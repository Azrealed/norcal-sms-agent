// Update the knowledge base in place. Safe to run more than once.

function seedKnowledgeBase(db) {
  const { syncKnowledgeBase } = require('./lib/knowledge');
  const result = syncKnowledgeBase(db);
  console.log('Knowledge base synced: ' + result.upserted + ' standard answers');
  if (result.deactivated.length) {
    console.log('Turned off outdated answers: ' + result.deactivated.join(' | '));
  }
  return result;
}

if (require.main === module) {
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');
  const DB_PATH = path.join(__dirname, 'data');
  if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
  const db = new Database(path.join(DB_PATH, 'sms-agent.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  seedKnowledgeBase(db);
  db.close();
}

module.exports = { seedKnowledgeBase };
