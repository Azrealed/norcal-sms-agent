const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { syncKnowledgeBase, CANONICAL_KB } = require('../lib/knowledge');

test('sync rewrites old promises and can be run twice', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO knowledge_base (question, answer, category) VALUES (?, ?, ?)').run(
    'How fast can you close?',
    'We can close in as little as 7-14 days, or we can work around YOUR timeline.',
    'process'
  );
  db.prepare('INSERT INTO knowledge_base (question, answer, category) VALUES (?, ?, ?)').run(
    'Do you pay closing costs?',
    'Yes! We cover all closing costs. No fees. The price we offer is what you walk away with.',
    'process'
  );
  db.prepare('INSERT INTO knowledge_base (question, answer, category) VALUES (?, ?, ?)').run(
    'Custom: BBB',
    'We are BBB accredited and have great reviews from sellers.',
    'trust'
  );

  const first = syncKnowledgeBase(db);
  assert.equal(first.upserted, CANONICAL_KB.length);
  assert.ok(first.deactivated.includes('Custom: BBB'));

  const close = db.prepare("SELECT answer, active FROM knowledge_base WHERE question = 'How fast can you close?'").get();
  assert.match(close.answer, /as little as 7 days/);
  assert.doesNotMatch(close.answer, /7-14/);
  assert.equal(close.active, 1);

  const costs = db.prepare("SELECT answer FROM knowledge_base WHERE question = 'Do you pay closing costs?'").get();
  assert.match(costs.answer, /talk through closing costs/);
  assert.doesNotMatch(costs.answer, /cover all closing|no fees|walk away/i);

  const bbb = db.prepare("SELECT active FROM knowledge_base WHERE question = 'Custom: BBB'").get();
  assert.equal(bbb.active, 0);

  const bot = db.prepare("SELECT answer FROM knowledge_base WHERE question = 'Are you a bot?'").get();
  assert.match(bot.answer, /AI assistant/);

  const second = syncKnowledgeBase(db);
  assert.equal(second.deactivated.length, 0);
  const count = db.prepare("SELECT COUNT(*) AS n FROM knowledge_base WHERE question = 'Are you a bot?'").get();
  assert.equal(count.n, 1);
  db.close();
});
