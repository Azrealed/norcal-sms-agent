const test = require('node:test');
const assert = require('node:assert');
const { composeReply, NO_PRICE_FACT, STAY_FACT, CLOSING_FACT, COSTS_FACT, HONEST_REPLY, WHO_REPLY } = require('../lib/persona');
const { CANONICAL_KB } = require('../lib/knowledge');

test('normal replies never mention Derek', () => {
  const drafts = [
    "What's the current condition of the home? Derek will follow up with more details.",
    "I can't quote a price by text. Derek will follow up. What condition is the home in?",
    "That makes sense. There's no rush. When you're ready, Derek can follow up with you both.",
    "Derek's team buys houses as-is. What condition is it in?",
    "Thanks! Derek can personally follow up once I know the condition.",
  ];
  for (const d of drafts) {
    const out = composeReply({ inbound: 'Yes', modelReply: d });
    assert.ok(out && out.length > 0, `empty reply for ${d}`);
    assert.doesNotMatch(out, /derek/i, out);
  }
});

test('fixed facts and non-identity KB answers have no Derek', () => {
  for (const f of [NO_PRICE_FACT, STAY_FACT, CLOSING_FACT, COSTS_FACT]) assert.doesNotMatch(f, /derek/i);
  for (const e of CANONICAL_KB) {
    if (e.category === 'honesty' || e.category === 'internal') continue;
    assert.doesNotMatch(e.answer, /derek/i, e.question);
  }
});

test('identity answers mention Derek exactly once', () => {
  assert.strictEqual((composeReply({ inbound: 'Are you a bot?', modelReply: 'x' }).match(/derek/gi) || []).length, 1);
  assert.strictEqual((composeReply({ inbound: 'Who is this?', modelReply: 'x' }).match(/derek/gi) || []).length, 1);
  assert.strictEqual((HONEST_REPLY.match(/derek/gi) || []).length, 1);
  assert.strictEqual((WHO_REPLY.match(/derek/gi) || []).length, 1);
});
