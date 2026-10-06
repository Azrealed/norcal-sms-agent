/** Phone helpers. Compare US numbers even when formatting differs. */

function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function national10(phone) {
  const d = digits(phone);
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  if (d.length === 10) return d;
  return d;
}

function phonesMatch(a, b) {
  const na = national10(a);
  const nb = national10(b);
  if (!na || !nb) return false;
  return na === nb;
}

function toE164(phone) {
  const d = digits(phone);
  if (!d) return '';
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return `+${d}`;
}

function parsePhoneList(value) {
  return String(value || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { digits, phonesMatch, toE164, parsePhoneList };
