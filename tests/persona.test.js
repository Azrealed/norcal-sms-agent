const test = require('node:test');
const assert = require('node:assert/strict');
const { HONEST_REPLY, WHO_REPLY, CLOSING_FACT, COSTS_FACT, MOBILE_FACT, buildSystemPrompt, composeReply } = require('../lib/persona');
const { CANONICAL_KB } = require('../lib/knowledge');

const PRODUCTION_LIE =
  'no automation here—just me, my phone, and a very real lack of bot-like tendencies';

test('a bot question is answered honestly even if the model lies', () => {
  const reply = composeReply({
    inbound: 'are you a bot?',
    modelReply: PRODUCTION_LIE,
  });
  assert.equal(reply, HONEST_REPLY);
  assert.match(reply, /AI assistant/i);
  assert.match(reply, /Derek's AI assistant/);
  assert.doesNotMatch(reply, /no automation|voice note|just me|not a bot|real person/i);
  assert.doesNotMatch(reply, /[-–—]\s*Derek\s*$/);
});

test('real person, AI, and human questions get the same honest answer', () => {
  for (const inbound of [
    'Are you a real person?',
    'is this AI?',
    'am I talking to a human?',
    'are you Derek?',
    'can you send a voice note to prove you are real?',
  ]) {
    const reply = composeReply({ inbound, modelReply: "Nope, I'm a real person. I can send a voice note. - Derek" });
    assert.equal(reply, HONEST_REPLY, inbound);
  }
});

test('who is this gives only "Derek\'s AI assistant", no company', () => {
  const reply = composeReply({
    inbound: 'Who is this?',
    modelReply: 'This is Derek from NorCal Home Offer. I am an investor buying homes.',
  });
  assert.equal(reply, WHO_REPLY);
  assert.equal(reply, "This is Derek's AI assistant.");
  assert.doesNotMatch(reply, /NorCal|Redding|cash home buyer|\.com/i);
  assert.match(reply, /AI assistant/);
  assert.doesNotMatch(reply, /I am an investor|This is Derek from/i);
});

test('bad business claims are rewritten and a human lie is removed', () => {
  const reply = composeReply({
    inbound: 'How fast can you close and do you cover fees?',
    modelReply:
      "We close in 7-14 days and we cover all closing costs. No fees. What we offer is what you walk away with. I'm not a bot, no automation here. We are BBB accredited with great reviews. I can offer you $180,000. You can stay after closing, rent-back is fine. - Derek",
  });
  assert.match(reply, /AI assistant/);
  assert.match(reply, new RegExp(CLOSING_FACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(reply, /talk through closing costs/i);
  assert.match(reply, /can't quote a price/i);
  assert.match(reply, /case by case/i);
  assert.doesNotMatch(reply, /7\s*[-–]\s*14|cover all closing|no fees|walk away with|BBB|voice note|\$180,000|rent-back is fine/i);
});

test('manufactured homes in parks are not offered', () => {
  const reply = composeReply({
    inbound: 'It is a manufactured home in a park. Would you buy it?',
    modelReply: 'Yes, we buy manufactured homes anywhere.',
  });
  assert.match(reply, new RegExp(MOBILE_FACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the system prompt requires honesty and the corrected facts', () => {
  const prompt = buildSystemPrompt('Q: sample\nA: sample');
  assert.match(prompt, /Derek's AI assistant/);
  assert.match(prompt, /Never claim to be human/);
  assert.match(prompt, /voice notes/);
  assert.doesNotMatch(prompt, /NorCal|Redding|Northern California|cash home|\.com|www\./i);
  assert.match(prompt, /NEVER give out business information/);
  assert.match(prompt, /as little as 7 days/);
  assert.match(prompt, /case by case/);
  assert.match(prompt, /talk through closing costs/);
  assert.match(prompt, /Never mention the BBB/);
  assert.match(prompt, /own land/);
  assert.match(prompt, /Never quote a price/);
  assert.match(prompt, /Never use a last name/);
});

test('seeded answers do not repeat the old promises', () => {
  const customerFacing = CANONICAL_KB.filter((e) => e.category !== 'internal');
  for (const entry of customerFacing) {
    assert.doesNotMatch(entry.answer, /7\s*[-–]\s*14|cover all closing costs|\bno fees\b|walk away with|\bBBB\b|voice note|no automation|\$\d/i, entry.question);
    assert.doesNotMatch(entry.answer, /this is derek from|i am an investor/i, entry.question);
  }
  assert.equal(CANONICAL_KB.find((e) => e.question === 'How fast can you close?').answer, CLOSING_FACT);
  assert.equal(CANONICAL_KB.find((e) => e.question === 'Do you pay closing costs?').answer, COSTS_FACT);
});
