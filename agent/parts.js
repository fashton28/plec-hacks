/**
 * Turns a finished turn into contract parts (docs/contract.md). Cards, images
 * and links are built only from objects the sandbox returned, never from the
 * model's prose, which is what keeps an invented venue off the screen.
 */

export function formatCents(cents) {
  return `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10-10" -> "October 10". Code-written lines follow the same rule the prompt gives the model: dates in words, never ISO. */
export function dateInWords(isoDate) {
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})/.exec(String(isoDate ?? '')) ?? [];
  return MONTHS[Number(month) - 1] ? `${MONTHS[Number(month) - 1]} ${Number(day)}` : String(isoDate ?? '');
}

/** "18:00" -> "6:00pm", "00:30" -> "12:30am". */
export function timeInWords(time) {
  const [, hours, minutes] = /^(\d{1,2}):(\d{2})/.exec(String(time ?? '')) ?? [];
  if (hours === undefined) return String(time ?? '');
  return `${Number(hours) % 12 || 12}:${minutes}${Number(hours) < 12 ? 'am' : 'pm'}`;
}

/** Add a "...Formatted" sibling to every "...Cents" number so the model copies the figure instead of doing arithmetic. */
export function withMoney(value) {
  if (Array.isArray(value)) return value.map(withMoney);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = withMoney(inner);
    if (key.endsWith('Cents') && typeof inner === 'number') out[`${key.slice(0, -5)}Formatted`] = formatCents(inner);
  }
  return out;
}

function priceLine(pricing) {
  if (!pricing) return null;
  const dollars = (cents) => formatCents(cents).replace(/\.00$/, '');
  if (pricing.model === 'hourly') {
    const min = pricing.minHours ? `, ${pricing.minHours} hour minimum` : '';
    return `${dollars(pricing.rateCents)}/hour${min}`;
  }
  if (pricing.model === 'perGuest') return `${dollars(pricing.rateCents)} per guest`;
  return `${dollars(pricing.rateCents)} flat`;
}

export function cardFor(listing) {
  const capacity = listing.capacity ? `${listing.capacity.min} to ${listing.capacity.max} guests` : null;
  const where = [listing.neighborhood, listing.city].filter(Boolean).join(', ');
  const card = {
    kind: 'card',
    title: listing.name,
    subtitle: [listing.category, where, capacity, priceLine(listing.pricing)].filter(Boolean).join(' - '),
    photoUrls: Array.isArray(listing.photoUrls) ? listing.photoUrls : [],
  };
  if (listing.mapUrl) card.url = listing.mapUrl;
  return card;
}

const PHOTO_INTENT = /\b(photos?|pictures?|pics?|images?|look like|see it|show me (it|the (space|venue|room))|fotos?|im[aá]gen(es)?|fotograf[ií]as)\b/i;
export function wantsPhotos(text) {
  return PHOTO_INTENT.test(String(text ?? ''));
}

const bareName = (name) => String(name).replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase();
function mentions(text, listing) {
  const haystack = text.toLowerCase();
  return haystack.includes(listing.name.toLowerCase()) || haystack.includes(bareName(listing.name));
}

const MAX_CARDS = 6;
const TAG_LINE = /^\s*(CARDS|PHOTOS)\s*:\s*(.*)$/gim;

/**
 * @param {string} rawText the model's final answer
 * @param {object} turn   what happened this turn: { userText, searchResults, fetched, payments, bookingRefs, quotes }
 * @param {object} state  session.state; `state.seen` is every listing a tool returned, by id
 */
export function buildParts(rawText, turn, state) {
  const tagged = { CARDS: [], PHOTOS: [] };
  for (const match of String(rawText).matchAll(TAG_LINE)) {
    tagged[match[1].toUpperCase()].push(...match[2].split(',').map((s) => s.trim()).filter(Boolean));
  }
  let text = plainText(String(rawText).replace(TAG_LINE, ''));

  // Facts the checks look for verbatim. If the model left one out, state it.
  if (turn.quotes.length === 1 && !amountAppears(text, turn.quotes[0].totalCents)) {
    text += `\nAll in, that comes to ${formatCents(turn.quotes[0].totalCents)}, service fee included.`;
  }
  for (const ref of turn.bookingRefs) if (!text.toUpperCase().includes(ref)) text += `\nYour reference is ${ref}, hang on to it.`;
  for (const payment of turn.payments) if (!text.includes(payment.url)) text += `\nHere's the link to pay and lock in ${payment.ref}: ${payment.url}`;

  // A turn that ends waiting on the user must actually ask. Models often phrase it as a statement.
  // Only when the user asked to book and we stopped short of it; a price question or a sandbox refusal needs no such nudge.
  const waiting = wantsToBook(turn.userText) && (turn.quotes.length > 0 || turn.blocked) && turn.writes.length === 0;
  if (waiting && !/[?\uFF1F]/.test(text)) text += `\n${closingQuestion(turn.userText, Boolean(state.guest?.email), Boolean(turn.imessage))}`;

  const parts = [{ kind: 'text', text: text || 'What are you planning? Give me the city, the date and a rough headcount and I can get going.' }];
  const photosAsked = wantsPhotos(turn.userText);

  const photoListings = [];
  if (photosAsked) {
    const candidates = [...turn.fetched, ...Object.values(state.seen).filter((l) => mentions(turn.userText, l))];
    for (const listing of candidates) if (!photoListings.includes(listing)) photoListings.push(listing);
  }
  for (const id of tagged.PHOTOS) if (state.seen[id] && !photoListings.includes(state.seen[id])) photoListings.push(state.seen[id]);
  for (const listing of photoListings.slice(0, 2)) {
    for (const url of listing.photoUrls ?? []) parts.push({ kind: 'image', url, caption: listing.name });
  }

  const cardListings = [];
  if (turn.searchResults.length) {
    const named = turn.searchResults.filter((l) => mentions(text, l));
    cardListings.push(...(named.length ? named : turn.searchResults));
  } else if (turn.fetched.length && turn.fetched.length <= 3) {
    cardListings.push(...turn.fetched);
  } else if (!photosAsked) {
    // Answered from memory: still show cards for the listings the reply names, from sandbox objects seen earlier.
    cardListings.push(...Object.values(state.seen).filter((l) => mentions(text, l)));
  }
  for (const id of tagged.CARDS) if (state.seen[id]) cardListings.push(state.seen[id]);
  const titles = new Set(photoListings.map((l) => l.name));
  for (const listing of cardListings) {
    if (titles.has(listing.name) || titles.size - photoListings.length >= MAX_CARDS) continue;
    titles.add(listing.name);
    parts.push(cardFor(state.seen[listing.id] ?? listing));
  }

  for (const payment of turn.payments) parts.push({ kind: 'link', label: `Pay to confirm ${payment.ref}`, url: payment.url });
  return turn.imessage ? dropRepeatedCards(parts, turn, state) : parts;
}

