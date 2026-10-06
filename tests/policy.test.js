const test = require('node:test');
const assert = require('node:assert/strict');
const { isAutoReplyAllowed, isSuppressed, isTestMode, canSendSms, isOptOutMessage } = require('../lib/policy');
const { planInbound } = require('../lib/inbound');
const { HONEST_REPLY } = require('../lib/persona');

test('test mode is on by default and the allowlist blocks everyone else', () => {
  const env = { AI_REPLY_ALLOWLIST: '+1 (530) 555-0100' };
  assert.equal(isTestMode(env), true);
  assert.equal(isTestMode({}), true);
  assert.equal(isAutoReplyAllowed('5305550100', env), true);
  assert.equal(isAutoReplyAllowed('+15305550999', env), false);

  const blocked = planInbound({ phone: '+15305550999', message: 'Yes I want to sell my house', env, optedOut: false });
  assert.equal(blocked.send, false);
  assert.equal(blocked.ghl, false);
  assert.equal(blocked.reason, 'test_mode');

  const allowed = planInbound({ phone: '+15305550100', message: 'are you a bot?', env, optedOut: false });
  assert.equal(allowed.send, true);
  assert.equal(allowed.fixedReply, HONEST_REPLY);
});

test('turning test mode off allows other numbers, but never the suppressed number', () => {
  const env = { AI_TEST_MODE: 'false', AI_REPLY_ALLOWLIST: '+14083061957' };
  assert.equal(isTestMode(env), false);
  assert.equal(isAutoReplyAllowed('+15305550999', env), true);
  assert.equal(isSuppressed('+14083061957', env), true);
  assert.equal(isSuppressed('(408) 306-1957', env), true);
  assert.equal(isAutoReplyAllowed('+14083061957', env), false);
  assert.equal(canSendSms('+14083061957', { automated: false, env, optedOut: false }).ok, false);
  assert.equal(canSendSms('+15305550999', { automated: true, env, optedOut: false }).ok, true);
  assert.equal(canSendSms('+15305550999', { automated: true, env, optedOut: true }).reason, 'opted_out');
});

test('STOP opts out with no reply and no CRM push', () => {
  const env = { AI_TEST_MODE: 'false' };
  for (const message of ['STOP', 'stop', 'Unsubscribe', 'please stop texting me']) {
    const plan = planInbound({ phone: '+15305550100', message, env, optedOut: false });
    assert.equal(plan.optOut, true, message);
    assert.equal(plan.send, false, message);
    assert.equal(plan.ghl, false, message);
  }
  assert.equal(isOptOutMessage('Yes'), false);
  const yes = planInbound({ phone: '+15305550100', message: 'Yes', env, optedOut: true });
  assert.equal(yes.clearOptOut, false);
  assert.equal(yes.send, false);
  assert.equal(yes.reason, 'already_opted_out');
});
