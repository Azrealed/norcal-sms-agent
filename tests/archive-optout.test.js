const test = require('node:test');
const assert = require('node:assert');
const { planInbound, hasPriorInterest } = require('../lib/inbound');
const { smsblastOptOut } = require('../lib/smsblast-optout');

const env = { AI_TEST_MODE: 'true', AI_REPLY_ALLOWLIST: '+15305550100' };
const phone = '+15305550100';

test('a plain no is archived, silent, no GHL, and NOT opted out', () => {
  for (const m of ['No', 'nope', 'Not interested', 'not selling', 'Never', 'No thanks']) {
    const p = planInbound({ phone, message: m, env });
    assert.equal(p.send, false, m);
    assert.equal(p.ghl, false, m);
    assert.equal(p.optOut, false, m);
    assert.equal(p.archive, true, m);
    assert.equal(p.reason, 'not_interested', m);
  }
});

test('stop-type and wrong-number replies are silent, opted out, and archived', () => {
  for (const m of ["Don't text me", "don't call me", 'Remove me', 'Lose this number', 'Wrong number', 'Not my phone', 'Please do not call', 'unsubscribe']) {
    const p = planInbound({ phone, message: m, env });
    assert.equal(p.send, false, m);
    assert.equal(p.ghl, false, m);
    assert.equal(p.optOut, true, m);
    assert.equal(p.archive, true, m);
  }
});

test('an already opted-out contact stays suppressed and archived, even if positive', () => {
  const p = planInbound({ phone, message: 'Yes I want to sell', env, optedOut: true, archived: true });
  assert.equal(p.send, false);
  assert.equal(p.reason, 'already_opted_out');
  assert.equal(p.archive, true);
});

test('an archived "no" that says something positive is un-archived and handled normally', () => {
  const p = planInbound({ phone, message: 'Actually, what would you offer?', env, archived: true });
  assert.equal(p.send, true);
  assert.equal(p.unarchive, true);
  assert.equal(p.reason, 'ai');
});

test('an archived "no" that says nothing positive stays archived and silent', () => {
  const p = planInbound({ phone, message: 'ok', env, archived: true });
  assert.equal(p.send, false);
  assert.equal(p.reason, 'archived_no');
  assert.equal(p.unarchive, undefined);
});

test('"No" after earlier interest is an answer to a question, not a not-interested reply', () => {
  const prior = hasPriorInterest(['Sell sell sell']);
  assert.equal(prior, true);
  const p = planInbound({ phone, message: 'Nope', env, priorInterest: prior });
  assert.equal(p.send, true);
  assert.notEqual(p.archive, true);
  assert.equal(hasPriorInterest(['No'], {}), false);
  assert.equal(hasPriorInterest([], { inGhl: true }), true);
});

test('smsblast opt-out call: Bearer auth, E.164 number, result mapping', async () => {
  const calls = [];
  const mk = (status, body) => async (url, opts) => {
    calls.push({ url, opts });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  let r = await smsblastOptOut('+15305550100', { apiKey: 'k', fetchImpl: mk(200, { success: true, optedOut: 1, alreadyOptedOut: false }) });
  assert.deepEqual(r, { ok: true, status: 'opted_out' });
  assert.equal(calls[0].url, 'https://app.smsblast.io/api/v2/contacts/opt-out');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { number: '+15305550100' });
  r = await smsblastOptOut('+1', { apiKey: 'k', fetchImpl: mk(200, { success: true, alreadyOptedOut: true }) });
  assert.equal(r.status, 'already_opted_out');
  r = await smsblastOptOut('+1', { apiKey: 'k', fetchImpl: mk(404, { error: 'not found' }) });
  assert.equal(r.status, 'not_found');
  r = await smsblastOptOut('+1', { apiKey: 'k', fetchImpl: mk(500, {}) });
  assert.equal(r.status, 'error_500');
  r = await smsblastOptOut('+1', { apiKey: '' });
  assert.equal(r.status, 'error_no_api_key');
});

test('a reaction that quotes our "Reply STOP to unsubscribe" footer is not an opt-out', () => {
  const { isOptOutMessage, isClearNo, isWrongNumber } = require('../lib/policy');
  const m = '\u200a\u200b👍\u200b to “\u200aHi there, Im looking to buy another property right now. Are you still interested in seeing how much I can pay for yours? Thanks -Derek Reply STOP to unsubscribe.\u200a”\u200a';
  assert.equal(isOptOutMessage(m), false);
  assert.equal(isClearNo(m), false);
  assert.equal(isWrongNumber(m), false);
  assert.equal(isOptOutMessage('Liked “No problem. Reply STOP to unsubscribe”'), false);
  assert.equal(isOptOutMessage('STOP'), true);
  assert.equal(isOptOutMessage('unsubscribe me'), true);
});

test('a seller quoting "stop texting me" in their own words is still an opt-out', () => {
  const { isOptOutMessage } = require('../lib/policy');
  assert.equal(isOptOutMessage('I already said "stop texting me"'), true);
});
