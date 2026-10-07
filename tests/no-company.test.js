const test = require('node:test');
const assert = require('node:assert');
const { composeReply } = require('../lib/persona');

const BAD = /nor\s*-?\s*cal\s*home\s*offer|\.com\b|www\.|https?:/i;

test('normal replies never name the company or a website', () => {
  const drafts = [
    "You can check us out at NorCalHomeOffer.com. We buy houses as-is for cash in Redding. No repairs needed. If you'd like to explore selling to us, share the property condition and timeline. Derek can follow up.",
    'Visit norcalhomeoffer . com for more info. What condition is the home in?',
    'NorCal Home Offer buys houses as-is. What condition is it in?',
    'See https://norcalhomeoffer.com or www.norcalhomeoffer.com. When would you like to sell?',
    'We work with Norcal Home Offers. Why are you selling?',
  ];
  for (const d of drafts) {
    const out = composeReply({ inbound: 'Tell me more', modelReply: d });
    assert.ok(out && out.length > 0, `empty reply for ${d}`);
    assert.doesNotMatch(out, BAD, out);
    assert.doesNotMatch(out, /derek/i, out);
  }
});

test('who-is-this answer may name the company', () => {
  assert.match(composeReply({ inbound: 'What company is this?', modelReply: 'x' }), /NorCal Home Offer/);
});
