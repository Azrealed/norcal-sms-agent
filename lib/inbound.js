const {
  isSuppressed,
  isAutoReplyAllowed,
  isOptOutMessage,
  isResubscribeMessage,
  isWrongNumber,
  isClearNo,
} = require('./policy');
const { isIdentityQuestion, isWhoQuestion, HONEST_REPLY, WHO_REPLY } = require('./persona');

/**
 * Decide what the webhook should do. Sending and CRM calls happen outside this function.
 */
function planInbound({ phone, message, env = process.env, optedOut = false }) {
  if (isSuppressed(phone, env)) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, reason: 'suppressed' };
  }

  if (isOptOutMessage(message)) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: true, clearOptOut: false, reason: 'opt_out' };
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
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, reason: 'already_opted_out' };
  }

  // "My name is not Brett, but yes I would" is still a seller. Only stay silent when there's no yes.
  const positive = /\b(yes|yeah|yep|sure|i would|i'd|interested|sell|offer)\b/i.test(String(message || ''));
  if (isWrongNumber(message) && !positive) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: true, clearOptOut: false, reason: 'wrong_number' };
  }

  // A clear "no" gets nothing back: no closer, no follow-up question, no CRM push.
  if (isClearNo(message) && !isIdentityQuestion(message) && !isWhoQuestion(message)) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, reason: 'not_interested' };
  }

  if (!isAutoReplyAllowed(phone, env)) {
    return { store: true, send: false, replyMode: 'none', ghl: false, optOut: false, clearOptOut: false, reason: 'test_mode' };
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
    reason: 'ai',
  };
}

module.exports = { planInbound };
