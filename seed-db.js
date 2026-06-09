const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
    status TEXT DEFAULT 'active', label TEXT DEFAULT 'new',
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

// Check if knowledge base is empty
const count = db.prepare('SELECT COUNT(*) as count FROM knowledge_base').get();
if (count.count === 0) {
  console.log('Seeding knowledge base with wholesaling scripts...');
  const seeds = [
    ['Who is this?', 'This is Derek from NorCal Home Offer. I am an investor buying homes in your area for CASH. We buy AS-IS no repairs, no cleaning, no realtor fees. If you have ever thought about selling, we can make a fair offer and close on YOUR timeline. Text me your address and I will run the numbers!', 'initial-response'],
    ['How did you get my number?', 'I got your number from county tax records its public info. I saw you own a property in the area and wanted to reach out direct. No brokers, no websites, just me reaching out to see if you are open to a conversation about selling. No pressure at all!', 'objection'],
    ['Not interested', 'No worries! I get it. If things change down the road, feel free to reach out anytime. I will leave you alone. Have a good one!', 'objection'],
    ['Leave me alone', 'Sorry for bothering you! You are removed from my list. If you ever need a fast cash offer in the future, just text me. Take care!', 'objection'],
    ['How much can you offer?', 'Great question! Every house is different, but here is how I work: I look at what similar homes have sold for in your area, subtract what needs to be fixed, and make a fair CASH offer. I do not need an appraisal, bank, or realtor. Want me to run the numbers on your property? Just send me the address!', 'pricing'],
    ['What if they say not right now?', 'Totally understand! Can I check back in 60 days? A lot changes in 2 months. If they say yes that is a hot lead. If they say no ask: What WOULD make you sell? That is gold info.', 'follow-up'],
    ['How do I follow up after no response?', 'Hey, still interested in that cash offer? Market is hot right now want me to run numbers real quick? Text 3 times max then call. Most deals happen on touch 3-5.', 'follow-up'],
    ['What if they want more than market value?', 'I totally understand you want top dollar. Here is what I can do cash close in 2 weeks, no repairs. If you want to try the market first, no hard feelings. My offer stands.', 'pricing'],
    ['How fast can you close?', 'We can close in as little as 7-14 days, or we can work around YOUR timeline. If you need time to find your next place, we schedule when it works for you.', 'process'],
    ['Do you pay closing costs?', 'Yes! We cover all closing costs. No realtor commissions, no fees, no hidden costs. The price we offer is what you walk away with.', 'process'],
    ['What areas do you buy in?', 'We buy houses in Sacramento, Yolo, Placer, El Dorado, and surrounding counties in Northern California. Send me your address and I will let you know!', 'areas'],
    ['Do I need to make repairs?', 'No! We buy houses in ANY condition. No repairs, no cleaning, no staging. We take it exactly as-is. That saves you thousands and months of work.', 'process'],
    ['What if my house needs major repairs?', 'That is exactly what we look for! We buy homes in any condition bad roof, foundation issues, old plumbing, whatever. We handle it all.', 'process'],
    ['Is your offer fair?', 'I base my offers on recent sales in your area minus what needs fixing. My goal is a win-win you get cash fast, I get a deal that works. Fair and square.', 'pricing'],
    ['I need to talk to my spouse', 'Of course! Talk it over. Want me to send over the numbers for you both to look at? No pressure to say yes. I can also text your spouse the info too.', 'objection'],
    ['What about inherited properties?', 'Hey, sorry for your loss. I buy inherited homes as-is. If you are looking to sell quickly without fixing anything, I can help. Cash offer in 24 hours.', 'motivation'],
    ['What do you say to absentee owners?', 'Hi, you own this property but do not live there anymore. Looking to sell? I buy as-is, cash, fast close. No need to fix anything or even come to town.', 'motivation'],
    ['Are you a realtor?', 'I am a cash home buyer. No realtor fees, no commissions, no listing. I buy directly and close fast. Think of me as a cash investor, not an agent.', 'objection'],
    ['Expired listings approach', 'Hey, saw your house did not sell on market. I buy cash as-is. No realtor headaches. Want a quick offer?', 'motivation'],
    ['Best time to text', 'Weekdays 10am-12pm or 4pm-6pm. Weekends 11am-2pm. Tuesday-Thursday are money days. People actually read texts then.', 'strategy'],
    ['How many times should I follow up?', '7 touches minimum. Mix of texts and calls. Most deals happen on touch 3-5. Do not quit after one text they are busy, not ignoring you.', 'strategy'],
    ['What sells the deal?', 'I can have cash in your hand in 14 days, no repairs, no cleaning, no realtor. Cash offer, you choose the close date. Simple.', 'pricing'],
    ['What if they say yes?', 'Great! Let me come see the property tomorrow. I will bring a cash offer. What time works for you? Move fast same day if possible before they change their mind.', 'follow-up'],
    ['AI_INTERNAL: Business model', 'NorCal Home Offer buys single-family homes in Northern California. We wholesale find deals, put under contract, assign to cash buyers. Offer cash, close fast, buy as-is. Focus on Sacramento metro area.', 'internal'],
    ['AI_INTERNAL: Offer criteria', '70-75% of ARV minus repairs. Buyers need at least 20% margin. Preferred under 700K, max 1M with buyer lined up. Focus on 3/2 single family in good areas.', 'internal']
  ];

  const insert = db.prepare('INSERT INTO knowledge_base (question, answer, category) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    for (const [q, a, c] of seeds) insert.run(q, a, c);
  });
  tx();
  console.log('Seeded ' + seeds.length + ' knowledge base articles');
} else {
  console.log('Knowledge base already has ' + count.count + ' articles, skipping seed');
}
db.close();
