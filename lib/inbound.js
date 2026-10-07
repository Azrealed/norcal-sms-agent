const {
  isSuppressed,
  isAutoReplyAllowed,
  isOptOutMessage,
  isResubscribeMessage,
  isWrongNumber,
  isClearNo,
  isPositiveSignal,
} = require('./policy');
const { isIdentityQuestion, isWhoQuestion, HONEST_REPLY, WHO_REPLY } = require('./persona');

/**
 * Decide what the webhook should do. Sending and CRM calls happen outside this function.
 */
/**
 * True when the seller already showed interest earlier in this conversation (or is in GHL).
 * Then a later "No" is usually an answer to a qualifying question, not a not-interested reply.
 */
function hasPriorInterest(priorInboundBodies = [], { inGhl = false } = {}) {
  if (inGhl) return true;
  return priorInboundBodies.some((b) => isPositiveSignal(b));
}

function planInbound({ phone, message, env = process.env, optedOut = false, priorInterest = false, archived = false }) {
  if (isSuppressed(phone, env)) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, reason: 'suppressed' };
  }

  if (isOptOutMessage(message)) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: true, clearOptOut: false, archive: true, reason: 'opt_out' };
  }

  if (optedOut && isResubscribeMessage(message)) {
    const allowed = isAutoReplyAllowed(phone, env);
    return {
      store: true,
      send: false,
      replyMode: 'none',
      ghl: false,
      optOut: false,
      clearOptOut: true,
      reason: allowed ? 'resubscribed' : 'resubscribed_test_mode',
    };
  }

  if (optedOut) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, archive: true, reason: 'already_opted_out' };
  }

  // "My name is not Brett, but yes I would" is still a seller. Only stay silent when there's no yes.
  const positive = /\b(yes|yeah|yep|sure|i would|i'd|interested|sell|offer)\b/i.test(String(message || ''));
  if (isWrongNumber(message) && !positive) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: true, clearOptOut: false, archive: true, reason: 'wrong_number' };
  }

  // A clear "no" gets nothing back: no closer, no follow-up question, no CRM push.
  if (isClearNo(message) && !priorInterest && !isIdentityQuestion(message) && !isWhoQuestion(message)) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, archive: true, reason: 'not_interested' };
  }

  // An archived "no" stays archived and silent until they say something positive (or ask who this is).
  let unarchive = false;
  if (archived) {
    if (isPositiveSignal(message) || isIdentityQuestion(message) || isWhoQuestion(message)) {
      unarchive = true;
    } else {
      return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, archive: true, reason: 'archived_no' };
    }
  }

  if (!isAutoReplyAllowed(phone, env)) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, unarchive, reason: 'test_mode' };
  }

  if (isIdentityQuestion(message)) {
    return {
      store: true,
      send: true,
      replyMode: 'fixed',
      fixedReply: HONEST_REPLY,
      ghl: true,
      optOut: false,
      clearOptOut: false,
      unarchive,
      reason: 'identity',
    };
  }

  if (isWhoQuestion(message)) {
    return {
      store: true,
      send: true,
      replyMode: 'fixed',
      fixedReply: WHO_REPLY,
      ghl: true,
      optOut: false,
      clearOptOut: false,
      unarchive,
      reason: 'who',
    };
  }

  return {
    store: true,
    send: true,
    replyMode: 'model',
    fixedReply: null,
    ghl: true,
    optOut: false,
    clearOptOut: false,
    unarchive,
    reason: 'ai',
  };
}

module.exports = { planInbound, hasPriorInterest };
