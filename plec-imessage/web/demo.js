/* Mock venues + the scripted demo timeline. app.js plays DEMO.timeline in order.
   Each event is { delay (ms before it fires), type, ...data }. */
(function () {
  const venues = {
    loft:       { id: 'loft', name: 'The Loft at Fishtown', short: 'The Loft', hood: 'Fishtown', capacity: 50, price: 1650, stepFree: true, note: 'step-free · DJ booth', colors: ['#C9CDEE', '#F2D6D2'] },
    carriage:   { id: 'carriage', name: 'Cedar Carriage Hall', short: 'Carriage Hall', hood: 'West Philly', capacity: 100, price: 1250, stepFree: true, note: 'step-free · dance floor', colors: ['#D6E4C4', '#F6DCCB'] },
    glasshouse: { id: 'glasshouse', name: 'The Glasshouse', short: 'Glasshouse', hood: 'Northern Liberties', capacity: 80, price: 1950, stepFree: true, note: 'step-free · fits 80', colors: ['#C9D3F2', '#E9D2F0'] },
    rooftop:    { id: 'rooftop', name: 'Halcyon Rooftop', short: 'Halcyon', hood: 'Rittenhouse', capacity: 60, price: 2400, stepFree: true, note: '10pm curfew', colors: ['#F4C9DE', '#F9DCC4'] },
    ironworks:  { id: 'ironworks', name: 'Ironworks Walk-up', short: 'Ironworks', hood: 'Old City', capacity: 55, price: 1350, stepFree: false, note: '3rd-floor walk-up', colors: ['#DCCBF3', '#DDE6C8'] },
  };

  const T = [];
  const ev = (delay, e) => T.push({ delay, ...e });
  const say = (who, text, gap = 1300) => {
    ev(gap, { type: 'typing', who, on: true });
    ev(Math.min(500 + text.length * 16, 1500), { type: 'message', from: who, text });
  };
  const plan = (data, delay = 500) => ev(delay, { type: 'plan', ...data });
  const act = (kind, text, sub, delay = 350) => ev(delay, { type: 'activity', kind, text, sub });
  const insight = (text, delay = 500) => ev(delay, { type: 'insight', text });
  const plec = (bubbles, { think = 1500 } = {}) => {
    ev(700, { type: 'agent', state: 'thinking' });
    ev(think, { type: 'agent', state: 'speaking' });
    bubbles.forEach((b, i) => {
      ev(i === 0 ? 100 : 250, { type: 'typing', who: 'PLEC', on: true });
      const text = typeof b === 'string' ? b : '';
      ev(typeof b === 'string' ? Math.min(700 + text.length * 9, 1900) : 800,
        typeof b === 'string' ? { type: 'message', from: 'PLEC', text } : { type: 'message', from: 'PLEC', card: b.card, n: b.n });
    });
    ev(600, { type: 'agent', state: 'listening' });
  };

  // 1. Intro
  say('Tony', "ok team. sofia's 30th. SURPRISE party. I'm organizing, added plec to help us book a place", 600);
  plec(["hey all, I'm PLEC 👋 I'll stay quiet and keep track of the plan while you talk",
        "say plec anytime you need me. and don't worry, I'll never text Sofia 🤫"], { think: 1100 });
  act('spoke', 'Said hi to the group', 'intro, then went quiet');

  // 2. Messy chatter. PLEC stays silent, the brain fills in.
  say('Dani', 'OMG yes finally');
  say('Marcus', "she's gonna cry lol");
  act('quiet', 'Stayed quiet', 'just hype, nothing to plan');
  say('Priya', 'wait does she suspect anything');
  say('Tony', "nope. she thinks we're doing brunch lmao");
  act('learned', "Learned: it's a surprise", 'Sofia thinks it is brunch');
  act('quiet', 'Stayed quiet', 'no question for me');

  say('Dani', 'ok when r we thinking. her bday is the 20th right');
  say('Tony', 'yeah the 20th. weekend before or after? 17th/18th or 24th/25th');
  plan({ dates: [
    { d: '17', label: 'Sat 17', no: [] }, { d: '18', label: 'Sun 18', no: [] },
    { d: '24', label: 'Sat 24', no: [] }, { d: '25', label: 'Sun 25', no: [] }] });
  act('learned', 'Learned: 4 candidate dates', 'Oct 17, 18, 24 or 25');
  say('Dani', 'ugh i cant do oct 17, my sisters wedding rehersal 😭');
  plan({ no: { d: '17', who: 'Dani' }, constraint: 'Dani · not the 17th' });
  act('learned', "Learned: Dani can't do the 17th", 'sister’s wedding rehearsal');
  say('Marcus', '18th im out of town till sunday night');
  plan({ no: { d: '18', who: 'Marcus' }, constraint: 'Marcus · away the 18th' });
  act('learned', 'Learned: Marcus is away the 18th', 'back Sunday night');
  say('Tony', '24th is my cousins wedding so not that one for me');
  plan({ no: { d: '24', who: 'Tony' }, constraint: 'Tony · not the 24th', allFor: '25', date: 'Sun Oct 25' });
  insight('Sun Oct 25 works for all 4 of you');
  act('learned', 'Learned: Oct 25 works for everyone', 'the only date left');
  act('quiet', 'Stayed quiet', 'they’re still talking, no need to jump in');

  say('Priya', 'ok more important question what are we wearing');
  say('Dani', '90s theme!!!');
  say('Marcus', 'absolutely not');
  say('Priya', 'all black? classy');
  say('Dani', 'boring but fine 🙄');
  act('quiet', 'Stayed quiet', 'outfit debate, not my business');

  say('Tony', 'prob like 40-45 ppl btw, she knows everyone');
  plan({ guests: 45 });
  act('learned', 'Learned: about 45 guests', 'Tony, “40-45 ppl”');
  say('Marcus', 'can we keep it under like $40 a head, im broke after vegas');
  plan({ budget: '≤ $40/pp', constraint: 'Marcus · under $40/head' });
  insight("Marcus's $40/head budget rules out Halcyon Rooftop");
  act('learned', 'Learned: budget ≤ $40/head', 'about $1,800 for 45 people');
  say('Priya', 'also my grandma is coming and she cant do stairs so nothing up a bunch of steps pls');
  plan({ constraint: 'Priya’s grandma · no stairs' });
  insight("Priya's grandma needs step-free access. Ironworks is out");
  act('learned', 'Learned: must be step-free', 'rules out Ironworks (walk-up)');
  say('Dani', 'and somewhere we can actually dance at!! not a sit down dinner');
  plan({ constraint: 'Dani · wants to dance' });
  act('learned', 'Learned: needs a dance floor', 'not a sit-down dinner');

  say('Marcus', 'saturday is better, ppl can go out after');
  say('Priya', 'sunday is better for my fam, saturdays are chaos for them');
  say('Marcus', 'saturday!!', 900);
  say('Priya', 'sunday!!', 700);
  say('Dani', 'you two are exhausting 😂');
  act('quiet', 'Stayed quiet', 'Sat vs Sun, but only Sun 25 works');

  // 3. Asked for help
  say('Marcus', 'ok this is going nowhere. plec help??', 1500);
  plec(["ok here's where you all are 👇 Dani can't do the 17th, Marcus is away the 18th and Tony has a wedding the 24th. so Sun Oct 25 works for all 4 of you",
        "Tony said ~45 people, Marcus wants under $40 a head, Priya's grandma needs no stairs and Dani wants to dance. 3 spots that fit:",
        { card: 'loft', n: 1 }, { card: 'carriage', n: 2 }, { card: 'glasshouse', n: 3 },
        'reply 1, 2 or 3 to vote 🗳️'], { think: 2200 });
  plan({ shortlist: ['loft', 'carriage', 'glasshouse'] });
  act('spoke', 'Summarized for the group', 'by name, plus 3 options');

  // 4. Votes
  say('Dani', '1', 1500);
  ev(300, { type: 'votes', venue: 'loft', who: 'Dani' });
  act('vote', 'Dani voted for #1', '1 of 4 in');
  say('Priya', '1!!');
  ev(300, { type: 'votes', venue: 'loft', who: 'Priya' });
  act('vote', 'Priya voted for #1', '2 of 4 in');
  say('Marcus', '2 tbh, its cheaper');
  ev(300, { type: 'votes', venue: 'carriage', who: 'Marcus' });
  act('vote', 'Marcus voted for #2', '3 of 4 in');
  say('Tony', '1');
  ev(300, { type: 'votes', venue: 'loft', who: 'Tony' });
  act('vote', 'Tony voted for #1', 'all 4 voted');
  plan({ venue: 'The Loft', lead: 'loft' });
  plec(['The Loft wins, 3 of 4 🎉',
        'Tony, want me to book it? Sun Oct 25, 7 to 11pm, 45 guests. $1,650 total, $495 deposit. just say "yes book it"'], { think: 1300 });
  ev(200, { type: 'booking', state: 'pending', venue: 'loft', guests: 45, lines: [['Venue · 4 hrs', 1500], ['Cleaning', 150], ['Deposit (30%)', 495], ['Per person', '$36.67']], total: 1650 });
  act('spoke', 'Asked Tony to confirm', 'booking waits for a yes');

  // 5. Booked
  say('Tony', 'yes book it', 2200);
  ev(600, { type: 'agent', state: 'thinking' });
  ev(1500, { type: 'booking', state: 'booked', venue: 'loft', code: 'PLEC-7Q4K', date: 'Sun Oct 25', time: '7–11pm', guests: 45, total: 1650, deposit: 495 });
  act('booked', 'Booked The Loft at Fishtown', '$1,650 · PLEC-7Q4K', 100);
  plec(['done ✓ The Loft at Fishtown is booked for Sun Oct 25, 7 to 11pm. confirmation PLEC-7Q4K'], { think: 300 });
  ev(0, { type: 'agent', state: 'booked' });
  say('Dani', 'AHHH its happening 🎉', 1800);
  say('Marcus', "i'll handle the playlist obviously");
  act('quiet', 'Stayed quiet', 'celebrating, nothing to do');

  // 6. Over capacity
  say('Priya', 'update: my cousins are coming, +8', 2200);
  plan({ guests: 53 });
  act('issue', 'Headcount over capacity', '53 guests, The Loft fits 50', 300);
  ev(400, { type: 'booking', state: 'issue', headline: '53 guests, but The Loft fits 50', alt: 'glasshouse', altNote: 'Same night · step-free · fits 80', delta: '+$300' });
  plec(["heads up Priya, that's 53 people and The Loft fits 50 😬",
        'The Glasshouse in Northern Liberties is free the same night, step-free and fits 80. $300 more, but still ~$37 a head. Tony, say "switch it" and I\'ll move the booking'], { think: 1800 });
  act('spoke', 'Flagged the capacity problem', 'offered The Glasshouse');
  say('Tony', 'switch it', 2200);
  ev(600, { type: 'agent', state: 'thinking' });
  ev(1400, { type: 'booking', state: 'booked', venue: 'glasshouse', code: 'PLEC-7Q4K', date: 'Sun Oct 25', time: '7–11pm', guests: 53, total: 1950, deposit: 585, updated: 'The Loft → The Glasshouse · 45 → 53 guests' });
  plan({ venue: 'The Glasshouse' });
  act('booked', 'Moved to The Glasshouse', '$1,950 · same night', 100);
  plec(['done ✓ moved to The Glasshouse. same night, same time, 53 guests. new total $1,950'], { think: 300 });
  ev(0, { type: 'agent', state: 'booked' });
  say('Priya', 'plec ur the best 😭', 1800);
  act('quiet', 'Stayed quiet', 'a thank-you, no reply needed');

  window.DEMO = { venues, timeline: T, people: ['Tony', 'Dani', 'Marcus', 'Priya'] };
})();
