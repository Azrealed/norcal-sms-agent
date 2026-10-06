const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { syncKnowledgeBase } = require('./lib/knowledge');

const DB_PATH = path.join(__dirname, 'data');
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
const db = new Database(path.join(DB_PATH, 'sms-agent.db'));
db.pragma('journal_mode = WAL');

// Create tables (same as server.js)
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, contact_name TEXT DEFAULT '',
    property_address TEXT DEFAULT '', lead_source TEXT DEFAULT '',
    last_message TEXT DEFAULT '', last_message_time TEXT DEFAULT '',
    unread_count INTEGER DEFAULT 0, ai_enabled INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active', label TEXT DEFAULT 'new', notes TEXT DEFAULT '',
    ghl_contact_id TEXT DEFAULT '', ghl_opportunity_id TEXT DEFAULT '',
    ghl_note_fingerprint TEXT DEFAULT '', ghl_pushed_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
    body TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    from_number TEXT, to_number TEXT, timestamp TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'sent', smsblast_sid TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );
  CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer TEXT NOT NULL,
    category TEXT DEFAULT 'general', active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS opt_outs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE,
    reason TEXT DEFAULT 'user_request', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const result = syncKnowledgeBase(db);
console.log('Knowledge base synced: ' + result.upserted + ' standard answers');
if (result.deactivated.length) {
  console.log('Turned off outdated answers: ' + result.deactivated.join(' | '));
}
db.close();
