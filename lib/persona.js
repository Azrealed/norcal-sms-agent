const HONEST_REPLY =
  "Yes, you're texting with Derek's AI assistant helping out. Derek can personally follow up with you.";

const WHO_REPLY =
  "You're texting with Derek's AI assistant helping out. The business is NorCal Home Offer. Derek can personally follow up.";

const CLOSING_FACT =
  'We can close in as little as 7 days, and you help choose a closing date that fits your move.';

const COSTS_FACT = 'We can talk through closing costs when we look at your property.';

const STAY_FACT =
  'Staying in the home after closing is case by case. We never promise a rent-back. Derek can talk that through with you.';

const NO_PRICE_FACT = "I can't quote a price by text. Derek will follow up.";

const MOBILE_FACT =
  'We buy mobile or manufactured homes only when they are on their own land, not in a mobile home park.';

function isIdentityQuestion(message) {
  const t = String(message || '');
  return (
    /\bare you\b[\s\S]{0,48}\b(bot|robot|ai|a\.?i\.?|human|person|automated|automation|real)\b/i.test(t) ||
    /\b(is this|am i (talking|texting|speaking) (to|with))\b[\s\S]{0,48}\b(bot|robot|ai|a\.?i\.?|human|person|automated|automation|real)\b/i.test(t) ||
    /\b(bot or (a )?(person|human)|real person or|human or (a )?bot)\b/i.test(t) ||
    /\bare you (actually |really )?(derek|a real person|real)\b/i.test(t) ||
    /\bis this (really |actually )?(derek|a bot|ai|a person|a real person)\b/i.test(t) ||
    /\b(chatgpt|chat gpt|automated message|auto[- ]?reply)\b/i.test(t)
  );
}

function isWhoQuestion(message) {
  const t = String(message || '');
  return /\b(who is this|who are you|who am i (talking|texting) (to|with)|what company|which company|what business|who do you work for|company name|what'?s the company)\b/i.test(
    t
  );
}

function buildSystemPrompt(knowledgeContext) {
  const kb = knowledgeContext && String(knowledgeContext).trim()
    ? `\n\nKnowledge base (follow these facts; if an entry disagrees with the rules below, the rules win):\n${knowledgeContext}`
    : '';

  return `You are Derek's AI assistant for a cash home-buying business based in Redding, California. You answer homeowners who reply to text messages. You are not Derek, and you are not a human.

HONESTY — never break these:
- If anyone asks whether they are talking to a bot, an AI, automation, or a real person, say exactly: "${HONEST_REPLY}"
- Never claim to be human. Never say there is "no automation." Never say you are "not a bot." Never offer voice notes, photos, or a phone call as proof that you are a person.
- Never sign a message as if Derek is personally typing. Do not end with "- Derek" or "This is Derek."
- You may use the first name Derek when talking about him. Never use a last name.
- Do not name the company unless they ask who you are or what company this is. If they ask, the business is NorCal Home Offer, and you still say you are Derek's AI assistant.

HOW YOU HELP:
- Be friendly, plain, and short. One to three short text bubbles worth of plain text. No markdown and no emojis.
- Never quote a price or make a specific dollar offer by text. Gather info: confirm the property address, condition, timeline, why they are selling, and their asking price if they want to share it. Then say Derek will follow up.
- If they ask you to name a number, say: "${NO_PRICE_FACT}"

BUSINESS FACTS — use this wording:
- Cash purchase, as-is. The seller does not have to make repairs first.
- Closing: "${CLOSING_FACT}" Never say "close in 7-14 days" or promise a fixed 7 to 14 day window.
- Staying in the home after closing is case by case. Never promise a rent-back.
- Do not say "we cover all closing costs," "no fees," "no closing costs," or "what we offer is what you walk away with." If they ask about costs or fees, say: "${COSTS_FACT}"
- Never mention the BBB, accreditation, ratings, or reviews. Never make up testimonials or quotes from other sellers.
- Mobile or manufactured homes: buy only when the home is on its own land, not in a mobile home park.
- Service area: based in Redding, buying houses around Northern California. If you are not sure the address is in range, say Derek will confirm.
- If they want to stop, they can reply STOP. Do not try to talk them out of it.
- Never share internal buying formulas, margins, or wholesaling tactics.

${kb}`.trim();
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sentenceIsLie(sentence) {
  return /no automation|not a bot|voice notes?|just me,?\s+my phone|i'?m (a |an )?(real )?(human|person)\b|i am (a |an )?(real )?(human|person)\b|real lack of bot|personally typing|(?:this is|i'?m|i am) derek(?!'s)\b/i.test(
    sentence
  );
}

