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

function isOptOutMessage(message) {
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
  return /\b(stop texting|stop messaging|do not text|don't text|dont text|do not contact|don't contact|leave me alone|leave me be|go away|lose this number|lose my number|delete my number|take me off|remove me|unsubscribe|never subscribed|f\W*ck off)\b/i.test(
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

function isWrongNumber(message) {
  const t = String(message || '').trim();
  if (/\bwrong (number|person|house|guy|girl|man|woman|lady)\b/i.test(t)) return true;
  if (/\byou(?:'ve| have) (?:got )?the wrong\b/i.test(t)) return true;
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
  // Short "not <name>" replies, or an explicit "this is not <Name>".
  if (t.length <= 80) return true;
  return /\b(this is|i am|i'm)\s+not\s+/i.test(t);
}

module.exports = {
  ALWAYS_SUPPRESSED,
  isTestMode,
  isSuppressed,
  isAutoReplyAllowed,
  isOptOutMessage,
  isResubscribeMessage,
  isNotInterested,
  isWrongNumber,
  canSendSms,
};
