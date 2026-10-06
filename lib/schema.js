function ensureConversationColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name));
  const add = [
    ['notes', "TEXT DEFAULT ''"],
    ['ghl_contact_id', "TEXT DEFAULT ''"],
    ['ghl_opportunity_id', "TEXT DEFAULT ''"],
    ['ghl_note_fingerprint', "TEXT DEFAULT ''"],
    ['ghl_pushed_at', "TEXT DEFAULT ''"],
  ];
  for (const [name, type] of add) {
    if (!cols.has(name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`);
  }
}

module.exports = { ensureConversationColumns };
