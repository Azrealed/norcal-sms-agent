// NorCal AI SMS Agent
// Express + SQLite + smsblast.io + DeepSeek
// Standalone SaaS - not dependent on Base44

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { extractPropertyInfo, determineStage, scoreMessage } = require('./lib/conversation');
const { phonesMatch, toE164 } = require('./lib/phones');
const { canSendSms, isSuppressed, isTestMode } = require('./lib/policy');
const { planInbound } = require('./lib/inbound');
const { normalizeInboundPayload } = require('./lib/payload');
const { buildSystemPrompt, composeReply, HONEST_REPLY, WHO_REPLY, isIdentityQuestion, isWhoQuestion, DEFAULT_DAILY_BLAST } = require('./lib/persona');
const { syncKnowledgeBase } = require('./lib/knowledge');
const { syncSellerToGhl } = require('./lib/ghl');
const { ensureConversationColumns } = require('./lib/schema');
const { assessOfferReady } = require('./lib/qualify');

// ── Config ──
const PORT = process.env.PORT || 8080;
const SMSBLAST_API_KEY = process.env.SMSBLAST_API_KEY;
const SMSBLAST_FROM = process.env.SMSBLAST_FROM_NUMBER || '+18884645732';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-chat';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://norcal-sms-agent.fly.dev';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.DASHBOARD_PASSWORD) {
  console.warn('[Auth] DASHBOARD_PASSWORD is not set. Dashboard login stays locked until it is set.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[Auth] SESSION_SECRET is not set. Using a temporary secret for this process only.');
}
const TRACERFY_API_KEY = process.env.TRACERFY_API_KEY;

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

  CREATE TABLE IF NOT EXISTS conversation_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    notes TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_notes_conv ON conversation_notes(conversation_id);
`);

// Migrate: add CRM columns to conversations if they don't exist
const crmCols = [
  ['lead_stage', "TEXT DEFAULT 'new'"],
  ['lead_address', 'TEXT DEFAULT \'\''],
  ['lead_asking_price', 'INTEGER DEFAULT 0'],
  ['lead_condition', 'TEXT DEFAULT \'\''],
  ['lead_motivation', 'TEXT DEFAULT \'\''],
  ['crm_pushed', 'INTEGER DEFAULT 0'],
  ['crm_pushed_at', 'TEXT DEFAULT NULL']
];
for (const [col, def] of crmCols) {
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN ${col} ${def}`);
    console.log(`Migrated: added column ${col}`);
  } catch (e) {
    // Column already exists — fine
  }
}

ensureConversationColumns(db);
try {
  const kbSync = syncKnowledgeBase(db);
  console.log(`[KB] synced ${kbSync.upserted} standard answers; turned off ${kbSync.deactivated.length} outdated answers`);
  if (kbSync.deactivated.length) console.log(`[KB] turned off: ${kbSync.deactivated.join(' | ')}`);
} catch (err) {
  console.error('[KB] sync failed, continuing with the existing knowledge base:', err.message);
}

// ── Express App ──
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
// Force no-cache on all responses to prevent stale CSS/JS on mobile
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
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

