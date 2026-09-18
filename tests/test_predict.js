/* tests/test_predict.js — assertions for VOC.predict under jsc (synthetic data via VOC.util.rng). */
(function () {
  'use strict';
  let failures = 0, passes = 0;
  function assert(cond, msg) {
    if (cond) { passes++; console.log('PASS ' + msg); }
    else { failures++; console.log('FAIL ' + msg); }
  }
  function near(a, b, tol) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function hasNoNaN(obj, path) {
    path = path || 'result';
    if (typeof obj === 'number') { if (Number.isNaN(obj)) { console.log('  NaN at ' + path); return false; } return true; }
    if (Array.isArray(obj)) return obj.every((v, i) => hasNoNaN(v, path + '[' + i + ']'));
    if (obj && typeof obj === 'object' && !(obj instanceof Date)) return Object.keys(obj).every(k => hasNoNaN(obj[k], path + '.' + k));
    return true;
  }
  const P = VOC.predict;
  assert(P && typeof P.forecastVolume === 'function', 'VOC.predict loads under jsc');

  /* ---------- synthetic helpers (VOC.util.rng when present) ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const U = VOC.util || {};
  const rng = typeof U.rng === 'function' ? U.rng(20260917) : mulberry32(20260917);
  const randNormal = typeof U.randNormal === 'function' ? U.randNormal : function (r, mu, sd) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const poisson = typeof U.poisson === 'function' ? U.poisson : function (r, lambda) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= r(); } while (p > L);
    return k - 1;
  };
  const AS_OF = '2026-09-16T23:59:00Z';
  const AS_OF_DAY = '2026-09-16';
  function dayMs(k) { const p = k.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(k, n) { return new Date(dayMs(k) + n * 86400000).toISOString().slice(0, 10); }
  function dow(k) { return (new Date(dayMs(k)).getUTCDay() + 6) % 7; }
  const DOW_FACTOR = [1.35, 1.25, 1.05, 1.0, 0.9, 0.55, 0.6];
  const CATS = ['subscription_billing', 'shipping_fulfillment', 'taste_quality', 'praise', 'usage_guidance', 'price_value', 'side_effects', 'customer_service'];
  const PRODUCTS = ['prolon_5day', 'prolon_nextgen', 'fast_bar', 'l_pill'];
  let recCounter = 0;
  function makeRecord(day, over) {
    recCounter++;
    const hour = 9 + Math.floor(rng() * 10);
    const sentiment = over && typeof over.sentiment === 'number' ? over.sentiment : randNormal(rng, 0.1, 0.5);
    const rec = Object.assign({
      id: 'r_' + String(recCounter).padStart(6, '0'), received_at: day + 'T' + String(hour + 5).padStart(2, '0') + ':15:00Z',
      subject: 'About my order', text: 'I have a question about my ProLon kit and delivery timing.',
      category: CATS[Math.floor(rng() * CATS.length)], subcategory: 'general_question', product: PRODUCTS[Math.floor(rng() * PRODUCTS.length)],
      kit_component: null, lot_number: null, sentiment, sentiment_label: sentiment <= -0.15 ? 'negative' : sentiment >= 0.15 ? 'positive' : 'neutral',
      urgency: 'P2', status: 'resolved', first_response_at: null, resolved_at: null, nps: null, csat: null, customer_id: 'c_' + Math.floor(rng() * 300),
      channel: 'email', segment: 'repeat', cancel_intent: false, is_noise: false, is_adverse_event: false, serious_ae: false, food_safety: false, restricted: false
    }, over || {});
    return rec;
  }

  /* ---------- 1. Holt-Winters recovers a weekly pattern with trend ---------- */
  (function () {
    const days = 140;
    const start = addDays(AS_OF_DAY, -(days - 1));
    const series = [];
    for (let t = 0; t < days; t++) {
      const key = addDays(start, t);
      const level = (18 + 0.06 * t) * DOW_FACTOR[dow(key)];
      series.push({ key, value: Math.max(0, Math.round(level + randNormal(rng, 0, 1.5))) });
    }
    const train = series.slice(0, days - 7), held = series.slice(days - 7);
    const fc = P.forecastVolume(train, { horizon: 7, now: AS_OF });
    assert(fc.method === 'holt_winters', 'forecastVolume picks holt_winters for 133 days (got ' + fc.method + ')');
    assert(fc.forecast.length === 7 && fc.history.length === train.length, 'forecast has horizon points and history has fitted values');
    const mape = held.reduce((s, p, i) => s + Math.abs(p.value - fc.forecast[i].value) / Math.max(p.value, 1), 0) / 7;
    assert(mape < 0.20, 'held-out week MAPE < 20% (got ' + (mape * 100).toFixed(1) + '%)');
    assert(fc.forecast[0].key === held[0].key, 'forecast keys continue the calendar (' + fc.forecast[0].key + ')');
    assert(fc.forecast.every(f => f.lo95 <= f.lo80 && f.lo80 <= f.value && f.value <= f.hi80 && f.hi80 <= f.hi95), 'bands nest lo95 ≤ lo80 ≤ value ≤ hi80 ≤ hi95');
    const full = P.forecastVolume(series, { horizon: 28, now: AS_OF });
    assert(full.backtest.folds.length === 4, 'backtest has 4 folds');
    assert(full.backtest.coverage80 >= 0.5 && full.backtest.coverage80 <= 1, 'coverage80 between 0.5 and 1 (got ' + full.backtest.coverage80 + ')');
    assert(typeof full.backtest.mase === 'number' && full.backtest.mase < 1.5, 'MASE vs seasonal naive is finite and < 1.5 (got ' + full.backtest.mase + ')');
    assert(full.weekly.length >= 4 && near(full.weekly.reduce((s, w) => s + w.value, 0), full.forecast.reduce((s, f) => s + f.value, 0), 0.5), 'weekly blocks sum to the daily forecast');
    assert(['high', 'medium', 'low'].indexOf(full.confidence) >= 0 && full.explanation.indexOf('n=') >= 0 && !/\bwill\b/i.test(full.explanation), 'forecast explanation carries n and avoids "will"');
    assert(hasNoNaN(full), 'forecastVolume output has no NaN');
    const tuned = P.forecastVolume(series, { horizon: 7, autoTune: true, now: AS_OF });
    assert(tuned.params.tuned === true && tuned.forecast.length === 7, 'autoTune runs the grid and still forecasts');
    assert(tuned.params.backtestTuning === 'per fold on training days' && full.params.backtestTuning === 'none' && full.params.backtestMethod === 'holt_winters', 'backtest re-tunes inside each fold on training days only, and reports it');
    // 70 days: the result is holt_winters, and every fold (train 42–63 days) is fitted with holt_winters too instead of drifting to Holt/OLS
    const seventy = P.forecastVolume(series.slice(-70), { horizon: 7, now: AS_OF });
    assert(seventy.method === 'holt_winters' && seventy.params.backtestMethod === 'holt_winters' && seventy.backtest.folds.length === 4, 'folds use the reported method (70-day series)');
  })();

  /* ---------- 2. fallback methods for short series ---------- */
  (function () {
    const mk = n => Array.from({ length: n }, (_, t) => ({ key: addDays('2026-08-01', t), value: 10 + t * 0.2 }));
    assert(P.forecastVolume(mk(40), { now: AS_OF }).method === 'holt_linear', '40 days → holt_linear');
    assert(P.forecastVolume(mk(20), { now: AS_OF }).method === 'ols', '20 days → ols');
    assert(P.forecastVolume(mk(5), { now: AS_OF }).method === 'mean', '5 days → mean');
    const empty = P.forecastVolume([], { now: AS_OF });
    assert(empty.n === 0 && empty.forecast.length === 0 && empty.confidence === 'low', 'empty series → n=0, no forecast, low confidence');
    const ols = P.forecastVolume(mk(20), { now: AS_OF });
    assert(near(ols.forecast[0].value, 10 + 20 * 0.2, 1e-6), 'ols forecast continues the line exactly');
    assert(hasNoNaN(P.forecastVolume(mk(3), { now: AS_OF })), 'tiny series output has no NaN');
  })();

  /* ---------- 3. anomaly detector flags an injected ×3 spike ---------- */
  (function () {
    const days = 90;
    const start = addDays(AS_OF_DAY, -(days - 1));
    const series = [];
    for (let t = 0; t < days; t++) {
      const key = addDays(start, t);
      series.push({ key, value: poisson(rng, 12 * DOW_FACTOR[dow(key)]) });
    }
    const spikeKey = series[70].key;
    series[70].value = Math.round(series[70].value * 3) + 12;
    const res = P.detectAnomalies(series, { mode: 'count', now: AS_OF });
    const critical = res.events.filter(e => e.severity === 'critical');
    const spikeEvent = res.events.find(e => e.start <= spikeKey && e.end >= spikeKey);
    const others = res.events.filter(e => e !== spikeEvent);
    assert(spikeEvent && spikeEvent.severity === 'critical' && spikeEvent.z >= 8, 'injected ×3 spike day is a critical event with z ≥ 8 (z ' + (spikeEvent && spikeEvent.z) + ')');
    assert(others.every(e => Math.abs(e.z) < 5) && critical.length <= 2, 'ordinary days never approach the spike (max other z ' + (others.length ? Math.max(...others.map(e => Math.abs(e.z))) : 0) + ')');
    assert(res.events.length <= 6, 'ordinary days produce few events (' + others.length + ' besides the spike)');
    const spikePoint = res.points.find(p => p.key === spikeKey);
    assert(spikePoint.z >= 3 && spikePoint.expected > 0 && spikePoint.hi > spikePoint.lo, 'spike point has z ≥ 3 with a sensible band');
    assert(res.points.slice(0, 14).every(p => p.z === null) && res.points[14].z !== null, 'first 14 days have no baseline (two full weeks for weekday factors); day 15 does');
    assert(res.params.dowAdjust === true && res.params.window === 28, 'params report window 28 with weekday adjustment');
    assert(hasNoNaN(res) && res.explanation.indexOf('n=') >= 0, 'anomaly output has no NaN and explanation carries n');
    // share mode with n
    const share = series.map(p => ({ key: p.key, value: 0.2 + randNormal(rng, 0, 0.03), n: p.value }));
    share[80].value = 0.7;
    const sres = P.detectAnomalies(share, { mode: 'share', now: AS_OF });
    assert(sres.events.some(e => e.start <= share[80].key && e.end >= share[80].key), 'share mode flags a jump from 20% to 70%');
    // masked days: a day with no scored records (value null / n 0) is neither scored nor part of the baseline
    const sparse = Array.from({ length: 60 }, (_, t) => { const key = addDays(addDays(AS_OF_DAY, -59), t); const thin = t % 10 < 7; return { key, value: thin ? null : 0.25 + randNormal(rng, 0, 0.02), n: thin ? 0 : 20 }; });
    const sparseRes = P.detectAnomalies(sparse, { mode: 'share', dowAdjust: false, now: AS_OF });
    const scoredPts = sparseRes.points.filter(p => p.z !== null);
    assert(sparseRes.points.filter(p => p.value === null).length === 42 && sparseRes.points.filter(p => p.value === null).every(p => p.z === null), 'days with n = 0 are masked (value null, unscored)');
    assert(scoredPts.length > 0 && scoredPts.every(p => p.expected > 0.2 && p.expected < 0.3) && sparseRes.events.length === 0, 'the baseline is the mean of observed days only, not dragged toward 0 by masked days (n=' + scoredPts.length + ' scored)');
    assert(hasNoNaN(sparseRes), 'masked series output has no NaN');
    // weekly series
    const weekly = Array.from({ length: 16 }, (_, i) => ({ key: '2026-W' + String(20 + i).padStart(2, '0'), value: 60 + Math.round(randNormal(rng, 0, 4)) }));
    weekly[14].value = 170;
    const wres = P.detectAnomalies(weekly, { mode: 'count', now: AS_OF });
    assert(wres.params.granularity === 'week' && wres.events.some(e => e.start === '2026-W34' && e.severity === 'critical'), 'weekly series scored without DOW adjustment and flags the spike week');
    // merge consecutive days
    const merged = series.map(p => ({ key: p.key, value: p.value }));
    merged[50].value = 60; merged[51].value = 62;
    const mres = P.detectAnomalies(merged, { mode: 'count', now: AS_OF });
    const ev = mres.events.find(e => e.start === merged[50].key);
    assert(ev && ev.end === merged[51].key && ev.days === 2, 'consecutive anomalous days merge into one event');
  })();

  /* ---------- 4. emerging: ramp → emerging/new, stable → stable, bigram → new ---------- */
  (function () {
    const recs = [];
    const start = addDays(AS_OF_DAY, -34);
    for (let t = 0; t < 35; t++) {
      const day = addDays(start, t);
      const recent = t >= 28;
      for (let i = 0; i < 3; i++) recs.push(makeRecord(day, { category: 'praise', subcategory: 'general_praise', product: 'prolon_5day', sentiment: 0.6, text: 'Loved the program, energy on day four was great.' }));
      const shipN = recent ? 6 : (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < shipN; i++) recs.push(makeRecord(day, { category: 'shipping_fulfillment', subcategory: 'late', product: 'fast_bar', text: 'My package is late and tracking has not moved.' }));
      if (recent) {
        recs.push(makeRecord(day, { category: 'subscription_billing', subcategory: 'duplicate_charge', product: 'subscription_account', text: 'I was charged twice for the same order this month.' }));
        if (t >= 31) recs.push(makeRecord(day, { category: 'foreign_material_allergen', subcategory: 'hard_bits', product: 'prolon_nextgen', kit_component: 'soup_minestrone_quinoa', lot_number: 'NG-0426-B', text: 'Found hard bits in the minestrone quinoa soup.' }));
      }
    }
    const res = P.detectEmerging(recs, { asOf: AS_OF });
    const byUnit = (unit, value) => res.rows.find(r => r.unit === unit && r.value === value);
    const ship = byUnit('category', 'shipping_fulfillment');
    assert(ship && (ship.status === 'emerging' || ship.status === 'new'), 'ramping category flagged ' + (ship && ship.status));
    // SPEC §8: E = cB·NR/NB. praise holds 3 records a day while shipping, billing and hard-bits surge, so its SHARE of voice
    // collapses: expected ≈ cB × (recent volume / baseline volume) sits far above its 21 recent mentions → fading, lift < 1.
    const praise = byUnit('category', 'praise');
    assert(praise && praise.status === 'fading' && praise.lift < 1 && near(praise.expected, praise.cB * res.nRecent / res.nBase, 0.01), 'expected = cB·NR/NB: a flat unit fades when its share of voice collapses (z ' + (praise && praise.z) + ', lift ' + (praise && praise.lift) + ')');
    // a pure volume surge (every recent record duplicated, shares unchanged) leaves every unit's lift where it was
    const recentStart = addDays(AS_OF_DAY, -6);
    const doubled = recs.concat(recs.filter(r => r.received_at.slice(0, 10) >= recentStart).map((r, i) => Object.assign({}, r, { id: r.id + '_dup' + i })));
    const res2 = P.detectEmerging(doubled, { asOf: AS_OF });
    const liftDrift = res.rows.filter(r => r.lift !== null).map(r => { const m = res2.rows.find(x => x.unit === r.unit && x.value === r.value); return m && m.lift !== null ? Math.abs(m.lift - r.lift) : 0; });
    assert(res2.nRecent === 2 * res.nRecent && liftDrift.every(d => d < 0.02), 'doubling recent volume with unchanged shares leaves lifts unchanged (max drift ' + Math.max(...liftDrift).toFixed(3) + ')');
    assert(/E = cB · NR \/ NB/.test(res.params.expectedRule), 'params name the expected rule');
    const dup = byUnit('subcategory', 'subscription_billing/duplicate_charge');
    assert(dup && dup.status === 'new' && dup.cB === 0 && dup.cR === 7, 'subcategory with no baseline and 7 recent mentions is new');
    const lot = byUnit('lot', 'NG-0426-B');
    assert(lot && lot.status === 'new' && lot.sampleIds.length >= 1 && lot.sampleIds.length <= 5, 'lot unit flagged new with sample ids');
    const comp = byUnit('kit_component', 'soup_minestrone_quinoa');
    assert(comp && comp.status === 'new', 'kit component flagged new');
    const bigram = res.rows.find(r => r.unit === 'bigram' && r.value === 'charged twice');
    assert(bigram && (bigram.status === 'new' || bigram.status === 'emerging'), 'bigram "charged twice" surfaces as new/emerging');
    assert(res.rows.every(r => r.cR >= 3 || r.status === 'fading'), 'min recent support respected');
    assert(res.nRecent > 0 && res.nBase > 0 && res.params.recentTo === AS_OF_DAY && hasNoNaN(res), 'emerging params/asOf consistent and no NaN');
    const neg = P.detectEmerging(recs, { asOf: AS_OF, negativeOnly: true, units: ['category'] });
    assert(neg.rows.every(r => r.unit === 'category') && !neg.rows.some(r => r.value === 'praise'), 'negativeOnly + units filter restricts rows');
    assert(P.detectEmerging([], { asOf: AS_OF }).n === 0, 'empty records → n=0');
    // fading: unit strong in baseline, absent recently
    const fadeRecs = recs.concat(Array.from({ length: 20 }, (_, i) => makeRecord(addDays(start, i % 28), { category: 'price_value', subcategory: 'too_expensive' })));
    const fres = P.detectEmerging(fadeRecs.filter(r => !(r.category === 'price_value' && r.received_at.slice(0, 10) >= addDays(AS_OF_DAY, -6))), { asOf: AS_OF, units: ['category'] });
    const fade = fres.rows.find(r => r.value === 'price_value');
    assert(fade && fade.status === 'fading', 'unit present in baseline and absent recently is fading');
  })();

  /* ---------- 5. churn: monotone in billing complaints, tiers correct ---------- */
  (function () {
    const customers = new Map();
    const recs = [];
    const mkCust = (id, status) => { customers.set(id, { customer_id: id, display_name: id, segment: 'subscriber', subscription_status: status, subscription_value_12m_usd: 1200 }); };
    mkCust('c_a', 'active'); mkCust('c_b', 'active'); mkCust('c_c', 'active'); mkCust('c_d', 'active');
    const recent = addDays(AS_OF_DAY, -10);
    // c_a: one positive record only; c_b: 1 billing complaint; c_c: 3 billing complaints; c_d: everything bad
    recs.push(makeRecord(recent, { customer_id: 'c_a', category: 'praise', sentiment: 0.6 }));
    recs.push(makeRecord(recent, { customer_id: 'c_b', category: 'subscription_billing', sentiment: -0.4 }));
    for (let i = 0; i < 3; i++) recs.push(makeRecord(addDays(recent, -i * 5), { customer_id: 'c_c', category: 'subscription_billing', sentiment: -0.4 }));
    for (let i = 0; i < 4; i++) recs.push(makeRecord(addDays(recent, -i * 3), { customer_id: 'c_d', category: 'subscription_billing', sentiment: -0.7, urgency: 'P1', cancel_intent: true, status: i < 2 ? 'open' : 'resolved' }));
    const a = P.churnRisk('c_a', recs, customers, { now: AS_OF });
    const b = P.churnRisk('c_b', recs, customers, { now: AS_OF });
    const c = P.churnRisk('c_c', recs, customers, { now: AS_OF });
    const d = P.churnRisk('c_d', recs, customers, { now: AS_OF });
    assert(a.score < b.score && b.score < c.score && c.score < d.score, 'churn score monotone: ' + [a.score, b.score, c.score, d.score].join(' < '));
    assert(a.tier === 'low' && a.method === 'heuristic', 'positive-only customer is low tier via heuristic');
    assert(d.tier === 'critical' && d.score >= 75, 'customer with billing + cancel intent + P1 + open tickets is critical (' + d.score + ')');
    assert(c.reasons.length >= 1 && c.reasons[0] === '3 billing complaints in 90 days', 'top reason phrased as short English ("' + c.reasons[0] + '")');
    assert(b.reasons.some(r => r === '1 billing complaint in 90 days'), 'singular reason phrasing');
    const tiers = [[10, 'low'], [24, 'low'], [25, 'watch'], [49, 'watch'], [50, 'high'], [74, 'high'], [75, 'critical'], [100, 'critical']];
    assert(tiers.every(([s, t]) => { const th = P.defaults.churn.tiers.find(([lo, hi]) => s >= lo && s <= hi); return th && th[2] === t; }), 'tier boundaries 0–24/25–49/50–74/75+');
    const none = P.churnRisk('c_zzz', recs, customers, { now: AS_OF });
    assert(none.n === 0 && none.score === 5 && none.tier === 'low' && none.reasons.length === 0, 'unknown customer → baseline score 5, n=0');
    assert(!/\bwill\b/i.test(d.explanation) && d.explanation.indexOf('n=') >= 0, 'churn explanation copy rules');
    // churnTable heuristic (only 4 labelled customers)
    const table = P.churnTable(recs, customers, { now: AS_OF, top: 10 });
    assert(table.method === 'heuristic' && table.rows.length === 4 && table.rows[0].customerId === 'c_d', 'churnTable ranks c_d first with heuristic method');
    assert(near(table.rows[0].revenueAtRisk, d.score / 100 * 1200, 15), 'revenueAtRisk = p × subscription value');
  })();

  /* ---------- 6. logistic fit reaches AUC > 0.8 on separable labels ---------- */
  (function () {
    const customers = new Map();
    const recs = [];
    for (let i = 0; i < 80; i++) {
      const id = 'c_l' + i;
      const churner = i % 2 === 0;
      customers.set(id, { customer_id: id, subscription_status: churner ? 'cancelled' : (i % 10 === 1 ? 'paused' : 'active'), subscription_value_12m_usd: 600 + i });
      const nRecs = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < nRecs; k++) {
        const day = addDays(AS_OF_DAY, -Math.floor(rng() * 60));
        if (churner) recs.push(makeRecord(day, { customer_id: id, category: rng() < 0.7 ? 'subscription_billing' : 'shipping_fulfillment', sentiment: -0.5 - rng() * 0.4, cancel_intent: rng() < 0.6, status: rng() < 0.3 ? 'open' : 'resolved' }));
        else recs.push(makeRecord(day, { customer_id: id, category: rng() < 0.7 ? 'praise' : 'usage_guidance', sentiment: 0.3 + rng() * 0.5 }));
      }
    }
    const table = P.churnTable(recs, customers, { now: AS_OF, top: 20 });
    assert(table.method === 'fitted', 'churnTable fits logistic regression with 80 labelled customers');
    assert(typeof table.auc === 'number' && table.auc > 0.8, 'fitted AUC > 0.8 (got ' + table.auc + ')');
    assert(Array.isArray(table.reliability) && table.reliability.length === 10 && table.reliability.every(r => r.n > 0 && r.predicted >= 0 && r.predicted <= 1), 'reliability has 10 deciles');
    assert(table.rows.every(r => r.customer.subscription_status !== 'cancelled'), 'cancelled customers excluded from the risk table');
    assert(table.rows.length === 20 && table.totalRows === 40, 'top=20 rows out of 40 non-cancelled customers');
    const fittedOne = P.churnRisk('c_l1', recs, customers, { now: AS_OF, model: table.model });
    assert(fittedOne.method === 'fitted', 'churnRisk scores with the fitted model when the caller passes churnTable().model');
    const plainOne = P.churnRisk('c_l1', recs, customers, { now: AS_OF });
    assert(plainOne.method === 'heuristic' && plainOne.score !== fittedOne.score, 'churnRisk without a model is heuristic regardless of earlier churnTable calls (no hidden cache)');
    const bundle = P.churnModel(recs, customers, { now: AS_OF });
    assert(bundle && bundle.method === 'fitted' && bundle.model && bundle.cv === true && near(bundle.auc, table.auc, 1e-9) && isNum(bundle.aucInSample) && bundle.nLabelled === 80,
      'churnModel returns the gated bundle churnTable used (cross-validated AUC ' + bundle.auc + ', in-sample ' + bundle.aucInSample + ')');
    const reused = P.churnTable(recs, customers, { now: AS_OF, top: 20, model: bundle });
    assert(reused.method === 'fitted' && reused.rows[0].score === table.rows[0].score && reused.revenueAtRisk === table.revenueAtRisk, 'churnTable reuses a passed bundle and reproduces the same scores');
    assert(P.churnRisk('c_l1', recs, customers, { now: AS_OF, model: bundle }).score === fittedOne.score, 'churnRisk accepts the bundle or the bare model alike');
    // gate: labels dealt out with no relation to behaviour carry no signal → the fit is rejected, the heuristic stays in charge and the caveat names the AUC
    const shuffled = new Map();
    let si = 0;
    for (const [id, c] of customers) shuffled.set(id, Object.assign({}, c, { subscription_status: (si++ % 3 === 0) ? 'cancelled' : 'active' }));
    const rejected = P.churnTable(recs, shuffled, { now: AS_OF, top: 20 });
    assert(rejected.method === 'heuristic' && rejected.model && rejected.model.model === null && rejected.rejectedFit && rejected.rejectedFit.auc < 0.65 && rejected.auc === undefined,
      'a near-random fit is rejected in favor of the heuristic (cross-validated AUC ' + (rejected.rejectedFit && rejected.rejectedFit.auc) + ')');
    assert(rejected.caveats.some(c => /below the 0.65 gate/.test(c) && /heuristic/.test(c)) && /heuristic weights/.test(rejected.explanation), 'the rejected fit is explained in a caveat and the explanation');
    assert(P.defaults.logistic.minAuc === 0.65 && P.defaults.logistic.folds === 5, 'gate defaults are exposed');
    assert(hasNoNaN(table), 'churnTable output has no NaN');
    // AUC kernel sanity
    assert(near(P.auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75, 1e-9), 'auc kernel handles a known case (0.75)');
    assert(near(P.auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5, 1e-9), 'auc kernel gives 0.5 for all ties');
  })();

  /* ---------- 7. ridge / linear solver ---------- */
  (function () {
    const x = P.solveLinear([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]], [8, -11, -3]);
    assert(x && near(x[0], 2, 1e-9) && near(x[1], 3, 1e-9) && near(x[2], -1, 1e-9), 'solveLinear solves a 3×3 system (2, 3, −1)');
    assert(P.solveLinear([[1, 2], [2, 4]], [1, 2]) === null, 'solveLinear returns null for a singular matrix');
    const X = [], y = [];
    for (let i = 0; i < 40; i++) {
      const r = [randNormal(rng, 0, 1), randNormal(rng, 0, 1), randNormal(rng, 0, 1)];
      X.push(r); y.push(1 + 2 * r[0] - 3 * r[1] + 0.5 * r[2]);
    }
    const fit = P.ridgeFit(X, y, 0);
    assert(fit && near(fit.intercept, 1, 1e-6) && near(fit.beta[0], 2, 1e-6) && near(fit.beta[1], -3, 1e-6) && near(fit.beta[2], 0.5, 1e-6), 'ridge (λ=0) recovers 1 + 2x1 − 3x2 + 0.5x3 within 1e-6');
    assert(near(fit.r2, 1, 1e-9) && fit.sigma < 1e-6, 'exact fit has r² = 1 and σ ≈ 0');
    const ridge = P.ridgeFit(X, y, 1);
    assert(ridge && Math.abs(ridge.beta[0]) < 2 && Math.abs(ridge.beta[1]) < 3, 'ridge (λ=1) shrinks slopes toward zero');
  })();

  /* ---------- 8. driverAnalysis χ² on a known 2×2 table ---------- */
  (function () {
    const recs = [];
    const day = addDays(AS_OF_DAY, -3);
    for (let i = 0; i < 100; i++) recs.push(makeRecord(day, { category: 'subscription_billing', sentiment: i < 20 ? -0.6 : 0.4 }));
    for (let i = 0; i < 100; i++) recs.push(makeRecord(day, { category: 'praise', sentiment: i < 10 ? -0.6 : 0.4 }));
    const res = P.driverAnalysis(recs, 'category');
    const row = res.rows.find(r => r.value === 'subscription_billing');
    // a=20 b=80 c=10 d=90: N=200, (|ad−bc|−N/2)² N / (r1 r2 c1 c2) = 200·900² / (100·100·30·170) = 3.17647
    assert(row && near(row.chi2, 3.1765, 1e-3), 'Yates χ² matches hand-computed 3.1765 (got ' + (row && row.chi2) + ')');
    assert(row && near(row.p, 0.0747, 2e-3), 'χ²(1) survival p ≈ 0.0747 (got ' + (row && row.p) + ')');
    assert(row && row.n === 100 && row.negatives === 20 && near(row.rate, 0.2, 1e-9) && near(row.baseRate, 0.15, 1e-9) && near(row.lift, 1.333, 1e-3) && near(row.excess, 5, 1e-9), 'row n/negatives/rate/baseRate/lift/excess correct');
    assert(near(P.chi2Yates(20, 80, 10, 90), 3.176470588, 1e-6), 'chi2Yates kernel exact');
    assert(near(P.chiSquareSurvival1(3.841), 0.05, 1e-3) && near(P.chiSquareSurvival1(6.635), 0.01, 5e-4), 'χ²(1) critical values give p 0.05 / 0.01');
    const q = P.benjaminiHochberg([0.01, 0.04, 0.03, 0.5]);
    // sorted p: .01 (r1) .03 (r2) .04 (r3) .5 (r4) → q = min over j≥i of p_j·m/j = [.04, .0533, .0533, .5]
    assert(near(q[0], 0.04, 1e-9) && near(q[1], 0.04 * 4 / 3, 1e-9) && near(q[2], 0.04 * 4 / 3, 1e-9) && near(q[3], 0.5, 1e-9), 'Benjamini–Hochberg q-values correct and monotone');
    assert(res.rows.every(r => r.q >= r.p - 1e-9) && res.explanation.indexOf('n=') >= 0 && hasNoNaN(res), 'q ≥ p and explanation carries n');
    assert(P.driverAnalysis([], 'category').n === 0, 'empty driverAnalysis → n=0');
    const small = P.driverAnalysis(recs.slice(0, 5), 'category');
    assert(small.rows.length === 0 && small.n === 5, 'min support 10 hides tiny groups');
  })();

  /* ---------- 9. whatChanged rows sum to the total delta ---------- */
  (function () {
    const mk = (n, dayOffset) => Array.from({ length: n }, () => makeRecord(addDays(AS_OF_DAY, -dayOffset - Math.floor(rng() * 7)), { category: CATS[Math.floor(rng() * CATS.length)] }));
    const nowRecs = mk(220, 0), priorRecs = mk(180, 30);
    const res = P.whatChanged(nowRecs, priorRecs, 'category');
    const sumDelta = res.rows.reduce((s, r) => s + r.delta, 0);
    const sumEffects = res.rows.reduce((s, r) => s + r.volumeEffect + r.rateEffect, 0);
    assert(sumDelta === res.total.delta, 'row deltas sum exactly to the total delta (' + sumDelta + ' = ' + res.total.delta + ')');
    assert(near(sumEffects, res.total.delta, 1e-6), 'volume + rate effects sum to the total delta within 1e-6');
    assert(res.rows.every(r => near(r.volumeEffect + r.rateEffect, r.delta, 1e-6)), 'each row decomposes exactly');
    const many = P.whatChanged(nowRecs.map((r, i) => Object.assign({}, r, { customer_id: 'c_' + (i % 15) })), priorRecs.map((r, i) => Object.assign({}, r, { customer_id: 'c_' + (i % 15) })), 'customer_id', { top: 5 });
    assert(many.rows.length === 6 && many.rows[5].value === '__other__' && near(many.rows.reduce((s, r) => s + r.delta, 0), many.total.delta, 1e-9), 'tail grouped as Other and still sums');
    const empty = P.whatChanged([], [], 'category');
    assert(empty.total.delta === 0 && empty.rows.length === 0 && hasNoNaN(empty), 'empty whatChanged is safe');
  })();

  /* ---------- 10. generic backtest returns 4 folds ---------- */
  (function () {
    const series = Array.from({ length: 90 }, (_, t) => ({ key: addDays('2026-06-01', t), value: 10 + (t % 7) }));
    const bt = P.backtest((train, h) => { const m = train.reduce((s, p) => s + p.value, 0) / train.length; return Array.from({ length: h }, () => ({ value: m, lo80: m - 5, hi80: m + 5 })); }, series, { folds: 4, horizon: 7 });
    assert(bt.folds.length === 4 && bt.folds.every(f => f.n === 7), 'backtest returns 4 folds of 7 days');
    assert(near(bt.coverage80, 1, 1e-9) && bt.mae > 0 && bt.mape > 0 && bt.mase === null, 'metrics computed (coverage 1 with a wide band; MASE null because the seasonal naive is perfect here)');
    const noisy = series.map((p, t) => ({ key: p.key, value: p.value + (t % 3) }));
    const bt2 = P.backtest((train, h) => Array.from({ length: h }, (_, i) => ({ value: train[train.length - 7 + i].value, lo80: 0, hi80: 100 })), noisy, { folds: 4, horizon: 7 });
    assert(typeof bt2.mase === 'number' && bt2.mase > 0, 'MASE is finite when the seasonal naive has error');
    assert(P.backtest(() => [], series.slice(0, 20), { folds: 4, horizon: 7 }).folds.length === 0, 'too-short series → no folds');
  })();

  /* ---------- 11. escalationRisk ---------- */
  (function () {
    const now = AS_OF;
    const calm = makeRecord(addDays(AS_OF_DAY, -1), { urgency: 'P3', sentiment: 0.5, status: 'resolved', text: 'Thanks so much, great service.' });
    const hot = makeRecord(addDays(AS_OF_DAY, -3), { id: 'r_hot', urgency: 'P0', sentiment: -0.8, status: 'open', customer_id: 'c_hot', channel: 'trustpilot_review', text: 'This is unacceptable, I am contacting my attorney and the BBB and disputing the charge.' });
    const sibling = makeRecord(addDays(AS_OF_DAY, -5), { customer_id: 'c_hot', sentiment: -0.5 });
    const a = P.escalationRisk(calm, [calm], { now }), b = P.escalationRisk(hot, [hot, sibling], { now });
    assert(a.score < b.score && b.tier === 'critical' && a.tier === 'low', 'escalation: calm ' + a.score + ' < hot ' + b.score);
    assert(b.features.severe === 1 && b.features.strong === 0 && b.features.repeat === 1 && b.features.noResponse === 1 && b.features.publicChannel === 1, 'keyword tiers exclusive; repeat/noResponse/public flags set');
    assert(b.reasons.length === 3 && b.reasons.some(r => /legal action/.test(r)), 'top-3 reasons include the legal-action keyword tier');
    assert(P.escalationRisk(null, [], { now }).score === null, 'null record handled');
    assert(hasNoNaN(b) && !/\bwill\b/i.test(b.explanation), 'escalation output clean');
  })();

  /* ---------- 12. predictCsat ridge path and fallback ---------- */
  (function () {
    const recs = [];
    for (let i = 0; i < 120; i++) {
      const day = addDays(AS_OF_DAY, -5 - Math.floor(rng() * 60));
      const s = randNormal(rng, 0, 0.5);
      const frt = Math.exp(randNormal(rng, 1.6, 0.8));
      const rec = makeRecord(day, { sentiment: s, status: 'resolved', category: CATS[i % CATS.length] });
      rec.first_response_at = new Date(new Date(rec.received_at).getTime() + frt * 3600000).toISOString();
      rec.resolved_at = new Date(new Date(rec.received_at).getTime() + (frt + 20) * 3600000).toISOString();
      rec.csat = Math.max(1, Math.min(5, Math.round(3.5 + 1.2 * s - 0.3 * Math.log1p(frt) + randNormal(rng, 0, 0.4))));
      recs.push(rec);
    }
    for (let i = 0; i < 10; i++) recs.push(makeRecord(addDays(AS_OF_DAY, -1), { status: 'open', sentiment: i < 5 ? -0.6 : 0.6 }));
    const res = P.predictCsat(recs, { now: AS_OF });
    assert(res.method === 'ridge' && res.model && res.model.n === 120, 'predictCsat fits ridge on 120 resolved CSAT records');
    assert(res.predictions.length === 10 && res.predictions.every(p => p.pred >= 1 && p.pred <= 5 && p.lo <= p.pred && p.pred <= p.hi), '10 open records predicted within 1–5 with bands');
    const negMean = res.predictions.slice(0, 5).reduce((s, p) => s + p.pred, 0) / 5, posMean = res.predictions.slice(5).reduce((s, p) => s + p.pred, 0) / 5;
    assert(negMean < posMean, 'negative-sentiment open records predict lower CSAT (' + negMean.toFixed(2) + ' < ' + posMean.toFixed(2) + ')');
    assert(res.model.r2 > 0.2 && res.model.features.length === res.model.beta.length, 'model r² > 0.2 and beta aligned with features');
    const fb = P.predictCsat(recs.slice(0, 30).concat(recs.slice(120)), { now: AS_OF });
    assert(fb.method === 'fallback' && fb.predictions.length === 10 && fb.confidence === 'low', 'fallback below n=50 with low confidence');
    assert(hasNoNaN(res) && hasNoNaN(fb), 'csat outputs have no NaN');
  })();

  /* ---------- 13. projectedNps, slaBreachProb, seasonalityIndex, sentimentDrift, rateInterval ---------- */
  (function () {
    const recs = [];
    for (let i = 0; i < 60; i++) recs.push(makeRecord(addDays(AS_OF_DAY, -Math.floor(rng() * 20)), { nps: i < 30 ? 9 : i < 45 ? 7 : 3, sentiment: i < 30 ? 0.5 : i < 45 ? 0 : -0.5 }));
    for (let i = 0; i < 10; i++) recs.push(makeRecord(addDays(AS_OF_DAY, -1), { status: 'open', sentiment: -0.6 }));
    const nps = P.projectedNps(recs, { now: AS_OF });
    assert(nps.n === 60 && near(nps.current, 25, 1e-6) && nps.nOpen === 10, 'current NPS 25 on n=60 with 10 open unsurveyed');
    assert(nps.projected < nps.current && nps.lo <= nps.projected && nps.projected <= nps.hi, 'projected NPS drops with 10 negative open records and sits inside its band');
    assert(P.projectedNps([], { now: AS_OF }).current === null, 'no NPS → null current');

    // SLA breach
    const hist = [];
    for (let i = 0; i < 100; i++) { const r = makeRecord(addDays(AS_OF_DAY, -30), { category: 'shipping_fulfillment', urgency: 'P2' }); r.frt_hours = i < 50 ? 2 : i < 80 ? 12 : 40; hist.push(r); }
    const waiting = makeRecord(AS_OF_DAY, { id: 'r_wait', category: 'shipping_fulfillment', urgency: 'P2', status: 'open' });
    waiting.age_hours = 6; waiting.first_response_at = null;
    const sla = P.slaBreachProb(waiting, hist, { now: AS_OF });
    // S(24) = (20+0.5)/101, S(6) = (50+0.5)/101 → p ≈ 0.406
    assert(sla.basis === 'category' && sla.n === 100 && near(sla.p, 20.5 / 50.5, 1e-3), 'slaBreachProb = S(T)/S(a) with Laplace smoothing (got ' + sla.p + ')');
    waiting.age_hours = 30;
    assert(P.slaBreachProb(waiting, hist, { now: AS_OF }).p === 1, 'already past the SLA → p = 1');
    const other = Object.assign({}, waiting, { category: 'praise', age_hours: 6 });
    assert(P.slaBreachProb(other, hist, { now: AS_OF }).basis === 'global', 'falls back to global basis when the category has < 30 records');
    assert(P.slaBreachProb(waiting, [], { now: AS_OF }).p === 1 && P.slaBreachProb(other, [], { now: AS_OF }).p === null, 'no history → null unless already breached');

    // seasonality
    const seas = [];
    for (let m = 0; m < 12; m++) { const n = m === 0 ? 40 : 20; for (let i = 0; i < n; i++) seas.push(makeRecord('2026-' + String(m + 1).padStart(2, '0') + '-10', { category: m === 5 ? 'taste_quality' : 'praise' })); }
    const si = P.seasonalityIndex(seas, null);
    assert(si.rows.length === 12 && si.rows[0].month === '2026-01' && si.rows[0].index > 150 && near(si.rows.reduce((s, r) => s + r.index, 0) / 12, 100, 0.5), 'volume seasonality averages 100 and peaks in January');
    const sc = P.seasonalityIndex(seas, 'taste_quality');
    assert(sc.rows.find(r => r.month === '2026-06').index > 1000 && sc.rows.find(r => r.month === '2026-01').index === 0, 'category share index isolates the June spike');
    assert(P.seasonalityIndex([], null).n === 0, 'empty seasonality → n=0');

    // drift
    const weekly = Array.from({ length: 12 }, (_, i) => ({ key: '2026-W' + String(26 + i).padStart(2, '0'), value: 62 - 0.8 * i, n: 30 }));
    const drift = P.sentimentDrift(weekly, { weeks: 12 });
    assert(near(drift.slope, -0.8, 1e-6) && drift.alert === true && near(drift.change12w, -9.6, 1e-6) && near(drift.r2, 1, 1e-9), 'drift slope −0.8/week triggers alert (change −9.6)');
    assert(drift.band === 0.8 && near(drift.projected12wLo, drift.projected12w, 0.11) && near(drift.projected12wHi, drift.projected12w, 0.11) && drift.sigma === 0 && drift.slopeSe === 0, 'a perfect line gives a zero-width 80% interval around the projection');
    const jitter = weekly.map((w, i) => ({ key: w.key, value: w.value + (i % 2 ? 4 : -4), n: 30 }));
    const jd = P.sentimentDrift(jitter, { weeks: 12 });
    assert(jd.projected12wLo < jd.projected12w && jd.projected12w < jd.projected12wHi && jd.sigma > 3 && jd.slopeSe > 0 && /likely \d+–\d+, 80% band/.test(jd.explanation),
      'residual scatter widens the interval (σ ' + jd.sigma + ', ' + jd.projected12wLo + '–' + jd.projected12wHi + ') and the explanation names it');
    const jd2 = P.sentimentDrift(weekly.map((w, i) => ({ key: w.key, value: w.value + (i % 2 ? 8 : -8), n: 30 })), { weeks: 12 });
    assert(jd2.projected12wHi - jd2.projected12wLo > (jd.projected12wHi - jd.projected12wLo) * 1.5, 'twice the scatter → a wider band');
    const flat = P.sentimentDrift(weekly.map(w => ({ key: w.key, value: 60 })), {});
    assert(flat.alert === false && flat.reason === 'within threshold', 'flat series → no alert, reason "within threshold"');
    assert(P.sentimentDrift(weekly.slice(0, 3), {}).slope === null && P.sentimentDrift(weekly.slice(0, 3), {}).reason === 'too few weeks', 'fewer than 4 weeks → null slope, reason "too few weeks"');
    // gate: a steep slide on only 5 weeks does not alert
    const five = P.sentimentDrift(weekly.slice(0, 5), { weeks: 12 });
    assert(five.alert === false && five.reason === 'too few weeks' && near(five.slope, -0.8, 1e-6) && five.change12w < -5, 'five steep weeks → slope measured but no alert (too few weeks)');
    // gate: weeks with n < 3 are dropped before the fit; 10 solid + 2 thin still alerts
    const withThin = weekly.slice(0, 10).concat([{ key: '2026-W40', value: 95, n: 1 }, { key: '2026-W41', value: 5, n: 2 }]);
    const thin = P.sentimentDrift(withThin, { weeks: 12 });
    assert(thin.alert === true && thin.n === 10 && thin.thinWeeks === 2 && thin.weeksTotal === 12 && near(thin.slope, -0.8, 1e-6), 'thin weeks (n < 3) dropped: fit on 10 solid weeks, alert holds');
    // gate: 7 solid + 5 thin → too few weeks
    const mostlyThin = weekly.slice(0, 7).concat(weekly.slice(7).map(w => Object.assign({}, w, { n: 2 })));
    assert(P.sentimentDrift(mostlyThin, { weeks: 12 }).alert === false && P.sentimentDrift(mostlyThin, { weeks: 12 }).reason === 'too few weeks', '7 solid weeks of 12 → too few weeks');
    // noise pattern with zero correlation to the week index, so the fitted slope equals the planted slope and r² = s²·var(x) / (s²·var(x) + a²)
    const PAT = [1, -1, -1, 1];
    const noisy = (slope, amp) => Array.from({ length: 12 }, (_, i) => ({ key: '2026-W' + String(26 + i).padStart(2, '0'), value: 60 + slope * i + amp * PAT[i % 4], n: 30 }));
    // gate: a sawtooth with a mild downward drift has r² ≈ 0.02 → weak fit, no alert
    const weak = P.sentimentDrift(noisy(-0.9, 20), { weeks: 12 });
    assert(weak.alert === false && weak.reason === 'weak fit' && weak.r2 < 0.1 && weak.change12w < -5 && /weak fit/.test(weak.explanation) && /n=12 weeks/.test(weak.explanation), 'sawtooth slide → weak fit, no alert (r² ' + weak.r2 + ')');
    // gate: r² between 0.1 and 0.2 alerts only when |change| ≥ 8 points
    const wob = P.sentimentDrift(noisy(-0.75, 6), { weeks: 12 });
    assert(wob.r2 > 0.1 && wob.r2 < 0.2 && wob.alert === true && wob.change12w <= -8, 'r² in (0.1, 0.2) with a 9-point slide alerts (r² ' + wob.r2 + ')');
    const wobSmall = P.sentimentDrift(noisy(-0.5, 6), { weeks: 12 });
    assert(wobSmall.alert === false && wobSmall.reason === 'weak fit' && wobSmall.r2 < 0.1 && wobSmall.change12w < -5, 'same noise with a 6-point slide → weak fit, no alert (r² ' + wobSmall.r2 + ')');
    const allThin = P.sentimentDrift(weekly.map(w => Object.assign({}, w, { n: 2 })), { weeks: 12 });
    assert(allThin.alert === false && allThin.slope === null && allThin.reason === 'too few weeks' && allThin.thinWeeks === 12, 'twelve thin weeks → no fit, too few weeks');
    assert([flat, five, thin, weak, wob].every(r => Array.isArray(r.reasons) && /n=\d+ weeks/.test(r.explanation) && !/\bwill\b/.test(r.explanation)), 'drift results carry reasons[], n and no "will"');

    // rateInterval
    const w = P.rateInterval(20, 100, 'wilson');
    assert(w.lo > 0.12 && w.lo < 0.14 && w.hi > 0.28 && w.hi < 0.30, 'Wilson 20/100 ≈ 0.13–0.29');
    const p = P.rateInterval(4, null, 'poisson');
    assert(p.lo > 1 && p.lo < 1.2 && p.hi > 9.5 && p.hi < 11, 'Poisson exact for k=4 ≈ 1.1–10.2');
    assert(P.rateInterval(0, 0, 'wilson').lo === null, 'rateInterval with n=0 → nulls');
  })();

  /* ---------- 14. forecastSentiment ---------- */
  (function () {
    const series = Array.from({ length: 60 }, (_, t) => ({ key: addDays(addDays(AS_OF_DAY, -59), t), value: 60 + randNormal(rng, 0, 4), n: 5 + Math.floor(rng() * 10) }));
    series[10].value = null; series[10].n = 0;
    const res = P.forecastSentiment(series, { horizon: 14, now: AS_OF });
    assert(res.method === 'ewma' && res.history.length === 60 && res.forecast.length === 14, 'forecastSentiment smooths 60 days and projects 14');
    assert(res.history.every(h => h.smoothed >= 0 && h.smoothed <= 100 && h.lo <= h.smoothed && h.smoothed <= h.hi), 'smoothed series and band stay within 0–100');
    assert(res.forecast[13].hi - res.forecast[13].lo >= res.forecast[0].hi - res.forecast[0].lo, 'band widens with horizon');
    assert(res.history[10].value === null && res.history[10].smoothed === res.history[9].smoothed, 'unscored day carries the smoothed level forward');
    assert(res.n === series.reduce((s, p) => s + p.n, 0) && res.explanation.indexOf('n=') >= 0 && hasNoNaN(res), 'n sums scored records; no NaN');
    assert(P.forecastSentiment([], {}).n === 0, 'empty sentiment → n=0');
    // anchoring: a first day with n = 1 at 90 followed by days near 55 starts near the n-weighted first-week mean, not at 90 with a zero-width band
    const shock = [{ key: addDays(AS_OF_DAY, -20), value: 90, n: 1 }].concat(Array.from({ length: 19 }, (_, t) => ({ key: addDays(AS_OF_DAY, -19 + t), value: 55 + randNormal(rng, 0, 2), n: 8 })));
    const anchored = P.forecastSentiment(shock, { now: AS_OF });
    assert(anchored.history[0].smoothed < 62 && anchored.history[0].hi - anchored.history[0].lo > 2 && anchored.params.anchorDays === 7,
      'EWMA anchors level and variance on the n-weighted first 7 scored days (day 1 smoothed ' + anchored.history[0].smoothed + ', band ' + anchored.history[0].lo + '–' + anchored.history[0].hi + ')');
    assert(anchored.history.slice(7).every(h => h.smoothed > 50 && h.smoothed < 62), 'the single n = 1 shock never drags the level toward 90');
  })();

  /* ---------- 15. detectorBacktest replays planted events ---------- */
  (function () {
    const recs = [];
    const start = addDays(AS_OF_DAY, -119);
    for (let t = 0; t < 120; t++) {
      const day = addDays(start, t);
      let n = poisson(rng, 4 * DOW_FACTOR[dow(day)]);
      const spike = day >= addDays(AS_OF_DAY, -40) && day <= addDays(AS_OF_DAY, -37);
      if (spike) n = n * 3 + 8;
      for (let i = 0; i < n; i++) recs.push(makeRecord(day, spike ? { category: 'shipping_fulfillment', sentiment: -0.5, text: 'FedEx says delivered but nothing arrived on my porch.' } : {}));
      if (day >= addDays(AS_OF_DAY, -8)) for (let i = 0; i < 3; i++) recs.push(makeRecord(day, { category: 'missing_damaged', subcategory: 'leaking', kit_component: 'l_drink', text: 'The L-Drink bottle was leaking inside the box.' }));
    }
    recs.push(makeRecord(addDays(AS_OF_DAY, -4), { category: 'adverse_event', serious_ae: true, is_adverse_event: true, urgency: 'P0' }));
    const events = [
      { id: 'E3', from: addDays(AS_OF_DAY, -40), to: addDays(AS_OF_DAY, -37), title: 'Carrier incident', detector: 'volume_zscore', expected: 'daily anomaly z≥3' },
      { id: 'E8', from: addDays(AS_OF_DAY, -8), to: AS_OF_DAY, title: 'L-Drink leak ramp', detector: 'emerging_unit', expected: "emerging 'new' on missing_damaged/leaking" },
      { id: 'E10', from: addDays(AS_OF_DAY, -5), to: AS_OF_DAY, title: 'Serious AE received', detector: 'ae_received', expected: 'serious AE in window' },
      { id: 'E7', from: addDays(AS_OF_DAY, -60), to: AS_OF_DAY, title: 'Taste drift', detector: 'sentiment_drift', expected: 'taste_quality index slides' },
      { id: 'EX', from: AS_OF_DAY, to: AS_OF_DAY, title: 'Unknown', detector: 'mystery', expected: '' }
    ];
    const res = P.detectorBacktest(recs, events, { now: AS_OF });
    const byId = id => res.rows.find(r => r.id === id);
    assert(res.rows.length === 5 && byId('EX').detected === null, 'unmapped detector reports detected=null');
    assert(byId('E3').detected === true && byId('E3').leadDays >= 0 && byId('E3').leadDays <= 3, 'volume spike detected with lead days ' + byId('E3').leadDays);
    assert(byId('E8').detected === true && /leaking|L-Drink|l_drink/i.test(byId('E8').detail), 'emerging ramp detected: ' + byId('E8').detail);
    assert(byId('E10').detected === true, 'AE presence detected');
    assert(byId('E7').detected === false && /slope/.test(byId('E7').detail), 'flat sentiment → drift not detected, detail explains');
    assert(res.evaluated === 4 && near(res.recall, 0.75, 1e-9), 'recall computed over mapped events only (' + res.recall + ')');
    assert(hasNoNaN(res) && res.explanation.indexOf('n=') >= 0, 'detectorBacktest output clean');
  })();

  /* ---------- 15b. eventHints / detectorBacktest with object-valued `expected` (VOC_SEED.meta.planted_events shape) ---------- */
  (function () {
    const h1 = P.eventHints({ id: 'E9', title: 'Longevity Starter Pack launch', detector: 'emerging', expected: { unit: 'product', value: 'starter_pack', status: 'new', phrase: 'final sale', min_recent: 3 } });
    assert(h1.ids.has('starter_pack') && h1.unitType === 'product' && h1.value === 'starter_pack', 'eventHints reads unit/value from an object (no "[object Object]")');
    assert(h1.phrases.indexOf('final sale') >= 0 && !h1.ids.has('new') && !h1.ids.has('min_recent') && h1.text.indexOf('[object') < 0, 'eventHints: phrase collected, status/settings keys skipped');
    const h2 = P.eventHints({ id: 'E2', title: 'BFCM surge', detector: 'anomaly', expected: { metric: 'volume', multiplier: 1.6, category_share: { checkout_website: 0.25 } } });
    assert(h2.ids.has('checkout_website') && !h2.ids.has('volume') && !h2.ids.has('category_share'), 'eventHints: category_share keys become ids, metric/key names do not');
    const h3 = P.eventHints({ id: 'E6', title: 'Foreign material ramp, lot NG-0426-B', detector: 'emerging', expected: { unit: 'lot', value: 'NG-0426-B', weekly: [1, 6, 11], kit_component: 'soup_minestrone_quinoa', product: 'prolon_nextgen', food_safety: true } });
    assert(h3.ids.has('NG-0426-B') && h3.ids.has('soup_minestrone_quinoa') && h3.ids.has('prolon_nextgen') && h3.unitType === 'lot', 'eventHints: lot id, kit component and product collected; numbers/booleans ignored');
    const h4 = P.eventHints({ id: 'E5', title: 'Double-charge bug', detector: 'p1_cluster', expected: { subcategory: 'duplicate_charge', bigram: 'charged twice', urgency: 'P1' } });
    assert(h4.ids.has('duplicate_charge') && h4.phrases.indexOf('charged twice') >= 0 && !h4.ids.has('P1'), 'eventHints: subcategory id and bigram phrase; urgency skipped');
    const h5 = P.eventHints({ id: 'S', title: 'Legacy', detector: 'emerging_unit', expected: "emerging 'new' on missing_damaged/leaking" });
    assert(h5.ids.has('missing_damaged') && h5.ids.has('leaking') && h5.phrases.indexOf('new') >= 0, 'eventHints: string expected still parsed');
    assert(P.eventHints({}).ids.size === 0 && P.eventHints(null).ids.size === 0, 'eventHints tolerates empty/null events');

    // Two units ramp in the same window: a starter_pack launch (the event) and a praise surge (a distractor).
    // The old string-concatenation fallback matched "any flagged unit with a sample in the window" and reported the distractor.
    const recs = [];
    const start = addDays(AS_OF_DAY, -119);
    for (let t = 0; t < 120; t++) {
      const day = addDays(start, t);
      const n = poisson(rng, 4 * DOW_FACTOR[dow(day)]);
      for (let i = 0; i < n; i++) recs.push(makeRecord(day, { category: t % 2 ? 'usage_guidance' : 'shipping_fulfillment' }));
      if (day >= addDays(AS_OF_DAY, -9)) {
        for (let i = 0; i < 3; i++) recs.push(makeRecord(day, { product: 'starter_pack', category: 'usage_guidance', subcategory: 'general_question', text: 'How do I start the Longevity Starter Pack? It says final sale.' }));
        for (let i = 0; i < 6; i++) recs.push(makeRecord(day, { category: 'praise', subcategory: 'results_praise', sentiment: 0.8, sentiment_label: 'positive', text: 'Loving my results, thank you!' }));
      }
    }
    const events = [
      { id: 'E9', from: addDays(AS_OF_DAY, -9), to: AS_OF_DAY, title: 'Longevity Starter Pack launch', detector: 'emerging', expected: { unit: 'product', value: 'starter_pack', status: 'new', phrase: 'final sale' } },
      { id: 'E2', from: addDays(AS_OF_DAY, -9), to: AS_OF_DAY, title: 'Surge', detector: 'anomaly', expected: { metric: 'volume', multiplier: 1.6, category_share: { praise: 0.25 } } },
      { id: 'EM', from: addDays(AS_OF_DAY, -9), to: AS_OF_DAY, title: 'Missing unit', detector: 'emerging', expected: { unit: 'product', value: 'l_protein', status: 'new' } }
    ];
    const res = P.detectorBacktest(recs, events, { now: AS_OF });
    const byId = id => res.rows.find(r => r.id === id);
    assert(byId('E9').detected === true && /starter.?pack/i.test(byId('E9').detail) && !/praise/i.test(byId('E9').detail), 'object expected: E9 is matched to the starter_pack unit, not the praise distractor: ' + byId('E9').detail);
    assert(byId('E2').detected !== null && byId('E2').kind === 'volume' && !/\[object/.test(byId('E2').detail), 'object expected: anomaly event maps to the volume detector (' + byId('E2').detail + ')');
    assert(byId('EM').detected === false && /No matching unit/.test(byId('EM').detail), 'object expected naming an absent unit is honestly missed: ' + byId('EM').detail);
    assert(hasNoNaN(res) && res.rows.every(r => String(r.detail).indexOf('[object') < 0), 'no "[object Object]" leaks into details');
  })();

  /* ---------- 15c. forecast confidence rule: MASE + coverage + weekly-block MAPE ---------- */
  (function () {
    const F = P.forecastConfidence;
    const folds = [{ n: 7 }, { n: 7 }, { n: 7 }, { n: 7 }];
    assert(F({ folds, mase: 0.8, coverage80: 0.86, weeklyMape: 0.10, mape: 0.65 }) === 'high', 'high: MASE<0.9, coverage in 65–95%, weekly MAPE<15% even with daily MAPE 65%');
    assert(F({ folds, mase: 0.8, coverage80: 0.96, weeklyMape: 0.10, mape: 0.65 }) === 'medium', 'medium: coverage above 95% blocks high (MASE<1.1)');
    assert(F({ folds, mase: 1.05, coverage80: 0.80, weeklyMape: 0.40, mape: 0.9 }) === 'medium', 'medium: MASE<1.1 alone');
    assert(F({ folds, mase: 1.4, coverage80: 0.80, weeklyMape: 0.25, mape: 0.9 }) === 'medium', 'medium: weekly MAPE<30% alone');
    assert(F({ folds, mase: 1.3, coverage80: 0.80, weeklyMape: 0.45, mape: 0.9 }) === 'low', 'low: MASE≥1.1 and weekly MAPE≥30%');
    assert(F({ folds, mase: null, coverage80: 0.80, weeklyMape: 0.10 }) === 'medium' && F({ folds: [], mase: 0.5, coverage80: 0.8, weeklyMape: 0.05 }) === 'low' && F(null) === 'low', 'null MASE falls back to weekly MAPE; no folds → low');

    // weekly-block MAPE on a series with a known block error: forecast 10/day vs actual 12/day → daily MAPE 16.7%, block |84−70|/84 = 16.7%
    const flat = Array.from({ length: 63 }, (_, t) => ({ key: addDays(AS_OF_DAY, t - 62), value: 12 }));
    const bt = P.backtest((train, h) => Array.from({ length: h }, () => ({ value: 10, lo80: 5, hi80: 15 })), flat, { folds: 4, horizon: 7 });
    assert(bt.folds.length === 4 && bt.folds.every(f => near(f.weeklyMape, 14 / 84, 1e-3)) && near(bt.weeklyMape, 14 / 84, 1e-3), 'backtest: weeklyMape is the error on 7-day block sums');
    // alternating over/under forecasts cancel in the block sum: daily MAPE stays high, weekly MAPE goes to 0
    const alt = P.backtest((train, h) => Array.from({ length: h }, (_, i) => ({ value: i % 2 ? 6 : 18, lo80: 0, hi80: 30 })), flat, { folds: 4, horizon: 7 });
    assert(alt.mape > 0.4 && alt.weeklyMape < alt.mape && alt.weeklyMape <= 6 / 84 + 1e-9, 'backtest: alternating errors cancel in block sums (daily MAPE ' + alt.mape + ', weekly ' + alt.weeklyMape + ')');
    assert(P.backtest(() => [], flat.slice(0, 20), { folds: 4, horizon: 7 }).weeklyMape === null, 'too-short series → weeklyMape null');

    // a sparse Poisson(3) series with a weekly pattern: daily MAPE is large but the explanation and confidence rely on MASE / weekly blocks
    const sparse = Array.from({ length: 133 }, (_, t) => { const key = addDays(AS_OF_DAY, t - 132); return { key, value: poisson(rng, 3 * DOW_FACTOR[dow(key)]) }; });
    const fc = P.forecastVolume(sparse, { horizon: 28, now: AS_OF });
    assert(fc.backtest.mape > 0.3 && isNum(fc.backtest.weeklyMape) && fc.backtest.weeklyMape < fc.backtest.mape, 'sparse series: daily MAPE ' + fc.backtest.mape + ' > weekly-block MAPE ' + fc.backtest.weeklyMape);
    assert(/MASE/.test(fc.explanation) && /weekly-block MAPE/.test(fc.explanation) && /n=4 folds/.test(fc.explanation), 'explanation states MASE, weekly-block MAPE and the fold count: ' + fc.explanation);
    assert(fc.caveats.every(c => !/\d+(?:\.\d+)?\s?%/.test(c) || /n=\d+ folds/.test(c)), 'every caveat carrying a percentage also carries n=folds: ' + JSON.stringify(fc.caveats));
    assert(fc.confidence === F(fc.backtest), 'forecastVolume confidence follows forecastConfidence(backtest)');
    function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
  })();

  /* ---------- 16. copy rules across every AnalyticResult produced above ---------- */
  (function () {
    const recs = Array.from({ length: 80 }, (_, i) => makeRecord(addDays(AS_OF_DAY, -(i % 40)), { nps: i % 3 === 0 ? 9 : null, csat: null }));
    const results = [
      P.forecastVolume(Array.from({ length: 70 }, (_, t) => ({ key: addDays(AS_OF_DAY, t - 69), value: 5 + (t % 7) })), { now: AS_OF }),
      P.forecastSentiment(Array.from({ length: 20 }, (_, t) => ({ key: addDays(AS_OF_DAY, t - 19), value: 55, n: 3 })), { now: AS_OF }),
      P.detectAnomalies(Array.from({ length: 40 }, (_, t) => ({ key: addDays(AS_OF_DAY, t - 39), value: 5 })), { now: AS_OF }),
      P.detectEmerging(recs, { asOf: AS_OF }), P.churnTable(recs, [], { now: AS_OF }), P.escalationRisk(recs[0], recs, { now: AS_OF }),
      P.predictCsat(recs, { now: AS_OF }), P.projectedNps(recs, { now: AS_OF }), P.driverAnalysis(recs, 'product'), P.whatChanged(recs.slice(0, 40), recs.slice(40), 'category'),
      P.slaBreachProb(recs[0], recs, { now: AS_OF }), P.seasonalityIndex(recs, null), P.sentimentDrift([], {}), P.detectorBacktest(recs, [], { now: AS_OF })
    ];
    const keys = ['method', 'params', 'n', 'explanation', 'confidence', 'caveats', 'asOf'];
    assert(results.every(r => keys.every(k => r[k] !== undefined)), 'every result carries method/params/n/explanation/confidence/caveats/asOf');
    assert(results.every(r => !/\bwill\b/i.test(r.explanation) && r.caveats.every(c => !/\bwill\b/i.test(c))), 'no generated sentence uses the word "will"');
    assert(results.every(r => /n=\d/.test(r.explanation)), 'every explanation states its n');
    assert(results.every(r => ['high', 'medium', 'low'].indexOf(r.confidence) >= 0), 'confidence is high/medium/low');
    assert(results.every(r => hasNoNaN(r)), 'no NaN anywhere in the result set');
  })();

  console.log(passes + ' passed, ' + failures + ' failed');
  if (failures) throw new Error('test_predict: ' + failures + ' assertion(s) failed');
})();
