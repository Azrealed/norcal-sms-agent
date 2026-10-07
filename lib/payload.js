/**
 * Normalize webhook bodies from smsblast.io (nested `contact` shape) and older flat shapes.
 * Returns { event, fromPhone, toPhone, message, sid, actionable }.
 * Only inbound message events are actionable. Lead-marking and status events are logged only.
 */
function str(v) {
  return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '');
}

function normalizeInboundPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const data = b.data && typeof b.data === 'object' ? b.data : {};
  const contact = (b.contact && typeof b.contact === 'object' ? b.contact : null) ||
    (data.contact && typeof data.contact === 'object' ? data.contact : {}) || {};
  const msgObj = (b.message && typeof b.message === 'object' ? b.message : null) ||
    (data.message && typeof data.message === 'object' ? data.message : {}) || {};
  const event = str(b.event || b.type || b.event_type || data.event || data.type);

  const fromPhone = str(b.from) || str(b.From) || str(b.fromNumber) || str(b.phone) ||
    str(msgObj.fromNumber) || str(msgObj.from) || str(data.from) || str(data.fromNumber) ||
    str(contact.phone) || str(contact.phoneNumber) || '';
  const toPhone = str(b.to) || str(b.To) || str(b.toNumber) || str(msgObj.toNumber) || str(msgObj.to) ||
    str(data.to) || str(data.toNumber) || '';

  let message = str(b.message) || str(b.Body) || str(b.body) || str(b.text) ||
    str(msgObj.body) || str(msgObj.text) || str(msgObj.message) ||
    str(data.body) || str(data.text) || str(data.message) || '';

  const sid = str(b.messageSid) || str(b.MessageSid) || str(b.id) || str(msgObj.id) || str(msgObj.messageSid) || str(data.id) || '';

  const ev = event.toLowerCase();
  const direction = str(msgObj.direction || b.direction || data.direction).toLowerCase();
  const nonMessageEvent = ev && !/(inbound|received|reply|incoming)/.test(ev) && /(lead|status|delivered|sent|outbound|opt)/.test(ev);
  const outbound = direction === 'outbound';

  // Lead-marking events carry conversation history; never treat them as a new inbound text.
  if (!message && Array.isArray(b.conversationHistory)) message = '';

  const contactName = [str(contact.firstName), str(contact.lastName)].filter(Boolean).join(' ').trim();
  const contactAddress = [str(contact.address), str(contact.city)].filter(Boolean).join(', ').trim();

  return {
    contactName,
    contactAddress,
    event,
    fromPhone,
    toPhone,
    message,
    sid,
    actionable: !nonMessageEvent && !outbound && !!fromPhone && !!message,
  };
}

module.exports = { normalizeInboundPayload };
