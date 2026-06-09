// NorCal AI SMS Agent
// Express + SQLite + smsblast.io + DeepSeek
// Standalone SaaS - not dependent on Base44

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const SqliteStoreFactory = require('better-sqlite3-session-store');
const SqliteStore = SqliteStoreFactory(session);
const path = require('path');
const fs = require('fs');

// ── Config ──

// Webhook: delivery status from smsblast.io
const PORT = process.env.PORT || 8080;
const SMSBLAST_API_KEY = process.env.SMSBLAST_API_KEY;
const SMSBLAST_FROM = process.env.SMSBLAST_FROM_NUMBER || '+18884645732';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-chat';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

// ── Database Setup ──
const DB_PATH = path.join(__dirname, 'data');
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
const db = new Database(path.join(DB_PATH, 'sms-agent.db'));
db.pragma('journal_mode = WAL');

// Init tables
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    property_address TEXT DEFAULT '',
    lead_source TEXT DEFAULT '',
    last_message TEXT DEFAULT '',
    last_message_time TEXT DEFAULT '',
    unread_count INTEGER DEFAULT 0,
    ai_enabled INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    label TEXT DEFAULT 'new',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    from_number TEXT,
    to_number TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'sent',
    smsblast_sid TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS opt_outs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    reason TEXT DEFAULT 'user_request',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(timestamp);
`);

// ── Express App ──
const app = express();

app.post('/webhook/status', (req, res) => {
  try {
    const { message_id, status, to, error } = req.body;
    console.log('Delivery status:', message_id, status, to, error || '');
    if (message_id) {
      const stmt = db.prepare('UPDATE messages SET status = ? WHERE smsblast_sid = ?');
      stmt.run(status || 'unknown', message_id);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Status webhook error:', e);
    res.json({ success: true });
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
  store: new SqliteStore({ client: db })
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Middleware ──
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

// ── Helpers ──

/** Send SMS via smsblast.io API */
async function sendSmsblast(phone, message) {
  const url = 'https://api.smsblast.io/api/v2/sms/send'; // endpoint from your API docs
  const body = {
    apiKey: SMSBLAST_API_KEY,
    to: phone,
    from: SMSBLAST_FROM,
    message: message
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error(`[SMS Error] ${resp.status}: ${JSON.stringify(data)}`);
      return { success: false, error: data.message || 'SMS failed' };
    }
    return { success: true, data };
  } catch (err) {
    console.error(`[SMS Error] ${err.message}`);
    return { success: false, error: err.message };
  }
}

/** Query DeepSeek via OpenRouter for an AI reply */
async function getAiReply(conversation, messages, contactName) {
  if (!OPENROUTER_API_KEY) {
    return "I'm not available to respond right now, but someone from our team will get back to you shortly.";
  }

  const kb = db.prepare('SELECT question, answer FROM knowledge_base WHERE active = 1').all();
  const knowledgeContext = kb.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');

  const systemPrompt = `You are an AI SMS assistant for NorCal Home Offer, a real estate wholesaling company in Northern California. You help respond to homeowners who may be interested in selling their property.

Your tone is professional, friendly, and direct. Keep responses CONCISE — SMS messages should be 1-3 short paragraphs max. No markdown, no emojis, just plain text.

Key points about the business:
- We make CASH offers for houses
- No repairs needed — we buy AS-IS
- Close on the homeowner's timeline
- We cover all closing costs
- We buy in Sacramento, Yolo, Placer, El Dorado, and surrounding counties

${knowledgeContext}

