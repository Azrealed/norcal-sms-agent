// The ONLY identity the bot may ever give is "Derek's AI assistant". No company name,
// website, address, city, or other business info, ever.
const HONEST_REPLY = "Yes, this is Derek's AI assistant.";

const WHO_REPLY = "This is Derek's AI assistant.";

const BUSINESS_INFO_REPLY = "I can't share business details by text, but someone can follow up with you.";

const CLOSING_FACT =
  'We can close in as little as 7 days, and you help choose a closing date that fits your move.';

const COSTS_FACT = 'We can talk through closing costs when we look at your property.';

const STAY_FACT =
  'Staying in the home after closing is case by case. We never promise a rent-back, but we can talk it through.';

const NO_PRICE_FACT = "I can't quote a price by text.";

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

function isBusinessInfoQuestion(message) {
  const t = String(message || '');
  return /\b(where are you (guys )?(located|based|from|at)|where('?s| is) your (office|company|business)|what('?s| is) your (website|web site|site|address|office|location|business name)|do you (guys )?have a (website|web site|site|office)|your (website|web site|office address|business address)|are you (guys )?local|website)\b/i.test(t);
}

function isWhoQuestion(message) {
  const t = String(message || '');
  return /\b(who is this|who are you|who am i (talking|texting) (to|with)|what company|which company|what business|who do you work for|company name|what'?s the company)\b/i.test(
    t
  );
}

const DEFAULT_DAILY_BLAST =
  "Hi {firstName}, Derek's assistant here. If you've thought about selling {address}, reply and Derek can follow up. Reply STOP to opt out.";

