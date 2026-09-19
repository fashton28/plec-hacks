/**
 * Booking-integrity checks after every plan update, in plain code.
 * Each distinct issue fires once (keyed), so the agent doesn't nag.
 */
import { getOrganizer } from './ingest.js';
import { prettyDate } from '../tools/util.js';
import { save } from '../store/state.js';

const ACCESS_NEED = /stairs|wheelchair|walker|mobility|step-?free|accessib|elevator/i;

export function runWatchers(chat) {
  const issues = [];
  const plan = chat.plan;
  const organizer = getOrganizer(chat)?.name;
  for (const b of chat.bookings.filter((x) => x.status !== 'cancelled')) {
    const hc = plan.headcount?.value;
    if (hc && b.venueCapacity && hc > b.venueCapacity) {
      issues.push({ key: `cap:${b.id}:${b.venueId}:${hc}`, kind: 'over_capacity', bookingId: b.id, venueId: b.venueId, venueName: b.venueName, date: b.date, capacity: b.venueCapacity, headcount: hc, bookedFor: b.headcount, summary: `headcount ${hc} > ${b.venueName} capacity ${b.venueCapacity}` });
    }
    const opt = plan.dateOptions?.find((d) => d.date === b.date);
    const out = (opt?.doesNotWorkFor || []).filter((p) => [organizer, plan.guestOfHonor].filter(Boolean).some((n) => n.toLowerCase() === p.toLowerCase()));
    if (out.length) {
      issues.push({ key: `date:${b.id}:${b.date}:${out.join(',')}`, kind: 'date_conflict', bookingId: b.id, venueName: b.venueName, date: b.date, people: out, summary: `${out.join(' & ')} can't make ${prettyDate(b.date)}` });
    }
    const needsAccess = [...(plan.dealbreakers || []), ...(plan.personConstraints || []).map((c) => c.constraint)].some((t) => ACCESS_NEED.test(t));
    if (needsAccess && b.venueAccessible === false) {
      issues.push({ key: `fit:${b.id}:${b.venueId}:access`, kind: 'fit', bookingId: b.id, venueName: b.venueName, need: 'step-free access', summary: `${b.venueName} isn't step-free but the group needs it` });
    }
  }
  chat.flaggedIssues = chat.flaggedIssues || [];
  const fresh = issues.filter((i) => !chat.flaggedIssues.includes(i.key));
  if (fresh.length) {
    chat.flaggedIssues.push(...fresh.map((i) => i.key));
    save();
  }
  return fresh;
}
