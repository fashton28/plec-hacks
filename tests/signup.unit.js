/** Offline tests for the iMessage sign-up (agent/signup.js). The Photon API is a stub. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, rateLimited, signup, smsLink, validateSignup } from '../agent/signup.js';

const ENV = { SPECTRUM_PROJECT_ID: 'proj', SPECTRUM_PROJECT_SECRET: 'secret' };
const GOOD = { name: 'Sam Rivera', email: 'Sam@Example.com', phone: '(215) 555-0123' };

function fakePhoton(users = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET') return new Response(JSON.stringify({ succeed: true, data: { users, total: users.length } }));
    const user = { id: 'u1', ...JSON.parse(init.body), assignedPhoneNumber: '+16175550199' };
    users.push(user);
    return new Response(JSON.stringify({ succeed: true, data: user }));
  };
  return { fetchImpl, calls };
}
let ipCounter = 0;
const ctx = (extra) => ({ ip: `10.0.0.${(ipCounter += 1)}`, env: ENV, ...extra });

test('phone numbers normalise to E.164 or are refused', () => {
  assert.equal(normalizePhone('(215) 555-0123'), '+12155550123');
  assert.equal(normalizePhone('1 215 555 0123'), '+12155550123');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  for (const bad of ['555-0123', '', 'not a number', '+1', '020 7946 0958 1234 5678']) assert.equal(normalizePhone(bad), null, bad);
});

test('validation splits the name, lower-cases the email and explains what is wrong', () => {
  assert.deepEqual(validateSignup(GOOD).value, { firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com', phoneNumber: '+12155550123' });
  assert.equal(validateSignup({ ...GOOD, name: 'Cher' }).value.lastName, '-');
  assert.match(validateSignup({ ...GOOD, name: '' }).message, /name/);
  assert.match(validateSignup({ ...GOOD, email: 'nope' }).message, /email/);
  assert.match(validateSignup({ ...GOOD, phone: '123' }).message, /phone/);
});

test('the sms link opens Messages with the first text filled in', () => {
  assert.equal(smsLink('+16175550199'), 'sms:+16175550199?&body=yo%20plec');
});

test('a new visitor is registered with the shape Photon accepts and gets their assigned number', async () => {
  const photon = fakePhoton();
  const res = await signup(GOOD, ctx({ fetchImpl: photon.fetchImpl }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { number: '+16175550199', smsUrl: 'sms:+16175550199?&body=yo%20plec', already: false, firstText: 'yo plec' });
  const post = photon.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com', phoneNumber: '+12155550123', type: 'shared' });
  assert.equal(post.auth, `Basic ${Buffer.from('proj:secret').toString('base64')}`);
  assert.equal(post.url, 'https://spectrum.photon.codes/projects/proj/users/');
});

test('someone who signed up before gets the same number back and is not created twice', async () => {
  const photon = fakePhoton([{ id: 'u0', email: 'sam@example.com', phoneNumber: '+12155550123', assignedPhoneNumber: '+16175550111' }]);
  const res = await signup(GOOD, ctx({ fetchImpl: photon.fetchImpl }));
  assert.equal(res.body.number, '+16175550111');
  assert.equal(res.body.already, true);
  assert.equal(photon.calls.filter((c) => c.method === 'POST').length, 0);
});

test('guards: off without credentials, access code, user cap, bad input, rate limit', async () => {
  const photon = fakePhoton();
  assert.equal((await signup(GOOD, ctx({ env: {}, fetchImpl: photon.fetchImpl }))).status, 503);
  const coded = { ...ENV, IMESSAGE_SIGNUP_CODE: 'plec2026' };
  assert.equal((await signup(GOOD, ctx({ env: coded, fetchImpl: photon.fetchImpl }))).status, 403);
  assert.equal((await signup({ ...GOOD, code: 'plec2026' }, ctx({ env: coded, fetchImpl: photon.fetchImpl }))).status, 200);
  const full = fakePhoton(Array.from({ length: 3 }, (_, i) => ({ id: `u${i}`, email: `x${i}@example.com`, phoneNumber: `+1215555010${i}`, assignedPhoneNumber: '+16175550100' })));
  assert.equal((await signup(GOOD, ctx({ env: { ...ENV, IMESSAGE_SIGNUP_MAX_USERS: '3' }, fetchImpl: full.fetchImpl }))).status, 409);
  assert.equal(full.calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal((await signup({ ...GOOD, phone: '12' }, ctx({ fetchImpl: photon.fetchImpl }))).status, 400);
  assert.equal(photon.calls.filter((c) => c.method === 'POST').length, 1, 'only the one valid sign-up reached Photon');
  for (let i = 0; i < 5; i += 1) assert.equal(rateLimited('1.2.3.4', 1_000 + i), false);
  assert.equal(rateLimited('1.2.3.4', 2_000), true);
  assert.equal(rateLimited('1.2.3.4', 2_000 + 60 * 60 * 1000 + 1), false, 'the window slides');
});

test('a Photon outage is an honest 502, never a crash and never a leaked secret', async () => {
  const res = await signup(GOOD, ctx({ fetchImpl: async () => { throw new Error('boom secret'); } }));
  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(res.body).includes('secret'));
});
