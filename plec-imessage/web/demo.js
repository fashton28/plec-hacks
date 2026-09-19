/* Venue catalogue + the mock demo. The mock emits the SAME events as the
   backend bus (src/bus.js): { type, chatId, data, at }, so app.js has one
   code path for mock and live. Story mirrors data/demo-script.json. */
(function () {
  // Copied from data/venues.json: [name, neighborhood, standing capacity, base + cleaning, step-free]
  const RAW = {"kiln-loft-fishtown":["The Kiln Loft","Fishtown",50,1650,1],"brightwater-hall-nolibs":["Brightwater Hall","Northern Liberties",90,1950,1],"halcyon-rooftop-rittenhouse":["Halcyon Rooftop","Rittenhouse",60,2600,1],"ironworks-loft-oldcity":["Ironworks Loft","Old City",55,1450,0],"magnolia-garden-queenvillage":["Magnolia Garden","Queen Village",70,1850,1],"wildflower-yard-kensington":["Wildflower Yard","Kensington",60,1130,0],"corner-room-southphilly":["The Corner Room","South Philly",35,650,1],"copperline-brewhall-kensington":["Copperline Brew Hall","Kensington",120,1900,1],"alder-ballroom-centercity":["The Alder Ballroom","Center City",200,9000,1],"riverbend-boathouse":["Riverbend Boathouse","East Falls",110,4500,1],"velvet-room-midtown":["The Velvet Room","Midtown Village",40,1250,0],"gallery-nine-oldcity":["Gallery Nine","Old City",80,2800,1],"osteria-private-room-passyunk":["Nonna Rosa's Private Room","East Passyunk",35,850,1],"pierside-roof-delaware":["Pierside Roof","Delaware River Waterfront",150,5550,1],"carriage-hall-westphilly":["Cedar Carriage Hall","West Philly",100,1350,1]};
  const venues = {};
  for (const [id, [name, hood, capacity, price, stepFree]] of Object.entries(RAW)) venues[id] = { id, name, hood, capacity, price, stepFree: !!stepFree };

  const CHAT = 'demo-sofia-30';
  const PHONE = { Tony: '+15550100001', Dani: '+15550100002', Marcus: '+15550100003', Priya: '+15550100004' };
  const T = [];
  const push = (delay, type, data) => T.push({ delay, type, chatId: CHAT, data });
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const plan = { dateOptions: [], vibe: [], dealbreakers: [], personConstraints: [], openQuestions: [], decisions: [], shortlist: [], votes: {}, status: 'gathering' };
  let n = 0;
  const say = (who, text, gap = 1700) => push(gap, 'inbound', { id: `m${++n}`, from: PHONE[who], fromName: who, text, attachments: [] });
  const update = (changes, changed, delay = 700) => { Object.assign(plan, changes); push(delay, 'plan', { plan: clone(plan), changed }); };
  const quiet = (reason, delay = 300) => push(delay, 'decision', { speak: false, reason, intent: 'none' });
  const speak = (intent, reason, bubbles, think = 1600) => {
    push(600, 'decision', { speak: true, reason, intent });
    bubbles.forEach((text, i) => {
      push(i === 0 ? think : 500, 'typing', {});
      push(Math.min(900 + text.length * 12, 2400), 'agent_message', { text });
    });
  };
  const date = (d, worksFor = [], doesNotWorkFor = []) => ({ date: d, worksFor, doesNotWorkFor });
  const quote = (venueId, headcount, base) => {
    const v = venues[venueId], total = base + 150;
    return { venueId, venueName: v.name, date: '2026-10-25', startTime: '19:00', endTime: '23:00', headcount, services: [],
      lineItems: [{ label: 'venue (4h included)', amount: base }, { label: 'cleaning fee', amount: 150 }],
      total, deposit: Math.round(total * 0.3), depositPercent: 30, perPerson: Math.round(total / headcount * 100) / 100 };
  };

  // 1. Intro (the backend sends the intro directly, with no decision event)
  say('Tony', "ok team. sofia's 30th. SURPRISE party. I'm organizing, added plec to help us book a place", 800);
  update({ eventType: '30th birthday', guestOfHonor: 'Sofia', isSurprise: true }, ['eventType', 'guestOfHonor', 'isSurprise'], 500);
  push(900, 'typing', {});
  push(1600, 'agent_message', { text: "hey all 👋 I'm PLEC. I'll quietly keep track of the plan while you chat and help find + book a venue when you're ready." });
  push(700, 'agent_message', { text: 'just say "plec" anytime. I only see this chat, and I\'ll never text Sofia 🤫' });

  // 2. Messy chatter. PLEC stays silent while the plan fills in.
  say('Dani', 'OMG yes finally', 2000);
  say('Marcus', "she's gonna cry lol", 1200);
  quiet('just reactions / lol');
  say('Priya', 'wait does she suspect anything');
  say('Tony', "nope. she thinks we're doing brunch lmao");
  quiet('nothing to add, they are hyping');

  say('Dani', 'ok when r we thinking. her bday is the 20th right');
  say('Tony', 'yeah the 20th. weekend before or after? 17th/18th or 24th/25th');
  update({ dateOptions: [date('2026-10-17'), date('2026-10-18'), date('2026-10-24'), date('2026-10-25')] }, ['dateOptions']);
  quiet('still collecting dates');
  say('Dani', 'ugh i cant do oct 17, my sisters wedding rehersal 😭');
  update({ dateOptions: [date('2026-10-17', [], ['Dani']), date('2026-10-18'), date('2026-10-24'), date('2026-10-25', ['Dani'])] }, ['dateOptions']);
  say('Marcus', '18th im out of town till sunday night');
  update({ dateOptions: [date('2026-10-17', [], ['Dani']), date('2026-10-18', [], ['Marcus']), date('2026-10-24'), date('2026-10-25', ['Dani', 'Marcus'])] }, ['dateOptions']);
  say('Tony', '24th is my cousins wedding so not that one for me');
  update({ dateOptions: [date('2026-10-17', [], ['Dani']), date('2026-10-18', [], ['Marcus']), date('2026-10-24', [], ['Tony']), date('2026-10-25', ['Dani', 'Marcus', 'Tony', 'Priya'])] }, ['dateOptions']);
  quiet('dates narrowing on their own, no need to jump in');

  say('Priya', 'ok more important question what are we wearing');
  say('Dani', '90s theme!!!', 1300);
  say('Marcus', 'absolutely not', 1100);
  say('Priya', 'all black? classy');
  say('Dani', 'boring but fine 🙄', 1300);
  quiet('outfit debate, not a planning question');

  say('Tony', 'prob like 40-45 ppl btw, she knows everyone');
  update({ headcount: { value: 45, confidence: 'medium', note: 'Tony: 40-45 ppl' } }, ['headcount']);
  say('Marcus', 'can we keep it under like $40 a head, im broke after vegas');
  update({ budget: { perPerson: 40, note: 'Marcus: under $40 a head' }, personConstraints: [{ person: 'Marcus', constraint: 'under $40 a head' }] }, ['budget', 'personConstraints']);
  say('Priya', 'also my grandma is coming and she cant do stairs so nothing up a bunch of steps pls');
  update({ dealbreakers: ['stairs'], personConstraints: [...plan.personConstraints, { person: 'Priya', constraint: "grandma can't do stairs" }] }, ['dealbreakers', 'personConstraints']);
  say('Dani', 'and somewhere we can actually dance at!! not a sit down dinner');
  update({ vibe: ['dancing'], personConstraints: [...plan.personConstraints, { person: 'Dani', constraint: 'wants to dance' }] }, ['vibe', 'personConstraints']);
  quiet('constraints landing, nobody asked me yet');

  say('Marcus', 'saturday is better, ppl can go out after');
  say('Priya', 'sunday is better for my fam, saturdays are chaos for them');
  say('Marcus', 'saturday!!', 1000);
  say('Priya', 'sunday!!', 900);
  say('Dani', 'you two are exhausting 😂', 1300);
  quiet('Sat vs Sun, but only Sun 25 works anyway');

  // 3. Asked for help
  say('Marcus', 'ok this is going nowhere. plec help??', 2000);
  speak('suggest_venues', 'mentioned directly', [
    "ok here's where you all are 👇 Dani can't do the 17th, Marcus is away the 18th, Tony has a wedding the 24th. so Sun Oct 25 works for all 4 of you",
    "Tony said ~45 people, Marcus wants under $40 a head, Priya's grandma can't do stairs and Dani wants to dance. 3 spots that fit:",
    '1. The Kiln Loft, Fishtown. step-free, DJ booth, fits 50. $1,650 ($37/head)\n2. Cedar Carriage Hall, West Philly. dance floor, fits 100. $1,350\n3. Brightwater Hall, Northern Liberties. fits 90. $1,950',
    'reply 1, 2 or 3 to vote 🗳️',
  ], 2400);
  update({ shortlist: ['kiln-loft-fishtown', 'carriage-hall-westphilly', 'brightwater-hall-nolibs'], status: 'options_sent' }, ['shortlist'], 200);

  // 4. Votes
  const vote = (who, id, rest) => {
    const votes = clone(plan.votes);
    votes[id] = [...(votes[id] || []), who];
    update({ votes, status: 'voting' }, ['votes'], 300);
    if (rest) quiet(rest);
  };
  say('Dani', '1', 2200); vote('Dani', 'kiln-loft-fishtown', 'vote recorded (1: 1), waiting for the rest');
  say('Priya', '1!!', 1400); vote('Priya', 'kiln-loft-fishtown', 'vote recorded (1: 2), waiting for the rest');
  say('Marcus', '2 tbh its cheaper', 1600); vote('Marcus', 'carriage-hall-westphilly', 'vote recorded (1: 2, 2: 1), waiting for the rest');
  say('Tony', '1', 1600); vote('Tony', 'kiln-loft-fishtown');
  speak('tally', 'all votes in (1: 3, 2: 1, 3: 0)', [
    'The Kiln Loft wins, 3 of 4 🎉',
    'Tony, want me to book it? Sun Oct 25, 7-11pm, 45 people. $1,650 total ($36.67/head), $495 deposit to hold it. reply "yes book it" to confirm',
  ], 1200);
  push(300, 'pending', { id: 'pa-1', kind: 'create_booking', payload: { quote: quote('kiln-loft-fishtown', 45, 1500) }, summaryText: 'The Kiln Loft, Sun Oct 25, 7pm-11pm, 45 people' });

  // 5. Booked (server code executes on the organizer's yes)
  say('Tony', 'yes book it', 2600);
  push(1400, 'booking', {
    id: 'PB-1001', chatId: CHAT, venueId: 'kiln-loft-fishtown', venueName: 'The Kiln Loft', date: '2026-10-25', startTime: '19:00', endTime: '23:00',
    headcount: 45, services: [], priceBreakdown: { 'venue (4h included)': 1500, 'cleaning fee': 150 }, total: 1650, deposit: 495,
    status: 'confirmed', venueCapacity: 50, history: [{ at: 0, change: 'created' }],
  });
  push(100, 'pending', null);
  update({ status: 'booked', decisions: ['booked The Kiln Loft for Sun Oct 25'] }, ['decisions', 'status'], 200);
  push(300, 'typing', {});
  push(1300, 'agent_message', { text: 'done ✅ The Kiln Loft, Sun Oct 25 7pm-11pm for 45. ref PB-1001' });
  push(600, 'agent_message', { text: '$495 deposit due to hold it, $1,650 total' });
  say('Dani', 'AHHH its happening 🎉', 2200);
  say('Marcus', "i'll handle the playlist obviously", 1500);
  quiet('celebrating, nothing to do');

  // 6. Over capacity
  say('Priya', 'update: my cousins are coming, +8', 2600);
  update({ headcount: { value: 53, confidence: 'high', note: 'Priya: +8 cousins' } }, ['headcount']);
  speak('booking_issue', 'booking issue: headcount 53 > The Kiln Loft capacity 50', [
    "heads up Priya, that's 53 people and The Kiln Loft fits 50 😬",
    'Brightwater Hall in Northern Liberties is open the same night, step-free, fits 90. +$300, still ~$37/head. Tony, say "switch it" and I\'ll move the booking',
  ], 1800);
  push(300, 'pending', { id: 'pa-2', kind: 'modify_booking', payload: { bookingId: 'PB-1001', quote: quote('brightwater-hall-nolibs', 53, 1800) }, summaryText: 'change PB-1001: The Kiln Loft -> Brightwater Hall, 45 -> 53 people' });
  say('Tony', 'switch it', 2600);
  push(1400, 'booking', {
    id: 'PB-1001', chatId: CHAT, venueId: 'brightwater-hall-nolibs', venueName: 'Brightwater Hall', date: '2026-10-25', startTime: '19:00', endTime: '23:00',
    headcount: 53, services: [], priceBreakdown: { 'venue (4h included)': 1800, 'cleaning fee': 150 }, total: 1950, deposit: 585,
    status: 'confirmed', venueCapacity: 90,
    history: [{ at: 0, change: 'created' }, { at: 1, change: 'The Kiln Loft Sun Oct 25 45ppl $1,650 -> Brightwater Hall Sun Oct 25 53ppl $1,950' }],
  });
  push(100, 'pending', null);
  push(300, 'typing', {});
  push(1300, 'agent_message', { text: 'switched ✅ Brightwater Hall, Sun Oct 25 7pm-11pm for 53. same ref PB-1001' });
  say('Priya', 'plec ur the best 😭', 2200);
  quiet('a thank-you, no reply needed');

  window.DEMO = { venues, timeline: T };
})();
