/** Date, time and money helpers shared by the tools and the templated messages. */
import { today } from '../config.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const weekday = (date) => DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
export const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`));

export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysUntil(date) {
  return Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today()}T12:00:00Z`)) / 86400000);
}

/** "Sun Oct 25" */
export function prettyDate(date) {
  if (!isDate(date)) return String(date ?? '');
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "HH:MM" -> minutes; "24:00" = 1440. Returns NaN on garbage. */
export function toMin(t) {
  const m = String(t ?? '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** "19:00" -> "7pm", "22:30" -> "10:30pm", "24:00" -> "midnight" */
export function prettyTime(t) {
  const mins = toMin(t);
  if (Number.isNaN(mins)) return String(t ?? '');
  if (mins % 1440 === 0 && mins > 0) return 'midnight';
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${suffix}`;
}

export const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
export const money2 = (n) => `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
