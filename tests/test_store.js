/* tests/test_store.js — VOC.store under jsc: init with a synthetic seed, filters/presets, derived KPIs without NaN,
 * overlays, undo, query round-trip, addRecords dedupe, settings, orders, saved views, resetDemo.
 * Runs with or without the sibling modules (classify/metrics/predict); stubs are installed only when a module is absent. */
(function () {
  'use strict';
  var failures = 0, total = 0;
  function assert(cond, msg) {
    total += 1;
    if (cond) console.log('PASS ' + msg);
    else { failures += 1; console.log('FAIL ' + msg); }
  }
  function drain() {
    if (typeof drainMicrotasks === 'function') drainMicrotasks();
  }
  function noNaN(obj, path, bad) {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'number') { if (!isFinite(obj)) bad.push(path); return; }
    if (typeof obj === 'object') Object.keys(obj).forEach(function (k) { if (k !== 'rec' && k !== 'records' && k !== 'compare' && k !== 'allRecords') noNaN(obj[k], path + '.' + k, bad); });
  }

  var u = VOC.util, store = VOC.store;
  assert(store && typeof store.init === 'function', 'VOC.store loads under jsc');

  /* ---- optional stubs so the integration paths run even before teammates finish ---- */
  var stubbedMetrics = false, stubbedPredict = false;
  if (!VOC.metrics) {
    stubbedMetrics = true;
    VOC.metrics = {
      registry: {
        volume: { id: 'volume', label: 'Volume', unit: 'count', direction: 'neutral', formula: 'count(records)', compute: function (recs) { return { value: recs.length, n: recs.length }; } },
        nps: { id: 'nps', label: 'NPS', unit: 'pts', direction: 'up_good', formula: '%9–10 − %0–6', compute: function (recs) {
          var s = recs.filter(function (r) { return typeof r.nps === 'number'; });
          if (!s.length) return { value: null, n: 0 };
          var p = s.filter(function (r) { return r.nps >= 9; }).length / s.length, d = s.filter(function (r) { return r.nps <= 6; }).length / s.length;
          return { value: (p - d) * 100, n: s.length, interval: { lo: (p - d) * 100 - 10, hi: (p - d) * 100 + 10 } };
        } }
      },
      compute: function (id, recs, ctx) { return VOC.metrics.registry[id].compute(recs, ctx); }
    };
  }
  if (!VOC.predict) {
    stubbedPredict = true;
    VOC.predict = {
      churnRisk: function (cid) { return { score: cid ? 42 : null, tier: 'watch', reasons: [] }; },
      escalationRisk: function () { return { score: 17, tier: 'low', reasons: [] }; },
      predictCsat: function (recs) { return { predictions: recs.filter(function (r) { return r.is_open; }).map(function (r) { return { id: r.id, pred: 3.5, lo: 2.5, hi: 4.5 }; }), method: 'fallback' }; }
    };
  }

  /* ---- synthetic seed: 30 records, Jul–Sep 2026, as_of 2026-09-16T23:59:00Z ---- */
  var AS_OF = '2026-09-16T23:59:00Z';
  function rec(i, o) {
    var base = {
      id: 'r_' + String(i).padStart(6, '0'), schema_version: 1, received_at: o.at, channel: o.channel || 'email', sales_channel: o.sales_channel || 'dtc_web',
      from_name: 'Customer ' + i, from_email: 'customer' + i + '@example.com', subject: o.subject, text: o.text, language: o.language || 'en', has_attachment: false,
      product: o.product || 'prolon_5day', product_variant: null, kit_component: o.kit_component || null, product_class: VOC.enums.productClass(o.product || 'prolon_5day'),
      category: o.category, subcategory: o.subcategory, secondary_categories: [], sentiment: o.sentiment, sentiment_min: o.sentiment,
      sentiment_label: o.language === 'other' ? 'unscored' : (o.sentiment > 0.15 ? 'positive' : o.sentiment < -0.15 ? 'negative' : 'neutral'),
      nps: o.nps === undefined ? null : o.nps, rating: null, csat: o.csat === undefined ? null : o.csat, urgency: o.urgency || 'P2', status: o.status || 'resolved',
      first_response_at: o.frt === undefined ? new Date(Date.parse(o.at) + 5 * 3600000).toISOString() : o.frt,
      resolved_at: (o.status || 'resolved') === 'resolved' ? new Date(Date.parse(o.at) + 30 * 3600000).toISOString() : null, reopen_count: 0,
      service_fields_source: 'seed', escalated_to: o.escalated_to || 'none', is_adverse_event: !!o.ae, serious_ae: !!o.serious, ae_criteria: o.serious ? ['intervention'] : [],
      contraindication_flags: [], food_safety: !!o.food, lot_number: o.lot || null, order_id: o.order || null, hcp_code: null, claim_related: false, cancel_intent: !!o.cancel,
      restricted: !!o.restricted, customer_id: 'c_' + String(o.cust || i).padStart(16, '0'), segment: o.segment || 'first_time', region: 'US', thread_id: 't_' + i, is_first_contact: true,
      message_id: '<m' + i + '@example.com>', source: 'seed', is_noise: !!o.noise, noise_reason: o.noise || null, assignee: o.assignee || null, tags: [], notes: [],
      classifier: { confidence: 0.8, rule_category: o.rule_category || o.category, rule_subcategory: o.subcategory, rule_product: o.product || 'prolon_5day', manual_override: false, needs_review: !!o.needs_review }
    };
    return base;
  }
  var records = [
    rec(1, { at: '2026-07-02T14:00:00Z', category: 'praise', subcategory: 'results_praise', sentiment: 0.7, subject: 'Lost 6 lbs', text: 'Lost 6 lbs and felt energized on day 4. Delicious soups.', nps: 10 }),
    rec(2, { at: '2026-07-06T15:30:00Z', category: 'subscription_billing', subcategory: 'cancel_friction', sentiment: -0.6, subject: 'No cancellation link', text: 'There is no cancellation link anywhere. I want to cancel my subscription.', nps: 3, segment: 'subscriber', cancel: true }),
    rec(3, { at: '2026-07-10T20:10:00Z', category: 'shipping_fulfillment', subcategory: 'late', sentiment: -0.4, subject: 'Order still not arrived', text: 'My order #123456 is late and still not arrived after 9 days.', order: '#123456' }),
    rec(4, { at: '2026-07-14T16:00:00Z', category: 'taste_quality', subcategory: 'soup_taste', sentiment: -0.3, subject: 'Astronaut food', text: 'The minestrone tastes like astronaut food, bland and salty.', product: 'prolon_nextgen', kit_component: 'soup_minestrone', rating: 2 }),
    rec(5, { at: '2026-07-18T13:00:00Z', category: 'usage_guidance', subcategory: 'coffee_exercise', sentiment: 0.05, subject: 'Coffee during the fast?', text: 'Can I drink black coffee and do light exercise during the 5 day?' }),
    rec(6, { at: '2026-07-22T17:45:00Z', category: 'side_effects', subcategory: 'headache', sentiment: -0.45, subject: 'Day 3 headache', text: 'Day 3 headache and hunger, is that normal?', ae: true, urgency: 'P1' }),
    rec(7, { at: '2026-07-26T11:00:00Z', category: 'price_value', subcategory: 'too_expensive', sentiment: -0.35, subject: '$40 a day', text: '$40 a day is not worth it for soup and crackers.', nps: 5 }),
    rec(8, { at: '2026-07-30T22:00:00Z', category: 'praise', subcategory: 'cs_praise', sentiment: 0.8, subject: 'Great agent', text: 'Maya was wonderful and solved my issue in minutes.', nps: 9, csat: 5 }),
    rec(9, { at: '2026-08-03T14:20:00Z', category: 'efficacy_results', subcategory: 'no_results', sentiment: -0.5, subject: 'No results', text: 'Finished the cycle and lost nothing. Disappointed.', nps: 4 }),
    rec(10, { at: '2026-08-07T18:00:00Z', category: 'hcp_practitioner', subcategory: 'bulk_order', sentiment: 0.1, subject: 'Bulk order for clinic', text: 'We would like to order 20 kits for our clinic with practitioner pricing.', segment: 'hcp', sales_channel: 'hcp', channel: 'hcp_portal' }),
    rec(11, { at: '2026-08-11T15:00:00Z', category: 'checkout_website', subcategory: 'promo_code', sentiment: -0.2, subject: 'Promo code not working', text: 'The promo code from the email does not apply at checkout.' }),
    rec(12, { at: '2026-08-15T12:00:00Z', category: 'missing_damaged', subcategory: 'leaking', sentiment: -0.55, subject: 'L-Drink leaked', text: 'The L-Drink bottle leaked all over the box.', product: 'prolon_nextgen', kit_component: 'l_drink', urgency: 'P1' }),
    rec(13, { at: '2026-08-19T19:00:00Z', category: 'praise', subcategory: 'nextgen_taste', sentiment: 0.65, subject: 'Next Gen tastes great', text: 'The Next Gen soups are delicious and easy.', product: 'prolon_nextgen', nps: 9 }),
    rec(14, { at: '2026-08-23T21:00:00Z', category: 'marketing_email', subcategory: 'too_many_emails', sentiment: -0.25, subject: 'Too many emails', text: 'Please stop emailing me twice a day.', urgency: 'P3' }),
    rec(15, { at: '2026-08-27T14:00:00Z', category: 'other_noise', subcategory: 'auto_reply', sentiment: 0, subject: 'Automatic reply: Out of office', text: 'I am out of the office until Monday.', noise: 'auto_reply', status: 'closed_noise', urgency: 'P3', frt: null }),
    rec(16, { at: '2026-08-31T13:30:00Z', category: 'usage_guidance', subcategory: 'medications', sentiment: -0.1, subject: 'A1c and metformin question', text: 'My A1c came down; my doctor prescribed metformin, can I continue the program?', segment: 'lnh_patient', sales_channel: 'lnutra_health', product: 'lnutra_health', restricted: true }),
    rec(17, { at: '2026-09-02T15:00:00Z', category: 'subscription_billing', subcategory: 'duplicate_charge', sentiment: -0.7, subject: 'Charged twice', text: 'I was charged twice for one order. Refund please.', urgency: 'P1', status: 'open', frt: null, nps: 2, segment: 'subscriber', cust: 2 }),
    rec(18, { at: '2026-09-02T18:30:00Z', category: 'subscription_billing', subcategory: 'duplicate_charge', sentiment: -0.65, subject: 'Double charge on my card', text: 'Two charges for the same kit showed up on my card.', urgency: 'P1', status: 'open', frt: null }),
    rec(19, { at: '2026-09-03T02:00:00Z', category: 'subscription_billing', subcategory: 'duplicate_charge', sentiment: -0.6, subject: 'Charged twice again', text: 'Charged twice, second time this happens.', urgency: 'P1', status: 'pending', segment: 'subscriber' }),
    rec(20, { at: '2026-09-05T16:00:00Z', category: 'product_request', subcategory: 'new_flavor', sentiment: 0.3, subject: 'More soup flavors please', text: 'Would love a lentil soup option in the kit.', urgency: 'P3' }),
    rec(21, { at: '2026-09-07T14:00:00Z', category: 'customer_service', subcategory: 'no_response', sentiment: -0.5, subject: 'No response in a week', text: 'I emailed a week ago and nobody answered.', status: 'open', frt: null, nps: 3 }),
    rec(22, { at: '2026-09-08T13:00:00Z', category: 'efficacy_results', subcategory: 'weight_loss', sentiment: 0.6, subject: 'Down 5 pounds', text: 'Down 5 pounds and sleeping better. Energy on day 4 was real.', nps: 10, csat: 5 }),
    rec(23, { at: '2026-09-09T20:00:00Z', category: 'shipping_fulfillment', subcategory: 'tracking', sentiment: -0.1, subject: 'Tracking not updating', text: 'Tracking has not updated in three days.', status: 'pending', language: 'en' }),
    rec(24, { at: '2026-09-10T15:00:00Z', category: 'adverse_event', subcategory: 'fainting', sentiment: -0.8, subject: 'Fainted on day 2', text: 'I fainted on day 2 and went to the ER. Taking L-Pill as well.', product: 'l_pill', ae: true, serious: true, urgency: 'P0', status: 'escalated', escalated_to: 'quality_regulatory', frt: '2026-09-10T15:40:00Z' }),
    rec(25, { at: '2026-09-11T14:00:00Z', category: 'taste_quality', subcategory: 'l_drink_taste', sentiment: -0.2, subject: 'L-Drink zu süß', text: 'Das L-Drink ist viel zu süß für mich.', language: 'other', product: 'prolon_5day', kit_component: 'l_drink' }),
    rec(26, { at: '2026-09-12T18:00:00Z', category: 'praise', subcategory: 'convenience', sentiment: 0.5, subject: 'So convenient', text: 'Everything in one box, so convenient for travel.', nps: 8, status: 'resolved' }),
    rec(27, { at: '2026-09-13T15:00:00Z', category: 'side_effects', subcategory: 'nausea_gi', sentiment: -0.4, subject: 'Nausea on day 1', text: 'Some nausea on day 1, went away by day 2.', ae: true, urgency: 'P1', status: 'resolved', needs_review: true, rule_category: 'usage_guidance' }),
    rec(28, { at: '2026-09-14T14:00:00Z', category: 'subscription_billing', subcategory: 'unauthorized_signup', sentiment: -0.75, subject: 'Signed up without permission', text: 'I was signed up for a subscription without permission. Cancel it now.', urgency: 'P1', status: 'new', frt: null, cancel: true, nps: 1 }),
    rec(29, { at: '2026-09-15T20:00:00Z', category: 'foreign_material_allergen', subcategory: 'hard_bits', sentiment: -0.7, subject: 'Hard bits in the minestrone quinoa', text: 'Found hard bits like nut shell in the minestrone quinoa soup. Lot NG-0426-B.', product: 'prolon_nextgen', kit_component: 'soup_minestrone_quinoa', food: true, urgency: 'P0', status: 'open', frt: null, lot: 'NG-0426-B' }),
    rec(30, { at: '2026-09-16T13:00:00Z', category: 'praise', subcategory: 'general_praise', sentiment: 0.6, subject: 'Love it', text: 'Third cycle done, love the routine.', nps: 9, status: 'new', frt: null, segment: 'repeat', cust: 1 })
  ];
  var seed = {
    meta: { schema_version: 1, seed: 1, generated: '2026-09-17', as_of: AS_OF, range: ['2026-07-01', '2026-09-16'], timezone: 'America/Chicago', agents: ['Maya R.', 'Devon K.'], planted_events: [] },
    records: records,
    customers: [{ customer_id: 'c_0000000000000001', display_name: 'Customer 1', email: 'customer1@example.com', segment: 'repeat', sales_channel: 'dtc_web', region: 'US', first_seen: '2026-07-02T14:00:00Z', orders_12m: 3, ltv_usd: 600, subscriber: false, subscription_status: 'none', subscription_cadence_months: null, subscription_value_12m_usd: null, cancelled_at: null, cancel_reason: null, hcp_code: null, practice_id: null, restricted: false },
      { customer_id: 'c_0000000000000002', display_name: 'Customer 2', email: 'customer2@example.com', segment: 'subscriber', sales_channel: 'dtc_web', region: 'US', first_seen: '2026-07-06T15:30:00Z', orders_12m: 4, ltv_usd: 800, subscriber: true, subscription_status: 'active', subscription_cadence_months: 1, subscription_value_12m_usd: 2400, cancelled_at: null, cancel_reason: null, hcp_code: null, practice_id: null, restricted: false }],
    practices: [{ practice_id: 'p_1', name: 'Lakeview Wellness', type: 'physician', region: 'US' }],
    orders_by_month: { _total: { '2026-07': 3100, '2026-08': 2900, '2026-09': 3000 }, prolon_5day: { '2026-07': 1200, '2026-08': 1100, '2026-09': 1150 } }
  };

  /* ---- init ---- */
  var events = { ready: 0, filtered: 0, changed: 0, settings: 0 };
  store.on('ready', function () { events.ready += 1; });
  store.on('filtered', function () { events.filtered += 1; });
  store.on('records:changed', function () { events.changed += 1; });
  store.on('settings:changed', function () { events.settings += 1; });
  var initDone = false, initErr = null;
  store.init({ seed: seed }).then(function () { initDone = true; }, function (e) { initErr = e; });
  drain();
  assert(initDone && !initErr, 'init() resolves under jsc' + (initErr ? ' (' + (initErr && initErr.message) + ')' : ''));
  if (!initDone) { console.log(initErr && initErr.stack); throw new Error('store.init did not resolve'); }
  assert(store.ready() && events.ready === 1, 'ready() true and ready event fired once');
  assert(store.now().toISOString() === '2026-09-16T23:59:00.000Z' && store.clockMode() === 'demo', 'demo clock returns as_of');
  assert(store.allWithNoise().length === 30 && store.all().length === 29, 'all() drops the noise record, allWithNoise keeps it');
  assert(store.all()[0].id === 'r_000030' && store.all()[28].id === 'r_000001', 'all() sorted received_at desc');
  assert(store.customers().size === 2 && store.customer('c_0000000000000002').segment === 'subscriber' && store.practices().size === 1, 'customers/practices maps');
  assert(store.meta().as_of === AS_OF, 'meta()');

  /* ---- derived fields ---- */
  var byId = {};
  store.all().forEach(function (r) { byId[r.id] = r; });
  var r1 = byId.r_000001, r24 = byId.r_000024, r29 = byId.r_000029, r17 = byId.r_000017;
  assert(r1.day_key === '2026-07-02' && r1.week_key === '2026-W27' && r1.month_key === '2026-07' && r1.dow === 3 && r1.hour === 9, 'day/week/month keys, dow, hour in CT');
  assert(typeof r1.sentiment_index === 'number' && r1.sentiment_index >= 0 && r1.sentiment_index <= 100, 'sentiment_index in 0–100');
  assert(r1.is_promoter === true && r1.is_detractor === false && byId.r_000002.is_detractor === true, 'promoter/detractor flags');
  assert(byId.r_000002.is_complaint === true && r1.is_complaint === false, 'is_complaint');
  assert(Math.abs(r1.frt_hours - 5) < 1e-9 && Math.abs(r1.resolution_hours - 30) < 1e-9 && r1.is_open === false, 'frt/resolution hours, closed record');
  assert(r17.is_open === true && r17.frt_hours === null && r17.sla_frt_hours === 4 && r17.sla_frt_breached === true && r17.age_hours > 300, 'open P1 without response breaches SLA');
  assert(r24.regulatory_clock === 'medwatch_15bd' && r24.regulatory_deadline === u.addBusinessDays('2026-09-10T15:00:00Z', 15) && typeof r24.business_days_remaining === 'number' && r24.business_days_remaining > 0, 'serious AE gets a MedWatch 15-business-day clock');
  assert(r29.regulatory_clock === 'rfr_24h' && r29.regulatory_deadline === '2026-09-16T20:00:00.000Z' && typeof r29.hours_remaining === 'number' && r29.hours_remaining < 0, 'food safety on conventional food gets a 24h RFR clock (already past)');
  assert(r1.regulatory_clock === 'none' && r1.regulatory_deadline === null && r1.hours_remaining === null, 'no clock on ordinary records');
  /* clock semantics: RFR covers conventional food and supplements (not programs); MedWatch is statutory only on a supplement */
  assert(r24.regulatory_clock_basis === 'statutory' && r29.regulatory_clock_basis === 'statutory' && r1.regulatory_clock_basis === null, 'serious AE on L-Pill and RFR on a kit are statutory; ordinary records carry no basis');
  var dNow = store.now();
  function clockOf(o) {
    var r = rec(90, Object.assign({ at: '2026-09-15T20:00:00Z', category: 'foreign_material_allergen', subcategory: 'hard_bits', sentiment: -0.7, subject: 'x', text: 'x' }, o));
    r.product_class = VOC.enums.productClass(r.product);
    store.derive(r, dNow);
    return r;
  }
  var fsPill = clockOf({ product: 'l_pill', food: true });
  var fsProgram = clockOf({ product: 'guided_health', food: true });
  var fsKit = clockOf({ product: 'fast_bar', food: true });
  var aeKit = clockOf({ product: 'prolon_5day', ae: true, serious: true, category: 'adverse_event', subcategory: 'fainting' });
  var aeProgram = clockOf({ product: 'guided_health', ae: true, serious: true, category: 'adverse_event', subcategory: 'fainting' });
  assert(fsPill.regulatory_clock === 'rfr_24h' && fsPill.regulatory_clock_basis === 'statutory' && fsPill.regulatory_deadline === '2026-09-16T20:00:00.000Z', 'food safety on a supplement (L-Pill) gets the 24h RFR clock');
  assert(fsKit.regulatory_clock === 'rfr_24h' && fsKit.regulatory_clock_basis === 'statutory', 'food safety on a conventional food (Fast Bar) gets the 24h RFR clock');
  assert(fsProgram.regulatory_clock === 'none' && fsProgram.regulatory_clock_basis === null && fsProgram.regulatory_deadline === null, 'food safety on a program carries no RFR clock');
  assert(aeKit.regulatory_clock === 'medwatch_15bd' && aeKit.regulatory_clock_basis === 'voluntary' && aeKit.regulatory_deadline === u.addBusinessDays('2026-09-15T20:00:00Z', 15), 'serious AE on a conventional-food kit keeps the 15-business-day clock, labeled voluntary');
  assert(aeProgram.regulatory_clock === 'medwatch_15bd' && aeProgram.regulatory_clock_basis === 'voluntary', 'serious AE on a program keeps the 15-business-day clock, labeled voluntary');
  assert(r1.recovered === null && Array.isArray(r1.audit) && r1.audit.length === 0, 'overlay defaults');
  assert((typeof r17.churn_score === 'number' || r17.churn_score === null) && (typeof r17.escalation_score === 'number' || r17.escalation_score === null) && (typeof r17.pred_csat === 'number' || r17.pred_csat === null), 'lazy prediction fields are number|null');
  if (stubbedPredict) assert(r17.churn_score === 42 && r17.escalation_score === 17 && r17.pred_csat === 3.5 && r1.escalation_score === null && r1.pred_csat === null, 'lazy fields call VOC.predict for open records only');

  /* ---- filters and presets ---- */
  var f = store.filters();
  assert(f.range.preset === '30d' && f.range.from === '2026-08-18' && f.range.to === '2026-09-16' && f.compare === 'prior_period', 'default 30d range ends on the demo clock day');
  function countIn(from, to, pred) {
    return store.all().filter(function (r) { return r.day_key >= from && r.day_key <= to && (!pred || pred(r)); }).length;
  }
  assert(store.filtered().length === countIn('2026-08-18', '2026-09-16'), 'filtered() honours the 30d range (n = ' + store.filtered().length + ')');
  store.setFilters({ range: { preset: '7d' } });
  assert(store.filters().range.from === '2026-09-10' && store.filtered().length === countIn('2026-09-10', '2026-09-16'), '7d preset');
  store.setFilters({ range: { preset: '90d' } });
  assert(store.filters().range.from === '2026-06-19' && store.filtered().length === 29, '90d preset covers the whole fixture');
  store.setFilters({ range: { preset: '12m' } });
  assert(store.filters().range.from === '2025-09-17', '12m preset = 365 days');
  store.setFilters({ range: { preset: 'custom', from: '2026-09-01', to: '2026-09-10' } });
  assert(store.filtered().length === countIn('2026-09-01', '2026-09-10'), 'custom range inclusive');
  store.setFilters({ range: { preset: '90d' }, category: ['praise'] });
  assert(store.filtered().length === countIn('2026-06-19', '2026-09-16', function (r) { return r.category === 'praise'; }) && store.filtered().length > 0, 'category filter');
  store.setFilters({ category: [], product: 'prolon_nextgen,l_pill' });
  assert(store.filtered().every(function (r) { return r.product === 'prolon_nextgen' || r.product === 'l_pill'; }) && store.filtered().length === countIn('2026-06-19', '2026-09-16', function (r) { return r.product === 'prolon_nextgen' || r.product === 'l_pill'; }), 'product list filter accepts comma strings');
  store.setFilters({ product: [], search: 'charged TWICE' });
  assert(store.filtered().length >= 2 && store.filtered().every(function (r) { return (r.subject + r.text).toLowerCase().indexOf('charged twice') >= 0; }), 'search is case-insensitive over subject/text');
  store.setFilters({ search: '#123456' });
  assert(store.filtered().length === 1 && store.filtered()[0].id === 'r_000003', 'search matches order_id');
  store.setFilters({ search: 'Customer3@EXAMPLE.com' });
  assert(store.filtered().length >= 1 && store.filtered().every(function (r) { return u.normalizeEmail(r.from_email) === 'customer3@example.com'; }), 'search matches the sender address (normalized, case-insensitive)');
  /* restricted records never leak through search: a distinctive word from the body finds nothing until the queue is open or redaction is off */
  store.setFilters({ search: 'metformin' });
  assert(store.filtered().length === 0, 'search over a restricted record\'s distinctive word finds nothing outside the restricted queue');
  store.setFilters({ search: 'r_000016' });
  assert(store.filtered().length === 1 && store.filtered()[0].restricted === true, 'a restricted record stays findable by id');
  store.setFilters({ search: 'metformin', restrictedQueue: true });
  assert(store.filtered().length === 1 && store.filtered()[0].id === 'r_000016', 'the same search finds the record once the restricted queue is on');
  store.setFilters({ restrictedQueue: false });
  store.setSettings({ redactRestricted: false });
  assert(store.filtered().length === 1 && store.filtered()[0].id === 'r_000016', 'with client-side redaction off the search reads restricted bodies');
  store.setSettings({ redactRestricted: true });
  assert(store.filtered().length === 0, 'turning redaction back on hides the restricted body from search again');
  /* customer filter: one customer_id, round-trips through the query, never a name */
  store.setFilters({ search: '', customer: 'c_0000000000000002' });
  assert(store.filtered().length >= 1 && store.filtered().every(function (r) { return r.customer_id === 'c_0000000000000002'; }), 'customer filter keeps only that customer\'s records');
  assert(store.toQuery().indexOf('customer=c_0000000000000002') > 0 && store.parseQuery('customer=c_0000000000000002').customer === 'c_0000000000000002', 'customer filter serializes as customer=c_… and parses back');
  store.setFilters({ customer: 'jane@example.com' });
  assert(store.parseQuery('customer=Jane%20Doe').customer === null && store.filters().customer === null, 'a customer filter that is not a customer_id is dropped');
  store.setFilters({ customer: 'c_0000000000000002' });
  assert(store.applyDimensionFilters(store.all(), { customer: 'c_0000000000000002' }).every(function (r) { return r.customer_id === 'c_0000000000000002'; }), 'applyDimensionFilters honors customer');
  store.setFilters({ customer: null });
  assert(store.filters().customer === null && store.toQuery().indexOf('customer=') < 0, 'clearing the customer filter drops it from the query');
  store.setFilters({ search: '', status: ['open', 'new'] });
  assert(store.filtered().every(function (r) { return r.status === 'open' || r.status === 'new'; }) && store.filtered().length === countIn('2026-06-19', '2026-09-16', function (r) { return r.status === 'open' || r.status === 'new'; }), 'status filter');
  store.setFilters({ status: [], sentiment: ['unscored'] });
  assert(store.filtered().length === countIn('2026-06-19', '2026-09-16', function (r) { return r.sentiment_label === 'unscored'; }), 'sentiment filter uses labels');
  store.setFilters({ sentiment: [], restrictedQueue: true });
  assert(store.filtered().length === 1 && store.filtered()[0].restricted === true, 'restricted queue');
  store.setFilters({ restrictedQueue: false, flags: ['open', 'unassigned'] });
  assert(store.filtered().length > 0 && store.filtered().every(function (r) { return r.is_open && !r.assignee; }), 'flags filter (open, unassigned)');
  store.setFilters({ flags: ['sla_breached'] });
  assert(store.filtered().length > 0 && store.filtered().every(function (r) { return r.is_open && r.frt_hours === null && r.sla_frt_breached; }), 'flags filter (sla_breached)');
  store.setFilters({ flags: [], assignee: ['unassigned'] });
  assert(store.filtered().length === 29, 'assignee filter: unassigned matches null');
  store.resetFilters();
  assert(store.filters().range.preset === '30d' && store.filters().assignee.length === 0 && events.filtered > 5, 'resetFilters and filtered events');

  /* ---- compare sets ---- */
  store.setFilters({ range: { preset: 'custom', from: '2026-09-01', to: '2026-09-16' } });
  var cr = store.compareRange();
  assert(cr.from === '2026-08-16' && cr.to === '2026-08-31', 'prior period of equal length (16 days)');
  assert(store.compareSet().length === countIn('2026-08-16', '2026-08-31'), 'compareSet applies the same filters to the prior period');
  store.setFilters({ compare: 'prior_year' });
  assert(store.compareRange().from === '2025-09-01' && store.compareSet().length === 0, 'prior_year shift');
  store.setFilters({ compare: 'none' });
  assert(store.compareSet().length === 0 && store.compareRange() === null, 'compare none → []');
  store.setFilters({ compare: 'prior_period' });

  /* ---- derived state ---- */
  var d = store.derived();
  assert(d.n === store.filtered().length && d.records.length === d.n && d.compare.length === store.compareSet().length, 'derived() n/records/compare');
  assert(d.byDay.length === 16 && d.byDay[0].key === '2026-09-01' && d.byDay[15].key === '2026-09-16', 'byDay zero-filled over the range');
  assert(d.byDay.reduce(function (s, x) { return s + x.count; }, 0) === d.n, 'byDay counts sum to n');
  assert(d.byDay.every(function (x) { return x.count > 0 || x.meanSentiment === null; }), 'empty days carry meanSentiment null, never NaN');
  assert(d.byWeek.length === 3 && d.byWeek[0].key === '2026-W36' && d.byWeek[2].key === '2026-W38', 'byWeek covers W36–W38');
  var shareSum = d.byCategory.reduce(function (s, x) { return s + x.share; }, 0);
  assert(d.byCategory.length === 17 && Math.abs(shareSum - 1) < 1e-9 && d.byCategory[0].id === 'subscription_billing', 'byCategory in display order, shares sum to 1');
  assert(d.byProduct.length === 13 && d.byChannel.length === 8 && d.bySegment.length === 8, 'byProduct/byChannel/bySegment cover every enum id');
  assert(d.bySubcategory.length > 0 && d.bySubcategory[0].count >= d.bySubcategory[d.bySubcategory.length - 1].count && d.bySubcategory[0].category, 'bySubcategory sorted desc with parent category');
  assert(d.kpis.volume && d.kpis.volume.value === d.n && d.kpis.volume.n === d.n, 'kpis.volume via VOC.metrics' + (stubbedMetrics ? ' (stub)' : ''));
  // The fixture's prior 30 days hold a handful of records, so the comparison is thin: prev is kept, delta withheld, deltaNote says why.
  assert(d.compareMeta && d.compareMeta.n === d.compare.length && d.compareMeta.from === store.compareRange().from && d.compareMeta.thin === true && /n=\d+/.test(d.compareMeta.reason), 'derived.compareMeta describes the thin prior period: ' + (d.compareMeta && d.compareMeta.reason));
  assert(typeof d.kpis.volume.prev === 'number' && d.kpis.volume.delta === null && typeof d.kpis.volume.deltaNote === 'string' && /too few records \(n=\d+\)/.test(d.kpis.volume.deltaNote), 'thin compare: kpi prev kept, delta null, deltaNote carries n');
  assert(Object.keys(d.kpis).every(function (id) { return d.kpis[id].delta === null; }), 'thin compare withholds every kpi delta');
  store.setFilters({ range: { preset: 'custom', from: '2026-07-01', to: '2026-07-31' } });
  var dJul = store.derived();
  assert(dJul.compareMeta.thin === true && /^no data before 2026-07-02/.test(dJul.compareMeta.reason) && dJul.kpis.volume.deltaNote === dJul.compareMeta.reason, 'compare window before the earliest record → "no data before <date>" note: ' + dJul.compareMeta.reason);
  store.setFilters({ range: { preset: 'custom', from: '2026-09-01', to: '2026-09-16' }, compare: 'none' });
  var dNone = store.derived();
  assert(dNone.compareMeta.thin === false && dNone.compareMeta.from === null && dNone.kpis.volume.prev === null && dNone.kpis.volume.delta === null && dNone.kpis.volume.deltaNote === null, 'compare none → compareMeta not thin, no prev/delta/deltaNote');
  store.setFilters({ compare: 'prior_period' });
  d = store.derived();   // filters are back where they were; the memo check below compares against this fresh state
  assert(d.dq.openOlderThan45d === 0 && d.dq.openTotal === 9 && d.dq.staleOpenDays === 45, 'dq.openOlderThan45d counts open records older than 45 days over the whole store (none in the fixture, 9 open)');
  var bad = [];
  noNaN(d.kpis, 'kpis', bad); noNaN(d.byDay, 'byDay', bad); noNaN(d.byCategory, 'byCategory', bad); noNaN(d.dq, 'dq', bad);
  assert(bad.length === 0, 'no NaN/Infinity anywhere in kpis/byDay/byCategory/dq' + (bad.length ? ': ' + bad.slice(0, 5).join(', ') : ''));
  assert(d.regulatory.openSerious.length === 1 && d.regulatory.openSerious[0].id === 'r_000024' && d.regulatory.openFoodSafety.length === 1, 'regulatory open serious AE and food safety (ignores range)');
  assert(d.regulatory.deadlines.length === 2 && d.regulatory.deadlines[0].rec.id === 'r_000029' && d.regulatory.deadlines[0].clock === 'rfr_24h' && d.regulatory.deadlines[1].clock === 'medwatch_15bd', 'deadlines sorted soonest first');
  assert(d.dq.noiseDropped === 0 && d.dq.duplicatesRemoved === 0 && d.dq.ordersCoverageMonths === 3 && d.dq.needsReviewPct >= 0 && d.dq.needsReviewPct <= 1, 'dq counters');
  assert(d.dq.agreementCategory !== null && d.dq.agreementCategory >= 0 && d.dq.agreementCategory <= 1 && (d.dq.agreementSentiment === null || (d.dq.agreementSentiment >= 0 && d.dq.agreementSentiment <= 1)), 'dq agreement shares in [0,1]');
  assert(Array.isArray(d.alerts), 'alerts array present');
  if (VOC.alerts) {
    assert(d.alerts.some(function (a) { return a.ruleId === 'ae_received' && a.severity === 'critical'; }), 'ae_received alert for the open serious AE');
    assert(d.alerts.some(function (a) { return a.ruleId === 'food_safety_received'; }), 'food_safety_received alert');
    assert(d.alerts.some(function (a) { return a.ruleId === 'p1_cluster' && a.n === 3; }), 'p1_cluster alert for 3 duplicate_charge P1 within 24h');
    assert(d.alerts.some(function (a) { return a.ruleId === 'sla_breach'; }), 'sla_breach alert');
    assert(d.alerts.every(function (a) { return a.id && a.title && a.at && !/\bwill\b/i.test(a.title + ' ' + a.detail); }), 'alerts have id/title/at and avoid "will"');
    var first = d.alerts[0];
    VOC.alerts.ack(first.id);
    assert(VOC.alerts.active().every(function (a) { return a.id !== first.id; }), 'ack removes an alert from active()');
    assert(VOC.alerts.history().some(function (h) { return h.id === first.id; }), 'history records alerts');
    var until = VOC.alerts.snooze(d.alerts[1].id, 4);
    assert(until && VOC.alerts.active().every(function (a) { return a.id !== d.alerts[1].id; }), 'snooze hides an alert');
    VOC.alerts.reset();
  }
  assert(store.derived() === d, 'derived() memoized until something changes');

  /* ---- overlays: update / bulkUpdate / undo / addNote ---- */
  var changedBefore = events.changed;
  var upd = store.update('r_000017', { status: 'resolved', assignee: 'Maya R.' }, 'Tester');
  assert(upd.status === 'resolved' && upd.assignee === 'Maya R.' && upd.is_open === false, 'update() applies overlay and re-derives');
  assert(upd.audit.length === 2 && upd.audit[0].field === 'status' && upd.audit[0].from === 'open' && upd.audit[0].to === 'resolved' && upd.audit[0].by === 'Tester', 'audit entries appended');
  assert(store.record('r_000017').status === 'resolved' && store.all().filter(function (r) { return r.id === 'r_000017'; })[0].assignee === 'Maya R.', 'overlay visible through all() and record()');
  assert(store.overlays().get('r_000017').updated_at === store.now().toISOString(), 'overlay updated_at set');
  assert(events.changed === changedBefore + 1 && store.derived() !== d, 'records:changed fired and derived cache invalidated');
  store.update('r_000017', { status: 'resolved' });
  assert(store.record('r_000017').audit.length === 2, 'identical patch adds no audit entry');
  assert(store.record('r_000027').classifier.needs_review === true && store.record('r_000027').classifier.manual_override === false, 'seed needs_review flag survives projection');
  var over = store.update('r_000027', { category: 'usage_guidance', subcategory: 'refeed_transition' });
  assert(over.category === 'usage_guidance' && over.classifier.manual_override === true && over.classifier.needs_review === false, 'category override marks manual_override and clears needs_review');

  var ids = ['r_000018', 'r_000021', 'r_000028'];
  var batch = store.bulkUpdate(ids, { assignee: 'Devon K.', tags: ['billing-bug'] }, 'Tester');
  assert(typeof batch === 'string' && store.lastBatchId() === batch, 'bulkUpdate returns a batch id');
  assert(ids.every(function (id) { var r = store.record(id); return r.assignee === 'Devon K.' && r.tags[0] === 'billing-bug'; }), 'bulk patch applied to every id');
  assert(store.undo(batch) === true, 'undo(batchId) returns true');
  assert(ids.every(function (id) { var r = store.record(id); return r.assignee === null && r.tags.length === 0; }), 'undo reverts field values');
  var audit18 = store.record('r_000018').audit;
  assert(audit18.length === 4 && audit18.filter(function (e) { return e.undo === batch; }).length === 2, 'undo keeps the original audit entries and appends undo entries');
  assert(store.undo(batch) === false && store.undo('nope') === false, 'undo of an unknown/used batch returns false');

  var noted = store.addNote('r_000017', 'Refund issued.', 'Tester');
  assert(noted.notes.length === 1 && noted.notes[0].text === 'Refund issued.' && noted.audit[noted.audit.length - 1].field === 'note', 'addNote appends a note and an audit entry');
  assert(store.addNote('r_000017', '   ').notes.length === 1, 'blank notes are ignored');

  /* ---- query round trip ---- */
  store.setFilters({ range: { preset: 'custom', from: '2026-09-01', to: '2026-09-10' }, product: ['prolon_nextgen', 'l_pill'], search: 'hard bits', compare: 'none', flags: ['open'] });
  var q = store.toQuery();
  assert(q.indexOf('range=custom') === 0 && q.indexOf('from=2026-09-01') > 0 && q.indexOf('to=2026-09-10') > 0 && q.indexOf('product=prolon_nextgen,l_pill') > 0 && q.indexOf('search=hard%20bits') > 0 && q.indexOf('compare=none') > 0, 'toQuery format: ' + q);
  var snapshot = JSON.stringify(store.filters());
  store.resetFilters();
  assert(store.toQuery() === 'range=30d', 'default filters serialize to range=30d');
  store.fromQuery('?' + q);
  assert(JSON.stringify(store.filters()) === snapshot, 'fromQuery(toQuery()) round-trips the FilterState');
  var parsed = store.parseQuery('range=7d&category=praise,other_noise&restricted=1');
  assert(parsed.range.preset === '7d' && parsed.category.length === 2 && parsed.restrictedQueue === true, 'parseQuery');
  store.resetFilters();

  /* ---- addRecords: dedupe, classification, persistence ---- */
  var addResult = null;
  store.addRecords([records[0], Object.assign({}, records[1], { id: 'x_dup_by_fingerprint' })], 'json').then(function (r) { addResult = r; });
  drain();
  assert(addResult && addResult.added === 0 && addResult.duplicates === 2, 'duplicates by id and by fingerprint are skipped');
  var fresh = Object.assign({}, records[4], { id: 'im_fresh000000001', from_email: 'fresh@example.com', received_at: '2026-09-14T10:00:00Z', subject: 'Fresh question', text: 'Can I take L-Pill with coffee?' });
  store.addRecords([fresh], 'json').then(function (r) { addResult = r; });
  drain();
  assert(addResult.added === 1 && store.all().length === 30 && store.record('im_fresh000000001').source === 'json', 'a new Record is added (source json)');
  var raw = {
    message_id: '<raw1@example.com>', thread_id: null, in_reply_to: null, references: [], date: '2026-09-15T14:05:00Z', from_name: 'Raw Sender', from_email: 'raw@example.com',
    to: ['support@l-nutra.com'], cc: [], subject: 'Order arrived late and box was crushed', text: 'My order #654321 arrived late and the box was crushed. Very disappointed.', html: null,
    direction: 'inbound', attachments: [], headers: { auto_submitted: null, precedence: null, list_id: null, list_unsubscribe: null, content_type: 'text/plain', x_autoreply: null }, source: 'eml'
  };
  store.addRecords([raw], 'eml').then(function (r) { addResult = r; });
  drain();
  assert(addResult.added === 1 && store.all().length === 31, 'RawEmail is converted to a Record' + (VOC.classify ? ' via VOC.classify' : ' via the local fallback'));
  var rawRec = store.all().filter(function (r) { return r.from_email === 'raw@example.com'; })[0];
  assert(rawRec && rawRec.received_at === '2026-09-15T14:05:00.000Z' && rawRec.category && rawRec.subcategory && rawRec.urgency && rawRec.classifier && typeof rawRec.classifier.needs_review === 'boolean' && rawRec.day_key === '2026-09-15', 'imported record has every field defaulted and derived');
  store.addRecords([raw], 'eml').then(function (r) { addResult = r; });
  drain();
  assert(addResult.added === 0 && addResult.duplicates === 1, 're-importing the same RawEmail adds 0');
  var auto = Object.assign({}, raw, { message_id: '<auto@example.com>', date: '2026-09-15T15:00:00Z', from_email: 'ooo@example.com', subject: 'Automatic reply: Out of office', text: 'I am out of the office.', headers: Object.assign({}, raw.headers, { auto_submitted: 'auto-replied' }) });
  store.addRecords([auto], 'eml').then(function (r) { addResult = r; });
  drain();
  assert(addResult.added === 1 && addResult.noise === 1 && store.all().length === 31 && store.allWithNoise().length === 33, 'auto-reply counted as noise and excluded from all()');
  var reply = Object.assign({}, raw, { message_id: '<reply1@example.com>', in_reply_to: '<raw1@example.com>', references: ['<raw1@example.com>'], date: '2026-09-15T16:30:00Z', from_email: 'support@l-nutra.com', direction: 'outbound', subject: 'Re: Order arrived late', text: 'So sorry, replacement on the way.' });
  store.addRecords([reply], 'eml').then(function (r) { addResult = r; });
  drain();
  assert(addResult.added === 0 && addResult.responses === 1 && Math.abs(store.record(rawRec.id).frt_hours - 2.4167) < 0.01 && store.record(rawRec.id).service_fields_source === 'sent_folder', 'outbound mail sets first_response_at on its thread');
  assert(store.derived().dq.duplicatesRemoved === 3, 'dq.duplicatesRemoved accumulates');
  var dbRecs = null;
  VOC.db.getAll('records').then(function (rows) { dbRecs = rows; });
  drain();
  assert(VOC.db.persistence() === 'memory' && dbRecs && dbRecs.length === 3 && !dbRecs.some(function (r) { return r.id === 'r_000001'; }), 'imported (non-seed) records persisted to VOC.db (memory fallback under jsc)');
  var dbOv = null;
  VOC.db.getAll('overlays').then(function (rows) { dbOv = rows; });
  drain();
  assert(dbOv && dbOv.some(function (o) { return o.id === 'r_000017' && o.status === 'resolved'; }), 'overlays persisted to VOC.db');
  assert(store.clockMode() === 'demo', 'imports older than as_of keep the demo clock');
  var future = Object.assign({}, fresh, { id: 'im_future00000001', from_email: 'future@example.com', received_at: '2026-09-18T12:00:00Z', subject: 'Newer than as_of' });
  store.addRecords([future], 'json');
  drain();
  assert(store.clockMode() === 'real' && store.now().getTime() > Date.parse(AS_OF), 'a record newer than as_of switches to the wall clock');

  /* ---- settings ---- */
  var settingsBefore = events.settings;
  store.setSettings({ sla: { P2: 12 }, theme: 'dark', me: 'Maya R.' });
  var s = store.settings();
  assert(s.sla.P2 === 12 && s.sla.P0 === 1 && s.theme === 'dark' && s.me === 'Maya R.' && s.clock === 'demo' && s.redactRestricted === true && s.connector.port === 993, 'setSettings merges sla/connector one level deep');
  assert(events.settings === settingsBefore + 1 && store.record('r_000023').sla_frt_hours === 12, 'settings event fired and SLA change re-derives');
  assert(store.settings().agents.length === 2 && store.settings().agents[0] === 'Maya R.', 'agents default from seed meta');
  store.setFilters({ range: { preset: '12m' }, flags: ['mine'] });
  assert(store.filtered().length === 1 && store.filtered()[0].id === 'r_000017', 'mine flag uses settings.me');
  store.resetFilters();

  /* ---- orders ---- */
  assert(store.ordersInRange('2026-08-01', '2026-08-31') === 2900 && store.ordersInRange('2026-07-01', '2026-09-30') === 9000, 'ordersInRange whole months');
  assert(store.ordersInRange('2026-08-01', '2026-08-31', 'prolon_5day') === 1100 && store.ordersInRange('2026-08-01', '2026-08-31', 'fast_bar') === null, 'ordersInRange per product / unknown product null');
  assert(store.ordersInRange('2026-06-15', '2026-07-15') === null && store.ordersInRange('2026-09-16', '2026-09-01') === null, 'missing month or inverted range → null');
  assert(store.ordersInRange('2026-09-01', '2026-09-15') === 1500, 'partial month prorated by days');
  assert(Math.abs(store.ordersInRange('2026-08-01', '2026-08-01', 'prolon_5day') - 1100 / 31) < 1e-9 && Math.abs(store.ordersInRange('2026-08-30', '2026-09-02') - (2900 * 2 / 31 + 3000 * 2 / 30)) < 1e-9,
    'prorated totals are returned unrounded (single day 35.48, not 35; metrics round for display)');
  assert(VOC.analytics && typeof VOC.analytics.ordersInRange === 'function' ? Math.abs(store.ordersInRange('2026-08-01', '2026-08-01', 'prolon_5day') - VOC.analytics.ordersInRange(store.orders(), '2026-08-01', '2026-08-01', 'prolon_5day')) < 1e-9 : true,
    'store.ordersInRange agrees with analytics.ordersInRange for the same range');
  store.setOrders({ _total: { '2026-09': 100 } });
  assert(store.orders()._total['2026-09'] === 100 && store.ordersInRange('2026-08-01', '2026-08-31') === null, 'setOrders replaces the table');

  /* ---- saved views and drill ---- */
  var views = store.savedViews();
  assert(views.length >= 9 && views.some(function (v) { return v.id === 'all_open' && v.builtin; }) && views.some(function (v) { return v.id === 'ae_register'; }), 'built-in saved views present');
  var saved = store.saveView({ name: 'Billing P1', filters: { range: { preset: '90d' }, category: ['subscription_billing'], urgency: ['P1'] } });
  assert(saved.id && store.savedViews().some(function (v) { return v.id === saved.id && !v.builtin; }), 'saveView adds a custom view');
  assert(store.deleteView(saved.id) === true && !store.savedViews().some(function (v) { return v.id === saved.id; }) && store.deleteView('all_open') === false, 'deleteView removes custom views only');
  var drilled = null;
  store.on('drill', function (p) { drilled = p; });
  store.drill({ view: 'inbox', filters: { category: ['praise'] }, id: 'r_000001' });
  assert(drilled && drilled.view === 'inbox' && drilled.id === 'r_000001' && store.filters().category[0] === 'praise' && drilled.query.indexOf('category=praise') > 0, 'drill sets filters and emits without a router');
  store.resetFilters();
  // with a router the route carries the query; the current filters (and so the origin's history entry) stay untouched until the new route applies them
  var nav = null, filteredDuringDrill = 0, beforeDrill = JSON.stringify(store.filters());
  var countFiltered = function () { filteredDuringDrill += 1; };
  store.on('filtered', countFiltered);
  VOC.router = { navigate: function (name, opts) { nav = { name: name, opts: opts }; } };
  store.drill({ view: 'inbox', filters: { product: ['fast_bar'], sentiment: ['negative'] } });
  store.off('filtered', countFiltered);
  assert(nav && nav.name === 'inbox' && nav.opts.query.indexOf('product=fast_bar') > 0 && nav.opts.query.indexOf('sentiment=negative') > 0 && nav.opts.query.indexOf('range=30d') === 0,
    'with a router, drill navigates with the merged query: ' + (nav && nav.opts.query));
  assert(JSON.stringify(store.filters()) === beforeDrill && filteredDuringDrill === 0, 'drill with a router emits no "filtered" and leaves the origin filters unchanged');
  var arrived = store.fromQuery(nav.opts.query);
  assert(arrived.product[0] === 'fast_bar' && arrived.sentiment[0] === 'negative' && arrived.range.preset === '30d', 'the drilled query round-trips through fromQuery on arrival');
  delete VOC.router;
  store.resetFilters();

  /* ---- events off ---- */
  var cnt = 0; function h() { cnt += 1; }
  store.on('filtered', h); store.setFilters({ search: 'x' }); store.off('filtered', h); store.setFilters({ search: '' });
  assert(cnt === 1, 'off() detaches a listener');

  /* ---- quoted-reply tails and signatures on stored text (cleanText / text_raw) ---- */
  var quoted = 'Great product, lost 5 lbs.\n\nRegards,\nSophie Baker\n\nOn Wed, Sep 2, 2026 at 1:05 PM, L-Nutra Customer Care <care@prolonlife.com> wrote:\n> Hi Sophie, thanks for reaching out!\n> Best, Maya R.\n\nSent from my iPhone';
  var plain = { id: 'r_plain', received_at: '2026-09-03T15:00:00Z', subject: 'Plain', text: 'No markers here at all.', category: 'praise', subcategory: 'general_praise', sentiment: 0.5, sentiment_label: 'positive', status: 'resolved' };
  var cleaned = store.cleanText({ text: quoted });
  if (VOC.classify && typeof VOC.classify.preprocess === 'function') {
    assert(cleaned.text.indexOf('wrote:') < 0 && cleaned.text.indexOf('Sent from my') < 0 && /lost 5 lbs/.test(cleaned.text) && cleaned.text_raw === quoted, 'cleanText strips the quoted tail and signature into text, keeps the original in text_raw');
    var again = store.cleanText({ text: cleaned.text, text_raw: cleaned.text_raw });
    assert(again.text === cleaned.text && again.text_raw === quoted, 'cleanText is idempotent (no marker → untouched, text_raw preserved)');
    var addQ = null;
    store.addRecords([{ id: 'r_quoted', received_at: '2026-09-04T15:00:00Z', subject: 'Quoted', text: quoted, category: 'praise', subcategory: 'general_praise', sentiment: 0.5, sentiment_label: 'positive', status: 'resolved' }, plain], 'json').then(function (s) { addQ = s; });
    drain();
    var rq = store.record('r_quoted'), rp = store.record('r_plain');
    assert(addQ && addQ.added === 2 && rq && rq.text.indexOf('wrote:') < 0 && rq.text_raw === quoted && rp.text_raw === undefined && rp.text === plain.text, 'addRecords cleans imported text with a marker and leaves marker-free text alone (no text_raw)');
  } else {
    assert(cleaned.text === quoted && cleaned.text_raw === undefined, 'cleanText is a no-op without VOC.classify');
  }
  var staleOpen = { id: 'r_stale', received_at: '2026-07-01T15:00:00Z', subject: 'Still waiting', text: 'Nobody has answered me.', category: 'customer_service', subcategory: 'no_response', sentiment: -0.5, sentiment_label: 'negative', status: 'open', first_response_at: null };
  store.addRecords([staleOpen], 'json');
  drain();
  assert(store.derived().dq.openOlderThan45d === 1, 'dq.openOlderThan45d counts an open record received 77 days before the clock');

  /* ---- a solid comparison window keeps its deltas ---- */
  var filler = [];
  for (var fi = 0; fi < 24; fi++) {
    filler.push({ id: 'r_fill_' + fi, received_at: '2026-08-' + String(16 + (fi % 15)).padStart(2, '0') + 'T15:00:00Z', subject: 'Filler ' + fi, text: 'Filler record ' + fi + ' for the prior window.',
      category: 'praise', subcategory: 'general_praise', sentiment: 0.4, sentiment_label: 'positive', status: 'resolved', nps: 9 });
  }
  store.addRecords(filler, 'json');
  drain();
  store.setFilters({ range: { preset: 'custom', from: '2026-09-01', to: '2026-09-16' }, compare: 'prior_period' });
  var dSolid = store.derived();
  assert(dSolid.compareMeta.thin === false && dSolid.compareMeta.n >= 20 && dSolid.compareMeta.reason === null, 'compareMeta not thin once the prior period holds ≥ 20 records (n=' + dSolid.compareMeta.n + ')');
  assert(dSolid.kpis.volume.delta && typeof dSolid.kpis.volume.delta.text === 'string' && dSolid.kpis.volume.deltaNote === null && typeof dSolid.kpis.volume.prev === 'number', 'solid compare: kpi delta text present, deltaNote null');
  store.resetFilters();

  /* ---- importOverlays validates enum fields; setOrders sanitizes file-sourced tables ---- */
  var ovRes = store.importOverlays([
    { id: 'r_000005', status: 'bogus', urgency: 'P1', category: 'nope', tags: ['vip'] },
    { id: 'r_000006', product: 'unicorn', serious_ae: 'yes' },
    { id: 'r_000007', subcategory: 'late', product: 'fast_bar', recovered: 'maybe' }
  ], { actor: 'Restore' });
  assert(ovRes.applied === 2 && ovRes.skipped === 1 && ovRes.invalidFields === 5, 'importOverlays drops invalid enum/flag fields and counts them (applied ' + ovRes.applied + ', skipped ' + ovRes.skipped + ', invalid ' + ovRes.invalidFields + ')');
  assert(store.record('r_000005').urgency === 'P1' && store.record('r_000005').status === 'resolved' && store.record('r_000005').tags.indexOf('vip') >= 0, 'valid overlay fields still apply when a sibling field is invalid');
  assert(store.record('r_000007').product === 'fast_bar' && store.record('r_000007').subcategory === 'late' && store.record('r_000007').recovered === null, 'known ids from VOC.enums pass; a non-boolean recovered is dropped');
  store.setOrders({ _total: { '2026-09': 100, 'bad-month': 5 }, '__proto__': { '2026-09': 1 }, 'l_pill': { '2026-09': '12', '2026-10': 'x' }, 'bad key!': { '2026-09': 3 } });
  var so = store.orders();
  assert(so._total['2026-09'] === 100 && so._total['bad-month'] === undefined && so.l_pill['2026-09'] === 12 && so.l_pill['2026-10'] === undefined && !Object.prototype.hasOwnProperty.call(so, 'bad key!') && ({})['2026-09'] === undefined, 'setOrders runs importers.sanitizeOrders: bad months, keys and counts are dropped, no prototype pollution');

  /* ---- resetDemo ---- */
  var resetDone = false;
  store.resetDemo().then(function () { resetDone = true; });
  drain();
  assert(resetDone && store.all().length === 29 && store.allWithNoise().length === 30 && store.overlays().size === 0, 'resetDemo drops imports and overlays');
  assert(store.record('r_000017').status === 'open' && store.settings().theme === 'system' && store.settings().sla.P2 === 24 && store.clockMode() === 'demo' && store.orders()._total['2026-07'] === 3100, 'resetDemo restores seed state, settings, clock and orders');
  var dbAfter = null;
  VOC.db.getAll('records').then(function (rows) { dbAfter = rows; });
  drain();
  assert(dbAfter && dbAfter.length === 0, 'resetDemo clears VOC.db');

  console.log(total - failures + '/' + total + ' store assertions passed');
  if (failures) throw new Error(failures + ' store assertion(s) failed');
})();
