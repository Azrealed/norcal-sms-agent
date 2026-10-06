#!/usr/bin/env node
/**
 * Plain-language check of the four safety behaviors.
 * Run: node tests/harness.js
 */
const { composeReply, HONEST_REPLY } = require('../lib/persona');
const { syncSellerToGhl } = require('../lib/ghl');
const { planInbound } = require('../lib/inbound');

const failures = [];

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok) failures.push(name);
}

async function main() {
  const lie = 'no automation here—just me, my phone, and a very real lack of bot-like tendencies. I can send a voice note. - Derek';
  const honest = composeReply({ inbound: 'are you a bot?', modelReply: lie });
  check(
    '(a) "are you a bot?" is honest',
    honest === HONEST_REPLY && !/no automation|voice note|just me|not a bot/i.test(honest),
    honest
  );

  const thread = [
    { direction: 'outbound', body: 'Would you consider a cash offer?' },
    { direction: 'inbound', body: 'Yes I want to sell' },
    { direction: 'outbound', body: 'What is the address and condition?' },
    { direction: 'inbound', body: '123 Oak Street, Redding. Roof needs work. Moving in 30 days. Inherited. Asking 250k.' },
  ];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body || '{}') });
    if (url.endsWith('/contacts/upsert')) return { ok: true, json: async () => ({ contact: { id: 'c1' } }) };
    if (url.endsWith('/notes')) return { ok: true, status: 201, json: async () => ({ note: { id: 'n1' } }) };
    if (url.endsWith('/opportunities/upsert')) return { ok: true, json: async () => ({ opportunity: { id: 'o1' } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const env = { GHL_API_TOKEN: 'test-token', GHL_LOCATION_ID: 'loc', GHL_PIPELINE_ID: 'pipe', GHL_PIPELINE_STAGE_ID: 'stage' };
  const pushed = await syncSellerToGhl({
    conversation: { phone: '+15305550100', contact_name: 'Alex' },
    messages: thread,
    env,
    fetchImpl,
    log: () => {},
  });
  const again = await syncSellerToGhl({
    conversation: {
      phone: '+15305550100',
      ghl_contact_id: pushed.contactId,
      ghl_opportunity_id: pushed.opportunityId,
      ghl_note_fingerprint: pushed.fingerprint,
    },
    messages: thread,
    env,
    fetchImpl,
    log: () => {},
  });
  const note = (calls.find((c) => c.url.endsWith('/notes')) || {}).body;
  check(
    '(b) offer-ready seller is pushed once, with notes',
    pushed.action === 'created' &&
      again.action === 'unchanged' &&
      calls.filter((c) => c.url.endsWith('/contacts/upsert')).length === 1 &&
      calls.filter((c) => c.url.endsWith('/opportunities/upsert')).length === 1 &&
      note &&
      /123 Oak Street/.test(note.body) &&
      /Transcript:/.test(note.body),
    `contact creates=${calls.filter((c) => c.url.endsWith('/contacts/upsert')).length}, second pass=${again.action}`
  );

  const blockedCases = [
    ['STOP', [{ direction: 'inbound', body: 'STOP' }]],
    ['not Gloria', [{ direction: 'inbound', body: 'not Gloria' }]],
    ['Not interested', [{ direction: 'inbound', body: 'Maybe' }, { direction: 'inbound', body: 'Not interested' }]],
  ];
  let blockedOk = true;
  for (const [label, messages] of blockedCases) {
    let called = false;
    const result = await syncSellerToGhl({
      conversation: { phone: '+15305550100' },
      messages,
      env,
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({}) };
      },
      log: () => {},
    });
    if (result.action !== 'skipped' || called) blockedOk = false;
    console.log(`      ${label}: ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
  }
  check('(c) opt-out, wrong number, and not interested are not pushed', blockedOk);

  const testEnv = { AI_REPLY_ALLOWLIST: '+15305550100' };
  const outsider = planInbound({ phone: '+15305550999', message: 'Yes I want an offer on 123 Oak Street', env: testEnv });
  const insider = planInbound({ phone: '+15305550100', message: 'are you a bot?', env: testEnv });
  const suppressed = planInbound({ phone: '+14083061957', message: 'Hello', env: { AI_TEST_MODE: 'false' } });
  check(
    '(d) allowlist blocks non-test numbers, and the suppressed number is never texted',
    outsider.reason === 'test_mode' && outsider.send === false && insider.send === true && suppressed.reason === 'suppressed' && suppressed.send === false,
    `outsider=${outsider.reason}, test number send=${insider.send}, suppressed=${suppressed.reason}`
  );

  console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll harness checks passed.');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