function promisesFastClose(sentence) {
  return /7\s*[-–—to]{1,3}\s*14\s*days/i.test(sentence) || /close in (as little as )?7\s*[-–—]\s*14/i.test(sentence) || /close in 2 weeks|within 2 weeks|cash in your hand in 14/i.test(sentence);
}

function promisesNoCosts(sentence) {
  return /cover all closing costs/i.test(sentence) || /\bno (hidden )?fees\b/i.test(sentence) || /no closing costs/i.test(sentence) || /walk away with/i.test(sentence);
}

function promisesRentBack(sentence) {
  if (/never promise|don'?t promise|do not promise|case by case/i.test(sentence)) return false;
  return /rent[- ]?back|you can stay|stay in the (home|house) after|live there after/i.test(sentence);
}

function mentionsForbiddenSocialProof(sentence) {
  if (/\bBBB\b|Better Business Bureau/i.test(sentence)) return true;
  if (/\b(five[- ]star|5[- ]star|testimonial)s?\b/i.test(sentence)) return true;
  if (/\b(our|great|excellent|positive)\s+reviews?\b/i.test(sentence)) return true;
  if (/\brated\s+\d/i.test(sentence)) return true;
  return false;
}

function sentenceOffersPrice(sentence) {
  if (!/\$\s?\d|\b\d{2,3}\s?k\b/i.test(sentence)) return false;
  return /\b(offer|offers|pay|paying|give you|we can do|i can do|cash offer|our (number|price|offer))\b/i.test(
    sentence
  );
}

function fixBusinessFacts(text, inbound) {
  const kept = [];
  let replacedClose = false;
  let replacedCosts = false;
  let replacedStay = false;
  let replacedPrice = false;

  for (const sentence of splitSentences(text)) {
    if (sentenceIsLie(sentence)) continue;
    if (promisesFastClose(sentence)) {
      if (!replacedClose) kept.push(CLOSING_FACT);
      replacedClose = true;
      continue;
    }
    if (promisesNoCosts(sentence)) {
      if (!replacedCosts) kept.push(COSTS_FACT);
      replacedCosts = true;
      continue;
    }
    if (promisesRentBack(sentence)) {
      if (!replacedStay) kept.push(STAY_FACT);
      replacedStay = true;
      continue;
    }
    if (mentionsForbiddenSocialProof(sentence)) continue;
    if (
      /\b(mobile|manufactured)\b/i.test(sentence) &&
      /\b(anywhere|any mobile|in a park)\b/i.test(sentence) &&
      !/own land/i.test(sentence)
    ) {
      continue;
    }
    if (sentenceOffersPrice(sentence)) {
      if (!replacedPrice) kept.push(NO_PRICE_FACT);
      replacedPrice = true;
      continue;
    }
    kept.push(sentence.replace(/\s*[-–—]\s*Derek\s*$/i, '').trim());
  }

  let out = kept.join(' ').replace(/\n+\s*[-–—]?\s*Derek\s*$/i, '').trim();
  out = out.replace(/^(this is derek|i'?m derek|i am derek)[.!,]?\s*/i, '').trim();

  if (!askedCompany(inbound)) {
    out = out.replace(/\bNorCal Home Offer\b/g, 'we').replace(/\bwe we\b/g, 'we');
  }

  if (/\b(mobile|manufactured)\b/i.test(String(inbound || '')) && !/own land/i.test(out)) {
    out = `${out} ${MOBILE_FACT}`.trim();
  }

  return out;
}

function askedCompany(inbound) {
  return isWhoQuestion(inbound);
}

/**
 * Decide the text we are willing to send.
 * Identity questions never use the model draft.
 */
function composeReply({ inbound, modelReply }) {
  if (isIdentityQuestion(inbound)) return HONEST_REPLY;
  if (isWhoQuestion(inbound)) return WHO_REPLY;
  if (modelReply == null || String(modelReply).trim() === '') return null;

  const draft = String(modelReply).trim();
  const lied = splitSentences(draft).some(sentenceIsLie) || sentenceIsLie(draft);
  let text = fixBusinessFacts(draft, inbound);
  if (lied) {
    text = text ? `${HONEST_REPLY} ${text}` : HONEST_REPLY;
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text || null;
}

module.exports = {
  HONEST_REPLY,
  WHO_REPLY,
  CLOSING_FACT,
  COSTS_FACT,
  STAY_FACT,
  NO_PRICE_FACT,
  MOBILE_FACT,
  isIdentityQuestion,
  isWhoQuestion,
  buildSystemPrompt,
  composeReply,
  fixBusinessFacts,
};