/** Send SMS via smsblast.io API. Suppressed and opted-out numbers are never texted. */
async function sendSmsblast(phone, message, { automated = false } = {}) {
  const gate = canSendSms(phone, { automated, env: process.env, optedOut: isOptedOut(phone) });
  if (!gate.ok) {
    console.log(`[SMS blocked] ${phone} (${gate.reason})`);
    return { success: false, blocked: true, error: gate.reason };
  }
  const url = 'https://app.smsblast.io/api/v2/sms/send';
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
/**
 * Generate an AI reply for any stage of the conversation.
 * Now used for ALL replies — not just post-qualification.
 * Context includes property details, lead stage, and previous messages
 * so the AI can have a natural, non-repetitive conversation.
 */
async function getAiReply(conversation, messages, contactName, leadContext = {}) {
  if (!OPENROUTER_API_KEY) {
    return "I'm not available to respond right now, but someone from our team will get back to you shortly.";
  }

  const kb = db.prepare('SELECT question, answer FROM knowledge_base WHERE active = 1').all();
  const knowledgeContext = kb.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');

  // Build lead state context for the AI
  const { stage, property, score, name } = leadContext;
  const hasAddress = !!(property?.address || conversation?.property_address);
  const addr = property?.address || conversation?.property_address || 'unknown';
  const askingPrice = property?.askingPrice ? `$${property.askingPrice.toLocaleString()}` : 'not yet discussed';
  const condition = property?.condition || 'not yet discussed';

  let stageGuidance = '';
  if (hasAddress) {
    // We already know the address — skip to pain points and motivation
    stageGuidance = `You ALREADY know the property address is ${addr}. Do NOT ask for it again. Work one question at a time toward: why they're selling now, what they want for it, and when. Don't fire off a list — pick the single most natural next question based on what they just said.`;
  } else {
    // Need to learn the address naturally
    stageGuidance = `You don't yet have the property address. Work it in naturally — first respond to why they reached out, then ask what area/zip they're in. One question at a time.`;
  }

  const systemPrompt = buildSystemPrompt(knowledgeContext, { stageGuidance });

  // Build conversation history
  const recentMessages = messages.slice(-15).map(m =>
    `${m.direction === 'inbound' ? 'Them' : 'You'}: ${m.body}`
  ).join('\n');

  // Track what was already said to prevent repetition
  const agentMessages = messages.filter(m => m.direction === 'outbound').slice(-3).map(m => m.body);
  const repeatWarning = agentMessages.length > 0
    ? `\n⚠️ Your last ${agentMessages.length > 1 ? 'few messages' : 'message'}: ${agentMessages.map(m => `"${m}"`).join(' | ')}. Say something DIFFERENT this time. Do not repeat.`
    : '';

  const userPrompt = `Lead name: ${contactName || name || 'unknown'}\nAddress known: ${hasAddress ? 'YES — ' + addr : 'NO — need to learn it'}\nAsking price discussed: ${askingPrice}\nCondition: ${condition}\nLead score: ${score || 0}/100\n\nConversation:\n${recentMessages}${repeatWarning}\n\nWrite your reply:`;

  // Primary model plus fallbacks. OpenRouter tries the next model when one is rate-limited or down.
  const models = [AI_MODEL, ...String(process.env.AI_FALLBACK_MODELS || 'openai/gpt-4o-mini,meta-llama/llama-3.3-70b-instruct')
    .split(',').map((m) => m.trim()).filter((m) => m && m !== AI_MODEL)];

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: models[0],
          models,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 180,
          temperature: 0.7
        })
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        const text = data.choices?.[0]?.message?.content?.trim() || null;
        if (text) {
          if (data.model && data.model !== AI_MODEL) console.log(`[AI] reply came from fallback model ${data.model}`);
          return text;
        }
        console.error(`[AI Error] empty reply (attempt ${attempt})`);
      } else {
        console.error(`[AI Error] ${resp.status} (attempt ${attempt}): ${JSON.stringify(data).slice(0, 300)}`);
        if (resp.status < 500 && resp.status !== 429) return null;
      }
    } catch (err) {
      console.error(`[AI Error] ${err.message} (attempt ${attempt})`);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/** Check if a phone is opted out, ignoring formatting differences. */
function isOptedOut(phone) {
  const rows = db.prepare('SELECT phone FROM opt_outs').all();
  return rows.some((row) => phonesMatch(row.phone, phone));
}

// ── SMSBLAST INBOUND WEBHOOK ──
// smsblast.io calls this URL when a contact sends an inbound message
// Handles both /webhook/ and /webhook/inbound paths
async function handleInboundWebhook(req, res) {
  const body = req.body;
  console.log(`[Inbound] ${JSON.stringify(body)}`);

  // smsblast.io payload — normalize the fields (nested contact/message or flat)
  const norm = normalizeInboundPayload(body);
  const fromPhone = norm.fromPhone;
  const toPhone = norm.toPhone || SMSBLAST_FROM;
  const message = norm.message;
  const sid = norm.sid;

  if (!norm.actionable) {
    if (norm.event) {
      console.log(`[Inbound] event "${norm.event}" logged only; no reply and no CRM push`);
      return res.json({ handled: true, reply: null, reason: 'not_an_inbound_message' });
    }
    console.error('[Inbound] Missing from or message');
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const plan = planInbound({
    phone: fromPhone,
    message,
    env: process.env,
    optedOut: isOptedOut(fromPhone),
  });

  if (plan.reason === 'already_opted_out') {
    console.log(`[OptOut] ${fromPhone} is opted out, ignoring`);
    return res.json({ handled: true, reply: null });
  }

  if (plan.optOut) {
    db.prepare('INSERT OR IGNORE INTO opt_outs (phone, reason) VALUES (?, ?)').run(toE164(fromPhone) || fromPhone, plan.reason === 'wrong_number' ? 'wrong_number' : 'keyword_stop');
    console.log(`[OptOut] ${fromPhone} opted out. No reply will be sent.`);
  }
  if (plan.clearOptOut) {
    const opted = db.prepare('SELECT id, phone FROM opt_outs').all();
    for (const row of opted) {
      if (phonesMatch(row.phone, fromPhone)) db.prepare('DELETE FROM opt_outs WHERE id = ?').run(row.id);
    }
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

  // Fill in the seller's name and property address from the smsblast contact when we don't have them yet
  if (norm.contactName && !conv.contact_name) {
    db.prepare('UPDATE conversations SET contact_name = ? WHERE id = ?').run(norm.contactName, convId);
    conv.contact_name = norm.contactName;
  }
  if (norm.contactAddress && !conv.property_address) {
    db.prepare('UPDATE conversations SET property_address = ? WHERE id = ?').run(norm.contactAddress, convId);
    conv.property_address = norm.contactAddress;
  }

  // Store the inbound message
  db.prepare(`INSERT INTO messages (conversation_id, body, direction, from_number, to_number, status, smsblast_sid)
    VALUES (?, ?, 'inbound', ?, ?, 'received', ?)`).run(convId, message, fromPhone, toPhone, sid);

  let replyText = null;

  if (!plan.send) {
    if (plan.reason === 'test_mode') console.log(`[TestMode] stored inbound from ${fromPhone}; AI reply skipped`);
    if (plan.reason === 'suppressed') console.log(`[Suppressed] stored inbound from ${fromPhone}; no text will be sent`);
    if (plan.reason === 'wrong_number') console.log(`[WrongNumber] ${fromPhone} marked do-not-text; no reply sent`);
    return res.json({ handled: true, conversation_id: convId, reply: null, reason: plan.reason });
  }

  // If AI is enabled for this conversation, generate and send a reply
  if (conv.ai_enabled) {
    const recentMessages = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    ).all(convId);

    // ── Lead Qualification Engine ──
    const state = getLeadState(fromPhone);
    
    // If the conversation already has a property address (from CSV blast), load it into lead state
    if (!state.property.address && conv.property_address) {
      state.property.address = conv.property_address;
    }
    if (!state.name && conv.contact_name) {
      state.name = conv.contact_name;
    }
    
    // If we already know the address, fast-forward past the address question
    if (state.property.address && state.stage === 'new') {
      state.stage = 'property_condition';
    }
    
    const extraction = extractPropertyInfo(message, state);
    const { stage, reason } = determineStage({ stage: state.stage, property: state.property, score: state.score }, message);
    const { points, reasons } = scoreMessage(message, { stage: state.stage, property: state.property, score: state.score });

    // Update lead state
    state.stage = stage;
    state.score += points;
    if (extraction.address) state.property.address = extraction.address;
    if (extraction.askingPrice) state.property.askingPrice = extraction.askingPrice;
    if (extraction.condition) state.property.condition = extraction.condition;
    state.history.push({ direction: 'inbound', text: message, time: new Date().toISOString() });

    // Update DB with extracted property info
    if (extraction.address) {
      db.prepare('UPDATE conversations SET property_address = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(extraction.address, convId);
    }

    // Update label based on score
    if (state.score >= 70 && conv.label !== 'hot') {
      db.prepare("UPDATE conversations SET label = 'hot', updated_at = datetime('now') WHERE id = ?").run(convId);
    } else if (state.score >= 40 && conv.label === 'new') {
      db.prepare("UPDATE conversations SET label = 'warm', updated_at = datetime('now') WHERE id = ?").run(convId);
    } else if (state.score <= -10 && conv.label !== 'cold') {
      db.prepare("UPDATE conversations SET label = 'cold', updated_at = datetime('now') WHERE id = ?").run(convId);
    }

    console.log(`[Lead] ${fromPhone} stage=${stage} score=${state.score} addr=${state.property.address || '?'} price=$${state.property.askingPrice || '?'} reason=${reason || ''}`);

    // ── Generate Reply (AI-driven for ALL stages) ──
    const allMessages = recentMessages; // already fetched above

    if (isIdentityQuestion(message)) {
      replyText = HONEST_REPLY;
    } else if (isWhoQuestion(message)) {
      replyText = WHO_REPLY;
    } else if (stage === 'cold') {
      replyText = composeReply({
        inbound: message,
        modelReply: "No problem. If anything changes, just text back.",
      });
    } else {
      const draft = await getAiReply(
        conv,
        recentMessages,
        conv.contact_name,
        {
          stage,
          property: state.property,
          score: state.score,
          name: state.name
        }
      );
      replyText = composeReply({ inbound: message, modelReply: draft });
    }

    // ── Hand-Raise Detection ──
    // Detect when a lead clearly expresses interest in selling
    const handRaiseKeywords = [
      'sell', 'selling', 'offer', 'cash', 'buy', 'interested',
      'price', 'worth', 'value', 'market', 'looking to',
      'yes', 'sure', 'ok', 'okay', 'please', 'tell me more',
      'address is', 'property is', 'home is'
    ];
    const lowerMsg = message.toLowerCase();
    const handRaiseScore = handRaiseKeywords.filter(k => lowerMsg.includes(k)).length;
    const isHandRaise = (
      (state.score >= 50 && recentMessages.length <= 3) ||  // Strong interest early
      (handRaiseScore >= 3 && state.score >= 30) ||     // Multiple interest signals
      (state.stage === 'offer_discussion' || state.stage === 'hot_lead') ||
      (state.property.address && state.property.askingPrice)  // Gave both address AND price
    );

    if (isHandRaise && !state._handRaiseNotified) {
      state._handRaiseNotified = true;
      const handRaiseAlert = `🔔 *Hand Raise!*
📱 ${fromPhone}
👤 ${conv.contact_name || 'Unknown'}
📍 ${state.property.address || 'No address yet'}
💰 ${state.property.askingPrice ? '$' + state.property.askingPrice.toLocaleString() : 'Not discussed'}
📊 Score: ${state.score}/100
🏷️ Stage: ${stage}
💬 "${message.substring(0, 150)}${message.length > 150 ? '...' : ''}"

View: ${DASHBOARD_URL || 'https://norcal-sms-agent.fly.dev'}/#conv-${convId}`;

      console.log(`[🖐️ HAND RAISE] ${fromPhone} score=${state.score} stage=${stage}`);

      // Send notification if Telegram bot token configured
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        try {
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: process.env.TELEGRAM_CHAT_ID,
              text: handRaiseAlert,
              parse_mode: 'Markdown'
            })
          });
          console.log(`[Notify] Telegram alert sent for ${fromPhone}`);
        } catch (e) {
          console.error(`[Notify] Telegram failed: ${e.message}`);
        }
      }

    }

    if (!replyText) {
      console.error(`[NoReply] ${fromPhone} AI produced no reply; inbound saved, nothing sent. Replay later.`);
    }

    if (replyText) {
      state.history.push({ direction: 'outbound', text: replyText, time: new Date().toISOString() });

      const smsResult = await sendSmsblast(fromPhone, replyText, { automated: true });
      const smsStatus = smsResult.success ? 'sent' : 'failed';

      db.prepare(`INSERT INTO messages (conversation_id, body, direction, from_number, to_number, status)
        VALUES (?, ?, 'outbound', ?, ?, ?)`).run(convId, replyText, SMSBLAST_FROM, fromPhone, smsStatus);

      db.prepare(`UPDATE conversations SET 
        last_message = ?, last_message_time = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`).run(replyText, convId);
    }
  }

  if (plan.ghl) {
    try {
      const convFresh = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
      const transcript = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(convId);
      const ghl = await syncSellerToGhl({ conversation: convFresh, messages: transcript, env: process.env });
      if (ghl && ghl.contactId) {
        db.prepare(`UPDATE conversations SET
            ghl_contact_id = ?,
            ghl_opportunity_id = ?,
            ghl_note_fingerprint = ?,
            ghl_pushed_at = CASE WHEN ghl_pushed_at IS NULL OR ghl_pushed_at = '' THEN datetime('now') ELSE ghl_pushed_at END,
            crm_pushed = 1,
            crm_pushed_at = COALESCE(crm_pushed_at, datetime('now'))
          WHERE id = ?`).run(ghl.contactId, ghl.opportunityId || '', ghl.fingerprint || '', convId);
        console.log(`[GHL] ${fromPhone} ${ghl.action}`);
      } else if (ghl && !['not_enough_conversation', 'not_enough_detail', 'only_acknowledgement', 'price_only'].includes(ghl.reason)) {
        console.log(`[GHL] ${fromPhone} skipped (${ghl.reason})`);
      }
    } catch (err) {
      console.error('[GHL] unexpected error, inbound still saved:', err.message);
    }
  }

  // Respond to smsblast.io
  const state = getLeadState(fromPhone);
  res.json({
    handled: true,
    conversation_id: convId,
    reply: replyText,
    stage: state.stage,
    score: state.score,
    property: state.property
  });
}

