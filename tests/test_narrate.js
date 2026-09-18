/* tests/test_narrate.js — VOC.narrate and VOC.report on a synthetic derived state (VOC.util.rng).
 * Runs under jsc with util.js first; analytics/predict may be absent, so every assertion holds in both configurations. */
(function () {
  'use strict';
  var failures = 0, total = 0;
  function assert(cond, msg) {
    total += 1;
    if (cond) console.log('PASS ' + msg);
    else { failures += 1; console.log('FAIL ' + msg); }
  }
  var u = VOC.util, N = VOC.narrate, R = VOC.report;
  assert(u && N && R, 'VOC.util, VOC.narrate and VOC.report load under jsc');
  var hasPredict = !!(VOC.predict && typeof VOC.predict.forecastVolume === 'function');
  var hasMetrics = !!(VOC.metrics && VOC.metrics.registry);
  console.log('  modules present: predict=' + hasPredict + ' analytics=' + !!VOC.analytics + ' metrics=' + hasMetrics);

  /* ---------- synthetic derived state ---------- */
  var AS_OF = '2026-09-16T23:59:00Z';
  var NOW = new Date(AS_OF);
  var TO = '2026-09-16', FROM = u.addDays(TO, -29), PRIOR_TO = u.addDays(FROM, -1), PRIOR_FROM = u.addDays(PRIOR_TO, -29);
  var rng = u.rng(20260917);
  var CATS = ['subscription_billing', 'shipping_fulfillment', 'taste_quality', 'praise', 'usage_guidance', 'price_value', 'side_effects', 'customer_service', 'missing_damaged'];
  var CAT_NEG = { subscription_billing: 0.85, shipping_fulfillment: 0.7, taste_quality: 0.55, praise: 0, usage_guidance: 0.15, price_value: 0.6, side_effects: 0.5, customer_service: 0.6, missing_damaged: 0.75 };
  var SUBS = { subscription_billing: 'duplicate_charge', shipping_fulfillment: 'late', taste_quality: 'soup_taste', praise: 'results_praise', usage_guidance: 'general_question', price_value: 'too_expensive', side_effects: 'headache', customer_service: 'slow_response', missing_damaged: 'leaking' };
  var PRODUCTS = ['prolon_5day', 'prolon_nextgen', 'fast_bar', 'l_pill', 'prolon_reset'];
  var NEG_TEXT = 'I was charged twice for my ProLon 5-Day kit and there is no cancellation link anywhere. Support has not answered in four days and I want a refund <b>now</b>. Order #123456. This is not worth the money.';
  var POS_TEXT = 'Day 4 and I feel energized and lighter. The Next Gen soups are delicious and the L-Drink is refreshing; I lost 6 lbs and my focus is back. Thank you to the team & to Maya for the quick reply!';
  var EVIL = '<script>alert("x")</script> <img src=x onerror=alert(1)>';
  var counter = 0;
  function makeRecord(day, over) {
    counter += 1;
    var cat = CATS[Math.floor(rng() * CATS.length)];
    var neg = rng() < CAT_NEG[cat];
    var sentiment = neg ? -0.35 - rng() * 0.5 : cat === 'praise' ? 0.45 + rng() * 0.4 : (rng() - 0.4) * 0.6;
    var lbl = sentiment <= -0.15 ? 'negative' : sentiment >= 0.15 ? 'positive' : 'neutral';
    var hour = 9 + Math.floor(rng() * 10);
    var received = day + 'T' + String(hour + 5).padStart(2, '0') + ':' + String(Math.floor(rng() * 60)).padStart(2, '0') + ':00Z';
    var nps = rng() < 0.35 ? (lbl === 'negative' ? Math.floor(rng() * 7) : lbl === 'positive' ? 8 + Math.floor(rng() * 3) : 6 + Math.floor(rng() * 4)) : null;
    var status = rng() < 0.85 ? 'resolved' : 'open';
    var text = (lbl === 'positive' ? POS_TEXT : NEG_TEXT) + (counter % 7 === 0 ? ' ' + EVIL : '');
    var rec = {
      id: 'r_' + String(counter).padStart(6, '0'), schema_version: 1, received_at: received, channel: 'email', sales_channel: 'dtc_web',
      from_name: 'Test Person ' + counter, from_email: 'person' + counter + '@example.com', subject: (lbl === 'positive' ? 'Loving it <3' : 'Charged twice & no reply'), text: text,
      language: 'en', has_attachment: false, product: PRODUCTS[Math.floor(rng() * PRODUCTS.length)], product_variant: null, kit_component: null, product_class: 'conventional_food',
      category: cat, subcategory: SUBS[cat], secondary_categories: [], sentiment: sentiment, sentiment_min: sentiment - 0.1, sentiment_label: lbl,
      nps: nps, rating: null, csat: status === 'resolved' && rng() < 0.4 ? (lbl === 'negative' ? 2 : 5) : null,
      urgency: neg && rng() < 0.2 ? 'P1' : 'P2', status: status, first_response_at: rng() < 0.88 ? new Date(Date.parse(received) + (1 + rng() * 20) * 3600000).toISOString() : null,
      resolved_at: status === 'resolved' ? new Date(Date.parse(received) + (10 + rng() * 60) * 3600000).toISOString() : null, reopen_count: 0,
      service_fields_source: 'seed', escalated_to: 'none', is_adverse_event: false, serious_ae: false, ae_criteria: [], contraindication_flags: [], food_safety: false,
      lot_number: null, order_id: null, hcp_code: null, claim_related: false, cancel_intent: neg && rng() < 0.3, restricted: false,
      customer_id: 'c_' + Math.floor(rng() * 200), segment: 'repeat', region: 'US', thread_id: 't_' + counter, is_first_contact: true, message_id: null,
      source: 'seed', is_noise: false, noise_reason: null, assignee: rng() < 0.7 ? 'Maya R.' : null, tags: [], notes: [],
      classifier: { confidence: 0.4 + rng() * 0.6, rule_category: cat, rule_subcategory: SUBS[cat], rule_product: 'prolon_5day', manual_override: false, needs_review: rng() < 0.06 }
    };
    rec.sentiment_index = (sentiment + 1) / 2 * 100;
    rec.is_complaint = sentiment < -0.1 || VOC.enums.COMPLAINT_CATEGORIES.indexOf(cat) >= 0;
    rec.is_detractor = nps != null && nps <= 6; rec.is_promoter = nps != null && nps >= 9;
    rec.is_open = status === 'open';
    rec.age_hours = (NOW.getTime() - Date.parse(received)) / 3600000;
    rec.frt_hours = rec.first_response_at ? (Date.parse(rec.first_response_at) - Date.parse(received)) / 3600000 : null;
    rec.resolution_hours = rec.resolved_at ? (Date.parse(rec.resolved_at) - Date.parse(received)) / 3600000 : null;
    rec.sla_frt_hours = rec.urgency === 'P1' ? 4 : 24; rec.sla_frt_breached = rec.frt_hours != null ? rec.frt_hours > rec.sla_frt_hours : rec.age_hours > rec.sla_frt_hours;
    rec.day_key = u.dayKey(received); rec.week_key = u.weekKey(received); rec.month_key = u.monthKey(received);
    rec.regulatory_clock = 'none'; rec.regulatory_deadline = null; rec.business_days_remaining = null; rec.hours_remaining = null;
    return Object.assign(rec, over || {});
  }
  function spread(from, count) {
    var out = [];
    for (var i = 0; i < count; i++) out.push(makeRecord(u.addDays(from, Math.floor(rng() * 30))));
    return out.sort(function (a, b) { return a.received_at < b.received_at ? 1 : -1; });
  }
  var records = spread(FROM, 150);
  var compare = spread(PRIOR_FROM, 118);
  // a serious AE on the MedWatch clock and a food-safety RFR record, both open, both outside the filtered set (regulatory ignores filters)
  var aeReceived = '2026-09-10T15:00:00Z';
  var ae = makeRecord('2026-09-10', { id: 'r_ae0001', received_at: aeReceived, category: 'adverse_event', subcategory: 'fainting', product: 'l_pill', product_class: 'supplement',
    is_adverse_event: true, serious_ae: true, ae_criteria: ['hospitalization'], urgency: 'P0', status: 'escalated', is_open: true, restricted: true, sentiment: -0.7, sentiment_label: 'negative',
    regulatory_clock: 'medwatch_15bd', regulatory_deadline: u.addBusinessDays(aeReceived, 15), text: 'My mother fainted and went to the ER after the L-Pill. She takes metformin.' });
  ae.business_days_remaining = u.businessDaysBetween(AS_OF, ae.regulatory_deadline);
  var fsReceived = '2026-09-16T20:00:00Z';
  var fs = makeRecord('2026-09-16', { id: 'r_fs0001', received_at: fsReceived, category: 'foreign_material_allergen', subcategory: 'hard_bits', product: 'prolon_nextgen',
    food_safety: true, urgency: 'P0', status: 'new', is_open: true, sentiment: -0.6, sentiment_label: 'negative', lot_number: 'NG-0426-B',
    regulatory_clock: 'rfr_24h', regulatory_deadline: new Date(Date.parse(fsReceived) + 24 * 3600000).toISOString(), text: 'Found hard bits like nut shell in the minestrone quinoa soup, lot NG-0426-B.' });
  fs.hours_remaining = (Date.parse(fs.regulatory_deadline) - NOW.getTime()) / 3600000;
  var allRecords = records.concat([ae, fs]).concat(compare);

  function roll(list) {
    var scored = list.filter(function (r) { return r.sentiment_label !== 'unscored'; });
    var neg = scored.filter(function (r) { return r.sentiment_label === 'negative'; }).length;
    var pos = scored.filter(function (r) { return r.sentiment_label === 'positive'; }).length;
    var mean = scored.length ? scored.reduce(function (s, r) { return s + r.sentiment; }, 0) / scored.length : null;
    return { count: list.length, neg: neg, pos: pos, neu: scored.length - neg - pos, meanSentiment: mean, negShare: scored.length ? neg / scored.length : null, posShare: scored.length ? pos / scored.length : null };
  }
  function byDim(list, field, ids) {
    var groups = new Map();
    ids.forEach(function (id) { groups.set(id, []); });
    list.forEach(function (r) { if (!groups.has(r[field])) groups.set(r[field], []); groups.get(r[field]).push(r); });
    var out = [];
    groups.forEach(function (g, id) { out.push(Object.assign({ id: id, label: VOC.enums.label(field, id), share: list.length ? g.length / list.length : 0 }, roll(g))); });
    return out;
  }
  function byKey(list, field, keys) {
    return keys.map(function (k) { return Object.assign({ key: k }, roll(list.filter(function (r) { return r[field] === k; }))); });
  }
  var dayKeys = []; for (var d = FROM; d <= TO; d = u.addDays(d, 1)) dayKeys.push(d);
  var weekKeys = []; dayKeys.forEach(function (k) { var w = u.weekKey(k); if (weekKeys.indexOf(w) < 0) weekKeys.push(w); });

  function npsOf(list) {
    var s = list.filter(function (r) { return r.nps != null; }); if (!s.length) return { value: null, n: 0, interval: null };
    var p = s.filter(function (r) { return r.nps >= 9; }).length / s.length, dd = s.filter(function (r) { return r.nps <= 6; }).length / s.length;
    var v = (p - dd) * 100, moe = 1.96 * Math.sqrt(Math.max(0, p + dd - (p - dd) * (p - dd)) / s.length) * 100;
    return { value: v, n: s.length, interval: { lo: v - moe, hi: v + moe } };
  }
  function mk(id, label, unit, direction, cur, prev) {
    return { id: id, label: label, unit: unit, direction: direction, value: cur.value, n: cur.n, prev: prev ? prev.value : null,
      delta: cur.value != null && prev && prev.value != null ? u.fmt.delta(cur.value, prev.value, { unit: unit }) : null, interval: cur.interval || null, extra: null };
  }
  function meanIdx(list) { var s = list.filter(function (r) { return r.sentiment_label !== 'unscored'; }); return { value: s.length ? s.reduce(function (a, r) { return a + r.sentiment_index; }, 0) / s.length : null, n: s.length }; }
  function medianHours(list, field) { var v = list.map(function (r) { return r[field]; }).filter(function (x) { return typeof x === 'number'; }); return { value: u.stats.median(v), n: v.length }; }
  function openCount(list, fn) { var open = list.filter(function (r) { return r.is_open; }); return { value: open.filter(fn).length, n: open.length }; }
  function kpis(now, prior) {
    return {
      volume: mk('volume', 'Volume', 'count', 'neutral', { value: now.length, n: now.length }, prior ? { value: prior.length, n: prior.length } : null),
      sentiment_index: mk('sentiment_index', 'Sentiment index', 'pts', 'up_good', meanIdx(now), prior ? meanIdx(prior) : null),
      net_sentiment: mk('net_sentiment', 'Net sentiment', 'pct', 'up_good', { value: (roll(now).posShare - roll(now).negShare) * 100, n: now.length }, prior ? { value: (roll(prior).posShare - roll(prior).negShare) * 100, n: prior.length } : null),
      nps: mk('nps', 'NPS', 'score', 'up_good', npsOf(now), prior ? npsOf(prior) : null),
      csat: mk('csat', 'CSAT', 'pct', 'up_good', { value: 78, n: 40, interval: { lo: 64, hi: 88 } }, prior ? { value: 81, n: 35 } : null),
      complaints_per_1k: mk('complaints_per_1k', 'Complaints per 1k orders', 'per_1k', 'down_good', { value: null, n: 0 }, null),
      contact_rate: mk('contact_rate', 'Contact rate', 'pct', 'down_good', { value: null, n: 0 }, null),
      frt_median: mk('frt_median', 'First response (median)', 'hours', 'down_good', medianHours(now, 'frt_hours'), prior ? medianHours(prior, 'frt_hours') : null),
      frt_sla_pct: mk('frt_sla_pct', 'First response within SLA', 'pct', 'up_good', { value: 82, n: 130, interval: { lo: 74, hi: 88 } }, prior ? { value: 86, n: 100 } : null),
      resolution_median: mk('resolution_median', 'Resolution time (median)', 'hours', 'down_good', medianHours(now, 'resolution_hours'), prior ? medianHours(prior, 'resolution_hours') : null),
      resolution_p90: mk('resolution_p90', 'Resolution time (p90)', 'hours', 'down_good', { value: 66, n: 120 }, null),
      reopen_rate: mk('reopen_rate', 'Reopen rate', 'pct', 'down_good', { value: 4, n: 120 }, prior ? { value: 3, n: 100 } : null),
      escalation_rate: mk('escalation_rate', 'Escalation rate', 'pct', 'down_good', { value: 2, n: now.length }, null),
      repeat_contact_rate: mk('repeat_contact_rate', 'Repeat contact rate', 'pct', 'down_good', { value: 18, n: 90 }, null),
      detractor_recovery: mk('detractor_recovery', 'Detractor recovery', 'pct', 'up_good', { value: null, n: 0 }, null),
      backlog_48h: mk('backlog_48h', 'Backlog older than 48h', 'count', 'down_good', openCount(now, function (r) { return r.age_hours > 48; }), null),
      open_p0_p1: mk('open_p0_p1', 'Open P0/P1', 'count', 'down_good', openCount(now, function (r) { return r.urgency === 'P0' || r.urgency === 'P1'; }), null),
      sla_breached: mk('sla_breached', 'SLA breached (open)', 'count', 'down_good', openCount(now, function (r) { return r.first_response_at == null && r.sla_frt_breached; }), null),
      unassigned: mk('unassigned', 'Unassigned (open)', 'count', 'down_good', openCount(now, function (r) { return r.assignee == null; }), null),
      needs_review_pct: mk('needs_review_pct', 'Needs review', 'pct', 'down_good', { value: 6, n: now.length }, null)
    };
  }
  var deadlines = [
    { rec: ae, clock: 'medwatch_15bd', deadline: ae.regulatory_deadline, remaining: null, businessDaysRemaining: ae.business_days_remaining },
    { rec: fs, clock: 'rfr_24h', deadline: fs.regulatory_deadline, remaining: fs.hours_remaining, businessDaysRemaining: null }
  ].sort(function (a, b) { return a.deadline < b.deadline ? -1 : 1; });
  var derived = {
    now: NOW, clockMode: 'demo',
    filters: { range: { preset: '30d', from: FROM, to: TO }, compare: 'prior_period', product: [], category: [], subcategory: [], channel: [], sales_channel: [], segment: [], region: [], urgency: [], status: [], sentiment: [], assignee: [], search: '', restrictedQueue: false },
    records: records, compare: compare, compareRange: { from: PRIOR_FROM, to: PRIOR_TO }, n: records.length, allRecords: allRecords,
    kpis: kpis(records, compare),
    byDay: byKey(records, 'day_key', dayKeys), byWeek: byKey(records, 'week_key', weekKeys),
    byCategory: byDim(records, 'category', Object.keys(VOC.enums.CATEGORIES)), byProduct: byDim(records, 'product', Object.keys(VOC.enums.PRODUCTS)),
    bySubcategory: byDim(records, 'subcategory', []), byChannel: byDim(records, 'channel', []), bySegment: byDim(records, 'segment', []),
    regulatory: { openSerious: [ae], openFoodSafety: [fs], deadlines: deadlines }, alerts: [],
    dq: { n: records.length, needsReviewPct: 0.06, nonEnglishPct: 0.04, noiseDropped: 11, duplicatesRemoved: 2, agreementCategory: 0.91, agreementCategoryN: 150, agreementSentiment: 0.88, agreementSentimentN: 140, ordersCoverageMonths: 12 },
    settings: { clock: 'demo', sla: { P0: 1, P1: 4, P2: 24, P3: 72 } }
  };
  var VALID_SEVERITY = ['info', 'warning', 'critical', 'good'];
  function clean(s) { return typeof s === 'string' && s.length > 0 && s.indexOf('NaN') < 0 && s.indexOf('undefined') < 0 && s.indexOf('null') < 0; }

  /* ---------- lint ---------- */
  var l1 = N.lint('Volume will rise 12% next week.');
  assert(!l1.ok && l1.violations.length === 2 && /will/.test(l1.violations[0]) && /percentage/.test(l1.violations[1]), 'lint flags "will" and a percentage with no n');
  assert(!N.lint('We guarantee results (n=10).').ok, 'lint flags "guarantee"');
  assert(!N.lint('Prioritise billing (n=10).').ok && !N.lint('Nothing to analyse yet.').ok && !N.lint('Colour and behaviour drifted.').ok && /British spelling "Prioritise"/.test(N.lint('Prioritise billing.').violations[0]),
    'lint flags British spellings (prioritise, analyse, colour, behaviour)');
  assert(N.lint('Prioritize the analysis, color-code it and center the behavior chart (n=10).').ok, 'lint accepts the American forms');
  assert(N.lint('Goodwill returned: 12% of records (n=97) mention it, and the team acted willingly.').ok, 'lint ignores goodwill/willingly and accepts a percentage with n nearby');
  assert(N.lint('').ok && N.lint(null).ok, 'lint accepts empty input');

  /* ---------- headline ---------- */
  var h = N.headline(derived);
  assert(clean(h) && N.lint(h).ok, 'headline is non-empty, clean and lint-clean: ' + h);
  assert(/^Last 30 days \(demo clock\): /.test(h) && /150 contacts/.test(h) && /NPS/.test(h) && /n=/.test(h), 'headline carries range, demo clock, volume, NPS and n');
  assert(/vs the prior 30 days/.test(h), 'headline compares with the prior 30 days');
  if (/in negatives is/.test(h)) assert(/\d+ → \d+ negatives, [+−]\d+; n=\d+ now vs \d+ prior\)/.test(h), 'headline lead-change clause states both negative counts and both n (prior → now): ' + h);
  var derivedNoNps = Object.assign({}, derived, { kpis: Object.assign({}, derived.kpis, { nps: mk('nps', 'NPS', 'score', 'up_good', { value: null, n: 0 }, null), sentiment_index: mk('sentiment_index', 'Sentiment index', 'pts', 'up_good', { value: null, n: 0 }, null) }) });
  var h2 = N.headline(derivedNoNps);
  assert(clean(h2) && N.lint(h2).ok && h2.indexOf('NPS') < 0 && h2.indexOf('sentiment index') < 0 && /n=150/.test(h2), 'headline omits NPS and sentiment clauses when those KPIs are null and still carries n: ' + h2);
  var empty = { now: NOW, clockMode: 'demo', filters: { range: { preset: '7d', from: u.addDays(TO, -6), to: TO }, compare: 'prior_period' }, records: [], compare: [], n: 0, kpis: {}, byDay: [], byWeek: [], byCategory: [], byProduct: [], regulatory: { openSerious: [], openFoodSafety: [], deadlines: [] }, dq: {}, settings: { clock: 'demo' } };
  var h3 = N.headline(empty);
  assert(clean(h3) && /n=0/.test(h3) && N.lint(h3).ok, 'headline degrades on an empty state: ' + h3);
  assert(clean(N.headline(null)) && clean(N.headline({})), 'headline tolerates null / {} input');
  var noCompare = Object.assign({}, derived, { compare: [], compareRange: null, filters: Object.assign({}, derived.filters, { compare: 'none' }) });
  var h4 = N.headline(noCompare);
  assert(clean(h4) && N.lint(h4).ok && h4.indexOf('prior') < 0 && /largest theme/.test(h4), 'headline without a comparison describes the largest theme instead: ' + h4);

  /* ---------- headlineParts (the Briefing's bold lead block) ---------- */
  var parts = N.headlineParts(derived);
  assert(Array.isArray(parts) && parts.length >= 3 && parts.length <= 4, 'headlineParts returns 3–4 statements, got ' + (parts && parts.length));
  parts.forEach(function (p, i) {
    var lp = N.lint(p);
    assert(clean(p) && p.length <= 90 && lp.ok && /n=\d/.test(p), 'part ' + i + ' is clean, ≤ 90 chars, lint-clean and carries n (' + p.length + ' chars): ' + p + (lp.ok ? '' : ' [' + lp.violations.join('; ') + ']'));
  });
  assert(/^Last 30 days \(demo clock\): 150 contacts/.test(parts[0]) && /vs/.test(parts[0]), 'first part carries range, demo clock, volume and the delta: ' + parts[0]);
  assert(parts.some(function (p) { return /^Sentiment index \d+ \(.*\) · NPS -?\d+ \(n=\d+/.test(p); }), 'a part carries the sentiment index and NPS with n: ' + parts.join(' | '));
  assert(parts.some(function (p) { return /negatives|Largest theme/.test(p); }), 'a part names the driver of change or the largest theme: ' + parts.join(' | '));
  assert(/1 open serious AE/.test(parts[parts.length - 1]) && /unfiltered/.test(parts[parts.length - 1]), 'last part is the regulatory state when a clock is running: ' + parts[parts.length - 1]);
  var partsNoCompare = N.headlineParts(noCompare);
  assert(partsNoCompare.length >= 3 && partsNoCompare.every(function (p) { return p.length <= 90 && N.lint(p).ok && p.indexOf('prior') < 0; }) && partsNoCompare.some(function (p) { return /^Largest theme/.test(p); }), 'without a comparison the parts drop deltas and name the largest theme: ' + partsNoCompare.join(' | '));
  var partsEmpty = N.headlineParts(empty);
  assert(partsEmpty.length >= 1 && /n=0/.test(partsEmpty[0]) && partsEmpty.every(function (p) { return N.lint(p).ok; }), 'headlineParts degrades on an empty state: ' + partsEmpty.join(' | '));
  assert(Array.isArray(N.headlineParts(null)) && Array.isArray(N.headlineParts({})), 'headlineParts tolerates null / {} input');
  assert(N.deadlineRemaining(deadlines[0]).length > 0 && N.deadlineRemaining(null) === '', 'deadlineRemaining formats a deadline entry and tolerates null');

  /* ---------- insights ---------- */
  var cards = N.insights(derived);
  assert(Array.isArray(cards) && cards.length === 5, 'insights returns exactly 5 cards');
  assert(cards.map(function (c) { return c.kind; }).join(',') === 'change,driver,emerging,regulatory,outlook', 'insight kinds are change, driver, emerging, regulatory, outlook in order');
  cards.forEach(function (c) {
    var lt = N.lint(c.title + ' ' + c.text);
    assert(clean(c.title) && clean(c.text) && typeof c.evidence === 'string' && lt.ok, 'card ' + c.kind + ' is clean and lint-clean: ' + c.title + ' — ' + c.text + (lt.ok ? '' : ' [' + lt.violations.join('; ') + ']'));
    assert(VALID_SEVERITY.indexOf(c.severity) >= 0 && (c.drill === null || (c.drill && typeof c.drill.view === 'string')), 'card ' + c.kind + ' has a valid severity and drill');
    assert(/n=/.test(c.text), 'card ' + c.kind + ' text carries n');
  });
  var reg = cards[3];
  assert(/unfiltered/.test(reg.text) && /1 open serious AE/.test(reg.title) && /remaining/.test(reg.title) && /business days? remaining/.test(reg.text) && reg.severity === 'critical' && reg.drill.view === 'regulatory', 'regulatory card counts the open serious AE, shows the nearest deadline and MedWatch business days remaining, is labelled unfiltered: ' + reg.title + ' — ' + reg.text);
  assert(/RFR open 1/.test(reg.evidence) && /food safety open 1/.test(reg.evidence), 'regulatory evidence lists RFR and food-safety counts');
  var change = cards[0];
  assert(/vs the prior 30 days/.test(change.title) && /150 records against 118/.test(change.text) && change.drill.view === 'trends', 'change card compares 150 vs 118 records: ' + change.title);
  if (hasPredict) {
    assert(cards[4].drill && cards[4].drill.view === 'predict' && /Expect about/.test(cards[4].text), 'outlook card uses the forecast when predict is present: ' + cards[4].title);
    assert(cards[1].drill && cards[1].drill.view === 'themes', 'driver card drills to themes: ' + cards[1].title);
  } else {
    assert(/unavailable/.test(cards[4].title) && cards[4].severity === 'info', 'outlook card is an honest info card when predict is absent');
    assert(/unavailable/.test(cards[2].title) && cards[2].severity === 'info', 'emerging card is an honest info card when predict is absent');
  }
  var emptyCards = N.insights(empty);
  assert(emptyCards.length === 5 && emptyCards.every(function (c) { return clean(c.text) && N.lint(c.title + ' ' + c.text).ok && VALID_SEVERITY.indexOf(c.severity) >= 0; }), 'insights on an empty state still yields 5 honest cards');
  assert(emptyCards[3].severity === 'good' && /No open regulatory clocks/.test(emptyCards[3].title), 'regulatory card is green when nothing is open');
  assert(N.insights(null).length === 5 && N.insights({}).length === 5, 'insights tolerates null / {} input');

  /* ---------- explainMetric, forecastSentence, whatChangedSentence ---------- */
  var ex = N.explainMetric('nps', derived);
  assert(clean(ex) && /^NPS/.test(ex) && /n=/.test(ex) && /95% interval/.test(ex) && /Higher is better/.test(ex) && N.lint(ex).ok, 'explainMetric(nps): ' + ex);
  if (hasMetrics) assert(/%9–10 − %0–6/.test(ex), 'explainMetric includes the registry formula');
  var ex2 = N.explainMetric('complaints_per_1k', derived);
  assert(clean(ex2) && /no value/.test(ex2) && /n=0/.test(ex2), 'explainMetric handles a null value: ' + ex2);
  assert(clean(N.explainMetric('nope', derived)) && clean(N.explainMetric('nps', {})), 'explainMetric tolerates unknown ids and empty derived');
  var mockForecast = {
    method: 'holt_winters', n: 365, confidence: 'high', caveats: [], backtest: { mape: 0.12, coverage80: 0.8, folds: [1, 2, 3, 4] },
    history: [22, 21, 25, 20, 19, 23, 24].map(function (v, i) { return { key: u.addDays(TO, i - 6), value: v, fitted: v }; }),
    forecast: [23, 24, 22, 23, 25, 21, 23].map(function (v, i) { return { key: u.addDays(TO, i + 1), value: v, lo80: v - 8, hi80: v + 8, lo95: v - 12, hi95: v + 12 }; }),
    weekly: [{ weekKey: '2026-W39', days: 7, value: 161, lo80: 105, hi80: 217 }]
  };
  var fs1 = N.forecastSentence(mockForecast);
  assert(/^Expect about 23 messages a day next week, likely 15–31; volume is trending \+\d+% a week \(n=365 days, backtest MAPE 12%\)\.$/.test(fs1) && N.lint(fs1).ok, 'forecastSentence matches the house format: ' + fs1);
  assert(/n=0/.test(N.forecastSentence(null)) && /n=0/.test(N.forecastSentence({ forecast: [] })), 'forecastSentence degrades on empty results');
  // low-confidence result whose first caveat states percentages without n (the shape predict used to emit): the sentence must still lint
  var covForecast = Object.assign({}, mockForecast, { confidence: 'low', caveats: ['Backtest coverage of the 80% band is 96%, so the band width is off; read it as indicative.'],
    backtest: { mape: 0.65, coverage80: 0.96, folds: [{ n: 7 }, { n: 7 }, { n: 7 }, { n: 7 }] } });
  var fs2 = N.forecastSentence(covForecast);
  assert(N.lint(fs2).ok && /n=4 folds, 28 days scored/.test(fs2) && /band is 96%/.test(fs2), 'forecastSentence: coverage caveat gets the fold count and lints clean: ' + fs2);
  var covCaveat = fs2.slice(fs2.indexOf('Backtest coverage'));
  assert(N.lint(covCaveat).ok, 'the appended caveat lints clean on its own (chart footnotes show it alone): ' + covCaveat);
  var weeklyForecast = Object.assign({}, mockForecast, { backtest: { mape: 0.65, weeklyMape: 0.12, mase: 0.8, coverage80: 0.86, folds: [1, 2, 3, 4] } });
  var fs3 = N.forecastSentence(weeklyForecast);
  assert(/backtest weekly MAPE 12%, daily 65%\)\.$/.test(fs3) && N.lint(fs3).ok, 'forecastSentence prefers the weekly-block MAPE when present: ' + fs3);
  var badCaveat = N.forecastSentence(Object.assign({}, mockForecast, { confidence: 'low', caveats: ['Volume will drop 30% next week.'], backtest: { mape: 0.2, folds: [{ n: 7 }] } }));
  assert(!/will/.test(badCaveat) && N.lint(badCaveat).ok, 'forecastSentence drops a caveat that cannot be made lint-clean: ' + badCaveat);
  assert(N.lintSafeCaveat('Coverage is 96%.', { folds: [{ n: 7 }, { n: 7 }] }) === 'Coverage is 96% (n=2 folds, 14 days scored).' && N.lintSafeCaveat('Coverage is 96%.', {}) === '' && N.lintSafeCaveat('Plain caveat.', null) === 'Plain caveat.', 'lintSafeCaveat: appends folds, drops what it cannot fix, passes clean text through');
  var mockWc = { method: 'rate_volume_decomposition', n: 268, params: { outcome: 'negative' }, total: { now: 71, prior: 52, delta: 19, volumeNow: 150, volumePrior: 118 },
    rows: [{ value: 'subscription_billing', label: 'Subscription & Billing', nNow: 40, nPrior: 28, delta: 11, volumeEffect: 8.4, rateEffect: 2.6 }, { value: 'shipping_fulfillment', label: 'Shipping & Delivery', nNow: 25, nPrior: 22, delta: 5, volumeEffect: 1.9, rateEffect: 3.1 }, { value: '__other__', label: 'Other', nNow: 85, nPrior: 68, delta: 3, volumeEffect: 2, rateEffect: 1 }] };
  var wcs = N.whatChangedSentence(mockWc);
  assert(/Negative records moved from 52 to 71 \(\+19; n=150 now vs 118 prior\)/.test(wcs) && /Subscription & Billing adds \+11/.test(wcs) && /Volume shifts explain about \+12\.3/.test(wcs) && N.lint(wcs).ok, 'whatChangedSentence: ' + wcs);
  assert(/n=0/.test(N.whatChangedSentence(null)), 'whatChangedSentence degrades on null');
  if (hasPredict) {
    var realWc = N.whatChangedSentence(VOC.predict.whatChanged(records, compare, 'category', { now: NOW }));
    assert(clean(realWc) && N.lint(realWc).ok, 'whatChangedSentence on a real predict result: ' + realWc);
  }

  /* ---------- every generated sentence on the synthetic derived state passes lint ---------- */
  (function () {
    var sentences = [];
    var label = [];
    sentences.push(N.headline(derived)); label.push('headline');
    N.insights(derived).forEach(function (c) { sentences.push(c.title + ' ' + c.text + ' ' + (c.evidence || '')); label.push('insight:' + c.kind); });
    var fcRes = null;
    if (hasPredict) {
      try { fcRes = VOC.predict.forecastVolume(N.historySeries(derived).series, { horizon: 28, now: NOW }); } catch (e) { fcRes = null; }
      if (fcRes) { sentences.push(fcRes.explanation); label.push('predict.forecastVolume.explanation'); fcRes.caveats.forEach(function (c, i) { sentences.push(c); label.push('predict.forecastVolume.caveat' + i); }); }
    }
    sentences.push(N.forecastSentence(fcRes || covForecast)); label.push('forecastSentence');
    sentences.push(N.whatChangedSentence(hasPredict ? VOC.predict.whatChanged(records, compare, 'category', { now: NOW }) : mockWc)); label.push('whatChangedSentence');
    N.recommendations(derived).forEach(function (r, i) { sentences.push(r); label.push('recommendation' + i); });
    var bad = [];
    sentences.forEach(function (t, i) { var l = N.lint(t); if (!l.ok || !clean(t)) bad.push(label[i] + ': ' + l.violations.join('; ') + ' :: ' + t); });
    assert(sentences.length >= 10 && bad.length === 0, 'lint passes on headline, 5 insights, forecastSentence, whatChangedSentence and recommendations (' + sentences.length + ' sentences)' + (bad.length ? '\n  ' + bad.join('\n  ') : ''));
  })();

  /* ---------- verbatims ---------- */
  var v = N.verbatims(records, { praise: 2, complaint: 3 });
  assert(v.length === 5, 'verbatims returns 2 + 3 = 5 records');
  assert(v.slice(0, 2).every(function (r) { return r.sentiment_label === 'positive' || r.category === 'praise'; }) && v.slice(2).every(function (r) { return r.sentiment_label !== 'positive'; }), 'verbatims orders praise first, then complaints');
  assert(v.every(function (r) { return !r.restricted || r.redacted; }), 'verbatims never returns a restricted record unredacted');
  assert(N.verbatims(records).length === 3, 'verbatims defaults to {praise:1, complaint:2}');
  var restrictedOnly = records.filter(function (r) { return r.sentiment_label === 'positive'; }).slice(0, 4).map(function (r) { return Object.assign({}, r, { restricted: true }); });
  var vr = N.verbatims(restrictedOnly.concat(records.filter(function (r) { return r.sentiment_label === 'negative'; }).slice(0, 3)), { praise: 2, complaint: 1 });
  assert(vr.length === 3 && vr.slice(0, 2).every(function (r) { return r.redacted === true && r.from_email === null && r.from_name === 'Redacted' && /restricted/.test(r.text); }), 'verbatims redacts restricted praise via redactRecord when nothing else qualifies');
  assert(restrictedOnly.every(function (r) { return r.redacted === undefined; }), 'verbatims does not mutate its inputs');
  assert(N.verbatims([], { praise: 2, complaint: 3 }).length === 0 && N.verbatims(null).length === 0, 'verbatims handles empty input');
  var mixed = records.map(function (r) { return Object.assign({}, r, { restricted: r.id.slice(-1) === '3' }); });
  assert(N.verbatims(mixed, { praise: 1, complaint: 2 }).every(function (r) { return !r.restricted; }), 'verbatims prefers non-restricted records when they exist');

  /* ---------- recommendations ---------- */
  var recs = N.recommendations(derived);
  assert(recs.length === 3 && recs.every(function (s) { return clean(s) && N.lint(s).ok && /n=/.test(s); }), 'recommendations returns 3 clean, lint-clean strings with n');
  recs.forEach(function (s, i) { console.log('  rec ' + (i + 1) + ': ' + s); });
  var recsEmpty = N.recommendations(empty);
  assert(recsEmpty.length === 3 && recsEmpty.every(function (s) { return clean(s) && N.lint(s).ok; }), 'recommendations on an empty state still returns 3 honest strings');
  assert(N.recommendations(null).length === 3, 'recommendations tolerates null');

  /* ---------- helpers ---------- */
  assert(N.filterContext(derived).indexOf('Last 30 days') === 0 && /Aug 18 – Sep 16, 2026/.test(N.filterContext(derived)), 'filterContext describes the range: ' + N.filterContext(derived));
  var fc2 = N.filterContext(Object.assign({}, derived, { filters: Object.assign({}, derived.filters, { product: ['prolon_5day'], sentiment: ['negative'] }) }));
  assert(/product: ProLon 5-Day/.test(fc2) && /sentiment: negative/i.test(fc2), 'filterContext lists dimension filters with labels: ' + fc2);
  assert(N.dailySeries(derived).length === 30 && N.dailySeries({ records: records }).length >= 1, 'dailySeries uses byDay and falls back to records');

  /* ---------- reports ---------- */
  var ctx = { actions: ['Ship the cancellation-link fix (owner: Devon K.)', { text: 'Recall review on lot NG-0426-B', owner: 'Priya S.', due: '2026-09-23', status: 'open' }] };
  var weekly = R.weekly(derived, ctx);
  var monthly = R.monthly(derived, ctx);
  var WEEKLY_HEADS = ['Headline', 'Key metrics', 'Top themes', 'Emerging issues and anomalies', 'Product spotlight', 'Regulatory', 'Service performance', 'Verbatims', 'Actions carried forward', 'Four-week forecast', 'Data quality'];
  var MONTHLY_HEADS = WEEKLY_HEADS.concat(['Recommendations', 'Methodology']);
  assert(/^<article class="report report--weekly"/.test(weekly) && /<\/article>$/.test(weekly), 'weekly returns a .report article fragment');
  WEEKLY_HEADS.forEach(function (hd) { assert(weekly.indexOf('<h2 class="report-h2">' + hd + '</h2>') >= 0, 'weekly has section "' + hd + '"'); });
  MONTHLY_HEADS.forEach(function (hd) { assert(monthly.indexOf('<h2 class="report-h2">' + hd + '</h2>') >= 0, 'monthly has section "' + hd + '"'); });
  assert(monthly.indexOf('<h2 class="report-h2">Recommendations</h2>') < monthly.indexOf('<h2 class="report-h2">Key metrics</h2>'), 'monthly puts recommendations before the KPI table');
  assert(weekly.indexOf('Recommendations</h2>') < 0 && weekly.indexOf('Methodology</h2>') < 0, 'weekly omits the monthly-only sections');
  ['report-h1', 'report-kpis', 'report-section', 'report-verbatim', 'report-footer'].forEach(function (cls) { assert(weekly.indexOf('class="' + cls) >= 0 || weekly.indexOf(' ' + cls + ' ') >= 0 || weekly.indexOf(cls + ' ') >= 0 || weekly.indexOf(cls + '"') >= 0, 'weekly uses class .' + cls); });
  assert(weekly.indexOf('<script') < 0 && monthly.indexOf('<script') < 0 && weekly.indexOf('onerror=') < 0 && weekly.indexOf('<b>') < 0, 'record text never reaches the HTML unescaped');
  assert(weekly.indexOf('&lt;script&gt;') >= 0 || weekly.indexOf('&lt;b&gt;') >= 0, 'record text is present in escaped form');
  assert(weekly.indexOf('Charged twice &amp; no reply') >= 0, 'subjects are escaped (& → &amp;)');
  assert(weekly.indexOf('NaN') < 0 && weekly.indexOf('undefined') < 0 && monthly.indexOf('NaN') < 0 && monthly.indexOf('undefined') < 0, 'reports contain no NaN/undefined');
  assert((weekly.match(/<blockquote class="report-verbatim report-verbatim--praise"/g) || []).length === 2 && (weekly.match(/report-verbatim--complaint"/g) || []).length === 3, 'weekly shows 2 praise and 3 complaint verbatims');
  assert(weekly.indexOf('Ship the cancellation-link fix') >= 0 && weekly.indexOf('owner Priya S.') >= 0 && weekly.indexOf('due Sep 23, 2026') >= 0, 'actions carried forward render strings and objects');
  assert(weekly.indexOf('All records, unfiltered') >= 0 && weekly.indexOf('MedWatch 15 business days') >= 0 && weekly.indexOf('RFR 24 hours') >= 0, 'regulatory box is labelled unfiltered and lists both clocks');
  assert(weekly.indexOf('8-week median') >= 0 && weekly.indexOf('95% interval') >= 0 && weekly.indexOf('Week ending Sep 16, 2026') >= 0, 'KPI table has median and interval columns; header shows week ending');
  var stripHtml = function (html) { return String(html).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' '); };
  var lw = N.lint(stripHtml(weekly)), lm = N.lint(stripHtml(monthly));
  assert(lw.ok && lm.ok, 'the weekly and monthly report text passes the copy lint (every percentage carries an n)' + (lw.ok ? '' : ' weekly: ' + lw.violations.join('; ')) + (lm.ok ? '' : ' monthly: ' + lm.violations.join('; ')));
  assert(/<td class="num">n=\d/.test(weekly), 'KPI and service tables print n as "n=…" in the n column');
  assert(monthly.indexOf('September 2026') >= 0, 'monthly header names the month');
  assert(weekly.indexOf('Demo clock') >= 0 && weekly.indexOf('Lexicon v') >= 0 === !!(VOC.lexicon && VOC.lexicon.version), 'footer states clock mode and lexicon version when present');
  if (hasMetrics) assert(monthly.indexOf('count(records)') >= 0 && monthly.indexOf('%9–10 − %0–6') >= 0, 'methodology appendix lists registry formulas');
  if (hasPredict) assert(weekly.indexOf('Likely (80% band)') >= 0 && weekly.indexOf('Model: ') >= 0, 'forecast section shows the weekly range table and model note');
  else assert(weekly.indexOf('Forecast unavailable') >= 0, 'forecast section is honest when predict is absent');
  var weeklyEmpty = R.weekly(empty, {});
  assert(/^<article/.test(weeklyEmpty) && weeklyEmpty.indexOf('No actions carried forward') >= 0 && weeklyEmpty.indexOf('NaN') < 0 && weeklyEmpty.indexOf('undefined') < 0, 'weekly renders on an empty state without NaN/undefined');
  assert(/^<article/.test(R.weekly(null)) && /^<article/.test(R.monthly({})), 'reports tolerate null / {} input');

  /* ---------- wrapPrintable ---------- */
  var doc = R.wrapPrintable(weekly, { title: 'Weekly VoC <test>', derived: derived });
  assert(doc.indexOf('<!doctype html>') === 0, 'wrapPrintable starts with <!doctype html>');
  assert(doc.indexOf('<title>Weekly VoC &lt;test&gt;</title>') >= 0 && doc.indexOf('--brand:#1E4036') >= 0 && doc.indexOf('.report-verbatim') >= 0 && doc.indexOf('@page') >= 0, 'wrapPrintable escapes the title and inlines tokens, report styles and @page');
  assert(/Generated .+ CT/.test(doc) && doc.indexOf('Demo clock') >= 0 && doc.indexOf('Filters: Last 30 days') >= 0 && doc.indexOf('n=150') >= 0, 'wrapPrintable footer has generated CT timestamp, clock mode, filter context and n');
  assert(doc.indexOf(weekly) >= 0 && /<\/html>$/.test(doc), 'wrapPrintable embeds the fragment and closes the document');
  var doc2 = R.wrapPrintable('<p>x</p>', { footer: 'Custom <footer>' });
  assert(doc2.indexOf('Custom &lt;footer&gt;') >= 0 && doc2.indexOf('<!doctype html>') === 0, 'wrapPrintable uses and escapes a supplied footer string');
  var ft = R.footerText(derived);
  assert(/^Generated /.test(ft) && /n=150/.test(ft) && /Demo clock/.test(ft), 'footerText: ' + ft);

  console.log('\n' + (total - failures) + '/' + total + ' assertions passed');
  if (failures) throw new Error(failures + ' narrate/report assertion(s) failed');
})();
