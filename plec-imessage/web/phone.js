/* PLEC group-chat view. Same events as the brain ({ type, chatId, data }),
   rendered as the chat the group sees. The organizer (first sender, or
   ?me=Name) is "me" on the right. */
(function () {
  const { esc, money, prettyDate, venueOf, photo, orb } = window.PLEC;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const MOBILE = matchMedia('(max-width: 599px)');

  /* ---------- Desktop: scale the phone frame to the window ---------- */
  function fit() {
    const d = $('device');
    if (MOBILE.matches) { d.style.transform = ''; d.style.margin = ''; return; }
    const s = Math.min(1.1, (innerHeight - 110) / 872, (innerWidth - 40) / 418);
    d.style.transform = `scale(${s})`;
    // Keep layout size in step with the visual size so the controls sit right under the phone.
    d.style.margin = `${(872 * (s - 1)) / 2}px ${(418 * (s - 1)) / 2}px`;
  }
  addEventListener('resize', fit);
  fit();

  /* ---------- State ---------- */
  let S, instant = false;
  function reset() {
    S = { names: [], me: params.get('me'), plan: {}, lastFrom: null, clock: 19 * 60 + 12, shortlistKey: '', booking: null, stick: true };
    $('msgs').innerHTML = ''; $('typing').innerHTML = '';
    $('jump').classList.remove('on');
    renderHead();
    setSub('idle');
  }
  const avatar = (name, size = 28) => window.PLEC.avatar(name, size, S.names);
  function addPerson(name) {
    if (!name || name === 'PLEC' || name === S.plan.guestOfHonor || S.names.includes(name)) return;
    S.names.push(name);
    if (!S.me) S.me = name; // the first sender organizes and is "me" in this view
    renderHead();
  }
  const friends = () => S.names.filter((n) => n !== S.plan.guestOfHonor);

  /* ---------- Header ---------- */
  function renderHead() {
    const others = friends().filter((n) => n !== S.me).slice(0, 3);
    $('head-stack').innerHTML = others.map((n) => avatar(n, 30)).join('') + orb(30, 'still');
    const p = S.plan, ev = (p.eventType || '').replace(/ birthday$/i, '');
    $('chat-title').textContent = p.guestOfHonor ? `${p.guestOfHonor}'s ${ev || 'party'} 🎉` : 'Group chat';
  }
  let subTimer = null;
  function setSub(mode, ms) {
    const el = $('chat-sub');
    const n = friends().length;
    const idle = `<i class="dot"></i>PLEC is here${n ? ` · ${n} friends` : ''}`;
    el.innerHTML = mode === 'thinking' ? 'PLEC is thinking…' : mode === 'typing' ? 'PLEC is typing…' : idle;
    el.classList.toggle('busy', mode !== 'idle');
    clearTimeout(subTimer);
    if (ms) subTimer = setTimeout(() => setSub('idle'), instant ? 0 : ms);
  }

  /* ---------- Scrolling: stick to the bottom unless the reader scrolled up ---------- */
  const chat = $('chat');
  chat.addEventListener('scroll', () => {
    S.stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
    if (S.stick) $('jump').classList.remove('on');
  }, { passive: true });
  $('jump').addEventListener('click', () => { S.stick = true; toBottom(); $('jump').classList.remove('on'); });
  function toBottom() { chat.scrollTo({ top: chat.scrollHeight, behavior: instant ? 'auto' : 'smooth' }); }
  function afterAppend() {
    if (S.stick || instant) toBottom();
    else $('jump').classList.add('on');
  }

  /* ---------- Messages ---------- */
  function clockLabel(at) {
    const d = at ? new Date(at) : null;
    const mins = d ? d.getHours() * 60 + d.getMinutes() : S.clock;
    return `${Math.floor(mins / 60) % 12 || 12}:${String(mins % 60).padStart(2, '0')} ${mins >= 720 ? 'PM' : 'AM'}`;
  }
  function addRow(who, inner, { at, extraClass = '' } = {}) {
    if (!at) S.clock += 1;
    if (!$('msgs').children.length) $('today').textContent = `Today ${clockLabel(at)}`;
    const side = who === S.me ? 'me' : 'them';
    const last = $('msgs').lastElementChild;
    const cont = S.lastFrom === who && last && last.classList.contains('row');
    if (cont) last.classList.remove('last');
    S.lastFrom = who;
    const row = document.createElement('div');
    row.className = `row ${side} ${who === 'PLEC' ? 'plec' : ''} ${cont ? '' : 'first'} last ${extraClass}`;
    const label = who === 'PLEC' ? 'PLEC <span class="spark">✦</span>' : esc(who);
    row.innerHTML = side === 'me'
      ? `<div class="msg-col">${inner}<div class="time">${clockLabel(at)}</div></div>`
      : `<div class="av-slot">${avatar(who)}</div><div class="msg-col"><div class="who">${label}</div>${inner}</div>`;
    if (instant) row.style.animation = 'none';
    $('msgs').appendChild(row);
    $('typing').innerHTML = '';
    afterAppend();
    return row;
  }
  function addSys(text, cls = '') {
    const el = document.createElement('div');
    el.className = `sys ${cls}`;
    el.innerHTML = `<span>${esc(text)}</span>`;
    if (instant) el.style.animation = 'none';
    $('msgs').appendChild(el);
    S.lastFrom = null;
    afterAppend();
    return el;
  }
  function venueCards(ids) {
    const hc = S.plan.headcount?.value;
    const cards = ids.map((id, i) => {
      const v = venueOf(id), fits = !hc || !v.capacity || v.capacity >= hc;
      return `<div class="vcard">${photo(v, i + 1)}<div class="body"><b>${esc(v.name)}</b><span class="hood">${esc(v.hood || '')}${v.stepFree ? ' · step-free' : ''}</span>` +
        `<div class="price"><span>${v.price ? money(v.price) : ''}</span><span class="fit ${fits ? '' : 'no'}">fits ${v.capacity ?? '?'}</span></div></div></div>`;
    }).join('');
    addRow('PLEC', `<div class="cards">${cards}</div>`, { extraClass: 'cards-row' });
  }
  function showTyping() {
    $('typing').innerHTML = `<div class="row them first last plec" style="animation-duration:.2s"><div class="av-slot">${orb(28, 'still')}</div><div class="msg-col"><div class="typing-bubble"><i></i><i></i><i></i></div></div></div>`;
    afterAppend();
  }

  /* ---------- The one event handler (same events as the brain) ---------- */
  function handle(evt, opts = {}) {
    instant = !!opts.instant;
    const d = evt.data || {};
    switch (evt.type) {
      case 'inbound': {
        const who = d.fromName || 'Someone';
        addPerson(who);
        const img = (d.attachments || []).find((a) => a.url && String(a.mimeType).startsWith('image/'));
        const body = `${img ? `<img src="${esc(img.url)}" alt="">` : ''}${esc(d.text || (d.attachments?.length ? '📷 screenshot' : ''))}`;
        addRow(who, `<div class="bubble">${body}</div>`, { at: evt.at && !instant ? evt.at : null });
        break;
      }
      case 'agent_message': {
        const img = d.mediaUrl ? `<img src="${esc(d.mediaUrl)}" alt="">` : '';
        addRow('PLEC', `<div class="bubble">${img}${esc(d.text || '')}</div>`);
        setSub('idle');
        break;
      }
      case 'typing': showTyping(); setSub('typing', 4000); break;
      case 'decision': if (d.speak) setSub('thinking', 8000); break;
      case 'plan': {
        const p = d.plan || {};
        S.plan = p;
        S.names = S.names.filter((n) => n !== p.guestOfHonor);
        renderHead(); setSub('idle');
        const key = (p.shortlist || []).join();
        if (key && key !== S.shortlistKey) venueCards(p.shortlist.slice(0, 3));
        S.shortlistKey = key;
        break;
      }
      case 'booking': {
        if (d.status === 'cancelled') { addSys(`Cancelled · ${d.venueName}`); S.booking = null; break; }
        const moved = S.booking && S.booking.id === d.id && S.booking.venueId !== d.venueId;
        S.booking = d;
        const el = moved
          ? addSys(`↺ Moved to ${d.venueName} · ${d.headcount} guests`, 'moved')
          : addSys(`✓ Booked · ${d.venueName} · ${prettyDate(d.date)} · ${d.id}`);
        if (!instant) setTimeout(() => window.PLEC.confetti(el), 120);
        break;
      }
      case 'state_reset': reset(); break;
    }
  }

  /* ---------- Clock ---------- */
  const tick = () => { const d = new Date(); $('clock').textContent = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`; };
  tick(); setInterval(tick, 15000);

  /* ---------- Start ---------- */
  reset();
  let paint = () => {}; // connect() reports state before the controls exist
  const player = window.PLEC.connect({ handle, reset: () => { instant = false; reset(); }, onChange: (st) => paint(st) });
  const paintA = window.PLEC.controls($('controls'), player), paintB = window.PLEC.controls($('controls-head'), player);
  paint = (st) => { paintA(st); paintB(st); };
  paint(player.state);
})();