function buildSystemPrompt(knowledgeContext, extras = {}) {
  const kb = knowledgeContext && String(knowledgeContext).trim()
    ? `\n\nKnowledge base (follow these facts; if an entry disagrees with the rules below, the rules win):\n${knowledgeContext}`
    : '';
  const stageGuidance = extras && extras.stageGuidance ? String(extras.stageGuidance).trim() : '';
  const stageBlock = stageGuidance ? `\n\nWhere this conversation stands:\n${stageGuidance}` : '';

  return `You are Derek's AI assistant. You answer homeowners who reply to text messages about possibly selling their property. You are not Derek, and you are not a human.

HONESTY — never break these:
- If anyone asks whether they are talking to a bot, an AI, automation, or a real person, say exactly: "${HONEST_REPLY}"
- If anyone asks who this is or what company this is, say exactly: "${WHO_REPLY}"
- Never claim to be human. Never say there is "no automation." Never say you are "not a bot." Never offer voice notes, photos, or a phone call as proof that you are a person.
- Never sign a message as if Derek is personally typing. Do not end with "- Derek" or "This is Derek."
- Do NOT mention Derek or any person's name in normal replies. Say "we" or "someone will follow up" instead. The only time you may say Derek's name is the exact honest answer when they ask if you are a bot or who this is. Never use a last name.
- NEVER give out business information of any kind: no company or business name, no website or link, no office or mailing address, no city or region the business is based in, no phone number, no license number. The only identity you may ever give is "Derek's AI assistant". If asked for business details, say exactly: "${BUSINESS_INFO_REPLY}"

HOW YOU HELP:
- Be friendly, plain, and short. One sentence, maybe two. One question, then wait. No markdown and no emojis.
- Never quote a price or make a specific dollar offer by text. Gather info: confirm the property address, condition, timeline, why they are selling, and their asking price if they want to share it. Then let them know someone will follow up.
- If they ask you to name a number, say: "${NO_PRICE_FACT}"

BUSINESS FACTS — use this wording:
- We buy as-is. The seller does not have to make repairs first.
- Closing: "${CLOSING_FACT}" Never say "close in 7-14 days" or promise a fixed 7 to 14 day window.
- Staying in the home after closing is case by case. Never promise a rent-back.
- Do not say "we cover all closing costs," "no fees," "no closing costs," or "what we offer is what you walk away with." If they ask about costs or fees, say: "${COSTS_FACT}"
- Never mention the BBB, accreditation, ratings, or reviews. Never make up testimonials or quotes from other sellers.
- Mobile or manufactured homes: buy only when the home is on its own land, not in a mobile home park.
- Service area: never say where the business is based. If they ask whether we buy in their area, ask for the property address and say we will confirm.
- If they want to stop, they can reply STOP. Do not try to talk them out of it.
- Never share internal buying formulas, margins, or wholesaling tactics.
- Do not sign messages and do not add a sign-off or name at the end.
${stageBlock}
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

  if (/\b(mobile|manufactured)\b/i.test(String(inbound || '')) && !/own land/i.test(out)) {
    out = `${out} ${MOBILE_FACT}`.trim();
  }

  return out;
}

/**
 * Normal replies never mention Derek. Drop "Derek will follow up" style sentences
 * and turn other mentions into "we" / "our".
 */
function stripDerek(text) {
  const sentences = splitSentences(text);
  if (!sentences.some((x) => /\bderek\b/i.test(x))) return String(text || '').trim();
  const followUpOnly = /^(and\s+)?derek(\s+can|\s+will|'ll)?\s+(personally\s+)?(follow up|reach out|get back|call|be in touch|contact)(\s+(with you( both)?|with more details|soon|shortly|from there|with you soon))?\s*[.!?]?$/i;
  const kept = [];
  for (const sentence of sentences) {
    if (!/\bderek\b/i.test(sentence)) { kept.push(sentence); continue; }
    if (followUpOnly.test(sentence.trim())) continue;
    let t = sentence
      .replace(/\bDerek's\b/gi, 'our')
      .replace(/\bDerek\s+(will|can|would|'ll)\b/gi, 'we $1')
      .replace(/\b(with|to|from|for|and)\s+Derek\b/gi, '$1 us')
      .replace(/\bDerek\b/gi, 'we')
      .replace(/,?\s*(and\s+)?we\s+(will|can)\s+(personally\s+)?follow up( with you)?\.?$/i, '.')
      .replace(/\bwe (can|will|would|'ll) personally\b/gi, 'we $1')
      .trim();
    t = t.replace(/^([a-z])/, (m) => m.toUpperCase()).replace(/\s+\./g, '.').replace(/^\.$/, '');
    if (t) kept.push(t);
  }
  return kept.join(' ').trim();
}

/**
 * No reply (normal, who, or bot) may give out business info: company name, website,
 * business address/location, phone number, license, or "cash home buyer" descriptors.
 * Any sentence containing one is dropped.
 */
const WEBSITE_RE = /(https?:\/\/\S+|www\s*\.\s*\S+|\b[a-z0-9-]+\s*(\.|\bdot\b)\s*(com|net|org|io|co|biz|us)\b)/i;
const COMPANY_RE = /\b(nor\s*-?\s*cal\s*-?\s*home(\s*-?\s*offers?)?|norcalhomeoffers?)\b/i;
const BUSINESS_INFO_RES = [
  /\bcash\s+(home|house)[\s-]*buy(er|ers|ing)\b/i,
  /\bhome[\s-]*buying\s+(business|company)\b/i,
  /\b(based|located|headquartered|operating)\s+(in|out of)\b/i,
  /\b(we|we're|we are|our team|our company|our business|i'm|i am)\s+(are\s+|'re\s+)?(a\s+[^.!?]{0,30}\s+)?(based\s+|located\s+|right\s+)?(in|out of|from|local to|here in)\s+(the\s+)?redding\b/i,
  /\bwe\s+(buy|purchase|work|operate|serve)\b[^.!?]{0,40}\b(in|around|across|throughout|near)\s+(the\s+)?(redding|shasta)\b/i,
  /\b(here|locally)\s+in\s+redding\b|\bredding\s+(company|business|team|buyers?|investors?)\b/i,
  /\bredding[\s-]*based\b|\blocal (to|in) redding\b|\bredding,?\s*(ca|california)\b[^.!?]{0,20}\b(office|company|business)\b/i,
  /\b(northern california|nor\s*cal)\b/i,
  /\bour\s+(office|address|location|website|web site|site|company name|business name|phone number|number is|license)\b/i,
  /\b(office|mailing|business)\s+address\b|\bvisit us\b|\bcome by\b|\bstop by\b/i,
  /\b(DRE|license)\s*#?\s*\d/i,
  /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
];

function hasBusinessInfo(text) {
  const t = String(text || '');
  return WEBSITE_RE.test(t) || COMPANY_RE.test(t) || BUSINESS_INFO_RES.some((re) => re.test(t));
}

function stripBusinessInfo(text) {
  const kept = splitSentences(text).filter((sentence) => !hasBusinessInfo(sentence));
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

// Back-compat name used by earlier tests.
const stripCompany = stripBusinessInfo;

function askedCompany(inbound) {
  return isWhoQuestion(inbound);
}

/**
 * Decide the text we are willing to send.
 * Identity questions never use the model draft.
 */
function composeReply({ inbound, modelReply }) {
  if (isIdentityQuestion(inbound)) return finalizeReply(HONEST_REPLY, { allowDerekIdentity: true });
  if (isWhoQuestion(inbound)) return finalizeReply(WHO_REPLY, { allowDerekIdentity: true });
  if (isBusinessInfoQuestion(inbound)) return finalizeReply(BUSINESS_INFO_REPLY);
  if (modelReply == null || String(modelReply).trim() === '') return null;

  const draft = String(modelReply).trim();
  const lied = splitSentences(draft).some(sentenceIsLie) || sentenceIsLie(draft);
  let text = stripBusinessInfo(stripDerek(fixBusinessFacts(draft, inbound)));
  if (lied) {
    text = text ? `${HONEST_REPLY} ${text}` : HONEST_REPLY;
  }
  return finalizeReply(text, { allowDerekIdentity: lied });
}

/**
 * Last check on every outbound text. Business info is always removed. "Derek" survives
 * only inside the exact honest identity line.
 */
function finalizeReply(text, { allowDerekIdentity = false } = {}) {
  let out = stripBusinessInfo(String(text || ''));
  if (!allowDerekIdentity) {
    out = stripDerek(out);
  } else {
    const ids = [HONEST_REPLY, WHO_REPLY];
    const id = ids.find((x) => out.startsWith(x));
    const rest = id ? out.slice(id.length).trim() : out;
    out = id ? `${id} ${stripDerek(rest)}` : stripDerek(rest);
  }
  out = out.replace(/\s+/g, ' ').trim().replace(/^([a-z])/, (m) => m.toUpperCase());
  return out || null;
}

module.exports = {
  HONEST_REPLY,
  WHO_REPLY,
  BUSINESS_INFO_REPLY,
  DEFAULT_DAILY_BLAST,
  CLOSING_FACT,
  COSTS_FACT,
  STAY_FACT,
  NO_PRICE_FACT,
  MOBILE_FACT,
  isIdentityQuestion,
  isWhoQuestion,
  isBusinessInfoQuestion,
  hasBusinessInfo,
  stripBusinessInfo,
  finalizeReply,
  buildSystemPrompt,
  composeReply,
  fixBusinessFacts,
  stripDerek,
  stripCompany,
};
