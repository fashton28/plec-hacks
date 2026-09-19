/**
 * Reading a yes or a no out of a text message.
 *
 * guards.js decides WHETHER a write may run; this file only answers what the
 * person's words mean. It errs on the side of asking again: a missed yes costs
 * one more "want me to lock it in?", a wrong yes costs someone a booking.
 *
 *   - Only the speaker's own words count. Quoted text and tapbacks are out.
 *   - A yes has to be a statement. "is that ok?" and "ok so what's the total"
 *     are questions, and a question is never an answer.
 *   - A hold-off beats a yes: "ok wait", "yes but not yet", "sure, let me ask".
 *   - Idioms that contain a no are not a no: "yes, no rush", "no te preocupes".
 *   - When the write IS a cancellation, restating it ("yes, cancel that") and
 *     giving the reason ("we don't need it anymore") are not refusals.
 *
 * Pure functions, covered phrase by phrase in tests/identity.unit.js.
 */

const WORD = (alternatives) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'iu');

/** Unmistakable on their own, so they still count in a message that also asks something. */
const CLEAR_YES = [
  'yes+', 'yep', 'yeah', 'yup', 'yea', 'confirm', 'confirmed', 'i confirm', 'go ahead', 'do it', 'please do', 'proceed',
  "let'?s do it", 'book it now', 'go for it', 'right away', 'no need to (?:ask|confirm|check)',
  // Unaccented "si" is also Spanish for "if", so it only counts standing alone: "si", "si, adelante", "si por favor".
  's[ií]+(?=\\s*(?:$|[.,!;]|por favor|claro|se[nñ]or))', 'sí+', 'claro', 'adelante', 'confirmo', 'confirmado', 'conf[ií]rmalo', 'hazlo', 'dale',
  'oui', "d'accord", 'ja', 'sim',
];
/** Agreement that leans on context: fine as the whole answer, too weak next to a question ("what's the refund? ok thanks"). */
const SOFT_YES = [
  'sure', 'for sure', 'ok', 'okay', 'okey', 'oki', 'okie', 'k', 'kk', 'alright', 'all right', 'bet', 'sounds good', 'looks good', 'that works', 'works for me',
  'perfect', 'correct', 'absolutely', 'definitely', 'de acuerdo', 'vale', 'perfecto',
];
const CLEAR_AFFIRMATIVE = WORD(CLEAR_YES.join('|'));
const AFFIRMATIVE = WORD([...CLEAR_YES, ...SOFT_YES].join('|'));
/** A message that is nothing but a thumbs-up. Only a typed one gets here: a real tapback never reaches the brain. */
const THUMBS_UP = /^\s*\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?\s*$/u;

/** Not now, not like this, or not mine to say. Any of these next to a yes means ask again. */
const HOLD_OFF = WORD([
  "(?:do|does|did|is|was|are|ca|wo|would|should|could)n'?t", 'do not', 'cannot', 'can not', 'will not', 'never', 'nope', 'nah',
  'not (?:ok|okay|sure|correct|right|perfect|good|great|now|right now|today|ready|really|happy|yet|so fast|confirm\\p{L}*)',
  '(?:guess|think|hope) not', 'wait', 'hold on', 'hang on', 'stop', 'cancel that', 'changed? my mind', 'maybe', 'perhaps', 'later',
  'unsure', 'incorrect', 'wrong', 'far from', 'yeah right', 'no way', 'let me(?! know)', 'think about it',
  '(?:need|have|want) to (?:ask|check|talk|think)', 'give me a (?:minute|min|sec|second|moment|bit)', 'after i', 'before (?:we|i|you)',
  'but (?:first|what|how)', 'what about', 'only if', 'unless', '(?:yes|yeah|ok|okay|sure)[,\\s]+(?:but\\s+)?if',
  // "book it for tomorrow" names the date; "I'll book tomorrow" and "yes tomorrow" put it off.
  "(?<!\\b(?:for|on|is|of|at|it's|para|el|es|de|la)\\s)(?:tomorrow|ma[nñ]ana)",
  'todav[ií]a no', 'no todav[ií]a', 'a[uú]n no', 'espera\\p{L}*', 'mejor (?:no|otro)', 'luego', 'despu[eé]s', 'd[eé]jame', 'tampoco',
  'nunca', 'jam[aá]s', 'ni', 'para nada', 'quiz[aá]s?', 'tal vez',
].join('|'));
/** A bare no is a refusal where it ends a clause ("yeah no", "ok no thanks"); "no notes" and "non refundable" only describe something. */
const BARE_NO = /(?<![\p{L}\p{N}])(?:no|non|nein)(?=\s*(?:$|[.,!;:)]|thanks|thank you|thx|gracias|merci|danke))/iu;
const TRAILING_NOT = /(?<![\p{L}\p{N}])not\W*$/iu;
/** Someone else's yes, relayed: "Ana said yes". "I said yes" is the speaker repeating their own. */
const REPORTED = /(?<!\b(?:i|you|u)\s)\b(?:said|says|dijo|dice)\b/iu;
/** A change of plan, unless the message opens with a plain yes: "yes, move it to the 11th instead". */
const SECOND_THOUGHT = WORD('instead|actually');
const OPENS_WITH_YES = /^\W*(?:yes+|yep|yeah|yup|yea|s[ií]+|claro|oui)(?![\p{L}\p{N}])/iu;

