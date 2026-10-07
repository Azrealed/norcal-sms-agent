const test = require('node:test');
const assert = require('node:assert');
const { isClearNo } = require('../lib/policy');
const { planInbound } = require('../lib/inbound');

const env = { AI_TEST_MODE: 'true', AI_REPLY_ALLOWLIST: '+15305550100' };
const phone = '+15305550100';

const CLEAR_NO = [
  'No', 'no', 'No.', 'NO!', 'Nope', 'Nah', 'No thanks', 'No thank you', 'not interested', 'Not interested, thanks',
  'No not really, thank you!', 'Not selling', 'Probably not.', 'Not at this time', 'No sir', "I'm good", 'Not for sale',
  "No, I just gutted the house and we're redoing the yard and my kids live there. ",
  "Nope. We're staying put.", 'No sorry', 'No we are not selling',
];

const NOT_CLEAR = [
  'No home . Land only', 'No, but maybe next year', 'Not right now, what would you offer?', 'Yes', 'Asap',
  'Derek yes I would. My name is not Brett', 'No? Who is this?', 'Not now but maybe in a few months', 'No, I want 300k',
  "It's already in the market for sale", 'Who is this?', 'Probably not unless the price is right',
];

test('clear no / not-interested replies are detected', () => {
  for (const m of CLEAR_NO) assert.equal(isClearNo(m), true, m);
});

test('hedged or positive replies are not treated as a clear no', () => {
  for (const m of NOT_CLEAR) assert.equal(isClearNo(m), false, m);
});

test('a clear no gets no text, no CRM push, and no opt-out', () => {
  for (const m of CLEAR_NO) {
    const plan = planInbound({ phone, message: m, env });
    assert.equal(plan.send, false, m);
    assert.equal(plan.ghl, false, m);
    assert.equal(plan.optOut, false, m);
    assert.equal(plan.reason, 'not_interested', m);
  }
});

test('hedged replies still get a normal reply', () => {
  const plan = planInbound({ phone, message: 'No, but maybe next year', env });
  assert.equal(plan.send, true);
});
