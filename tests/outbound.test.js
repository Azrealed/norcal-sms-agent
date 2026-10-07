const test = require('node:test');
const assert = require('node:assert/strict');
const { canSendSms } = require('../lib/policy');
const { DEFAULT_DAILY_BLAST } = require('../lib/persona');
const { planInbound } = require('../lib/inbound');

test('campaign sends honor test mode, opt-outs, and the suppressed number', () => {
  const env = { AI_REPLY_ALLOWLIST: '+15305550100' };
  assert.equal(canSendSms('+15305550100', { automated: true, env, optedOut: false }).ok, true);
  assert.equal(canSendSms('+15305550999', { automated: true, env, optedOut: false }).reason, 'test_mode');
  assert.equal(canSendSms('+14083061957', { automated: true, env: { AI_TEST_MODE: 'false' }, optedOut: false }).reason, 'suppressed');
  assert.equal(canSendSms('+15305550100', { automated: true, env, optedOut: true }).reason, 'opted_out');
  assert.equal(canSendSms('(408) 306-1957', { automated: false, env: { AI_TEST_MODE: 'false' }, optedOut: false }).ok, false);
});

test('new-message and blast planning does not text outsiders while test mode is on', () => {
  const env = { AI_REPLY_ALLOWLIST: '+15305550100' };
  const outsider = planInbound({ phone: '+15305550888', message: 'yes I want to sell', env });
  assert.equal(outsider.send, false);
  assert.equal(outsider.ghl, false);
});

test('the daily blast script does not pretend to be Derek or promise no fees', () => {
  assert.match(DEFAULT_DAILY_BLAST, /assistant/i);
  assert.match(DEFAULT_DAILY_BLAST, /STOP/);
  assert.doesNotMatch(DEFAULT_DAILY_BLAST, /this is derek|no fees|7-14|cover all closing/i);
});
