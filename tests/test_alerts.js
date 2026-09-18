/* tests/test_alerts.js — VOC.alerts.evaluate on a synthetic DerivedState under jsc (run via tests/run.sh so VOC.predict is loaded).
 * Asserts: every detail ≤ 220 chars and carries n; a volume spike and a negative-share spike on the same day are both kept and
 * linked; an emerging lot, its kit component, its subcategory and its phrases (same records) collapse into one alert on the lot
 * with the others named in detail; alert ids use the unit's value; sla_breach states the count, P0/P1 count and oldest age;
 * sentiment drift alerts only through the gated predict.sentimentDrift.
 */
(function () {
  'use strict';
  var failures = 0, total = 0;
  function assert(cond, msg) {
    total += 1;
    if (cond) console.log('PASS ' + msg);
    else { failures += 1; console.log('FAIL ' + msg); }
  }
  var u = VOC.util, AL = VOC.alerts;
  assert(AL && typeof AL.evaluate === 'function' && typeof AL.defaultRules === 'function', 'VOC.alerts loads under jsc');
  var hasPredict = !!(VOC.predict && typeof VOC.predict.detectEmerging === 'function');

  var AS_OF = '2026-09-16T23:59:00Z';
  var nowD = new Date(AS_OF);
  var TODAY = u.dayKey(nowD);
  var DAY = 86400000;

  function rec(id, dayKey, o) {
    var at = u.startOfDayCT(dayKey);
    var atMs = new Date(at).getTime() + 15 * 3600000;
    var iso = new Date(atMs).toISOString();
    var status = o.status || 'resolved';
    var open = ['new', 'open', 'pending', 'reopened', 'escalated'].indexOf(status) >= 0;
    var frt = o.frt === undefined ? 2 : o.frt;
    var r = {
      id: id, received_at: iso, day_key: dayKey, week_key: u.weekKey(iso), month_key: dayKey.slice(0, 7), subject: o.subject || 'Note', text: o.text || 'Everything is fine, thanks.',
      from_name: 'Customer', from_email: id + '@example.com', channel: 'email', product: o.product || 'prolon_5day', kit_component: o.kit_component || null,
      category: o.category || 'praise', subcategory: o.subcategory || 'general_praise', sentiment: o.sentiment === undefined ? 0.5 : o.sentiment,
      sentiment_label: o.label || (o.sentiment !== undefined && o.sentiment < -0.15 ? 'negative' : 'positive'), urgency: o.urgency || 'P2', status: status, is_open: open,
      assignee: o.assignee === undefined ? 'Maya R.' : o.assignee, lot_number: o.lot || null, serious_ae: false, food_safety: !!o.food, is_noise: false, is_adverse_event: false,
      frt_hours: frt, sla_frt_hours: o.urgency === 'P1' ? 4 : 24, age_hours: (nowD.getTime() - atMs) / 3600000, segment: 'first_time', region: 'US', language: 'en', customer_id: 'c_' + id, thread_id: 't_' + id
    };
    r.sla_frt_breached = r.frt_hours === null ? (open && r.age_hours > r.sla_frt_hours) : r.frt_hours > r.sla_frt_hours;
    r.sentiment_index = (r.sentiment + 1) / 2 * 100;
    return r;
  }

  /* ---- fixture: 100 flat days (6 records/day, 2 negative), then a same-day volume + negative-share spike and a lot ramp in the last 7 days ---- */
  var records = [];
  var byDay = [];
  var SPIKE_DAY = u.addDays(TODAY, -2);
  for (var i = 99; i >= 0; i--) {
    var dk = u.addDays(TODAY, -i);
    var n = 6, neg = 2;
    if (dk === SPIKE_DAY) { n = 18; neg = 15; }
    for (var j = 0; j < n; j++) records.push(rec('r_' + dk + '_' + j, dk, { sentiment: j < neg ? -0.5 : 0.5, category: j < neg ? 'shipping_fulfillment' : 'praise', subcategory: j < neg ? 'late' : 'general_praise' }));
    byDay.push({ key: dk, count: n, neg: neg, pos: n - neg, neu: 0, meanSentiment: (neg * -0.5 + (n - neg) * 0.5) / n });
  }
  // E6-style ramp: 12 lot records in the last 7 days, none in the prior 28 — lot, kit component, subcategory and phrases all describe them
  for (var k = 0; k < 12; k++) {
    records.push(rec('lot_' + k, u.addDays(TODAY, -(k % 7)), { lot: 'NG-0426-B', kit_component: 'soup_minestrone_quinoa', product: 'prolon_nextgen', category: 'foreign_material_allergen', subcategory: 'hard_bits',
      sentiment: -0.7, urgency: 'P0', food: true, subject: 'Hard bits in the minestrone quinoa', text: 'Found hard bits like nut shell in the minestrone quinoa soup. Lot NG-0426-B on the box.' }));
  }
  // SLA: 3 open records with no first response past their SLA (one P1), oldest 9 days
  records.push(rec('sla_1', u.addDays(TODAY, -9), { status: 'open', frt: null, urgency: 'P2', assignee: null }));
  records.push(rec('sla_2', u.addDays(TODAY, -3), { status: 'open', frt: null, urgency: 'P1' }));
  records.push(rec('sla_3', u.addDays(TODAY, -2), { status: 'new', frt: null, urgency: 'P2', assignee: null }));

  function weekly(nWeeks, perWeek, slope) {
    var out = [];
    for (var w = 0; w < nWeeks; w++) {
      var key = u.weekKey(u.addDays(TODAY, -7 * (nWeeks - 1 - w)));
      var mean = ((60 + slope * w) / 100) * 2 - 1;
      out.push({ key: key, count: perWeek, neg: 0, pos: perWeek, neu: 0, meanSentiment: mean });
    }
    return out;
  }
  function derivedWith(byWeek) {
    return { now: nowD, records: records, allRecords: records, byDay: byDay, byWeek: byWeek || [], regulatory: { openSerious: [], openFoodSafety: [], deadlines: [] } };
  }

  /* ---- 1. shape, detail length, n ---- */
  AL.reset();
  var alerts = AL.evaluate(derivedWith(weekly(12, 30, -1.5)), { predict: VOC.predict });
  assert(alerts.length > 0, 'evaluate returns alerts on the fixture (' + alerts.length + ')');
  assert(alerts.every(function (a) { return a.detail.length <= 220; }), 'every alert detail is ≤ 220 chars (max ' + Math.max.apply(null, alerts.map(function (a) { return a.detail.length; })) + ')');
  assert(alerts.every(function (a) { return /\(n = [\d,]+/.test(a.detail); }), 'every alert detail carries (n = …)');
  assert(alerts.every(function (a) { return Array.isArray(a.related) && typeof a.id === 'string' && a.id.indexOf(a.ruleId + ':') === 0; }), 'alerts carry related[] and ids prefixed by their rule');
  assert(alerts.every(function (a) { return !/\bwill\b/i.test(a.title + ' ' + a.detail); }), 'no alert copy uses "will"');
  var ids = alerts.map(function (a) { return a.id; });
  assert(new Set(ids).size === ids.length, 'alert ids are unique');

  /* ---- 2. same-day volume + negative-share spikes: both kept, linked ---- */
  var vol = alerts.filter(function (a) { return a.ruleId === 'volume_zscore' && a.days && a.days.from === SPIKE_DAY; })[0];
  var negA = alerts.filter(function (a) { return a.ruleId === 'neg_share_zscore' && a.days && a.days.from === SPIKE_DAY; })[0];
  assert(vol && negA, 'volume spike and negative-share spike both fire on ' + SPIKE_DAY);
  if (vol && negA) {
    assert(vol.related.indexOf(negA.id) >= 0 && negA.related.indexOf(vol.id) >= 0, 'the two spikes reference each other in related[]');
    assert(/Coincides with a negative-share spike/.test(vol.detail) && /Coincides with a volume spike/.test(negA.detail), 'each spike names the other in its detail');
    // n comes from the records themselves (whole-store daily series), not from the range-bound byDay fixture
    var spikeN = records.filter(function (r) { return r.day_key === SPIKE_DAY; }).length;
    var nRe = new RegExp('\\(n = ' + spikeN + ' records that day\\)');
    assert(spikeN > 18 && nRe.test(vol.detail) && nRe.test(negA.detail), 'both spike details keep n (' + spikeN + ' records on the day, counted from allRecords) after linking');
    assert(negA.n === spikeN && negA.value > 3 && /Negative share spike: 8\d%/.test(negA.title), 'negative share uses the real share of scored records with per-day n: ' + negA.title);
  }
  // alerts describe whole-store facts: cutting byDay to a 7-day range leaves the anomaly alerts unchanged
  var shortRange = AL.evaluate(Object.assign(derivedWith(weekly(12, 30, 0)), { byDay: byDay.slice(-7) }), { predict: VOC.predict });
  assert(shortRange.some(function (a) { return a.ruleId === 'volume_zscore' && a.days.from === SPIKE_DAY; }) && shortRange.some(function (a) { return a.ruleId === 'neg_share_zscore' && a.days.from === SPIKE_DAY; }), 'volume and negative-share alerts do not depend on the filter range (7-day byDay still yields both)');

  /* ---- 3. emerging: lot absorbs component / subcategory / phrases describing the same records ---- */
  if (hasPredict) {
    var emerging = alerts.filter(function (a) { return a.ruleId === 'emerging_unit'; });
    var lotAlert = emerging.filter(function (a) { return a.id === 'emerging_unit:lot:NG-0426-B'; })[0];
    assert(lotAlert, 'emerging alert on the lot uses the lot value in its id (' + emerging.map(function (a) { return a.id; }).join(', ') + ')');
    if (lotAlert) {
      assert(lotAlert.severity === 'critical' && lotAlert.n === 12 && /\(n = 12\)/.test(lotAlert.detail), 'lot alert is critical with n = 12');
      var alsoTypes = (lotAlert.alsoRising || []).map(function (x) { return x.type; });
      assert(alsoTypes.indexOf('subcategory') >= 0 && alsoTypes.indexOf('kit_component') >= 0, 'lot alert lists the subcategory and kit component as the same event: ' + alsoTypes.join(', '));
      assert(/Same records also rise as/.test(lotAlert.detail) && /Hard bits|hard_bits/i.test(lotAlert.detail), 'lot detail names the collapsed subcategory');
      assert(lotAlert.drill && lotAlert.drill.filters && lotAlert.drill.filters.search === 'NG-0426-B', 'lot drill searches for the lot value');
    }
    assert(!emerging.some(function (a) { return a.id === 'emerging_unit:subcategory:hard_bits' || a.id === 'emerging_unit:kit_component:soup_minestrone_quinoa'; }), 'no separate subcategory / kit-component alert for the same records');
    assert(!emerging.some(function (a) { return /^emerging_unit:(lot|bigram|subcategory):(lot|bigram|subcategory)$/.test(a.id); }), 'no alert id uses the unit type as its value');
    assert(emerging.every(function (a) { return a.related.indexOf(vol ? vol.id : '') >= 0 || !a.days || a.days.to < SPIKE_DAY; }), 'emerging alerts on the spike days link to the volume spike');
  }

  /* ---- 3b. emerging praise / mostly-positive units are informational, negative ones keep their severity ---- */
  if (hasPredict) {
    var praiseRecs = [];
    for (var pk = 0; pk < 14; pk++) {
      praiseRecs.push(rec('praise_' + pk, u.addDays(TODAY, -(pk % 7)), { product: 'l_protein', category: 'praise', subcategory: 'results_praise', sentiment: 0.7, label: 'positive',
        subject: 'Loving the L-Protein', text: 'Loving the L-Protein shake, great taste and steady energy all week.' }));
    }
    var withPraise = records.concat(praiseRecs);
    AL.reset();
    var praiseAlerts = AL.evaluate({ now: nowD, records: withPraise, allRecords: withPraise, byDay: byDay, byWeek: weekly(12, 30, 0), regulatory: { openSerious: [], openFoodSafety: [], deadlines: [] } }, { predict: VOC.predict });
    var praiseEmerging = praiseAlerts.filter(function (a) { return a.ruleId === 'emerging_unit' && /results_praise|l_protein|praise|l-protein|steady energy|great taste/i.test(a.id + ' ' + a.title); });
    assert(praiseEmerging.length > 0, 'a praise ramp still surfaces as an emerging unit (' + praiseEmerging.map(function (a) { return a.id; }).join(', ') + ')');
    assert(praiseEmerging.every(function (a) { return a.severity === 'info'; }), 'emerging units that are praise or ≥70% positive are capped at info (' + praiseEmerging.map(function (a) { return a.id + '=' + a.severity; }).join(', ') + ')');
    var lotStill = praiseAlerts.filter(function (a) { return a.id === 'emerging_unit:lot:NG-0426-B'; })[0];
    assert(lotStill && lotStill.severity !== 'info', 'the negative lot ramp keeps its warning/critical severity next to the praise ramp');
    AL.reset();
  }

  /* ---- 4. sla_breach wording ---- */
  var sla = alerts.filter(function (a) { return a.ruleId === 'sla_breach'; })[0];
  assert(sla && sla.n === 3 && /^3 open records past first-response SLA$/.test(sla.title), 'sla_breach title states the count');
  if (sla) {
    assert(/^3 open records with no first response past SLA, 1 of them P0\/P1 and 2 unassigned; oldest waiting 9\.\d+d \(n = 3\)\.$/.test(sla.detail), 'sla_breach detail: count, P0/P1 count, unassigned, oldest age, n — ' + sla.detail);
    assert(sla.severity === 'critical' && sla.extra && sla.extra.oldestHours > 9 * 24 && sla.extra.urgent === 1 && sla.extra.unassigned === 2, 'sla_breach critical when a P0/P1 is past SLA, exposes extra.oldestHours/urgent/unassigned');
  }

  /* ---- 5. sentiment drift goes through the predict gate (byWeek is the fallback when no records are given) ---- */
  function derivedWeeks(byWeek) { return { now: nowD, records: [], byWeek: byWeek, regulatory: { openSerious: [], openFoodSafety: [], deadlines: [] } }; }
  function driftOnly(list) { return list.filter(function (a) { return a.ruleId === 'sentiment_drift'; }); }
  var drift = driftOnly(AL.evaluate(derivedWeeks(weekly(12, 30, -1.5)), { predict: VOC.predict }))[0];
  assert(drift && /\(n = 12 weeks, 360 records\)/.test(drift.detail) && drift.severity === 'critical', 'drift alert on 12 solid weeks sliding 1.5 pts/week carries weeks and records: ' + (drift && drift.detail));
  assert(drift && /about \d+ pts in 12 weeks, likely \d+–\d+ \(80% band\)/.test(drift.detail) && drift.extra && drift.extra.projectedLo <= drift.extra.projected && drift.extra.projected <= drift.extra.projectedHi,
    'the "likely" range is the OLS 80% prediction interval around the projection, not ±30% of the change: ' + (drift && drift.detail));
  var few = driftOnly(AL.evaluate(derivedWeeks(weekly(9, 30, -1.5).slice(0, 5)), { predict: VOC.predict }));
  assert(few.length === 0, 'five weeks of slide → no drift alert (too few weeks)');
  var thinW = driftOnly(AL.evaluate(derivedWeeks(weekly(12, 2, -1.5)), { predict: VOC.predict }));
  assert(thinW.length === 0, 'twelve weeks with n = 2 each → no drift alert (thin weeks)');
  var flatW = driftOnly(AL.evaluate(derivedWeeks(weekly(12, 30, 0)), { predict: VOC.predict }));
  assert(flatW.length === 0, 'flat weeks → no drift alert');
  // with records, drift is measured on the last 12 ISO weeks of allRecords, overall and per category: a slide inside
  // taste_quality (4 records a week, index 70 → 25) raises its own alert while 42 flat records a week keep the overall index level
  var driftRecs = [];
  for (var w = 0; w < 12; w++) {
    var wkKey = u.weekKey(u.addDays(TODAY, -7 * (11 - w)) + 'T18:00:00Z'), ws = u.weekStart(wkKey);
    for (var q = 0; q < 42; q++) driftRecs.push(rec('flat_' + w + '_' + q, u.addDays(ws, q % 3), { sentiment: q < 14 ? -0.5 : 0.5, category: q < 14 ? 'shipping_fulfillment' : 'praise', subcategory: q < 14 ? 'late' : 'general_praise' }));
    var idx = 70 - 45 * w / 11, sent = idx / 50 - 1;
    for (var t = 0; t < 4; t++) driftRecs.push(rec('taste_' + w + '_' + t, u.addDays(ws, t % 3), { sentiment: sent, category: 'taste_quality', subcategory: 'taste', label: sent < -0.15 ? 'negative' : sent > 0.15 ? 'positive' : 'neutral' }));
  }
  var catDrift = driftOnly(AL.evaluate({ now: nowD, records: driftRecs, allRecords: driftRecs, byDay: [], byWeek: [], regulatory: { openSerious: [], openFoodSafety: [], deadlines: [] } }, { predict: VOC.predict }));
  var taste = catDrift.filter(function (a) { return a.extra && a.extra.unit === 'taste_quality'; })[0];
  assert(taste && taste.drill && taste.drill.view === 'trends' && taste.drill.filters.category && taste.drill.filters.category[0] === 'taste_quality' && / in /.test(taste.title) && /\(n = 12 weeks, 48 records\)/.test(taste.detail),
    'a category-level slide raises its own drift alert that drills to the category: ' + (taste && taste.title));
  assert(!catDrift.some(function (a) { return a.extra && a.extra.unit === 'all'; }), 'the flat overall index raises no drift alert (per-category drift is not averaged away, nor invented overall)');
  assert(taste && taste.id === 'sentiment_drift:taste_quality:' + u.weekKey(TODAY + 'T18:00:00Z'), 'drift alert ids carry the unit and the last week');

  /* ---- 6. rules, ack/snooze ---- */
  var rules = AL.rules();
  assert(rules.length === 8 && rules.every(function (r) { return typeof r.enabled === 'boolean' && typeof r.threshold === 'number'; }), 'eight rules with enabled/threshold');
  AL.setRule('sla_breach', { enabled: false });
  var noSla = AL.evaluate(derivedWith([]), { predict: VOC.predict });
  assert(!noSla.some(function (a) { return a.ruleId === 'sla_breach'; }), 'disabling a rule removes its alerts');
  AL.setRule('sla_breach', { enabled: true });
  var again = AL.evaluate(derivedWith([]), { predict: VOC.predict });
  var first = again[0];
  AL.ack(first.id);
  assert(AL.active().every(function (a) { return a.id !== first.id; }), 'ack hides an alert from active()');
  AL.reset();

  console.log((total - failures) + '/' + total + ' alert assertions passed');
  if (failures) throw new Error('test_alerts: ' + failures + ' failure(s)');
})();
