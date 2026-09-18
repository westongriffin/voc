/* tests/test_classify.js — VOC.classify: gold sentences → category/subcategory, product detection, safety,
 * urgency, entities, noise, language gate, preprocess, sentiment sign, full classifyRecord. Runs under jsc via tests/run.sh. */
(function () {
  'use strict';
  var failures = 0, total = 0;
  function assert(cond, msg) {
    total += 1;
    if (cond) console.log('PASS ' + msg);
    else { failures += 1; console.log('FAIL ' + msg); }
  }
  var C = VOC.classify, R = VOC.rules, L = VOC.lexicon;
  assert(C && R && L, 'VOC.classify, VOC.rules and VOC.lexicon load');
  assert(L.version === '1.0.0' && R.version === '1.0.0' && C.version === '1.0.0', 'versions');
  assert(Object.keys(L.BASE).length >= 450 && Object.keys(L.DOMAIN).length >= 120 && L.STOPWORDS.length >= 170, 'lexicon sizes (BASE ≥450, DOMAIN ≥120, STOPWORDS ≥170)');
  assert(L.valence('love') === 3.2 && L.valence('terrible') === -3.1 && L.valence('prolon') === undefined && L.valence('delicious') === 2.0, 'lexicon.valence base/domain/brand');

  /* Rules shape: every SPEC §3 category and subcategory, 3–10 patterns each */
  var EXPECTED = {
    subscription_billing: ['unauthorized_signup', 'auto_renew_surprise', 'cancel_friction', 'post_cancel_shipment', 'duplicate_charge', 'refund_status', 'promo_not_applied', 'discount_math', 'pause_skip'],
    checkout_website: ['checkout_error', 'mobile_checkout', 'unwanted_addon', 'promo_code', 'hcp_code_entry', 'login_account', 'app_bug'],
    shipping_fulfillment: ['late', 'lost', 'tracking', 'porch_drop', 'heat_damage', 'international_customs'],
    missing_damaged: ['missing_item', 'welcome_kit_missing', 'leaking', 'crushed_melted', 'damaged_seal'],
    taste_quality: ['soup_taste', 'texture', 'l_drink_taste', 'olives', 'bar_taste', 'portion', 'expiry_short_dated'],
    foreign_material_allergen: ['hard_bits', 'shell_fragment', 'allergen_exposure', 'mold_spoilage', 'undeclared_allergen'],
    side_effects: ['hunger', 'headache', 'fatigue', 'dizziness', 'brain_fog', 'nausea_gi', 'cold', 'sleep', 'inulin_ibs'],
    adverse_event: ['fainting', 'er_hospital', 'allergic_reaction', 'hypoglycemia_medication', 'pregnancy_minor', 'chest_pain'],
    efficacy_results: ['weight_loss', 'no_results', 'regain', 'energy_clarity', 'labs_biomarkers'],
    price_value: ['too_expensive', 'per_day_cost', 'hsa_fsa', 'bundle_value', 'price_increase'],
    customer_service: ['no_response', 'slow_response', 'wrong_item_sent', 'great_agent', 'chatbot_loop'],
    hcp_practitioner: ['account_setup', 'bulk_order', 'patient_protocol', 'evidence_request'],
    marketing_email: ['too_many_emails', 'influencer_skepticism', 'misleading_claim'],
    usage_guidance: ['coffee_exercise', 'medications', 'refeed_transition', 'cycle_frequency', 'general_question'],
    product_request: ['new_flavor', 'allergen_free', 'sample_pack', 'longer_program'],
    praise: ['results_praise', 'convenience', 'cs_praise', 'nextgen_taste', 'general_praise'],
    other_noise: ['auto_reply', 'bounce', 'newsletter', 'duplicate']
  };
  var shapeOk = true, byId = {};
  R.categories.forEach(function (c) { byId[c.id] = c; });
  Object.keys(EXPECTED).forEach(function (cid) {
    var cat = byId[cid];
    if (!cat) { shapeOk = false; console.log('  missing category ' + cid); return; }
    var subIds = cat.subcategories.map(function (s) { return s.id; });
    EXPECTED[cid].forEach(function (sid) { if (subIds.indexOf(sid) < 0) { shapeOk = false; console.log('  missing subcategory ' + cid + '/' + sid); } });
    if (subIds.length !== EXPECTED[cid].length) { shapeOk = false; console.log('  extra subcategories in ' + cid); }
    cat.subcategories.forEach(function (s) {
      if (s.patterns.length < 3 || s.patterns.length > 10) { shapeOk = false; console.log('  pattern count ' + cid + '/' + s.id + ' = ' + s.patterns.length); }
      s.patterns.forEach(function (p) { if (!(p.re instanceof RegExp) || !(p.w >= 1 && p.w <= 3)) shapeOk = false; });
    });
  });
  assert(R.categories.length === 17 && shapeOk, 'rules cover all 17 categories / 94 subcategories with 3–10 weighted patterns');

  /* Gold sentences: [text, category, subcategory|null] */
  var GOLD = [
    ['You signed me up for a subscription without my permission and charged my card.', 'subscription_billing', 'unauthorized_signup'],
    ['My subscription auto-renewed and I was charged again without any warning.', 'subscription_billing', 'auto_renew_surprise'],
    ['There is no cancellation link anywhere. I cannot cancel my subscription.', 'subscription_billing', 'cancel_friction'],
    ['I cancelled weeks ago and you still shipped another box and charged me.', 'subscription_billing', 'post_cancel_shipment'],
    ['I was charged twice for order #123456. Please refund the duplicate charge.', 'subscription_billing', 'duplicate_charge'],
    ['Where is my refund? It has been 3 weeks and nothing has posted.', 'subscription_billing', 'refund_status'],
    ['The promo code was not applied at checkout and I was charged full price.', 'subscription_billing', 'promo_not_applied'],
    ['Can I pause my subscription for two months?', 'subscription_billing', 'pause_skip'],
    ['The checkout page kept giving an error when I tried to pay.', 'checkout_website', 'checkout_error'],
    ['A Fast Bar box was automatically added to my cart and I never wanted it.', 'checkout_website', 'unwanted_addon'],
    ['My doctor gave me a practitioner code PP-12345 but it will not apply at checkout.', 'checkout_website', 'hcp_code_entry'],
    ["I can't log in to my account; the password reset email never arrives.", 'checkout_website', 'login_account'],
    ['The app crashes every time I open the day tracker.', 'checkout_website', 'app_bug'],
    ['My order still hasn\'t arrived. Tracking has not updated in 6 days. FedEx says label created.', 'shipping_fulfillment', null],
    ['USPS marked it delivered but I never received the package.', 'shipping_fulfillment', 'lost'],
    ['The package was left on the porch in the rain and the box was soaked.', 'shipping_fulfillment', 'porch_drop'],
    ['The bars arrived melted after sitting in the heat.', 'shipping_fulfillment', 'heat_damage'],
    ['Package is held at customs and they want import duties.', 'shipping_fulfillment', 'international_customs'],
    ['Day 3 box was missing the olives and the kale crackers.', 'missing_damaged', 'missing_item'],
    ['There was no welcome kit or instructions in the box.', 'missing_damaged', 'welcome_kit_missing'],
    ['The L-Drink leaked all over the inside of the box, everything is sticky.', 'missing_damaged', 'leaking'],
    ['The box arrived crushed and the bars were in pieces.', 'missing_damaged', 'crushed_melted'],
    ['The seal on the tomato soup was broken when it arrived.', 'missing_damaged', 'damaged_seal'],
    ['The minestrone soup tasted bland and watery, like astronaut food.', 'taste_quality', 'soup_taste'],
    ['The shake was chalky and gritty and would not dissolve.', 'taste_quality', 'texture'],
    ['The L-Drink tastes like cough syrup, way too sweet.', 'taste_quality', 'l_drink_taste'],
    ['The olives were mushy and slimy.', 'taste_quality', 'olives'],
    ['The L-Bar was dry and crumbly, honestly stale.', 'taste_quality', 'bar_taste'],
    ['The soups expire next month, short dated stock.', 'taste_quality', 'expiry_short_dated'],
    ['I found hard bits in the Minestrone Quinoa soup, lot NG-0426-B. I think I chipped a tooth.', 'foreign_material_allergen', 'hard_bits'],
    ['There was a piece of nut shell in my L-Bar.', 'foreign_material_allergen', 'shell_fragment'],
    ['The mushroom soup smelled off and had fuzzy spots, looked moldy.', 'foreign_material_allergen', 'mold_spoilage'],
    ['The label does not list soy but the ingredients say soy lecithin. Undeclared allergen!', 'foreign_material_allergen', 'undeclared_allergen'],
    ['I was so hungry on day 2, constant cravings.', 'side_effects', 'hunger'],
    ['Day 3 headache that would not go away.', 'side_effects', 'headache'],
    ['I felt so tired and had no energy at all on day 4.', 'side_effects', 'fatigue'],
    ['Got dizzy and lightheaded standing up.', 'side_effects', 'dizziness'],
    ['Brain fog all day, could not concentrate at work.', 'side_effects', 'brain_fog'],
    ['Nauseous and bloated after the L-Drink, stomach cramps too.', 'side_effects', 'nausea_gi'],
    ['I was freezing the whole time, cold hands and feet.', 'side_effects', 'cold'],
    ['Could not fall asleep and woke up at 3am hungry.', 'side_effects', 'sleep'],
    ['The inulin in the bars gave me terrible gas, I have IBS.', 'side_effects', 'inulin_ibs'],
    ['I fainted on day 3 and my husband called an ambulance. I spent the night in the ER.', 'adverse_event', null],
    ['I had an allergic reaction with hives and my throat closed, used my EpiPen.', 'adverse_event', 'allergic_reaction'],
    ['My blood sugar crashed to 55 while on metformin and I ended up in the hospital.', 'adverse_event', 'hypoglycemia_medication'],
    ['I am pregnant and want to do a cycle, is it safe?', 'adverse_event', 'pregnancy_minor'],
    ['Chest pain and heart racing on day 2, went to urgent care.', 'adverse_event', 'chest_pain'],
    ['I lost 6 lbs and my pants fit better!', 'efficacy_results', 'weight_loss'],
    ['No results at all. Did not lose a single pound. Waste of money.', 'efficacy_results', 'no_results'],
    ['I gained it all back within a week. Just water weight.', 'efficacy_results', 'regain'],
    ['So much energy on day 4 and amazing mental clarity.', 'efficacy_results', 'energy_clarity'],
    ['My A1c dropped from 6.2 to 5.6 and my doctor was impressed with my labs.', 'efficacy_results', 'labs_biomarkers'],
    ['$250 for five days of soup is too expensive, I cannot afford it.', 'price_value', 'too_expensive'],
    ['That works out to $40 a day for soup.', 'price_value', 'per_day_cost'],
    ['Can I use my HSA or FSA card to pay for ProLon?', 'price_value', 'hsa_fsa'],
    ['Is there a discount for buying a 3-pack bundle?', 'price_value', 'bundle_value'],
    ['The price went up $50 since last year. It used to be $199.', 'price_value', 'price_increase'],
    ['I have emailed three times and gotten no response. Being ignored.', 'customer_service', 'no_response'],
    ['It took eight days for someone to reply to my ticket.', 'customer_service', 'slow_response'],
    ['You sent me the original kit instead of the Next Gen I ordered. Wrong item.', 'customer_service', 'wrong_item_sent'],
    ['I keep getting the same canned chatbot response, I need to talk to a real person.', 'customer_service', 'chatbot_loop'],
    ['I am a nurse practitioner and want to set up a practitioner account for my clinic.', 'hcp_practitioner', 'account_setup'],
    ['We would like to order 50 kits for our patients, do you offer wholesale pricing?', 'hcp_practitioner', 'bulk_order'],
    ['What protocol do you recommend for a patient with type 2 diabetes on metformin?', 'hcp_practitioner', 'patient_protocol'],
    ['Can you send me the clinical studies and peer-reviewed research behind the FMD?', 'hcp_practitioner', 'evidence_request'],
    ['Stop sending me so many marketing emails! I unsubscribed twice and they keep coming.', 'marketing_email', 'too_many_emails'],
    ['Saw this on TikTok from an influencer, seems like a scam with fake reviews.', 'marketing_email', 'influencer_skepticism'],
    ['I need a return label for my unopened kit. How do I send it back for a refund?', 'subscription_billing', 'refund_status'],
    ['Started an Amazon return on the Fast Bar box, the RMA page asks for a reason.', 'subscription_billing', 'refund_status'],
    ['Cancel my Subscribe & Save before the next box ships.', 'subscription_billing', null],
    ['My Loop subscription auto-renewed and shipped another box I did not want.', 'subscription_billing', 'auto_renew_surprise'],
    ['We order through Fullscript for our clinic. Can practitioners get ProLon on the dispensary?', 'hcp_practitioner', 'account_setup'],
    ['My doctor gave me code HCP-K7M2P and it is rejected at checkout as invalid.', 'checkout_website', 'hcp_code_entry'],
    ['The L-Pill bottle had white mold under the seal when I opened it.', 'foreign_material_allergen', 'mold_spoilage'],
    ['You claim it is clinically proven to reverse biological age. That is a misleading claim.', 'marketing_email', 'misleading_claim'],
    ['Can I have black coffee during the fast? What about a light workout?', 'usage_guidance', 'coffee_exercise'],
    ['I take levothyroxine for my thyroid, is it safe to take during ProLon?', 'usage_guidance', 'medications'],
    ['What should I eat on day 6 for the refeed transition?', 'usage_guidance', 'refeed_transition'],
    ['How often can I do a cycle? Is back-to-back ok?', 'usage_guidance', 'cycle_frequency'],
    ['Do I heat the soup or can I eat it cold?', 'usage_guidance', 'general_question'],
    ['Please make a spicy lentil soup flavor, and bring back the old bar!', 'product_request', 'new_flavor'],
    ['Do you have a nut-free version of the kit? My son is allergic to tree nuts.', 'product_request', 'allergen_free'],
    ['Can I buy just the soups separately without the whole kit?', 'product_request', 'sample_pack'],
    ['Is there a longer 10-day version or a maintenance program after ProLon?', 'product_request', 'longer_program'],
    ['Lost 7 pounds and feel amazing, highly recommend to everyone!', 'praise', 'results_praise'],
    ['So easy to follow, everything is laid out day by day. No guesswork.', 'praise', 'convenience'],
    ['The Next Gen soups are so much better than the old powder ones, actually delicious.', 'praise', 'nextgen_taste'],
    ['Just wanted to say thank you, great product and great experience.', 'praise', 'general_praise'],
    ['Automatic reply: I am currently out of the office and will return on Monday.', 'other_noise', 'auto_reply'],
    ['Delivery has failed to these recipients or groups: mailer-daemon', 'other_noise', 'bounce']
  ];
  var goldFail = 0;
  GOLD.forEach(function (g) {
    var r = C.scoreCategories(g[0]);
    var ok = r.category === g[1] && (g[2] === null || r.subcategory === g[2]);
    if (!ok) { goldFail += 1; console.log('  gold miss: "' + g[0].slice(0, 60) + '" → ' + r.category + '/' + r.subcategory + ' (want ' + g[1] + '/' + g[2] + ')'); }
  });
  assert(GOLD.length >= 40 && goldFail === 0, 'gold sentences (' + GOLD.length + ') all match category' + (goldFail ? ' — ' + goldFail + ' misses' : ''));
  var csp = C.scoreCategories('Maya was amazing, resolved my issue within an hour. Thank you so much!');
  assert((csp.category === 'praise' && csp.subcategory === 'cs_praise') || (csp.category === 'customer_service' && csp.subcategory === 'great_agent'), 'agent praise lands on cs_praise or great_agent');
  var zero = C.scoreCategories('Hello there.');
  assert(zero.category === 'usage_guidance' && zero.subcategory === 'general_question' && zero.confidence === 0.2, 'zero hits → usage_guidance/general_question, confidence 0.2');
  var zeroPos = C.scoreCategories('Wonderful, simply wonderful!');
  assert(zeroPos.category === 'praise' || zeroPos.category === 'praise', 'positive text with lexicon hits → praise');
  var subj = C.scoreCategories('Please help.', 'Charged twice');
  assert(subj.category === 'subscription_billing' && subj.subcategory === 'duplicate_charge', 'subject hits drive category');
  var multi = C.scoreCategories('I was charged twice and the box arrived late and the soup was bland and salty.');
  assert(multi.secondary.length >= 1 && multi.scores.subscription_billing > 0 && multi.scores.taste_quality > 0, 'secondary categories populated on multi-topic text');
  assert(C.scoreCategories('Not happy with this at all.').category !== 'praise', 'negative sentence never lands on praise');

  /* Product detection for every product id */
  var PROD = [
    ['My ProLon 5-day kit arrived today', 'prolon_5day'], ['The Next Gen soups are ready to eat', 'prolon_nextgen'], ['I tried the 1-Day Reset', 'prolon_reset'],
    ['Question about the 5:2 plan', 'prolon_52'], ['The Fast Bar is dry', 'fast_bar'], ['My fasting shake was clumpy', 'fasting_shake'],
    ['L-Protein powder does not dissolve', 'l_protein'], ['Does the L-Pill contain nicotinamide riboside?', 'l_pill'], ['I ordered the Longevity Starter Pack', 'starter_pack'],
    ['My Guided Health coach never replied', 'guided_health'], ['I am in the diabetes remission program and my A1c improved', 'lnutra_health'],
    ['Please cancel my subscription and stop auto-renew', 'subscription_account'], ['Hello, quick question.', 'general']
  ];
  var prodFail = 0;
  PROD.forEach(function (p) { var d = C.detectProduct(p[0]); if (d.product !== p[1]) { prodFail += 1; console.log('  product miss: "' + p[0] + '" → ' + d.product); } });
  assert(prodFail === 0, 'detectProduct finds every product id (' + PROD.length + ')');
  var comp = C.detectProduct('The minestrone quinoa soup had hard bits');
  assert(comp.kit_component === 'soup_minestrone_quinoa' && comp.product === 'prolon_5day', 'component minestrone quinoa before minestrone; component implies kit');
  assert(C.detectProduct('the L-Drink leaked').kit_component === 'l_drink', 'component l_drink');
  assert(C.detectProduct('Next Gen', 'Re: my order').product_class === 'conventional_food' && C.detectProduct('L-Pill').product_class === 'supplement' && C.detectProduct('guided health').product_class === 'program', 'product_class mapping');
  assert(C.detectProduct('the password reset link is broken').product !== 'prolon_reset', '"password reset" is not the Reset product');
  assert(C.detectProduct('hello', 'Fast Bar question').product === 'fast_bar', 'subject drives product');

  /* Safety */
  var s1 = C.assessSafety('I fainted on day 3 and my husband called an ambulance. I spent the night in the ER.');
  assert(s1.serious_ae && s1.is_adverse_event && s1.ae_criteria.indexOf('hospitalization') >= 0 && !s1.food_safety, 'serious AE: fainting + ER → hospitalization criterion');
  var s2 = C.assessSafety('I had a mild headache on day 2 and felt a bit dizzy.');
  assert(s2.is_adverse_event && !s2.serious_ae && s2.ae_criteria.length === 0, 'non-serious AE: headache/dizzy');
  var s3 = C.assessSafety('I am pregnant, can I do the fast? I also take metformin.');
  assert(s3.contraindication_flags.indexOf('pregnancy') >= 0 && s3.contraindication_flags.indexOf('glucose_meds') >= 0 && !s3.is_adverse_event, 'contraindications: pregnancy + glucose_meds, no AE');
  var s4 = C.assessSafety('There was a piece of nut shell in the bar and the soup smelled off.');
  assert(s4.food_safety && !s4.serious_ae, 'food safety: shell + smelled off');
  var s5 = C.assessSafety('No headaches, no hunger, no dizziness at all. Loved it.');
  assert(!s5.is_adverse_event, 'negated symptoms are not adverse events');
  var s7 = C.assessSafety('I work at a hospital and love the kit. My hospital dietitian recommended it.');
  assert(!s7.serious_ae && !s7.is_adverse_event && s7.ae_criteria.length === 0, 'a hospital workplace mention is not a serious adverse event');
  var s8 = C.assessSafety('I passed out at work on day 4. My coworkers called 911 and the paramedics checked me.');
  assert(s8.serious_ae && s8.ae_criteria.indexOf('intervention') >= 0, 'fainting + 911/paramedics → serious AE with the intervention criterion (' + s8.ae_criteria.join(',') + ')');
  var s9 = C.assessSafety('Broke out in hives after the bar and went to urgent care for an antihistamine.');
  assert(s9.is_adverse_event && !s9.serious_ae, 'an urgent-care walk-in is an adverse event but not a seriousness criterion');
  var s10 = C.assessSafety('They kept me overnight at the hospital after day 3.');
  assert(s10.serious_ae && s10.ae_criteria.indexOf('hospitalization') >= 0, 'an overnight hospital stay is a hospitalization');
  var s11 = C.assessSafety('The L-Pill bottle had white mold under the seal when I opened it.');
  assert(s11.food_safety && !s11.serious_ae && C.detectProduct('The L-Pill bottle had white mold under the seal.').product === 'l_pill', 'mold on an L-Pill bottle is a food-safety report on the supplement');
  var s6 = C.assessSafety('The plastic packaging is wasteful.');
  assert(!s6.food_safety, 'plastic without foreign-material context is not food safety');
  var s7 = C.assessSafety('I had an allergic reaction, my throat closed and I used my EpiPen.');
  assert(s7.serious_ae && s7.ae_criteria.indexOf('life_threatening') >= 0 && s7.ae_criteria.indexOf('intervention') >= 0, 'anaphylaxis → life_threatening + intervention');
  assert(C.assessSafety('My 15 year old daughter wants to try it').contraindication_flags.indexOf('minor') >= 0, 'contraindication: minor');
  assert(C.assessSafety('I have a severe peanut allergy').contraindication_flags.indexOf('nut_soy_allergy') >= 0, 'contraindication: nut_soy_allergy');
  assert(C.assessSafety('I am on dialysis for kidney disease').contraindication_flags.indexOf('serious_disease') >= 0, 'contraindication: serious_disease');
  assert(C.assessSafety('My BMI is 17 and I am underweight').contraindication_flags.indexOf('bmi_low') >= 0, 'contraindication: bmi_low');

  /* Urgency */
  function urg(text, extra) {
    var sf = C.assessSafety(text), cat = C.scoreCategories(text), st = C.scoreSentiment(text), fl = C.flags(text, extra || {});
    var label = st.compound >= 0.15 ? 'positive' : st.compound <= -0.15 ? 'negative' : 'neutral';
    var p = { category: cat.category, subcategory: cat.subcategory, sentiment: st.compound, sentiment_label: label, text: text, claim_related: fl.claim_related,
      serious_ae: sf.serious_ae, is_adverse_event: sf.is_adverse_event, food_safety: sf.food_safety, contraindication_flags: sf.contraindication_flags };
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    return C.assignUrgency(p);
  }
  var u0 = urg('I fainted and went to the ER.');
  assert(u0.urgency === 'P0' && u0.escalated_to === 'medical' && u0.reasons.length > 0, 'P0: serious AE → medical');
  var u0b = urg('I found a shell fragment in the soup.');
  assert(u0b.urgency === 'P0' && u0b.escalated_to === 'quality_regulatory', 'P0: food safety → quality_regulatory');
  var u0c = urg('I am contacting my lawyer and the BBB about this refund.');
  assert(u0c.urgency === 'P0' && u0c.escalated_to === 'legal', 'P0: lawyer/BBB → legal');
  var u0d = urg('I am pregnant, can I do this?');
  assert(u0d.urgency === 'P0' && u0d.escalated_to === 'medical', 'P0: pregnancy contraindication → medical');
  var u1 = urg('I was charged twice for my order.');
  assert(u1.urgency === 'P1' && u1.escalated_to === 'finance', 'P1: duplicate_charge → finance');
  var u1b = urg('The L-Drink leaked all over the box.');
  assert(u1b.urgency === 'P1', 'P1: leaking');
  var u1c = urg('The soup was bland and I hated every bite, terrible experience.', { nps: 2 });
  assert(u1c.urgency === 'P1', 'P1: detractor (nps ≤6) with strongly negative sentiment');
  var u1d = urg('My patients are frustrated, the portal is broken and support is useless.', { segment: 'hcp' });
  assert(u1d.urgency === 'P1', 'P1: negative practitioner account');
  var u1e = urg('I had a headache on day 3.');
  assert(u1e.urgency === 'P1', 'P1: non-serious adverse event');
  var u2 = urg('The tomato soup was too salty for me.');
  assert(u2.urgency === 'P2' && u2.escalated_to === 'none', 'P2: taste complaint');
  var u2b = urg('Can I drink black coffee during the fast?');
  assert(u2b.urgency === 'P2', 'P2: usage guidance');
  var u3 = urg('Love the kit, thank you so much!');
  assert(u3.urgency === 'P3', 'P3: praise');
  var u3b = urg('Please add a spicy lentil soup flavor.');
  assert(u3b.urgency === 'P3', 'P3: product request');
  var uEmpty = C.assignUrgency({});
  assert(uEmpty.urgency === 'P2' && uEmpty.escalated_to === 'none' && Array.isArray(uEmpty.reasons), 'assignUrgency on empty partial returns P2/none');
  assert(u0.reasons.concat(u1.reasons, u2.reasons).every(function (s) { return !/\bwill\b/i.test(s); }), 'urgency reasons never contain "will"');

  /* Entities */
  var e1 = C.extractEntities('My Shopify order #123456 never arrived. Lot NG-0426-B was on the box. My code is PP-12345.');
  assert(e1.order_id === '#123456' && e1.lot_number === 'NG-0426-B' && e1.hcp_code === null, 'entities: Shopify #123456, lot NG-0426-B; a PP- order id is not a practitioner code');
  var e2 = C.extractEntities('Amazon order 113-1234567-1234567 arrived damaged.');
  assert(e2.order_id === '113-1234567-1234567' && e2.lot_number === null && e2.hcp_code === null, 'entities: Amazon order id');
  var e3 = C.extractEntities('hello', 'Re: Order #654321');
  assert(e3.order_id === '#654321', 'entities: order id from subject');
  var e4 = C.extractEntities('The lot number is NG-0426-B.');
  assert(e4.lot_number === 'NG-0426-B', 'entities: bare lot code');
  var e5 = C.extractEntities('I lost 6 lbs in 5 days and spent $250.');
  assert(e5.order_id === null && e5.lot_number === null && e5.hcp_code === null, 'entities: no false positives on weights/prices');
  var e6 = C.extractEntities('My practitioner order PP-12345 shipped late.');
  assert(e6.hcp_code === null && e6.order_id === 'PP-12345', 'entities: PP-12345 is the practitioner order id, hcp_code stays null');
  var e7 = C.extractEntities('My doctor gave me code HCP-K7M2P and it is rejected at checkout. Order #148213.');
  assert(e7.hcp_code === 'HCP-K7M2P' && e7.order_id === '#148213', 'entities: practitioner code HCP-K7M2P alongside a Shopify order id');
  var e8 = C.extractEntities('hello', 'Practitioner code hcp-9a2bq rejected');
  assert(e8.hcp_code === 'HCP-9A2BQ', 'entities: HCP code found in the subject, upper-cased');
  var segHcp = C.classifyRecord({ from_email: 'pt@example.com', subject: 'Code question', text: 'My doctor gave me code HCP-K7M2P and it is rejected at checkout.' }, {});
  var segOrder = C.classifyRecord({ from_email: 'clinic@example.com', subject: 'Invoice', text: 'The invoice for wholesale order PP-12345 shows the wrong tax.' }, {});
  assert(segHcp.segment === 'hcp_patient' && segHcp.hcp_code === 'HCP-K7M2P' && segOrder.segment !== 'hcp_patient' && segOrder.order_id === 'PP-12345', 'classifyRecord infers hcp_patient from an HCP- code, never from a PP- order id');
  var loopRec = C.detectProduct('My Loop subscription auto-renewed and shipped another box I did not want.');
  assert(loopRec.product === 'subscription_account', 'Loop (the subscription app) resolves to the subscription account, not a chatbot loop');

  /* Flags */
  var f1 = C.flags('This is false advertising, it is not clinically proven and autophagy claims are misleading.');
  assert(f1.claim_related && !f1.restricted, 'flags: claim_related');
  var f2 = C.flags('Please cancel my subscription and refund me.');
  assert(f2.cancel_intent, 'flags: cancel_intent');
  var f3 = C.flags('My A1c went from 7.1 to 6.4 and my doctor prescribed a lower metformin dose.');
  assert(f3.restricted, 'flags: restricted via A1c / prescription text');
  assert(C.flags('hello', { segment: 'lnh_patient' }).restricted && C.flags('hello', { segment: 'hcp_patient' }).restricted, 'flags: restricted via segment');
  assert(C.flags('hello', { to: ['Med.Ed@l-nutra.com'] }).restricted, 'flags: restricted via Med.Ed recipient');
  assert(!C.flags('I love the soup.').cancel_intent && !C.flags('I love the soup.').claim_related && !C.flags('I love the soup.').restricted, 'flags: all false on praise');

  /* Noise */
  assert(C.isNoise({ auto_submitted: 'auto-replied' }, 'Re: hi', 'x').reason === 'auto_reply', 'noise: Auto-Submitted header');
  assert(C.isNoise({ x_autoreply: 'yes' }, '', '').reason === 'auto_reply', 'noise: X-Autoreply header');
  assert(C.isNoise({ list_unsubscribe: '<mailto:unsub@x.com>' }, 'Deals', 'body').reason === 'newsletter', 'noise: List-Unsubscribe header');
  assert(C.isNoise({ precedence: 'bulk' }, 'Deals', 'body').reason === 'newsletter', 'noise: Precedence bulk');
  assert(C.isNoise({ content_type: 'multipart/report; report-type=delivery-status' }, 'x', '').reason === 'bounce', 'noise: delivery-status content type');
  assert(C.isNoise({}, 'Undeliverable: your message', '').reason === 'bounce', 'noise: bounce subject');
  assert(C.isNoise({}, 'Automatic reply: Question about my kit', '').reason === 'auto_reply', 'noise: auto-reply subject');
  assert(C.isNoise({}, 'Out of Office', '').is_noise, 'noise: out of office subject');
  assert(C.isNoise({}, 'Your weekly newsletter', '').reason === 'newsletter', 'noise: newsletter subject');
  assert(C.isNoise({}, 'Question', 'I am currently out of the office with limited access to email.').reason === 'auto_reply', 'noise: auto-reply body');
  var clean = C.isNoise({ content_type: 'text/plain' }, 'Charged twice', 'Hi, I was charged twice for my order. Please help.');
  assert(!clean.is_noise && clean.reason === null, 'noise: real complaint is not noise');
  assert(R.noise.headerChecks(null) === null && R.noise.headerChecks({}) === null, 'headerChecks tolerates null/empty');

  /* Language gate */
  var de = 'Ich habe meine Bestellung vor drei Wochen aufgegeben und sie ist noch nicht angekommen. Das ist sehr enttäuschend und ich möchte mein Geld zurück, bitte antworten Sie mir so schnell wie möglich.';
  assert(C.detectLanguage(de) === 'other', 'language: German paragraph → other');
  assert(C.detectLanguage('I ordered the kit two weeks ago and it has not arrived yet. Can you check on the shipment for me?') === 'en', 'language: English → en');
  assert(C.detectLanguage('Loved it!') === 'en', 'language: short English → en');
  assert(C.detectLanguage('') === 'unknown' && C.detectLanguage(null) === 'unknown', 'language: empty → unknown');
  assert(C.detectLanguage('Il mio ordine non è ancora arrivato e sono molto deluso. Vorrei un rimborso per favore, grazie mille per la vostra attenzione.') === 'other', 'language: Italian → other');

  /* Preprocess */
  var raw = 'Hi team,\n\nMy kit still hasn\'t arrived.\n\nThanks,\nJo\n\nSent from my iPhone\n\nOn Tue, Sep 2, 2026 at 3:14 PM Support <support@prolon.com> wrote:\n> Hi Jo,\n> Your order shipped.';
  var pre = C.preprocess(raw);
  assert(pre.indexOf('wrote:') < 0 && pre.indexOf('Your order shipped') < 0, 'preprocess cuts "On … wrote:" tail');
  assert(pre.indexOf('Sent from my iPhone') < 0 && pre.indexOf('Jo') >= 0, 'preprocess cuts "Sent from my iPhone" signature, keeps body');
  assert(/hasn't arrived\./.test(pre) && pre.indexOf('Hi team') === 0, 'preprocess keeps case and punctuation');
  var pre2 = C.preprocess('Great!!\n\n\n\n-----Original Message-----\nFrom: x\nSent: y\nblah');
  assert(pre2 === 'Great!!', 'preprocess cuts Original Message block and collapses whitespace');
  var pre3 = C.preprocess('', '<html><body><p>Hello &amp; welcome</p><br>Line two<style>p{}</style></body></html>');
  assert(pre3.indexOf('Hello & welcome') === 0 && pre3.indexOf('Line two') > 0 && pre3.indexOf('p{}') < 0, 'preprocess converts html when text empty');
  assert(C.preprocess(null) === '' && C.preprocess(undefined) === '', 'preprocess handles null');
  var pre4 = C.preprocess('Body line\n> quoted line\nmore body\n-- \nSig Name');
  assert(pre4 === 'Body line\nmore body', 'preprocess drops > lines and -- signature');

  /* Sentiment sign on ≥30 sentences (incl. negation) */
  var SENT = [
    ['I love the results!', 1], ['Great product, excellent service.', 1], ['Delicious soups and so much energy.', 1], ['Lost 6 lbs and feel amazing.', 1],
    ['Thank you so much, Maya was wonderful.', 1], ['Highly recommend this to anyone.', 1], ['No complaints — loved it!', 1], ['I am not disappointed at all, it was fine.', 1],
    ['Pleasantly surprised, the Next Gen is tasty.', 1], ['Worth every penny.', 1], ['The bars were surprisingly good.', 1], ['My energy on day 4 was incredible.', 1],
    ['Not happy with this at all.', -1], ['Never received my kit.', -1], ['Terrible experience, total scam.', -1], ['The soup was bland and disgusting.', -1],
    ['I was charged twice and nobody responded.', -1], ['Awful taste, like astronaut food.', -1], ['This is NOT worth the money!!!', -1], ['Frustrated and disappointed.', -1],
    ['I am not happy.', -1], ['The L-Drink leaked everywhere, what a mess.', -1], ['Rude and unhelpful support.', -1], ['I do not recommend this at all.', -1],
    ['Hard bits in the soup, unacceptable.', -1], ['Still waiting, no response after three emails.', -1], ['Headache and nausea the whole time.', -1], ['Worst purchase I have ever made.', -1],
    ['I gained it all back, waste of money.', -1], ['Never again.', -1], ['The kit was fine but the price is ridiculous.', -1], ['Disappointing results, no weight loss.', -1],
    ['I hate the olives but love everything else.', 1], ['It was okay.', 1]
  ];
  var sentFail = 0;
  SENT.forEach(function (s) {
    var r = C.scoreSentiment(s[0]);
    var sign = r.compound > 0 ? 1 : r.compound < 0 ? -1 : 0;
    if (sign !== s[1]) { sentFail += 1; console.log('  sentiment miss: "' + s[0] + '" → ' + r.compound); }
  });
  assert(SENT.length >= 30 && sentFail === 0, 'sentiment sign on ' + SENT.length + ' sentences incl. negation' + (sentFail ? ' — ' + sentFail + ' misses' : ''));
  var ss = C.scoreSentiment('The soup was great. The bars were terrible.');
  assert(ss.sentences.length === 2 && ss.min < 0 && ss.min <= ss.compound && ss.hits.length === 2, 'scoreSentiment: sentences, min ≤ compound, hits');
  var caps = C.scoreSentiment('This is TERRIBLE.').compound, nocaps = C.scoreSentiment('This is terrible.').compound;
  assert(caps < nocaps, 'ALL-CAPS intensifies');
  assert(C.scoreSentiment('very good').compound > C.scoreSentiment('good').compound, 'booster intensifies');
  assert(C.scoreSentiment('slightly good').compound < C.scoreSentiment('good').compound, 'dampener softens');
  assert(C.scoreSentiment('good!!').compound > C.scoreSentiment('good').compound, 'exclamation intensifies');
  assert(C.scoreSentiment('The soup was great but the service was awful.').compound < 0, '"but" weights the clause after it');
  var empty = C.scoreSentiment('');
  assert(empty.compound === 0 && empty.min === 0 && empty.sentences.length === 0 && empty.hits.length === 0, 'scoreSentiment on empty text');
  assert(C.scoreSentiment('ProLon Fast Bar reset').compound === 0, 'brand stoplist carries no valence');

  /* Full classifyRecord on a RawEmail */
  var rawEmail = {
    message_id: '<abc123@mail.example.com>', thread_id: null, in_reply_to: null, references: [], date: '2026-09-14T15:22:00Z',
    from_name: 'Jane Doe', from_email: 'Jane.Doe+promo@gmail.com', to: ['support@l-nutra.com'], cc: [],
    subject: 'Charged twice for order #123456',
    text: 'Hi team,\n\nI was charged twice for my ProLon 5-day kit order #123456. Please refund the duplicate charge, this is really frustrating.\n\nThanks,\nJane\n\nSent from my iPhone\n\nOn Mon, Sep 14, 2026 at 9:00 AM Support wrote:\n> earlier message',
    html: null, direction: 'inbound', attachments: [], headers: { content_type: 'text/plain' }, source: 'imap'
  };
  var rec = C.classifyRecord(rawEmail, { now: '2026-09-16T23:59:00Z', settings: {}, source: 'imap' });
  var FIELDS = ['id', 'schema_version', 'received_at', 'channel', 'sales_channel', 'from_name', 'from_email', 'subject', 'text', 'language', 'has_attachment',
    'product', 'product_variant', 'kit_component', 'product_class', 'category', 'subcategory', 'secondary_categories', 'sentiment', 'sentiment_min', 'sentiment_label',
    'nps', 'rating', 'csat', 'urgency', 'status', 'first_response_at', 'resolved_at', 'reopen_count', 'service_fields_source', 'escalated_to', 'is_adverse_event',
    'serious_ae', 'ae_criteria', 'contraindication_flags', 'food_safety', 'lot_number', 'order_id', 'hcp_code', 'claim_related', 'cancel_intent', 'restricted',
    'customer_id', 'segment', 'region', 'thread_id', 'is_first_contact', 'message_id', 'source', 'is_noise', 'noise_reason', 'assignee', 'tags', 'notes', 'classifier'];
  var missing = FIELDS.filter(function (f) { return !(f in rec) || rec[f] === undefined; });
  assert(missing.length === 0, 'classifyRecord returns every SPEC §2 field' + (missing.length ? ' — missing ' + missing.join(',') : ''));
  var nan = FIELDS.filter(function (f) { return typeof rec[f] === 'number' && isNaN(rec[f]); });
  assert(nan.length === 0, 'classifyRecord has no NaN fields');
  assert(/^em_[0-9a-f]{16}$/.test(rec.id), 'id = em_ + hex16 for imap source');
  assert(rec.customer_id === 'c_' + VOC.util.fnv64('janedoe@gmail.com'), 'customer_id = c_ + fnv64(normalizeEmail(from))');
  assert(rec.category === 'subscription_billing' && rec.subcategory === 'duplicate_charge' && rec.product === 'prolon_5day', 'record category/subcategory/product');
  assert(rec.urgency === 'P1' && rec.escalated_to === 'finance' && rec.status === 'new' && rec.reopen_count === 0, 'record urgency P1 → finance, status new');
  assert(rec.order_id === '#123456' && rec.cancel_intent === true && rec.claim_related === false && rec.restricted === false, 'record entities and flags');
  assert(rec.sentiment < 0 && rec.sentiment_label === 'negative' && rec.sentiment_min <= rec.sentiment, 'record sentiment negative');
  assert(rec.text.indexOf('wrote:') < 0 && rec.text.indexOf('Sent from my iPhone') < 0, 'record text is preprocessed');
  assert(rec.received_at === '2026-09-14T15:22:00Z' && rec.language === 'en' && rec.channel === 'email' && rec.source === 'imap', 'record received_at/language/channel/source');
  assert(rec.thread_id && rec.is_first_contact === true && rec.message_id === '<abc123@mail.example.com>', 'record thread/message ids');
  assert(rec.classifier.rule_category === 'subscription_billing' && rec.classifier.manual_override === false && rec.classifier.needs_review === false && rec.classifier.confidence > 0.5, 'record classifier block');
  assert(Array.isArray(rec.tags) && rec.tags.length === 0 && Array.isArray(rec.notes) && rec.nps === null && rec.assignee === null && rec.is_noise === false, 'record defaults');
  var reply = C.classifyRecord({ message_id: '<def@x>', in_reply_to: '<abc123@mail.example.com>', references: ['<abc123@mail.example.com>'], date: '2026-09-15T10:00:00Z', from_email: 'jane.doe@gmail.com', subject: 'Re: Charged twice for order #123456', text: 'Any update?' }, { now: '2026-09-16T23:59:00Z', source: 'eml' });
  assert(reply.thread_id === rec.thread_id && reply.is_first_contact === false && /^im_/.test(reply.id), 'reply shares thread_id via references, im_ prefix for non-imap');
  var noEmail = C.classifyRecord({ subject: 'Hi', text: 'Question about the fast.' }, { now: new Date('2026-09-16T23:59:00Z') });
  assert(/^c_unknown_[0-9a-f]{16}$/.test(noEmail.customer_id) && noEmail.received_at === '2026-09-16T23:59:00Z' && noEmail.source === 'manual', 'no email → c_unknown_, received_at from ctx.now');
  var noisy = C.classifyRecord({ subject: 'Automatic reply: hi', text: 'I am out of the office.', headers: { auto_submitted: 'auto-replied' }, from_email: 'a@b.com' }, {});
  assert(noisy.is_noise && noisy.noise_reason === 'auto_reply' && noisy.status === 'closed_noise', 'noise record → closed_noise');
  var german = C.classifyRecord({ subject: 'Bestellung', text: de, from_email: 'hans@web.de' }, {});
  assert(german.language === 'other' && german.sentiment_label === 'unscored' && german.sentiment === 0 && german.region === 'DE' && german.classifier.needs_review, 'German record → unscored, region DE, needs review');
  var ae = C.classifyRecord({ subject: 'Fainted', text: 'I fainted on day 3 and went to the ER. Lot NG-0426-B on the box.', from_email: 'x@y.com' }, {});
  assert(ae.serious_ae && ae.urgency === 'P0' && ae.escalated_to === 'medical' && ae.lot_number === 'NG-0426-B' && ae.category === 'adverse_event', 'AE record → P0 medical with lot');

  /* reclassify */
  var seedRec = Object.assign({}, rec, { id: 'r_000001', source: 'seed', category: 'praise', subcategory: 'general_praise', product: 'fast_bar', urgency: 'P3', status: 'resolved', assignee: 'Maya R.', tags: ['x'] });
  var re1 = C.reclassify(seedRec);
  assert(re1.id === 'r_000001' && re1.category === 'praise' && re1.product === 'fast_bar' && re1.status === 'resolved' && re1.assignee === 'Maya R.' && re1.tags[0] === 'x', 'reclassify(seed) keeps id/labels/status/overlay fields');
  assert(re1.classifier.rule_category === 'subscription_billing' && re1.classifier.needs_review === true && re1.sentiment < 0, 'reclassify(seed) writes rule_* and lexicon sentiment, flags disagreement');
  var imp = Object.assign({}, rec, { category: 'praise', subcategory: 'general_praise', urgency: 'P3', classifier: { manual_override: false } });
  var re2 = C.reclassify(imp);
  assert(re2.category === 'subscription_billing' && re2.urgency === 'P1' && re2.classifier.needs_review === false, 'reclassify(non-seed) recomputes category and urgency');
  var man = Object.assign({}, imp, { classifier: { manual_override: true } });
  var re3 = C.reclassify(man);
  assert(re3.category === 'praise' && re3.urgency === 'P3' && re3.classifier.manual_override === true, 'reclassify respects manual_override');

  /* explain */
  var ex = C.explain('I was charged twice for order #123456 and I am furious.', 'Billing');
  var names = ex.stages.map(function (s) { return s.name; });
  assert(names.length === 10 && names.indexOf('sentiment') >= 0 && names.indexOf('categories') >= 0 && names.indexOf('urgency') >= 0, 'explain returns 10 stages');
  assert(ex.stages.every(function (s) { return s.output !== undefined; }), 'explain stages all have output');

  /* fingerprint stability */
  assert(C.fingerprint(rawEmail) === C.fingerprint(rawEmail) && /^[0-9a-f]{16}$/.test(C.fingerprint(rawEmail)), 'fingerprint stable hex16');
  assert(C.fingerprint({ from_email: 'a@b.com', date: '2026-01-01T00:00:00Z', subject: 'Hi', text: 'x' }) !== C.fingerprint({ from_email: 'a@b.com', date: '2026-01-01T00:00:00Z', subject: 'Hi', text: 'y' }), 'fingerprint differs on body');

  /* Performance: 1 KB email under 3 ms, 1,000 records reclassified under 2 s */
  var body = rawEmail.text;
  while (body.length < 1024) body += ' The soups were bland and the L-Drink leaked. I also had a headache on day 3 and felt tired.';
  var big = Object.assign({}, rawEmail, { text: body });
  C.classifyRecord(big, {});
  var t0 = Date.now(), N = 300;
  for (var i = 0; i < N; i++) C.classifyRecord(big, {});
  var per = (Date.now() - t0) / N;
  assert(per < 3, 'classifyRecord on 1 KB email averages ' + per.toFixed(2) + ' ms (< 3 ms)');
  var recs = [];
  for (var j = 0; j < 1000; j++) recs.push(Object.assign({}, rec, { id: 'r_' + j, text: j % 2 ? body : rec.text }));
  var t1 = Date.now();
  recs.forEach(function (r) { C.reclassify(r); });
  var dt = Date.now() - t1;
  assert(dt < 2000, '1,000 records reclassified in ' + dt + ' ms (< 2000)');

  console.log('\n' + (total - failures) + '/' + total + ' assertions passed');
  if (failures) throw new Error(failures + ' test_classify assertions failed');
})();
