-- ================================================================
-- NorCal Home Offer - AI SMS Agent Knowledge Base
-- Based on top wholesalers: Jerry Norton, King Khan, RJ Bates, Steven Trang
-- ================================================================

-- First, clear old articles and start fresh
DELETE FROM knowledge_base;

-- ── 1. INITIAL COLD BLAST RESPONSES ──
-- When a lead replies to your initial cold text

INSERT INTO knowledge_base (question, answer, category) VALUES
('Who is this?', 
'This is Derek from NorCal Home Offer. I''m an investor buying homes in your area for CASH. We buy AS-IS — no repairs, no cleaning, no realtor fees. If you''ve ever thought about selling, we can make a fair offer and close on YOUR timeline. Text me your address and I''ll run the numbers! 🏠'),

('How did you get my number?',
'I got your number from county tax records — it''s public info. I saw you own a property in the area and wanted to reach out direct. No brokers, no websites, just me reaching out to see if you''re open to a conversation about selling. No pressure at all!'),

('Stop', 'STOP'),
('Unsubscribe', 'STOP'),
('Not interested',
'No worries! I get it. If things change down the road, feel free to reach out anytime. I''ll leave you alone. Have a good one! 🙌'),

('Leave me alone',
'Sorry for bothering you! You''re removed from my list. If you ever need a fast cash offer in the future, just text me. Take care!'),

('How much can you offer?',
'Great question! Every house is different, but here''s how I work: I look at what similar homes have sold for in your area, subtract what needs to be fixed, and make a fair CASH offer. I don''t need an appraisal, bank, or realtor. Want me to run the numbers on your property? Just send me the address!'),

('Send me the address for a text blast', 
'Your approach is on point. For cold SMS, the key is keeping it short and value-driven. Here''s what works from Jerry Norton and King Khan''s playbook: "Hey [Name], I''m looking to buy a 3bd/2ba in your area and saw your property. Want a fast cash offer — no repairs needed, close on your timeline. Interested?" Keep it under 160 chars for one SMS segment.'),

('What do you say in the first text?',
'Here''s the formula Jerry Norton teaches: "Hi [Name], I''m looking to buy in [area]. Would you take $XXX,XXX for your property on [Street]? Cash, as-is, close in 2 weeks. Text me YES or your best number." Keep it direct. King Khan says: "The first text needs a hook AND a price. Without either, they ignore it."'),

('How do you handle the price objection?',
'Steven Trang''s approach: When they say "that''s too low," don''t argue. Say: "I hear you. What number would work for you?" Get them to name their price first. RJ Bates says: "The price is always negotiable — but I need to know what they want first. Never negotiate against yourself."'),

('What if they say not right now?',
'Classic objection. Jerry Norton says: "Put them in a 30/60/90 day follow-up sequence." Reply: "Totally understand. Can I check back in 60 days? A lot changes in 2 months." If they say yes → hot lead. If they say no → ask: "What WOULD make you sell?" That''s gold.'),

('How do I follow up after no response?',
'King Khan''s rule: "Text 3 times, then call. Never more than 5 texts without a response." Day 3: "Hey [Name], still interested in that cash offer. Market''s hot right now — want me to run numbers real quick?" Day 7: "Last text — if you''re serious about selling, I can close in 2 weeks. Text YES."'),

('How many times should I text?',
'Steven Trang says: "7 touches minimum before you give up." Mix of texts, calls, and voicemails. Jerry Norton: "Most deals happen on touch 3-5. Don''t quit after one text. They''re busy, not ignoring you."'),

('What time of day should I send texts?',
'Best times from the pros: Weekdays 10am-12pm or 4pm-6pm. Weekends 11am-2pm. Avoid Monday mornings and Friday after 4pm. RJ Bates: "Tuesday-Thursday are your money days. That''s when people are in the routine and actually read texts."'),

('Should I mention "we buy ugly houses"?',
'Nope. Jerry Norton: "You''re buying HOUSES, not ugly ones. Say: We buy homes AS-IS. That''s less insulting and gets better responses." Steven Trang agrees: "Position it as convenience, not pity. They''re selling their biggest asset."'),

('What if they ask if I''m a realtor?',
'Be honest. King Khan: "I''m a cash home buyer. No realtor fees, no commissions, no listing. I buy directly and close fast." RJ Bates: "If they think you''re a realtor, they''ll expect a listing appointment. Make it clear you''re a CASH BUYER from the start."'),

('What about expired listings?',
'Goldmine. Jerry Norton: "Text the owner of an expired listing: Hey [Name], saw your house didn''t sell on the market. I buy cash as-is. No realtor headaches. Want a quick offer?" King Khan: "Expireds are the best leads. They already wanted to sell. The market said no. Now you''re the solution."'),

('How do I handle "I need to talk to my spouse"?',
'Total respect answer: "Of course! Talk it over. Can I send over the numbers for you both to look at? No pressure to say yes." RJ Bates: "Get the husband/wife''s number too. Text both of them. If only one is on the thread, the deal dies."'),

