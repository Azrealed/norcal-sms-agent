#!/usr/bin/env node
/**
 * Update the SQLite knowledge base in place.
 * Safe to run more than once. Does not delete custom entries unless
 * their text still makes a promise this bot is not allowed to make.
 *
 * Usage: node scripts/update-kb-facts.js [path-to-sms-agent.db]
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { syncKnowledgeBase } = require('../lib/knowledge');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'sms-agent.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

const result = syncKnowledgeBase(db);
console.log(`Updated ${result.upserted} standard answers in ${dbPath}`);
if (result.deactivated.length) {
  console.log('Turned off older answers that still had promises we no longer make:');
  for (const question of result.deactivated) console.log(` - ${question}`);
} else {
  console.log('No older answers needed to be turned off.');
}
db.close();
