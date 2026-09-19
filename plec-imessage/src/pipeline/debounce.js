/**
 * Per-chat burst buffer. Every message resets the timer; when the chat has
 * been quiet for the delay, the batch runs. One run per chat at a time: if
 * messages land mid-run, exactly one more run is queued afterwards.
 */
const chats = new Map();

function slot(chatId) {
  let s = chats.get(chatId);
  if (!s) {
    s = { timer: null, fast: false, fastDelay: 0, running: false, again: false, run: null, waiters: [] };
    chats.set(chatId, s);
  }
  return s;
}

/**
 * Schedule (or re-schedule) a run. A mention asks for the fast lane; follow-up
 * messages in the same burst keep the fast lane but still reset the timer.
 */
export function schedule(chatId, delayMs, run, { fast = false } = {}) {
  const s = slot(chatId);
  s.run = run;
  if (fast) { s.fast = true; s.fastDelay = delayMs; }
  const d = s.fast ? Math.min(delayMs, s.fastDelay) : delayMs;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => fire(chatId), d);
}

async function fire(chatId) {
  const s = slot(chatId);
  clearTimeout(s.timer);
  s.timer = null;
  s.fast = false;
  if (s.running) { s.again = true; return; }
  s.running = true;
  try {
    await s.run?.(chatId);
  } finally {
    s.running = false;
    if (s.again) {
      s.again = false;
      fire(chatId);
    } else if (!s.timer) {
      const waiters = s.waiters.splice(0);
      waiters.forEach((w) => w());
    }
  }
}

/** Run now instead of waiting out the timer (replay --fast uses this). */
export function flush(chatId) {
  const s = slot(chatId);
  if (s.timer) fire(chatId);
}

/** Resolves once nothing is scheduled or running for this chat. */
export function whenIdle(chatId) {
  const s = slot(chatId);
  if (!s.timer && !s.running) return Promise.resolve();
  return new Promise((resolve) => s.waiters.push(resolve));
}

export function cancel(chatId) {
  const s = slot(chatId);
  clearTimeout(s.timer);
  s.timer = null;
}
