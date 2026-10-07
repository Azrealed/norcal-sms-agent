const test = require('node:test');
const assert = require('node:assert');
const {
  composeReply, finalizeReply, buildSystemPrompt, HONEST_REPLY, WHO_REPLY, BUSINESS_INFO_REPLY,
} = require('../lib/persona');
const { CANONICAL_KB } = require('../lib/knowledge');

const BAD = /nor\s*-?\s*cal|redding|northern california|cash (home|house)[\s-]*buyer|\.\s*com\b|\bdot com\b|www\.|https?:|based in|our office|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/i;

test('normal replies never give the company, website, location, address or phone', () => {
  const drafts = [
    "You can check us out at NorCalHomeOffer.com. We buy houses as-is for cash in Redding. No repairs needed. If you'd like to explore selling to us, share the property condition and timeline. Derek can follow up.",
    'Visit norcalhomeoffer . com for more info. What condition is the home in?',
    'Visit norcalhomeoffer dot com for more info. What condition is the home in?',
    'NorCal Home Offer buys houses as-is. What condition is it in?',
    'See https://norcalhomeoffer.com or www.norcalhomeoffer.com. When would you like to sell?',
    'We work with Norcal Home Offers. Why are you selling?',
    "We're a cash home buyer in Redding. What's your timeline?",
    'We are based in Redding and buy around Northern California. What is the address?',
    'Our office is at 1234 Main St. When would you like to sell?',
    'You can call us at (530) 555-1212. What condition is the home in?',
    "We're local to Redding. Is the house vacant?",
  ];
  for (const d of drafts) {
    const out = composeReply({ inbound: 'Tell me more', modelReply: d });
    assert.ok(out && out.length > 0, `empty reply for ${d}`);
    assert.doesNotMatch(out, BAD, out);
    assert.doesNotMatch(out, /derek/i, out);
  }
});

test('who/bot answers give only "Derek\'s AI assistant"', () => {
  assert.equal(WHO_REPLY, "This is Derek's AI assistant.");
  assert.equal(HONEST_REPLY, "Yes, this is Derek's AI assistant.");
  for (const q of ['Who is this?', 'What company is this?', 'who are you']) {
    assert.equal(composeReply({ inbound: q, modelReply: 'This is NorCal Home Offer in Redding' }), WHO_REPLY, q);
  }
  for (const q of ['Are you a bot?', 'Is this a real person?']) {
    assert.equal(composeReply({ inbound: q, modelReply: 'x' }), HONEST_REPLY, q);
  }
});

test('business-detail questions get the fixed no-details answer', () => {
  for (const q of ['Where are you located?', "What's your website?", 'Do you have a website', 'Are you guys local?']) {
    const out = composeReply({ inbound: q, modelReply: 'We are NorCal Home Offer at norcalhomeoffer.com in Redding.' });
    assert.equal(out, BUSINESS_INFO_REPLY, q);
  }
});

test('final guard strips business info even from identity lines', () => {
  const out = finalizeReply(`${WHO_REPLY} We are NorCal Home Offer, a cash home buyer in Redding.`, { allowDerekIdentity: true });
  assert.equal(out, WHO_REPLY);
  assert.equal(finalizeReply('Visit www.norcalhomeoffer.com.'), null);
});

test('no KB answer or prompt contains business info', () => {
  for (const e of CANONICAL_KB) {
    if (e.category === 'internal') {
      assert.doesNotMatch(e.answer, /nor\s*cal|redding|northern california|\.com|www\./i, e.question);
      continue;
    }
    assert.doesNotMatch(e.answer, BAD, e.question);
    if (e.category !== 'honesty') assert.doesNotMatch(e.answer, /derek/i, e.question);
  }
  const prompt = buildSystemPrompt(CANONICAL_KB.map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n'));
  assert.doesNotMatch(prompt, /nor\s*cal|redding|northern california|cash home|\.com|www\./i);
});
