/**
 * In-process event bus. Everything visible (simulator bubbles, dashboard,
 * decision log) is fed from here, and SSE endpoints just relay it.
 * Event shape: { type, chatId, data, at }
 *   type: inbound | agent_message | typing | plan | decision | pending | booking | state_reset | error
 */
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(type, chatId, data = {}) {
  bus.emit('event', { type, chatId, data, at: Date.now() });
}
