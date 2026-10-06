const {
  isSuppressed,
  isAutoReplyAllowed,
  isOptOutMessage,
  isResubscribeMessage,
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
