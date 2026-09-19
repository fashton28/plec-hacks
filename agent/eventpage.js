/**
 * Event pages and calendar links: the shareable side of a booking.
 *
 *   /e/<id>        a designed invitation page: venue photo, when and where, the
 *                  lineup, calendar buttons and the playlist. Public, so it
 *                  carries no email, no price and no payment link.
 *   /e/<id>.ics    the same event as a calendar file (Apple Calendar, Outlook).
 *   /c/<id>        a short link that opens Google Calendar with the event
 *                  filled in AND the group's emails as invitees. It is only
 *                  ever sent to the person booking, never put on a public page.
 *
 * Nothing here talks to Google or Spotify. A calendar link is opened by the
 * guest, who sends the invites from their own account: the guest acts, the
 * agent never acts for them. Records live in memory, like sessions do.
 */

import { randomBytes } from 'node:crypto';

const TIME_ZONE = 'America/New_York'; // Philadelphia, New York and Washington all keep Eastern time
const MAX_RECORDS = 2_000;
const pages = new Map();
const calendars = new Map();

const newId = () => randomBytes(6).toString('base64url');
function keep(map, id, value) {
  if (map.size >= MAX_RECORDS) map.delete(map.keys().next().value);
  map.set(id, value);
  return value;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stamp = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;

export function dateWords(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(date) : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
export function timeWords(time) {
  const [h, m] = String(time).split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
}

/** @typedef {{ title: string, date: string, startTime: string, endTime: string, location?: string, details?: string }} CalendarEvent */

/** Google Calendar's "create event" page, filled in. `emails` become invitees; the guest still presses Save. */
export function googleCalendarUrl(event, emails = []) {
  const q = new URLSearchParams({ action: 'TEMPLATE', text: event.title, dates: `${stamp(event.date, event.startTime)}/${stamp(event.date, event.endTime)}`, ctz: TIME_ZONE });
  if (event.details) q.set('details', event.details);
  if (event.location) q.set('location', event.location);
  if (emails.length) q.set('add', [...new Set(emails)].join(','));
  return `https://calendar.google.com/calendar/render?${q}`;
}

const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
export function icsFile(event, uid) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PLEC Concierge//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${uid}@plec-concierge`, `DTSTAMP:${now}`,
    `DTSTART;TZID=${TIME_ZONE}:${stamp(event.date, event.startTime)}`, `DTEND;TZID=${TIME_ZONE}:${stamp(event.date, event.endTime)}`,
    `SUMMARY:${icsText(event.title)}`, event.location ? `LOCATION:${icsText(event.location)}` : null, event.details ? `DESCRIPTION:${icsText(event.details)}` : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

/** A short link for one person: Google Calendar with the group's emails already on the invite. */
export function createCalendarLink(event, emails) {
  const id = newId();
  keep(calendars, id, { event, emails: [...new Set(emails)] });
  return id;
}
export const getCalendarLink = (id) => calendars.get(id) ?? null;

/** Open a track in Spotify. A search link needs no account and no API key, and never claims a track exists. */
export const spotifySearchUrl = (title, artist) => `https://open.spotify.com/search/${encodeURIComponent(`${title} ${artist}`.trim())}`;

export function savePage(id, patch) {
  const pageId = id && pages.has(id) ? id : newId();
  return keep(pages, pageId, { ...pages.get(pageId), ...patch, id: pageId });
}
export const getPage = (id) => pages.get(id) ?? null;

const ANSWERS = new Set(['yes', 'maybe', 'no']);
const MAX_RSVPS = 300;
const rsvpHits = new Map();

/**
 * One guest's answer on an invitation page. A name answers once: answering again changes the answer.
 * The page is public, so this is bounded three ways: answers per page, answers per caller per hour, and name length.
 * @returns {{ ok: true, rsvps: object } | { ok: false, status: number, message: string }}
 */
export function addRsvp(id, { name, going }, caller = 'unknown', now = Date.now()) {
  const page = pages.get(id);
  if (!page) return { ok: false, status: 404, message: 'That invitation has expired.' };
  const who = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (who.length < 2) return { ok: false, status: 400, message: 'Add your name so the host knows who is coming.' };
  if (!ANSWERS.has(going)) return { ok: false, status: 400, message: 'Pick yes, maybe or no.' };
  const recent = (rsvpHits.get(caller) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 20) return { ok: false, status: 429, message: 'That is a lot of answers from one place. Try again later.' };
  rsvpHits.set(caller, [...recent, now]);
  if (rsvpHits.size > 5_000) rsvpHits.clear();
  const others = (page.rsvps ?? []).filter((r) => r.name.toLowerCase() !== who.toLowerCase());
  if (others.length >= MAX_RSVPS) return { ok: false, status: 409, message: 'This guest list is full.' };
  page.rsvps = [...others, { name: who, going, at: now }];
  return { ok: true, rsvps: rsvpSummary(page) };
}

export function rsvpSummary(page) {
  const by = (answer) => (page?.rsvps ?? []).filter((r) => r.going === answer).map((r) => r.name);
  return { yes: by('yes'), maybe: by('maybe'), no: by('no') };
}

/** The calendar event a page stands for, or null while the page has no time yet. */
export function pageEvent(page) {
  if (!page?.date || !page.startTime || !page.endTime) return null;
  const lineup = (page.lineup ?? []).map((l) => `${l.category}: ${l.name}`).join('\n');
  return { title: page.title, date: page.date, startTime: page.startTime, endTime: page.endTime, location: [page.venue?.name, page.venue?.address].filter(Boolean).join(', '), details: [page.message, lineup].filter(Boolean).join('\n\n') };
}

const ACCENTS = ['#7B3FE4', '#3B82F6', '#4FA54D', '#F5B82E', '#F08A2C', '#E15543'];

/** The invitation page. Every value is escaped; nothing here is trusted. */
export function renderPage(page, origin) {
  const url = `${origin}/e/${page.id}`;
  const event = pageEvent(page);
  const when = page.date ? dateWords(page.date) : 'Date to be announced';
  const hours = page.startTime && page.endTime ? `${timeWords(page.startTime)} to ${timeWords(page.endTime)}` : '';
  const venue = page.venue ?? {};
  const where = [venue.neighborhood, venue.city].filter(Boolean).join(', ');
  const blurb = page.message || `You are invited. ${when}${hours ? `, ${hours}` : ''}${venue.name ? ` at ${venue.name}` : ''}.`;
  const confetti = Array.from({ length: 18 }, (_, i) => `<i style="--x:${(i * 53) % 100}%;--d:${(i % 7) * 0.35}s;--c:${ACCENTS[i % ACCENTS.length]};--r:${(i * 47) % 360}deg"></i>`).join('');
  const lineup = (page.lineup ?? []).map((l) => `<li><small>${esc(l.category)}</small><b>${esc(l.name)}</b></li>`).join('');
  const rsvps = rsvpSummary(page);
  const tracks = (page.playlist?.tracks ?? []).map((t, i) => `<li><a href="${esc(t.url || spotifySearchUrl(t.title, t.artist))}" target="_blank" rel="noreferrer"><span class="n">${i + 1}</span><span class="tt"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span><span class="go">Play</span></a></li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(blurb)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(page.title)}" />
<meta property="og:description" content="${esc(blurb)}" />
<meta property="og:url" content="${esc(url)}" />
${venue.photoUrl ? `<meta property="og:image" content="${esc(venue.photoUrl)}" />\n<meta name="twitter:card" content="summary_large_image" />` : ''}
<link rel="icon" href="/emblem.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600&family=Livvic:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root { --brand: #E15543; --navy: #1F3A5F; --ink: #1a1a1a; --muted: #6b6b6b; --page: #f6f4f1; --ring: rgba(0,0,0,.07);
    --font-body: "Livvic", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --font-title: "Bricolage Grotesque", "Livvic", ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font-family: var(--font-body); color: var(--ink); background: var(--page); -webkit-font-smoothing: antialiased; min-height: 100svh; display: flex; justify-content: center; padding: clamp(0px, 3vw, 36px);
    background-image: radial-gradient(60rem 30rem at 10% -10%, hsl(5 90% 63% / .18), transparent 60%), radial-gradient(50rem 30rem at 100% 110%, hsl(213 51% 25% / .12), transparent 60%); }
  h1, h2 { font-family: var(--font-title); font-weight: 400; margin: 0; }
  .invite { width: min(560px, 100%); background: #fff; border-radius: clamp(0px, 3vw, 32px); overflow: hidden; box-shadow: 0 0 0 1px var(--ring), 0 40px 80px -40px rgba(31,58,95,.45); align-self: flex-start; }
  .cover { position: relative; min-height: 340px; display: flex; align-items: flex-end; padding: 28px; color: #fff; overflow: hidden;
    background: linear-gradient(180deg, rgba(20,16,20,.05) 0%, rgba(20,16,20,.25) 45%, rgba(20,16,20,.82) 100%)${venue.photoUrl ? `, url("${esc(venue.photoUrl)}") center / cover` : ', linear-gradient(135deg, #E15543, #7B3FE4 55%, #1F3A5F)'}; }
  .confetti { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .confetti i { position: absolute; top: -14px; left: var(--x); width: 9px; height: 14px; border-radius: 2px; background: var(--c); opacity: .9; transform: rotate(var(--r)); animation: fall 5.5s var(--d) linear infinite; }
  @keyframes fall { to { transform: translateY(380px) rotate(calc(var(--r) + 300deg)); opacity: 0; } }
  .kicker { display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; padding: 6px 12px; border-radius: 999px; background: rgba(255,255,255,.18); backdrop-filter: blur(8px); margin-bottom: 12px; }
  .cover h1 { font-size: clamp(34px, 8vw, 52px); line-height: 1.02; letter-spacing: -0.02em; text-wrap: balance; text-shadow: 0 2px 18px rgba(0,0,0,.35); }
  .host { margin: 10px 0 0; font-size: 15px; opacity: .92; }
  .body { padding: 26px 28px 30px; }
  .message { margin: 0 0 22px; font-size: 17px; line-height: 1.5; color: var(--navy); }
  .facts { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 22px; }
  .fact { padding: 14px 16px; border-radius: 18px; background: var(--page); }
  .fact small { display: block; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
  .fact b { display: block; font-family: var(--font-title); font-weight: 500; font-size: 18px; line-height: 1.2; }
  .fact span { display: block; margin-top: 3px; font-size: 13px; color: var(--muted); line-height: 1.35; }
  .fact a { color: var(--brand); font-weight: 600; font-size: 13px; text-underline-offset: 3px; }
  .actions { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; margin-bottom: 26px; }
  .btn { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px 16px; border-radius: 16px; font-weight: 600; font-size: 15px; text-decoration: none; transition: transform .15s; }
  .btn:hover { transform: translateY(-2px); }
  .btn.primary { background: var(--brand); color: #fff; box-shadow: 0 14px 28px -14px rgba(225,85,67,.9); }
  .btn.quiet { background: var(--page); color: var(--ink); box-shadow: inset 0 0 0 1px var(--ring); }
  .rsvp { margin: 0 0 26px; padding: 20px; border-radius: 22px; background: linear-gradient(135deg, hsl(5 90% 97%), hsl(213 60% 96%)); }
  .rsvp h2 { margin-bottom: 12px; }
  .rsvp input { width: 100%; font: inherit; font-size: 16px; padding: 12px 14px; border: 0; border-radius: 14px; background: #fff; box-shadow: inset 0 0 0 1px rgba(0,0,0,.1); outline: none; margin-bottom: 10px; }
  .rsvp input:focus { box-shadow: inset 0 0 0 2px var(--brand); }
  .answers { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 8px; }
  .ans { font: inherit; font-weight: 600; font-size: 14.5px; padding: 12px 8px; border: 0; border-radius: 14px; cursor: pointer; background: #fff; color: var(--ink); box-shadow: inset 0 0 0 1px var(--ring); transition: transform .15s; }
  .ans:hover { transform: translateY(-2px); } .ans:disabled { opacity: .6; cursor: default; transform: none; }
  .ans.yes { background: var(--navy); color: #fff; box-shadow: 0 12px 24px -14px rgba(31,58,95,.9); }
  .rsvp-note { min-height: 1.4em; margin: 10px 0 0; font-size: 14px; color: var(--navy); font-weight: 500; }
  .going { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .going span { font-size: 13px; padding: 5px 11px; border-radius: 999px; background: #fff; box-shadow: inset 0 0 0 1px var(--ring); }
  .going span.maybe { color: var(--muted); }
  .going small { width: 100%; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
  .btn.spotify { background: #1db954; color: #fff; margin: 10px 0 14px; box-shadow: 0 14px 28px -16px rgba(29,185,84,.9); }
  .player { display: block; width: 100%; border: 0; border-radius: 14px; }
  h2 { font-size: 22px; margin: 0 0 12px; }
  .lineup { list-style: none; margin: 0 0 26px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .lineup li { padding: 9px 14px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--ring); }
  .lineup small { display: block; font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .lineup b { font-weight: 600; font-size: 14.5px; }
  .vibe { margin: -6px 0 12px; font-size: 14px; color: var(--muted); }
  .tracks { list-style: none; margin: 0; padding: 0; border-radius: 18px; overflow: hidden; box-shadow: inset 0 0 0 1px var(--ring); }
  .tracks a { display: flex; align-items: center; gap: 14px; padding: 11px 16px; color: inherit; text-decoration: none; border-top: 1px solid var(--ring); transition: background .15s; }
  .tracks li:first-child a { border-top: 0; }
  .tracks a:hover { background: var(--page); }
  .n { width: 22px; text-align: right; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .tt { flex: 1; min-width: 0; } .tt b { display: block; font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .tt small { display: block; font-size: 12.5px; color: var(--muted); }
  .go { font-size: 12px; font-weight: 600; color: #1a9c4b; padding: 5px 11px; border-radius: 999px; background: #e7f6ec; }
  footer { margin-top: 26px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { color: var(--brand); font-weight: 600; text-decoration: none; }
  @media (max-width: 420px) { .actions { grid-template-columns: 1fr; } .body { padding: 22px 20px 26px; } .cover { padding: 22px 20px; } }
  @media (prefers-reduced-motion: reduce) { .confetti { display: none; } }
</style>
</head>
<body>
<main class="invite">
  <header class="cover">
    <div class="confetti" aria-hidden="true">${confetti}</div>
    <div>
      <span class="kicker">You are invited</span>
      <h1>${esc(page.title)}</h1>
      ${page.hostName ? `<p class="host">Hosted by ${esc(page.hostName)}</p>` : ''}
    </div>
  </header>
  <div class="body">
    ${page.message ? `<p class="message">${esc(page.message)}</p>` : ''}
    <section class="facts">
      <div class="fact"><small>When</small><b>${esc(when)}</b>${hours ? `<span>${esc(hours)}</span>` : ''}</div>
      ${venue.name ? `<div class="fact"><small>Where</small><b>${esc(venue.name)}</b>${venue.address || where ? `<span>${esc(venue.address || where)}</span>` : ''}${venue.mapUrl ? `<a href="${esc(venue.mapUrl)}" target="_blank" rel="noreferrer">Open the map</a>` : ''}</div>` : ''}
      ${page.guests ? `<div class="fact"><small>Party size</small><b>${esc(page.guests)} guests</b></div>` : ''}
    </section>
    ${event ? `<section class="actions"><a class="btn primary" href="${esc(googleCalendarUrl(event))}" target="_blank" rel="noreferrer">Add to Google Calendar</a><a class="btn quiet" href="/e/${esc(page.id)}.ics">Apple or Outlook</a></section>` : ''}
    <section class="rsvp" id="rsvp">
      <h2>Are you coming?</h2>
      <form id="rsvp-form">
        <input id="rsvp-name" name="name" maxlength="40" autocomplete="given-name" placeholder="Your name" aria-label="Your name" required />
        <div class="answers">
          <button type="submit" value="yes" class="ans yes">I'm in</button>
          <button type="submit" value="maybe" class="ans">Maybe</button>
          <button type="submit" value="no" class="ans">Can't go</button>
        </div>
      </form>
      <p class="rsvp-note" id="rsvp-note" role="status"></p>
      <div class="going" id="going" data-rsvps="${esc(JSON.stringify(rsvps))}"></div>
    </section>
    ${lineup ? `<h2>The lineup</h2><ul class="lineup">${lineup}</ul>` : ''}
    ${tracks ? `<h2 id="playlist">The playlist</h2>${page.playlist.vibe ? `<p class="vibe">${esc(page.playlist.vibe)}</p>` : ''}${page.playlist.spotifyId ? `<iframe class="player" title="The playlist on Spotify" src="https://open.spotify.com/embed/playlist/${esc(page.playlist.spotifyId)}?utm_source=plec" height="352" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe><a class="btn spotify" href="${esc(page.playlist.spotifyUrl)}" target="_blank" rel="noreferrer">Open in Spotify</a>` : ''}<ol class="tracks">${tracks}</ol>` : ''}
    <footer>Planned with <a href="/">PLEC Concierge</a></footer>
  </div>
</main>
<script>
(function () {
  const form = document.getElementById('rsvp-form'), note = document.getElementById('rsvp-note'), going = document.getElementById('going');
  function draw(r) {
    going.replaceChildren();
    const add = (text, cls) => { const el = document.createElement(cls === 'label' ? 'small' : 'span'); if (cls && cls !== 'label') el.className = cls; el.textContent = text; going.appendChild(el); };
    if (r.yes.length || r.maybe.length) add(r.yes.length + ' coming' + (r.maybe.length ? ', ' + r.maybe.length + ' maybe' : ''), 'label');
    r.yes.forEach((n) => add(n)); r.maybe.forEach((n) => add(n + '?', 'maybe'));
  }
  try { draw(JSON.parse(going.dataset.rsvps)); } catch (e) {}
  try { const saved = localStorage.getItem('plec.rsvp.name'); if (saved) document.getElementById('rsvp-name').value = saved; } catch (e) {}
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const answer = event.submitter && event.submitter.value, name = document.getElementById('rsvp-name').value;
    if (!answer) return;
    const buttons = form.querySelectorAll('button'); buttons.forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch(location.pathname.replace(/[/]$/, '') + '/rsvp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, going: answer }) });
      const body = await res.json();
      if (!res.ok) { note.textContent = body.message || 'That did not work. Try again.'; return; }
      try { localStorage.setItem('plec.rsvp.name', name); } catch (e) {}
      note.textContent = answer === 'yes' ? "You're on the list. See you there!" : answer === 'maybe' ? 'Got it, marked as a maybe.' : 'Thanks for letting the host know.';
      draw(body.rsvps);
    } catch (e) { note.textContent = 'Could not reach the server. Try again.'; }
    finally { buttons.forEach((b) => { b.disabled = false; }); }
  });
})();
</script>
</body>
</html>`;
}

/** For tests. */
export const _stores = { pages, calendars };
