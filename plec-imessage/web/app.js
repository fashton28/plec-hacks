/* PLEC stage: state, rendering, playback controls and the live hook. */
(function () {
  const { venues, timeline, people } = window.DEMO;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (n) => '$' + Number(n).toLocaleString('en-US');
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const COLORS = { Tony: '#DAD6F6', Dani: '#F9D9C8', Marcus: '#DCE8C8', Priya: '#F4CACA', Sofia: '#CFE0F6' };
  const BAR_COLORS = ['#A99BF4', '#9FBDF2', '#A4D9B8'];

  /* ---------- Fit the 1920-wide stage to the window ---------- */
  function fit() {
    const s = innerWidth / 1920;
    const stage = $('stage');
    stage.style.transform = `scale(${s})`;
    stage.style.height = innerHeight / s + 'px';
    const colH = innerHeight / s - 72;
    const phoneScale = Math.min((colH - 56) / 872, (1920 * 0.38 - 60) / 418, 1.12);
    $('phone-fit').style.transform = `scale(${phoneScale})`;
  }
  addEventListener('resize', fit);
  fit();

  /* ---------- Small components ---------- */
  const orb = (size, cls = '') => `<div class="orb ${cls}" style="--s:${size}px"><div class="orb-body"><div class="orb-swirl"></div><div class="orb-ribbon"></div></div><div class="orb-ring"></div></div>`;
  const avatar = (name, size = 28) => name === 'PLEC'
    ? orb(size, 'still')
    : `<div class="av" style="width:${size}px;height:${size}px;background:${COLORS[name] || '#E6E1F0'}">${esc(name[0])}</div>`;

  function tile(v) {
    const [a, b] = v.colors;
    const lights = Array.from({ length: 9 }, (_, i) => {
      const x = 16 + i * 26, y = 26 + Math.sin(i / 8 * Math.PI) * 16;
      return `<circle cx='${x}' cy='${y}' r='2.2' fill='%23FFF6D8' opacity='.95'/>`;
    }).join('');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 150' preserveAspectRatio='xMidYMid slice'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs>` +
      `<rect width='240' height='150' fill='url(%23g)'/>` +
      `<path d='M10 26 Q120 62 232 26' stroke='%23fff' stroke-opacity='.5' fill='none'/>${lights}` +
      `<path d='M0 104 C60 78 120 88 170 104 S220 96 240 90 V150 H0Z' fill='%23fff' opacity='.3'/>` +
      `<path d='M0 126 C70 108 150 120 240 110 V150 H0Z' fill='%23fff' opacity='.45'/></svg>`;
    return `background-image:url(&quot;data:image/svg+xml;utf8,${svg.replace(/#/g, '%23')}&quot;)`;
  }
  const photo = (v, badge) => `<div class="photo" style="${tile(v)}">${badge ? `<span class="badge">${badge}</span>` : ''}<span class="initial">${esc(v.short.replace(/^The /, '')[0])}</span></div>`;

  function glow(el) {
    if (!el || instant) return;
    el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
  }
  function countTo(el, to) {
    const from = parseInt(el.textContent, 10);
    if (instant || reduced || isNaN(from)) { el.textContent = to; return; }
    const t0 = performance.now(), dur = 1000;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- Confetti ---------- */
  function confetti(anchor) {
    if (instant || reduced) return;
    const cv = $('confetti'), ctx = cv.getContext('2d');
    cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const r = anchor.getBoundingClientRect();
    const ox = r.left + r.width / 2, oy = r.top + r.height / 3;
    const cols = ['#A99BF4', '#9FBDF2', '#A4D9B8', '#F3D48E', '#F1B7AE', '#F4C9DE', '#F65A4C'];
    const ps = Array.from({ length: 110 }, () => ({
      x: ox, y: oy, vx: (Math.random() - .5) * 16, vy: -Math.random() * 14 - 4,
      s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * .4,
      c: cols[Math.random() * cols.length | 0],
    }));
    const t0 = performance.now();
    (function frame(t) {
      const k = (t - t0) / 1600;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      if (k >= 1) return;
      ctx.globalAlpha = 1 - k * k;
      for (const p of ps) {
        p.vy += .45; p.vx *= .985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * .66); ctx.restore();
      }
      requestAnimationFrame(frame);
    })(t0);
  }

  /* ---------- State ---------- */
  let S, instant = false, clockMin;
  function reset() {
    S = { dates: [], allFor: null, constraints: [], shortlist: [], votes: {}, lead: null, guests: null, bookedGuests: null,
      capacity: null, booking: null, issue: null, spoke: 0, quiet: 0, lastFrom: null };
    clockMin = 19 * 60 + 12;
    $('msgs').innerHTML = ''; $('typing').innerHTML = ''; $('feed').innerHTML = ''; $('booking').innerHTML = '';
    $('guests').textContent = '—'; $('brain-main').classList.remove('has-pending', 'is-booked'); $('trend').textContent = ''; $('trend').className = 'trend';
    for (const id of ['chip-budget', 'chip-date', 'chip-venue']) $(id).textContent = '—';
    $('insight').outerHTML = '<div class="txt" id="insight"><small>✦ Quiet insight</small><b>Listening to the group…</b></div>';
    renderWhos(); renderVotes(); renderCounter(); setAgent('listening');
  }

  /* ---------- Chat ---------- */
  function scrollChat() {
    const c = $('chat');
    c.scrollTo({ top: c.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  }
  function addMessage(e) {
    const who = e.from, side = who === 'Tony' ? 'me' : 'them';
    clockMin += 1;
    const last = $('msgs').lastElementChild;
    const cont = S.lastFrom === who && last;
    if (cont) last.classList.remove('last');
    S.lastFrom = who;
    const time = `${Math.floor(clockMin / 60) - 12}:${String(clockMin % 60).padStart(2, '0')} PM`;
    let inner;
    if (e.card) {
      const v = venues[e.card];
      inner = `<div class="vcard">${photo(v, e.n)}<div class="body"><b>${esc(v.name)}</b><span>${esc(v.hood)} · ${esc(v.note)}</span>` +
        `<div class="price"><span>${money(v.price)} total</span><span>fits ${v.capacity}</span></div></div></div>`;
    } else {
      inner = `<div class="bubble">${esc(e.text)}</div>`;
    }
    const row = document.createElement('div');
    row.className = `row ${side} ${who === 'PLEC' ? 'plec' : ''} ${cont ? '' : 'first'} last`;
    const label = who === 'PLEC' ? 'PLEC <span style="color:var(--violet)">✦</span>' : esc(who);
    row.innerHTML = side === 'me'
      ? `<div class="msg-col">${inner}<div class="time">${time}</div></div>`
      : `<div class="av-slot">${avatar(who)}</div><div class="msg-col"><div class="who">${label}</div>${inner}</div>`;
    if (instant) row.style.animation = 'none';
    $('msgs').appendChild(row);
    $('typing').innerHTML = '';
    scrollChat();
  }
  function setTyping(e) {
    if (!e.on || e.who === 'Tony') { $('typing').innerHTML = ''; return; }
    $('typing').innerHTML = `<div class="row them first last" style="animation-duration:.2s"><div class="av-slot">${avatar(e.who)}</div><div class="msg-col"><div class="typing"><i></i><i></i><i></i></div></div></div>`;
    scrollChat();
  }

  /* ---------- Agent / orb ---------- */
  const STATUS = { listening: 'Listening quietly', thinking: 'Thinking…', speaking: 'Typing…', booked: 'Booked ✓' };
  function setAgent(state) {
    document.querySelectorAll('.orb.live').forEach((o) => {
      o.classList.remove('thinking', 'speaking', 'celebrate');
      if (state === 'thinking' || state === 'speaking') o.classList.add(state);
      if (state === 'booked' && !instant) { o.classList.add('celebrate'); setTimeout(() => o.classList.remove('celebrate'), 1000); }
    });
    const m = $('status-main');
    m.textContent = STATUS[state] || state;
    m.classList.toggle('booked', state === 'booked');
  }
  function renderCounter() {
    const t = `Spoke ${S.spoke}× · stayed quiet ${S.quiet}×`;
    $('counter').textContent = t; $('status-sub').textContent = t;
  }

  /* ---------- Brain ---------- */
  function applyPlan(p) {
    if (p.dates) S.dates = p.dates.map((d) => ({ ...d, no: [...d.no] }));
    if (p.no) { const d = S.dates.find((x) => x.d === p.no.d); if (d) d.no.push(p.no.who); }
    if (p.allFor) S.allFor = p.allFor;
    if (p.constraint) S.constraints.push(p.constraint);
    if (p.dates || p.no || p.allFor || p.constraint) renderWhos(p.no);
    if (p.shortlist) { S.shortlist = p.shortlist; renderVotes(); }
    if (p.lead) { S.lead = p.lead; renderVotes(); }
    if (p.budget) { $('chip-budget').textContent = p.budget; glow($('chip-budget')); }
    if (p.date) { $('chip-date').textContent = p.date; glow($('chip-date')); }
    if (p.venue) { $('chip-venue').textContent = p.venue; glow($('chip-venue')); }
    if (p.guests != null) { S.guests = p.guests; countTo($('guests'), p.guests); glow($('guests')); renderTrend(); }
  }
  function renderTrend() {
    const t = $('trend');
    if (S.bookedGuests && S.guests > S.bookedGuests) {
      const over = S.capacity && S.guests > S.capacity ? S.guests - S.capacity : 0;
      t.className = 'trend ' + (over ? 'bad' : 'up');
      t.textContent = over ? `↗ +${S.guests - S.bookedGuests} · over capacity by ${over}` : `↗ +${S.guests - S.bookedGuests} since booking · fits ${S.capacity}`;
    } else if (S.guests) {
      t.className = 'trend up'; t.textContent = S.capacity ? `fits ${S.capacity} · room to spare` : 'Tony: “40-45 ppl”';
    }
    glow(t);
  }
  function renderWhos(changed) {
    const el = $('whos');
    if (!S.dates.length) { el.innerHTML = '<div class="empty" style="height:180px">No dates mentioned yet</div>'; return; }
    let h = `<div class="grid" style="grid-template-columns: 120px repeat(${S.dates.length}, 1fr)"><div></div>`;
    for (const d of S.dates) h += `<div class="h ${S.allFor === d.d ? 'all' : ''}">${d.label}</div>`;
    for (const p of people) {
      h += `<div class="person">${avatar(p, 28)}${p}</div>`;
      for (const d of S.dates) {
        const no = d.no.includes(p), yes = !no && S.allFor === d.d;
        const pop = changed && changed.d === d.d && changed.who === p;
        h += `<div class="cell ${no ? 'n' : yes ? 'y pop' : ''} ${pop ? 'pop' : ''}">${no ? '✕' : yes ? '✓' : '·'}</div>`;
      }
    }
    h += '</div>';
    if (S.constraints.length) h += `<div class="constraints">${S.constraints.map((c, i) => `<span class="cpill" style="${i < S.constraints.length - 1 || instant ? 'animation:none' : ''}">${esc(c)}</span>`).join('')}</div>`;
    el.innerHTML = h;
    $('whos-sub').textContent = S.allFor ? `Sun ${S.allFor} works for all ✓` : 'dates × people';
  }
  function renderVotes() {
    const el = $('votes');
    if (!S.shortlist.length) { el.innerHTML = '<div class="empty">PLEC hasn\'t suggested venues yet</div>'; $('votes-sub').textContent = 'no options yet'; return; }
    if (!el.querySelector('.bar-col')) {
      el.innerHTML = S.shortlist.map((id, i) => `<div class="bar-col" data-id="${id}"><div class="track"><div class="fill" style="background:${BAR_COLORS[i]}"></div></div><div class="bar-name">#${i + 1} ${esc(venues[id].short)}</div></div>`).join('');
      void el.offsetWidth;
    }
    let total = 0;
    const max = Math.max(1, ...S.shortlist.map((id) => (S.votes[id] || []).length));
    S.shortlist.forEach((id) => {
      const n = (S.votes[id] || []).length; total += n;
      const col = el.querySelector(`[data-id="${id}"]`), fill = col.querySelector('.fill');
      if (instant) fill.style.transition = 'none';
      fill.style.height = n ? `${Math.max(22, (n / people.length) * 100)}%` : '0%';
      fill.textContent = n ? n : '';
      col.classList.toggle('lead', n === max && n > 0);
      if (instant) { void fill.offsetWidth; fill.style.transition = ''; }
    });
    $('votes-sub').textContent = total ? `${total} of ${people.length} voted` : 'waiting for votes';
  }
  function addVote(e) {
    (S.votes[e.venue] = S.votes[e.venue] || []).push(e.who);
    renderVotes();
  }
  function setInsight(text) {
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
  function addActivity(e) {
    if (e.kind === 'quiet') S.quiet++;
    if (e.kind === 'spoke') S.spoke++;
    renderCounter();
    const row = document.createElement('div');
    row.className = `item ${e.kind}`;
    row.innerHTML = `<span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[e.kind]}</svg></span>` +
      `<div class="t"><b>${esc(e.text)}</b><span>${esc(e.sub || '')}</span></div><span class="tag ${e.kind === 'quiet' ? '' : e.kind}">${TAG[e.kind]}</span>`;
    if (instant) row.style.animation = 'none';
    const feed = $('feed');
    feed.prepend(row);
    while (feed.children.length > 9) feed.lastElementChild.remove();
  }

  function setBooking(e) {
    const box = $('booking');
    if (e.state === 'issue') { S.issue = e; }
    else { S.booking = e; S.issue = null; }
    if (e.state === 'booked') { S.bookedGuests = S.bookedGuests || e.guests; S.capacity = venues[e.venue].capacity; }
    let h = '';
    if (S.issue) {
      const v = venues[S.issue.alt];
      h += `<div class="card issue-card bk"><span class="heads-up">Heads up</span><h3>${esc(S.issue.headline)}</h3>` +
        `<div class="alt">${photo(v)}<div><b>${esc(v.name)} · fits ${v.capacity}</b><span>${esc(S.issue.altNote)}</span></div>` +
        `<div class="delta"><b>${esc(S.issue.delta)}</b><br><span class="tag vote">Suggested</span></div></div></div>`;
    }
    const b = S.booking;
    if (b && b.state === 'pending') {
      const v = venues[b.venue];
      h += `<div class="card pending bk"><div class="pending-head">${orb(44, 'live thinking')}<div><div class="card-title">Waiting on Tony to confirm</div><div class="card-sub">${esc(v.name)} · Sun Oct 25 · ${b.guests} guests</div></div></div>` +
        `<div class="lines">${b.lines.map(([k, val]) => `<span>${esc(k)}</span><b>${typeof val === 'number' ? money(val) : esc(val)}</b>`).join('')}</div>` +
        `<div class="total"><span>Total</span><b class="num">${money(b.total)}</b></div></div>`;
    } else if (b && b.state === 'booked') {
      const v = venues[b.venue];
      h += `<div class="card ticket bk">${photo(v)}<div class="stub">` +
        `<div class="booked-row"><span class="booked-word">Booked ✓</span><span class="code">${esc(b.code)}</span>${b.updated ? '<span class="upd">Updated</span>' : ''}</div>` +
        `<div class="venue-name">${esc(v.name)} · ${esc(v.hood)}</div>` +
        `<div class="kv"><div><small>Date</small><b>${esc(b.date)}</b></div><div><small>Time</small><b>${esc(b.time)}</b></div><div><small>Guests</small><b>${b.guests}</b></div><div><small>Total</small><b>${money(b.total)}</b></div><div><small>Deposit</small><b>${money(b.deposit)}</b></div></div>` +
        (b.updated ? `<div class="history">↺ ${esc(b.updated)}</div>` : '') + '</div></div>';
    }
    box.innerHTML = h;
    // Once booked, the date and vote are settled: collapse them so hero + ticket + alert fit on the projector.
    $('brain-main').classList.toggle('has-pending', !!b && b.state === 'pending');
    $('brain-main').classList.toggle('is-booked', !!b && b.state === 'booked');
    if (instant) box.querySelectorAll('.bk').forEach((x) => { x.style.animation = 'none'; });
    renderTrend();
    const main = $('brain-main');
    main.scrollTo({ top: main.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
    if (e.state === 'booked') setTimeout(() => confetti(box), 120);
  }

  /* ---------- Event dispatch ---------- */
  function apply(e) {
    switch (e.type) {
      case 'message': addMessage(e); break;
      case 'typing': setTyping(e); break;
      case 'plan': applyPlan(e); break;
      case 'insight': setInsight(e.text); break;
      case 'activity': addActivity(e); break;
      case 'votes': addVote(e); break;
      case 'booking': setBooking(e); break;
      case 'agent': setAgent(e.state); break;
      case 'reset': reset(); break;
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
    timer = setTimeout(() => { apply(timeline[idx++]); schedule(); }, timeline[idx].delay / speed);
  }
  function jump(n) {
    instant = true;
    while (idx < Math.min(n, timeline.length)) apply(timeline[idx++]);
    instant = false;
  }
  addEventListener('keydown', (k) => {
    if (live) return;
    if (k.code === 'Space') { k.preventDefault(); playing = !playing; schedule(); }
    else if (k.key === 'r' || k.key === 'R') { playing = false; clearTimeout(timer); idx = 0; reset(); }
    else if (k.key === 'ArrowRight' && idx < timeline.length) { apply(timeline[idx++]); schedule(); }
    else if (k.key === '2') { speed = speed === 1 ? 2 : 1; schedule(); }
    else return;
    label();
  });

  /* ---------- Clock ---------- */
  const tick = () => { const d = new Date(); $('clock').textContent = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`; };
  tick(); setInterval(tick, 15000);
  $('head-stack').innerHTML = ['Dani', 'Marcus', 'Priya'].map((p) => avatar(p, 30)).join('') + orb(30, 'still');

  /* ---------- Start: live if /events answers, else mock ---------- */
  reset();
  function startMock() {
    live = false;
    if (params.has('at')) jump(+params.get('at'));
    playing = params.has('autoplay');
    schedule(); label();
  }
  // Under `npx serve` on 5178 there is no backend, so skip the probe (avoids a 404 in the console).
  const tryLive = !params.has('mock') && (params.has('live') || location.port !== '5178');
  if (tryLive && 'EventSource' in window) {
    const es = new EventSource('/events');
    const fallback = setTimeout(() => { es.close(); startMock(); }, 1500);
    es.onopen = () => { clearTimeout(fallback); live = true; label(); };
    es.onerror = () => { if (!live) { clearTimeout(fallback); es.close(); startMock(); } };
    es.onmessage = (m) => { try { apply(JSON.parse(m.data)); } catch (err) { console.warn('bad event', err); } };
  } else {
    startMock();
  }
})();
