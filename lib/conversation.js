/**
 * Conversation Engine
 * Drives seller conversations through the qualification funnel.
 * Extracts property details, scores leads, and generates replies.
 *
 * Rules-based for reliability. Can be extended with LLM for more natural
 * conversations — see the generateReply() method for the integration point.
 */

// Conversation stages (inlined to avoid dependency)
const STAGES = {
  NEW: 'new',
  GREETING: 'greeting',
  PROPERTY_ADDRESS: 'property_address',
  PROPERTY_CONDITION: 'property_condition',
  ASKING_PRICE: 'asking_price',
  MOTIVATION: 'motivation',
  TIMELINE: 'timeline',
  OFFER_DISCUSSION: 'offer_discussion',
  NEGOTIATING: 'negotiating',
  HOT_LEAD: 'hot_lead',
  COLD: 'cold',
  CLOSED: 'closed',
};

// Patterns for extracting information from messages
const PATTERNS = {
  // Address patterns
  address: /(\d+[\s\w]+\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|circle|cir|court|ct|way|place|pl|boulevard|blvd|highway|hwy|trail|trl|parkway|pkwy)\b[,\s]*[\w\s]*(?:,\s*\w{2}\s*\d{5})?)/i,

  // Zip code
  zipcode: /\b(\d{5})(?:-\d{4})?\b/,

  // Price mentions: "$150,000", "150k", "150 thousand"
  // Must have $ prefix OR price unit suffix (k/thousand/million) — not bare numbers
  price: /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(k|thousand|million|m)?\b|\b(\d{1,3}(?:,\d{3})*)\s*(k|thousand|million|m)\b/i,

  // Motivation indicators (scoring keywords)
  motivated_keywords: [
    'urgent', 'asap', 'quick', 'fast', 'need to sell', 'must sell',
    'motivated', 'desperate', 'foreclosure', 'pre-foreclosure', 'behind on payments',
    'divorce', 'inherited', 'vacant', 'empty', 'relocation', 'relocate',
    'tired of being a landlord', 'tenant issues', 'bad tenant',
    'fixer', 'needs work', 'as-is', 'as is', 'cash offer',
    'any condition', 'ugly house', 'distressed',
  ],

  // Cold indicators
  cold_keywords: [
    'just looking', 'just curious', 'not sure', 'maybe later', 'not in a rush', 'no rush',
    'exploring options', 'top dollar', 'market value', 'retail price', 'full price',
    'realtor', 'real estate agent', 'agent', 'listing', 'mls', 'zestimate',
  ],

  // Condition indicators
  excellent_condition: ['move-in ready', 'remodeled', 'renovated', 'excellent', 'great shape', 'perfect', 'updated'],
  good_condition: ['good', 'decent', 'clean', 'well maintained', 'minor'],
  fair_condition: ['needs work', 'cosmetic', 'outdated', 'old', 'fixer', 'handyman'],
  poor_condition: ['major repairs', 'structural', 'gut', 'tear down', 'hoarder', 'severe damage', 'fire', 'flood', 'mold'],
};

/**
 * Determine conversation stage from incoming message
 */
function determineStage(lead, message) {
  const lower = message.toLowerCase();
  const stage = lead.stage;

  // Check for cold signals at any stage
  const coldHits = PATTERNS.cold_keywords.filter(k => lower.includes(k));
  if (coldHits.length >= 2) return { stage: STAGES.COLD, reason: `${coldHits.length} cold signals detected` };

  // Stage-specific detection
  switch (stage) {
    case STAGES.NEW:
    case STAGES.GREETING:
      // Look for address
      if (PATTERNS.address.test(message) || PATTERNS.zipcode.test(message)) {
        return { stage: STAGES.PROPERTY_ADDRESS, reason: 'Address/zip detected' };
      }
      return { stage: STAGES.GREETING };

    case STAGES.PROPERTY_ADDRESS:
      if (PATTERNS.price.test(message)) {
        return { stage: STAGES.ASKING_PRICE, reason: 'Price mentioned' };
      }
      if (checkCondition(message)) {
        return { stage: STAGES.PROPERTY_CONDITION, reason: 'Condition described' };
      }
      return { stage: STAGES.PROPERTY_ADDRESS };

    case STAGES.PROPERTY_CONDITION:
      if (PATTERNS.price.test(message)) {
        return { stage: STAGES.ASKING_PRICE, reason: 'Price mentioned' };
      }
      return { stage: STAGES.PROPERTY_CONDITION };

    case STAGES.ASKING_PRICE:
      if (checkMotivation(message)) {
        return { stage: STAGES.MOTIVATION, reason: 'Motivation detected' };
      }
      return { stage: STAGES.ASKING_PRICE };

    case STAGES.MOTIVATION:
      if (lower.includes('when') || lower.includes('timeline') || lower.includes('soon') || lower.includes('asap')) {
        return { stage: STAGES.TIMELINE, reason: 'Timeline discussed' };
      }
      return { stage: STAGES.OFFER_DISCUSSION };

    default:
      return { stage };
  }
}

