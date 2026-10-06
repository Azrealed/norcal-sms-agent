const test = require('node:test');
const assert = require('node:assert/strict');
const { syncSellerToGhl, resetGhlWarnings } = require('../lib/ghl');
const { assessOfferReady } = require('../lib/qualify');

function offerReadyThread() {
  return [
    { direction: 'outbound', body: 'Hi, would you consider a cash offer if you have thought about selling?' },
    { direction: 'inbound', body: 'Yes I want to sell' },
    { direction: 'outbound', body: 'What is the address, the condition, and your timeline?' },
    {
      direction: 'inbound',
      body: '123 Oak Street, Redding. Roof needs work. Hoping to move in about 30 days. Inherited it. Asking around 250k.',
    },
  ];
}

function mockFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = url.replace('https://services.leadconnectorhq.com', '');
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const handler = handlers.find((h) => h.method === (options.method || 'GET') && h.path === path);
    if (!handler) {
      return { ok: false, status: 404, json: async () => ({ message: 'unexpected ' + path }) };
    }
    return { ok: true, status: handler.status || 200, json: async () => handler.json };
  };
  return { fetchImpl, calls };
}

const env = {
  GHL_API_TOKEN: 'test-token',
  GHL_LOCATION_ID: 'loc_test',
  GHL_PIPELINE_ID: 'pipe_test',
  GHL_PIPELINE_STAGE_ID: 'stage_test',
};

test('an offer-ready conversation pushes once, with a note, then only updates the note', async () => {
  const messages = offerReadyThread();
  const assessment = assessOfferReady(messages, { phone: '+15305550100', contact_name: 'Gloria' });
  assert.equal(assessment.ready, true);
  assert.match(assessment.summary.address, /123 Oak Street/);

  const { fetchImpl, calls } = mockFetch([
    { method: 'POST', path: '/contacts/upsert', json: { contact: { id: 'contact_1' }, new: true } },
    { method: 'POST', path: '/contacts/contact_1/notes', status: 201, json: { note: { id: 'note_1' } } },
    { method: 'POST', path: '/opportunities/upsert', json: { opportunity: { id: 'opp_1' }, new: true } },
  ]);

  const first = await syncSellerToGhl({
    conversation: { phone: '+15305550100', contact_name: 'Gloria' },
    messages,
    env,
    fetchImpl,
    log: () => {},
  });

  assert.equal(first.action, 'created');
  assert.equal(first.contactId, 'contact_1');
  assert.equal(first.opportunityId, 'opp_1');
  assert.equal(calls.filter((c) => c.path === '/contacts/upsert').length, 1);
  assert.equal(calls.filter((c) => c.path === '/opportunities/upsert').length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith('/notes')).length, 1);
  const note = calls.find((c) => c.path.endsWith('/notes')).body.body;
  assert.match(note, /123 Oak Street/);
  assert.match(note, /Roof needs work/);
  assert.match(note, /30 days/);
  assert.match(note, /Inherited/);
  assert.match(note, /250k/);
  assert.match(note, /Transcript:/);
  assert.match(note, /Lead: Yes I want to sell/);
  assert.equal(calls[0].body.locationId, 'loc_test');
  assert.equal(calls[0].body.phone, '+15305550100');

  const second = await syncSellerToGhl({
    conversation: {
      phone: '+15305550100',
      contact_name: 'Gloria',
      ghl_contact_id: first.contactId,
      ghl_opportunity_id: first.opportunityId,
      ghl_note_fingerprint: first.fingerprint,
    },
    messages,
    env,
    fetchImpl,
    log: () => {},
  });
  assert.equal(second.action, 'unchanged');
  assert.equal(calls.filter((c) => c.path === '/contacts/upsert').length, 1);
  assert.equal(calls.filter((c) => c.path === '/opportunities/upsert').length, 1);

  const followUp = messages.concat([{ direction: 'inbound', body: 'The foundation is cracked too, still want an offer.' }]);
  const third = await syncSellerToGhl({
    conversation: {
      phone: '+15305550100',
      contact_name: 'Gloria',
      ghl_contact_id: first.contactId,
      ghl_opportunity_id: first.opportunityId,
      ghl_note_fingerprint: first.fingerprint,
    },
    messages: followUp,
    env,
    fetchImpl,
    log: () => {},
  });
  assert.equal(third.action, 'updated');
  assert.equal(third.wroteNote, true);
  assert.equal(third.createdContact, false);
  assert.equal(third.createdOpportunity, false);
  assert.equal(calls.filter((c) => c.path === '/contacts/upsert').length, 1);
  assert.equal(calls.filter((c) => c.path === '/opportunities/upsert').length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith('/notes')).length, 2);
});

test('opt-out, wrong number, not interested, a lone yes, and a lone price do not push', async () => {
  const cases = [
    [{ direction: 'inbound', body: 'STOP' }],
    [{ direction: 'inbound', body: 'not Gloria' }, { direction: 'inbound', body: 'This is not Gloria, wrong number' }],
    [
      { direction: 'inbound', body: 'I want to sell 123 Oak Street, roof needs work' },
      { direction: 'inbound', body: 'Not interested' },
    ],
    [{ direction: 'outbound', body: 'Want a cash offer?' }, { direction: 'inbound', body: 'Yes' }],
    [{ direction: 'inbound', body: '$250,000' }],
  ];

  for (const messages of cases) {
    let called = false;
    const result = await syncSellerToGhl({
      conversation: { phone: '+15305550100' },
      messages,
      env,
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) };
      },
      log: () => {},
    });
    assert.equal(result.action, 'skipped', messages.map((m) => m.body).join(' | '));
    assert.equal(called, false);
  }
});

test('missing GoHighLevel env vars are logged and do not throw', async () => {
  resetGhlWarnings();
  const logs = [];
  const result = await syncSellerToGhl({
    conversation: { phone: '+15305550100' },
    messages: offerReadyThread(),
    env: {},
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'missing_config');
  assert.match(logs.join('\n'), /GHL_API_TOKEN or GHL_LOCATION_ID/);
});

test('pipeline name lookup is used when ids are not set', async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      method: 'GET',
      path: '/opportunities/pipelines?locationId=loc_test',
      json: { pipelines: [{ id: 'pipe_named', name: 'SMS Blast Leads', stages: [{ id: 'stage_named', name: 'New' }] }] },
    },
    { method: 'POST', path: '/contacts/upsert', json: { contact: { id: 'contact_9' }, new: true } },
    { method: 'POST', path: '/contacts/contact_9/notes', status: 201, json: { note: { id: 'note_9' } } },
    { method: 'POST', path: '/opportunities/upsert', json: { opportunity: { id: 'opp_9' }, new: true } },
  ]);

  const result = await syncSellerToGhl({
    conversation: { phone: '5305550100', contact_name: 'Sam Seller' },
    messages: offerReadyThread(),
    env: { GHL_API_TOKEN: 'test-token', GHL_LOCATION_ID: 'loc_test' },
    fetchImpl,
    log: () => {},
  });
  assert.equal(result.opportunityId, 'opp_9');
  const opp = calls.find((c) => c.path === '/opportunities/upsert');
  assert.equal(opp.body.pipelineId, 'pipe_named');
  assert.equal(opp.body.pipelineStageId, 'stage_named');
  assert.equal(opp.body.contactId, 'contact_9');
});
