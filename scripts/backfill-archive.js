#!/usr/bin/env node
/**
 * One-off backfill for the archive / opt-out rules. Runs inside the app container.
 *   node scripts/backfill-archive.js dump
 *       Prints conversations that have inbound messages, plus opt-out rows (read-only).
 *   node scripts/backfill-archive.js apply --archive-no 1,2 --optout 3,4
 *       --archive-no: set status='archived' (not opted out).
 *       --optout: make sure the number is on the bot opt-out list, call smsblast opt-out, archive.
 * Skips conversations with ai_enabled=0 or already in GHL. Never deletes anything. Sends no texts.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { toE164, phonesMatch } = require('../lib/phones');
const { isWrongNumber } = require('../lib/policy');
const { smsblastOptOut } = require('../lib/smsblast-optout');

const db = new Database(path.join(__dirname, '..', 'data', 'sms-agent.db'));
for (const [col, def] of [['smsblast_status', 'TEXT DEFAULT NULL'], ['smsblast_synced_at', 'TEXT DEFAULT NULL']]) {
  try { db.exec(`ALTER TABLE opt_outs ADD COLUMN ${col} ${def}`); } catch (e) { /* exists */ }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) return [];
  return process.argv[i + 1].split(',').map((x) => Number(x.trim())).filter(Boolean);
}

function dump() {
  const convs = db.prepare('SELECT * FROM conversations').all();
  const out = [];
  for (const c of convs) {
    const msgs = db.prepare('SELECT direction, body, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC, id ASC').all(c.id);
    if (!msgs.some((m) => m.direction === 'inbound')) continue;
    out.push({
      id: c.id, phone: c.phone, name: c.contact_name, status: c.status, label: c.label, ai_enabled: c.ai_enabled,
      ghl: !!(c.ghl_contact_id || c.crm_pushed), msgs,
    });
  }
  const optOuts = db.prepare('SELECT * FROM opt_outs').all();
  console.log(JSON.stringify({ conversations: out, opt_outs: optOuts }));
}

async function apply() {
  const results = [];
  const guard = (c) => {
    if (!c) return 'missing';
    if (!c.ai_enabled) return 'skip_ai_off';
    if (c.ghl_contact_id || c.crm_pushed) return 'skip_in_ghl';
    return null;
  };
  for (const id of arg('--archive-no')) {
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    const g = guard(c);
    if (g) { results.push({ id, action: g }); continue; }
    db.prepare("UPDATE conversations SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(id);
    results.push({ id, phone: c.phone, action: 'archived_no' });
  }
  const key = process.env.SMSBLAST_API_KEY;
  for (const id of arg('--optout')) {
    const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    const g = guard(c);
    if (g) { results.push({ id, action: g }); continue; }
    const e164 = toE164(c.phone) || c.phone;
    let row = db.prepare('SELECT * FROM opt_outs').all().find((r) => phonesMatch(r.phone, c.phone));
    let added = false;
    if (!row) {
      const last = db.prepare("SELECT body FROM messages WHERE conversation_id = ? AND direction = 'inbound' ORDER BY timestamp DESC, id DESC LIMIT 1").get(id);
      const reason = last && isWrongNumber(last.body) ? 'wrong_number' : 'keyword_stop';
      db.prepare('INSERT OR IGNORE INTO opt_outs (phone, reason) VALUES (?, ?)').run(e164, reason);
      row = db.prepare('SELECT * FROM opt_outs WHERE phone = ?').get(e164);
      added = true;
    }
    const r = await smsblastOptOut(e164, { apiKey: key });
    db.prepare("UPDATE opt_outs SET smsblast_status = ?, smsblast_synced_at = datetime('now') WHERE id = ?").run(r.status, row.id);
    db.prepare("UPDATE conversations SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(id);
    results.push({ id, phone: e164, action: 'opted_out_archived', bot_row_added: added, smsblast: r.status });
    await new Promise((res) => setTimeout(res, 300));
  }
  console.log(JSON.stringify(results));
}

const cmd = process.argv[2];
if (cmd === 'dump') dump();
else if (cmd === 'apply') apply().catch((e) => { console.error(e.message); process.exit(1); });
else { console.error('usage: dump | apply --archive-no ids --optout ids'); process.exit(2); }