// Register both webhook paths (SMSBlast sends to /webhook/)
app.post('/webhook/', handleInboundWebhook);
app.post('/webhook/inbound', handleInboundWebhook);

// ── DASHBOARD API ROUTES (all require auth) ──

// Auth
app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

app.post('/api/login', (req, res) => {
  const { password, remember } = req.body;
  if (DASHBOARD_PASSWORD && password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    if (remember) {
      // Extend session to 30 days for "remember me"
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    }
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
  const { status, label, search, today, unread, stage, replied } = req.query;
  let sql = 'SELECT * FROM conversations WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (label) { sql += ' AND label = ?'; params.push(label); }
  if (stage) { sql += ' AND lead_stage = ?'; params.push(stage); }
  if (search) { sql += ' AND (phone LIKE ? OR contact_name LIKE ? OR property_address LIKE ? OR lead_address LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  if (today) { sql += " AND date(last_message_time) = date('now')"; }
  if (unread) { sql += ' AND unread_count > 0'; }
  if (replied === '1') { sql += ' AND id IN (SELECT conversation_id FROM messages WHERE direction = \'inbound\')'; }
  if (replied === '0') { sql += ' AND id NOT IN (SELECT conversation_id FROM messages WHERE direction = \'inbound\')'; }
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
  const { contact_name, property_address, lead_source, ai_enabled, status, label,
    lead_stage, lead_address, lead_asking_price, lead_condition, lead_motivation } = req.body;
  const updates = [];
  const params = [];
  if (contact_name !== undefined) { updates.push('contact_name = ?'); params.push(contact_name); }
  if (property_address !== undefined) { updates.push('property_address = ?'); params.push(property_address); }
  if (lead_source !== undefined) { updates.push('lead_source = ?'); params.push(lead_source); }
  if (ai_enabled !== undefined) { updates.push('ai_enabled = ?'); params.push(ai_enabled ? 1 : 0); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (label !== undefined) { updates.push('label = ?'); params.push(label); }
  if (lead_stage !== undefined) { updates.push('lead_stage = ?'); params.push(lead_stage); }
  if (lead_address !== undefined) { updates.push('lead_address = ?'); params.push(lead_address); }
  if (lead_asking_price !== undefined) { updates.push('lead_asking_price = ?'); params.push(lead_asking_price); }
  if (lead_condition !== undefined) { updates.push('lead_condition = ?'); params.push(lead_condition); }
  if (lead_motivation !== undefined) { updates.push('lead_motivation = ?'); params.push(lead_motivation); }
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

  const smsResult = await sendSmsblast(conv.phone, message, { automated: false });
  if (!smsResult.success && smsResult.blocked) {
    const error = smsResult.error === 'suppressed' ? 'This number cannot be texted.' : 'This number is opted out.';
    return res.status(403).json({ error });
  }
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

// Notes for conversations
app.get('/api/conversations/:id/notes', requireAuth, (req, res) => {
  const notes = db.prepare('SELECT * FROM conversation_notes WHERE conversation_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(notes);
});

app.post('/api/conversations/:id/notes', requireAuth, (req, res) => {
  const { notes } = req.body;
  if (!notes) return res.status(400).json({ error: 'Notes text required' });
  const result = db.prepare('INSERT INTO conversation_notes (conversation_id, notes) VALUES (?, ?)').run(req.params.id, notes);
  res.json({ id: result.lastInsertRowid, notes, created_at: new Date().toISOString() });
});

app.delete('/api/conversations/:id/notes/:noteId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM conversation_notes WHERE id = ? AND conversation_id = ?').run(req.params.noteId, req.params.id);
  res.json({ success: true });
});

// Pull comps / ARV for a lead
app.post('/api/conversations/:id/comps', requireAuth, (req, res) => {
  const { address } = req.body;
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const leadAddr = address || conv.lead_address || conv.property_address || '';
  
  // Basic property info for formula display
  // In production, this would call BatchLeads or PropertyRadar APIs
  res.json({
    success: true,
    arv: null,
    mao: null,
    source: 'estimated',
    formula: leadAddr ? `Comps for ${leadAddr} — connect BatchLeads API key for real comps` : 'No address on file. Add address to pull comps.'
  });
});

// Create a new conversation and send initial message
app.post('/api/conversations/new', requireAuth, async (req, res) => {
  const { phone, message, contact_name, ai_enabled } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });
  
  const cleaned = phone.replace(/[^\d+]/g, '');
  const e164 = cleaned.startsWith('+') ? cleaned : (cleaned.startsWith('1') && cleaned.length === 11 ? '+' + cleaned : '+1' + cleaned);
  
  try {
    const smsResult = await sendSmsblast(e164, message, { automated: true });
    if (!smsResult.success) {
      return res.json({ success: false, sms_error: smsResult.error });
    }
    
    // Create conversation
    const result = db.prepare(`INSERT INTO conversations (phone, contact_name, lead_source, ai_enabled, status, label)
      VALUES (?, ?, 'manual', ?, 'active', 'new')`).run(e164, contact_name || '', ai_enabled !== false ? 1 : 0);
    
    // Record the outbound message
    db.prepare(`INSERT INTO messages (conversation_id, body, direction, from_number, to_number, status)
      VALUES (?, ?, 'outbound', ?, ?, 'sent')`).run(result.lastInsertRowid, message, SMSBLAST_FROM, e164);
    
    db.prepare(`UPDATE conversations SET last_message = ?, last_message_time = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(message, result.lastInsertRowid);
    
    res.json({ success: true, conversation_id: result.lastInsertRowid });
  } catch (err) {
    res.json({ success: false, sms_error: err.message });
  }
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

// Stats (legacy)
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

// Rich Dashboard (for SPA)
app.get('/api/dashboard', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
  const active = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE status = 'active'").get();
  const hot = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE label = 'hot'").get();
  const warm = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE label = 'warm'").get();
  const unread = db.prepare('SELECT SUM(unread_count) as count FROM conversations').get();
  const todayMsgs = db.prepare("SELECT COUNT(*) as count FROM messages WHERE date(timestamp) = date('now')").get();
  const todayIn = db.prepare("SELECT COUNT(*) as count FROM messages WHERE date(timestamp) = date('now') AND direction = 'inbound'").get();
  const todayOut = db.prepare("SELECT COUNT(*) as count FROM messages WHERE date(timestamp) = date('now') AND direction = 'outbound'").get();
  const weekMsgs = db.prepare("SELECT COUNT(*) as count FROM messages WHERE timestamp >= datetime('now', '-7 days')").get();
  const aiEnabled = db.prepare('SELECT COUNT(*) as count FROM conversations WHERE ai_enabled = 1').get();
  const optOuts = db.prepare('SELECT COUNT(*) as count FROM opt_outs').get();
  const dealsInPipeline = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE label IN ('hot','warm')").get();

  // Response rate: conversations with at least 1 inbound message
  const responded = db.prepare("SELECT COUNT(DISTINCT conversation_id) as count FROM messages WHERE direction = 'inbound'").get();
  const responseRate = total.count > 0 ? Math.round((responded.count / total.count) * 100) : 0;

  // Recent activity (last 20 messages)
  const recentActivity = db.prepare(`
    SELECT m.body, m.direction, m.timestamp, c.phone as conv_phone, c.contact_name
    FROM messages m
    LEFT JOIN conversations c ON m.conversation_id = c.id
    ORDER BY m.timestamp DESC LIMIT 20
  `).all();

  // Stage breakdown
  const stageBreakdown = db.prepare(`
    SELECT COALESCE(label, 'new') as lead_stage, COUNT(*) as count
    FROM conversations
    WHERE status = 'active'
    GROUP BY label
    ORDER BY count DESC
  `).all();

  // Label breakdown
  const labelBreakdown = db.prepare(`
    SELECT label, COUNT(*) as count
    FROM conversations
    WHERE status = 'active'
    GROUP BY label
    ORDER BY count DESC
  `).all();

  res.json({
    total_conversations: total.count,
    active_conversations: active.count,
    hot_leads: hot.count,
    messages_today: todayMsgs.count,
    today_inbound: todayIn.count,
    today_outbound: todayOut.count,
    response_rate: responseRate,
    week_messages: weekMsgs.count,
    total_unread: unread.count || 0,
    ai_enabled: aiEnabled.count,
    opt_outs: optOuts.count,
    deals_in_pipeline: dealsInPipeline.count,
    warm_leads: warm.count,
    recent_activity: recentActivity,
    stage_breakdown: stageBreakdown,
    label_breakdown: labelBreakdown
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

// ── Push Lead to CRM (Go High Level) ──
/**
 * POST /api/conversations/:id/push-to-crm
 * Pushes a lead to Go High Level or any configured webhook CRM.
 */
app.post('/api/conversations/:id/push-to-crm', requireAuth, async (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(conv.id);
  const qualification = assessOfferReady(messages, conv);
  if (['opt_out', 'wrong_number', 'not_interested'].includes(qualification.reason) || isOptedOut(conv.phone)) {
    return res.status(400).json({ error: 'Opt-outs, wrong numbers, and not-interested replies are not sent to GoHighLevel.' });
  }
  const lastMsg = messages[messages.length - 1];

  if (process.env.GHL_API_TOKEN && process.env.GHL_LOCATION_ID) {
    const ghl = await syncSellerToGhl({ conversation: conv, messages, env: process.env, force: true });
    if (ghl && ghl.contactId) {
      db.prepare(`UPDATE conversations SET
          ghl_contact_id = ?,
          ghl_opportunity_id = ?,
          ghl_note_fingerprint = ?,
          ghl_pushed_at = CASE WHEN ghl_pushed_at IS NULL OR ghl_pushed_at = '' THEN datetime('now') ELSE ghl_pushed_at END,
          crm_pushed = 1,
          crm_pushed_at = COALESCE(crm_pushed_at, datetime('now')),
          updated_at = datetime('now')
        WHERE id = ?`).run(ghl.contactId, ghl.opportunityId || '', ghl.fingerprint || conv.ghl_note_fingerprint || '', conv.id);
      return res.json({ success: true, via: 'ghl_api', action: ghl.action, contactId: ghl.contactId });
    }
    if (ghl && ghl.reason === 'api_error') {
      return res.status(502).json({ error: 'GoHighLevel did not accept the contact. The bot is still running.' });
    }
  }

  const payload = {
    event: 'lead_push',
    phone: conv.phone,
    name: conv.contact_name || '',
    email: conv.email || '',
    address: conv.property_address || '',
    label: conv.label || 'new',
    status: conv.status || 'active',
    messageCount: messages.length,
    lastMessage: lastMsg?.body || '',
    lastMessageTime: lastMsg?.timestamp || null,
    transcript: messages.map((m) => `${m.direction === 'inbound' ? 'Lead' : 'Assistant'}: ${m.body}`).join('\n').slice(0, 6000),
    conversationUrl: `${DASHBOARD_URL}/#conv-${conv.id}`,
    pushedAt: new Date().toISOString()
  };

  const webhookUrl = process.env.GHL_WEBHOOK_URL || process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(400).json({ error: 'No webhook URL configured. Set GHL_WEBHOOK_URL or WEBHOOK_URL env var.' });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    db.prepare(`UPDATE conversations SET 
      crm_pushed = 1, 
      crm_pushed_at = datetime('now'),
      updated_at = datetime('now')
      WHERE id = ?`).run(conv.id);

    console.log(`[CRM Push] Lead ${conv.phone} pushed → ${response.status}`);
    res.json({
      success: true,
      status: response.status,
      payload,
      message: `Lead pushed to CRM successfully (${response.status})`
    });
  } catch (err) {
    console.error(`[CRM Push] Failed: ${err.message}`);
    res.status(500).json({ error: `Webhook failed: ${err.message}` });
  }
});

/** GET /api/webhook-config — Returns webhook configuration status */
app.get('/api/webhook-config', requireAuth, (req, res) => {
  res.json({
    webhookUrl: !!(process.env.GHL_WEBHOOK_URL || process.env.WEBHOOK_URL || process.env.GHL_API_TOKEN),
    ghlApi: !!process.env.GHL_API_TOKEN,
    telegramNotifications: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    testMode: isTestMode(),
    dashboardUrl: DASHBOARD_URL
  });
});

// Login page redirect — SPA handles it
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── CSV Upload & Blast ──

// Store active blast jobs
const blastJobs = new Map();

/**
 * POST /api/upload-csv
 * Body: { csv: "phone\n+15302480020\n+15305551234\n..." }
 * OR: { numbers: ["+15302480020", ...] }
 * Returns parsed phone list with validation
 */
app.post('/api/upload-csv', requireAuth, (req, res) => {
  const { csv, numbers } = req.body;
  let rows = [];

  if (csv) {
    // Parse CSV lines — supports phone, name, address columns
    const lines = csv.split(/[\n]+/).filter(l => l.trim());
    for (const line of lines) {
      // Split by comma or tab
      const cols = line.split(/[,\t]+/).map(c => c.trim().replace(/^["']|["']$/g, ''));
      let phone = '', name = '', address = '';
      
      // Find phone column (looks like a phone number)
      for (const col of cols) {
        const cleaned = col.replace(/[^\d+]/g, '');
        if (/^\+?1?\d{10}$/.test(cleaned) || cleaned.length >= 10) {
          phone = cleaned.startsWith('+') ? cleaned : (cleaned.startsWith('1') && cleaned.length === 11 ? '+' + cleaned : '+1' + cleaned);
        } else if (col.match(/\d+\s+\w+/)) {
          address = col;
        } else if (col.length > 0 && !col.match(/^[\d\s\-()+]+$/)) {
          if (!name) name = col;
          else if (!address) address = col;
        }
      }
      
      // Heuristic: if only two useful columns, first might be name
      const nonPhoneCols = cols.filter(c => c !== phone && c.length > 0);
      if (nonPhoneCols.length === 2 && !name) {
        name = nonPhoneCols[0];
        address = nonPhoneCols[1];
      } else if (nonPhoneCols.length === 1 && !name) {
        // Could be name or address — check for address-like patterns
        const col = nonPhoneCols[0];
        if (col.match(/\d+\s/) || col.match(/street|st|ave|road|rd|dr|lane|ln|cir|ct|way|blvd|hwy/i)) {
          address = col;
        } else {
          name = col;
        }
      }
      
      if (phone) rows.push({ phone, name, address });
    }
  } else if (numbers && Array.isArray(numbers)) {
    // Support objects with phone + optional name/address
    rows = numbers.map(n => typeof n === 'string' ? { phone: n } : { phone: n.phone || n.number, name: n.name || '', address: n.address || n.property || '' });
  } else {
    return res.status(400).json({ error: 'Provide csv string or numbers array' });
  }

  // Dedupe by phone
  const seen = new Set();
  const unique = rows.filter(r => { if (seen.has(r.phone)) return false; seen.add(r.phone); return true; });

  const valid = unique.filter(r => /^\+1\d{10}$/.test(r.phone));
  const invalid = unique.filter(r => !/^\+1\d{10}$/.test(r.phone));

  // Check opt-outs and numbers that must never be texted
  const alreadyOptedOut = valid.filter(r => isOptedOut(r.phone));
  const suppressedLeads = valid.filter(r => isSuppressed(r.phone) && !isOptedOut(r.phone));
  const clean = valid.filter(r => !isOptedOut(r.phone) && !isSuppressed(r.phone));

  res.json({
    total: unique.length,
    valid: valid.length,
    invalid: invalid.length,
    optedOut: alreadyOptedOut.length,
    suppressed: suppressedLeads.length,
    clean: clean.length,
    leads: clean,
    invalidLeads: invalid,
    optedOutLeads: alreadyOptedOut,
    suppressedLeads
  });
});

/**
 * POST /api/blast
 * Body: { numbers: ["+15302480020", ...], message: "Hey...", delayMs: 200, scrubDnc: true }
 * Sends blast to all numbers with configurable delay between sends.
 * If scrubDnc is true, filters out DNC-registered numbers before sending.
 */
app.post('/api/blast', requireAuth, async (req, res) => {
  const { numbers, message, delayMs, scrubDnc } = req.body;

  // Support both flat numbers and lead objects with name/address
  let leads = Array.isArray(numbers) ? numbers.map(n => {
    if (typeof n === 'string') return { phone: n, name: '', address: '' };
    return { phone: n.phone || n.number, name: n.name || '', address: n.address || n.property || '' };
  }) : [];

  if (leads.length === 0) {
    return res.status(400).json({ error: 'Provide numbers array' });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Provide message body' });
  }

  let dncResult = null;
  let dncBlocked = 0;

  // Optional DNC scrubbing before blast
  if (scrubDnc) {
    if (!TRACERFY_API_KEY) {
      return res.status(500).json({ error: 'scrubDnc requested but TRACERFY_API_KEY not configured' });
    }
    
    const phonesToScrub = leads.map(l => l.phone);
    console.log(`[Blast] DNC scrubbing ${phonesToScrub.length} numbers before blast...`);
    
    try {
      dncResult = await scrubPhones(TRACERFY_API_KEY, phonesToScrub);
      dncBlocked = dncResult.stats.blocked;
      
      // Filter leads to only clean numbers
      // Normalize: Tracersfy strips leading + and country code, returns 10-digit
      const normalizePhone = (p) => p.replace(/[^\d]/g, '').slice(-10);
      const cleanPhones = new Set(dncResult.clean.map(normalizePhone));
      leads = leads.filter(l => cleanPhones.has(normalizePhone(l.phone)));
      
      console.log(`[Blast] DNC complete — ${dncResult.stats.clean} clean, ${dncBlocked} blocked`);
    } catch (err) {
      console.error(`[Blast] DNC scrub failed: ${err.message}`);
      return res.status(500).json({ error: `DNC scrub failed: ${err.message}` });
    }
  }

  if (leads.length === 0) {
    return res.json({ 
      jobId: null, 
      total: numbers.length, 
      dncBlocked, 
      status: 'completed',
      message: 'All numbers were blocked by DNC scrubbing'
    });
  }

  const jobId = `blast_${Date.now()}`;
  const delay = delayMs || 300;

  const filteredMessage = scrubDnc && dncBlocked > 0 && leads.length === 0 ? null : message;

  blastJobs.set(jobId, {
    id: jobId,
    total: leads.length,
    originalTotal: numbers.length,
    dncBlocked,
    dncResult: dncResult ? { 
      clean: dncResult.stats.clean, 
      blocked: dncResult.stats.blocked,
      creditsUsed: dncResult.stats.creditsDeducted
    } : null,
    sent: 0,
    failed: 0,
    status: 'running',
    startedAt: new Date().toISOString(),
    leads,
    message,
    results: []
  });

  // Start blast in background
  runBlast(jobId, leads, message, delay);

  res.json({ 
    jobId, 
    total: leads.length, 
    originalTotal: numbers.length,
    dncBlocked,
    status: 'running' 
  });
});

async function runBlast(jobId, leads, message, delay) {
  const job = blastJobs.get(jobId);
  if (!job) return;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const phone = lead.phone;
    const gate = canSendSms(phone, { automated: true, env: process.env, optedOut: isOptedOut(phone) });
    if (!gate.ok) {
      job.skipped = (job.skipped || 0) + 1;
      job.results.push({ phone, name: lead.name, status: 'skipped', error: gate.reason });
      console.log(`[Blast ${jobId}] skipped ${phone} (${gate.reason})`);
      continue;
    }

    // Pre-create conversation and pre-populate known info
    let conv = db.prepare('SELECT * FROM conversations WHERE phone = ?').get(phone);
    if (!conv) {
      const result = db.prepare(`INSERT INTO conversations 
        (phone, contact_name, property_address, lead_source, ai_enabled, status, label)
        VALUES (?, ?, ?, 'csv_blast', 1, 'active', 'new')`)
        .run(phone, lead.name || '', lead.address || '');
      conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
    } else if (lead.address && !conv.property_address) {
      db.prepare('UPDATE conversations SET property_address = ?, contact_name = COALESCE(NULLIF(contact_name,""),?) WHERE id = ?')
        .run(lead.address, lead.name || '', conv.id);
    }

    // Pre-populate lead state with known address
    if (lead.address) {
      const state = getLeadState(phone);
      if (!state.property.address) {
        state.property.address = lead.address;
        state.stage = 'property_condition'; // Skip address question since we know it
      }
    }

    try {
      // Personalize message if we have name
      const personalized = lead.name ? message.replace(/\[Name\]/gi, lead.name.split(' ')[0]) : message;
      const result = await sendSmsblast(phone, personalized, { automated: true });
      
      if (result.success) {
        job.sent++;
        const sid = result.data?.results?.[0]?.messageSid;
        job.results.push({ phone, name: lead.name, address: lead.address, status: 'sent', sid });
        
        // Record outbound message in conversation
        const convId = conv?.id || (db.prepare('SELECT id FROM conversations WHERE phone = ?').get(phone)?.id);
        if (convId) {
          db.prepare(`INSERT INTO messages (conversation_id, body, direction, from_number, to_number, status, smsblast_sid)
            VALUES (?, ?, 'outbound', ?, ?, 'sent', ?)`).run(convId, personalized, SMSBLAST_FROM, phone, sid);
          const state = getLeadState(phone);
          state.history.push({ direction: 'outbound', text: personalized, time: new Date().toISOString() });
        }
      } else {
        job.failed++;
        job.results.push({ phone, name: lead.name, status: 'failed', error: result.error });
      }
    } catch (err) {
      job.failed++;
      job.results.push({ phone, name: lead.name, status: 'failed', error: err.message });
    }

    if ((i + 1) % 50 === 0 || i === leads.length - 1) {
      console.log(`[Blast ${jobId}] ${i + 1}/${leads.length} — ${job.sent} sent, ${job.failed} failed`);
    }

    if (i < leads.length - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  console.log(`[Blast ${jobId}] Complete — ${job.sent}/${job.total} sent, ${job.failed} failed`);
}

/** GET /api/blast/:jobId — Check blast status */
app.get('/api/blast/:jobId', requireAuth, (req, res) => {
  const job = blastJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const { results, ...summary } = job;
  res.json({ ...summary, resultCount: results.length });
});

/** GET /api/blast/:jobId/results — Full blast results */
app.get('/api/blast/:jobId/results', requireAuth, (req, res) => {
  const job = blastJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/** GET /api/blasts — List recent blast jobs */
app.get('/api/blasts', requireAuth, (req, res) => {
  const jobs = [...blastJobs.values()].map(({ results, ...j }) => ({
    ...j,
    resultCount: results?.length || 0
  }));
  res.json(jobs);
});

// ── DNC Scrub Endpoints ──
const dncJobs = new Map();

/**
 * POST /api/dnc-scrub
 * Body: { numbers: ["+15302480020", ...], ... }
 * 
 * Scrubs phone numbers against Federal/State DNC, DMA, and TCPA Litigator databases.
 * Filters out DNC-registered, DMA-suppressed, and TCPA-litigator numbers.
 */
app.post('/api/dnc-scrub', requireAuth, async (req, res) => {
  const { numbers } = req.body;
  
  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Provide numbers array' });
  }
  
  if (!TRACERFY_API_KEY) {
    return res.status(500).json({ error: 'TRACERFY_API_KEY not configured' });
  }

  // Support both flat strings and objects with phone field
  const phones = numbers.map(n => typeof n === 'string' ? n : (n.phone || n.number || '')).filter(p => p);
  
  const jobId = `dnc_${Date.now()}`;
  dncJobs.set(jobId, {
    id: jobId,
    total: phones.length,
    status: 'scrubbing',
    startedAt: new Date().toISOString(),
    inputPhones: phones
  });

  try {
    const result = await scrubPhones(TRACERFY_API_KEY, phones);
    
    dncJobs.set(jobId, {
      ...dncJobs.get(jobId),
      status: 'completed',
      completedAt: new Date().toISOString(),
      ...result.stats,
      cleanPhones: result.clean,
      blockedPhones: result.blocked,
      fullResults: result.fullResults
    });
    
    res.json({
      jobId,
      total: result.stats.total,
      clean: result.stats.clean,
      blocked: result.stats.blocked,
      creditsUsed: result.stats.creditsDeducted,
      cleanPhones: result.clean,
      blockedPhones: result.blocked.map(b => ({
        phone: b.phone,
        national_dnc: b.national_dnc,
        state_dnc: b.state_dnc,
        dma: b.dma,
        litigator: b.litigator,
        phone_type: b.phone_type
      }))
    });
  } catch (err) {
    dncJobs.set(jobId, {
      ...dncJobs.get(jobId),
      status: 'failed',
      error: err.message
    });
    res.status(500).json({ error: err.message, jobId });
  }
});

/** GET /api/dnc-scrub/:jobId — Check DNC scrub job status/results */
app.get('/api/dnc-scrub/:jobId', requireAuth, (req, res) => {
  const job = dncJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/** GET /api/dnc-scrubs — List DNC scrub jobs */
app.get('/api/dnc-scrubs', requireAuth, (req, res) => {
  const jobs = [...dncJobs.values()].map(({ fullResults, ...j }) => j);
  res.json(jobs);
});

// ── Skip Tracing ──
const { createEngine } = require('./lib/skip-trace');
const skipTraceEngine = createEngine();

// ── DNC Scrubbing ──
const { scrubPhones, getDncQueueStatus } = require('./lib/dnc-scrub');

// Active skip trace jobs
const skipTraceJobs = new Map();

/**
 * POST /api/skip-trace
 * Body: { addresses: ["123 Main St, Redding, CA", ...] }
 * OR:    { csv: "address\n123 Main St, Redding, CA\n..." }
 * 
 * Skip traces property addresses to find owner phone numbers.
 */
app.post('/api/skip-trace', requireAuth, async (req, res) => {
  const { addresses, csv, providerName } = req.body;
  let addrList = [];

  if (csv) {
    const lines = csv.split(/[\n]+/).filter(l => l.trim());
    addrList = lines.map(l => l.replace(/^["']|["']$/g, '').trim()).filter(l => l.length > 3);
  } else if (addresses && Array.isArray(addresses)) {
    addrList = addresses.filter(a => a && a.trim().length > 3);
  } else {
    return res.status(400).json({ error: 'Provide addresses array or csv string' });
  }

  // Dedupe
  addrList = [...new Set(addrList)];

  if (addrList.length === 0) {
    return res.status(400).json({ error: 'No valid addresses provided' });
  }

  // Check for previously traced addresses in our DB
  const previouslyTraced = {};
  for (const addr of addrList) {
    const existing = db.prepare(
      "SELECT phone, contact_name FROM conversations WHERE property_address LIKE ? AND phone != ''"
    ).get(`%${addr.split(',')[0].trim()}%`);
    if (existing) {
      previouslyTraced[addr] = {
        phones: [existing.phone],
        ownerName: existing.contact_name || '',
        source: 'database_cache',
        cached: true
      };
    }
  }

  // Filter out already-traced
  const toTrace = addrList.filter(a => !previouslyTraced[a]);

  const jobId = `trace_${Date.now()}`;
  skipTraceJobs.set(jobId, {
    id: jobId,
    total: toTrace.length,
    completed: 0,
    found: 0,
    status: 'running',
    startedAt: new Date().toISOString(),
    addresses: toTrace,
    cachedResults: previouslyTraced,
    results: {},
    errors: []
  });

  // Start tracing in background
  runSkipTrace(jobId, toTrace, providerName);

  res.json({
    jobId,
    total: toTrace.length,
    cached: Object.keys(previouslyTraced).length,
    status: 'running'
  });
});

async function runSkipTrace(jobId, addresses, providerName) {
  const job = skipTraceJobs.get(jobId);
  if (!job) return;

  const result = await skipTraceEngine.traceBatch(addresses, {
    providerName,
    concurrency: 3,
    onProgress: ({ completed, total, found, address, result }) => {
      job.completed = completed;
      job.found = found;
      if (result) {
        job.results[address] = result;
        // Auto-save phone numbers to conversations table for future lookups
        if (result.phones.length > 0) {
          for (const phone of result.phones) {
            const existing = db.prepare('SELECT id FROM conversations WHERE phone = ?').get(phone);
            if (!existing) {
              db.prepare(`INSERT INTO conversations (phone, contact_name, property_address, lead_source, ai_enabled, status)
                VALUES (?, ?, ?, 'skip_trace', 1, 'active')`)
                .run(phone, result.ownerName || '', address);
            } else {
              // Update with owner name and address if missing
              const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id);
              if (result.ownerName && !conv.contact_name) {
                db.prepare('UPDATE conversations SET contact_name = ? WHERE id = ?').run(result.ownerName, existing.id);
              }
              if (address && !conv.property_address) {
                db.prepare('UPDATE conversations SET property_address = ? WHERE id = ?').run(address, existing.id);
              }
            }
          }
        }
      } else {
        job.errors.push({ address, error: 'No results found' });
      }
    }
  });

  // Merge cached results
  Object.assign(job.results, job.cachedResults);

  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  job.stats = result.stats;
  
  console.log(`[SkipTrace ${jobId}] Complete — ${job.found}/${job.total} found`);
}

/** GET /api/skip-trace/:jobId — Check skip trace job status */
app.get('/api/skip-trace/:jobId', requireAuth, (req, res) => {
  const job = skipTraceJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  
  const { results, errors, addresses, ...summary } = job;
  const resultCount = Object.keys(results).length;
  const phoneLeads = Object.entries(results)
    .filter(([_, r]) => r && r.phones?.length > 0)
    .map(([addr, r]) => ({
      address: addr,
      phones: r.phones,
      ownerName: r.ownerName,
      source: r.source,
      cached: r.cached || false
    }));

  res.json({ ...summary, resultCount, phoneLeads });
});

/** GET /api/skip-trace/:jobId/results — Full skip trace results */
app.get('/api/skip-trace/:jobId/results', requireAuth, (req, res) => {
  const job = skipTraceJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/** GET /api/skip-traces — List recent skip trace jobs */
app.get('/api/skip-traces', requireAuth, (req, res) => {
  const jobs = [...skipTraceJobs.values()].map(({ results, errors, addresses, ...j }) => ({
    ...j,
    resultCount: Object.keys(results).length
  }));
  res.json(jobs);
});

/**
 * POST /api/skip-trace/upload-and-blast
 * Full pipeline: CSV upload → Skip Trace → SMS Blast
 * 
 * Body: {
 *   csv: "address\n123 Main St, Redding, CA\n456 Oak Ave, Anderson, CA\n...",
 *   message: "Hey [Name], interested in selling 123 Main St? I buy houses...",
 *   delayMs: 300,
 *   providerName: "batchleads"  // optional
 * }
 * 
 * Returns: { pipelineId, traceJobId, blastJobId }
 */
app.post('/api/skip-trace/upload-and-blast', requireAuth, async (req, res) => {
  const { csv, message, delayMs, providerName } = req.body;

  if (!csv) return res.status(400).json({ error: 'Provide csv with addresses' });
  if (!message) return res.status(400).json({ error: 'Provide message to blast' });

  // Parse addresses from CSV
  const rows = [];
  const lines = csv.split(/[\n]+/).filter(l => l.trim());
  
  for (const line of lines) {
    const cols = line.split(/[,\t]+/).map(c => c.trim().replace(/^["']|["']$/g, ''));
    // Try to extract address from CSV columns
    const address = cols.find(c => 
      c.match(/\d+\s/) || 
      c.match(/street|st|ave|road|rd|dr|lane|ln|cir|ct|way|blvd|hwy/i)
    ) || cols.join(' ');
    if (address && address.length > 3) rows.push(address);
  }

  const addresses = [...new Set(rows)];
  if (addresses.length === 0) {
    return res.status(400).json({ error: 'No valid addresses found in CSV' });
  }

  const pipelineId = `pipeline_${Date.now()}`;

  // Phase 1: Skip Trace
  const traceJobId = `trace_${Date.now()}`;
  skipTraceJobs.set(traceJobId, {
    id: traceJobId,
    pipelineId,
    total: addresses.length,
    completed: 0,
    found: 0,
    status: 'running',
    phase: 'skip_trace',
    startedAt: new Date().toISOString(),
    addresses,
    results: {},
    errors: []
  });

  // Run skip trace, then auto-blast
  const traceResult = await new Promise(async (resolve) => {
    await runSkipTrace(traceJobId, addresses, providerName);
    const traceJob = skipTraceJobs.get(traceJobId);
    traceJob.status = 'completed';
    
    // Collect phone numbers from results
    const phoneLeads = [];
    for (const [addr, result] of Object.entries(traceJob.results)) {
      if (result && result.phones?.length > 0) {
        for (const phone of result.phones) {
          phoneLeads.push({
            phone,
            name: result.ownerName || '',
            address: addr
          });
        }
      }
    }

    resolve({ traceJob, phoneLeads });
  });

  // Phase 2: SMS Blast
  let blastJobId = null;

  if (traceResult.phoneLeads.length > 0) {
    blastJobId = `blast_${Date.now()}`;
    const delay = delayMs || 300;
    const leads = traceResult.phoneLeads;

    blastJobs.set(blastJobId, {
      id: blastJobId,
      pipelineId,
      total: leads.length,
      sent: 0,
      failed: 0,
      status: 'running',
      phase: 'sms_blast',
      startedAt: new Date().toISOString(),
      leads,
      message,
      results: []
    });

    // Don't await — blast runs in background
    runBlast(blastJobId, leads, message, delay);
  }

  res.json({
    pipelineId,
    traceJobId,
    blastJobId,
    addressesFound: traceResult.phoneLeads.length,
    totalAddresses: addresses.length,
    status: blastJobId ? 'blasting' : 'completed'
  });
});

// ── Conversation Engine ──
// In-memory lead state (stage, score, property info)
const leadState = new Map();

function getLeadState(phone) {
  if (!leadState.has(phone)) {
    leadState.set(phone, { stage: 'new', score: 0, property: {}, history: [] });
  }
  return leadState.get(phone);
}

/**
 * GET /api/lead-state/:phone — View lead stage, score, property info
 */
app.get('/api/lead-state/:phone', requireAuth, (req, res) => {
  res.json(getLeadState(req.params.phone));
});

// ── Monitor API (token-based auth for external monitoring/cron) ──
const MONITOR_TOKEN = process.env.MONITOR_TOKEN;

function requireMonitorToken(req, res, next) {
  if (!MONITOR_TOKEN) return res.status(500).json({ error: 'MONITOR_TOKEN not configured' });
  const header = req.headers.authorization || '';
  const query = req.query.token || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : query;
  if (token !== MONITOR_TOKEN) return res.status(401).json({ error: 'Invalid monitor token' });
  next();
}

/** GET /api/monitor/hot-leads — Returns hot leads for external monitoring */
app.get('/api/monitor/hot-leads', requireMonitorToken, (req, res) => {
  const { hours, limit } = req.query;
  const sinceHours = parseInt(hours) || 2;
  const resultLimit = parseInt(limit) || 20;

  // Get conversations where the last message was inbound (from lead) within N hours
  // and label is hot/warm or lead_stage is negotiating/contacted
  const leads = db.prepare(`
    SELECT c.*, 
      (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_msg_body,
      (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_msg_direction,
      (SELECT timestamp FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_msg_time
    FROM conversations c
    WHERE c.status = 'active'
      AND (c.label IN ('hot', 'warm') OR c.lead_stage IN ('negotiating', 'contacted'))
      AND (
        SELECT timestamp FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1
      ) >= datetime('now', '-' || ? || ' hours')
    ORDER BY c.updated_at DESC
    LIMIT ?
  `).all(sinceHours, resultLimit);

  // Enrich with full message history
  const enriched = leads.map(lead => {
    const messages = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    ).all(lead.id);
    return { ...lead, messages };
  });

  res.json(enriched);
});

/** GET /api/monitor/lead/:phone — Look up a specific lead by phone number */
app.get('/api/monitor/lead/:phone', requireMonitorToken, (req, res) => {
  const phone = req.params.phone;
  // Normalize phone format
  const query = phone.startsWith('+1') ? phone : phone.startsWith('1') ? '+' + phone : phone.startsWith('+') ? phone : '+1' + phone;
  
  const conv = db.prepare('SELECT * FROM conversations WHERE phone = ?').get(query);
  if (!conv) {
    // Try partial match
    const likeQuery = '%' + phone.replace(/[^\d]/g, '') + '%';
    const matches = db.prepare('SELECT * FROM conversations WHERE phone LIKE ? ORDER BY updated_at DESC LIMIT 5').all(likeQuery);
    if (matches.length === 0) return res.status(404).json({ error: 'No lead found for that phone number' });
    return res.json({ exact: false, matches });
  }
  
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(conv.id);
  const notes = db.prepare('SELECT * FROM conversation_notes WHERE conversation_id = ? ORDER BY created_at DESC').all(conv.id);
  res.json({ exact: true, lead: { ...conv, messages, notes } });
});

/** POST /api/seed — Seed tagged conversations from a daily blast (idempotent upsert by phone) */
app.post('/api/seed', requireMonitorToken, (req, res) => {
  const { leads = [], label = '' } = req.body || {};
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'No leads provided' });
  }

  // Normalize to E.164 (+1XXXXXXXXXX) to match how inbound webhooks store phones
  const normalize = (p) => {
    if (!p) return null;
    let d = String(p).replace(/[^\d]/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    return d.length === 10 ? '+1' + d : null;
  };

  let created = 0, updated = 0, skipped = 0;

  const seedTx = db.transaction(() => {
    for (const lead of leads) {
      const phone = normalize(lead.phone);
      if (!phone) { skipped++; continue; }
      const name = String(lead.name || '').trim();
      const address = String(lead.address || '').trim();
      const existing = db.prepare('SELECT id FROM conversations WHERE phone = ?').get(phone);
      if (existing) {
        db.prepare(`
          UPDATE conversations SET
            contact_name = CASE WHEN ? <> '' THEN ? ELSE contact_name END,
            property_address = CASE WHEN ? <> '' THEN ? ELSE property_address END,
            lead_source = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(name, name, address, address, label, existing.id);
        updated++;
      } else {
        db.prepare(`
          INSERT INTO conversations (phone, contact_name, property_address, lead_source, label, status, ai_enabled)
          VALUES (?, ?, ?, ?, 'new', 'active', 1)
        `).run(phone, name, address, label);
        created++;
      }
    }
  });
  seedTx();

  res.json({ success: true, created, updated, skipped, total: leads.length, label });
});

// ── Daily Lead Pipeline ──
// Pulls fresh leads from Tracersfy → DNC scrub → SMS blast
// Triggered daily by OpenClaw cron at 8 AM PT
// Custom auth: accepts session cookie OR password in body/header
function requireDailyAuth(req, res, next) {
  // Session auth
  if (req.session?.authenticated) return next();
  // Password in body
  if (DASHBOARD_PASSWORD && req.body?.password && req.body.password === DASHBOARD_PASSWORD) return next();
  // Password in header
  if (DASHBOARD_PASSWORD && req.headers['x-daily-password'] === DASHBOARD_PASSWORD) return next();
  // Bearer token matching MONITOR_TOKEN
  const authHeader = req.headers.authorization || '';
  if (MONITOR_TOKEN && authHeader === `Bearer ${MONITOR_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/daily-pipeline', requireDailyAuth, async (req, res) => {
  const {
    counties = ['Sacramento','Butte','Shasta','Solano','Clark'],
    strategies = ['pre_foreclosure_motivated','probate_inherited','vacant'],
    requestedCount = 50,
    message,
    delayMs = 300,
    dryRun = false,
  } = req.body;

  if (!TRACERFY_API_KEY) {
    return res.status(500).json({ error: 'TRACERFY_API_KEY not configured' });
  }
  if (!SMSBLAST_API_KEY && !dryRun) {
    return res.status(500).json({ error: 'SMSBLAST_API_KEY not configured' });
  }

  if (String(process.env.DAILY_PIPELINE_ENABLED || '').trim().toLowerCase() !== 'true') {
    console.log('[DailyPipeline] Disabled (DAILY_PIPELINE_ENABLED is not true). Nothing pulled, nothing texted.');
    return res.status(403).json({ error: 'Daily pipeline is disabled', status: 'disabled' });
  }

  const blastMessage = message || DEFAULT_DAILY_BLAST;
  if (isTestMode() && !dryRun) {
    console.log('[DailyPipeline] Test mode is ON. Only AI_REPLY_ALLOWLIST numbers can be texted.');
  }

  const pipelineId = `daily_${Date.now()}`;
  const log = [];

  function addLog(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    log.push(entry);
    console.log(`[DailyPipeline] ${msg}`);
  }

  addLog(`Starting daily pipeline — ${new Date().toLocaleDateString()}`);

  // Phase 1: Pull leads from Tracersfy Lead Builder
  addLog('Phase 1: Pulling leads from Tracersfy...');
  const allLeads = [];
  const seen = new Set();

  for (const county of counties) {
    for (const strategy of strategies) {
      const label = strategy.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      addLog(`  ${county} / ${label}...`);

      try {
        const r = await fetch('https://tracerfy.com/v1/api/lead-builder/execute/', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TRACERFY_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            strategy,
            geography: {
              mode: 'counties',
              counties: [county],
              states: [county === 'Clark' ? 'NV' : 'CA'],
            },
            requested_count: requestedCount,
          }),
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          addLog(`  WARN: ${county}/${label} HTTP ${r.status} — ${JSON.stringify(data).substring(0, 200)}`);
          continue;
        }

        const leads = data.leads || data.results || [];
        addLog(`  OK: ${county}/${label} — ${leads.length} leads`);

        for (const l of leads) {
          let phone = '';
          if (l.phones && l.phones[0]?.number) {
            phone = l.phones[0].number.replace(/[^0-9]/g, '');
          } else if (l.phone) {
            phone = String(l.phone).replace(/[^0-9]/g, '');
          }
          if (!phone || phone.length < 10) continue;

          const name = l.owner_name || l.owner || l.full_name ||
            `${l.first_name || ''} ${l.last_name || ''}`.trim() || 'Owner';
          const address = l.address || l.street || '';
          const city = l.city || county;
          const state = county === 'Clark' ? 'NV' : 'CA';

          const key = `${phone}|${address}`;
          if (seen.has(key)) continue;
          seen.add(key);

          allLeads.push({ phone, name, address, city, state, type: label, source: county });
        }
      } catch (e) {
        addLog(`  ERROR: ${county}/${label} — ${e.message}`);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  }

  addLog(`Total unique leads pulled: ${allLeads.length}`);

  if (allLeads.length === 0) {
    addLog('No leads found — pipeline ending');
    return res.json({ pipelineId, leadsFound: 0, dncBlocked: 0, blastSent: 0, log, status: 'no_leads' });
  }

  // Phase 2: DNC Scrub
  let cleanLeads = allLeads;
  let dncStats = null;

  addLog('Phase 2: DNC scrubbing...');
  try {
    const { scrubPhones } = require('./lib/dnc-scrub');
    const phones = allLeads.map(l => l.phone);
    const dncResult = await scrubPhones(TRACERFY_API_KEY, phones, { pollIntervalMs: 3000, maxWaitMs: 300000 });
    dncStats = dncResult.stats;

    const cleanPhones = new Set(dncResult.clean);
    cleanLeads = allLeads.filter(l => cleanPhones.has(l.phone));

    addLog(`DNC done: ${dncStats.clean} clean, ${dncStats.blocked} blocked`);
  } catch (e) {
    addLog(`DNC scrub failed: ${e.message} — proceeding without DNC`);
    dncStats = { error: e.message };
  }

  addLog(`Leads after DNC: ${cleanLeads.length}`);

  // Phase 3: SMS Blast
  if (dryRun) {
    addLog(`DRY RUN — ${cleanLeads.length} leads would be blasted`);
    const sample = cleanLeads.slice(0, 5).map(l => ({
      phone: `***${l.phone.slice(-4)}`,
      name: l.name.split(' ')[0],
      address: `${l.address}, ${l.city}`,
      type: l.type,
    }));
    return res.json({
      pipelineId, leadsFound: allLeads.length, dncBlocked: dncStats?.blocked || 0,
      cleanLeads: cleanLeads.length, blastSent: 0, dryRun: true, sample, log, status: 'dry_run',
    });
  }

  if (cleanLeads.length === 0) {
    addLog('No clean leads to blast — pipeline ending');
    return res.json({
      pipelineId, leadsFound: allLeads.length, dncBlocked: dncStats?.blocked || 0,
      cleanLeads: 0, blastSent: 0, log, status: 'dnc_all_blocked',
    });
  }

  const beforeGate = cleanLeads.length;
  cleanLeads = cleanLeads.filter((lead) => {
    const digits = String(lead.phone || '').replace(/\D/g, '');
    const to = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : `+${digits}`;
    lead._to = to;
    return canSendSms(to, { automated: true, env: process.env, optedOut: isOptedOut(to) }).ok;
  });
  if (cleanLeads.length !== beforeGate) {
    addLog(`Send gate kept ${cleanLeads.length} of ${beforeGate} leads (test mode, opt-outs, or suppressed numbers removed)`);
  }

  addLog(`Phase 3: Blasting ${cleanLeads.length} leads...`);

  let sent = 0, failed = 0;
  for (let i = 0; i < cleanLeads.length; i++) {
    const lead = cleanLeads[i];
    const firstName = (lead.name || '').split(' ')[0] || 'there';
    const addr = lead.address ? `${lead.address}, ${lead.city}` : 'your property';
    const msg = blastMessage.replace(/\{firstName\}/g, firstName).replace(/\{address\}/g, addr);

    try {
      const result = await sendSmsblast(lead._to, msg, { automated: true });
      if (result.success) {
        sent++;
        if (sent % 10 === 0) addLog(`  Sent ${sent}/${cleanLeads.length}...`);
      } else {
        failed++;
        addLog(`  FAILED ${lead.phone}: ${result.error || 'send failed'}`);
      }
    } catch (e) {
      failed++;
      addLog(`  ERROR ${lead.phone}: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  addLog(`Blast done: ${sent} sent, ${failed} failed`);
  addLog('Pipeline complete!');

  res.json({
    pipelineId,
    leadsFound: allLeads.length,
    dncBlocked: dncStats?.blocked || 0,
    dncStats,
    cleanLeads: cleanLeads.length,
    blastSent: sent,
    blastFailed: failed,
    log,
    status: 'complete',
  });
});

// ── Catch-all: serve dashboard SPA ──
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
  const allowCount = String(process.env.AI_REPLY_ALLOWLIST || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).length;
  console.log(`   SMS API:   smsblast.io (via API key)`);
  console.log(`   AI Model:  ${AI_MODEL}`);
  console.log(`   Test mode: ${isTestMode() ? 'ON' : 'OFF'} (${allowCount} allowlisted number${allowCount === 1 ? '' : 's'})`);
  console.log(`   Daily pipeline: ${String(process.env.DAILY_PIPELINE_ENABLED || '').trim().toLowerCase() === 'true' ? 'ENABLED' : 'disabled'}`);
  console.log(`   GHL:       ${process.env.GHL_API_TOKEN && process.env.GHL_LOCATION_ID ? 'configured' : 'not configured'}\n`);
});
