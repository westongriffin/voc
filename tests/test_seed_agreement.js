/* tests/test_seed_agreement.js — the generated seed (js/data.js) against the real classifier and detectors (SPEC §6, §11).
 * Run under tests/run.sh (PURE modules loaded first) or:
 *   jsc tests/_jsc_shim.js js/util.js js/lexicon.js js/rules.js js/classify.js js/data.js js/store.js js/analytics.js \
 *       js/predict.js js/alerts.js tests/test_seed_agreement.js
 * Asserts: record count and date range; open serious-AE / food-safety records only inside the 14-day window before as_of;
 * backlog realism (40–70 open-state records concentrated in the last 21 days, 8–25 past first-response SLA, oldest open
 * ≤ 60 days with ≤ 3 older than 45 days, older records resolved with received ≤ first_response ≤ resolved ≤ as_of);
 * category / sentiment-band / product agreement between the seed labels and VOC.classify; planted events (13) replayed by
 * VOC.predict.detectorBacktest with recall ≥ 0.8; the E7 taste sentiment drift alert at 2026-07-31; noise excluded from store.all().
 */
(function () {
  'use strict';
  var failures = 0, total = 0;
  function assert(cond, msg) {
    total += 1;
    if (cond) console.log('PASS ' + msg);
    else { failures += 1; console.log('FAIL ' + msg); }
  }
  function drain() { if (typeof drainMicrotasks === 'function') drainMicrotasks(); }
  function pct(x) { return (100 * x).toFixed(1) + '%'; }
  function count(arr, fn) { var n = 0; for (var i = 0; i < arr.length; i++) if (fn(arr[i])) n++; return n; }
  function every(arr, fn) { for (var i = 0; i < arr.length; i++) if (!fn(arr[i])) return false; return true; }
  function dayOf(iso) { return String(iso).slice(0, 10); }

  assert(typeof window.VOC_SEED === 'object' && window.VOC_SEED && Array.isArray(window.VOC_SEED.records), 'window.VOC_SEED loaded');
  assert(VOC.classify && typeof VOC.classify.scoreCategories === 'function' && typeof VOC.classify.detectProduct === 'function', 'VOC.classify loaded');
  assert(VOC.store && typeof VOC.store.init === 'function', 'VOC.store loaded');
  assert(VOC.predict && typeof VOC.predict.detectorBacktest === 'function' && typeof VOC.predict.sentimentDrift === 'function', 'VOC.predict loaded');

  var seed = window.VOC_SEED, meta = seed.meta, recs = seed.records, C = VOC.classify;
  var AS_OF = meta.as_of, asOfMs = Date.parse(AS_OF), DAY = 86400000;
  var live = recs.filter(function (r) { return !r.is_noise; });
  var en = live.filter(function (r) { return r.language === 'en'; });

  /* ---------- 1. size and range ---------- */
  assert(recs.length >= 1000 && recs.length <= 1060, 'record count in 1000..1060 (' + recs.length + ')');
  assert(meta.as_of === '2026-09-16T23:59:00Z' && meta.range[0] === '2025-09-15' && meta.range[1] === '2026-09-16', 'meta as_of / range');
  assert(dayOf(recs[0].received_at) === '2025-09-15' && dayOf(recs[recs.length - 1].received_at) === '2026-09-16', 'records span 2025-09-15 → 2026-09-16');
  assert(every(recs, function (r) { return r.received_at <= AS_OF && r.received_at >= '2025-09-15'; }), 'every record inside the range and not newer than as_of');
  assert(JSON.stringify(seed).length <= 2.5 * 1024 * 1024, 'serialized seed ≤ 2.5 MB (' + JSON.stringify(seed).length + ' chars)');

  /* ---------- 2. regulatory realism ---------- */
  var OPEN = { new: 1, open: 1, pending: 1, reopened: 1, escalated: 1 };
  var regulatory = live.filter(function (r) { return r.serious_ae || r.food_safety; });
  var openReg = regulatory.filter(function (r) { return OPEN[r.status]; });
  var oldOpenReg = openReg.filter(function (r) { return asOfMs - Date.parse(r.received_at) > 14 * DAY; });
  assert(regulatory.length >= 20, 'seed carries serious-AE / food-safety records (' + regulatory.length + ')');
  assert(oldOpenReg.length === 0, 'every open serious-AE / food-safety record was received within 14 days of as_of (' + openReg.length + ' open, ' + oldOpenReg.length + ' stale)');
  assert(every(regulatory, function (r) { return OPEN[r.status] || (r.status === 'resolved' && r.resolved_at !== null && r.resolved_at <= AS_OF); }), 'older regulatory records are resolved with resolved_at set');
  var serious = live.filter(function (r) { return r.serious_ae; });
  var recentSerious = serious.filter(function (r) { return r.received_at >= '2026-09-02'; });
  assert(serious.length === 6, 'E10: six serious AEs (' + serious.length + ')');
  assert(recentSerious.length === 2 && every(recentSerious, function (r) { return r.status === 'escalated' && r.urgency === 'P0'; }), 'E10: the two recent serious AEs stay escalated (live MedWatch clocks)');
  assert(every(serious.filter(function (r) { return r.received_at < '2026-09-02'; }), function (r) { return r.status === 'resolved'; }), 'E10: older serious AEs are resolved');
  var rfr = openReg.filter(function (r) { return r.food_safety && !r.serious_ae; });
  assert(rfr.length === 1, 'exactly one open food-safety record (' + rfr.length + ')');
  if (rfr.length === 1) {
    var f = rfr[0];
    assert(asOfMs - Date.parse(f.received_at) <= 48 * 3600000, 'open food-safety record received within 48h of as_of (' + f.received_at + ')');
    assert(f.lot_number === 'NG-0826-C' && f.product === 'prolon_nextgen' && f.urgency === 'P0' && f.category === 'foreign_material_allergen' && f.product_class === 'conventional_food', 'open food-safety record: Next Gen soup, lot NG-0826-C, P0, foreign material (24h RFR clock)');
    assert(/NG-0826-C/.test(f.text), 'open food-safety record names its lot in the body');
  }

  /* ---------- 2b. backlog realism (SPEC §6): what the Briefing alert and the Inbox tiles show against the demo clock ---------- */
  var SLA = { P0: 1, P1: 4, P2: 24, P3: 72 };   // Settings.sla defaults (SPEC §4.5)
  function ageH(r) { return (asOfMs - Date.parse(r.received_at)) / 3600000; }
  var openAll = live.filter(function (r) { return OPEN[r.status]; });
  var breached = openAll.filter(function (r) { return r.first_response_at === null && ageH(r) > SLA[r.urgency]; });
  var oldestOpenDays = openAll.reduce(function (m, r) { return Math.max(m, ageH(r)); }, 0) / 24;
  var openOver45 = count(openAll, function (r) { return ageH(r) > 45 * 24; });
  var openRecent = count(openAll, function (r) { return ageH(r) <= 21 * 24; });
  var aging48 = count(openAll, function (r) { return ageH(r) > 48; });
  assert(openAll.length >= 40 && openAll.length <= 70, 'open-state records (new/open/pending/reopened/escalated) in 40..70 (' + openAll.length + ')');
  assert(breached.length >= 8 && breached.length <= 25, 'open records past first-response SLA in 8..25 (' + breached.length + ')');
  assert(oldestOpenDays <= 60, 'oldest open record ≤ 60 days (' + oldestOpenDays.toFixed(1) + 'd)');
  assert(openOver45 <= 3, 'at most 3 open records older than 45 days (' + openOver45 + ')');
  assert(openRecent >= openAll.length / 2, 'open records concentrated in the last 21 days (' + openRecent + '/' + openAll.length + ')');
  assert(aging48 >= 20, 'Aging > 48h tile is non-trivial (' + aging48 + ' open records older than 48h)');
  assert(every(live.filter(function (r) { return ageH(r) > 60 * 24; }), function (r) { return r.status === 'resolved'; }), 'every live record older than 60 days is resolved');
  var resolvedRecs = live.filter(function (r) { return r.status === 'resolved'; });
  assert(every(resolvedRecs, function (r) {
    return r.resolved_at !== null && r.resolved_at <= AS_OF && r.resolved_at >= r.received_at &&
      (r.first_response_at === null || (r.first_response_at >= r.received_at && r.first_response_at <= r.resolved_at));
  }), 'resolved records keep received ≤ first_response ≤ resolved ≤ as_of (n=' + resolvedRecs.length + ')');
  assert(every(live.filter(function (r) { return r.status === 'new' || r.status === 'open'; }), function (r) { return r.first_response_at === null && r.resolved_at === null; }), 'new/open records carry no first response or resolution');
  var resolvedShare = resolvedRecs.length / live.length;
  assert(resolvedShare >= 0.85 && resolvedShare <= 0.97, 'resolved share of live records 85–97% (' + pct(resolvedShare) + ')');
  var frtNullShare = count(resolvedRecs, function (r) { return r.first_response_at === null; }) / resolvedRecs.length;
  assert(frtNullShare >= 0.05 && frtNullShare <= 0.20, 'resolved records with no first response 5–20% (' + pct(frtNullShare) + ')');

  /* ---------- 3. classifier agreement ---------- */
  var catOk = 0, sentOk = 0, prodOk = 0, mentioned = 0, nonGeneral = 0;
  live.forEach(function (r) {
    var cats = C.scoreCategories(r.text, r.subject);
    if (cats.category === r.category) catOk++;
    var p = C.detectProduct(r.text, r.subject);
    if (p.product === r.product) prodOk++;
    if (r.product !== 'general') { nonGeneral++; if (p.product === r.product) mentioned++; }
  });
  en.forEach(function (r) {
    var c = C.scoreSentiment(r.text).compound;
    var label = c >= 0.15 ? 'positive' : c <= -0.15 ? 'negative' : 'neutral';
    if (label === r.sentiment_label) sentOk++;
  });
  var catAgree = catOk / live.length, sentAgree = sentOk / en.length, prodAgree = prodOk / live.length, mentionRate = mentioned / nonGeneral;
  assert(catAgree >= 0.85, 'category agreement ≥ 85% (' + pct(catAgree) + ', n=' + live.length + ')');
  assert(sentAgree >= 0.85, 'sentiment-band agreement ≥ 85% on English records (' + pct(sentAgree) + ', n=' + en.length + ')');
  assert(prodAgree >= 0.70, 'product agreement ≥ 70% (' + pct(prodAgree) + ')');
  assert(mentionRate >= 0.80, 'detectProduct names the labelled product on ≥ 80% of non-general records (' + pct(mentionRate) + ')');
  assert(every(live, function (r) { return r.text.indexOf('{') < 0 && r.subject.indexOf('{') < 0; }), 'no unfilled template slots');

  /* ---------- 4. sentiment mix (seed bands, English) ---------- */
  function posShare(channel) {
    var pool = en.filter(function (r) { return r.channel === channel; });
    return { n: pool.length, pos: count(pool, function (r) { return r.sentiment_label === 'positive'; }) / Math.max(1, pool.length) };
  }
  ['amazon_review', 'trustpilot_review', 'survey'].forEach(function (ch) {
    var s = posShare(ch);
    assert(s.n >= 20 && s.pos >= 0.60, ch + ' ≥ 60% positive band (' + pct(s.pos) + ', n=' + s.n + ')');
  });
  var negShare = count(en, function (r) { return r.sentiment_label === 'negative'; }) / en.length;
  var posShareAll = count(en, function (r) { return r.sentiment_label === 'positive'; }) / en.length;
  assert(negShare <= 0.45, 'overall negative band ≤ 45% (' + pct(negShare) + ')');
  assert(posShareAll >= 0.54 && posShareAll <= 0.66 && negShare >= 0.22 && negShare <= 0.34, 'SPEC §6 band mix: positive 54–66%, negative 22–34% (' + pct(posShareAll) + ' / ' + pct(negShare) + ', n=' + en.length + ')');
  var scored = live.filter(function (r) { return typeof r.nps === 'number'; });
  var nps12 = 100 * (count(scored, function (r) { return r.nps >= 9; }) - count(scored, function (r) { return r.nps <= 6; })) / Math.max(1, scored.length);
  assert(scored.length >= 100 && nps12 >= 25 && nps12 <= 55, '12-month seed NPS between 25 and 55 (' + nps12.toFixed(1) + ', n=' + scored.length + ')');
  assert(every(live, function (r) { return !/\.\. /.test(r.text) && !/shaker/i.test(r.text); }), 'no double periods or shaker in any body');
  assert(every(live.filter(function (r) { return ['fast_bar', 'fasting_shake', 'l_protein', 'l_pill'].indexOf(r.product) >= 0 && r.language === 'en'; }), function (r) {
    return !/\bsoups?\b|\bl-drink\b|\bolives?\b|\bday [2-6]\b|five days/i.test(r.text);
  }), 'bar, shake, protein and L-Pill records never talk about soups, the L-Drink, olives or day 2–6');
  assert(every(live.filter(function (r) { return r.product === 'prolon_nextgen' && r.language === 'en'; }), function (r) { return !/powder|dissolve/i.test(r.text); }), 'Next Gen (ready-to-eat) records never talk about powder');
  assert(every(live, function (r) { return !r.hcp_code || /^HCP-[A-Z0-9]{5}$/.test(r.hcp_code); }), 'practitioner codes are HCP-XXXXX');

  /* ---------- 5. planted events ---------- */
  assert(Array.isArray(meta.planted_events) && meta.planted_events.length === 13, 'planted_events has 13 entries');
  assert(meta.planted_events.map(function (e) { return e.id; }).join(',') === 'E1,E2,E3,E4,E5,E6,E7,E8,E9,E10,E11,E12,E13', 'planted event ids E1..E13');
  assert(every(meta.planted_events, function (e) { return e.id && e.from && e.to && e.title && e.detector && e.expected && typeof e.expected === 'object'; }), 'every planted event has id/from/to/title/detector/expected');

  /* ---------- 6. store-derived records: noise exclusion, detector replay, E7 drift ---------- */
  var initDone = false, initErr = null;
  VOC.store.init({ seed: seed }).then(function () { initDone = true; }, function (e) { initErr = e; });
  drain();
  assert(initDone && !initErr, 'store.init resolves under jsc' + (initErr ? ' (' + (initErr && initErr.message) + ')' : ''));
  if (!initDone) { console.log(initErr && initErr.stack); throw new Error('store.init did not resolve'); }
  var all = VOC.store.all();
  var noiseCount = count(recs, function (r) { return r.is_noise; });
  assert(all.length === recs.length - noiseCount && count(all, function (r) { return r.is_noise || r.status === 'closed_noise'; }) === 0, 'store.all() excludes the ' + noiseCount + ' noise records (' + all.length + ' live)');
  assert(noiseCount === 11, 'E12: 11 noise records in the seed');

  var cm = typeof VOC.store.churnModel === 'function' ? VOC.store.churnModel() : null;
  assert(cm && cm.method === 'fitted' && typeof cm.auc === 'number' && cm.auc >= 0.65, 'churn model fits the seed: cancellations follow recent signals, so the cross-validated AUC clears the 0.65 gate (' + (cm ? cm.method + ', AUC ' + cm.auc + ', n=' + cm.nLabelled : 'no model') + ')');

  var bt = VOC.predict.detectorBacktest(all, meta.planted_events, { now: AS_OF });
  var byId = {};
  bt.rows.forEach(function (row) { byId[row.id] = row; });
  assert(typeof bt.recall === 'number' && bt.recall >= 0.8, 'detectorBacktest recall ≥ 0.8 (' + bt.recall + ', ' + bt.detected + '/' + bt.evaluated + ')');
  ['E3', 'E5', 'E6', 'E7', 'E8'].forEach(function (id) {
    assert(byId[id] && byId[id].detected === true, id + ' detected on replay' + (byId[id] ? ' — ' + byId[id].detail : ''));
  });

  // E7: weekly taste_quality sentiment index over the 12 weeks ending 2026-07-31 must trip the drift alert.
  var TO = '2026-07-31', FROM = '2026-05-09';
  var byWeek = {};
  all.forEach(function (r) {
    if (r.category !== 'taste_quality' || r.sentiment_label === 'unscored' || typeof r.sentiment_index !== 'number') return;
    if (r.day_key < FROM || r.day_key > TO) return;
    (byWeek[r.week_key] = byWeek[r.week_key] || []).push(r.sentiment_index);
  });
  var weekly = Object.keys(byWeek).sort().map(function (k) {
    var v = byWeek[k]; return { key: k, value: v.reduce(function (a, b) { return a + b; }, 0) / v.length, n: v.length };
  });
  var drift = VOC.predict.sentimentDrift(weekly, { weeks: 12, now: TO + 'T23:59:59Z' });
  assert(weekly.length >= 8, 'E7: at least 8 weekly taste_quality points before 2026-07-31 (' + weekly.length + ')');
  assert(drift.alert === true && drift.change12w < -5, 'E7: sentimentDrift alert at 2026-07-31 (slope ' + drift.slope + ' pts/week, 12-week change ' + drift.change12w + ')');

  console.log('metrics: n=' + live.length + ' category=' + catAgree.toFixed(3) + ' sentiment=' + sentAgree.toFixed(3) + ' product=' + prodAgree.toFixed(3) +
    ' mention=' + mentionRate.toFixed(3) + ' recall=' + bt.recall + ' negShare=' + negShare.toFixed(3) + ' openRegulatory=' + openReg.length +
    ' open=' + openAll.length + ' slaBreached=' + breached.length + ' oldestOpenDays=' + oldestOpenDays.toFixed(1));
  console.log((total - failures) + '/' + total + ' seed agreement assertions passed');
  if (failures) throw new Error('test_seed_agreement: ' + failures + ' failure(s)');
})();
