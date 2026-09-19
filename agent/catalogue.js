/**
 * Booking rules the search endpoint does not apply. GET /listings only drops
 * blacked-out dates; closed weekdays and lead times surface later, as a quote
 * error. Recommending a venue that cannot be booked on the user's date is a
 * bad answer, so search results are screened against the offline catalogue
 * copy first. The sandbox stays the source of truth: a listing missing from
 * the copy is kept, and a quote still validates everything before a booking.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_MS = 24 * 60 * 60 * 1000;

let rules;
function loadRules() {
  if (rules) return rules;
  rules = new Map();
  try {
    const file = join(dirname(dirname(fileURLToPath(import.meta.url))), 'data', 'listings.json');
    for (const l of JSON.parse(readFileSync(file, 'utf8'))) {
      rules.set(l.id, { id: l.id, name: l.name, city: l.city, kind: l.kind, keys: nameKeys(l.name), closedDays: l.closedDays ?? [], leadTimeDays: l.leadTimeDays ?? 0 });
    }
  } catch (err) {
    console.warn(`[catalogue] offline copy unavailable, search results are not screened: ${err.message}`);
  }
  return rules;
}

const squash = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The spellings a user might type: the full name, without a parenthetical, without a leading "the". */
function nameKeys(name) {
  const full = squash(name);
  const bare = squash(String(name).replace(/\([^)]*\)/g, ' '));
  const keys = new Set([full, bare, full.replace(/^the /, ''), bare.replace(/^the /, '')]);
  return [...keys].filter((key) => key.length >= 8);
}

/**
 * Listings the user named in their message, resolved to ids. Names only: every
 * fact about them still has to come from a sandbox call. This spares a search
 * round trip and, more importantly, finds a venue that a date-filtered search
 * would hide because it is blacked out that day.
 * @returns {Array<{ id: string, name: string, city: string, kind: string }>}
 */
export function findMentionedListings(text) {
  const haystack = ` ${squash(text)} `;
  const hits = [];
  for (const rule of loadRules().values()) {
    const key = rule.keys.filter((k) => haystack.includes(` ${k} `)).sort((a, b) => b.length - a.length)[0];
    if (key) hits.push({ rule, length: key.length });
  }
  // "Rittenhouse Hotel Penthouse" must not also match a shorter listing name contained in it.
  return hits
    .filter((hit) => !hits.some((other) => other !== hit && other.length > hit.length && other.rule.keys.some((k) => hit.rule.keys.some((mine) => k.includes(mine) && k !== mine))))
    .map(({ rule }) => ({ id: rule.id, name: rule.name, city: rule.city, kind: rule.kind }));
}

/** Why a listing cannot be booked on `date`, or null when nothing in the offline copy rules it out. */
export function unbookableReason(listingId, date, now = new Date()) {
  const rule = loadRules().get(listingId);
  const day = new Date(`${date}T00:00:00Z`);
  if (!rule || Number.isNaN(day.getTime())) return null;
  if (rule.closedDays.includes(DAYS[day.getUTCDay()])) return 'closed_day';
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (rule.leadTimeDays && (day.getTime() - today) / DAY_MS < rule.leadTimeDays) return 'lead_time';
  return null;
}

/** Drop search hits that cannot be booked on `date`. If that would leave nothing, keep them all and let the quote explain. */
export function screenSearch(result, date, now = new Date()) {
  if (!date || !Array.isArray(result?.results)) return result;
  const bookable = result.results.filter((l) => !unbookableReason(l.id, date, now));
  if (bookable.length === 0 || bookable.length === result.results.length) return result;
  return { ...result, results: bookable, notBookableOnThatDate: result.results.length - bookable.length };
}