/** Phrases that contain a negative word and mean the opposite of a refusal. */
const NOT_A_NO = new RegExp([
  '\\bno (?:need to (?:ask|confirm|check)|problem\\p{L}*|worries|rush|hurry|pressure|biggie|changes?|(?:more |other |further )?questions|notes?|allergies|doubts?)\\b',
  '\\bnot a problem\\b', '\\bwhy not\\b', "\\b(?:don'?t|do not) (?:worry|mind|care|need anything(?: else)?|have any (?:questions|changes|notes))\\b",
  "\\bcan(?:'?t|not) wait\\b", '\\bstop asking\\b', '\\bnothing else\\b',
  '\\bno hay (?:problema|prisa)\\b', '\\bno te preocupes\\b', '\\bno tengo (?:dudas|preguntas)\\b', '\\bsin (?:problemas?|prisa)\\b',
].join('|'), 'giu');

/** Saying the cancellation back. It reads as a refusal ("cancel that", "stop") everywhere except when cancelling is the point. */
const CANCEL_RESTATED = /\bcancel that\b|\bstop the (?:booking|reservation)\b/giu;
/**
 * A reason people give FOR cancelling. It is only a reason when it ends the
 * clause: "I don't need it anymore" is, "I don't want it cancelled" is a refusal.
 */
const CANCEL_REASON = new RegExp([
  "\\b(?:don'?t|do not|no longer|won'?t|will not) (?:need|want) (?:it|that|this|(?:the|that|this|my|our) \\p{L}+)(?: any ?more| after all| now)?(?=\\s*(?:$|[.,!;:)]))",
  '\\bno longer needed\\b', '\\bnot needed any ?more\\b', "\\bcan(?:'?t|not| not) (?:make it|come|go|attend)\\b", '\\bno way we can make it\\b',
  '\\bya no l[ao]s? (?:necesito|necesitamos|quiero|queremos)\\b', '\\bno (?:puedo|podemos) (?:ir|asistir)\\b',
].join('|'), 'giu');

