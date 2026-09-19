/* Shared by index.html (brain) and phone.html (chat): formatting, the orb,
   avatars, venue tiles, confetti, and the event source (live SSE or the mock
   player). Pages only supply handle(evt) and reset(). */
(function () {
  const venues = window.DEMO.venues;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (n) => '$' + Math.round(Number(n)).toLocaleString('en-US');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const day = (d) => new Date(`${d}T12:00:00`);
  const prettyDate = (d) => day(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
  const shortDate = (d) => { const x = day(d); return `${x.toLocaleDateString('en-US', { weekday: 'short' })} ${x.getDate()}`; };
  const hr = (t) => { const [h, m] = String(t).split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`; };
  const timeRange = (a, b) => `${hr(a).replace(/[ap]m$/, '')}–${hr(b)}`;
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const venueOf = (id, fallbackName) => venues[id] || { id: String(id), name: fallbackName || String(id).replace(/-/g, ' '), hood: '', capacity: null };
  const shortName = (v) => v.name.replace(/^The /, '');

  // Person colors: confetti tints, assigned in order of appearance.
  const TINTS = [['#EFE7FC', '#7B3FE4'], ['#FDEBDC', '#C9661A'], ['#E7F5E5', '#3E8F3C'], ['#E6EFFE', '#2F6FD6'], ['#FDF3DA', '#A87A10'], ['#FCE5E3', '#C23030']];
  const SKIES = [['#FBE0D4', '#ECE6F8'], ['#FCE8CE', '#F7E1EA'], ['#E6EFFE', '#FBE0D4'], ['#E7F5E5', '#FCE8CE'], ['#EFE7FC', '#FDEBDC']];
  const hash = (s) => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0);
  function tint(name, names = []) {
    const i = names.indexOf(name);
    return TINTS[(i < 0 ? hash(name) : i) % TINTS.length];
  }

  const orb = (size, cls = '') => `<div class="orb ${cls}" style="--s:${size}px"><div class="orb-body"><div class="orb-swirl"></div><div class="orb-ribbon"></div></div><div class="orb-ring"></div></div>`;
  function avatar(name, size = 30, names = []) {
    if (name === 'PLEC') return orb(size, 'still');
    const [bg, fg] = tint(name, names);
    return `<div class="av" style="width:${size}px;height:${size}px;background:${bg};color:${fg}">${esc(String(name)[0] || '?')}</div>`;
  }
  function tile(v) {
    const [a, b] = SKIES[hash(v.id) % SKIES.length];
    const lights = Array.from({ length: 9 }, (_, i) => `<circle cx='${16 + i * 26}' cy='${(26 + Math.sin(i / 8 * Math.PI) * 16).toFixed(1)}' r='2.2' fill='#FFF3D0'/>`).join('');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 150' preserveAspectRatio='xMidYMid slice'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs>` +
      `<rect width='240' height='150' fill='url(#g)'/><path d='M10 26 Q120 62 232 26' stroke='#fff' stroke-opacity='.6' fill='none'/>${lights}` +
      `<path d='M0 104 C60 78 120 88 170 104 S220 96 240 90 V150 H0Z' fill='#fff' opacity='.35'/>` +
      `<path d='M0 126 C70 108 150 120 240 110 V150 H0Z' fill='#fff' opacity='.5'/></svg>`;
    return `background-image:url(&quot;data:image/svg+xml;utf8,${svg.replace(/#/g, '%23')}&quot;)`;
  }
  const photo = (v, badge) => `<div class="photo" style="${tile(v)}">${badge ? `<span class="badge">${badge}</span>` : ''}<span class="initial">${esc(shortName(v)[0])}</span></div>`;

  function confetti(anchor) {
    if (reduced || !anchor) return;
    let cv = document.querySelector('canvas.confetti');
    if (!cv) { cv = document.createElement('canvas'); cv.className = 'confetti'; document.body.appendChild(cv); }
    const ctx = cv.getContext('2d');
    cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const r = anchor.getBoundingClientRect(), ox = r.left + r.width / 2, oy = r.top + r.height / 3;
    const spread = Math.min(18, innerWidth / 60);
    const cols = ['#7B3FE4', '#3B82F6', '#6CC06A', '#F5B82E', '#F08A2C', '#E4543F', '#C9B0F4', '#F8DE9A'];
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

  /* ---------- Event source: live SSE, else the mock player ----------
     Mock playback syncs across tabs (BroadcastChannel), so the brain on the
     projector and the chat view on the laptop screen move together. Whichever
     tab you control leads; the others follow. Across devices, use live mode. */
  function connect({ handle, reset, onChange = () => {} }) {
    const timeline = window.DEMO.timeline;
    const params = new URLSearchParams(location.search);
    const bc = 'BroadcastChannel' in window ? new BroadcastChannel('plec-demo') : null;
    const st = { live: false, playing: false, speed: 1, idx: 0, total: timeline.length, following: false };
    let timer = null;
    const changed = () => onChange(st);
    const send = (msg) => bc && bc.postMessage(msg);

    // instant: catching up (jump or follow), so pages skip animations.
    const apply = (i, instant) => handle(timeline[i], { instant });
    function catchUp(target) {
      const gap = target - st.idx;
      while (st.idx < Math.min(target, timeline.length)) apply(st.idx++, gap > 3);
    }
    function schedule() {
      clearTimeout(timer);
      if (!st.playing || st.idx >= timeline.length) { st.playing = st.playing && st.idx < timeline.length; changed(); return; }
      timer = setTimeout(() => { apply(st.idx++, false); send({ t: 'idx', idx: st.idx }); schedule(); }, timeline[st.idx].delay / st.speed);
      changed();
    }
    function lead() { st.following = false; send({ t: 'lead' }); }
    const api = {
      state: st,
      toggle() { if (st.live) return; lead(); st.playing = !st.playing; schedule(); },
      next() { if (st.live || st.idx >= timeline.length) return; lead(); apply(st.idx++, false); send({ t: 'idx', idx: st.idx }); schedule(); },
      reset() { if (st.live) return; lead(); st.playing = false; clearTimeout(timer); st.idx = 0; reset(); send({ t: 'reset' }); changed(); },
      toggleSpeed() { if (st.live) return; st.speed = st.speed === 1 ? 2 : 1; schedule(); },
    };

    if (bc) bc.onmessage = ({ data: m }) => {
      if (st.live) return;
      if (m.t === 'lead') { st.playing = false; st.following = true; clearTimeout(timer); changed(); }
      else if (m.t === 'idx' && m.idx > st.idx) { catchUp(m.idx); changed(); }
      else if (m.t === 'reset') { st.playing = false; clearTimeout(timer); st.idx = 0; reset(); changed(); }
      else if (m.t === 'hello' && st.idx > 0) send({ t: 'idx', idx: st.idx });
    };

    addEventListener('keydown', (k) => {
      if (k.target.closest && k.target.closest('input, textarea')) return;
      if (k.code === 'Space') { k.preventDefault(); api.toggle(); }
      else if (k.key === 'r' || k.key === 'R') api.reset();
      else if (k.key === 'ArrowRight') api.next();
      else if (k.key === '2') api.toggleSpeed();
    });

    function startMock() {
      st.live = false;
      if (params.has('at')) catchUp(+params.get('at'));
      else send({ t: 'hello' });
      st.playing = params.has('autoplay');
      schedule();
    }
    // `npx serve` on 5178 has no backend, so skip the probe there (avoids a 404 in the console).
    const tryLive = !params.has('mock') && (params.has('live') || location.port !== '5178');
    if (tryLive && 'EventSource' in window) {
      const es = new EventSource('/events');
      const fallback = setTimeout(() => { es.close(); startMock(); }, 1500);
      es.onopen = () => { clearTimeout(fallback); if (!st.live) { st.live = true; reset(); } changed(); };
      es.onerror = () => { if (!st.live) { clearTimeout(fallback); es.close(); startMock(); } };
      es.onmessage = (m) => { try { handle(JSON.parse(m.data), { instant: false }); } catch (err) { console.warn('PLEC: bad event', err); } };
    } else {
      startMock();
    }
    changed();
    return api;
  }

  /* Small control pill: play/pause, reset, speed, mode. Works by touch and by keys. */
  function controls(el, api) {
    el.innerHTML = '<button class="ctl" data-a="toggle" aria-label="Play or pause"></button><button class="ctl" data-a="reset" aria-label="Restart">↺</button><button class="ctl speed" data-a="toggleSpeed" aria-label="Speed">1×</button><span class="mode-text"></span>';
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) api[b.dataset.a](); });
    return (st) => {
      el.classList.toggle('is-live', st.live);
      el.querySelector('[data-a="toggle"]').textContent = st.playing ? '❚❚' : '▶';
      el.querySelector('.speed').textContent = st.speed + '×';
      el.querySelector('.mode-text').textContent = st.live ? 'LIVE' : st.idx >= st.total ? 'MOCK · done' : `MOCK${st.playing ? '' : st.following ? ' · synced' : ' · paused'}`;
    };
  }

  window.PLEC = { esc, money, reduced, prettyDate, shortDate, hr, timeRange, cap, venueOf, shortName, tint, orb, avatar, photo, confetti, connect, controls };
})();