Rules:
- Be helpful but don't make specific price promises
- If they ask about price or offers, give general info and say someone will follow up
- If they seem serious, encourage them to reply with their property address
- NEVER share internal business information
- If they ask something you don't know, say "Let me have Derek reach out to you directly about that"
- If they text STOP/UNSUBSCRIBE/CANCEL — do not try to convince them, just acknowledge`;

  // Build context from conversation history (last 10 messages)
  const recentMessages = messages.slice(-10).map(m =>
    `${m.direction === 'inbound' ? 'Lead' : 'Agent'}: ${m.body}`
  ).join('\n');

  const userPrompt = `Conversation with ${contactName || 'a lead'}:\n${recentMessages}\n\nWrite a brief SMS reply:`;

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 300,
        temperature: 0.7
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error(`[AI Error] ${resp.status}: ${JSON.stringify(data)}`);
      return null;
    }
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error(`[AI Error] ${err.message}`);
    return null;
  }
}

/** Check if a phone is opted out */
function isOptedOut(phone) {
  const row = db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(phone);
  return !!row;
}

// ── SMEBLAST INBOUND WEBHOOK ──
// smsblast.io calls this URL when a contact sends an inbound message
app.post('/webhook/inbound', async (req, res) => {
  const body = req.body;
  console.log(`[Inbound] ${JSON.stringify(body)}`);

  // smsblast.io payload — normalize the fields
  const fromPhone = body.from || body.From || body.phone || '';
  const toPhone = body.to || body.To || SMSBLAST_FROM;
  const message = body.message || body.Body || body.text || '';
  const sid = body.messageSid || body.MessageSid || body.id || '';

  if (!fromPhone || !message) {
    console.error('[Inbound] Missing from or message');
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Check opt-out
  if (isOptedOut(fromPhone)) {
    console.log(`[OptOut] ${fromPhone} is opted out, ignoring`);
    return res.json({ handled: true, reply: null });
  }

  // Check for opt-out keywords
  const upperMsg = message.toUpperCase().trim();
  if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'STOPALL', 'REMOVE'].includes(upperMsg)) {
    db.prepare('INSERT OR IGNORE INTO opt_outs (phone, reason) VALUES (?, ?)').run(fromPhone, 'keyword_stop');
    console.log(`[OptOut] ${fromPhone} opted out via keyword`);
    // Auto-reply with confirmation
    await sendSmsblast(fromPhone, "You've been unsubscribed. No more messages from NorCal Home Offer. Reply START to resubscribe.");
    return res.json({ handled: true, reply: 'optout_confirmed' });
  }

  // Check for re-subscribe
  if (['START', 'YES', 'UNSTOP'].includes(upperMsg)) {
    db.prepare('DELETE FROM opt_outs WHERE phone = ?').run(fromPhone);
    console.log(`[OptOut] ${fromPhone} resubscribed`);
  }

  // Find or create conversation
  let conv = db.prepare('SELECT * FROM conversations WHERE phone = ?').get(fromPhone);
  let convId;

  if (conv) {
    convId = conv.id;
    db.prepare(`UPDATE conversations SET 
      last_message = ?, last_message_time = datetime('now'), 
      unread_count = unread_count + 1, updated_at = datetime('now') 
      WHERE id = ?`).run(message, convId);
  } else {
    const result = db.prepare(`INSERT INTO conversations 
      (phone, last_message, last_message_time, unread_count, ai_enabled, status)
      VALUES (?, ?, datetime('now'), 1, 1, 'active')`).run(fromPhone, message);
    convId = result.lastInsertRowid;
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  }

  // Store the inbound message
  db.prepare(`INSERT INTO messages (conversation_id, body, direction, from_number, to_number, status, smsblast_sid)
    VALUES (?, ?, 'inbound', ?, ?, 'received', ?)`).run(convId, message, fromPhone, toPhone, sid);

  let replyText = null;

  // If AI is enabled for this conversation, generate and send a reply
  if (conv.ai_enabled) {
    const recentMessages = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    ).all(convId);

    replyText = await getAiReply(conv, recentMessages, conv.contact_name);

    if (replyText) {
      const smsResult = await sendSmsblast(fromPhone, replyText);
      const smsStatus = smsResult.success ? 'sent' : 'failed';

      db.prepare(`INSERT INTO messages (conversation_id, body, direction, from_number, to_number, status)
        VALUES (?, ?, 'outbound', ?, ?, ?)`).run(convId, replyText, SMSBLAST_FROM, fromPhone, smsStatus);

      db.prepare(`UPDATE conversations SET 
        last_message = ?, last_message_time = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`).run(replyText, convId);
    }
  }

  // Respond to smsblast.io
  res.json({
    handled: true,
    conversation_id: convId,
    reply: replyText
  });
});

// ── DASHBOARD API ROUTES (all require auth) ──

// Auth
app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

app.post('/api/login', (req, res) => {
  const rememberMe = req.body.rememberMe === true;
  if (rememberMe) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  } else {
    req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000;
  }
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Conversations
app.get('/api/conversations', requireAuth, (req, res) => {
  const { status, label, search } = req.query;
  let sql = 'SELECT * FROM conversations WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (label) { sql += ' AND label = ?'; params.push(label); }
  if (search) { sql += ' AND (phone LIKE ? OR contact_name LIKE ? OR property_address LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  sql += ' ORDER BY updated_at DESC';
  const convs = db.prepare(sql).all(...params);
  res.json(convs);
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(req.params.id);
  res.json({ ...conv, messages });
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const { contact_name, property_address, lead_source, ai_enabled, status, label, notes } = req.body;
  const updates = [];
  const params = [];
  if (contact_name !== undefined) { updates.push('contact_name = ?'); params.push(contact_name); }
  if (property_address !== undefined) { updates.push('property_address = ?'); params.push(property_address); }
  if (lead_source !== undefined) { updates.push('lead_source = ?'); params.push(lead_source); }
  if (ai_enabled !== undefined) { updates.push('ai_enabled = ?'); params.push(ai_enabled ? 1 : 0); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (label !== undefined) { updates.push('label = ?'); params.push(label); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  res.json(conv);
});

// Send a manual reply
app.post('/api/conversations/:id/reply', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const smsResult = await sendSmsblast(conv.phone, message);
  const status = smsResult.success ? 'sent' : 'failed';

  const result = db.prepare(`INSERT INTO messages (conversation_id, body, direction, from_number, to_number, status)
    VALUES (?, ?, 'outbound', ?, ?, ?)`).run(req.params.id, message, SMSBLAST_FROM, conv.phone, status);

  db.prepare(`UPDATE conversations SET 
    last_message = ?, last_message_time = datetime('now'), 
    unread_count = 0, updated_at = datetime('now')
    WHERE id = ?`).run(message, req.params.id);

  res.json({
    success: smsResult.success,
    message_id: result.lastInsertRowid,
    status,
    error: smsResult.error || null
  });
});

// Knowledge Base
app.get('/api/knowledge-base', requireAuth, (req, res) => {
  const kb = db.prepare('SELECT * FROM knowledge_base WHERE active = 1 ORDER BY category, id').all();
  res.json(kb);
});

app.post('/api/knowledge-base', requireAuth, (req, res) => {
  const { question, answer, category } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer required' });
  const result = db.prepare('INSERT INTO knowledge_base (question, answer, category) VALUES (?, ?, ?)').run(question, answer, category || 'general');
  const kb = db.prepare('SELECT * FROM knowledge_base WHERE id = ?').get(result.lastInsertRowid);
  res.json(kb);
});

app.put('/api/knowledge-base/:id', requireAuth, (req, res) => {
  const { question, answer, category, active } = req.body;
  const updates = []; const params = [];
  if (question !== undefined) { updates.push('question = ?'); params.push(question); }
  if (answer !== undefined) { updates.push('answer = ?'); params.push(answer); }
  if (category !== undefined) { updates.push('category = ?'); params.push(category); }
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  params.push(req.params.id);
  db.prepare(`UPDATE knowledge_base SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM knowledge_base WHERE id = ?').get(req.params.id));
});

