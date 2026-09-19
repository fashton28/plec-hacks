/* PLEC brain stage. One code path: handle() takes backend bus events
   ({ type, chatId, data }) from either the live SSE stream or the mock player. */
(function () {
  const { venues, timeline } = window.DEMO;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (n) => '$' + Math.round(Number(n)).toLocaleString('en-US');
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ACCESS = /stairs|steps|wheelchair|walker|mobility|step-?free|accessib|elevator/i;

  // Person colors: confetti tints, assigned in order of appearance.
  const TINTS = [['#EFE7FC', '#7B3FE4'], ['#FDEBDC', '#C9661A'], ['#E7F5E5', '#3E8F3C'], ['#E6EFFE', '#2F6FD6'], ['#FDF3DA', '#A87A10'], ['#FCE5E3', '#C23030']];
  const SKIES = [['#FBE0D4', '#ECE6F8'], ['#FCE8CE', '#F7E1EA'], ['#E6EFFE', '#FBE0D4'], ['#E7F5E5', '#FCE8CE'], ['#EFE7FC', '#FDEBDC']];
  const BARS = ['var(--bar-1)', 'var(--bar-2)', 'var(--bar-3)'];

  /* ---------- Formatting ---------- */
  const day = (d) => new Date(`${d}T12:00:00`);
  const prettyDate = (d) => day(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
  const shortDate = (d) => { const x = day(d); return `${x.toLocaleDateString('en-US', { weekday: 'short' })} ${x.getDate()}`; };
  const hr = (t) => { const [h, m] = String(t).split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`; };
  const timeRange = (a, b) => `${hr(a).replace(/[ap]m$/, '')}–${hr(b)}`;
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const venueOf = (id, fallbackName) => venues[id] || { id: String(id), name: fallbackName || String(id).replace(/-/g, ' '), hood: '', capacity: null };
  const shortName = (v) => v.name.replace(/^The /, '');

  /* ---------- Fit the 1920-wide stage to the window ---------- */
  function fit() {
    const s = innerWidth / 1920;
    $('stage').style.transform = `scale(${s})`;
    $('stage').style.height = innerHeight / s + 'px';
  }
  addEventListener('resize', fit);
  fit();

  /* ---------- Components ---------- */
  const orb = (size, cls = '') => `<div class="orb ${cls}" style="--s:${size}px"><div class="orb-body"><div class="orb-swirl"></div><div class="orb-ribbon"></div></div><div class="orb-ring"></div></div>`;
  function tint(name) {
    let i = S.names.indexOf(name);
    if (i < 0) i = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
    return TINTS[i % TINTS.length];
  }
  const avatar = (name, size = 30) => {
    if (name === 'PLEC') return orb(size, 'still');
    const [bg, fg] = tint(name);
    return `<div class="av" style="width:${size}px;height:${size}px;background:${bg};color:${fg}">${esc(name[0])}</div>`;
  };
  function tile(v) {
    const [a, b] = SKIES[[...v.id].reduce((s, c) => s + c.charCodeAt(0), 0) % SKIES.length];
    const lights = Array.from({ length: 9 }, (_, i) => `<circle cx='${16 + i * 26}' cy='${(26 + Math.sin(i / 8 * Math.PI) * 16).toFixed(1)}' r='2.2' fill='#FFF3D0'/>`).join('');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 150' preserveAspectRatio='xMidYMid slice'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs>` +
      `<rect width='240' height='150' fill='url(#g)'/><path d='M10 26 Q120 62 232 26' stroke='#fff' stroke-opacity='.6' fill='none'/>${lights}` +
      `<path d='M0 104 C60 78 120 88 170 104 S220 96 240 90 V150 H0Z' fill='#fff' opacity='.35'/>` +
      `<path d='M0 126 C70 108 150 120 240 110 V150 H0Z' fill='#fff' opacity='.5'/></svg>`;
    return `background-image:url(&quot;data:image/svg+xml;utf8,${svg.replace(/#/g, '%23')}&quot;)`;
  }
  const photo = (v) => `<div class="photo" style="${tile(v)}"><span class="initial">${esc(shortName(v)[0])}</span></div>`;

  function glow(el) {
    if (!el || instant) return;
    el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
  }
  function setText(id, text) {
    const el = $(id);
    if (el.textContent !== String(text)) { el.textContent = text; glow(el); }
  }
  function countTo(el, to) {
    const from = parseInt(el.textContent, 10);
    if (from === to) return;
    glow(el);
    if (instant || reduced || isNaN(from)) { el.textContent = to; return; }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 1000);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function confetti(anchor) {
    if (instant || reduced) return;
    const cv = $('confetti'), ctx = cv.getContext('2d');
    cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const r = anchor.getBoundingClientRect(), ox = r.left + r.width / 2, oy = r.top + r.height / 3;
    const cols = ['#7B3FE4', '#3B82F6', '#6CC06A', '#F5B82E', '#F08A2C', '#E4543F', '#C9B0F4', '#F8DE9A'];
    const ps = Array.from({ length: 120 }, () => ({ x: ox, y: oy, vx: (Math.random() - .5) * 18, vy: -Math.random() * 15 - 4, s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: cols[Math.random() * cols.length | 0] }));
    const t0 = performance.now();
    (function frame(t) {
      const k = (t - t0) / 1700;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      if (k >= 1) return;
      ctx.globalAlpha = 1 - k * k;
      for (const p of ps) {
        p.vy += .45; p.vx *= .985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * .66); ctx.restore();
      }
      requestAnimationFrame(frame);
    })(t0);
  }

  /* ---------- State ---------- */
  let S, instant = false, settleTimer = null;
  function reset() {
    S = { plan: {}, pending: null, booking: null, names: [], spoke: 0, quiet: 0, introduced: false, awaitingSpeech: false, seen: new Set(), prevCells: {} };
    $('feed').innerHTML = '';
    $('latest').outerHTML = '<div class="latest-msg" id="latest"><span class="latest-empty">Waiting for the group to start talking…</span></div>';
    $('insight').outerHTML = '<div class="txt" id="insight"><small>✦ Quiet insight</small><b>Listening to the group…</b></div>';
    $('guests').textContent = '—'; $('trend').textContent = ''; $('trend').className = 'trend';
    for (const id of ['chip-budget', 'chip-date', 'chip-venue']) $(id).textContent = '—';
    $('votes').dataset.key = ''; $('booking').dataset.html = '';
    renderHero(); renderWhos(); renderVotes(); renderBooking(); renderCounter(); setAgent('listening');
  }
  const organizer = () => S.names[0] || 'the organizer';
  const people = () => S.names.filter((n) => n !== S.plan.guestOfHonor);
  function addPerson(name) {
    if (name && name !== 'PLEC' && name !== S.plan.guestOfHonor && !S.names.includes(name)) S.names.push(name);
  }
  const once = (key) => (S.seen.has(key) ? false : (S.seen.add(key), true));

  /* ---------- Agent / orb ---------- */
  const STATUS = { listening: 'Listening quietly', thinking: 'Thinking…', speaking: 'Typing…', booked: 'Booked ✓' };
  function setAgent(state, settleMs) {
    document.querySelectorAll('.orb.live').forEach((o) => {
      o.classList.remove('thinking', 'speaking', 'celebrate');
      if (state === 'thinking' || state === 'speaking') o.classList.add(state);
      if (state === 'booked' && !instant) { o.classList.add('celebrate'); setTimeout(() => o.classList.remove('celebrate'), 1000); }
    });
    $('status-main').textContent = STATUS[state] || state;
    $('status-main').classList.toggle('booked', state === 'booked');
    clearTimeout(settleTimer);
    if (settleMs) settleTimer = setTimeout(() => setAgent('listening'), instant ? 0 : settleMs);
  }
  function renderCounter() {
    const t = `Spoke ${S.spoke}× · stayed quiet ${S.quiet}×`;
    $('counter').textContent = t; $('status-sub').textContent = t;
  }

  /* ---------- Latest in the chat ---------- */
  function showLatest(name, html, isPlec) {
    const n = document.createElement('div');
    n.className = `latest-msg ${isPlec ? 'plec' : ''}`; n.id = 'latest';
    n.innerHTML = `${avatar(name)}<b>${esc(name)}</b>${html}`;
    if (instant) n.style.animation = 'none';
    $('latest').replaceWith(n);
  }

  /* ---------- Insight + activity ---------- */
  function insight(key, text) {
    if (!once('insight:' + key)) return;
    const n = document.createElement('div');
    n.className = 'txt'; n.id = 'insight';
    n.innerHTML = `<small>✦ Quiet insight</small><b>${esc(text)}</b>`;
    if (instant) n.style.animation = 'none';
    $('insight').replaceWith(n);
  }
  const ICONS = {
    quiet: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    learned: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    spoke: '<path d="M4 5h16v11H9l-5 4z"/>',
    vote: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M9 6l3 3 5-5"/>',
    booked: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    issue: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  };
  const TAG = { quiet: 'Stayed quiet', learned: 'Learned', spoke: 'Spoke', vote: 'Vote', booked: 'Booked', issue: 'Issue' };
  function activity(kind, text, sub) {
    const row = document.createElement('div');
    row.className = `item k-${kind}`;
    row.innerHTML = `<span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind]}</svg></span>` +
      `<div class="t"><b>${esc(text)}</b><span>${esc(sub || '')}</span></div><span class="tag k-${kind}">${TAG[kind]}</span>`;
    if (instant) row.style.animation = 'none';
    const feed = $('feed');
    feed.prepend(row);
    while (feed.children.length > 14) feed.lastElementChild.remove();
  }
  const INTENT = { suggest_venues: 'Suggested venues', tally: 'Tallied the votes', booking_issue: 'Flagged a booking issue', answer_question: 'Answered the group', recap: 'Recapped the plan', summarize: 'Summarized for the group', intro: 'Said hi to the group' };

  /* ---------- Derived plan facts ---------- */
  function allForDate(plan) {
    const opts = plan.dateOptions || [], ppl = people();
    const full = opts.find((o) => ppl.length && ppl.every((p) => o.worksFor.includes(p)));
    if (full) return full.date;
    // Fallback for sparse live extraction: the only date nobody ruled out, when every other date is ruled out.
    const open = opts.filter((o) => !o.doesNotWorkFor.length);
    return opts.length > 1 && open.length === 1 ? open[0].date : null;
  }
  function voteLeader(plan) {
    const tally = (plan.shortlist || []).map((id) => [id, (plan.votes?.[id] || []).length]).sort((a, b) => b[1] - a[1]);
    return tally.length && tally[0][1] > 0 ? tally[0][0] : null;
  }
  const liveBooking = () => (S.booking && S.booking.status !== 'cancelled' ? S.booking : null);
  const bookingCap = (b) => b.venueCapacity || venueOf(b.venueId).capacity;

  /* ---------- Plan ---------- */
  function onPlan(plan, changed) {
    const prev = S.plan;
    for (const o of plan.dateOptions || []) [...o.worksFor, ...o.doesNotWorkFor].forEach(addPerson);
    for (const c of plan.personConstraints || []) addPerson(c.person);
    Object.values(plan.votes || {}).flat().forEach(addPerson);
    S.names = S.names.filter((n) => n !== plan.guestOfHonor);

    if (plan.isSurprise && !prev.isSurprise && plan.guestOfHonor) activity('learned', `It's a surprise for ${plan.guestOfHonor}`, plan.eventType || 'keep it quiet');

    const prevDates = new Map((prev.dateOptions || []).map((o) => [o.date, o]));
    const fresh = (plan.dateOptions || []).filter((o) => !prevDates.has(o.date));
    if (fresh.length) activity('learned', fresh.length > 1 ? `${fresh.length} candidate dates` : `Candidate date: ${prettyDate(fresh[0].date)}`, fresh.map((o) => shortDate(o.date)).join(', '));
    for (const o of plan.dateOptions || []) {
      const before = prevDates.get(o.date)?.doesNotWorkFor || [];
      for (const p of o.doesNotWorkFor.filter((x) => !before.includes(x))) activity('learned', `${p} can't do ${shortDate(o.date)}`, 'date ruled out');
    }
    const all = allForDate(plan);
    if (all && all !== allForDate(prev)) {
      activity('learned', `${prettyDate(all)} works for everyone`, `all ${people().length} can make it`);
      insight('date:' + all, `${prettyDate(all)} works for all ${people().length} of you`);
    }

    const hc = plan.headcount?.value, prevHc = prev.headcount?.value;
    if (hc && hc !== prevHc && !liveBooking()) activity('learned', `About ${hc} guests`, plan.headcount.note || `${plan.headcount.confidence} confidence`);
    const pp = plan.budget?.perPerson, prevPp = prev.budget?.perPerson;
    if (pp && pp !== prevPp) {
      activity('learned', `Budget ≤ $${pp}/head`, plan.budget.note || '');
      if (hc) insight('budget:' + pp + ':' + hc, `$${pp}/head × ${hc} guests ≈ ${money(pp * hc)} to work with`);
    }
    const prevC = new Set((prev.personConstraints || []).map((c) => c.person + '|' + c.constraint));
    for (const c of plan.personConstraints || []) {
      if (prevC.has(c.person + '|' + c.constraint)) continue;
      activity('learned', `${c.person}: ${c.constraint}`, 'constraint');
      if (ACCESS.test(c.constraint)) insight('access:' + c.person, `${c.person}: ${c.constraint}, so step-free venues only`);
    }
    for (const v of (plan.vibe || []).filter((x) => !(prev.vibe || []).includes(x))) activity('learned', `Vibe: ${v}`, 'from the chat');

    for (const [i, id] of (plan.shortlist || []).entries()) {
      const before = prev.votes?.[id] || [];
      for (const who of (plan.votes?.[id] || []).filter((x) => !before.includes(x))) {
        const voted = new Set(Object.values(plan.votes).flat()).size;
        activity('vote', `${who} voted for #${i + 1}`, `${voted} of ${people().length} in`);
      }
    }
    const lead = voteLeader(plan);
    const voted = new Set(Object.values(plan.votes || {}).flat()).size;
    if (lead && voted >= people().length) insight('votes:' + lead, `${venueOf(lead).name} wins, ${(plan.votes[lead] || []).length} of ${voted} votes`);

    S.plan = plan;
    renderHero(); renderWhos(changed); renderVotes(); checkIssue(); renderBooking();
  }

  function checkIssue() {
    const b = liveBooking(), hc = S.plan.headcount?.value, c = b && bookingCap(b);
    if (b && c && hc > c && once(`issue:${b.id}:${b.venueId}:${hc}`)) {
      activity('issue', 'Headcount over capacity', `${hc} guests, ${b.venueName} fits ${c}`);
      insight(`issue:${hc}`, `${hc} guests, but ${b.venueName} fits ${c}`);
    }
  }

  /* ---------- Hero ---------- */
  function renderHero() {
    const p = S.plan, b = liveBooking();
    const goh = p.guestOfHonor, ev = (p.eventType || '').replace(/ birthday$/i, '');
    if (goh) {
      $('hero-title').textContent = `${goh}'s ${p.isSurprise ? 'surprise ' : ''}${ev || 'party'}`;
      document.querySelector('.event').textContent = `${goh}'s ${ev || 'party'}`;
    }
    $('surprise').style.display = p.isSurprise && goh ? '' : 'none';
    $('surprise').textContent = `🤫 ${goh || ''} isn't in the chat`;

    const hc = p.headcount?.value;
    if (hc) countTo($('guests'), hc);
    const t = $('trend');
    let cls = '', txt = '';
    if (b && hc) {
      const c = bookingCap(b), over = c && hc > c ? hc - c : 0, d = hc - b.headcount;
      if (over) { cls = 'bad'; txt = `▲ +${d} · over capacity by ${over}`; }
      else if (d > 0) { cls = 'up'; txt = `↗ +${d} since booking · fits ${c}`; }
      else if (c) { cls = 'up'; txt = `fits ${c} · ${c - hc} spots to spare`; }
    } else if (hc) { cls = 'note'; txt = p.headcount.note || `${p.headcount.confidence} confidence`; }
    if (t.textContent !== txt) { t.className = `trend ${cls}`; t.textContent = txt; glow(t); }

    if (p.budget?.perPerson) setText('chip-budget', `≤ $${p.budget.perPerson}/pp`);
    else if (p.budget?.max) setText('chip-budget', `≤ ${money(p.budget.max)}`);
    const date = b?.date || allForDate(p);
    if (date) setText('chip-date', prettyDate(date));
    const lead = voteLeader(p);
    const venue = b ? b.venueName : lead ? venueOf(lead).name : null;
    if (venue) setText('chip-venue', venue);
  }

  /* ---------- Who's in ---------- */
  function renderWhos() {
    const el = $('whos'), opts = S.plan.dateOptions || [], ppl = people().slice(0, 6);
    if (!opts.length || !ppl.length) { el.innerHTML = '<div class="empty" style="height:190px">No dates mentioned yet</div>'; $('whos-sub').textContent = 'dates × people'; return; }
    const all = allForDate(S.plan), cells = {};
    let h = `<div class="grid" style="grid-template-columns: 130px repeat(${opts.length}, minmax(0, 1fr))"><div></div>`;
    for (const o of opts) h += `<div class="h ${all === o.date ? 'all' : ''}">${shortDate(o.date)}</div>`;
    for (const p of ppl) {
      h += `<div class="person">${avatar(p, 28)}${esc(p)}</div>`;
      for (const o of opts) {
        const v = o.doesNotWorkFor.includes(p) ? 'n' : o.worksFor.includes(p) || all === o.date ? 'y' : '';
        const key = p + o.date; cells[key] = v;
        const pop = v && S.prevCells[key] !== v && !instant;
        h += `<div class="cell ${v} ${pop ? 'pop' : ''}">${v === 'n' ? '✕' : v === 'y' ? '✓' : '·'}</div>`;
      }
    }
    h += '</div>';
    const cons = S.plan.personConstraints || [];
    if (cons.length) {
      h += `<div class="constraints">${cons.map((c) => {
        const [bg, fg] = tint(c.person), isNew = !instant && once('cpill:' + c.person + c.constraint);
        if (instant) S.seen.add('cpill:' + c.person + c.constraint);
        return `<span class="cpill ${isNew ? 'new' : ''}" style="background:${bg};color:${fg}">${esc(c.person)} · ${esc(c.constraint)}</span>`;
      }).join('')}</div>`;
    }
    el.innerHTML = h;
    S.prevCells = cells;
    $('whos-sub').textContent = all ? `${shortDate(all)} works for all ✓` : `${opts.length} dates · ${ppl.length} people`;
  }

  /* ---------- Votes ---------- */
  function renderVotes() {
    const el = $('votes'), list = (S.plan.shortlist || []).slice(0, 3);
    if (!list.length) { el.dataset.key = ''; el.innerHTML = '<div class="empty" style="width:100%">PLEC hasn\'t suggested venues yet</div>'; $('votes-sub').textContent = 'no options yet'; return; }
    if (el.dataset.key !== list.join()) {
      el.dataset.key = list.join();
      el.innerHTML = list.map((id, i) => `<div class="bar-col" data-id="${esc(id)}"><div class="track"><div class="fill" style="background:${BARS[i]}"></div></div>` +
        `<div class="bar-name">#${i + 1} ${esc(shortName(venueOf(id)))}</div><div class="voters"></div></div>`).join('');
      void el.offsetWidth;
    }
    const votes = S.plan.votes || {}, lead = voteLeader(S.plan), n = people().length || 4;
    let total = 0;
    for (const id of list) {
      const who = votes[id] || [], col = el.querySelector(`[data-id="${CSS.escape(id)}"]`), fill = col.querySelector('.fill');
      total += who.length;
      if (instant) fill.style.transition = 'none';
      fill.style.height = who.length ? `${Math.max(20, who.length / n * 100)}%` : '0%';
      fill.textContent = who.length || '';
      if (instant) { void fill.offsetWidth; fill.style.transition = ''; }
      col.classList.toggle('lead', id === lead);
      col.querySelector('.voters').innerHTML = who.map((w) => avatar(w, 22)).join('');
    }
    $('votes-sub').textContent = total ? `${new Set(Object.values(votes).flat()).size} of ${n} voted` : 'waiting for votes';
  }

  /* ---------- Booking ---------- */
  function onBooking(b) {
    const prev = liveBooking();
    S.booking = b; S.pending = null;
    if (b.status === 'cancelled') { activity('booked', `Cancelled ${b.venueName}`, b.id); renderAll(); return; }
    const moved = prev && prev.id === b.id && prev.venueId !== b.venueId;
    activity('booked', moved ? `Moved to ${b.venueName}` : `Booked ${b.venueName}`, `${money(b.total)} · ${b.id}`);
    insight('booked:' + b.venueId, `Booked ${b.venueName} for ${prettyDate(b.date)}`);
    setAgent('booked', 3500);
    renderAll();
    setTimeout(() => confetti($('booking')), 150);
  }
  function renderAll() { renderHero(); renderVotes(); checkIssue(); renderBooking(); }

  function renderBooking() {
    const box = $('booking'), b = liveBooking(), pa = S.pending, hc = S.plan.headcount?.value;
    const cards = [];
    const c = b && bookingCap(b), over = !!(b && c && hc > c);
    if ((pa && pa.kind === 'modify_booking') || over) {
      const q = pa?.kind === 'modify_booking' ? pa.payload?.quote : null;
      const head = over ? `${hc} guests, but ${b.venueName} fits ${c}` : String(pa.summaryText || 'Change requested').split('\n')[0];
      let alt = '<div class="alt-wait">PLEC is finding a bigger room for the same night…</div>';
      if (q) {
        const v = venueOf(q.venueId, q.venueName), d = b ? q.total - b.total : 0;
        const note = [q.date === b?.date ? 'Same night' : prettyDate(q.date), v.stepFree ? 'step-free' : '', `$${Math.round(q.perPerson)}/head`].filter(Boolean).join(' · ');
        alt = `<div class="alt">${photo(v)}<div class="t"><b>${esc(v.name)}${v.capacity ? ` · fits ${v.capacity}` : ''}</b><span>${esc(note)}</span></div>` +
          `<div class="delta"><b>${d >= 0 ? '+' : '−'}${money(Math.abs(d))}</b><span class="tag k-vote">Waiting on ${esc(organizer())}</span></div></div>`;
      }
      cards.push(`<div class="card issue-card bk"><span class="heads-up">Heads up</span><h3>${esc(head)}</h3>${alt}</div>`);
    }
    if (pa && pa.kind === 'create_booking' && pa.payload?.quote) {
      const q = pa.payload.quote;
      const lines = [...(q.lineItems || []).map((li) => [cap(li.label), money(li.amount)]), [`Deposit (${q.depositPercent ?? 30}%)`, money(q.deposit)], ['Per person', '$' + Number(q.perPerson).toFixed(2)]];
      cards.push(`<div class="card pending bk"><div class="pending-head">${orb(46, 'live thinking')}<div><div class="card-title">Waiting on ${esc(organizer())} to confirm</div>` +
        `<div class="card-sub">${esc(q.venueName)} · ${prettyDate(q.date)} · ${timeRange(q.startTime, q.endTime)} · ${q.headcount} guests</div></div></div>` +
        `<div class="lines">${lines.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}</div>` +
        `<div class="total"><span>Total</span><b class="num">${money(q.total)}</b></div></div>`);
    }
    if (b) {
      const v = venueOf(b.venueId, b.venueName), hist = b.history || [], last = hist.length > 1 ? hist[hist.length - 1].change : '';
      cards.push(`<div class="card ticket bk">${photo(v)}<div class="stub">` +
        `<div class="booked-row"><span class="booked-word">Booked ✓</span><span class="code">${esc(b.id)}</span>${last ? '<span class="upd">Updated</span>' : ''}</div>` +
        `<div class="venue-name">${esc(b.venueName)}${v.hood ? ' · ' + esc(v.hood) : ''}</div>` +
        `<div class="kv"><div><small>Date</small><b>${prettyDate(b.date)}</b></div><div><small>Time</small><b>${timeRange(b.startTime, b.endTime)}</b></div>` +
        `<div><small>Guests</small><b>${b.headcount}</b></div><div><small>Total</small><b>${money(b.total)}</b></div><div><small>Deposit</small><b>${money(b.deposit)}</b></div></div>` +
        (last ? `<div class="history">↺ ${esc(last.replace(/->/g, '→'))}</div>` : '') + '</div></div>');
    }
    if (!cards.length) {
      cards.push(`<div class="card idle"><span class="lock"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>` +
        `<div>Nothing booked yet. PLEC only books after <b>${esc(organizer())}</b> says yes.</div></div>`);
    }
    const html = cards.join('');
    if (box.dataset.html === html) return;
    box.dataset.html = html;
    box.className = `booking ${cards.length > 1 ? 'two' : ''}`;
    box.innerHTML = html;
    if (instant) box.querySelectorAll('.bk').forEach((x) => { x.style.animation = 'none'; });
  }

  /* ---------- The one event handler ---------- */
  function handle(evt) {
    const d = evt.data || {};
    switch (evt.type) {
      case 'inbound':
        addPerson(d.fromName);
        showLatest(d.fromName || 'Someone', `<span class="text">${esc(d.text || (d.attachments?.length ? '📷 screenshot' : ''))}</span>`);
        renderBooking();
        break;
      case 'agent_message':
        if (!S.awaitingSpeech && !S.introduced) { S.spoke++; renderCounter(); activity('spoke', 'Said hi to the group', 'intro, then went quiet'); }
        S.introduced = true; S.awaitingSpeech = false;
        showLatest('PLEC', `<span class="text">${esc(d.text || '📎 sent a picture')}</span>`, true);
        if ($('status-main').textContent !== STATUS.booked) setAgent('speaking', 2600);
        break;
      case 'typing':
        showLatest('PLEC', '<span class="typing"><i></i><i></i><i></i></span>', true);
        if ($('status-main').textContent !== STATUS.booked) setAgent('speaking', 4000);
        break;
      case 'plan': onPlan(d.plan || {}, d.changed || []); break;
      case 'decision':
        if (d.speak) { S.spoke++; S.awaitingSpeech = true; activity('spoke', INTENT[d.intent] || 'Spoke up', d.reason); setAgent('thinking', 8000); }
        else { S.quiet++; activity('quiet', 'Stayed quiet', d.reason); }
        renderCounter();
        break;
      case 'pending': S.pending = evt.data; renderBooking(); break;
      case 'booking': onBooking(d); break;
      case 'llm_call': if ($('status-main').textContent === STATUS.listening) setAgent('thinking', 1500); break;
      case 'state_reset': reset(); break;
    }
  }

  /* ---------- Mock playback ---------- */
  let idx = 0, playing = false, speed = 1, timer = null, live = false;
  function label() {
    $('mode').textContent = live ? 'LIVE' : `MOCK${speed > 1 ? ' · 2×' : ''}${playing ? '' : idx >= timeline.length ? ' · done' : ' · paused (space)'}`;
  }
  function schedule() {
    clearTimeout(timer);
    if (!playing || idx >= timeline.length) { playing = playing && idx < timeline.length; label(); return; }
    timer = setTimeout(() => { handle(timeline[idx++]); schedule(); }, timeline[idx].delay / speed);
  }
  addEventListener('keydown', (k) => {
    if (live) return;
    if (k.code === 'Space') { k.preventDefault(); playing = !playing; schedule(); }
    else if (k.key === 'r' || k.key === 'R') { playing = false; clearTimeout(timer); idx = 0; reset(); }
    else if (k.key === 'ArrowRight' && idx < timeline.length) { handle(timeline[idx++]); schedule(); }
    else if (k.key === '2') { speed = speed === 1 ? 2 : 1; schedule(); }
    else return;
    label();
  });

  /* ---------- Start: live if /events answers, else mock ---------- */
  reset();
  function startMock() {
    live = false;
    if (params.has('at')) { instant = true; while (idx < Math.min(+params.get('at'), timeline.length)) handle(timeline[idx++]); instant = false; }
    playing = params.has('autoplay');
    schedule(); label();
  }
  // `npx serve` on 5178 has no backend, so skip the probe there (avoids a 404 in the console).
  const tryLive = !params.has('mock') && (params.has('live') || location.port !== '5178');
  if (tryLive && 'EventSource' in window) {
    const es = new EventSource('/events');
    const fallback = setTimeout(() => { es.close(); startMock(); }, 1500);
    es.onopen = () => { clearTimeout(fallback); if (!live) { live = true; reset(); } label(); };
    es.onerror = () => { if (!live) { clearTimeout(fallback); es.close(); startMock(); } };
    es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (err) { console.warn('PLEC: bad event', err); } };
  } else {
    startMock();
  }
})();
