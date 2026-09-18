/* L-Nutra Voice of the Customer — alerts.js (A1)
 * Alert rules and evaluate(derived): statistical rules through VOC.predict when present (with small local fallbacks)
 * plus rule-based safety/SLA rules. Ack/snooze state persists in localStorage when available. SPEC §4.8. PURE.
 */
window.VOC = window.VOC || {};
(function () {
  'use strict';

  const LS_RULES = 'voc.alerts.rules';
  const LS_STATE = 'voc.alerts.state';
  const LS_HISTORY = 'voc.alerts.history';
  const HISTORY_MAX = 500;
  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;
  const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

  function U() { return VOC.util; }
  function E() { return VOC.enums; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function lsGet(key) {
    if (typeof localStorage === 'undefined') return null;
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function lsSet(key, value) {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* memory only */ }
  }

  const mem = {
    overrides: lsGet(LS_RULES) || {},
    state: Object.assign({ acked: {}, snoozed: {} }, lsGet(LS_STATE) || {}),
    history: Array.isArray(lsGet(LS_HISTORY)) ? lsGet(LS_HISTORY) : [],
    last: []
  };

  function nowDate() {
    return VOC.store && typeof VOC.store.now === 'function' ? VOC.store.now() : new Date();
  }

  /* ------------------------------------------------------------------ */
  /* Rules                                                               */
  /* ------------------------------------------------------------------ */

  /** @returns {Array<{id:string,type:string,threshold:number,enabled:boolean,label:string,unit:string}>} */
  function defaultRules() {
    return [
      { id: 'volume_zscore', type: 'volume_zscore', threshold: 2, enabled: true, label: 'Daily volume spike', unit: 'z', detail: 'Daily count of all records vs a 28-day day-of-week-adjusted baseline (independent of the date range); warning at z ≥ 2, critical at z ≥ 3.' },
      { id: 'neg_share_zscore', type: 'neg_share_zscore', threshold: 2, enabled: true, label: 'Negative-share spike', unit: 'z', detail: 'Share of negative records per day vs a 28-day baseline, thin days shrunk toward it (all records, independent of the date range).' },
      { id: 'emerging_unit', type: 'emerging_unit', threshold: 2, enabled: true, label: 'Emerging issue', unit: 'z', detail: 'Category, subcategory, product, component, lot or bigram rising in the last 7 days vs the prior 28.' },
      { id: 'sentiment_drift', type: 'sentiment_drift', threshold: -5, enabled: true, label: 'Sentiment drift', unit: 'pts / 12 weeks', detail: 'OLS slope on the last 12 weekly sentiment-index means, overall and per category (all records); alert when the projected 12-week change falls below the threshold.' },
      { id: 'p1_cluster', type: 'p1_cluster', threshold: 3, enabled: true, label: 'P1 cluster', unit: 'records / 24h', detail: 'At least this many P1 records of one subcategory within 24 hours.' },
      { id: 'ae_received', type: 'ae_received', threshold: 1, enabled: true, label: 'Serious adverse event open', unit: 'records', detail: 'Every open serious adverse event raises a critical alert with its MedWatch clock.' },
      { id: 'food_safety_received', type: 'food_safety_received', threshold: 1, enabled: true, label: 'Food-safety report open', unit: 'records', detail: 'Open foreign-material, allergen or spoilage reports (Reportable Food Registry 24-hour evaluation).' },
      { id: 'sla_breach', type: 'sla_breach', threshold: 1, enabled: true, label: 'First-response SLA breached', unit: 'records', detail: 'Open records with no first response past their urgency SLA.' }
    ];
  }
  /** Default rules with persisted enabled/threshold overrides applied. */
  function rules() {
    return defaultRules().map((r) => {
      const o = mem.overrides[r.id];
      if (!o) return r;
      return Object.assign(r, { enabled: o.enabled === undefined ? r.enabled : !!o.enabled, threshold: isNum(o.threshold) ? o.threshold : r.threshold });
    });
  }
  /**
   * Persist an enabled/threshold change for a rule.
   * @returns {object|null} the updated rule
   */
  function setRule(id, patch) {
    const base = defaultRules().find((r) => r.id === id);
    if (!base) return null;
    const o = Object.assign({}, mem.overrides[id] || {});
    if (patch && patch.enabled !== undefined) o.enabled = !!patch.enabled;
    if (patch && isNum(patch.threshold)) o.threshold = patch.threshold;
    mem.overrides[id] = o;
    lsSet(LS_RULES, mem.overrides);
    return rules().find((r) => r.id === id);
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function fmtN(x, d) { return U().fmt.num(x, d === undefined ? 0 : d); }
  function dayMs(key) { return new Date(U().startOfDayCT(key)).getTime(); }
  function withinDays(isoOrKey, nowD, days) {
    const t = /^\d{4}-\d{2}-\d{2}$/.test(String(isoOrKey)) ? dayMs(isoOrKey) : Date.parse(isoOrKey);
    return isNum(t) && nowD.getTime() - t <= days * DAY_MS;
  }
  function severityByZ(z) { return Math.abs(z) >= 3 ? 'critical' : 'warning'; }
  const DETAIL_MAX = 220;
  /**
   * Keep an alert detail at or under DETAIL_MAX characters without losing its trailing "(n = …)" clause: the body is cut
   * at a word boundary and marked with an ellipsis, the n clause is re-attached.
   * @param {string} detail
   * @param {number} [max=DETAIL_MAX]
   * @returns {string}
   */
  function fitDetail(detail, max) {
    const limit = isNum(max) ? max : DETAIL_MAX;
    const s = String(detail || '');
    if (s.length <= limit) return s;
    const idx = s.lastIndexOf('(n = ');
    const suffix = idx >= 0 ? s.slice(idx) : '';
    let body = idx >= 0 ? s.slice(0, idx).replace(/[\s;,.]+$/, '') : s;
    const room = limit - suffix.length - 2;
    if (room < 20) return s.slice(0, limit - 1) + '…';
    body = body.slice(0, room);
    const cutAt = body.lastIndexOf(' ');
    if (cutAt > room * 0.6) body = body.slice(0, cutAt);
    body = body.replace(/[\s;,.]+$/, '') + '…';
    return suffix ? body + ' ' + suffix : body;
  }
  function mkAlert(o) {
    return {
      id: o.id, ruleId: o.ruleId, severity: o.severity || 'warning', title: o.title, detail: fitDetail(o.detail || ''), at: o.at,
      drill: o.drill || null, acked: false, snoozedUntil: null, n: isNum(o.n) ? o.n : null, value: o.value === undefined ? null : o.value, spark: o.spark || null,
      days: o.days || null, related: [], alsoRising: o.alsoRising || null, extra: o.extra || null
    };
  }

  /** Local fallback anomaly scan when VOC.predict is absent: rolling 28-day baseline (excluding the day), last 14 days scored. Null values are masked. */
  function localAnomalies(series, mode, minZ) {
    const events = [];
    const floor = mode === 'share' ? 0.03 : 1.0;
    const start = Math.max(7, series.length - 14);
    for (let i = start; i < series.length; i++) {
      if (!isNum(series[i].value)) continue;
      const win = series.slice(Math.max(0, i - 28), i).map((p) => p.value).filter(isNum);
      if (win.length < 7) continue;
      const mu = win.reduce((s, x) => s + x, 0) / win.length;
      const sd = Math.sqrt(win.reduce((s, x) => s + (x - mu) * (x - mu), 0) / Math.max(1, win.length - 1));
      const denom = Math.max(sd, mode === 'share' ? floor : Math.sqrt(Math.max(mu, floor)), floor);
      let value = series[i].value;
      if (mode === 'share' && isNum(series[i].n)) value = (series[i].n * value + 10 * mu) / (series[i].n + 10);
      const z = (value - mu) / denom;
      if (z >= minZ) events.push({ start: series[i].key, end: series[i].key, value: series[i].value, expected: mu, z, severity: severityByZ(z) });
    }
    return events;
  }
  /* Anomaly rules describe whole-store facts, so their daily series come from d.allRecords over a fixed trailing window
   * (28-day baseline + 84 days of weekday history) ending d.now — not from d.byDay, which is cut to the filter range and
   * would make the header badge flip with the range preset (no alert possible at 7d, a truncated baseline at 30d). */
  const ANOMALY_DAYS = 28 + 84;
  function dailyFromRecords(records, nowD, days) {
    const u = U();
    const to = u.dayKey(nowD), from = u.addDays(to, -(days - 1));
    const map = new Map();
    for (let d = from; d <= to; d = u.addDays(d, 1)) map.set(d, { key: d, count: 0, neg: 0, pos: 0, neu: 0 });
    records.forEach((r) => {
      if (!r || r.is_noise) return;
      const dk = r.day_key || (r.received_at ? u.dayKey(r.received_at) : null);
      const b = dk ? map.get(dk) : null;
      if (!b) return;
      b.count += 1;
      const l = r.sentiment_label;
      if (l === 'negative') b.neg += 1; else if (l === 'positive') b.pos += 1; else if (l === 'neutral') b.neu += 1;
    });
    return Array.from(map.values());
  }
  function anomalyDays(d, nowD) {
    if (Array.isArray(d.allRecords) && d.allRecords.length) return dailyFromRecords(d.allRecords, nowD, ANOMALY_DAYS);
    return d.byDay || [];
  }
  function anomalyEvents(predict, series, mode, minZ) {
    if (predict && typeof predict.detectAnomalies === 'function') {
      try {
        const res = predict.detectAnomalies(series, { mode, window: 28, dowAdjust: true, warn: 2, critical: 3 });
        return ((res && res.events) || []).filter((e) => isNum(e.z) && e.z >= minZ);
      } catch (e) { return []; }
    }
    return localAnomalies(series, mode, minZ);
  }
  function olsSlope(values) {
    const n = values.length;
    if (n < 2) return null;
    const xm = (n - 1) / 2;
    const ym = values.reduce((s, x) => s + x, 0) / n;
    let num = 0, den = 0;
    values.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) * (i - xm); });
    return den ? num / den : null;
  }

  /* ------------------------------------------------------------------ */
  /* Rule evaluators                                                     */
  /* ------------------------------------------------------------------ */

  function evalVolume(rule, d, predict, nowD) {
    const series = anomalyDays(d, nowD).map((p) => ({ key: p.key, value: p.count }));
    if (series.length < 14) return [];
    return anomalyEvents(predict, series, 'count', rule.threshold).filter((e) => withinDays(e.end || e.start, nowD, 14)).map((e) => mkAlert({
      id: 'volume_zscore:' + e.start, ruleId: rule.id, severity: e.severity || severityByZ(e.z),
      title: 'Volume spike: ' + fmtN(e.value) + ' records on ' + U().fmt.date(e.start) + ' vs about ' + fmtN(e.expected) + ' expected',
      detail: 'z = ' + fmtN(e.z, 1) + ' against a 28-day baseline (n = ' + fmtN(e.value) + ' records that day).',
      at: U().endOfDayCT(e.end || e.start), n: e.value, value: e.z, days: { from: e.start, to: e.end || e.start },
      drill: { view: 'inbox', filters: { range: { preset: 'custom', from: e.start, to: e.end || e.start } } }
    }));
  }
  function evalNegShare(rule, d, predict, nowD) {
    // Every day carries its real share and its n (scored records): predict shrinks thin days toward the baseline
    // ((n·share + K·expected)/(n + K)) and masks days with no scored records, instead of reading them as 0% negative.
    const days = anomalyDays(d, nowD);
    const series = days.map((p) => { const scored = p.neg + p.pos + p.neu; return { key: p.key, value: scored > 0 ? p.neg / scored : null, n: scored }; });
    if (series.filter((p) => isNum(p.value)).length < 14) return [];
    const countByDay = new Map(days.map((p) => [p.key, p.count]));
    return anomalyEvents(predict, series, 'share', rule.threshold).filter((e) => withinDays(e.end || e.start, nowD, 14)).map((e) => {
      const dayN = countByDay.get(e.start);
      return mkAlert({
        id: 'neg_share_zscore:' + e.start, ruleId: rule.id, severity: e.severity || severityByZ(e.z),
        title: 'Negative share spike: ' + U().fmt.pct(e.value) + ' of records negative on ' + U().fmt.date(e.start) + ' vs about ' + U().fmt.pct(e.expected) + ' expected',
        detail: 'z = ' + fmtN(e.z, 1) + ' against a 28-day baseline (n = ' + (isNum(dayN) ? fmtN(dayN) : '—') + ' records that day).',
        at: U().endOfDayCT(e.end || e.start), n: isNum(dayN) ? dayN : null, value: e.z, days: { from: e.start, to: e.end || e.start },
        drill: { view: 'inbox', filters: { range: { preset: 'custom', from: e.start, to: e.end || e.start }, sentiment: ['negative'] } }
      });
    });
  }
  /** Emerging rows carry {unit: type, type, value}; older shapes put the value in `unit`. Subcategory values arrive as 'category/subcategory'. */
  function emergingValue(row) {
    const raw = row.value !== undefined && row.value !== null ? String(row.value) : String(row.unit);
    if (row.type === 'subcategory' && raw.indexOf('/') >= 0) return raw.slice(raw.indexOf('/') + 1);
    return raw;
  }
  function emergingDrill(row, nowD) {
    const u = U();
    const to = u.dayKey(nowD), from = u.addDays(to, -6);
    const f = { range: { preset: 'custom', from, to } };
    const v = emergingValue(row);
    if (row.type === 'category') f.category = [v];
    else if (row.type === 'subcategory') f.subcategory = [v];
    else if (row.type === 'product') f.product = [v];
    else f.search = v;
    return { view: 'inbox', filters: f };
  }
  /** Structured units win when two emerging rows describe the same records (lot before component before subcategory …); a phrase names the same event less precisely, so it ranks last. */
  const EMERGING_SPECIFICITY = { lot: 0, kit_component: 1, subcategory: 2, product: 3, category: 4, segment: 5, channel: 6, region: 7, bigram: 8 };
  const ALSO_RISING_MAX = 3;
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /** Ids of recent-window records that belong to an emerging unit, recomputed from the records (rows only carry 5 sample ids). */
  function emergingMembers(row, recent) {
    const v = emergingValue(row);
    let test;
    switch (row.type) {
      case 'lot': test = (r) => r.lot_number === v; break;
      case 'kit_component': test = (r) => r.kit_component === v; break;
      case 'subcategory': test = (r) => r.subcategory === v; break;
      case 'product': test = (r) => r.product === v; break;
      case 'category': test = (r) => r.category === v; break;
      case 'segment': test = (r) => r.segment === v; break;
      case 'channel': test = (r) => r.channel === v; break;
      case 'region': test = (r) => r.region === v; break;
      case 'bigram': {
        // grams skip stopwords ("hard bits in the soup" → "bits soup"), so allow up to three intervening words
        const re = new RegExp('\\b' + v.split(/\s+/).map(escapeRe).join('\\b(?:\\W+[\\w\']+){0,3}?\\W+') + '\\b', 'i');
        test = (r) => re.test((r.subject || '') + '\n' + (r.text || ''));
        break;
      }
      default: test = () => false;
    }
    const ids = new Set();
    recent.forEach((r) => { if (test(r)) ids.add(r.id); });
    return ids;
  }
  function overlapShare(a, b) {
    if (!a.size || !b.size) return 0;
    let both = 0;
    a.forEach((id) => { if (b.has(id)) both += 1; });
    return both / Math.min(a.size, b.size);
  }
  function evalEmerging(rule, d, predict, nowD) {
    if (!predict || typeof predict.detectEmerging !== 'function') return [];
    const u = U();
    const records = d.allRecords || d.records || [];
    let rows = [];
    try {
      const res = predict.detectEmerging(records, { recentDays: 7, baseDays: 28, asOf: nowD, negativeOnly: false, minRecent: 3 });
      rows = (res && res.rows) || [];
    } catch (e) { return []; }
    const to = u.dayKey(nowD), from = u.addDays(to, -6);
    const recent = records.filter((r) => { const dk = r.day_key || (r.received_at ? u.dayKey(r.received_at) : null); return dk && dk >= from && dk <= to; });
    const candidates = rows.filter((r) => (r.status === 'new' || r.status === 'emerging') && isNum(r.z) && r.z >= rule.threshold)
      .map((r) => ({ row: r, members: emergingMembers(r, recent), rank: EMERGING_SPECIFICITY[r.type] === undefined ? 9 : EMERGING_SPECIFICITY[r.type], also: [] }))
      .sort((a, b) => (a.rank - b.rank) || (b.row.z - a.row.z));
    // Collapse rows that describe the same root event (≥ 60% of the smaller set shared, at least 2 records): keep the most specific.
    const kept = [];
    candidates.forEach((c) => {
      const twin = kept.find((k) => Math.min(k.members.size, c.members.size) >= 2 && overlapShare(k.members, c.members) >= 0.6);
      if (twin) twin.also.push(c);
      else kept.push(c);
    });
    return kept.sort((a, b) => b.row.z - a.row.z).slice(0, 5).map((c) => {
      const r = c.row;
      const label = r.label || E().label(r.type, emergingValue(r));
      const critical = r.z >= 3 && (r.type === 'lot' || r.type === 'kit_component' || (isNum(r.lift) && r.lift >= 3));
      // Good news is not an incident: a unit that is praise (the category, a praise subcategory, or records that are all
      // praise) or whose recent records are ≥ 70% positive is capped at 'info'.
      const memberRecs = recent.filter((x) => c.members.has(x.id));
      const positiveShare = memberRecs.length ? memberRecs.filter((x) => x.sentiment_label === 'positive' || (!x.sentiment_label && isNum(x.sentiment) && x.sentiment > 0.15)).length / memberRecs.length : 0;
      const v = emergingValue(r);
      const praise = (r.type === 'category' && v === 'praise') || (r.type === 'subcategory' && E().categoryOf(v) === 'praise') ||
        (memberRecs.length > 0 && memberRecs.every((x) => x.category === 'praise'));
      const severity = praise || positiveShare >= 0.7 ? 'info' : (critical ? 'critical' : 'warning');
      const alsoSorted = c.also.slice().sort((x, y) => (x.rank - y.rank) || (y.row.z - x.row.z));
      const also = alsoSorted.slice(0, ALSO_RISING_MAX).map((x) => (x.row.label || E().label(x.row.type, emergingValue(x.row))) + ' (' + String(x.row.type).replace('_', ' ') + ', z ' + fmtN(x.row.z, 1) + ')');
      const more = alsoSorted.length - also.length;
      return mkAlert({
        id: 'emerging_unit:' + r.type + ':' + emergingValue(r), ruleId: rule.id, severity,
        title: (r.status === 'new' ? 'New: ' : 'Rising: ') + label + ' — ' + fmtN(r.cR) + ' in the last 7 days vs ' + fmtN(r.cB) + ' in the prior 28',
        detail: 'About ' + fmtN(r.expected, 1) + ' expected; z = ' + fmtN(r.z, 1) + (isNum(r.lift) ? ', lift ' + fmtN(r.lift, 1) + '×' : '') +
          (also.length ? '. Same records also rise as ' + also.join('; ') + (more > 0 ? ' and ' + more + ' more' : '') : '') + ' (n = ' + fmtN(r.cR) + ').',
        at: nowD.toISOString(), n: r.cR, value: r.z, drill: emergingDrill(r, nowD), days: { from, to },
        alsoRising: also.length ? c.also.map((x) => ({ type: x.row.type, value: emergingValue(x.row), label: x.row.label || null, z: x.row.z, cR: x.row.cR })) : null
      });
    });
  }
  /* Sentiment drift is a whole-store fact too: the weekly index series comes from d.allRecords over the last 12 ISO weeks
   * ending d.now (the range preset never has 8 weeks at 30d), and it is scored overall AND per category so a slide inside
   * one theme (SPEC §11 E7: taste_quality) is not averaged away by a flat majority. d.byWeek is the fallback when a caller
   * passes no records. */
  const DRIFT_WEEKS = 12;
  const DRIFT_UNITS_MAX = 5;
  function weeklyIndexSeries(records, nowD, filterFn) {
    const u = U();
    const to = u.dayKey(nowD);
    const keys = [];
    for (let w = DRIFT_WEEKS - 1; w >= 0; w--) keys.push(u.weekKey(u.addDays(to, -7 * w) + 'T18:00:00Z'));
    const map = new Map(keys.map((k) => [k, { sum: 0, n: 0 }]));
    records.forEach((r) => {
      if (!r || r.is_noise || (filterFn && !filterFn(r))) return;
      if (!isNum(r.sentiment) || r.sentiment_label === 'unscored') return;
      const wk = r.week_key || (r.received_at ? u.weekKey(r.received_at) : null);
      const b = wk ? map.get(wk) : null;
      if (!b) return;
      b.sum += isNum(r.sentiment_index) ? r.sentiment_index : (r.sentiment + 1) / 2 * 100;
      b.n += 1;
    });
    return keys.map((k) => { const b = map.get(k); return { key: k, value: b.n ? b.sum / b.n : null, n: b.n }; }).filter((p) => p.value !== null);
  }
  function driftUnits(d, nowD) {
    const all = Array.isArray(d.allRecords) && d.allRecords.length ? d.allRecords : null;
    if (!all) {
      const weekly = (d.byWeek || []).filter((w) => w.count > 0 && isNum(w.meanSentiment)).slice(-DRIFT_WEEKS)
        .map((w) => ({ key: w.key, value: (w.meanSentiment + 1) / 2 * 100, n: w.count }));
      return [{ id: 'all', label: null, weekly, filters: {} }];
    }
    const units = [{ id: 'all', label: null, weekly: weeklyIndexSeries(all, nowD, null), filters: {} }];
    const cats = [];
    all.forEach((r) => { const c = r && r.category; if (c && c !== 'other_noise' && c !== 'general' && cats.indexOf(c) < 0) cats.push(c); });
    cats.sort().forEach((c) => units.push({ id: c, label: E().label('category', c), weekly: weeklyIndexSeries(all, nowD, (r) => r.category === c), filters: { category: [c] } }));
    return units;
  }
  function driftFor(rule, unit, predict) {
    const weekly = unit.weekly;
    if (weekly.length < 8) return null;
    let slope = null, change = null, r2 = null, alert = false, usedWeeks = weekly.length, lo = null, hi = null, projected = null;
    let viaPredict = false;
    if (predict && typeof predict.sentimentDrift === 'function') {
      try {
        // predict applies the gate (≥ 8 solid weeks, fit quality, threshold); its verdict is final when it answers.
        const res = predict.sentimentDrift(weekly, { weeks: DRIFT_WEEKS, alertDrop: rule.threshold });
        if (res && typeof res.alert === 'boolean') {
          viaPredict = true;
          slope = isNum(res.slope) ? res.slope : null;
          change = isNum(res.change12w) ? res.change12w : (slope !== null ? slope * 12 : null);
          r2 = isNum(res.r2) ? res.r2 : null;
          alert = res.alert;
          if (isNum(res.n)) usedWeeks = res.n;
          if (isNum(res.projected12w)) projected = res.projected12w;
          if (isNum(res.projected12wLo) && isNum(res.projected12wHi)) { lo = res.projected12wLo; hi = res.projected12wHi; }
        }
      } catch (e) { viaPredict = false; }
    }
    if (!viaPredict) {
      // local fallback: same rule shape without fit statistics (predict.js absent); no interval is invented
      const solid = weekly.filter((w) => w.n >= 3);
      if (solid.length < 8) return null;
      slope = olsSlope(solid.map((w) => w.value));
      if (slope === null) return null;
      change = slope * 12;
      usedWeeks = solid.length;
      alert = change < rule.threshold;
    }
    if (!alert || slope === null || change === null) return null;
    // the point projection is the fitted line carried 12 weeks on (what the band is centred on); last + change is the fallback
    if (projected === null) projected = weekly[weekly.length - 1].value + change;
    return { unit, weekly, slope, change, r2, usedWeeks, lo, hi, projected };
  }
  function evalDrift(rule, d, predict, nowD) {
    const hits = driftUnits(d, nowD).map((unit) => driftFor(rule, unit, predict)).filter(Boolean);
    const overall = hits.filter((h) => h.unit.id === 'all');
    const byCategory = hits.filter((h) => h.unit.id !== 'all').sort((a, b) => a.change - b.change).slice(0, DRIFT_UNITS_MAX);
    return overall.concat(byCategory).map((h) => {
      const weekly = h.weekly;
      const last = weekly[weekly.length - 1].value;
      const totalN = weekly.reduce((s, w) => s + (isNum(w.n) ? w.n : 0), 0);
      // The "likely" range is the OLS 80% prediction interval predict.sentimentDrift returns (residual σ, slope error and
      // leverage of the 12-week horizon); without predict there is no honest band, so the clause is left out.
      const likely = h.lo !== null && h.hi !== null ? ', likely ' + fmtN(h.lo) + '–' + fmtN(h.hi) + ' (80% band)' : '';
      return mkAlert({
        id: 'sentiment_drift:' + h.unit.id + ':' + weekly[weekly.length - 1].key, ruleId: rule.id, severity: h.change <= rule.threshold * 2 ? 'critical' : 'warning',
        title: 'Sentiment index sliding about ' + fmtN(Math.abs(h.slope), 1) + ' pts a week over ' + h.usedWeeks + ' weeks' + (h.unit.label ? ' in ' + h.unit.label : ''),
        detail: 'Now ' + fmtN(last) + ' pts; if the trend holds, about ' + fmtN(h.projected) + ' pts in 12 weeks' + likely +
          (h.r2 !== null ? '; r² ' + fmtN(h.r2, 2) : '') + ' (n = ' + h.usedWeeks + ' weeks, ' + fmtN(totalN) + ' records).',
        at: nowD.toISOString(), n: totalN, value: h.slope, spark: weekly.map((w) => w.value),
        drill: { view: 'trends', filters: Object.assign({ range: { preset: '90d' } }, h.unit.filters) },
        extra: { unit: h.unit.id, change12w: h.change, projected: h.projected, projectedLo: h.lo, projectedHi: h.hi }
      });
    });
  }
  function evalP1Cluster(rule, d, nowD) {
    const u = U();
    const k = Math.max(2, Math.round(rule.threshold));
    const p1 = (d.records || []).filter((r) => r.urgency === 'P1' && !r.is_noise);
    const groups = u.groupBy(p1, (r) => r.subcategory);
    const out = [];
    groups.forEach((list, sub) => {
      const sorted = list.slice().sort((a, b) => (a.received_at < b.received_at ? -1 : 1));
      let best = null;
      for (let i = 0; i + k - 1 < sorted.length; i++) {
        const t0 = Date.parse(sorted[i].received_at);
        let j = i + k - 1;
        if (Date.parse(sorted[j].received_at) - t0 > 24 * HOUR_MS) continue;
        while (j + 1 < sorted.length && Date.parse(sorted[j + 1].received_at) - t0 <= 24 * HOUR_MS) j += 1;
        best = { members: sorted.slice(i, j + 1) };
      }
      if (!best) return;
      const members = best.members;
      const end = members[members.length - 1].received_at;
      const open = members.filter((r) => r.is_open).length;
      if (!open && !withinDays(end, nowD, 7)) return;
      out.push(mkAlert({
        id: 'p1_cluster:' + sub + ':' + u.dayKey(end), ruleId: rule.id, severity: members.length >= k * 2 ? 'critical' : 'warning',
        title: members.length + ' P1 ' + E().label('subcategory', sub) + ' reports within 24 hours',
        detail: 'Latest ' + u.fmt.date(end, 'datetime') + '; ' + open + ' still open (n = ' + members.length + ').',
        at: end, n: members.length, value: members.length,
        drill: { view: 'inbox', filters: { range: { preset: 'custom', from: u.dayKey(members[0].received_at), to: u.dayKey(end) }, subcategory: [sub], urgency: ['P1'] } }
      }));
    });
    return out;
  }
  function evalAe(rule, d) {
    const u = U();
    const open = (d.regulatory && d.regulatory.openSerious) || (d.allRecords || []).filter((r) => r.serious_ae && r.is_open);
    return open.map((r) => mkAlert({
      id: 'ae_received:' + r.id, ruleId: rule.id, severity: 'critical',
      title: 'Serious adverse event: ' + E().label('product', r.product) + ' — ' + E().label('subcategory', r.subcategory),
      detail: 'Received ' + u.fmt.date(r.received_at, 'datetime') + '; ' + (isNum(r.business_days_remaining) ? fmtN(r.business_days_remaining, 1) + ' business days left on the MedWatch 15-day clock' : 'MedWatch clock pending') + ' (n = 1).',
      at: r.received_at, n: 1, value: r.business_days_remaining, drill: { view: 'inbox', id: r.id }
    }));
  }
  function evalFoodSafety(rule, d) {
    const u = U();
    const open = (d.regulatory && d.regulatory.openFoodSafety) || (d.allRecords || []).filter((r) => r.food_safety && r.is_open);
    if (open.length < rule.threshold) return [];
    if (open.length <= 3) {
      return open.map((r) => mkAlert({
        id: 'food_safety_received:' + r.id, ruleId: rule.id, severity: 'critical',
        title: 'Food-safety report: ' + E().label('product', r.product) + ' — ' + E().label('subcategory', r.subcategory) + (r.lot_number ? ' (lot ' + r.lot_number + ')' : ''),
        detail: 'Received ' + u.fmt.date(r.received_at, 'datetime') + (isNum(r.hours_remaining) ? '; ' + u.fmt.hours(r.hours_remaining) + ' left on the 24-hour RFR evaluation' : '') + ' (n = 1).',
        at: r.received_at, n: 1, value: r.hours_remaining, drill: { view: 'inbox', id: r.id }
      }));
    }
    const newest = open.reduce((m, r) => (r.received_at > m ? r.received_at : m), open[0].received_at);
    const lots = Array.from(new Set(open.map((r) => r.lot_number).filter(Boolean)));
    return [mkAlert({
      id: 'food_safety_received:group:' + u.dayKey(newest), ruleId: rule.id, severity: 'critical',
      title: open.length + ' open food-safety reports',
      detail: (lots.length ? lots.length + ' lot' + (lots.length > 1 ? 's' : '') + ' named (' + lots.slice(0, 3).join(', ') + (lots.length > 3 ? ', …' : '') + '); ' : '') + 'newest ' + u.fmt.date(newest, 'datetime') + ' (n = ' + open.length + ').',
      at: newest, n: open.length, value: open.length, drill: { view: 'regulatory', filters: { range: { preset: '12m' }, flags: ['food_safety', 'open'] } }
    })];
  }
  function evalSla(rule, d, nowD) {
    const u = U();
    const breached = (d.allRecords || d.records || []).filter((r) => r.is_open && r.frt_hours === null && r.sla_frt_breached);
    if (breached.length < rule.threshold) return [];
    const urgent = breached.filter((r) => r.urgency === 'P0' || r.urgency === 'P1').length;
    const oldest = breached.reduce((m, r) => Math.max(m, r.age_hours || 0), 0);
    const unassigned = breached.filter((r) => !r.assignee).length;
    return [mkAlert({
      id: 'sla_breach:' + u.dayKey(nowD), ruleId: rule.id, severity: urgent ? 'critical' : 'warning',
      title: breached.length + ' open record' + (breached.length > 1 ? 's' : '') + ' past first-response SLA',
      detail: breached.length + ' open record' + (breached.length > 1 ? 's' : '') + ' with no first response past SLA, ' + urgent + ' of them P0/P1 and ' + unassigned + ' unassigned; oldest waiting ' +
        u.fmt.hours(oldest) + ' (n = ' + breached.length + ').',
      at: nowD.toISOString(), n: breached.length, value: breached.length, extra: { oldestHours: oldest, urgent, unassigned },
      drill: { view: 'inbox', filters: { range: { preset: '12m' }, flags: ['sla_breached'] } }
    })];
  }

  /* ------------------------------------------------------------------ */
  /* Evaluate, state, history                                            */
  /* ------------------------------------------------------------------ */

  function daysOverlap(a, b) {
    return !!(a && b && a.from && b.from && a.from <= (b.to || b.from) && b.from <= (a.to || a.from));
  }
  /**
   * Link alerts that describe one root event on the same days: a volume spike and a negative-share spike (both kept,
   * each names the other in `related` and its detail), and an emerging unit rising on the same days as either spike.
   * Mutates the alerts in place.
   */
  function linkRelated(alerts) {
    const spikes = alerts.filter((a) => (a.ruleId === 'volume_zscore' || a.ruleId === 'neg_share_zscore') && a.days);
    spikes.forEach((a) => {
      spikes.forEach((b) => {
        if (a === b || a.ruleId === b.ruleId || !daysOverlap(a.days, b.days) || a.related.indexOf(b.id) >= 0) return;
        a.related.push(b.id);
        const note = a.ruleId === 'volume_zscore' ? 'Coincides with a negative-share spike the same day' : 'Coincides with a volume spike the same day';
        a.detail = fitDetail(a.detail.replace(/\s*\(n = [^)]*\)\.?$/, (m) => '. ' + note + m));
      });
    });
    alerts.filter((a) => a.ruleId === 'emerging_unit' && a.days).forEach((a) => {
      spikes.forEach((s) => { if (daysOverlap(a.days, s.days) && a.related.indexOf(s.id) < 0) { a.related.push(s.id); if (s.related.indexOf(a.id) < 0) s.related.push(a.id); } });
    });
  }

  function decorate(alert, nowD) {
    const acked = mem.state.acked[alert.id];
    const until = mem.state.snoozed[alert.id];
    alert.acked = !!acked;
    alert.snoozedUntil = until && Date.parse(until) > nowD.getTime() ? until : null;
    return alert;
  }
  function recordHistory(alerts, nowIso) {
    const byId = new Map(mem.history.map((h) => [h.id, h]));
    let changed = false;
    alerts.forEach((a) => {
      const h = byId.get(a.id);
      if (h) {
        if (h.last_seen !== nowIso || h.severity !== a.severity) { h.last_seen = nowIso; h.severity = a.severity; h.title = a.title; changed = true; }
      } else {
        mem.history.unshift({ id: a.id, ruleId: a.ruleId, severity: a.severity, title: a.title, at: a.at, first_seen: nowIso, last_seen: nowIso });
        changed = true;
      }
    });
    if (mem.history.length > HISTORY_MAX) { mem.history = mem.history.slice(0, HISTORY_MAX); changed = true; }
    if (changed) lsSet(LS_HISTORY, mem.history);
  }

  /**
   * Evaluate every enabled rule against a DerivedState. Uses opts.predict (or VOC.predict) when present.
   * @param {object} derived store.derived() shape (byDay, byWeek, records, allRecords, regulatory, now)
   * @param {{predict?:object}} [opts]
   * @returns {Array} Alert[] sorted by severity then recency
   */
  function evaluate(derived, opts) {
    const d = derived || {};
    const predict = (opts && opts.predict) || VOC.predict || null;
    const nowD = d.now ? new Date(d.now) : nowDate();
    let out = [];
    rules().filter((r) => r.enabled).forEach((rule) => {
      let res = [];
      try {
        switch (rule.type) {
          case 'volume_zscore': res = evalVolume(rule, d, predict, nowD); break;
          case 'neg_share_zscore': res = evalNegShare(rule, d, predict, nowD); break;
          case 'emerging_unit': res = evalEmerging(rule, d, predict, nowD); break;
          case 'sentiment_drift': res = evalDrift(rule, d, predict, nowD); break;
          case 'p1_cluster': res = evalP1Cluster(rule, d, nowD); break;
          case 'ae_received': res = evalAe(rule, d); break;
          case 'food_safety_received': res = evalFoodSafety(rule, d); break;
          case 'sla_breach': res = evalSla(rule, d, nowD); break;
          default: res = [];
        }
      } catch (e) { res = []; }
      out = out.concat(res);
    });
    const seen = new Set();
    out = out.filter((a) => { if (seen.has(a.id)) return false; seen.add(a.id); return true; }).map((a) => decorate(a, nowD));
    linkRelated(out);
    out.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    recordHistory(out, nowD.toISOString());
    mem.last = out;
    return out.map((a) => clone(a));
  }
  /** Alerts from the last evaluate() that are neither acknowledged nor snoozed. */
  function active() {
    const nowD = nowDate();
    return mem.last.map((a) => decorate(clone(a), nowD)).filter((a) => !a.acked && !a.snoozedUntil);
  }
  /** Append-only record of every alert seen, newest first. */
  function history() { return clone(mem.history); }
  function ack(id) {
    if (!id) return false;
    mem.state.acked[id] = nowDate().toISOString();
    lsSet(LS_STATE, mem.state);
    return true;
  }
  function unack(id) {
    if (!mem.state.acked[id]) return false;
    delete mem.state.acked[id];
    lsSet(LS_STATE, mem.state);
    return true;
  }
  /**
   * Hide an alert until now + hours.
   * @returns {string|null} snoozedUntil ISO
   */
  function snooze(id, hours) {
    if (!id) return null;
    const h = isNum(hours) && hours > 0 ? hours : 24;
    const until = new Date(nowDate().getTime() + h * HOUR_MS).toISOString();
    mem.state.snoozed[id] = until;
    lsSet(LS_STATE, mem.state);
    return until;
  }
  /** Drop ack/snooze state and history (used by store.resetDemo through localStorage keys, and by Settings). */
  function reset() {
    mem.overrides = {};
    mem.state = { acked: {}, snoozed: {} };
    mem.history = [];
    mem.last = [];
    [LS_RULES, LS_STATE, LS_HISTORY].forEach((k) => { if (typeof localStorage !== 'undefined') { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } } });
  }

  VOC.alerts = { defaultRules, rules, setRule, evaluate, active, history, ack, unack, snooze, reset };
})();
