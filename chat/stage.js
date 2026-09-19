/* PLEC live panels. One code path: handle() takes the events agent/stage.js
   emits ({ type, chatId, data, at, replay? }) from GET /events.
   stage.html follows whichever conversation spoke last. index.html sets
   window.PLEC_FOLLOW = () => sessionId, so its panels show that chat only.
   A page may leave panels out: every render checks its element exists. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const orb = (size, cls = '') => `<div class="orb ${cls}" style="--s:${size}px"><div class="orb-body"><div class="orb-swirl"></div><div class="orb-ribbon"></div></div><div class="orb-ring"></div></div>`;

  const day = (d) => new Date(`${d}T12:00:00`);
  const prettyDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? day(d).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' }) : String(d ?? ''));
  const hr = (t) => { const [h, m] = String(t).split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`; };
  const timeRange = (a, b) => `${hr(a)} to ${hr(b)}`;

  /* ---------- State ---------- */
  let S, instant = false, settleTimer = null;
  function reset(chatId = null) {
    // bookings: every booking this conversation touched, by reference, in the order they first appeared. A package is several.
    S = { chatId, plan: {}, pending: null, bookings: new Map(), checked: 0, held: 0 };
    $('feed').innerHTML = '<div class="feed-empty">Every lookup, quote and booking shows up here as it happens.</div>';
    if ($('latest')) $('latest').outerHTML = '<div class="latest-msg" id="latest"><span class="latest-empty">Waiting for someone to say hi</span></div>';
    if ($('options')) { $('options').hidden = true; $('options').innerHTML = ''; }
    $('booking').dataset.html = '';
    renderHero(); renderBooking(); renderCounter(); setAgent('listening');
  }

  /* ---------- Small effects ---------- */
  function glow(el) {
    if (!el || instant) return;
    el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
  }
  function setText(id, text) {
    const el = $(id);
    if (el.textContent !== String(text)) { el.textContent = text; glow(el); }
  }
  function countTo(el, to) {
    const from = parseInt(el.textContent, 10) || 0;
    if (from === to) return;
    glow(el);
    if (instant || reduced) { el.textContent = to; return; }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 900);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function confetti(anchor) {
    if (reduced || instant || !anchor) return;
    let cv = document.querySelector('canvas.confetti');
    if (!cv) { cv = document.createElement('canvas'); cv.className = 'confetti'; document.body.appendChild(cv); }
    const ctx = cv.getContext('2d');
    cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const r = anchor.getBoundingClientRect(), ox = r.left + r.width / 2, oy = r.top + r.height / 3;
    const spread = Math.min(18, innerWidth / 60);
    const cols = ['#7B3FE4', '#3B82F6', '#4FA54D', '#F5B82E', '#F08A2C', '#E15543', '#C9B0F4', '#F8DE9A'];
    const ps = Array.from({ length: 120 }, () => ({ x: ox, y: oy, vx: (Math.random() - .5) * spread, vy: -Math.random() * 15 - 4, s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: cols[Math.random() * cols.length | 0] }));
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

  /* ---------- Agent status and orb ---------- */
  const STATUS = { listening: 'Listening', thinking: 'Thinking', speaking: 'Replying', booked: 'Booked' };
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
  const times = (n) => `${n} ${n === 1 ? 'time' : 'times'}`;
  function renderCounter() {
    $('status-sub').textContent = `checked the sandbox ${times(S.checked)}, held back ${times(S.held)}`;
  }

  /* ---------- Latest in the chat ---------- */
  function showLatest(name, html, { plec = false, where = '' } = {}) {
    if (!$('latest')) return;
    const n = document.createElement('div');
    n.className = `latest-msg ${plec ? 'plec' : ''}`; n.id = 'latest';
    n.innerHTML = `${plec ? orb(32, 'still') : `<div class="av">${esc(name.slice(-1))}</div>`}<b>${esc(name)}</b>${where ? `<span class="where">${esc(where)}</span>` : ''}${html}`;
    if (instant) n.style.animation = 'none';
    $('latest').replaceWith(n);
  }

  /* ---------- Activity feed ---------- */
  const ICONS = {
    heard: '<path d="M4 5h16v11H9l-5 4z"/>',
    looked: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    quoted: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 15h2"/>',
    held: '<rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    booked: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    issue: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
    quiet: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    spoke: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  };
  const TAG = { heard: 'Heard', looked: 'Checked', quoted: 'Quoted', held: 'Held back', booked: 'Done', issue: 'Honest no', quiet: 'Stayed quiet', spoke: 'Replied' };
  function activity(kind, title, detail) {
    const k = ICONS[kind] ? kind : 'looked';
    const feed = $('feed');
    feed.querySelector('.feed-empty')?.remove();
    const row = document.createElement('div');
    row.className = `item k-${k}`;
    row.innerHTML = `<span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg></span>` +
      `<div class="t"><b>${esc(title)}</b><span>${esc(detail || '')}</span></div><span class="tag k-${k}">${TAG[k]}</span>`;
    if (instant) row.style.animation = 'none';
    feed.prepend(row);
    while (feed.children.length > 12) feed.lastElementChild.remove();
  }

  /* ---------- Hero ---------- */
  function renderHero() {
    const p = S.plan;
    $('hero-title').textContent = p.city ? `An event in ${p.city}` : p.venue ? `An event at ${p.venue}` : 'Listening for a plan';
    countTo($('guests'), Number(p.guests) || 0);
    setText('chip-date', p.date ? prettyDate(p.date) : 'Not set');
    const live = liveBookings();
    setText('chip-venue', live[0]?.venue || p.venue || 'Not picked');
    setText('chip-total', live.length ? sumTotals(live) : p.total || 'No quote yet');
  }

  /* ---------- Options the agent just showed ---------- */
  function renderOptions(cards) {
    const el = $('options');
    if (!el) return;
    // One card just repeats the venue already on the quote or the ticket. Options are for choosing between several.
    if (cards.length < 2) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = cards.slice(0, 4).map((c) => `<article class="option"><div class="shot" ${c.photoUrl ? `style="background-image:url(&quot;${esc(c.photoUrl)}&quot;)"` : ''}></div>` +
      `<div class="t"><b>${esc(c.title)}</b><span>${esc(c.subtitle)}</span></div></article>`).join('');
    if (instant) el.querySelectorAll('.option').forEach((x) => { x.style.animation = 'none'; });
  }

  /* ---------- Booking zone ---------- */
  const STATE = { pending_payment: 'Waiting on payment', requested: 'Waiting on the host', confirmed: 'Confirmed', cancelled: 'Cancelled' };
  const NOTE = {
    pending_payment: 'Held, not confirmed. PLEC sent the guest a payment link and never pays for them.',
    requested: 'The host still has to approve this one. Nothing is due yet.',
    confirmed: 'Paid and confirmed.',
  };
  const liveBookings = () => [...S.bookings.values()].filter((b) => b.status !== 'cancelled');
  /** Totals arrive formatted ("$1,815.00"), so add them up in cents and format the same way. */
  function sumTotals(list) {
    const cents = list.reduce((sum, b) => sum + Math.round(Number(String(b.total ?? '').replace(/[^0-9.]/g, '')) * 100 || 0), 0);
    return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function renderBooking() {
    const box = $('booking'), q = S.pending;
    // Live bookings first. A cancelled one stays visible so the cancellation is seen to have happened.
    const all = [...S.bookings.values()], shown = [...all.filter((b) => b.status !== 'cancelled'), ...all.filter((b) => b.status === 'cancelled')];
    const cards = [];
    if (q) {
      cards.push(`<div class="card pending bk"><div class="pending-head">${orb(46, 'live thinking')}<div><h3 class="card-title">Waiting for a clear yes</h3>` +
        `<div class="card-sub">${esc(q.venue)} · ${esc(prettyDate(q.date))} · ${esc(timeRange(q.startTime, q.endTime))} · ${esc(q.guests)} guests</div></div></div>` +
        `<div class="lines">${(q.lines || []).filter(([, v]) => v).map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}</div>` +
        `<div class="total"><span>All-in total, straight from the sandbox</span><b class="num">${esc(q.total)}</b></div></div>`);
    }
    for (const b of shown) {
      const refund = b.status === 'cancelled' && b.refund ? `Refund: ${b.refund}.` : '';
      cards.push(`<div class="card ticket bk"><div class="shot" ${b.photoUrl ? `style="background-image:url(&quot;${esc(b.photoUrl)}&quot;)"` : ''}></div><div class="stub">` +
        `<div class="booked-row"><span class="state s-${esc(b.status)}">${esc(b.paid ? 'Paid' : STATE[b.status] || b.status)}</span><span class="code">${esc(b.ref)}</span></div>` +
        `<div class="venue-name">${esc(b.venue)}</div>` +
        `<div class="kv"><div><small>Date</small><b>${esc(prettyDate(b.date))}</b></div><div><small>Time</small><b>${esc(timeRange(b.startTime, b.endTime))}</b></div>` +
        `<div><small>Guests</small><b>${esc(b.guests)}</b></div><div><small>Total</small><b class="num">${esc(b.total)}</b></div></div>` +
        `<p class="note">${esc(refund || NOTE[b.status] || '')}</p></div></div>`);
    }
    if (!cards.length) {
      cards.push('<div class="card idle"><span class="lock"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>' +
        '<div>Nothing booked yet. PLEC only books after the guest has seen the exact total and <b>said yes</b>.</div></div>');
    }
    const html = cards.join('');
    if (box.dataset.html === html) return;
    box.dataset.html = html;
    box.innerHTML = html;
    if (instant) box.querySelectorAll('.bk').forEach((x) => { x.style.animation = 'none'; });
  }

  /* ---------- The one event handler ---------- */
  function handle(evt) {
    instant = !!evt.replay;
    const d = evt.data || {};
    const follow = window.PLEC_FOLLOW;
    if (follow) {
      // Panels beside a chat: that conversation only.
      const mine = follow();
      if (evt.chatId !== mine) return;
      if (S.chatId !== mine) { reset(mine); instant = !!evt.replay; }
    } else if (evt.chatId !== S.chatId) {
      // The projector view follows whoever spoke last. Other conversations' background events are ignored.
      if (evt.type !== 'inbound') return;
      reset(evt.chatId);
      instant = !!evt.replay;
    }
    switch (evt.type) {
      case 'inbound':
        showLatest(d.fromName || 'Guest', `<span class="text">${esc(d.text)}</span>`, { where: d.channel });
        activity('heard', `${d.fromName || 'Guest'}, ${d.channel || 'chat'}`, d.text);
        break;
      case 'typing':
        showLatest('PLEC', '<span class="typing"><i></i><i></i><i></i></span>', { plec: true });
        setAgent('speaking', 9000);
        break;
      case 'llm_call': setAgent('thinking', 9000); break;
      case 'activity':
        if (d.kind === 'held') S.held += 1; else if (d.kind !== 'issue') S.checked += 1;
        renderCounter();
        activity(d.kind, d.title, d.detail);
        break;
      case 'plan': S.plan = d; renderHero(); break;
      case 'pending': S.pending = evt.data; renderBooking(); break;
      case 'booking':
        S.bookings.set(d.ref, d); S.pending = null; renderBooking(); renderHero();
        if (d.fresh) { setAgent('booked', 3500); setTimeout(() => confetti($('booking')), 150); }
        break;
      case 'agent_message':
        showLatest('PLEC', `<span class="text">${esc(d.text)}</span>`, { plec: true });
        activity('spoke', 'PLEC replied', d.text);
        renderOptions(d.cards || []);
        if ($('status-main').textContent !== STATUS.booked) setAgent('speaking', 1800);
        break;
      case 'decision': if (!d.speak) activity('quiet', 'Stayed quiet', d.reason); break;
      case 'state_reset': reset(null); break;
    }
  }

  /* ---------- Connect ---------- */
  function setLive(on, text) {
    if (!$('live-pill')) return;
    $('live-pill').className = `live-pill ${on ? 'on' : 'off'}`;
    $('live-text').textContent = text;
  }
  reset(null);
  // The chat page starts a new conversation: clear the panels with it.
  addEventListener('plec:newsession', () => reset(null));
  if (!('EventSource' in window)) { setLive(false, 'This browser cannot stream events'); return; }
  const es = new EventSource('events');
  es.onopen = () => setLive(true, 'Live');
  es.onerror = () => setLive(false, 'Reconnecting');
  es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (err) { console.warn('PLEC stage: bad event', err); } };
})();