app.delete('/api/knowledge-base/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Opt-Outs
app.get('/api/opt-outs', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM opt_outs ORDER BY created_at DESC').all());
});

app.delete('/api/opt-outs/:id', requireAuth, (req, res) => {
  const row = db.prepare('DELETE FROM opt_outs WHERE id = ?').run(req.params.id);
  res.json({ success: row.changes > 0 });
});

// Stats
app.get('/api/stats', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
  const active = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE status = 'active'").get();
  const unread = db.prepare('SELECT SUM(unread_count) as count FROM conversations').get();
  const todayMsgs = db.prepare("SELECT COUNT(*) as count FROM messages WHERE date(timestamp) = date('now')").get();
  const aiEnabled = db.prepare('SELECT COUNT(*) as count FROM conversations WHERE ai_enabled = 1').get();
  const optOuts = db.prepare('SELECT COUNT(*) as count FROM opt_outs').get();
  res.json({
    total_conversations: total.count,
    active_conversations: active.count,
    total_unread: unread.count || 0,
    messages_today: todayMsgs.count,
    ai_enabled: aiEnabled.count,
    opt_outs: optOuts.count
  });
});

// Settings
app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { key, value } = req.body;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  res.json({ success: true });
});

// Global toggle: AI on/off for all conversations
app.post('/api/ai-toggle-all', requireAuth, (req, res) => {
  const { enabled } = req.body;
  db.prepare('UPDATE conversations SET ai_enabled = ?, updated_at = datetime(\'now\')').run(enabled ? 1 : 0);
  res.json({ success: true, ai_enabled: !!enabled });
});

// Login page redirect — SPA handles it
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Catch-all: serve dashboard SPA
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.path.startsWith('/webhook/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📋 NorCal AI SMS Agent`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Webhook:   http://localhost:${PORT}/webhook/inbound`);
  console.log(`   SMS API:   smsblast.io (via API key)`);
  console.log(`   AI Model:  ${AI_MODEL}\n`);
});
