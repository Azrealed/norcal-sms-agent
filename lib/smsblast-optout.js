/**
 * smsblast opt-out: POST https://app.smsblast.io/api/v2/contacts/opt-out {"number":"+1..."}
 * Idempotent. 404 means smsblast has no contact with that number.
 * Returns { ok, status } where status is opted_out | already_opted_out | not_found | error_<code>.
 * Never logs the API key.
 */
const SMSBLAST_OPTOUT_URL = 'https://app.smsblast.io/api/v2/contacts/opt-out';

async function smsblastOptOut(number, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) return { ok: false, status: 'error_no_api_key' };
  try {
    const resp = await fetchImpl(SMSBLAST_OPTOUT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number }),
    });
    let data = {};
    try { data = await resp.json(); } catch (_) { /* empty body */ }
    if (resp.status === 404) return { ok: false, status: 'not_found' };
    if (!resp.ok || data.success === false) return { ok: false, status: `error_${resp.status}` };
    return { ok: true, status: data.alreadyOptedOut ? 'already_opted_out' : 'opted_out' };
  } catch (err) {
    return { ok: false, status: 'error_network' };
  }
}

module.exports = { smsblastOptOut, SMSBLAST_OPTOUT_URL };
