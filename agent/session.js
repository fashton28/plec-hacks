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
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.touchedAt < cutoff) sessions.delete(id);
  }
}