('What if they want way more than market value?',
'Be straight with them. Steven Trang: "I totally understand you want top dollar. Here''s what I can do — $XXX,XXX cash, close in 2 weeks, no repairs. If you want to try the market first, no hard feelings. My offer stands." King Khan: "Sometimes you gotta let them learn the hard way. Circle back in 6 months."'),

('How do I use scarcity in texts?',
'RJ Bates: "I buy 1-2 houses per month in this area. If I fill my buys, I move to the next area. If you''re interested, let''s talk this week." Jerry Norton: "We''re only buying 2 more properties this quarter. After that we''re on buying pause until next season." Create real FOMO.'),

('Should I text on weekends?',
'Yes. Steven Trang: "Saturday morning texts get opened more than weekday texts. People are relaxed, browsing their phone, not stressed about work." Jerry Norton: "Sunday afternoon is prime time. 2-4pm. They''re home, bored, and actually reading messages."'),

('What''s the best way to handle a lead that''s ready to sell?',
'Act fast. King Khan: "When they say yes, you move. Same day. Get the address, run comps, send a offer within 24 hours. Cold leads go cold fast." RJ Bates: "Have your contract ready. Text them the numbers, set up a walkthrough for next day. Momentum kills."'),

('How do I price the offer in the first text?',
'Jerry Norton: "Offer 70-75% of ARV minus repairs. But don''t lead with that. Lead with: I can offer $XXX,XXX. If they bite, you negotiate up. If they''re insulted, you ask what they want." Steven Trang: "I always ask them what they want first. They''ll tell you their number, then you work from there."'),

('How do I handle "my house is worth more"?',
'King Khan: "You might be right. Let me come take a look and make my best offer. Based on what I see, I''ll give you a fair number." Don''t argue comps over text. RJ Bates: "Get eyes on the property. Text is for setting appointments, not negotiating."'),

('What if they want to use a realtor?',
'Respect it. "Totally fine! Just know that after 6% commission and closing costs, you''ll net about $XX less. My cash offer is commission-free. If the market doesn''t work out, I''m here." Jerry Norton says: "Don''t badmouth realtors. Just state the math."'),

('What do I say to absentee owners?',
'King Khan: "Hi [Name], you own [address] but don''t live there anymore. Looking to sell it? I buy as-is, cash, fast close. No need to fix anything or even come to town." Steven Trang: "Absentee owners are the best leads. They ALREADY want to sell, they just haven''t pulled the trigger."'),

('What about inherited properties?',
'Jerry Norton: "Hey, sorry for your loss. I buy inherited homes as-is. If you''re looking to sell quickly without fixing anything, I can help. Cash offer in 24 hours." Be respectful. King Khan: "Inherited properties have motivated sellers. They just want to unload it. Be the solution."'),

('How do I handle the "I''ll think about it" brush off?',
'Steven Trang: "What specifically do you need to think about? Price? Timing? Trust? Let me address whatever''s holding you back." RJ Bates: "I''ll think about it = no. They need a reason to say yes. Find the pain point: taxes, repairs, divorce, moving, money."'),

('What''s the one sentence that closes deals?',
'Jerry Norton: "I can have cash in your hand in 14 days, no repairs, no cleaning, no realtor." King Khan: "I buy houses like yours every week. Here are the numbers. Yes or no?" Steven Trang: "What would it take for us to make a deal today?"'),

('How do I text someone who said no 6 months ago?',
'Confidence. "Hey [Name], hope you''re doing well. I''m back in your area buying. Market''s changed — want me to run fresh comps on your place?" RJ Bates: "No is just no FOR NOW. Conditions change. Debt, divorce, death, desire. Check back every 90 days."'),

('What''s the biggest mistake in SMS wholesaling?',
'Jerry Norton: "Talking too much. The first text should be 2-3 sentences. Get to the point. They read texts in 3 seconds." King Khan: "Not following up. Most people say no or ignore. The ones who say yes come on text 3 or 4." Steven Trang: "Being aggressive. Cold texts should be helpful, not pushy. You''re offering a solution."')
;

-- Add some internal notes for Derek (not sent to leads, but for the AI agent context)
INSERT INTO knowledge_base (question, answer, category) VALUES
('AI_INTERNAL: What is my business model?',
'NorCal Home Offer buys single-family homes in Northern California (Sacramento, Yolo, Placer, El Dorado counties). We wholesale — meaning we find deals, put them under contract, and assign or sell to cash buyers. We offer cash, close fast, buy as-is.'),

('AI_INTERNAL: What areas do I buy?',
'Sacramento County, Yolo County, Placer County, El Dorado County, and surrounding areas in Northern California. Focus on the greater Sacramento metro area.'),

('AI_INTERNAL: What''s my max offer criteria?',
'We aim for 70-75% of ARV minus repairs. We need our buyers/investors to make at least 20% margin. Priced under $700K preferred. We won''t go above $1M without a buyer already lined up.');
