/* L-Nutra Voice of the Customer — analytics.js (SPEC §4.6)
 * VOC.metrics  : metric registry, compute(), series()
 * VOC.analytics: bucketing, heatmap, share of voice, theme impact, segments,
 *                components, lots, HCP rollup, cohorts, resolution distribution,
 *                text mining (n-grams, KWIC, distinctive terms, stemmer, cosine)
 *
 * PURE module: no DOM, no storage, no Chart access. Loads under jsc.
 * Uses VOC.util helpers when present and falls back to private equivalents.
 * Every metric returns { value:number|null, n:number, interval?:{lo,hi}, extra? }
 * and never emits NaN or undefined in a value slot.
 */
(function () {
  'use strict';

  window.VOC = window.VOC || {};

  var TZ = 'America/Chicago';
  var MS_HOUR = 3600000;
  var MS_DAY = 86400000;
  var DEFAULT_SLA = { P0: 1, P1: 4, P2: 24, P3: 72 };
  var OPEN_STATUSES = { new: 1, open: 1, pending: 1, reopened: 1, escalated: 1 };
  var COMPLAINT_CATEGORIES = ['subscription_billing', 'checkout_website', 'shipping_fulfillment', 'missing_damaged',
    'taste_quality', 'foreign_material_allergen', 'side_effects', 'adverse_event', 'customer_service', 'price_value'];
  var COMPLAINT_SET = {};
  COMPLAINT_CATEGORIES.forEach(function (c) { COMPLAINT_SET[c] = true; });

  /* ------------------------------------------------------------------ */
  /* util access + fallbacks                                             */
  /* ------------------------------------------------------------------ */

  function util() { return (typeof VOC !== 'undefined' && VOC.util) ? VOC.util : null; }
  function ustat(name) { var u = util(); return (u && u.stats && typeof u.stats[name] === 'function') ? u.stats[name] : null; }
  function ufn(name) { var u = util(); return (u && typeof u[name] === 'function') ? u[name] : null; }

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function safe(x) { return isNum(x) ? x : null; }
  function toMs(iso) {
    if (iso == null) return null;
    var t = (iso instanceof Date) ? iso.getTime() : Date.parse(iso);
    return isFinite(t) ? t : null;
  }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  var DOW_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  var partsFormatter = null;
  function localParts(iso) {
    var ms = toMs(iso);
    if (ms == null) return null;
    if (!partsFormatter) {
      partsFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
      });
    }
    var out = {};
    partsFormatter.formatToParts(new Date(ms)).forEach(function (p) { out[p.type] = p.value; });
    var hour = parseInt(out.hour, 10);
    if (hour === 24) hour = 0;
    return { y: parseInt(out.year, 10), m: parseInt(out.month, 10), d: parseInt(out.day, 10),
      dow: DOW_INDEX[out.weekday] != null ? DOW_INDEX[out.weekday] : 0, hour: hour, minute: parseInt(out.minute, 10) };
  }
  function parts(iso) {
    var f = ufn('parts');
    if (f) { var p = f(iso); if (p && isNum(p.y)) return p; }
    return localParts(iso);
  }
  function isoWeekOf(y, m, d) {
    var target = new Date(Date.UTC(y, m - 1, d));
    var dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    var isoYear = target.getUTCFullYear();
    var firstThu = new Date(Date.UTC(isoYear, 0, 4));
    var week = 1 + Math.round(((target - firstThu) / MS_DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return isoYear + '-W' + pad2(week);
  }
  function dayKey(iso) {
    var f = ufn('dayKey'); if (f) return f(iso);
    var p = localParts(iso); return p ? p.y + '-' + pad2(p.m) + '-' + pad2(p.d) : null;
  }
  function weekKey(iso) {
    var f = ufn('weekKey'); if (f) return f(iso);
    var p = localParts(iso); return p ? isoWeekOf(p.y, p.m, p.d) : null;
  }
  function monthKey(iso) {
    var f = ufn('monthKey'); if (f) return f(iso);
    var p = localParts(iso); return p ? p.y + '-' + pad2(p.m) : null;
  }
  /** Monday (ISO date) of an ISO week key. */
  function weekStart(wk) {
    var f = ufn('weekStart'); if (f) return f(wk);
    var m = /^(\d{4})-W(\d{2})$/.exec(wk);
    if (!m) return null;
    var isoYear = +m[1], week = +m[2];
    var jan4 = new Date(Date.UTC(isoYear, 0, 4));
    var monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * MS_DAY + (week - 1) * 7 * MS_DAY);
    return monday.toISOString().slice(0, 10);
  }
  function addDays(isoDate, n) {
    var f = ufn('addDays'); if (f) return f(isoDate, n);
    var t = Date.parse(isoDate.slice(0, 10) + 'T00:00:00Z') + n * MS_DAY;
    return new Date(t).toISOString().slice(0, 10);
  }
  function addMonths(ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + pad2(m + 1);
  }
  function daysInMonth(ym) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  function keyToDate(key) {
    if (/^\d{4}-W\d{2}$/.test(key)) return weekStart(key);
    if (/^\d{4}-\d{2}$/.test(key)) return key + '-01';
    return key;
  }
  function keyToBounds(key) {
    if (/^\d{4}-W\d{2}$/.test(key)) { var ws = weekStart(key); return { from: ws, to: addDays(ws, 6) }; }
    if (/^\d{4}-\d{2}$/.test(key)) return { from: key + '-01', to: key + '-' + pad2(daysInMonth(key)) };
    return { from: key, to: key };
  }
  function nextKey(key, gran) {
    if (gran === 'week') return weekKey(addDays(weekStart(key), 7) + 'T12:00:00Z');
    if (gran === 'month') return addMonths(key, 1);
    return addDays(key, 1);
  }
  /** Calendar key (day/week/month) of a record in CT, using derived keys when present. */
  function recordKey(rec, gran) {
    if (gran === 'week') return rec.week_key || weekKey(rec.received_at);
    if (gran === 'month') return rec.month_key || monthKey(rec.received_at);
    return rec.day_key || dayKey(rec.received_at);
  }
  /** Key of an ISO date/datetime for the granularity. Dates are read as noon CT to avoid boundary drift. */
  function keyOfDate(iso, gran) {
    var s = String(iso);
    if (s.length === 10) s = s + 'T18:00:00Z';
    if (gran === 'week') return weekKey(s);
    if (gran === 'month') return monthKey(s);
    return dayKey(s);
  }

  /* stats fallbacks */
  function mean(a) {
    var f = ustat('mean'); if (f) { var v = f(a); return isNum(v) ? v : null; }
    if (!a.length) return null;
    var s = 0; for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  function std(a) {
    if (a.length < 2) return null;
    var f = ustat('std'); if (f) { var v = f(a); return isNum(v) ? v : null; }
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }
  function percentile(a, p) {
    if (!a.length) return null;
    var f = ustat('percentile'); if (f) { var v = f(a, p); return isNum(v) ? v : null; }
    var s = a.slice().sort(function (x, y) { return x - y; });
    var idx = (s.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }
  function median(a) { return percentile(a, 0.5); }
  /** Wilson score interval for k successes out of n, as proportions 0..1. */
  function wilson(k, n, z) {
    z = z || 1.96;
    if (!isNum(n) || n <= 0) return null;
    var f = ustat('wilson');
    if (f) { var w = f(k, n, z); if (w && isNum(w.lo) && isNum(w.hi)) return { lo: w.lo, hi: w.hi }; }
    var z2 = z * z, center = (k + z2 / 2) / (n + z2);
    var half = z * Math.sqrt((k * (n - k)) / n + z2 / 4) / (n + z2);
    return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
  }
  /** Poisson interval on a count (Byar approximation when util lacks poissonExact). */
  function poissonInterval(k, z) {
    z = z || 1.96;
    var f = ustat('poissonExact');
    if (f) { var p = f(k, z); if (p && isNum(p.lo) && isNum(p.hi)) return { lo: p.lo, hi: p.hi }; }
    var lo = k === 0 ? 0 : k * Math.pow(1 - 1 / (9 * k) - z / (3 * Math.sqrt(k)), 3);
    var k1 = k + 1;
    var hi = k1 * Math.pow(1 - 1 / (9 * k1) + z / (3 * Math.sqrt(k1)), 3);
    return { lo: Math.max(0, lo), hi: hi };
  }
  function scaleInterval(iv, factor) {
    if (!iv) return undefined;
    return { lo: safe(iv.lo * factor), hi: safe(iv.hi * factor) };
  }
  /** Proportion metric (0–100) with a Wilson interval. */
  function rate(k, n, factor) {
    factor = factor || 100;
    if (!isNum(n) || n <= 0) return { value: null, n: isNum(n) ? n : 0 };
    return { value: (k / n) * factor, n: n, interval: scaleInterval(wilson(k, n), factor) };
  }
  /** Mean with a normal-approximation interval. */
  function meanResult(values) {
    var n = values.length;
    if (!n) return { value: null, n: 0 };
    var m = mean(values), sd = std(values);
    var out = { value: safe(m), n: n };
    if (sd != null && n > 1) out.interval = { lo: m - 1.96 * sd / Math.sqrt(n), hi: m + 1.96 * sd / Math.sqrt(n) };
    return out;
  }

  /* text fallbacks */
  var LOCAL_STOPWORDS = ('a about above after again against all am an and any are aren\'t as at be because been before being ' +
    'below between both but by can cannot can\'t could couldn\'t did didn\'t do does doesn\'t doing don\'t down during each few for from ' +
    'further had hadn\'t has hasn\'t have haven\'t having he he\'d he\'ll he\'s her here here\'s hers herself him himself his how how\'s ' +
    'i i\'d i\'ll i\'m i\'ve if in into is isn\'t it it\'s its itself let\'s me more most mustn\'t my myself no nor not of off on once ' +
    'only or other ought our ours ourselves out over own same shan\'t she she\'d she\'ll she\'s should shouldn\'t so some such than ' +
    'that that\'s the their theirs them themselves then there there\'s these they they\'d they\'ll they\'re they\'ve this those through ' +
    'to too under until up very was wasn\'t we we\'d we\'ll we\'re we\'ve were weren\'t what what\'s when when\'s where where\'s which ' +
    'while who who\'s whom why why\'s with won\'t would wouldn\'t you you\'d you\'ll you\'re you\'ve your yours yourself yourselves ' +
    'also just get got getting gets like one two will would can may might still even much many ' +
    'hi hello hey dear thanks thank please regards sincerely best team kind ok okay yes yeah well really ' +
    'im ive dont didnt cant wont isnt doesnt').split(' ');
  var stopwordCache = null, stopwordSource = null;
  function stopwords() {
    var lex = (typeof VOC !== 'undefined' && VOC.lexicon && Array.isArray(VOC.lexicon.STOPWORDS)) ? VOC.lexicon.STOPWORDS : null;
    var src = lex || LOCAL_STOPWORDS;
    if (stopwordCache && stopwordSource === src) return stopwordCache;
    stopwordCache = {};
    src.forEach(function (w) { stopwordCache[String(w).toLowerCase()] = true; });
    stopwordSource = src;
    return stopwordCache;
  }
  function tokenize(text) {
    var f = ufn('tokenize'); if (f) return f(text || '');
    var m = String(text || '').toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
    return m.filter(function (t) { return t.length >= 2; });
  }
  function sentences(text) {
    var f = ufn('sentences'); if (f) return f(text || '');
    var m = String(text || '').match(/[^.!?\n]+[.!?]*/g) || [];
    return m.map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function contentTokens(text) {
    var sw = stopwords();
    return tokenize(text).filter(function (t) { return !sw[t]; });
  }

  /* ---- text-mining hygiene: signature / boilerplate words, sender and agent names, quoted-reply tails ---- */
  /** Analytics-local stopwords for email boilerplate; applied on top of the lexicon stopwords in ngrams and distinctiveTerms only. */
  var BOILERPLATE_STOPWORDS = {};
  ('care prolonlife lnutra nutra wrote regards sincerely cheers warmly cordially sent from reaching original forwarded ' +
    'iphone ipad android outlook gmail yahoo www http https com mailto re fw fwd ' +
    'pm am wed thu fri sat sun mon tue jan feb mar apr jun jul aug sep sept oct nov dec ' +
    'hi hello hey dear thanks thank please best kind team greetings').split(' ').forEach(function (w) { BOILERPLATE_STOPWORDS[w] = true; });
  /** Whole n-grams that are boilerplate even when their tokens survive (kept lowercase, single-spaced). */
  var BOILERPLATE_GRAMS = {};
  ['customer care', 'l nutra', 'nutra customer', 'reaching out', 'sent from', 'original message', 'best regards', 'kind regards', 'thank you', 'thanks reaching', 'customer life']
    .forEach(function (g) { BOILERPLATE_GRAMS[g] = true; });
  var RE_QUOTED_TAIL = /wrote:\s*$|-{2,}\s*Original Message|^Sent from (?:my |Mail|Outlook|Yahoo Mail)|^-- ?$|^From: [^\n]+\n(?:Sent|Date): /mi;
  var agentCache = { src: null, tokens: null };

  function nameTokens(name) {
    return tokenize(String(name || '').replace(/[^A-Za-z' -]/g, ' ')).filter(function (t) { return /^[a-z']+$/.test(t); });
  }
  /**
   * Agent first/last-name tokens: opts.agents, else VOC_SEED.meta.agents, else VOC.store settings.agents.
   * @param {string[]} [agents]
   * @returns {Object<string,true>}
   */
  function agentTokenSet(agents) {
    var src = Array.isArray(agents) ? agents : null;
    if (!src && typeof window !== 'undefined' && window.VOC_SEED && window.VOC_SEED.meta && Array.isArray(window.VOC_SEED.meta.agents)) src = window.VOC_SEED.meta.agents;
    if (!src && typeof VOC !== 'undefined' && VOC.store && typeof VOC.store.settings === 'function') {
      try { var s = VOC.store.settings(); if (s && Array.isArray(s.agents)) src = s.agents; } catch (e) { src = null; }
    }
    src = src || [];
    if (agentCache.tokens && agentCache.src === src) return agentCache.tokens;
    var set = {};
    src.forEach(function (a) { nameTokens(a).forEach(function (t) { set[t] = true; }); });
    agentCache = { src: src, tokens: set };
    return set;
  }
  /** Per-record drop set: boilerplate words, agent names and the sender's own first/last name. */
  function dropSetFor(rec, agentTokens) {
    var drop = Object.assign({}, agentTokens);
    if (rec && rec.from_name) nameTokens(rec.from_name).forEach(function (t) { drop[t] = true; });
    return drop;
  }
  function isBoilerplateToken(t, drop) { return !!(BOILERPLATE_STOPWORDS[t] || (drop && drop[t])); }
  function contentTokensFor(text, drop) {
    var sw = stopwords();
    return tokenize(text).filter(function (t) { return !sw[t] && !isBoilerplateToken(t, drop); });
  }
  /**
   * Record text for mining: the subject, then the body with any quoted-reply tail or signature removed through
   * VOC.classify.preprocess (only when a marker is present; store-cleaned records skip the call).
   */
  /**
   * Records whose text may be mined: restricted (PHI-adjacent) records are skipped unless they arrive already redacted
   * (rec.redacted) or the caller passes {includeRestricted:true} because the restricted queue is open or redaction is off.
   */
  function minable(records, opts) {
    var include = !!(opts && opts.includeRestricted);
    return (records || []).filter(function (r) { return r && (include || !r.restricted || r.redacted); });
  }
  function miningText(rec, sep) {
    var body = rec && rec.text ? String(rec.text) : '';
    if (body && RE_QUOTED_TAIL.test(body) && typeof VOC !== 'undefined' && VOC.classify && typeof VOC.classify.preprocess === 'function') {
      try { var clean = VOC.classify.preprocess(body); if (clean && clean.trim()) body = clean; } catch (e) { /* keep the raw body */ }
    }
    return (rec && rec.subject ? String(rec.subject) + sep : '') + body;
  }

  /* record accessors (derived fields when present, local otherwise) */
  function nowMs(ctx) { return toMs(ctx && ctx.now) || Date.now(); }
  function isOpen(rec) { return rec.is_open != null ? !!rec.is_open : !!OPEN_STATUSES[rec.status]; }
  function ageHours(rec, ctx) {
    if (isNum(rec.age_hours)) return rec.age_hours;
    var r = toMs(rec.received_at); if (r == null) return null;
    return (nowMs(ctx) - r) / MS_HOUR;
  }
  function frtHours(rec) {
    if (isNum(rec.frt_hours)) return rec.frt_hours;
    if (rec.frt_hours === null && rec.first_response_at == null) return null;
    var a = toMs(rec.received_at), b = toMs(rec.first_response_at);
    return (a == null || b == null) ? null : Math.max(0, (b - a) / MS_HOUR);
  }
  function resolutionHours(rec) {
    if (isNum(rec.resolution_hours)) return rec.resolution_hours;
    var a = toMs(rec.received_at), b = toMs(rec.resolved_at);
    return (a == null || b == null) ? null : Math.max(0, (b - a) / MS_HOUR);
  }
  function slaHours(rec, ctx) {
    var table = (ctx && ctx.sla) || DEFAULT_SLA;
    if (isNum(table[rec.urgency])) return table[rec.urgency];
    if (isNum(rec.sla_frt_hours)) return rec.sla_frt_hours;
    return DEFAULT_SLA[rec.urgency] != null ? DEFAULT_SLA[rec.urgency] : DEFAULT_SLA.P2;
  }
  function sentimentLabel(rec) {
    if (rec.sentiment_label) return rec.sentiment_label;
    if (!isNum(rec.sentiment)) return 'unscored';
    return rec.sentiment >= 0.15 ? 'positive' : rec.sentiment <= -0.15 ? 'negative' : 'neutral';
  }
  function isScored(rec) { return isNum(rec.sentiment) && sentimentLabel(rec) !== 'unscored'; }
  function isComplaint(rec) {
    if (rec.is_complaint != null) return !!rec.is_complaint;
    return (isNum(rec.sentiment) && rec.sentiment < -0.1) || !!COMPLAINT_SET[rec.category];
  }
  function hasNps(rec) { return isNum(rec.nps); }
  function isDetractor(rec) { return rec.is_detractor != null ? !!rec.is_detractor : (hasNps(rec) && rec.nps <= 6); }
  function isPromoter(rec) { return rec.is_promoter != null ? !!rec.is_promoter : (hasNps(rec) && rec.nps >= 9); }
  function threadOf(rec) { return rec.thread_id || rec.id; }
  function customerOf(rec) { return rec.customer_id || rec.from_email || null; }

  function npsOf(records) {
    var n = 0, p = 0, d = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!hasNps(r)) continue;
      n++;
      if (isPromoter(r)) p++; else if (isDetractor(r)) d++;
    }
    if (!n) return { value: null, n: 0 };
    var ps = p / n, ds = d / n, v = (ps - ds) * 100;
    var moe = 1.96 * Math.sqrt(Math.max(0, ps + ds - (ps - ds) * (ps - ds)) / n) * 100;
    return { value: v, n: n, interval: { lo: Math.max(-100, v - moe), hi: Math.min(100, v + moe) }, extra: { promoters: p, detractors: d, passives: n - p - d } };
  }
  function netSentimentOf(records) {
    var n = 0, pos = 0, neg = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!isScored(r)) continue;
      n++;
      if (r.sentiment >= 0.05) pos++; else if (r.sentiment <= -0.05) neg++;
    }
    if (!n) return { value: null, n: 0 };
    var ps = pos / n, ns = neg / n, v = (ps - ns) * 100;
    var moe = 1.96 * Math.sqrt(Math.max(0, ps + ns - (ps - ns) * (ps - ns)) / n) * 100;
    return { value: v, n: n, interval: { lo: Math.max(-100, v - moe), hi: Math.min(100, v + moe) }, extra: { positive: pos, negative: neg } };
  }
  /** Customers with ≥2 threads / customers with ≥1 thread (as a rate result). */
  function repeatContactOf(records) {
    var threads = new Map();
    records.forEach(function (r) {
      var c = customerOf(r); if (!c) return;
      if (!threads.has(c)) threads.set(c, new Set());
      threads.get(c).add(threadOf(r));
    });
    var k = 0;
    threads.forEach(function (set) { if (set.size >= 2) k++; });
    return rate(k, threads.size, 100);
  }

  /* orders */
  function monthsBetween(fromIso, toIso) {
    var out = [], cur = String(fromIso).slice(0, 7), end = String(toIso).slice(0, 7);
    var guard = 0;
    while (cur <= end && guard++ < 600) { out.push(cur); cur = addMonths(cur, 1); }
    return out;
  }
  /**
   * Orders in [from, to] (ISO dates, inclusive) for a product (or _total), prorated by
   * days of overlap in partial months. Returns null when any month in range is missing.
   */
  function ordersInRange(orders, fromIso, toIso, product) {
    if (!orders || !fromIso || !toIso) return null;
    var table = orders[product || '_total'];
    if (!table) return null;
    var from = String(fromIso).slice(0, 10), to = String(toIso).slice(0, 10);
    if (from > to) return null;
    var months = monthsBetween(from, to), sum = 0;
    for (var i = 0; i < months.length; i++) {
      var ym = months[i];
      if (!isNum(table[ym])) return null;
      var dim = daysInMonth(ym);
      var mStart = ym + '-01', mEnd = ym + '-' + pad2(dim);
      var oStart = from > mStart ? from : mStart, oEnd = to < mEnd ? to : mEnd;
      var days = Math.round((Date.parse(oEnd + 'T00:00:00Z') - Date.parse(oStart + 'T00:00:00Z')) / MS_DAY) + 1;
      sum += table[ym] * (days / dim);
    }
    return sum;
  }
  function ctxOrders(ctx, product) {
    if (!ctx) return null;
    if (typeof ctx.ordersInRange === 'function') {
      var v = ctx.ordersInRange(ctx.from, ctx.to, product || null);
      return isNum(v) ? v : null;
    }
    return ordersInRange(ctx.orders, ctx.from, ctx.to, product);
  }
  function perOrders(k, ctx, factor, intervalKind) {
    var orders = ctxOrders(ctx, null);
    if (!isNum(orders) || orders <= 0) return { value: null, n: 0, extra: { orders: null, count: k } };
    var out = { value: (k / orders) * factor, n: Math.round(orders), extra: { orders: orders, count: k } };
    if (intervalKind === 'poisson') out.interval = scaleInterval(poissonInterval(k), factor / orders);
    else out.interval = scaleInterval(wilson(Math.min(k, orders), orders), factor);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* VOC.metrics                                                          */
  /* ------------------------------------------------------------------ */

  function def(id, label, unit, direction, formula, compute) {
    return { id: id, label: label, unit: unit, direction: direction, formula: formula, compute: compute };
  }

  var registry = {};
  [
    def('volume', 'Volume', 'count', 'neutral', 'count(records)', function (records) {
      return { value: records.length, n: records.length };
    }),
    def('contact_rate', 'Contact rate', 'pct', 'down_good', 'records / orders × 100', function (records, ctx) {
      return perOrders(records.length, ctx, 100, 'wilson');
    }),
    def('complaints_per_1k', 'Complaints per 1k orders', 'per_1k', 'down_good', 'complaints / orders × 1000', function (records, ctx) {
      return perOrders(records.filter(isComplaint).length, ctx, 1000, 'wilson');
    }),
    def('sentiment_index', 'Sentiment index', 'pts', 'up_good', 'mean((s+1)/2×100)', function (records) {
      var vals = [];
      records.forEach(function (r) { if (isScored(r)) vals.push(isNum(r.sentiment_index) ? r.sentiment_index : (r.sentiment + 1) / 2 * 100); });
      return meanResult(vals);
    }),
    def('net_sentiment', 'Net sentiment', 'pct', 'up_good', '%pos(s≥0.05) − %neg(s≤−0.05)', function (records) {
      return netSentimentOf(records);
    }),
    def('nps', 'NPS', 'score', 'up_good', '%9–10 − %0–6', function (records) {
      return npsOf(records);
    }),
    def('csat', 'CSAT', 'pct', 'up_good', '% of csat ∈ {4,5}', function (records) {
      var n = 0, k = 0;
      records.forEach(function (r) { if (isNum(r.csat)) { n++; if (r.csat >= 4) k++; } });
      return rate(k, n, 100);
    }),
    def('rating_mean', 'Mean rating', 'score', 'up_good', 'mean(rating)', function (records) {
      var vals = [];
      records.forEach(function (r) { if (isNum(r.rating)) vals.push(r.rating); });
      return meanResult(vals);
    }),
    def('frt_median', 'First response (median)', 'hours', 'down_good', 'median(first_response_at − received_at)', function (records) {
      var vals = [];
      records.forEach(function (r) { var h = frtHours(r); if (isNum(h)) vals.push(h); });
      if (!vals.length) return { value: null, n: 0 };
      return { value: safe(median(vals)), n: vals.length, extra: { p25: safe(percentile(vals, 0.25)), p75: safe(percentile(vals, 0.75)) } };
    }),
    def('frt_sla_pct', 'First response within SLA', 'pct', 'up_good', '% with frt ≤ SLA[urgency]', function (records, ctx) {
      // Denominator: records with a first response, plus OPEN records still unanswered past their SLA (certain misses).
      // Closed records that never carried a first response (imported reviews, surveys, social posts, tickets whose
      // service fields were unavailable) have no defined FRT and stay out of both numerator and denominator.
      var n = 0, k = 0;
      records.forEach(function (r) {
        var h = frtHours(r), sla = slaHours(r, ctx);
        if (isNum(h)) { n++; if (h <= sla) k++; return; }
        if (r.first_response_at != null || !isOpen(r)) return;
        var age = ageHours(r, ctx);
        if (isNum(age) && age > sla) n++;
      });
      return rate(k, n, 100);
    }),
    def('resolution_median', 'Resolution time (median)', 'hours', 'down_good', 'median(resolved_at − received_at)', function (records) {
      var vals = [];
      records.forEach(function (r) { var h = resolutionHours(r); if (isNum(h)) vals.push(h); });
      if (!vals.length) return { value: null, n: 0 };
      return { value: safe(median(vals)), n: vals.length };
    }),
    def('resolution_p90', 'Resolution time (p90)', 'hours', 'down_good', 'p90(resolved_at − received_at)', function (records) {
      var vals = [];
      records.forEach(function (r) { var h = resolutionHours(r); if (isNum(h)) vals.push(h); });
      if (!vals.length) return { value: null, n: 0 };
      return { value: safe(percentile(vals, 0.9)), n: vals.length };
    }),
    def('reopen_rate', 'Reopen rate', 'pct', 'down_good', 'reopened / resolved', function (records) {
      var n = 0, k = 0;
      records.forEach(function (r) {
        var everResolved = r.resolved_at != null || r.status === 'resolved' || r.status === 'reopened';
        if (!everResolved) return;
        n++;
        if ((isNum(r.reopen_count) && r.reopen_count > 0) || r.status === 'reopened') k++;
      });
      return rate(k, n, 100);
    }),
    def('escalation_rate', 'Escalation rate', 'pct', 'down_good', 'escalated / total', function (records) {
      var k = records.filter(function (r) { return r.status === 'escalated' || (r.escalated_to && r.escalated_to !== 'none'); }).length;
      return rate(k, records.length, 100);
    }),
    def('repeat_contact_rate', 'Repeat contact rate', 'pct', 'down_good', 'customers with ≥2 threads in range / customers with ≥1', function (records) {
      return repeatContactOf(records);
    }),
    def('detractor_recovery', 'Detractor recovery', 'pct', 'up_good', 'detractors with recovered=true / detractors with recovered ≠ null', function (records) {
      var n = 0, k = 0;
      records.forEach(function (r) {
        if (!isDetractor(r) || r.recovered == null) return;
        n++; if (r.recovered === true) k++;
      });
      return rate(k, n, 100);
    }),
    def('ae_rate', 'Adverse events per 10k orders', 'per_10k', 'down_good', 'AE records / orders × 10,000', function (records, ctx) {
      return perOrders(records.filter(function (r) { return !!r.is_adverse_event; }).length, ctx, 10000, 'poisson');
    }),
    def('backlog_48h', 'Backlog older than 48h', 'count', 'down_good', 'open with age > 48h', function (records, ctx) {
      var open = records.filter(isOpen);
      var k = open.filter(function (r) { var a = ageHours(r, ctx); return isNum(a) && a > 48; }).length;
      return { value: k, n: open.length };
    }),
    def('open_p0_p1', 'Open P0/P1', 'count', 'down_good', 'open ∧ urgency ∈ {P0, P1}', function (records) {
      var open = records.filter(isOpen);
      var k = open.filter(function (r) { return r.urgency === 'P0' || r.urgency === 'P1'; }).length;
      return { value: k, n: open.length, extra: { p0: open.filter(function (r) { return r.urgency === 'P0'; }).length } };
    }),
    def('sla_breached', 'SLA breached (open)', 'count', 'down_good', 'open ∧ no first response ∧ age > SLA', function (records, ctx) {
      var open = records.filter(isOpen);
      var k = open.filter(function (r) {
        if (r.first_response_at != null) return false;
        if (r.sla_frt_breached != null && ctx && !ctx.sla) return !!r.sla_frt_breached;
        var a = ageHours(r, ctx); return isNum(a) && a > slaHours(r, ctx);
      }).length;
      return { value: k, n: open.length };
    }),
    def('unassigned', 'Unassigned (open)', 'count', 'down_good', 'open ∧ assignee null', function (records) {
      var open = records.filter(isOpen);
      return { value: open.filter(function (r) { return r.assignee == null || r.assignee === ''; }).length, n: open.length };
    }),
    def('needs_review_pct', 'Needs review', 'pct', 'down_good', 'classifier.needs_review / total × 100', function (records) {
      var k = records.filter(function (r) { return !!(r.classifier && r.classifier.needs_review); }).length;
      return rate(k, records.length, 100);
    }),
    def('revenue_at_risk', 'Subscription revenue at risk', 'usd', 'down_good', 'Σ churn_score/100 × subscription_value_12m over subscribers', function (records, ctx) {
      var customers = asMap(ctx && ctx.customers, 'customer_id');
      var seen = new Map();
      records.forEach(function (r) {
        var cid = customerOf(r); if (!cid) return;
        var cust = customers.get(cid) || null;
        var score = isNum(r.churn_score) ? r.churn_score : (cust && isNum(cust.churn_score) ? cust.churn_score : null);
        var prev = seen.get(cid);
        if (!prev || (isNum(score) && (!isNum(prev.score) || score > prev.score))) seen.set(cid, { cust: cust, score: score });
      });
      var sum = 0, n = 0;
      seen.forEach(function (e) {
        var c = e.cust;
        var isSub = c ? (c.subscriber === true || c.subscription_status === 'active' || c.subscription_status === 'paused') : false;
        if (!isSub || !isNum(c.subscription_value_12m_usd) || !isNum(e.score)) return;
        n++; sum += (e.score / 100) * c.subscription_value_12m_usd;
      });
      var out = n ? { value: sum, n: n } : { value: null, n: 0 };
      // The store names the churn model behind churn_score ('fitted' | 'heuristic') so narration can say which one priced the risk.
      if (ctx && typeof ctx.churnMethod === 'string') out.extra = { method: ctx.churnMethod, customers: n };
      return out;
    })
  ].forEach(function (m) { registry[m.id] = m; });

  function asMap(coll, keyField) {
    if (!coll) return new Map();
    if (coll instanceof Map) return coll;
    var m = new Map();
    if (Array.isArray(coll)) coll.forEach(function (x) { if (x && x[keyField] != null) m.set(x[keyField], x); });
    else Object.keys(coll).forEach(function (k) { m.set(k, coll[k]); });
    return m;
  }

  function recordRange(records) {
    var lo = null, hi = null;
    for (var i = 0; i < records.length; i++) {
      var t = toMs(records[i].received_at); if (t == null) continue;
      if (lo == null || t < lo) lo = t;
      if (hi == null || t > hi) hi = t;
    }
    return lo == null ? null : { from: new Date(lo).toISOString(), to: new Date(hi).toISOString() };
  }
  function normalizeCtx(ctx, records) {
    var c = Object.assign({}, ctx || {});
    if (!c.now) c.now = new Date().toISOString();
    if (!c.from || !c.to) {
      var r = recordRange(records || []);
      if (r) { c.from = c.from || dayKey(r.from); c.to = c.to || dayKey(r.to); }
    }
    return c;
  }
  function sanitize(res) {
    if (!res || typeof res !== 'object') return { value: null, n: 0 };
    var out = { value: safe(res.value), n: isNum(res.n) ? res.n : 0 };
    if (res.interval && isNum(res.interval.lo) && isNum(res.interval.hi)) out.interval = { lo: res.interval.lo, hi: res.interval.hi };
    if (res.extra) out.extra = res.extra;
    return out;
  }

  /**
   * Compute one registry metric over a record set.
   * @param {string} id registry id
   * @param {Object[]} records records (derived fields used when present)
   * @param {Object} [ctx] { now, from, to, orders, ordersInRange(from,to,product), customers, allRecords, sla }
   * @returns {{value:(number|null), n:number, interval?:{lo:number,hi:number}, extra?:Object}}
   */
  function compute(id, records, ctx) {
    var m = registry[id];
    records = Array.isArray(records) ? records : [];
    if (!m) return { value: null, n: 0 };
    return sanitize(m.compute(records, normalizeCtx(ctx, records)));
  }

  /**
   * Metric per calendar bucket over a complete, zero-filled range.
   * Rolling windows pool the trailing k buckets: count/usd metrics take the window mean,
   * every other metric is recomputed on the pooled records (so rates stay exact).
   * @param {string} id
   * @param {Object[]} records
   * @param {Object} ctx
   * @param {{granularity?:('day'|'week'|'month'), rolling?:(0|7|28)}} [opts]
   * @returns {Array<{key:string, value:(number|null), n:number, interval?:{lo:number,hi:number}}>}
   */
  function series(id, records, ctx, opts) {
    opts = opts || {};
    var gran = opts.granularity || 'day';
    var rolling = isNum(opts.rolling) ? Math.max(0, Math.floor(opts.rolling)) : 0;
    var m = registry[id];
    records = Array.isArray(records) ? records : [];
    var c = normalizeCtx(ctx, records);
    var buckets = bucket(records, gran, { from: c.from, to: c.to });
    if (!m) return buckets.map(function (b) { return { key: b.key, value: null, n: 0 }; });
    var averaging = m.unit === 'count' || m.unit === 'usd';
    var pointValues = [];
    // Edge buckets hold records only for the days inside the ctx range, so their order denominator (ctx.from/to →
    // ordersInRange) is clipped to the same days; a full calendar week of orders against three days of records
    // would understate contact_rate / complaints_per_1k / ae_rate on both ends of the series.
    var clipFrom = c.from ? String(c.from).slice(0, 10) : null, clipTo = c.to ? String(c.to).slice(0, 10) : null;
    function clipped(bounds) {
      return { from: clipFrom && bounds.from < clipFrom ? clipFrom : bounds.from, to: clipTo && bounds.to > clipTo ? clipTo : bounds.to };
    }
    return buckets.map(function (b, i) {
      var bounds = clipped(keyToBounds(b.key));
      var point = sanitize(m.compute(b.records, Object.assign({}, c, { from: bounds.from, to: bounds.to })));
      pointValues.push(point.value);
      if (rolling <= 1) return seriesPoint(b.key, point);
      var start = Math.max(0, i - rolling + 1);
      if (averaging) {
        var vals = pointValues.slice(start, i + 1).filter(isNum);
        return { key: b.key, value: vals.length ? mean(vals) : null, n: vals.length };
      }
      var pooled = [];
      for (var j = start; j <= i; j++) pooled = pooled.concat(buckets[j].records);
      return seriesPoint(b.key, sanitize(m.compute(pooled, Object.assign({}, c, { from: clipped(keyToBounds(buckets[start].key)).from, to: bounds.to }))));
    });
  }
  function seriesPoint(key, res) {
    var p = { key: key, value: res.value, n: res.n };
    if (res.interval) p.interval = res.interval;
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* VOC.analytics                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Group records into calendar buckets (America/Chicago), zero-filling the full range.
   * @param {Object[]} records
   * @param {'day'|'week'|'month'} gran
   * @param {{from?:string, to?:string}} [opts] optional ISO date bounds to extend the range
   * @returns {Array<{key:string,count:number,neg:number,pos:number,neu:number,meanSentiment:(number|null),records:Object[]}>}
   */
  function bucket(records, gran, opts) {
    gran = gran === 'week' || gran === 'month' ? gran : 'day';
    records = Array.isArray(records) ? records : [];
    var map = new Map(), minKey = null, maxKey = null;
    records.forEach(function (r) {
      var k = recordKey(r, gran); if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
      if (minKey == null || keyToDate(k) < keyToDate(minKey)) minKey = k;
      if (maxKey == null || keyToDate(k) > keyToDate(maxKey)) maxKey = k;
    });
    if (opts && opts.from) { var fk = keyOfDate(opts.from, gran); if (fk && (minKey == null || keyToDate(fk) < keyToDate(minKey))) minKey = fk; }
    if (opts && opts.to) { var tk = keyOfDate(opts.to, gran); if (tk && (maxKey == null || keyToDate(tk) > keyToDate(maxKey))) maxKey = tk; }
    var out = [];
    if (minKey == null) return out;
    var key = minKey, guard = 0, maxDate = keyToDate(maxKey);
    while (keyToDate(key) <= maxDate && guard++ < 20000) {
      out.push(summarizeBucket(key, map.get(key) || []));
      key = nextKey(key, gran);
    }
    return out;
  }
  function summarizeBucket(key, recs) {
    var neg = 0, pos = 0, neu = 0, sum = 0, scored = 0;
    recs.forEach(function (r) {
      var l = sentimentLabel(r);
      if (l === 'negative') neg++; else if (l === 'positive') pos++; else if (l === 'neutral') neu++;
      if (isScored(r)) { scored++; sum += r.sentiment; }
    });
    return { key: key, count: recs.length, neg: neg, pos: pos, neu: neu, meanSentiment: scored ? sum / scored : null, records: recs };
  }

  /**
   * Arrival heatmap by weekday (0=Mon) × hour (CT).
   * @returns {{matrix:number[][], sentiment:Array<Array<number|null>>, n:number}}
   */
  function heatmap(records) {
    var matrix = [], sums = [], counts = [], d, h;
    for (d = 0; d < 7; d++) { matrix.push([]); sums.push([]); counts.push([]); for (h = 0; h < 24; h++) { matrix[d].push(0); sums[d].push(0); counts[d].push(0); } }
    var n = 0;
    (records || []).forEach(function (r) {
      var dow = isNum(r.dow) ? r.dow : null, hour = isNum(r.hour) ? r.hour : null;
      if (dow == null || hour == null) { var p = parts(r.received_at); if (!p) return; dow = p.dow; hour = p.hour; }
      if (dow < 0 || dow > 6 || hour < 0 || hour > 23) return;
      matrix[dow][hour]++; n++;
      if (isScored(r)) { sums[dow][hour] += r.sentiment; counts[dow][hour]++; }
    });
    var sentiment = sums.map(function (row, i) { return row.map(function (s, j) { return counts[i][j] ? s / counts[i][j] : null; }); });
    return { matrix: matrix, sentiment: sentiment, n: n };
  }

  /**
   * Mention share vs order share per product; index = mentionShare / orderShare.
   * @param {Object[]} records
   * @param {Object} orders OrdersByMonth
   * @param {string} from ISO date
   * @param {string} to ISO date
   * @returns {Array<{product:string,mentions:number,mentionShare:number,orders:(number|null),orderShare:(number|null),index:(number|null)}>}
   */
  function shareOfVoice(records, orders, from, to) {
    var recs = records || [];
    var counts = new Map();
    var byMonth = new Map();       // month → { total, byProduct: Map }
    recs.forEach(function (r) {
      var p = r.product || 'general';
      counts.set(p, (counts.get(p) || 0) + 1);
      var mk = r.month_key || (r.received_at ? monthKey(r.received_at) : null);
      if (!mk) return;
      var m = byMonth.get(mk);
      if (!m) { m = { total: 0, byProduct: new Map() }; byMonth.set(mk, m); }
      m.total += 1;
      m.byProduct.set(p, (m.byProduct.get(p) || 0) + 1);
    });
    var total = recs.length;
    var rangeMonths = (from && to && String(from).slice(0, 10) <= String(to).slice(0, 10)) ? monthsBetween(String(from).slice(0, 10), String(to).slice(0, 10)) : [];
    var totalOrders = ordersInRange(orders, from, to, null);
    if (!isNum(totalOrders) && orders) {
      totalOrders = 0;
      Object.keys(orders).forEach(function (p) { if (p === '_total') return; var v = ordersInRange(orders, from, to, p); if (isNum(v)) totalOrders += v; });
      if (!totalOrders) totalOrders = null;
    }
    /** Months inside the range where this product has orders > 0 (null when the product has no order table). */
    function orderMonths(product) {
      var table = orders && orders[product];
      if (!table) return null;
      return rangeMonths.filter(function (ym) { return isNum(table[ym]) && table[ym] > 0; });
    }
    /** Prorated orders for a product (or _total) over a list of months, honoring the range edges. */
    function ordersOverMonths(product, months) {
      var sum = 0;
      for (var i = 0; i < months.length; i++) {
        var ym = months[i];
        var dim = daysInMonth(ym);
        var mStart = ym + '-01', mEnd = ym + '-' + pad2(dim);
        var s = String(from).slice(0, 10) > mStart ? String(from).slice(0, 10) : mStart;
        var e = String(to).slice(0, 10) < mEnd ? String(to).slice(0, 10) : mEnd;
        var v = ordersInRange(orders, s, e, product);
        if (!isNum(v)) return null;
        sum += v;
      }
      return sum;
    }
    var rows = [];
    counts.forEach(function (mentions, product) {
      var o = ordersInRange(orders, from, to, product);
      var mentionShare = total ? mentions / total : 0;
      var orderShare = (isNum(o) && isNum(totalOrders) && totalOrders > 0) ? o / totalOrders : null;
      var months = orderMonths(product);
      var coverageMonths = months ? months.length : 0;
      var partial = !!(months && rangeMonths.length && coverageMonths > 0 && coverageMonths < rangeMonths.length);
      var row = { product: product, mentions: mentions, mentionShare: mentionShare, orders: isNum(o) ? o : null,
        orderShare: orderShare, index: null, partialCoverage: partial, coverageMonths: coverageMonths, rangeMonths: rangeMonths.length,
        coverage: null };
      if (!months || coverageMonths === 0 || !isNum(o) || o <= 0) {
        row.index = null;                                    // no order data for this product: an index would be meaningless
      } else if (partial) {
        // The product sold in only part of the range: compare its mention share and order share over those months only.
        var mentionsIn = 0, totalIn = 0;
        months.forEach(function (ym) { var m = byMonth.get(ym); if (m) { totalIn += m.total; mentionsIn += m.byProduct.get(product) || 0; } });
        var oIn = ordersOverMonths(product, months), tIn = ordersOverMonths(null, months);
        if (!isNum(tIn) || tIn <= 0) {
          tIn = 0;
          Object.keys(orders).forEach(function (p) { if (p === '_total') return; var v = ordersOverMonths(p, months); if (isNum(v)) tIn += v; });
        }
        var mShareIn = totalIn ? mentionsIn / totalIn : null;
        var oShareIn = (isNum(oIn) && isNum(tIn) && tIn > 0) ? oIn / tIn : null;
        row.coverage = { months: months.slice(), mentions: mentionsIn, mentionShare: mShareIn, orders: isNum(oIn) ? oIn : null, orderShare: oShareIn, n: totalIn };
        row.index = (mShareIn != null && oShareIn != null && oShareIn > 0) ? mShareIn / oShareIn : null;
      } else {
        row.index = (orderShare != null && orderShare > 0) ? mentionShare / orderShare : null;
      }
      rows.push(row);
    });
    return rows.sort(function (a, b) { return b.mentions - a.mentions; });
  }

  /**
   * NPS impact per category: NPS(all) − NPS(excluding records tagged with the category).
   * Uses records that carry an nps. Sorted most damaging first.
   * @returns {Array<{category:string,impact:(number|null),npsAll:(number|null),npsExcl:(number|null),n:number,nAll:number}>}
   */
  function themeImpact(records) {
    var scored = (records || []).filter(hasNps);
    var all = npsOf(scored);
    var cats = new Map();
    scored.forEach(function (r) {
      var tags = [r.category].concat(Array.isArray(r.secondary_categories) ? r.secondary_categories : []);
      var seen = {};
      tags.forEach(function (c) { if (!c || seen[c]) return; seen[c] = true; cats.set(c, (cats.get(c) || 0) + 1); });
    });
    var rows = [];
    cats.forEach(function (n, cat) {
      var excl = npsOf(scored.filter(function (r) {
        return r.category !== cat && !(Array.isArray(r.secondary_categories) && r.secondary_categories.indexOf(cat) >= 0);
      }));
      var impact = (all.value != null && excl.value != null) ? all.value - excl.value : null;
      rows.push({ category: cat, impact: safe(impact), npsAll: all.value, npsExcl: excl.value, n: n, nAll: all.n });
    });
    return rows.sort(function (a, b) { return (a.impact == null ? 1 : a.impact) - (b.impact == null ? 1 : b.impact); });
  }

  /**
   * Segment comparison: n, NPS, net sentiment, repeat-contact rate (all on 0–100 scales).
   * @returns {Array<{segment:string,n:number,nps:(number|null),npsN:number,netSentiment:(number|null),repeatRate:(number|null),customers:number}>}
   */
  function segmentCompare(records, customers) {
    var custMap = asMap(customers, 'customer_id');
    var groups = new Map();
    (records || []).forEach(function (r) {
      var seg = r.segment || (custMap.get(r.customer_id) || {}).segment || 'unknown';
      if (!groups.has(seg)) groups.set(seg, []);
      groups.get(seg).push(r);
    });
    var rows = [];
    groups.forEach(function (recs, seg) {
      var nps = npsOf(recs), ns = netSentimentOf(recs), rep = repeatContactOf(recs);
      rows.push({ segment: seg, n: recs.length, nps: nps.value, npsN: nps.n, netSentiment: ns.value, repeatRate: rep.value, customers: rep.n });
    });
    return rows.sort(function (a, b) { return b.n - a.n; });
  }

  /** Kit-component mentions with mean sentiment and negative share. */
  function componentMentions(records) {
    var groups = new Map();
    (records || []).forEach(function (r) {
      if (!r.kit_component) return;
      if (!groups.has(r.kit_component)) groups.set(r.kit_component, []);
      groups.get(r.kit_component).push(r);
    });
    var rows = [];
    groups.forEach(function (recs, comp) {
      var s = summarizeBucket(comp, recs);
      rows.push({ component: comp, count: recs.length, meanSentiment: s.meanSentiment, negShare: recs.length ? s.neg / recs.length : null });
    });
    return rows.sort(function (a, b) { return b.count - a.count; });
  }

  /** Lot × ISO-week count matrix; food-safety lots first. */
  function lotMatrix(records) {
    var lots = new Map();
    (records || []).forEach(function (r) {
      if (!r.lot_number) return;
      var lot = String(r.lot_number).trim().toUpperCase();
      if (!lots.has(lot)) lots.set(lot, { lot: lot, weeks: {}, total: 0, foodSafety: false, products: {} });
      var e = lots.get(lot), wk = recordKey(r, 'week');
      if (wk) e.weeks[wk] = (e.weeks[wk] || 0) + 1;
      e.total++;
      if (r.food_safety) e.foodSafety = true;
      if (r.product) e.products[r.product] = (e.products[r.product] || 0) + 1;
    });
    return Array.from(lots.values()).sort(function (a, b) {
      if (a.foodSafety !== b.foodSafety) return a.foodSafety ? -1 : 1;
      return b.total - a.total;
    });
  }

  /**
   * Practitioner practice rollup. Records link to a practice through their customer
   * (customer_id → practice_id) or through a matching hcp_code on any customer.
   * @returns {Array<{practice_id:string,name:string,records:number,negatives:number,nps:(number|null),npsN:number,evidenceRequests:number}>}
   */
  function hcpRollup(records, customers, practices) {
    var custMap = asMap(customers, 'customer_id'), pracMap = asMap(practices, 'practice_id');
    var byHcp = new Map();
    custMap.forEach(function (c) { if (c && c.hcp_code && c.practice_id && !byHcp.has(c.hcp_code)) byHcp.set(c.hcp_code, c.practice_id); });
    var groups = new Map();
    (records || []).forEach(function (r) {
      var c = custMap.get(r.customer_id);
      var pid = (c && c.practice_id) || (r.hcp_code && byHcp.get(r.hcp_code)) || null;
      if (!pid) return;
      if (!groups.has(pid)) groups.set(pid, []);
      groups.get(pid).push(r);
    });
    var rows = [];
    groups.forEach(function (recs, pid) {
      var p = pracMap.get(pid) || {}, nps = npsOf(recs);
      rows.push({ practice_id: pid, name: p.name || pid, type: p.type || null, region: p.region || null, records: recs.length,
        negatives: recs.filter(function (r) { return sentimentLabel(r) === 'negative'; }).length,
        nps: nps.value, npsN: nps.n,
        evidenceRequests: recs.filter(function (r) { return r.subcategory === 'evidence_request'; }).length });
    });
    return rows.sort(function (a, b) { return b.records - a.records; });
  }

  /**
   * First-contact-month cohorts. retention[k] = share of the cohort with any contact k months after
   * first contact (k=0 is 1). Months after the last observed month are null (unobservable).
   * @returns {{cohorts:Array<{month:string,size:number,retention:Array<number|null>}>}}
   */
  function cohorts(records) {
    var first = new Map(), months = new Map(), lastMonth = null;
    (records || []).forEach(function (r) {
      var cid = customerOf(r), mk = recordKey(r, 'month');
      if (!cid || !mk) return;
      if (lastMonth == null || mk > lastMonth) lastMonth = mk;
      if (!months.has(cid)) months.set(cid, new Set());
      months.get(cid).add(mk);
      var cur = first.get(cid);
      if (cur == null || mk < cur) first.set(cid, mk);
    });
    var cohortMap = new Map();
    first.forEach(function (mk, cid) {
      if (!cohortMap.has(mk)) cohortMap.set(mk, []);
      cohortMap.get(mk).push(cid);
    });
    var out = [];
    Array.from(cohortMap.keys()).sort().forEach(function (mk) {
      var ids = cohortMap.get(mk), retention = [];
      for (var k = 0; k < 6; k++) {
        var target = addMonths(mk, k);
        if (lastMonth != null && target > lastMonth) { retention.push(null); continue; }
        var hit = 0;
        ids.forEach(function (cid) { if (months.get(cid).has(target)) hit++; });
        retention.push(ids.length ? hit / ids.length : null);
      }
      out.push({ month: mk, size: ids.length, retention: retention });
    });
    return { cohorts: out };
  }

  var RES_BUCKETS = [
    { label: '<4h', max: 4 }, { label: '4–12h', max: 12 }, { label: '12–24h', max: 24 }, { label: '1–2d', max: 48 },
    { label: '2–4d', max: 96 }, { label: '4–7d', max: 168 }, { label: '7d+', max: Infinity }
  ];
  /** Resolution-hour histogram with p50/p75/p90. */
  function resolutionDistribution(records) {
    var vals = [];
    (records || []).forEach(function (r) { var h = resolutionHours(r); if (isNum(h)) vals.push(h); });
    var buckets = RES_BUCKETS.map(function (b) { return { label: b.label, count: 0 }; });
    vals.forEach(function (h) {
      for (var i = 0; i < RES_BUCKETS.length; i++) { if (h < RES_BUCKETS[i].max) { buckets[i].count++; return; } }
    });
    return { buckets: buckets, p50: safe(percentile(vals, 0.5)), p75: safe(percentile(vals, 0.75)), p90: safe(percentile(vals, 0.9)), n: vals.length };
  }

  /* ------------------------------------------------------------------ */
  /* text mining                                                          */
  /* ------------------------------------------------------------------ */

  var STEM_EXCEPTIONS = {};
  ('this was has his is us yes bus gas glass class less unless news always sometimes stress process access address business ' +
   'series species thing nothing something anything everything morning evening during bring ring king sing spring string wing ' +
   'need feed seed speed bleed indeed shed red bed wed used based sales ' +
   'shipping billing pricing fasting').split(' ').forEach(function (w) { STEM_EXCEPTIONS[w] = true; });

  /**
   * Light stemmer: strips s / es / ies / ed / ing when the remaining stem has ≥4 characters,
   * undoubles a trailing consonant after ed/ing, and skips a small exception list.
   * @param {string} token
   * @returns {string}
   */
  function stem(token) {
    var t = String(token || '').toLowerCase();
    if (STEM_EXCEPTIONS[t] || t.length < 5 || /(ss|us|is)$/.test(t)) return t;
    if (/ing$/.test(t) && t.length - 3 >= 4) return undouble(t.slice(0, -3));
    if (/ied$/.test(t) && t.length - 3 >= 3) return t.slice(0, -3) + 'y';
    if (/ed$/.test(t) && t.length - 2 >= 4) return undouble(t.slice(0, -2));
    if (/ies$/.test(t) && t.length - 3 >= 3) return t.slice(0, -3) + 'y';
    if (/(sh|ch|x|z)es$/.test(t)) return t.length - 2 >= 3 ? t.slice(0, -2) : t;
    if (/s$/.test(t) && t.length - 1 >= 4) return t.slice(0, -1);
    return t;
  }
  function undouble(s) {
    if (s.length >= 4 && s[s.length - 1] === s[s.length - 2] && !/[aeiouls]$/.test(s)) return s.slice(0, -1);
    return s;
  }

  /**
   * Sentence-bounded 1–3-grams over stopword-filtered tokens, counted once per record (df).
   * Bigrams are absorbed into a trigram that contains them when df(tri) ≥ 0.8·df(bi).
   * Email boilerplate (signature words, "customer care", quoted-reply tails via VOC.classify.preprocess), agent names
   * (opts.agents → VOC_SEED.meta.agents → store settings.agents) and each sender's own from_name tokens are dropped.
   * @param {Object[]} records
   * @param {{n?:number[], minDf?:number, top?:number, samples?:number, agents?:string[]}} [opts]
   * @returns {Array<{gram:string,size:number,df:number,meanSentiment:(number|null),negShare:(number|null),sampleIds:string[]}>}
   */
  function ngrams(records, opts) {
    opts = opts || {};
    var sizes = Array.isArray(opts.n) && opts.n.length ? opts.n : [1, 2, 3];
    var minDf = isNum(opts.minDf) ? opts.minDf : 3;
    var top = isNum(opts.top) ? opts.top : 30;
    var maxSamples = isNum(opts.samples) ? opts.samples : 5;
    var agentToks = agentTokenSet(opts.agents);
    var stats = new Map();
    minable(records, opts).forEach(function (r) {
      var seen = {};
      var drop = dropSetFor(r, agentToks);
      // sentences() splits on . ! ? and line breaks, so no gram spans a sentence boundary
      sentences(miningText(r, '. ')).forEach(function (sent) {
        var toks = contentTokensFor(sent, drop);
        sizes.forEach(function (k) {
          for (var i = 0; i + k <= toks.length; i++) {
            var g = toks.slice(i, i + k).join(' ');
            if (seen[g] || BOILERPLATE_GRAMS[g]) continue;
            seen[g] = true;
            var e = stats.get(g);
            if (!e) { e = { gram: g, size: k, df: 0, sum: 0, scored: 0, neg: 0, sampleIds: [] }; stats.set(g, e); }
            e.df++;
            if (isScored(r)) { e.scored++; e.sum += r.sentiment; }
            if (sentimentLabel(r) === 'negative') e.neg++;
            if (e.sampleIds.length < maxSamples && r.id != null) e.sampleIds.push(r.id);
          }
        });
      });
    });
    var rows = [];
    stats.forEach(function (e) { if (e.df >= minDf) rows.push(e); });
    var tris = rows.filter(function (e) { return e.size === 3; });
    var absorbed = {};
    tris.forEach(function (t) {
      var w = t.gram.split(' ');
      [w[0] + ' ' + w[1], w[1] + ' ' + w[2]].forEach(function (bi) {
        var b = stats.get(bi);
        if (b && b.df >= minDf && t.df >= 0.8 * b.df) absorbed[bi] = true;
      });
    });
    return rows.filter(function (e) { return !(e.size === 2 && absorbed[e.gram]); })
      .sort(function (a, b) { return b.df - a.df || b.size - a.size || (a.gram < b.gram ? -1 : 1); })
      .slice(0, top)
      .map(function (e) {
        return { gram: e.gram, size: e.size, df: e.df, meanSentiment: e.scored ? e.sum / e.scored : null,
          negShare: e.df ? e.neg / e.df : null, sampleIds: e.sampleIds };
      });
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /**
   * Keyword-in-context snippets: ±width characters around the term, bounded by the sentence.
   * One snippet per record, up to max.
   * @param {Object[]} records
   * @param {string} term word or phrase (case-insensitive, whole-word)
   * @param {{width?:number, max?:number}} [opts]
   * @returns {Array<{id:string, before:string, match:string, after:string}>}
   */
  function kwic(records, term, opts) {
    opts = opts || {};
    var width = isNum(opts.width) ? opts.width : 60;
    var max = isNum(opts.max) ? opts.max : 20;
    var t = String(term || '').trim();
    if (!t) return [];
    var re = new RegExp('(?:^|[^a-z0-9])(' + escapeRe(t).replace(/\s+/g, '\\s+') + ')(?![a-z0-9])', 'i');
    var out = [];
    records = minable(records, opts);
    for (var i = 0; i < records.length && out.length < max; i++) {
      var r = records[i];
      var sents = sentences(r.text || '');
      if (r.subject) sents.unshift(String(r.subject));
      for (var j = 0; j < sents.length; j++) {
        var m = re.exec(sents[j]);
        if (!m) continue;
        var start = m.index + m[0].length - m[1].length, end = start + m[1].length;
        var before = sents[j].slice(Math.max(0, start - width), start);
        var after = sents[j].slice(end, end + width);
        if (start - width > 0) before = '…' + before.replace(/^\S*\s/, '');
        if (end + width < sents[j].length) after = after.replace(/\s\S*$/, '') + '…';
        out.push({ id: r.id, before: before, match: m[1], after: after });
        break;
      }
    }
    return out;
  }

  function termCounts(records, agentToks) {
    var counts = new Map(), surfaces = new Map(), total = 0;
    var agents = agentToks || agentTokenSet();
    (records || []).forEach(function (r) {
      var drop = dropSetFor(r, agents);
      contentTokensFor(miningText(r, ' '), drop).forEach(function (tok) {
        if (!/[a-z]/.test(tok)) return;
        var s = stem(tok);
        counts.set(s, (counts.get(s) || 0) + 1); total++;
        if (!surfaces.has(s)) surfaces.set(s, new Map());
        var sm = surfaces.get(s); sm.set(tok, (sm.get(tok) || 0) + 1);
      });
    });
    return { counts: counts, surfaces: surfaces, total: total };
  }
  function topSurface(surfMap) {
    var best = null, bestN = -1;
    surfMap.forEach(function (n, tok) { if (n > bestN) { bestN = n; best = tok; } });
    return best;
  }

  /**
   * Distinctive terms between two record sets: weighted log-odds with an informative Dirichlet prior
   * (Monroe, Colaresi & Quinn 2008), ranked by z = δ/√(1/(y_a+α_w) + 1/(y_b+α_w)).
   * The prior is spread over terms by pooled frequency. By default alpha0 is the mean pseudo-count
   * per vocabulary term (total prior mass alpha0 × V), which keeps the prior informative on small
   * corpora; pass prior:'total' to read alpha0 as the total prior mass instead.
   * @param {Object[]} recordsA current set (rising terms are more frequent here)
   * @param {Object[]} recordsB comparison set
   * @param {{top?:number, alpha0?:number, minCount?:number, prior?:('per_term'|'total')}} [opts]
   * @returns {{rising:Array<{term:string,stem:string,z:number,a:number,b:number}>, falling:Array<Object>, nA:number, nB:number}}
   */
  function distinctiveTerms(recordsA, recordsB, opts) {
    opts = opts || {};
    var top = isNum(opts.top) ? opts.top : 15;
    var alpha0 = isNum(opts.alpha0) ? opts.alpha0 : 10;
    var minCount = isNum(opts.minCount) ? opts.minCount : 2;
    var agentToks = agentTokenSet(opts.agents);
    var A = termCounts(minable(recordsA, opts), agentToks), B = termCounts(minable(recordsB, opts), agentToks);
    var pooledTotal = A.total + B.total;
    if (!pooledTotal) return { rising: [], falling: [], nA: 0, nB: 0 };
    var vocab = new Set();
    A.counts.forEach(function (_, k) { vocab.add(k); });
    B.counts.forEach(function (_, k) { vocab.add(k); });
    var mass = opts.prior === 'total' ? alpha0 : alpha0 * vocab.size;
    var rows = [];
    vocab.forEach(function (w) {
      var ya = A.counts.get(w) || 0, yb = B.counts.get(w) || 0;
      if (ya + yb < minCount) return;
      var alpha = mass * (ya + yb) / pooledTotal;
      var la = Math.log((ya + alpha) / (A.total + mass - ya - alpha));
      var lb = Math.log((yb + alpha) / (B.total + mass - yb - alpha));
      var delta = la - lb;
      var variance = 1 / (ya + alpha) + 1 / (yb + alpha);
      var z = delta / Math.sqrt(variance);
      if (!isFinite(z)) return;
      var surf = topSurface(ya >= yb ? (A.surfaces.get(w) || B.surfaces.get(w)) : (B.surfaces.get(w) || A.surfaces.get(w)));
      rows.push({ term: surf || w, stem: w, z: z, a: ya, b: yb });
    });
    rows.sort(function (x, y) { return y.z - x.z; });
    var rising = rows.filter(function (r) { return r.z > 0; }).slice(0, top);
    var falling = rows.filter(function (r) { return r.z < 0; }).reverse().slice(0, top);
    return { rising: rising, falling: falling, nA: (recordsA || []).length, nB: (recordsB || []).length };
  }

  /**
   * Cosine similarity over stemmed, stopword-filtered term-frequency vectors.
   * @returns {number} 0..1 (0 when either text has no content tokens)
   */
  function cosine(textA, textB) {
    var va = new Map(), vb = new Map();
    contentTokens(textA).forEach(function (t) { var s = stem(t); va.set(s, (va.get(s) || 0) + 1); });
    contentTokens(textB).forEach(function (t) { var s = stem(t); vb.set(s, (vb.get(s) || 0) + 1); });
    if (!va.size || !vb.size) return 0;
    var dot = 0, na = 0, nb = 0;
    va.forEach(function (c, k) { na += c * c; if (vb.has(k)) dot += c * vb.get(k); });
    vb.forEach(function (c) { nb += c * c; });
    var denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom ? dot / denom : 0;
  }

  /* ------------------------------------------------------------------ */
  /* exports                                                              */
  /* ------------------------------------------------------------------ */

  VOC.metrics = {
    version: '1.0.0',
    registry: registry,
    ids: Object.keys(registry),
    compute: compute,
    series: series,
    /** Wilson interval on k/n (0..1). */
    wilson: wilson,
    /** Poisson interval on a count. */
    poissonInterval: poissonInterval,
    COMPLAINT_CATEGORIES: COMPLAINT_CATEGORIES
  };

  VOC.analytics = {
    version: '1.0.0',
    bucket: bucket,
    heatmap: heatmap,
    shareOfVoice: shareOfVoice,
    themeImpact: themeImpact,
    segmentCompare: segmentCompare,
    componentMentions: componentMentions,
    lotMatrix: lotMatrix,
    hcpRollup: hcpRollup,
    cohorts: cohorts,
    resolutionDistribution: resolutionDistribution,
    ngrams: ngrams,
    kwic: kwic,
    distinctiveTerms: distinctiveTerms,
    stem: stem,
    cosine: cosine,
    /** NPS on a record set ({value, n, interval, extra}). */
    nps: npsOf,
    /** Net sentiment on a record set. */
    netSentiment: netSentimentOf,
    /** Prorated orders in [from, to] for a product (null when a month is missing). */
    ordersInRange: ordersInRange,
    /** Stopword-filtered tokens (VOC.lexicon.STOPWORDS when loaded). */
    contentTokens: contentTokens
  };
})();