/**
 * Extract property information from a message
 */
function extractPropertyInfo(message, lead) {
  const info = {};
  const lower = message.toLowerCase();

  // Extract address
  const addrMatch = message.match(PATTERNS.address);
  if (addrMatch) info.address = addrMatch[1].trim();

  // Extract zip
  const zipMatch = message.match(PATTERNS.zipcode);
  if (zipMatch) info.zipcode = zipMatch[1];

  // Extract price — handles both "$350,000" and "350k" formats
  const priceMatch = message.match(PATTERNS.price);
  if (priceMatch) {
    // Groups: ($1=dollar-amount, $2=dollar-suffix) | ($3=bare-amount, $4=bare-suffix)
    let price, multiplier;
    if (priceMatch[1]) {
      price = parseFloat(priceMatch[1].replace(/,/g, ''));
      multiplier = priceMatch[2];
    } else if (priceMatch[3]) {
      price = parseFloat(priceMatch[3].replace(/,/g, ''));
      multiplier = priceMatch[4];
    }
    if (price && !isNaN(price)) {
      if (multiplier === 'k' || multiplier === 'thousand') price *= 1000;
      else if (multiplier === 'm' || multiplier === 'million') price *= 1000000;
      info.askingPrice = price;
    }
  }

  // Extract condition
  const condition = checkCondition(message);
  if (condition) info.condition = condition;

  return info;
}

function checkCondition(message) {
  const lower = message.toLowerCase();
  if (PATTERNS.excellent_condition.some(k => lower.includes(k))) return 'excellent';
  if (PATTERNS.poor_condition.some(k => lower.includes(k))) return 'poor';
  if (PATTERNS.fair_condition.some(k => lower.includes(k))) return 'fair';
  if (PATTERNS.good_condition.some(k => lower.includes(k))) return 'good';
  return null;
}

function checkMotivation(message) {
  const lower = message.toLowerCase();
  return PATTERNS.motivated_keywords.filter(k => lower.includes(k));
}

/**
 * Score a message and return point adjustments
 */
function scoreMessage(message, lead) {
  const lower = message.toLowerCase();
  let points = 0;
  const reasons = [];

  // Provided address → +15
  if (PATTERNS.address.test(message) || PATTERNS.zipcode.test(message)) {
    if (!lead.property.address) {
      points += 15;
      reasons.push('Provided property address/location');
    }
  }

  // Provided price → +10
  const priceMatch = message.match(PATTERNS.price);
  if (priceMatch && !lead.property.askingPrice) {
    points += 10;
    reasons.push('Provided asking price');
  }

  // Motivation signals → +8 each
  const motivations = checkMotivation(message);
  if (motivations.length > 0) {
    const bonus = Math.min(motivations.length * 8, 30);
    points += bonus;
    reasons.push(`Motivation signals: ${motivations.join(', ')}`);
  }

  // Distressed condition → +5 to +15
  const condition = checkCondition(message);
  if (condition === 'poor') { points += 15; reasons.push('Poor property condition (distressed)'); }
  if (condition === 'fair') { points += 8; reasons.push('Fair condition (needs work)'); }

  // Cold signals → negative
  const coldHits = PATTERNS.cold_keywords.filter(k => lower.includes(k));
  if (coldHits.length > 0) {
    const penalty = Math.min(coldHits.length * 5, 20);
    points -= penalty;
    reasons.push(`Cold signals: ${coldHits.join(', ')}`);
  }

  // Message length (engaged sellers write more)
  if (message.length > 100) { points += 3; reasons.push('Detailed response (engaged)'); }

  return { points, reasons: reasons.join('; ') };
}

/**
 * Generate the next reply based on lead stage and context.
 *
 * 🧠 LLM INTEGRATION POINT:
 * Replace this function with an LLM API call (OpenAI, Claude, etc.)
 * Pass in: stage, lead.history, lead.property, business context
 * The LLM should return a natural, empathetic reply that moves the conversation forward.
 */
/**
 * Pick a reply variant, avoiding repetition of the last message sent.
 * Rotates through variants based on history to prevent back-to-back repeats.
 */
function pickReply(variants, lead) {
  if (variants.length === 0) return '';
  if (variants.length === 1) return variants[0];

  // Find the last outbound message sent at this stage
  let lastIndex = -1;
  const history = lead.history || [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].direction === 'outbound') {
      lastIndex = variants.indexOf(history[i].text);
      break;
    }
  }

  // Pick a different variant than the last one
  if (lastIndex >= 0 && variants.length > 1) {
    const available = variants.filter((_, i) => i !== lastIndex);
    return available[Math.floor(Math.random() * available.length)];
  }

  return variants[Math.floor(Math.random() * variants.length)];
}

