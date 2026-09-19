/**
 * In-memory conversation store, one entry per sessionId.
 *
 * A fresh sessionId is a fresh conversation: the chat page mints one and keeps
 * it in localStorage, and the test runner mints one per scenario. Everything
 * the agent needs to remember between turns (the chat history, the guest's
 * name, the quote it is waiting on a "yes" for) lives here. It is in memory on
 * purpose: restarting the server clears every conversation, which is what you
 * want while iterating.
 */

const sessions = new Map();

/** Sessions idle longer than this are dropped so a long-running server does not grow forever. */
const IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * An iMessage chat is one long-lived session: a quote at 9pm gets its "yes" the
 * next morning. Forgetting it after two hours would make the agent greet a
 * returning person like a stranger, so those sessions live for a week.
 */
const IMESSAGE_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const idleTtl = (id) => (id.startsWith('imessage:') ? IMESSAGE_IDLE_TTL_MS : IDLE_TTL_MS);

function newSession(id) {
  return {
    id,
    /** Chat history in OpenAI message shape: { role, content, tool_calls?, tool_call_id? }. */
    messages: [],
    /** Scratch space for your harness: pending quote, guest details, the last search, and so on. */
    state: {},
    createdAt: Date.now(),
    touchedAt: Date.now(),
  };
}

export function getSession(id) {
  sweep();
  let session = sessions.get(id);
  if (!session) {
    session = newSession(id);
    sessions.set(id, session);
  }
  session.touchedAt = Date.now();
  return session;
}

export function resetSession(id) {
  sessions.delete(id);
}

export function sessionCount() {
  return sessions.size;
}

function sweep() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.touchedAt > idleTtl(id)) sessions.delete(id);
  }
}

/** sessionId -> the tail of that session's queue. An id with nothing running has no entry. */
const locks = new Map();

/**
 * Run `fn` while holding the session's mutex. Callers on one session run one
 * at a time, first come first served; other sessions are not held up. The lock
 * is released when `fn` settles, whether it resolves, rejects or throws.
 *
 * Both front doors wrap the WHOLE respond() turn in this. A front door that
 * gives up waiting (its deadline) must still leave the turn inside the lock, so
 * a slow turn can never interleave its history and state with the next one.
 *
 * @template T
 * @param {string} sessionId
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>} whatever `fn` returns or throws
 */
export function withSessionLock(sessionId, fn) {
  const ahead = locks.get(sessionId) ?? Promise.resolve();
  const run = ahead.then(() => fn());
  // The tail never rejects, so one failed turn does not poison the turns queued behind it.
  const tail = run.then(() => {}, () => {});
  locks.set(sessionId, tail);
  tail.then(() => {
    if (locks.get(sessionId) === tail) locks.delete(sessionId);
  });
  return run;
}

/** How many sessions have a turn running or queued. */
export function sessionLockCount() {
  return locks.size;
}