/** Anything inside double quotes is someone else's words (usually ours, quoted back), never the speaker's own yes or no. */
const QUOTED = /["\u201C\u201E\u00AB][^"\u201D\u00BB]*["\u201D\u00BB]/gu;
/** iOS types U+2019 by default, so "don’t" is the normal spelling on iMessage and must read the same as "don't". */
const CURLY_APOSTROPHE = /[\u2018\u2019\u02BC]/g;
/**
 * How a tapback from a green-bubble (SMS or RCS) member arrives: as a text
 * that quotes the message reacted to, for example Liked "Want me to book it?".
 * In a group anyone can react, so a reaction is never a yes.
 */
const TAPBACK = /^\s*(?:liked|loved|disliked|laughed at|emphasi[sz]ed|questioned|reacted\b.{0,20}?\bto|removed an? .{1,20}? from)\s+(?:["\u201C\u201E\u00AB]|an? (?:image|photo|video|attachment|audio message|message)\b)/iu;

const FILLER = '(?:(?:ok|okay|so|and|but|hmm+|well|also|wait|y|pero|entonces)\\W+)*';
const ASKS = new RegExp(`^\\W*${FILLER}(?:what|how|when|where|which|who|why(?! not)|is|are|was|were|can|could|should|would|does|did|will|may|might|qu[eé]|c[oó]mo|cu[aá]nt[oa]s?|cu[aá]ndo|d[oó]nde|cu[aá]l)(?![\\p{L}\\p{N}])`, 'iu');
/** "can you book it?" is a question in form and a request in meaning. */
const REQUEST = new RegExp(`^\\W*${FILLER}(?:(?:can|could|would|will) (?:you|u)|puedes|podr[ií]as)(?![\\p{L}\\p{N}])`, 'iu');
/** Asking for the booking itself: enough, with an earlier quote, to mean "go on then". */
const BOOKING_INTENT = WORD(['book', 'reserve', 'lock (?:it|that) in', 'put it under', 'reservar?', 'res[eé]rv[ae]\\p{L}*', 'apartar?'].join('|'));

const ownWords = (text) => String(text ?? '').replace(QUOTED, ' ').replace(CURLY_APOSTROPHE, "'");
const sentencesOf = (text) => text.split(/(?<=[.!?\uFF1F])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const isQuestion = (sentence) => /[?\uFF1F]\s*$/.test(sentence) || /^\s*\u00BF/.test(sentence) || ASKS.test(sentence);

/** The speaker's words with the harmless negatives taken out, ready to be searched for a real one. */
function withoutIdioms(text, cancelling) {
  const own = ownWords(text).replace(NOT_A_NO, ' ');
  return cancelling ? own.replace(CANCEL_RESTATED, ' ').replace(CANCEL_REASON, ' ') : own;
}

/** True for the text form of a tapback (Liked "...", Loved "...", Emphasized "...", Reacted 👍 to "..."). */
export function isTapbackText(text) {
  return TAPBACK.test(String(text ?? ''));
}

/**
 * Does the message say yes, as a statement? Says nothing about a no beside it.
 * @param {string} text
 * @param {{ thumbsUp?: boolean }} [options] count a lone thumbs-up emoji; the caller allows it outside groups only
 */
export function isAffirmative(text, { thumbsUp = false } = {}) {
  if (isTapbackText(text)) return false;
  if (thumbsUp && THUMBS_UP.test(String(text ?? ''))) return true;
  const sentences = sentencesOf(ownWords(text));
  const statements = sentences.filter((sentence) => !isQuestion(sentence));
  const yes = statements.length < sentences.length ? CLEAR_AFFIRMATIVE : AFFIRMATIVE;
  return statements.some((sentence) => yes.test(sentence));
}

/**
 * Does the message refuse, hedge or put things off?
 * @param {string} text
 * @param {{ cancelling?: boolean }} [options] the write being confirmed is a cancellation
 */
export function isNegative(text, { cancelling = false } = {}) {
  const said = withoutIdioms(text, cancelling);
  if (HOLD_OFF.test(said) || BARE_NO.test(said) || TRAILING_NOT.test(said) || REPORTED.test(said)) return true;
  return SECOND_THOUGHT.test(said) && !OPENS_WITH_YES.test(said);
}

/**
 * A clear yes: an affirmative statement with no negative beside it. "ok wait dont book yet" is a no.
 * @param {string} text
 * @param {{ cancelling?: boolean, thumbsUp?: boolean }} [options]
 */
export function hasConsent(text, options = {}) {
  return isAffirmative(text, options) && !isNegative(text, options);
}

/** "Book it", "lock it in", "can you book it?": asks for the booking without saying yes in so many words. */
export function hasBookingIntent(text) {
  if (isTapbackText(text)) return false;
  return sentencesOf(ownWords(text)).some((sentence) => BOOKING_INTENT.test(sentence) && (!isQuestion(sentence) || REQUEST.test(sentence)));
}