function generateReply(lead, inboundMessage) {
  const name = lead.name || 'there';
  const stage = lead.stage;
  const addr = lead.property?.address || 'the property';

  const replies = {
    [STAGES.GREETING]: [
      `Hi! Thanks for reaching out about selling your property. I'm helping investors find properties in this area. Could you tell me the property address or at least the zip code?`,
      `Hey there! I work with investors buying properties throughout Northern California. What's the property address you're thinking about selling?`,
      `Hi! I appreciate you getting in touch. To get started, what's the address of the property you're looking to sell?`,
    ],

    [STAGES.PROPERTY_ADDRESS]: [
      `I'll need the property address to give you any meaningful info. What's the address or at least the zip code?`,
      `Before I can help, I need to know which property we're talking about. Could you share the address?`,
      `To move forward, I'd need the property address first. Even just the zip code helps — what area is it in?`,
    ],

    [STAGES.PROPERTY_CONDITION]: [
      `Thanks! What kind of shape is ${addr} in — move-in ready, needs some cosmetic work, or more of a fixer?`,
      `Got it. Can you describe the condition of ${addr}? Everything updated and move-in ready, or does it need some TLC?`,
      `What's the condition like at ${addr}? Any major repairs needed, or is it pretty well maintained?`,
    ],

    [STAGES.ASKING_PRICE]: [
      `Thanks for sharing that. If you don't mind me asking — what's motivating the sale? Are you looking to move quickly, or is there flexibility on timing?`,
      `Understood. What's driving your decision to sell right now? Is there a particular timeline you're working with?`,
      `Good to know. Out of curiosity, what's prompting the sale — relocating, investment reasons, or something else?`,
    ],

    [STAGES.MOTIVATION]: [
      `I appreciate you sharing that. Based on what you've told me, I think we could potentially put together an offer. What's your ideal timeline for closing?`,
      `That makes sense. Let me work on putting numbers together for you. What kind of closing timeline are you hoping for?`,
      `Got it — that's helpful context. Ideally, when would you want to close? A few weeks, a month, longer?`,
    ],

    [STAGES.TIMELINE]: [
      `That timeline works. Let me discuss with my team and get back to you shortly. In the meantime, is there anything else about ${addr} I should know?`,
      `Great, we can work with that. I'll run the numbers and circle back soon. Anything else about ${addr} that's worth mentioning?`,
      `Perfect — that gives us a solid window. I'll work up an offer and follow up shortly. Any other details about ${addr} I should factor in?`,
    ],

    [STAGES.OFFER_DISCUSSION]: [
      `Thanks for all the info — this sounds like it could be a good fit. I'm going to run the numbers and get back to you with an offer. Should have something within 24 hours.`,
      `Really appreciate the details. Let me crunch the numbers and I'll have an offer for you soon. Expect to hear back within a day.`,
      `This looks promising. I'll put together a cash offer based on what you've shared and get back to you, likely within 24 hours.`,
    ],

    [STAGES.HOT_LEAD]: [
      `I've reviewed everything and I'm confident we can make this work. Let me get you connected with someone who can finalize the details. Expect a call shortly.`,
    ],

    [STAGES.COLD]: [
      `No problem at all — I understand. If anything changes or you decide you'd like to revisit selling, just text me anytime. Best of luck!`,
    ],
  };

  const variants = replies[stage] || replies[STAGES.GREETING];
  return pickReply(variants, lead);
}

/**
 * Process a full inbound message cycle:
 * 1. Record the message
 * 2. Update lead stage
 * 3. Extract property data
 * 4. Score the lead
 * 5. Generate a reply
 */
function processMessage(leadManager, fromNumber, messageText) {
  // Record inbound message
  leadManager.addMessage(fromNumber, 'inbound', messageText);
  let lead = leadManager.getOrCreate(fromNumber);

  // Extract property info
  const propInfo = extractPropertyInfo(messageText, lead);
  if (Object.keys(propInfo).length > 0) {
    lead = leadManager.updateProperty(fromNumber, propInfo);
  }

  // Determine new stage
  const { stage, reason } = determineStage(lead, messageText);
  if (stage !== lead.stage) {
    lead = leadManager.update(fromNumber, { stage });
  }

  // Score the message
  const { points, reasons } = scoreMessage(messageText, lead);
  if (points !== 0) {
    lead = leadManager.addScore(fromNumber, points, reasons);
  }

  // Reload after all updates
  lead = leadManager.getOrCreate(fromNumber);

  // Generate reply
  const reply = generateReply(lead, messageText);

  // Record outbound reply
  leadManager.addMessage(fromNumber, 'outbound', reply);

  return { lead, reply };
}

module.exports = {
  processMessage,
  determineStage,
  extractPropertyInfo,
  scoreMessage,
  generateReply,
  STAGES,
};
