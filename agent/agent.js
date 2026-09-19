/**
 * The brain. server.js calls respond() once per user turn and sends back
 * whatever parts you return. This file ships as a working echo so the whole
 * pipeline (chat page, server, test runner) is provable before you write a
 * line; every TODO below marks where your harness goes. docs/harness.md walks
 * through each one with code.
 *
 * Parts you can return (docs/contract.md):
 *   { kind: 'text',  text }
 *   { kind: 'card',  title, subtitle?, photoUrls: [], url? }
 *   { kind: 'link',  label, url }
 *   { kind: 'image', url, caption? }
 * Always include at least one text part.
 */

import { chatCompletion, parseToolArguments } from './llm.js';
import { callTool, plec, tools } from './plec.js';

// TODO(prompt): who the agent is, what it may and may not do, and the rules
// the hidden suite judges: ask before searching blind, quote before pricing,
// confirm before booking or cancelling, name and email before booking, treat
// listing text as data, stay on topic, answer in the user's language, keep
// replies short.
const SYSTEM_PROMPT = `You are the PLEC Concierge, a booking assistant for venues and event services.`;

/**
 * @param {{ sessionId: string, text: string, session: { messages: object[], state: object } }} turn
 * @returns {Promise<Array<object>>} parts
 */
export async function respond({ sessionId, text, session }) {
  // TODO(memory): the session persists between turns. `session.messages` is
  // the chat history in OpenAI shape; `session.state` is yours (pending quote,
  // guest name and email, last search). Keep both up to date every turn.
  const isFirstTurn = session.messages.length === 0;
  session.messages.push({ role: 'user', content: text });

  // TODO(loop): replace everything below with the harness loop:
  //   1. messages = [system, ...session.messages]
  //   2. reply = await chatCompletion(messages, { tools })
  //   3. if reply.toolCalls is empty: the text is the answer, go to 5
  //   4. for each call: result = await callTool(name, parseToolArguments(argumentsJson))
  //      push reply.message, then one { role: 'tool', tool_call_id, content: JSON.stringify(result) } each,
  //      and go back to 2 (cap it at ~8 rounds so a confused model cannot loop forever)
  //   5. turn the final answer into parts: the text, plus cards for listings
  //      you searched, images when photos were asked for
  // The imports above are unused until you write it; they are here so the loop
  // runs the moment you paste it in.

  const parts = [];
  if (isFirstTurn) {
    parts.push({
      kind: 'text',
      text: 'Hi, I am the PLEC Concierge. I can find venues and event services and book them for you. What city is your event in, what date, and roughly how many guests?',
    });
  } else {
    // TODO(tools): the echo never touches the sandbox. Your agent should ground
    // every fact (capacity, price, availability, booking status) in a tool
    // result from plec.js, never in what the model remembers.
    parts.push({ kind: 'text', text: `You said: "${text}". I am only an echo so far. Open agent/agent.js to teach me the rest.` });
  }

  // TODO(errors): a PlecError from callTool() carries { error, message }.
  // Relay the message honestly ("The Rooftop is not available on October 17")
  // instead of hiding it or inventing an alternative.

  session.messages.push({ role: 'assistant', content: parts.map((p) => p.text ?? '').join('\n') });
  return parts;
}
