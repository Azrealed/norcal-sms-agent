const { phonesMatch, parsePhoneList } = require('./phones');

/** This number must never be texted, even if someone puts it on the allowlist. */
const ALWAYS_SUPPRESSED = ['+14083061957'];

function isTestMode(env = process.env) {
  const raw = env.AI_TEST_MODE;
  if (raw == null || String(raw).trim() === '') return true;
  return !['false', '0', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

function isSuppressed(phone, env = process.env) {
  const extra = parsePhoneList(env.SUPPRESSED_NUMBERS);
  return [...ALWAYS_SUPPRESSED, ...extra].some((n) => phonesMatch(n, phone));
}

/**
 * Test mode is on unless AI_TEST_MODE is explicitly turned off.
 * While it is on, only AI_REPLY_ALLOWLIST numbers get automatic replies.
 */
function isAutoReplyAllowed(phone, env = process.env) {
  if (!phone || isSuppressed(phone, env)) return false;
  if (!isTestMode(env)) return true;
  const allow = parsePhoneList(env.AI_REPLY_ALLOWLIST);
  return allow.some((n) => phonesMatch(n, phone));
}

function canSendSms(phone, { automated = false, env = process.env, optedOut = false } = {}) {
  if (isSuppressed(phone, env)) return { ok: false, reason: 'suppressed' };
  if (optedOut) return { ok: false, reason: 'opted_out' };
  if (automated && !isAutoReplyAllowed(phone, env)) return { ok: false, reason: 'test_mode' };
  return { ok: true };
}

function normalizeKeyword(message) {
  return String(message || '')
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Remove text the seller is quoting rather than saying: iMessage/Android reactions
 * ('Liked “...”', '👍 to “...”') and our own "Reply STOP to unsubscribe" footer.
 */
function stripQuoted(message) {
  let t = String(message || '').replace(/[\u200a\u200b\u200c\u200d\ufeff]/g, '');
  if (isReaction(t)) t = t.replace(/[“"][^”"]*[”"]?/g, ' ');
  return t
    .replace(/\breply\s+stop\s+to\s+(unsubscribe|opt[\s-]?out|end|stop)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isReaction(message) {
  return /^\s*[\u200a\u200b\s]*(liked|loved|disliked|laughed at|emphasized|questioned|reacted\s+\S+\s+to|\S{1,4}\s+to)\s*[\u200a\u200b\s]*[“"]/i.test(String(message || ''));
}

function isOptOutMessage(message) {
  message = stripQuoted(message);
  const t = normalizeKeyword(message);
  const exact = new Set([
    'stop',
    'stopall',
    'stop all',
    'unsubscribe',
    'cancel',
    'quit',
    'end',
    'remove',
    'opt out',
    'optout',
  ]);
  if (exact.has(t)) return true;
  return /\b(stop texting|stop messaging|do not text|don't text|dont text|do not contact|don't contact|dont contact|stop contacting|stop calling|don't call|do not call|dont call|quit calling|do not disturb|don't disturb|dont disturb|quit texting|quit messaging|stop sending|leave me alone|leave me be|go away|lose this number|lose my number|delete my number|take me off|remove me|unsubscribe|never subscribed|f\W*ck off)\b/i.test(
    String(message || '')
  );
}

function isResubscribeMessage(message) {
  const t = normalizeKeyword(message);
  return t === 'start' || t === 'unstop';
}

function isNotInterested(message) {
  return /\b(not interested|no thanks|no thank you|not selling|don'?t want to sell|do not want to sell|no longer interested)\b/i.test(
    String(message || '')
  );
}

/**
 * A clear "no" / not-interested reply. The bot sends nothing back to these.
 * Hedged replies ("no, but maybe next year", "not now, what would you offer?") are not clear no's.
 */
function isClearNo(message) {
  if (isReaction(message)) return false;
  const t = stripQuoted(message).trim().toLowerCase().replace(/[\u2018\u2019]/g, "'");
  if (!t) return false;
  if (t.includes('?')) return false;
  const hedge = /\b(but|maybe|unless|depends|depending|how much|what would|what's your|what is your|considering|consider|might|possibly|later|future|someday|some day|next year|in a (few|couple)|if\b|sell for|asking|call me|text me|land|lot|acres?)\b|\$\s?\d|\b\d+\s?k\b/;
  if (hedge.test(t)) return false;
  if (isNotInterested(t)) return true;
  const core = t.replace(/[\s.!,;:)\-]+$/, '').replace(/\s+/g, ' ');
  const exact = /^(no+|nope|nah|no sir|no ma'?am|no way|never|not really|probably not|not interested|not for sale|not selling|not at this time|not right now|not now|no thanks?|no thank you|i'?m good|we'?re good|all good|pass|i'?ll pass|hard pass|definitely not|absolutely not|not at all|no sorry|sorry no|no not really|no not interested|no not selling|nope not interested)([ ,.!]+(thanks?|thank you|thx|sorry|though|tho))*$/;
  if (exact.test(core)) return true;
  if (/^(no+|nope|nah)\s*[,.!\-]/.test(t)) return true;
  if (/^(no+|nope|nah)\s+(not|thanks|thank|i'?m|we'?re|sorry|never|i don'?t|we don'?t|i do not|we do not|i am not|we are not|it'?s not|i have no|we have no|i will not|i won'?t|we won'?t|i just|we just|my|our)\b/.test(t)) return true;
  return false;
}

/** Something positive or re-engaging from a seller (used to un-archive and to spot real interest). */
function isPositiveSignal(message) {
  const t = String(message || '');
  if (!t.trim()) return false;
  if (isClearNo(t) || isOptOutMessage(t)) return false;
  return /\b(yes|yeah|yep|yup|ya|sure|interested|sell|selling|sale|offer|price|how much|what would|maybe|possibly|depends|changed my mind|actually|call me|tell me more|still (buying|interested|available)|thinking about|consider|considering|asap)\b|\$\s?\d|\b\d+\s?k\b|\b\d{1,3},\d{3}\b/i.test(t)
    && !/\bnot\s+(interested|selling)\b/i.test(t);
}

function isWrongNumber(message) {
  if (isReaction(message)) return false;
  const t = stripQuoted(message);
  if (/\bwrong\s+(?:(?:phone|cell|cell phone|mobile|tel(?:ephone)?)\s+)?(number|num|no\.?|#|person|house|guy|girl|man|woman|lady|people)(?=\W|$)/i.test(t)) return true;
  if (/\byou(?:'ve| have) (?:got )?the wrong\b/i.test(t)) return true;
  if (/\b(phone|number|this)\s+(does not|doesn'?t|do not|don'?t)\s+belong\s+to\b/i.test(t)) return true;
  if (/\bnot\s+my\s+(phone|number|cell|line)\b/i.test(t)) return true;
  if (/\b(no one|nobody|no)\s+(here\s+)?(by that name|named)\b/i.test(t)) return true;
  if (/\bnot\s+gloria\b/i.test(t)) return true;
  if (/\bthis isn'?t\s+[A-Za-z]{3,}\b/i.test(t) && !/\bthis isn'?t\s+(a |an )?(good|bad|interested)/i.test(t)) {
    return true;
  }
  const named = t.match(
    /\bnot\s+(?!interested\b|selling\b|sure\b|ready\b|now\b|going\b|looking\b|home\b|a\b|the\b)([A-Za-z]{3,})\b/i
  );
  if (!named) return false;
  const word = named[1].toLowerCase();
  const ordinary = new Set(['interested', 'selling', 'sure', 'ready', 'now', 'going', 'looking', 'home', 'available']);
  if (ordinary.has(word)) return false;
  // "I'm not Teresa" / "this is not wendy" / "I aint Craig": a name right after a self-reference,
  // or a capitalized name. Ordinary phrases like "not quite looking" are not wrong numbers.
  if (/\b(this is|this isn'?t|i am|i'm|im|i ain'?t|i aint)\s+(not\s+)?[A-Za-z]{3,}\b/i.test(t) && /\b(this is|i am|i'm|im)\s+not\s+/i.test(t)) return true;
  const capitalized = /^[A-Z][a-z]+$/.test(named[1]);
  return capitalized && t.length <= 80;
}

module.exports = {
  ALWAYS_SUPPRESSED,
  isTestMode,
  isSuppressed,
  isAutoReplyAllowed,
  isOptOutMessage,
  isResubscribeMessage,
  isNotInterested,
  isClearNo,
  stripQuoted,
  isReaction,
  isPositiveSignal,
  isWrongNumber,
  canSendSms,
};
