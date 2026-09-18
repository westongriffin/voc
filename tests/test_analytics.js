/* tests/test_analytics.js — run under jsc after _jsc_shim.js, js/util.js (optional) and js/analytics.js.
 * Builds a deterministic synthetic fixture (~200 records over 90 days) so it does not depend on data.js / store.js.
 */
(function () {
  'use strict';
  var failures = 0, passes = 0;
  function assert(cond, msg) {
    if (cond) { passes++; console.log('PASS ' + msg); }
    else { failures++; console.log('FAIL ' + msg); }
  }
  function near(a, b, tol) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol; }
  function finiteOrNull(v) { return v === null || (typeof v === 'number' && isFinite(v)); }

  var M = VOC.metrics, A = VOC.analytics;
  assert(M && A, 'VOC.metrics and VOC.analytics load under jsc');

  /* ---------------- deterministic PRNG ---------------- */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rng = (VOC.util && typeof VOC.util.rng === 'function') ? VOC.util.rng(20260917) : mulberry32(20260917);
  function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }
  function chance(p) { return rng() < p; }

  /* ---------------- fixture ---------------- */
  var AS_OF = '2026-09-16T23:59:00Z';
  var asOfMs = Date.parse(AS_OF);
  var DAY = 86400000, HOUR = 3600000;
  var GAP_DAY = '2026-08-02';                       // no records on this CT day → bucket must zero-fill it
  var PRODUCTS = ['prolon_5day', 'prolon_nextgen', 'prolon_reset', 'fast_bar', 'fasting_shake', 'l_pill', 'subscription_account', 'general'];
  var CATEGORIES = ['subscription_billing', 'shipping_fulfillment', 'taste_quality', 'side_effects', 'praise', 'usage_guidance', 'price_value', 'customer_service'];
  var SEGMENTS = ['first_time', 'repeat', 'subscriber', 'hcp', 'hcp_patient'];
  var STATUSES = ['resolved', 'resolved', 'resolved', 'resolved', 'open', 'pending', 'new', 'reopened', 'escalated'];
  var URGENCY = ['P0', 'P1', 'P2', 'P2', 'P2', 'P3'];
  var BODIES = {
    subscription_billing: ['I was charged twice for my ProLon order this month. Please refund the duplicate charge.',
      'You charged twice on my card and there is no cancellation link anywhere in the account.',
      'Charged twice again. I want to cancel the subscription and get a refund now.'],
    shipping_fulfillment: ['My box was left on the porch in the heat and the soup bags were warm. Still not arrived for the second kit.',
      'FedEx says delivered but nothing on my porch. The tracking has not moved in four days.',
      'The porch delivery was crushed. Package sat on the porch all afternoon.'],
    taste_quality: ['The minestrone soup tasted bland and the L-Drink was too sweet. The kale crackers were fine.',
      'Astronaut food honestly. The tomato soup is the only edible thing in the kit.',
      'Next Gen soups taste better than before. Olives are salty but good.'],
    side_effects: ['Day 3 headache and hunger were rough but energy on day 4 was great.',
      'Felt dizzy and lightheaded on day 2. Is that normal with the fasting shake?',
      'Nausea on the first day. Brain fog cleared by day four.'],
    praise: ['Lost 6 lbs and feel lighter. Great customer service from Maya as well.',
      'Delicious bars and the program was easy to follow. Energized and focused.',
      'Best reset I have done. Clarity and energy all week. Thank you team.'],
    usage_guidance: ['Can I drink coffee during the five day program? What about light exercise?',
      'How often should I repeat the cycle? Every month or every quarter?',
      'Can I take my medications with the L-Pill? My doctor asked me to check.'],
    price_value: ['At $40 a day this is too expensive for a monthly cycle. Any bundle discount?',
      'Price increase again. The per day cost is hard to justify without HSA coverage.',
      'Not worth the price for the reset kit. Would buy again with a discount.'],
    customer_service: ['No response to my email for five days. The chatbot loops back to the start.',
      'Wrong item sent and the agent was slow to respond. Frustrating experience.',
      'Slow response but the agent Devon fixed the order quickly once reached.']
  };
  var records = [];
  var customers = [];
  var practices = [{ practice_id: 'pr_001', name: 'Lakeshore Longevity', type: 'physician', region: 'US' },
    { practice_id: 'pr_002', name: 'Prairie Wellness', type: 'np', region: 'US' }];
  for (var c = 0; c < 120; c++) {
    var seg = pick(SEGMENTS);
    customers.push({ customer_id: 'c_' + c, display_name: 'Customer ' + c, email: 'c' + c + '@example.com', segment: seg,
      sales_channel: seg === 'hcp' ? 'hcp' : 'dtc_web', region: 'US', first_seen: '2026-01-01T00:00:00Z', orders_12m: 1 + Math.floor(rng() * 4),
      ltv_usd: 200 + Math.floor(rng() * 800), subscriber: seg === 'subscriber', subscription_status: seg === 'subscriber' ? 'active' : 'none',
      subscription_cadence_months: seg === 'subscriber' ? 1 : null, subscription_value_12m_usd: seg === 'subscriber' ? 1800 : null,
      cancelled_at: null, cancel_reason: null, hcp_code: seg === 'hcp' ? 'HCP' + (c % 2) : null, practice_id: seg === 'hcp' ? 'pr_00' + ((c % 2) + 1) : null,
      restricted: seg === 'hcp_patient' });
  }
  var i = 0, made = 0;
  while (made < 200) {
    var dayOffset = Math.floor(rng() * 90);                     // 0..89 days back
    var hour = chance(0.5) ? 9 + Math.floor(rng() * 3) : 19 + Math.floor(rng() * 3);   // bimodal CT hours
    var receivedMs = asOfMs - dayOffset * DAY - 12 * HOUR + Math.floor(rng() * 50) * 60000;
    var ctHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }).format(new Date(receivedMs)), 10) % 24;
    receivedMs += ((hour - ctHour + 24) % 24) * HOUR;                                  // shift so the CT hour equals `hour`
    if (receivedMs > asOfMs) receivedMs -= DAY;
    var received = new Date(receivedMs).toISOString();
    var ctDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(receivedMs));
    if (ctDay === GAP_DAY) continue;
    var cat = CATEGORIES[i % CATEGORIES.length];
    var cust = customers[Math.floor(rng() * customers.length)];
    var sentiment = cat === 'praise' ? 0.4 + rng() * 0.5 : cat === 'usage_guidance' ? -0.1 + rng() * 0.3 : -0.9 + rng() * 0.7;
    var status = pick(STATUSES);
    var frt = chance(0.88) ? Math.exp(Math.log(5) + (rng() - 0.5) * 2) : null;
    var resolved = (status === 'resolved' || status === 'reopened') ? Math.max((frt || 1) + 1, Math.exp(Math.log(30) + (rng() - 0.5) * 3)) : null;
    var nps = chance(0.4) ? (cat === 'praise' ? 9 + Math.floor(rng() * 2) : cat === 'subscription_billing' ? Math.floor(rng() * 7) : Math.floor(rng() * 11)) : null;
    var product = cat === 'subscription_billing' ? 'subscription_account' : PRODUCTS[Math.floor(rng() * 6)];
    var isDetr = nps !== null && nps <= 6;
    records.push({
      id: 'r_' + String(made + 1).padStart(6, '0'), schema_version: 1, received_at: received, channel: chance(0.7) ? 'email' : 'survey',
      sales_channel: cust.sales_channel, from_name: cust.display_name, from_email: cust.email, subject: cat.replace('_', ' ') + ' question',
      text: pick(BODIES[cat]), language: 'en', has_attachment: false, product: product, product_variant: null,
      kit_component: cat === 'taste_quality' ? pick(['soup_minestrone', 'l_drink', 'olives', 'kale_crackers']) : null,
      product_class: product === 'l_pill' ? 'supplement' : 'conventional_food', category: cat, subcategory: 'general_question',
      secondary_categories: chance(0.15) ? [pick(CATEGORIES)] : [], sentiment: sentiment, sentiment_min: sentiment - 0.1,
      sentiment_label: sentiment >= 0.15 ? 'positive' : sentiment <= -0.15 ? 'negative' : 'neutral',
      nps: nps, rating: chance(0.2) ? 1 + Math.floor(rng() * 5) : null, csat: status === 'resolved' && chance(0.45) ? 1 + Math.floor(rng() * 5) : null,
      urgency: pick(URGENCY), status: status,
      first_response_at: frt !== null ? new Date(receivedMs + frt * HOUR).toISOString() : null,
      resolved_at: resolved !== null ? new Date(receivedMs + resolved * HOUR).toISOString() : null,
      reopen_count: status === 'reopened' ? 1 : 0, service_fields_source: 'seed',
      escalated_to: status === 'escalated' ? 'cs_lead' : 'none', is_adverse_event: cat === 'side_effects' && chance(0.2), serious_ae: false,
      ae_criteria: [], contraindication_flags: [], food_safety: cat === 'taste_quality' && chance(0.1),
      lot_number: cat === 'taste_quality' ? pick(['NG-0426-B', 'NG-0501-A', null]) : null, order_id: null, hcp_code: cust.hcp_code,
      claim_related: false, cancel_intent: cat === 'subscription_billing', restricted: cust.restricted,
      customer_id: cust.customer_id, segment: cust.segment, region: 'US', thread_id: 't_' + made, is_first_contact: true, message_id: null,
      source: 'seed', is_noise: false, noise_reason: null, assignee: chance(0.7) ? 'Maya R.' : null, tags: [], notes: [],
      classifier: { confidence: 0.6, rule_category: cat, rule_subcategory: 'general_question', rule_product: product, manual_override: false, needs_review: chance(0.1) },
      recovered: isDetr ? (chance(0.5) ? true : (chance(0.5) ? false : null)) : null,
      churn_score: cust.segment === 'subscriber' ? Math.floor(rng() * 100) : null
    });
    made++; i++;
  }
  assert(records.length === 200, 'fixture has 200 records');

  var orders = { _total: {}, prolon_5day: {}, prolon_nextgen: {}, prolon_reset: {}, fast_bar: {}, fasting_shake: {}, l_pill: {} };
  ['2026-06', '2026-07', '2026-08', '2026-09'].forEach(function (ym) {
    orders._total[ym] = 2500; orders.prolon_5day[ym] = 1000; orders.prolon_nextgen[ym] = 500; orders.prolon_reset[ym] = 400;
    orders.fast_bar[ym] = 300; orders.fasting_shake[ym] = 200; orders.l_pill[ym] = 100;
  });
  var ctx = {
    now: AS_OF, from: '2026-06-19', to: '2026-09-16', orders: orders,
    ordersInRange: function (from, to, product) { return A.ordersInRange(orders, from, to, product); },
    customers: customers, allRecords: records, sla: { P0: 1, P1: 4, P2: 24, P3: 72 }
  };

  /* ---------------- registry ---------------- */
  var EXPECTED_IDS = ['volume', 'contact_rate', 'complaints_per_1k', 'sentiment_index', 'net_sentiment', 'nps', 'csat', 'rating_mean', 'frt_median',
    'frt_sla_pct', 'resolution_median', 'resolution_p90', 'reopen_rate', 'escalation_rate', 'repeat_contact_rate', 'detractor_recovery', 'ae_rate',
    'backlog_48h', 'open_p0_p1', 'sla_breached', 'unassigned', 'needs_review_pct', 'revenue_at_risk'];
  EXPECTED_IDS.forEach(function (id) {
    var m = M.registry[id];
    assert(!!m && m.id === id && typeof m.formula === 'string' && m.formula.length > 0 && typeof m.compute === 'function', 'registry has ' + id + ' with formula');
  });
  assert(M.registry.nps.formula === '%9–10 − %0–6', 'nps formula string verbatim');
  assert(M.registry.contact_rate.formula === 'records / orders × 100', 'contact_rate formula string verbatim');
  assert(M.registry.ae_rate.formula === 'AE records / orders × 10,000', 'ae_rate formula string verbatim');

  var allClean = true, allEmptyClean = true;
  var COUNT_LIKE = ['volume', 'contact_rate', 'complaints_per_1k', 'ae_rate', 'backlog_48h', 'open_p0_p1', 'sla_breached', 'unassigned'];
  EXPECTED_IDS.forEach(function (id) {
    var r = M.compute(id, records, ctx);
    var ok = r && finiteOrNull(r.value) && typeof r.n === 'number' && isFinite(r.n) &&
      (r.interval === undefined || (isFinite(r.interval.lo) && isFinite(r.interval.hi) && r.interval.lo <= r.interval.hi));
    if (!ok) { allClean = false; console.log('  bad result for ' + id + ': ' + JSON.stringify(r)); }
    var e = M.compute(id, [], ctx);
    var expectZero = COUNT_LIKE.indexOf(id) >= 0;
    var okEmpty = e && isFinite(e.n) && (expectZero ? e.value === 0 : (e.value === null && e.n === 0));
    if (!okEmpty) { allEmptyClean = false; console.log('  bad empty result for ' + id + ': ' + JSON.stringify(e)); }
  });
  assert(allClean, 'every registry id computes on the fixture without NaN/undefined');
  assert(allEmptyClean, 'on empty input counts are 0 and every other metric is {value:null, n:0}');
  assert(M.compute('volume', records, ctx).value === 200, 'volume counts records');
  var noOrders = M.compute('contact_rate', records, { now: AS_OF, from: '2026-01-01', to: '2026-09-16', orders: orders });
  assert(noOrders.value === null, 'contact_rate is null when a month of orders is missing');
  // frt_sla_pct: answered records count by their FRT; OPEN records still unanswered past SLA are certain misses; a CLOSED record
  // that never had a first response (a review, a survey, a ticket without service fields) has no FRT and leaves the denominator
  var slaRecs = [
    { id: 'sla_a', received_at: '2026-09-10T12:00:00Z', urgency: 'P2', status: 'resolved', first_response_at: '2026-09-10T14:00:00Z' },
    { id: 'sla_b', received_at: '2026-09-10T12:00:00Z', urgency: 'P2', status: 'resolved', first_response_at: '2026-09-12T12:00:00Z' },
    { id: 'sla_c', received_at: '2026-09-10T12:00:00Z', urgency: 'P2', status: 'open', first_response_at: null },
    { id: 'sla_d', received_at: '2026-09-10T12:00:00Z', urgency: 'P2', status: 'resolved', first_response_at: null, channel: 'amazon_review' },
    { id: 'sla_e', received_at: '2026-09-16T20:00:00Z', urgency: 'P2', status: 'open', first_response_at: null }
  ];
  var slaRes = M.compute('frt_sla_pct', slaRecs, { now: AS_OF, sla: { P0: 1, P1: 4, P2: 24, P3: 72 } });
  assert(slaRes.n === 3 && near(slaRes.value, 100 / 3, 1e-9), 'frt_sla_pct: 1 of 3 (answered in 2h ✓, answered in 48h ✗, open 6 days ✗); closed-without-FRT and open-within-SLA excluded (n=' + slaRes.n + ', ' + slaRes.value + ')');
  var cr = M.compute('contact_rate', records, ctx);
  assert(cr.value !== null && cr.interval && cr.interval.lo <= cr.value && cr.value <= cr.interval.hi, 'contact_rate has a Wilson interval around the value');
  var ae = M.compute('ae_rate', records, ctx);
  assert(ae.value !== null && ae.interval && ae.interval.lo <= ae.value && ae.value <= ae.interval.hi, 'ae_rate has a Poisson interval around the value');
  var rar = M.compute('revenue_at_risk', records, ctx);
  assert(rar.value !== null && rar.value > 0 && rar.n > 0, 'revenue_at_risk sums over subscribers (n=' + rar.n + ')');
  var open = records.filter(function (r) { return ['new', 'open', 'pending', 'reopened', 'escalated'].indexOf(r.status) >= 0; }).length;
  assert(M.compute('unassigned', records, ctx).n === open, 'count metrics on open records report n = open records');
  assert(M.compute('nope', records, ctx).value === null, 'unknown metric id returns a null result');

  /* ---------------- nps on a known set ---------------- */
  var known = [10, 10, 9, 7, 5, 0].map(function (v, k) { return { id: 'k' + k, received_at: AS_OF, nps: v }; });
  var nps = M.compute('nps', known, ctx);
  assert(near(nps.value, 16.6667, 0.01) && nps.n === 6, 'nps = %promoters − %detractors on a known set (16.7)');
  var p = 0.5, d = 2 / 6, moe = 1.96 * Math.sqrt((p + d - (p - d) * (p - d)) / 6) * 100;
  assert(near(nps.interval.hi - nps.value, moe, 0.01) && near(nps.value - nps.interval.lo, moe, 0.01), 'nps interval matches ±1.96·√((p+d−(p−d)²)/n)·100');
  assert(M.compute('nps', [{ id: 'x', received_at: AS_OF, nps: null }], ctx).value === null, 'nps null with no scores');

  /* ---------------- wilson ---------------- */
  var w = M.wilson(5, 20);
  assert(near(w.lo, 0.1119, 0.005) && near(w.hi, 0.4687, 0.005), 'wilson(5,20) ≈ [0.112, 0.469]');
  assert(w.lo >= 0 && w.hi <= 1 && w.lo < 0.25 && w.hi > 0.25, 'wilson bounds bracket p within [0,1]');
  var w0 = M.wilson(0, 10);
  assert(w0.lo === 0 && w0.hi > 0 && w0.hi < 0.4, 'wilson(0,10) lower bound is 0');
  var csat = M.compute('csat', records, ctx);
  assert(csat.interval && csat.interval.lo >= 0 && csat.interval.hi <= 100, 'csat interval is on the 0–100 scale');

  /* ---------------- bucket ---------------- */
  var days = A.bucket(records, 'day');
  var gap = days.filter(function (b) { return b.key === GAP_DAY; });
  assert(gap.length === 1 && gap[0].count === 0 && gap[0].records.length === 0, 'bucket zero-fills the empty day ' + GAP_DAY);
  var first = days[0].key, last = days[days.length - 1].key;
  var span = Math.round((Date.parse(last + 'T00:00:00Z') - Date.parse(first + 'T00:00:00Z')) / DAY) + 1;
  assert(days.length === span, 'daily buckets form a contiguous calendar range (' + days.length + ' days)');
  assert(days.reduce(function (s, b) { return s + b.count; }, 0) === 200, 'daily bucket counts sum to n');
  var weeks = A.bucket(records, 'week');
  assert(weeks.length >= 12 && weeks.length <= 15 && /^\d{4}-W\d{2}$/.test(weeks[0].key), 'weekly buckets use ISO week keys (' + weeks.length + ' weeks)');
  var months = A.bucket(records, 'month');
  assert(months.length === 4 && months[0].key === '2026-06' && months[3].key === '2026-09', 'monthly buckets span Jun–Sep 2026');
  var padded = A.bucket(records, 'day', { from: '2026-06-01', to: '2026-09-30' });
  assert(padded[0].key === '2026-06-01' && padded[padded.length - 1].key === '2026-09-30', 'bucket extends to explicit from/to bounds');
  assert(A.bucket([], 'day').length === 0, 'bucket on empty input is []');
  var meanOk = days.every(function (b) { return b.meanSentiment === null || (isFinite(b.meanSentiment) && b.pos + b.neg + b.neu <= b.count); });
  assert(meanOk, 'bucket sentiment splits are consistent');

  /* ---------------- heatmap ---------------- */
  var hm = A.heatmap(records);
  var total = 0, shapeOk = hm.matrix.length === 7;
  hm.matrix.forEach(function (row) { shapeOk = shapeOk && row.length === 24; row.forEach(function (v) { total += v; }); });
  assert(shapeOk && total === 200, 'heatmap is 7×24 and sums to n');
  var hours = {};
  hm.matrix.forEach(function (row) { row.forEach(function (v, h) { if (v) hours[h] = true; }); });
  assert(Object.keys(hours).every(function (h) { return (h >= 9 && h <= 11) || (h >= 19 && h <= 21); }), 'heatmap hours are in CT (bimodal 9–11 / 19–21)');

  /* ---------------- theme impact ---------------- */
  var ti = A.themeImpact(records);
  var npsAll = M.compute('nps', records, ctx).value;
  assert(ti.length > 0 && ti.every(function (r) { return r.npsAll === npsAll && finiteOrNull(r.impact) && r.n > 0; }), 'themeImpact rows share NPS(all) and carry n');
  assert(ti.every(function (r) { return r.impact === null || near(r.impact, r.npsAll - r.npsExcl, 1e-9); }), 'impact = NPS(all) − NPS(excluding category)');
  assert(ti.every(function (r) { return r.impact === null || Math.abs(r.impact) <= 200; }) && ti[0].impact <= ti[ti.length - 1].impact, 'themeImpact sorted most damaging first, bounded');
  var praiseRow = ti.filter(function (r) { return r.category === 'praise'; })[0];
  var billingRow = ti.filter(function (r) { return r.category === 'subscription_billing'; })[0];
  assert(praiseRow && billingRow && praiseRow.impact > 0 && billingRow.impact < 0 && ti[0].category === 'subscription_billing',
    'planted promoters (praise) lift NPS and planted detractors (billing) drag it; billing ranks first');
  var sumImpact = ti.reduce(function (s, r) { return s + (r.impact || 0); }, 0);
  assert(isFinite(sumImpact) && Math.abs(sumImpact) < 200 * ti.length, 'themeImpact impacts sum to a finite total (' + sumImpact.toFixed(1) + ')');

  /* ---------------- other analytics ---------------- */
  var sov = A.shareOfVoice(records, orders, '2026-06-19', '2026-09-16');
  var fiveDay = sov.filter(function (r) { return r.product === 'prolon_5day'; })[0];
  assert(fiveDay && fiveDay.index !== null && isFinite(fiveDay.index) && near(fiveDay.index, fiveDay.mentionShare / fiveDay.orderShare, 1e-9), 'shareOfVoice index = mentionShare / orderShare');
  var general = sov.filter(function (r) { return r.product === 'general'; })[0];
  assert(!general || (general.orders === null && general.index === null), 'shareOfVoice index null without order data');
  assert(sov.every(function (r) { return typeof r.partialCoverage === 'boolean' && typeof r.coverageMonths === 'number' && r.rangeMonths === 4; }), 'shareOfVoice rows carry partialCoverage / coverageMonths / rangeMonths');
  assert(fiveDay.partialCoverage === false && fiveDay.coverageMonths === 4, 'a product sold across the whole range is not partial');
  // Starter Pack: orders only in Aug–Sep (zeros before), mentions only in those months → index measured over the two covered months.
  var ordersSP = JSON.parse(JSON.stringify(orders));
  ordersSP.starter_pack = { '2026-06': 0, '2026-07': 0, '2026-08': 50, '2026-09': 50 };
  ordersSP.ghost = { '2026-06': 0, '2026-07': 0, '2026-08': 0, '2026-09': 0 };
  var spRecords = records.slice();
  for (var si = 0; si < 10; si++) {
    var base = records[si];
    spRecords.push(Object.assign({}, base, { id: 'sp_' + si, product: 'starter_pack', received_at: (si < 5 ? '2026-08-' : '2026-09-') + String(10 + si).padStart(2, '0') + 'T15:00:00Z' }));
  }
  spRecords.push(Object.assign({}, records[0], { id: 'ghost_1', product: 'ghost', received_at: '2026-09-01T15:00:00Z' }));
  var sov2 = A.shareOfVoice(spRecords, ordersSP, '2026-06-19', '2026-09-16');
  var sp = sov2.filter(function (r) { return r.product === 'starter_pack'; })[0];
  var ghost = sov2.filter(function (r) { return r.product === 'ghost'; })[0];
  var naiveSp = sp.mentionShare / sp.orderShare;
  assert(sp && sp.partialCoverage === true && sp.coverageMonths === 2 && sp.coverage && sp.coverage.months.join(',') === '2026-08,2026-09' && sp.coverage.mentions === 10 && sp.coverage.n > 10, 'partial-coverage product: flagged, 2 of 4 months, mention share measured inside its months');
  assert(sp.index !== null && near(sp.index, sp.coverage.mentionShare / sp.coverage.orderShare, 1e-9) && sp.index < naiveSp, 'partial-coverage index = covered mention share / covered order share, below the whole-range ratio (' + sp.index.toFixed(2) + ' vs ' + naiveSp.toFixed(2) + ')');
  assert(ghost && ghost.index === null && ghost.partialCoverage === false && ghost.coverageMonths === 0, 'a product with no orders at all in the range gets index null');
  assert(sov2.filter(function (r) { return r.product === 'prolon_5day'; })[0].partialCoverage === false, 'other rows unchanged by the partial-coverage product');
  assert(A.ordersInRange(orders, '2026-07-01', '2026-07-31', null) === 2500 && near(A.ordersInRange(orders, '2026-07-01', '2026-07-16', null), 2500 * 16 / 31, 1e-6), 'ordersInRange prorates partial months');
  assert(A.ordersInRange(orders, '2026-05-15', '2026-06-15', null) === null, 'ordersInRange is null when a month is missing');

  var seg = A.segmentCompare(records, customers);
  assert(seg.length >= 3 && seg.every(function (r) { return r.n > 0 && finiteOrNull(r.nps) && finiteOrNull(r.netSentiment) && finiteOrNull(r.repeatRate); }), 'segmentCompare rows are clean');
  var comp = A.componentMentions(records);
  assert(comp.length > 0 && comp.every(function (r) { return r.count > 0 && r.negShare >= 0 && r.negShare <= 1; }), 'componentMentions counts kit components');
  var lots = A.lotMatrix(records);
  assert(lots.length === 2 && lots.every(function (r) { return Object.keys(r.weeks).length > 0 && r.total > 0; }), 'lotMatrix builds lot × week counts');
  var hcp = A.hcpRollup(records, customers, practices);
  assert(hcp.length > 0 && hcp[0].name !== hcp[0].practice_id && hcp.every(function (r) { return r.records > 0 && finiteOrNull(r.nps); }), 'hcpRollup links records to practices');
  var coh = A.cohorts(records).cohorts;
  assert(coh.length === 4 && coh.every(function (c) { return c.retention.length === 6 && c.retention[0] === 1; }), 'cohorts: 4 first-contact months, retention[0] = 1');
  var rd = A.resolutionDistribution(records);
  var rdN = rd.buckets.reduce(function (s, b) { return s + b.count; }, 0);
  assert(rd.buckets.length === 7 && rd.buckets[0].label === '<4h' && rd.buckets[6].label === '7d+' && rdN === rd.n && rd.p50 <= rd.p75 && rd.p75 <= rd.p90, 'resolutionDistribution buckets sum to n, p50≤p75≤p90');
  assert(A.resolutionDistribution([]).p50 === null, 'resolutionDistribution empty → null percentiles');

  /* ---------------- series ---------------- */
  var s = M.series('volume', records, ctx, { granularity: 'week', rolling: 0 });
  assert(s.length === weeks.length && s.every(function (pt) { return finiteOrNull(pt.value) && typeof pt.n === 'number'; }), 'series(volume, week) aligns with buckets');
  var rs = M.series('nps', records, ctx, { granularity: 'day', rolling: 28 });
  assert(rs.length === days.length && rs.every(function (pt) { return finiteOrNull(pt.value) && !('interval' in pt && pt.interval === undefined); }), 'series(nps, day, rolling 28) is clean');
  var rv = M.series('volume', records, ctx, { granularity: 'day', rolling: 7 });
  assert(rv.every(function (pt) { return finiteOrNull(pt.value); }) && rv[rv.length - 1].n === 7, 'rolling count series averages a 7-bucket window');
  // edge buckets: a range starting Thu 2026-08-20 covers 4 days of ISO week 2026-W34 (Aug 17–23) and 3 days of W38 (Sep 14–16),
  // so the order denominator of those weeks is clipped to the days in range instead of a full calendar week
  var dk = function (iso) { return VOC.util ? VOC.util.dayKey(iso) : String(iso).slice(0, 10); };
  var clipCtx = Object.assign({}, ctx, { from: '2026-08-20', to: '2026-09-16' });
  var inRange = records.filter(function (r) { var d = dk(r.received_at); return d >= '2026-08-20' && d <= '2026-09-16'; });
  var crw = M.series('contact_rate', inRange, clipCtx, { granularity: 'week' });
  var firstW = crw[0], lastW = crw[crw.length - 1];
  assert(firstW.key === '2026-W34' && firstW.n === Math.round(2500 * 4 / 31) && lastW.key === '2026-W38' && lastW.n === Math.round(2500 * 3 / 30),
    'series clips edge-bucket order denominators to the range (W34 → ' + firstW.n + ' orders for 4 days, W38 → ' + lastW.n + ' for 3 days)');
  assert(crw.length > 2 && crw[1].n === Math.round(2500 * 7 / 31), 'interior weeks keep the full week of orders');
  var crRoll = M.series('contact_rate', inRange, clipCtx, { granularity: 'week', rolling: 4 });
  assert(crRoll[1].n === Math.round(2500 * 11 / 31), 'pooled rolling windows clip their first bucket too (4 + 7 days)');

  /* ---------------- text mining ---------------- */
  var grams = A.ngrams(records, { n: [1, 2, 3], minDf: 3, top: 40 });
  var planted = grams.filter(function (g) { return g.gram === 'charged twice'; })[0];
  assert(!!planted && planted.df >= 3 && planted.sampleIds.length > 0 && finiteOrNull(planted.meanSentiment), 'ngrams finds the planted bigram "charged twice" (df=' + (planted && planted.df) + ')');
  assert(grams.every(function (g) { return g.df >= 3 && g.negShare >= 0 && g.negShare <= 1; }), 'ngrams respects minDf and clean shares');
  assert(!grams.some(function (g) { return g.gram.split(' ').indexOf('the') >= 0; }), 'ngrams drop stopwords');
  assert(A.ngrams([], {}).length === 0, 'ngrams on empty input is []');
  /* restricted (PHI-adjacent) records are not mined unless the caller opts in or hands over a redacted copy */
  var planted = [];
  for (var pi = 0; pi < 4; pi++) planted.push({ id: 'rx_' + pi, restricted: true, sentiment: -0.3, sentiment_label: 'negative', subject: 'Metformin timing', text: 'Metformin timing with the fast worries me. Metformin timing again.' });
  var open = [{ id: 'ok_1', sentiment: 0.4, sentiment_label: 'positive', subject: 'Great soup', text: 'Great soup and easy days.' }];
  var mined = A.ngrams(planted.concat(open), { n: [2], minDf: 2, top: 20 });
  assert(!mined.some(function (g) { return g.gram === 'metformin timing'; }), 'ngrams skip restricted records by default');
  assert(A.ngrams(planted.concat(open), { n: [2], minDf: 2, top: 20, includeRestricted: true }).some(function (g) { return g.gram === 'metformin timing'; }), 'ngrams mine restricted records with includeRestricted');
  assert(A.kwic(planted, 'metformin').length === 0 && A.kwic(planted, 'metformin', { includeRestricted: true }).length === 4, 'kwic skips restricted records unless includeRestricted');
  var dt = A.distinctiveTerms(planted, open, { minCount: 1 });
  assert(!dt.rising.some(function (t) { return /metformin/.test(t.term || t.word || JSON.stringify(t)); }), 'distinctiveTerms skip restricted records by default');
  assert(A.ngrams(planted.map(function (r) { return VOC.util.redactRecord(r); }), { n: [2], minDf: 2 }).every(function (g) { return g.gram !== 'metformin timing'; }), 'a redacted copy carries no body to mine');

  var hits = A.kwic(records, 'charged twice', { width: 60, max: 5 });
  assert(hits.length === 5 && hits.every(function (h) { return h.match.toLowerCase() === 'charged twice' && typeof h.before === 'string' && typeof h.after === 'string' && h.id; }), 'kwic returns bounded highlights with ids');
  var wide = A.kwic(records, 'porch', { width: 10, max: 3 });
  assert(wide.length === 3 && wide.every(function (h) { return h.before.length <= 12 && h.after.length <= 12; }), 'kwic respects width (±10 chars)');
  assert(A.kwic(records, 'zzzz').length === 0, 'kwic returns [] for a missing term');

  var groupA = records.filter(function (r) { return r.category === 'shipping_fulfillment'; });
  var groupB = records.filter(function (r) { return r.category !== 'shipping_fulfillment'; });
  var dt = A.distinctiveTerms(groupA, groupB, { top: 15, alpha0: 10 });
  assert(dt.rising.length > 0 && dt.rising[0].term === 'porch' && dt.rising[0].z > 2, 'distinctiveTerms ranks planted term "porch" first (z=' + (dt.rising[0] && dt.rising[0].z.toFixed(2)) + ')');
  assert(dt.falling.length > 0 && dt.falling[0].z < 0 && dt.rising.every(function (r) { return isFinite(r.z) && r.a >= 0 && r.b >= 0; }), 'distinctiveTerms falling side is negative and finite');
  var dtTotal = A.distinctiveTerms(groupA, groupB, { top: 5, alpha0: 10, prior: 'total' });
  assert(dtTotal.rising.length === 5 && dtTotal.rising.every(function (r) { return isFinite(r.z); }), 'distinctiveTerms prior:"total" (literal α0 mass) also runs clean');
  assert(A.distinctiveTerms([], [], {}).rising.length === 0, 'distinctiveTerms on empty input is empty');

  /* ---------------- text-mining hygiene: signatures, names, quoted tails, sentence boundaries ---------------- */
  var tail = '\n\nRegards,\nSophie Baker\n\nOn Wed, Sep 2, 2026 at 1:05 PM, L-Nutra Customer Care <care@prolonlife.com> wrote:\n> Hi Sophie, thanks for reaching out! Could you share the lot number printed on the box?\n> Best, Maya R.\n\nSent from my iPhone';
  var hyg = [];
  for (var hi = 0; hi < 4; hi++) {
    hyg.push({ id: 'h_' + hi, received_at: '2026-09-0' + (hi + 1) + 'T15:00:00Z', from_name: 'Sophie Baker', subject: 'Charged twice', text: 'Charged twice. Refund please. Maya said Sophie Baker gets a refund.' + tail,
      sentiment: -0.6, sentiment_label: 'negative', category: 'subscription_billing', subcategory: 'duplicate_charge', product: 'general' });
  }
  var hg = A.ngrams(hyg, { n: [1, 2], minDf: 3, top: 50, agents: ['Maya R.', 'Devon K.'] });
  var hgSet = {};
  hg.forEach(function (g) { hgSet[g.gram] = g.df; });
  assert(hgSet['charged twice'] === 4 && hgSet['refund'] === 4, 'hygiene: real content ("charged twice", "refund") survives');
  ['regards', 'sophie', 'baker', 'maya', 'care', 'customer care', 'wrote', 'sent', 'iphone', 'sophie baker'].forEach(function (w) {
    assert(hgSet[w] === undefined, 'hygiene: "' + w + '" (signature / agent / sender name) does not surface as a theme');
  });
  assert(hgSet['twice refund'] === undefined && hgSet['refund maya'] === undefined, 'hygiene: no gram spans a sentence boundary');
  if (VOC.classify && typeof VOC.classify.preprocess === 'function') {
    assert(hgSet['lot number'] === undefined && hgSet['lot'] === undefined && hgSet['reaching'] === undefined, 'hygiene: quoted-reply tail is cut before mining (no "lot number" from the agent\'s quoted question)');
  }
  var hgSeed = A.ngrams(hyg, { n: [1], minDf: 3, top: 50 });   // agents from VOC_SEED.meta.agents / store settings when opts.agents is absent
  assert(!hgSeed.some(function (g) { return g.gram === 'sophie' || g.gram === 'baker'; }), 'hygiene: sender names dropped without opts.agents too');
  var hygB = hyg.map(function (r, i) { return Object.assign({}, r, { id: 'hb_' + i, from_name: 'Tom Hill', text: 'Box arrived late and the soup leaked. Regards, Tom Hill' }); });
  var hdt = A.distinctiveTerms(hyg, hygB, { top: 10, agents: ['Maya R.'] });
  var risingTerms = hdt.rising.map(function (r) { return r.term; });
  var fallingTerms = hdt.falling.map(function (r) { return r.term; });
  assert(risingTerms.indexOf('charged') >= 0 && risingTerms.every(function (t) { return ['sophie', 'baker', 'maya', 'regards', 'care'].indexOf(t) < 0; }), 'distinctiveTerms rising skips sender / agent names and signature words: ' + risingTerms.join(', '));
  assert(fallingTerms.every(function (t) { return ['tom', 'hill', 'regards'].indexOf(t) < 0; }) && fallingTerms.indexOf('leaked') >= 0, 'distinctiveTerms falling skips the other sender\'s name: ' + fallingTerms.join(', '));

  assert(A.stem('charged') === 'charg' && A.stem('shipped') === 'ship' && A.stem('boxes') === 'box' && A.stem('deliveries') === 'delivery', 'stem strips ed/ing/es/ies with undoubling');
  assert(A.stem('this') === 'this' && A.stem('glass') === 'glass' && A.stem('bus') === 'bus' && A.stem('days') === 'days', 'stem leaves exceptions and short stems alone');
  assert(A.stem('running') === 'run' && A.stem('soups') === 'soup' && A.stem('shipping') === 'shipping', 'stem: running→run, soups→soup, shipping kept');

  assert(near(A.cosine('charged twice for my order', 'my order was charged twice'), 1, 1e-9), 'cosine of same content is 1');
  assert(A.cosine('porch delivery', 'headache hunger') === 0 && A.cosine('', 'anything') === 0, 'cosine of disjoint or empty text is 0');
  var mid = A.cosine('porch delivery late', 'porch delivery fine');
  assert(mid > 0.5 && mid < 1, 'cosine of partial overlap is between 0 and 1');

  console.log(passes + ' passed, ' + failures + ' failed');
  if (failures) throw new Error('test_analytics: ' + failures + ' assertion(s) failed');
})();
