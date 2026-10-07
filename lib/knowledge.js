const { CLOSING_FACT, COSTS_FACT, STAY_FACT, NO_PRICE_FACT, MOBILE_FACT, HONEST_REPLY, WHO_REPLY } = require('./persona');

const CANONICAL_KB = [
  {
    question: 'Are you a bot?',
    answer: HONEST_REPLY,
    category: 'honesty',
  },
  {
    question: 'Are you a real person?',
    answer: HONEST_REPLY,
    category: 'honesty',
  },
  {
    question: 'Who is this?',
    answer: WHO_REPLY,
    category: 'honesty',
  },
  {
    question: 'What company is this?',
    answer: 'NorCal Home Offer. You are texting with Derek\'s AI assistant, and Derek can personally follow up.',
    category: 'honesty',
  },
  {
    question: 'How did you get my number?',
    answer: 'This number came from public property records. If you do not want texts, reply STOP and you will not get another one.',
    category: 'objection',
  },
  {
    question: 'Not interested',
    answer: 'No problem at all. We will leave it there. Reply STOP if you want to be sure the texts stop.',
    category: 'objection',
  },
  {
    question: 'Leave me alone',
    answer: 'Understood. You will not get another text from us.',
    category: 'objection',
  },
  {
    question: 'How much can you offer?',
    answer: NO_PRICE_FACT + ' If you share the address, condition, timeline, why you are selling, and what you would like to get, Derek will follow up.',
    category: 'pricing',
  },
  {
    question: 'How fast can you close?',
    answer: CLOSING_FACT,
    category: 'process',
  },
  {
    question: 'Do you pay closing costs?',
    answer: COSTS_FACT,
    category: 'process',
  },
  {
    question: 'Can I stay in the house after closing?',
    answer: STAY_FACT,
    category: 'process',
  },
  {
    question: 'Do I need to make repairs?',
    answer: 'You do not need to make repairs before we look. We buy as-is.',
    category: 'process',
  },
  {
    question: 'What if my house needs major repairs?',
    answer: 'That is fine. Share what is going on with the property and Derek will follow up. You do not need to fix it first.',
    category: 'process',
  },
  {
    question: 'What areas do you buy in?',
    answer: 'We are based in Redding and buy houses around Northern California. Send the address and Derek can confirm it is in range.',
    category: 'areas',
  },
  {
    question: 'What about mobile or manufactured homes?',
    answer: MOBILE_FACT,
    category: 'property-types',
  },
  {
    question: 'Are you a realtor?',
    answer: 'No. This is a cash home buyer, not a listing agent. You are texting with Derek\'s AI assistant, and Derek can follow up.',
    category: 'objection',
  },
  {
    question: 'I need to talk to my spouse',
    answer: 'Of course. There is no rush. Derek can follow up when you are both ready.',
    category: 'objection',
  },
  {
    question: 'What about inherited properties?',
    answer: 'Sorry for your loss. If you want to sell an inherited house as-is, share the address, condition, and timeline. Derek will follow up. A price is not quoted by text.',
    category: 'motivation',
  },
  {
    question: 'Is your offer fair?',
    answer: 'Derek puts the offer together after looking at the property. I do not quote a price by text, and I do not share ratings, reviews, or testimonials.',
    category: 'pricing',
  },
  {
    question: 'AI_INTERNAL: Rules the assistant must follow',
    answer: 'Never claim to be human. Never offer voice notes. Never use a last name. Never say close in 7-14 days. Never promise a rent-back. Never say we cover all closing costs, no fees, or that the offer is what they walk away with. Never mention BBB, ratings, reviews, or testimonials. Never quote a dollar offer. Mobile or manufactured homes only on their own land, not in a park. Company name NorCal Home Offer only if asked. Based in Redding.',
    category: 'internal',
  },
];

/** Old dashboard scripts that coach cold follow-up or impersonation. Turned off, not deleted. */
const RETIRED_QUESTIONS = [
  'What if they say not right now?',
  'How do I follow up after no response?',
  'What if they want more than market value?',
  'What do you say to absentee owners?',
  'Expired listings approach',
  'Best time to text',
  'How many times should I follow up?',
  'What sells the deal?',
  'What if they say yes?',
  'AI_INTERNAL: Business model',
  'AI_INTERNAL: Offer criteria',
];

const BAD_ANSWER = [
  /7\s*[-–to]{1,3}\s*14\s*days/i,
  /close in 7/i,
  /close in 2 weeks/i,
  /cash in your hand in 14/i,
  /cover all closing costs/i,
  /\bno fees\b/i,
  /walk away with/i,
  /\bBBB\b/,
  /Better Business Bureau/i,
  /voice notes?/i,
  /no automation/i,
  /\bnot a bot\b/i,
  /70-75%\s*of ARV/i,
  /\$\s?\d{2,3},?\d{3}/,
  /this is derek from/i,
  /this is d\b/i,
  /i am an investor/i,
  /i'?m an investor/i,
  /no realtor fees/i,
];

function syncKnowledgeBase(db) {
  const find = db.prepare('SELECT id FROM knowledge_base WHERE question = ?');
  const update = db.prepare('UPDATE knowledge_base SET answer = ?, category = ?, active = 1 WHERE id = ?');
  const insert = db.prepare('INSERT INTO knowledge_base (question, answer, category, active) VALUES (?, ?, ?, 1)');
  const canonicalIds = new Set();

  const tx = db.transaction(() => {
    for (const entry of CANONICAL_KB) {
      const rows = find.all(entry.question);
      if (rows.length === 0) {
        const info = insert.run(entry.question, entry.answer, entry.category);
        canonicalIds.add(Number(info.lastInsertRowid));
      } else {
        for (const row of rows) {
          update.run(entry.answer, entry.category, row.id);
          canonicalIds.add(Number(row.id));
        }
      }
    }

    const deactivated = [];
    const active = db.prepare('SELECT id, question, answer FROM knowledge_base WHERE active = 1').all();
    const turnOff = db.prepare('UPDATE knowledge_base SET active = 0 WHERE id = ?');
    const retired = new Set(RETIRED_QUESTIONS);
    for (const row of active) {
      if (canonicalIds.has(Number(row.id))) continue;
      const hay = `${row.question}\n${row.answer}`;
      if (retired.has(row.question) || BAD_ANSWER.some((re) => re.test(hay))) {
        turnOff.run(row.id);
        deactivated.push(row.question);
      }
    }
    return deactivated;
  });

  const deactivated = tx();
  return { upserted: CANONICAL_KB.length, deactivated };
}

module.exports = { CANONICAL_KB, BAD_ANSWER, RETIRED_QUESTIONS, syncKnowledgeBase };