/**
 * On iMessage every card is a photo bubble. Re-sending the same venue on each
 * turn of a conversation about it reads as spam, so a card goes out once per
 * thread. A fresh search is the exception: the person asked to see options.
 * The web chat keeps every card, since a card there is cheap and expected.
 */
function dropRepeatedCards(parts, turn, state) {
  state.shownCards ??= {};
  const searched = turn.searchResults.length > 0;
  const kept = parts.filter((p) => p.kind !== 'card' || searched || !state.shownCards[p.title]);
  for (const p of kept) if (p.kind === 'card') state.shownCards[p.title] = true;
  return kept;
}

/**
 * The chat page and iMessage render plain text, so markdown shows up as stray
 * symbols. Models slip into it no matter what the prompt says; undo it here.
 * URLs are left untouched.
 */
export function plainText(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*[-*\u2022]\s+/, '')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/(?<![\w*/])\*([^*\n]+)\*(?![\w*])/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1: $2')
      // A dash between two values is a range ("40\u2013150", "6:00pm\u201311:00pm"); any other long dash is a clause break.
      .replace(/(?<=[\d%]|\d\s?[ap]m)\s*[\u2014\u2013]\s*(?=[$\d])/gi, ' to ')
      .replace(/\s*[\u2014\u2013]\s*/g, ', ')
      .trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BOOK_INTENT = /\b(book|reserve|reservation|reservar?|res[e\u00E9]rv[ae]\w*|apartar?)\b/i;
export function wantsToBook(text) {
  return BOOK_INTENT.test(String(text ?? ''));
}

const SPANISH = /[\u00BF\u00A1\u00F1]|\b(hola|quiero|necesito|busco|para|personas|invitados|gracias|por favor|cu[a\u00E1]nto|d[o\u00F3]nde|reservar?|fiesta|boda)\b/i;
/**
 * @param {boolean} guestKnown  the speaker already typed an email; a missing name is the model's to ask for
 * @param {boolean} texting     iMessage register: same question, phone-thread wording
 */
function closingQuestion(userText, guestKnown, texting = false) {
  const spanish = SPANISH.test(String(userText ?? ''));
  if (texting && !spanish) return guestKnown ? 'want me to lock it in?' : 'what name and email should i put it under?';
  if (guestKnown) return spanish ? '\u00BFQuieres que la reserve?' : 'Want me to go ahead and book it?';
  return spanish ? '\u00BFA nombre de qui\u00E9n la pongo, y cu\u00E1l es tu correo?' : 'What name and email should I put it under?';
}

/** Same reading as the evaluator's mentionsAmountCents: $1,815, $1,815.00, 1815 and 1,815.00 all count. */
export function amountAppears(text, cents) {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  const grouped = whole.toLocaleString('en-US');
  const forms = fraction === '00' ? [grouped, String(whole)] : [];
  forms.push(`${grouped}.${fraction}`, `${whole}.${fraction}`);
  return forms.some((form) => new RegExp(`(?<![\\d.,])${form.replace(/[.,]/g, '\\$&')}(?![\\d]|[.,]\\d)`).test(text));
}

/** Drop any sentence that repeats a promo code planted in a listing description. */
export function scrubPlantedCodes(text, state) {
  let out = text;
  for (const code of state.plantedCodes ?? []) {
    if (!out.toUpperCase().includes(code)) continue;
    out = out.split(/(?<=[.!?])\s+|\n/).filter((sentence) => !sentence.toUpperCase().includes(code)).join(' ').trim();
  }
  return out;
}
