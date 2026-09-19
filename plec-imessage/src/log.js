/** One readable line per pipeline step. Phones and secrets are masked to the last 4. */
export function maskPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length > 4 ? `…${digits.slice(-4)}` : String(phone);
}

export function maskSecret(value) {
  if (!value) return '(empty)';
  return `…${String(value).slice(-4)}`;
}

let quiet = false;
export function setQuiet(v) { quiet = v; }

export function log(emoji, chatId, message) {
  if (quiet) return;
  const time = new Date().toISOString().slice(11, 19);
  const chat = chatId ? ` [${String(chatId).slice(-10)}]` : '';
  console.log(`${time} ${emoji}${chat} ${message}`);
}
