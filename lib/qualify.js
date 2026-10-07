const { isOptOutMessage, isNotInterested, isWrongNumber } = require('./policy');
const { toE164 } = require('./phones');

function latestInbound(messages) {
  const inbound = (messages || []).filter((m) => m.direction === 'inbound');
  return inbound.length ? inbound[inbound.length - 1].body || '' : '';
}

function inboundBodies(messages) {
  return (messages || []).filter((m) => m.direction === 'inbound').map((m) => String(m.body || '').trim());
}

function isAcknowledgement(text) {
  return /^(yes|yeah|yep|yup|y|ok|okay|sure|hi|hello|hey|k)[.!]?$/i.test(String(text || '').trim());
}

function isPriceOnly(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 48) return false;
  return (
    /^\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t) ||
    /^\$?\d{4,7}$/.test(t) ||
    /^(?:asking|price|want|need)?\s*\$?\d{2,3}\s?k[.!]?$/i.test(t) ||
    /^\$\s?\d+[.!]?$/.test(t)
  );
}

function disqualifyReason(text) {
  if (isOptOutMessage(text)) return 'opt_out';
  if (isWrongNumber(text)) return 'wrong_number';
  if (isNotInterested(text)) return 'not_interested';
  return null;
}

function findSentence(blob, pattern) {
  const parts = String(blob || '')
    .split(/[\n.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = parts.find((s) => pattern.test(s));
  return hit || '';
}

function extractAddress(blob, conversation) {
  const stored = conversation && conversation.property_address && String(conversation.property_address).trim();
  if (stored) return stored;
  const match = String(blob || '').match(
    /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Way|Court|Ct|Circle|Cir|Place|Pl)\b\.?/i
  );
  return match ? match[0].replace(/\.$/, '') : '';
}

function extractPrice(blob) {
  const match = String(blob || '').match(/\$\s?\d{1,3}(?:,\d{3})+|\b\d{2,3}\s?k\b|\$\s?\d{4,7}|\b\d{5,7}\b/i);
  return match ? match[0] : '';
}

function summarize(messages, conversation) {
  const blob = inboundBodies(messages).join('\n');
  const address = extractAddress(blob, conversation) || 'not given';
  const condition =
    findSentence(blob, /\b(condition|repair|repairs|roof|foundation|as-is|as is|fixer|needs work|good shape|updated|remodel|kitchen|bath|hvac|plumbing)\b/i) ||
    'not given';
  const timeline =
    findSentence(blob, /\b(day|days|week|weeks|month|months|asap|timeline|closing|close|move|moving|soon)\b/i) ||
    'not given';
  const motivation =
    findSentence(blob, /\b(divorc|inherit|probate|relocat|behind|foreclos|tired|landlord|tax|downsiz|vacant|empty|job|estate|moving)\b/i) ||
    'not given';
  const asking = extractPrice(blob) || 'not given';
  return {
    address,
    condition,
    timeline,
    motivation,
    askingPrice: asking,
    phone: toE164((conversation && conversation.phone) || ''),
    name: (conversation && conversation.contact_name) || '',
  };
}

function assessOfferReady(messages, conversation) {
  const bodies = inboundBodies(messages);
  const latest = latestInbound(messages);
  const blocked = disqualifyReason(latest);
  if (blocked) return { ready: false, reason: blocked, summary: summarize(messages, conversation) };

  if (bodies.some((b) => isOptOutMessage(b))) {
    return { ready: false, reason: 'opt_out', summary: summarize(messages, conversation) };
  }

  const substantive = bodies.filter((b) => b && !isAcknowledgement(b) && !isPriceOnly(b));
  const onlyYes = bodies.length > 0 && substantive.length === 0 && bodies.every((b) => isAcknowledgement(b) || isPriceOnly(b));
  const onlyPrice = bodies.length > 0 && bodies.every((b) => isPriceOnly(b));
  if (onlyYes) return { ready: false, reason: 'only_acknowledgement', summary: summarize(messages, conversation) };
  if (onlyPrice) return { ready: false, reason: 'price_only', summary: summarize(messages, conversation) };

  // A real back-and-forth: more than one reply from the seller, and something besides "yes" or a bare price.
  if (bodies.length < 2 || substantive.length < 1) {
    return { ready: false, reason: 'not_enough_conversation', summary: summarize(messages, conversation) };
  }

  const blob = bodies.join('\n');
  const summary = summarize(messages, conversation);
  const wantsOffer = /\b(want(?:\s+\w+){0,4}\s+offer|make (?:me )?an offer|cash offer|interested in (?:selling|an offer)|want to sell|looking to sell|i(?:'d| would) like to sell|sell (?:my|the) (?:house|home|property)|ready to sell|send (?:me )?an offer)\b/i.test(
    blob
  );
  const hasAddress = summary.address !== 'not given';
  const detailCount = ['condition', 'timeline', 'motivation', 'askingPrice'].filter((k) => summary[k] !== 'not given').length;
  const engaged = wantsOffer || (hasAddress && detailCount >= 1) || detailCount >= 2;

  return {
    ready: engaged,
    reason: engaged ? 'offer_ready' : 'not_enough_detail',
    summary,
  };
}

function buildNote(summary, messages) {
  const lines = (messages || []).map((m) => {
    const who = m.direction === 'inbound' ? 'Lead' : 'Assistant';
    return `${who}: ${String(m.body || '').trim()}`;
  });
  const transcript = lines.join('\n').slice(0, 6000);
  return [
    'SMS offer-ready lead. Derek should follow up. No price was quoted by text.',
    '',
    `Property address: ${summary.address}`,
    `Condition: ${summary.condition}`,
    `Timeline: ${summary.timeline}`,
    `Motivation: ${summary.motivation}`,
    `Asking price: ${summary.askingPrice}`,
    `Phone: ${summary.phone || 'not given'}`,
    `Name: ${summary.name || 'not given'}`,
    '',
    'Transcript:',
    transcript,
  ].join('\n');
}

function noteFingerprint(messages) {
  const crypto = require('crypto');
  const raw = (messages || []).map((m) => `${m.direction}:${m.body}`).join('\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = {
  assessOfferReady,
  summarize,
  buildNote,
  noteFingerprint,
  isAcknowledgement,
  isPriceOnly,
  disqualifyReason,
};
