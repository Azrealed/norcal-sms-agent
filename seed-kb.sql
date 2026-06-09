-- Seed knowledge base for NorCal Home Offer
-- Run: sqlite3 data/sms-agent.db < seed-kb.sql

INSERT INTO knowledge_base (question, answer, category) VALUES
('What areas do you buy in?', 'We buy houses in Sacramento, Yolo, Placer, El Dorado, and surrounding counties in Northern California. If you''re not sure if we cover your area, just send us your address and we''ll let you know!', 'areas'),
('How does your cash offer work?', 'We make a fair cash offer for your home as-is. No repairs needed, no cleaning required. We handle all the paperwork and closing costs. You choose the closing date that works best for you.', 'process'),
('Do I need to make repairs before selling?', 'No! We buy houses in ANY condition. No repairs, no cleaning, no staging. We take it exactly as-is. This saves you thousands in fix-up costs and months of work.', 'process'),
('How fast can you close?', 'We can close in as little as 7-14 days, or we can work around your timeline. If you need more time to find your next place, we can schedule the closing for whenever works best for you.', 'process'),
('Do you pay closing costs?', 'Yes! We cover all closing costs. No realtor commissions, no fees, no hidden costs. The price we offer is what you walk away with.', 'process'),
('What if my house needs major repairs?', 'That''s exactly the kind of house we''re looking for! We buy homes in any condition - whether it needs a new roof, foundation issues, old plumbing, or just needs some TLC. We handle it all.', 'process'),
('How is your price determined?', 'We look at recent comparable sales in your area, the condition of the home, and what we need to invest to resell it. Our goal is to make a fair offer that works for both of us - a win-win.', 'offers'),
('Is my information kept private?', 'Yes, absolutely. Your information is confidential and will never be shared with third parties. We respect your privacy.', 'general'),
('What type of properties do you buy?', 'We buy single-family homes, townhouses, condos, duplexes, triplexes, fourplexes, and vacant land. Basically any residential property in Northern California.', 'general'),
('Do I have to let people walk through my house?', 'Nope! Since we buy as-is, we typically just do a quick walkthrough to confirm the condition. No open houses, no showings, no strangers walking through your home.', 'process');
