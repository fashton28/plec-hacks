/* PLEC chat, the front page. One request shape: POST {agent}/agent/messages
   { sessionId, text } -> { parts }. The conversation lives in localStorage so a
   reload keeps it. The live panels (stage.js) follow this session through
   window.PLEC_FOLLOW. */
(function () {
  const params = new URLSearchParams(location.search);
  const AGENT = (params.get('agent') || location.origin).replace(/\/+$/, '');
  const TURN_TIMEOUT_MS = 45_000;
  const KEY_SESSION = 'plec.sessionId';
  const KEY_LOG = 'plec.log';

  const $ = (id) => document.getElementById(id);
  const $log = $('log'), $input = $('input'), $send = $('send');

  let sessionId = read(KEY_SESSION) || newSessionId();
  write(KEY_SESSION, sessionId);
  /** [{ role: 'user'|'agent'|'note', part }] so a reload redraws the log. */
  let entries = readJson(KEY_LOG) || [];
  let sending = false;

  window.PLEC_FOLLOW = () => sessionId;

  const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>';
  const IDEAS = [
    ['c-brand', '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>', 'I need a venue in Philadelphia for 40 people on October 10'],
    ['c-orange', '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 15h2"/>', 'How much is The Foundry at Fishtown from 6pm to 11pm on October 10 for 40 guests?'],
    ['c-violet', '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/>', 'Show me photos of The Rooftop at Rittenhouse'],
  ];

  /* ---------- One element per part kind. Text is set with textContent, never as HTML. ---------- */
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  /** A bubble of plain text. URLs become links with a short, readable label; the address itself is never fetched. */
  function bubble(text, failed) {
    const el = node('div', `bubble${failed ? ' failed' : ''}`);
    const pieces = String(text ?? '').split(/(https?:\/\/[^\s]+[^\s.,;:!?)])/);
    pieces.forEach((piece, i) => {
      if (i % 2 === 0) { el.append(piece); return; }
      const a = document.createElement('a');
      a.href = piece; a.target = '_blank'; a.rel = 'noreferrer';
      a.textContent = /\/pay\//.test(piece) ? 'your payment link' : piece.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, '');
      el.appendChild(a);
    });
    return el;
  }
  function venueCard(part) {
    const el = document.createElement(part.url ? 'a' : 'div');
    el.className = 'vcard';
    if (part.url) { el.href = part.url; el.target = '_blank'; el.rel = 'noreferrer'; }
    const photo = Array.isArray(part.photoUrls) ? part.photoUrls[0] : null;
    if (photo) { const img = document.createElement('img'); img.src = photo; img.alt = part.title; img.loading = 'lazy'; el.appendChild(img); }
    const t = node('div', 't');
    t.appendChild(node('b', '', part.title));
    if (part.subtitle) t.appendChild(node('span', '', part.subtitle));
    if (part.url) { const map = node('span', 'map', 'Open the map'); map.insertAdjacentHTML('beforeend', ARROW); t.appendChild(map); }
    el.appendChild(t);
    return el;
  }
  function shot(part) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = part.url; img.alt = part.caption || 'Photo from PLEC'; img.loading = 'lazy';
    fig.appendChild(img);
    return fig;
  }
  function payLink(part) {
    // A plain link the guest chooses to open. Never fetched by the page: opening it is the guest's act.
    const el = document.createElement('a');
    // Paying is the one action that matters most, so only payment links get the solid button.
    el.className = /^pay\b/i.test(part.label || '') ? 'paylink' : 'paylink soft'; el.href = part.url; el.target = '_blank'; el.rel = 'noreferrer';
    el.textContent = part.label;
    el.insertAdjacentHTML('beforeend', ARROW);
    return el;
  }

  /* ---------- Drawing the log. Runs of cards become one swipeable strip, runs of photos one grid. ---------- */
  function draw() {
    $log.replaceChildren();
    if (entries.length === 0 && !sending) { $log.appendChild(welcome()); return; }
    let strip = null, shots = null;
    for (const entry of entries) {
      const kind = entry.role === 'agent' ? entry.part?.kind : null;
      if (kind !== 'card') strip = null;
      if (kind !== 'image') shots = null;
      if (entry.role === 'note') { $log.appendChild(noteRow(entry)); continue; }
      if (kind === 'card') {
        if (!strip) { strip = node('div', 'strip'); $log.appendChild(strip); }
        strip.appendChild(venueCard(entry.part));
      } else if (kind === 'image') {
        if (!shots) { shots = node('div', 'shots'); $log.appendChild(shots); }
        shots.appendChild(shot(entry.part));
      } else {
        const row = node('div', `row ${entry.role}`);
        const part = entry.part || {};
        row.appendChild(part.kind === 'link' ? payLink(part) : bubble(part.kind === 'text' ? part.text : `[${part.kind || 'unknown'} part]`, entry.failed));
        $log.appendChild(row);
      }
    }
    if (sending) {
      const row = node('div', 'row agent');
      row.innerHTML = '<div class="typing" role="status" aria-label="PLEC is typing"><i></i><i></i><i></i></div>';
      $log.appendChild(row);
    }
    $log.scrollTop = $log.scrollHeight;
  }
  function noteRow(entry) {
    const el = node('div', 'chat-note', entry.part.text);
    if (entry.retryText) {
      const btn = node('button', '', 'Retry');
      btn.type = 'button';
      btn.onclick = () => send(entry.retryText);
      el.append(' ', btn);
    }
    return el;
  }
  function welcome() {
    const el = node('div', 'welcome');
    el.appendChild(node('h2', '', 'What are we planning?'));
    el.appendChild(node('p', '', 'Venues, DJs, caterers and more in Philadelphia, New York and Washington. I quote exact prices, and I only book once you say yes.'));
    const ideas = node('div', 'ideas');
    for (const [tone, icon, text] of IDEAS) {
      const btn = node('button', 'idea');
      btn.type = 'button';
      btn.innerHTML = `<span class="ic ${tone}"><svg viewBox="0 0 24 24">${icon}</svg></span>`;
      btn.appendChild(node('span', '', text));
      btn.onclick = () => send(text);
      ideas.appendChild(btn);
    }
    el.appendChild(ideas);
    return el;
  }

  /* ---------- Talking to the agent ---------- */
  async function send(text) {
    text = (text || '').trim();
    if (!text || sending) return;
    entries = entries.filter((e) => !(e.role === 'note' && e.retryText === text));
    const mine = { role: 'user', part: { kind: 'text', text } };
    entries.push(mine);
    sending = true;
    $send.disabled = true;
    persist(); draw();
    try {
      const res = await fetch(`${AGENT}/agent/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, text }),
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (parts.length === 0) throw new Error('The agent returned no parts');
      for (const part of parts) entries.push({ role: 'agent', part });
    } catch (err) {
      mine.failed = true;
      const why = err && err.name === 'TimeoutError' ? `no reply in ${TURN_TIMEOUT_MS / 1000}s` : (err && err.message) || String(err);
      entries.push({ role: 'note', part: { kind: 'text', text: `That one did not go through: ${why}.` }, retryText: text });
    } finally {
      sending = false;
      persist(); draw();
      $input.focus();
      updateSend();
    }
  }

  async function reset() {
    try {
      await fetch(`${AGENT}/agent/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(5000) });
    } catch {
      // The reset endpoint is optional in the contract; a fresh sessionId is a fresh conversation regardless.
    }
    sessionId = newSessionId();
    write(KEY_SESSION, sessionId);
    entries = [];
    persist(); draw();
    dispatchEvent(new Event('plec:newsession'));
    $input.focus();
  }

  /* ---------- Composer ---------- */
  function updateSend() { $send.disabled = sending || $input.value.trim().length === 0; }
  function resize() { $input.style.height = 'auto'; $input.style.height = `${Math.min($input.scrollHeight, 120)}px`; }
  function submit() {
    const text = $input.value;
    $input.value = '';
    resize(); updateSend();
    send(text);
  }
  $input.addEventListener('input', () => { updateSend(); resize(); });
  $input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  $send.addEventListener('click', submit);
  $('reset').addEventListener('click', reset);

  /* ---------- Helpers ---------- */
  function newSessionId() {
    // The evaluator sends UUIDs; the page does the same so the agent sees one id shape.
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
  }
  // localStorage can throw (private windows, blocked storage); the page must work without it.
  function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }
  function readJson(key) { try { return JSON.parse(read(key) || 'null'); } catch { return null; } }
  function persist() { write(KEY_LOG, JSON.stringify(entries.slice(-200))); }

  draw();
  $input.focus();
})();
