/* L-Nutra Voice of the Customer — narrate.js (H)
 * Headline, insight cards, metric explanations, forecast / what-changed sentences, verbatim selection,
 * recommendations and a copy linter (SPEC §4.8). PURE: runs under jsc with no DOM.
 * Copy rules: active voice, ranges not point claims, never the word "will", every statistic carries its n.
 * Uses VOC.predict / VOC.analytics / VOC.metrics when they are loaded and degrades to honest cards when not.
 */
window.VOC = window.VOC || {};
(function () {
  'use strict';

  var INSIGHT_KINDS = ['change', 'driver', 'emerging', 'regulatory', 'outlook'];
  var COMPLAINT_CATEGORIES = ['subscription_billing', 'checkout_website', 'shipping_fulfillment', 'missing_damaged', 'taste_quality',
    'foreign_material_allergen', 'side_effects', 'adverse_event', 'customer_service', 'price_value'];
  var PRESET_LABELS = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '12m': 'Last 12 months' };
  var PRIOR_LABELS = { '7d': 'the prior 7 days', '30d': 'the prior 30 days', '90d': 'the prior 90 days', '12m': 'the prior 12 months' };
  var LEXICAL_DIMENSIONS = ['product', 'category', 'subcategory', 'channel', 'sales_channel', 'segment', 'region', 'urgency', 'status', 'sentiment', 'assignee'];

  /* ------------------------------------------------------------------ */
  /* Module access and small helpers                                     */
  /* ------------------------------------------------------------------ */

  function U() { return VOC.util || null; }
  function EN() { return VOC.enums || (VOC.util && VOC.util.enums) || null; }
  function P() { return VOC.predict || null; }
  function A() { return VOC.analytics || null; }
  function M() { return VOC.metrics || null; }

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function label(kind, id) {
    var en = EN();
    if (en && typeof en.label === 'function') { try { return en.label(kind, id); } catch (e) { /* fall through */ } }
    return String(id == null ? '' : id).replace(/_/g, ' ');
  }
  function fmtInt(n) { var u = U(); return u ? u.fmt.int(n) : String(Math.round(n)); }
  function fmtNum(n, d) { var u = U(); return u ? u.fmt.num(n, d || 0) : (isNum(n) ? n.toFixed(d || 0) : '—'); }
  function fmtPct01(p, d) { var u = U(); return u ? u.fmt.pct(p, d || 0) : (isNum(p) ? (p * 100).toFixed(d || 0) + '%' : '—'); }
  function fmtPct100(v, d) { return isNum(v) ? fmtNum(v, d) + '%' : '—'; }
  function fmtHours(h) { var u = U(); return u ? u.fmt.hours(h) : (isNum(h) ? h.toFixed(1) + 'h' : '—'); }
  function fmtDate(iso, gran) { var u = U(); return u ? u.fmt.date(iso, gran || 'day') : String(iso || '—'); }
  function fmtRange(from, to) { var u = U(); return u ? u.fmt.range(from, to) : from + ' – ' + to; }
  function signed(n, d) { if (!isNum(n)) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + fmtNum(Math.abs(n), d || 0); }
  function signedPct100(n, d) { return isNum(n) ? signed(n, d) + ' pts' : '—'; }
  function round(x, d) { var u = U(); if (u && typeof u.round === 'function') return u.round(x, d); var f = Math.pow(10, d || 0); return Math.round(x * f) / f; }
  function dayKey(iso) { var u = U(); return u ? u.dayKey(iso) : String(iso).slice(0, 10); }
  function addDays(day, n) { var u = U(); return u ? u.addDays(day, n) : new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function nowOf(derived) {
    var n = derived && derived.now;
    if (n instanceof Date && !isNaN(n.getTime())) return n;
    if (typeof n === 'string') { var d = new Date(n); if (!isNaN(d.getTime())) return d; }
    return new Date();
  }
  function clockMode(derived) {
    if (derived && (derived.clockMode === 'demo' || derived.clockMode === 'real')) return derived.clockMode;
    if (derived && derived.settings && (derived.settings.clock === 'demo' || derived.settings.clock === 'real')) return derived.settings.clock;
    if (VOC.store && typeof VOC.store.clockMode === 'function') { try { return VOC.store.clockMode(); } catch (e) { return null; } }
    return null;
  }
  function kpi(derived, id) {
    var k = derived && derived.kpis && derived.kpis[id];
    return k && typeof k === 'object' ? k : null;
  }
  function kpiValue(derived, id) { var k = kpi(derived, id); return k && isNum(k.value) ? k.value : null; }
  function halfWidth(interval) { return interval && isNum(interval.lo) && isNum(interval.hi) ? (interval.hi - interval.lo) / 2 : null; }
  function wilson(k, n) {
    var u = U();
    if (u && u.stats && typeof u.stats.wilson === 'function') return u.stats.wilson(k, n);
    if (!n) return { lo: null, hi: null };
    var p = k / n, z = 1.96, z2 = z * z, denom = 1 + z2 / n, c = (p + z2 / (2 * n)) / denom, h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
    return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
  }
  function median(a) {
    var u = U();
    if (u && u.stats) return u.stats.median(a);
    var v = a.filter(isNum).sort(function (x, y) { return x - y; });
    return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
  }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) if (isNum(a[i])) s += a[i]; return s; }
  function isNegative(r) { return r.sentiment_label === 'negative' || (isNum(r.sentiment) && r.sentiment <= -0.15 && r.sentiment_label !== 'unscored'); }
  function isPositive(r) { return r.sentiment_label === 'positive' || (isNum(r.sentiment) && r.sentiment >= 0.15 && r.sentiment_label !== 'unscored'); }
  function isComplaint(r) {
    if (typeof r.is_complaint === 'boolean') return r.is_complaint;
    return (isNum(r.sentiment) && r.sentiment < -0.1) || COMPLAINT_CATEGORIES.indexOf(r.category) >= 0;
  }
  function isOpen(r) {
    if (typeof r.is_open === 'boolean') return r.is_open;
    return ['new', 'open', 'pending', 'reopened', 'escalated'].indexOf(r.status) >= 0;
  }
  function recordDayKey(r) { return r.day_key || (r.received_at ? dayKey(r.received_at) : null); }
  function cleanRecords(list) { return arr(list).filter(function (r) { return r && !r.is_noise; }); }
  function baseRecords(derived) { return cleanRecords(derived && (derived.allRecords || derived.records)); }

  /** Range label such as 'Last 30 days' or 'Aug 18 – Sep 16, 2026' (custom). */
  function rangeLabel(derived) {
    var f = derived && derived.filters, r = f && f.range;
    if (!r) return 'Current range';
    if (r.preset && PRESET_LABELS[r.preset]) return PRESET_LABELS[r.preset];
    if (r.from && r.to) return fmtRange(r.from, r.to);
    return 'Current range';
  }
  function priorLabel(derived) {
    var f = derived && derived.filters, r = f && f.range;
    if (f && f.compare === 'prior_year') return 'the same period a year earlier';
    if (r && r.preset && PRIOR_LABELS[r.preset]) return PRIOR_LABELS[r.preset];
    var cr = derived && derived.compareRange;
    if (cr && cr.from && cr.to) return fmtRange(cr.from, cr.to);
    return 'the prior period';
  }
  function capitalize(str) { str = String(str || ''); return str.charAt(0).toUpperCase() + str.slice(1); }
  function hasCompare(derived) { return arr(derived && derived.compare).length > 0 && (!derived.filters || derived.filters.compare !== 'none'); }
  /** True when store.derived() marked the comparison window thin (fewer than 20 records or starting before the data): deltas are withheld. */
  function thinCompare(derived) { var cm = derived && derived.compareMeta; return !!(cm && cm.thin); }

  /**
   * One-line description of the active filters, for footers and card labels.
   * @param {object} derived
   * @returns {string} e.g. 'Last 30 days (Aug 18 – Sep 16, 2026) · product: ProLon 5-Day · sentiment: negative'
   */
  function filterContext(derived) {
    var f = derived && derived.filters;
    if (!f) return 'all records';
    var parts = [];
    var r = f.range || {};
    parts.push(rangeLabel(derived) + (r.from && r.to && r.preset !== 'custom' ? ' (' + fmtRange(r.from, r.to) + ')' : ''));
    LEXICAL_DIMENSIONS.forEach(function (dim) {
      var v = f[dim];
      if (Array.isArray(v) && v.length) parts.push(dim.replace(/_/g, ' ') + ': ' + v.map(function (id) { return label(dim, id); }).join(', '));
    });
    if (f.search) parts.push('search: "' + f.search + '"');
    if (f.restrictedQueue) parts.push('restricted queue');
    if (f.compare === 'none') parts.push('no comparison');
    return parts.join(' · ');
  }

  /* ------------------------------------------------------------------ */
  /* Lint                                                                */
  /* ------------------------------------------------------------------ */

  var RE_WILL = /\bwill\b/i;
  var RE_GUARANTEE = /\bguarantee[sd]?\b/i;
  var RE_PCT = /\d+(?:\.\d+)?\s?%/g;
  var RE_N = /\bn\s?=\s?\d/;
  var N_WINDOW = 200;
  // The site writes American English ('analysis', 'hospitalization', 'color'); British forms that slipped into copy before are caught here.
  var RE_BRITISH = /\b(?:prioritis(?:e|ed|es|ing)|analys(?:e|ed|ing)|optimis(?:e|ed|es|ing|ation)|organis(?:e|ed|es|ing|ation)|recognis(?:e|ed|es|ing)|summaris(?:e|ed|es|ing)|categoris(?:e|ed|es|ing|ation)|normalis(?:e|ed|es|ing|ation)|standardis(?:e|ed|es|ing|ation)|minimis(?:e|ed|es|ing)|maximis(?:e|ed|es|ing)|realis(?:e|ed|es|ing)|utilis(?:e|ed|es|ing)|emphasis(?:e|ed|es|ing)|colours?|behaviours?|favourites?|centres?|programmes?)\b/i;

  /**
   * Check generated copy against the house rules.
   * Flags the standalone word "will", "guarantee", British spellings ("prioritise", "analyse", "colour"…), and any
   * percentage with no "n=" within 200 characters.
   * @param {string} text
   * @returns {{ok:boolean, violations:string[]}}
   */
  function lint(text) {
    var s = text == null ? '' : String(text);
    var violations = [];
    var m = RE_WILL.exec(s);
    if (m) violations.push('uses "will" at ' + m.index + ': "' + snippet(s, m.index) + '"');
    m = RE_GUARANTEE.exec(s);
    if (m) violations.push('uses "guarantee" at ' + m.index + ': "' + snippet(s, m.index) + '"');
    m = RE_BRITISH.exec(s);
    if (m) violations.push('British spelling "' + m[0] + '" at ' + m.index + ' (use American): "' + snippet(s, m.index) + '"');
    RE_PCT.lastIndex = 0;
    var hit;
    while ((hit = RE_PCT.exec(s)) !== null) {
      var lo = Math.max(0, hit.index - N_WINDOW), hi = Math.min(s.length, hit.index + hit[0].length + N_WINDOW);
      if (!RE_N.test(s.slice(lo, hi))) { violations.push('percentage without n at ' + hit.index + ': "' + snippet(s, hit.index) + '"'); break; }
    }
    return { ok: violations.length === 0, violations: violations };
  }
  function snippet(s, at) {
    var lo = Math.max(0, at - 20), hi = Math.min(s.length, at + 30);
    return (lo > 0 ? '…' : '') + s.slice(lo, hi).replace(/\s+/g, ' ') + (hi < s.length ? '…' : '');
  }

  /* ------------------------------------------------------------------ */
  /* Headline                                                            */
  /* ------------------------------------------------------------------ */

  function negativeDeltaByDimension(recordsNow, recordsPrior, dim) {
    var counts = new Map();
    function bump(list, field) {
      list.forEach(function (r) {
        if (!isNegative(r)) return;
        var k = r[dim] == null ? 'unknown' : r[dim];
        if (!counts.has(k)) counts.set(k, { value: k, now: 0, prior: 0, nNow: 0 });
        counts.get(k)[field] += 1;
      });
    }
    bump(recordsNow, 'now'); bump(recordsPrior, 'prior');
    recordsNow.forEach(function (r) { var k = r[dim] == null ? 'unknown' : r[dim]; if (counts.has(k)) counts.get(k).nNow += 1; });
    var rows = [];
    counts.forEach(function (c) { rows.push({ value: c.value, label: label(dim, c.value), delta: c.now - c.prior, nNow: c.nNow }); });
    rows.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    return rows;
  }
  function leadChange(derived) {
    var recs = cleanRecords(derived.records), prior = cleanRecords(derived.compare);
    if (!recs.length || !prior.length) return null;
    var rows = null, total = null;
    var p = P();
    if (p && typeof p.whatChanged === 'function') {
      try {
        var wc = p.whatChanged(recs, prior, 'category', { now: nowOf(derived) });
        rows = arr(wc.rows).filter(function (r) { return r.value !== '__other__'; });
        total = wc.total ? wc.total.delta : null;
      } catch (e) { rows = null; }
    }
    if (!rows) { rows = negativeDeltaByDimension(recs, prior, 'category'); total = sum(rows.map(function (r) { return r.delta; })); }
    if (!rows.length || !isNum(total) || total === 0) return null;
    var lead = rows[0];
    if (!lead || !isNum(lead.delta) || lead.delta === 0 || (lead.delta > 0) !== (total > 0)) return null;
    var inCat = recs.filter(function (r) { return r.category === lead.value; });
    var priorInCat = prior.filter(function (r) { return r.category === lead.value; });
    var byProduct = negativeDeltaByDimension(inCat, priorInCat, 'product');
    var prod = byProduct.length && (byProduct[0].delta > 0) === (total > 0) && byProduct[0].value !== 'general' ? byProduct[0] : null;
    var negNow = inCat.filter(isNegative).length, negPrior = priorInCat.filter(isNegative).length;
    return { label: lead.label || label('category', lead.value), delta: lead.delta, negNow: negNow, negPrior: negPrior, n: inCat.length, nPrior: priorInCat.length,
      product: prod ? prod.label : null, total: total };
  }

  /**
   * One or two sentences that open the briefing. Clauses with no data (no orders, no NPS) are omitted.
   * @param {object} derived store.derived() (or a compatible object)
   * @returns {string}
   */
  function headline(derived) {
    derived = derived || {};
    var clock = clockMode(derived);
    var lead = rangeLabel(derived) + (clock === 'demo' ? ' (demo clock)' : '') + ': ';
    var n = isNum(derived.n) ? derived.n : arr(derived.records).length;
    if (!n) return lead + 'no records match the current filters (n=0). Widen the range or clear a filter to see the briefing.';
    var compare = hasCompare(derived) && !thinCompare(derived);
    var clauses = [];
    var vol = kpi(derived, 'volume');
    var volValue = vol && isNum(vol.value) ? vol.value : n;
    var volClause = fmtInt(volValue) + ' contact' + (volValue === 1 ? '' : 's');
    var volDelta = vol && vol.delta && vol.delta.text && vol.delta.text !== '—' && compare ? vol.delta.text + ' vs ' + priorLabel(derived) : null;

    var si = kpi(derived, 'sentiment_index');
    var siClause = null;
    if (si && isNum(si.value)) {
      var siParts = [];
      if (si.delta && si.delta.text && si.delta.text !== '—' && compare) siParts.push(si.delta.text);
      siParts.push('n=' + fmtInt(si.n));
      siClause = 'sentiment index ' + fmtNum(si.value) + ' (' + siParts.join(', ') + ')';
    }
    var nps = kpi(derived, 'nps');
    var npsClause = null;
    if (nps && isNum(nps.value) && nps.n > 0) {
      var moe = halfWidth(nps.interval);
      npsClause = 'NPS ' + fmtNum(nps.value) + ' (n=' + fmtInt(nps.n) + (isNum(moe) ? ', ±' + fmtNum(moe) : '') +
        (nps.delta && nps.delta.text && nps.delta.text !== '—' && compare ? ', ' + nps.delta.text : '') + ')';
    }
    var volParen = [];
    if (volDelta) volParen.push(volDelta);
    if (!siClause && !npsClause) volParen.push('n=' + fmtInt(volValue));
    clauses.push(volClause + (volParen.length ? ' (' + volParen.join(', ') + ')' : ''));
    if (siClause) clauses.push(siClause);
    if (npsClause) clauses.push(npsClause);
    var first = lead + clauses.join(', ') + '.';

    var second = '';
    var change = compare ? leadChange(derived) : null;
    if (change) {
      var dir = change.total > 0 ? 'rise' : 'fall';
      // Both counts, so "−11 negatives" is never read against the current n alone (13 → 2 negatives; n=5 now vs 18 prior).
      second = ' Most of the ' + dir + ' in negatives is ' + change.label + (change.product ? ' on ' + change.product : '') +
        ' (' + fmtInt(change.negPrior) + ' → ' + fmtInt(change.negNow) + ' negatives, ' + signed(change.negNow - change.negPrior) + '; n=' + fmtInt(change.n) + ' now vs ' + fmtInt(change.nPrior) + ' prior).';
    } else {
      var cats = arr(derived.byCategory).filter(function (c) { return c.count > 0 && c.id !== 'other_noise'; }).sort(function (a, b) { return b.count - a.count; });
      if (cats.length) {
        var top = cats[0];
        second = ' The largest theme is ' + (top.label || label('category', top.id)) + ' (' + fmtInt(top.count) + ' records, ' + fmtPct01(top.share) +
          ' of volume' + (isNum(top.negShare) ? ', ' + fmtPct01(top.negShare) + ' negative' : '') + '; n=' + fmtInt(n) + ').';
      }
    }
    return first + second;
  }

  var PART_MAX = 90;
  /** First variant that fits the per-statement cap; the last (shortest) variant always goes through. */
  function fit(variants) {
    var list = variants.filter(function (v) { return typeof v === 'string' && v.length > 0; });
    for (var i = 0; i < list.length; i++) if (list[i].length <= PART_MAX) return list[i];
    return list[list.length - 1] || '';
  }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (n === 1 ? one : (many || one + 's')); }

  /**
   * The briefing headline as 3–4 short bold statements (each ≤ 90 characters, lint-clean, carrying n): volume with its
   * delta; sentiment index and NPS; the biggest driver of change (or the largest theme); regulatory state or the volume
   * outlook. headline() stays the prose form for reports and tests.
   * @param {object} derived store.derived() (or a compatible object)
   * @returns {string[]}
   */
  function headlineParts(derived) {
    derived = derived || {};
    var clock = clockMode(derived);
    var range = rangeLabel(derived) + (clock === 'demo' ? ' (demo clock)' : '');
    var n = isNum(derived.n) ? derived.n : arr(derived.records).length;
    if (!n) return [range + ': no records match the current filters (n=0).', 'Widen the range or clear a filter to see the briefing.'];
    var compare = hasCompare(derived) && !thinCompare(derived);
    var parts = [];

    // 1. Volume with its delta.
    var vol = kpi(derived, 'volume');
    var volValue = vol && isNum(vol.value) ? vol.value : n;
    var volText = plural(volValue, 'contact');
    var delta = vol && vol.delta && vol.delta.text && vol.delta.text !== '—' && compare ? vol.delta.text : null;
    var prevN = vol && isNum(vol.prevN) ? vol.prevN : arr(derived.compare).length;
    var nVol = 'n=' + fmtInt(volValue) + (delta && prevN ? ' vs ' + fmtInt(prevN) : '');
    parts.push(delta
      ? fit([range + ': ' + volText + ', ' + delta + ' vs ' + priorLabel(derived) + ' (' + nVol + ').',
        range + ': ' + volText + ', ' + delta + ' vs prior (' + nVol + ').',
        volText + ', ' + delta + ' vs prior (' + nVol + ').'])
      : fit([range + ': ' + volText + ' (' + nVol + ').', volText + ' (' + nVol + ').']));

    // 2. Sentiment index and NPS.
    var si = kpi(derived, 'sentiment_index'), nps = kpi(derived, 'nps');
    var full = [], short = [];
    if (si && isNum(si.value)) {
      var siDelta = si.delta && si.delta.text && si.delta.text !== '—' && compare ? si.delta.text + ', ' : '';
      full.push('Sentiment index ' + fmtNum(si.value) + ' (' + siDelta + 'n=' + fmtInt(si.n) + ')');
      short.push('Sentiment index ' + fmtNum(si.value) + ' (n=' + fmtInt(si.n) + ')');
    }
    if (nps && isNum(nps.value) && nps.n > 0) {
      var moe = halfWidth(nps.interval);
      var npsDelta = nps.delta && nps.delta.text && nps.delta.text !== '—' && compare ? ', ' + nps.delta.text : '';
      full.push('NPS ' + fmtNum(nps.value) + ' (n=' + fmtInt(nps.n) + (isNum(moe) ? ', ±' + fmtNum(moe) : '') + npsDelta + ')');
      short.push('NPS ' + fmtNum(nps.value) + ' (n=' + fmtInt(nps.n) + ')');
    }
    if (full.length) parts.push(fit([full.join(' · ') + '.', short.join(' · ') + '.']));

    // 3. Biggest driver of change, or the largest theme when there is no comparison.
    var change = compare ? leadChange(derived) : null;
    if (change) {
      var dir = change.total > 0 ? 'rise' : 'fall';
      var neg = fmtInt(change.negPrior) + ' → ' + fmtInt(change.negNow) + ' negatives';
      var nChange = 'n=' + fmtInt(change.n) + ' vs ' + fmtInt(change.nPrior);
      parts.push(fit([
        'Most of the ' + dir + ' in negatives: ' + change.label + (change.product ? ' on ' + change.product : '') + ', ' + neg + ' (' + nChange + ' prior).',
        'Most of the ' + dir + ' in negatives: ' + change.label + ', ' + neg + ' (' + nChange + ').',
        change.label + ' drove the ' + dir + ': ' + neg + ' (' + nChange + ').',
        change.label + ': ' + neg + ' (' + nChange + ').'
      ]));
    } else {
      var cats = arr(derived.byCategory).filter(function (c) { return c.count > 0 && c.id !== 'other_noise'; }).sort(function (a, b) { return b.count - a.count; });
      if (cats.length) {
        var top = cats[0], topLabel = top.label || label('category', top.id);
        parts.push(fit([
          'Largest theme: ' + topLabel + ', ' + plural(top.count, 'record') + ', ' + fmtPct01(top.share) + ' of volume' + (isNum(top.negShare) ? ', ' + fmtPct01(top.negShare) + ' negative' : '') + ' (n=' + fmtInt(n) + ').',
          'Largest theme: ' + topLabel + ', ' + plural(top.count, 'record') + ', ' + fmtPct01(top.share) + ' of volume (n=' + fmtInt(n) + ').',
          'Largest theme: ' + topLabel + ', ' + plural(top.count, 'record') + ' (n=' + fmtInt(n) + ').'
        ]));
      }
    }

    // 4. Regulatory state when a clock is running, otherwise the volume outlook.
    var reg = derived.regulatory || {};
    var openSerious = arr(reg.openSerious), openFood = arr(reg.openFoodSafety), deadlines = arr(reg.deadlines);
    var nAll = baseRecords(derived).length;
    var regPart = null;
    if (openSerious.length || openFood.length || deadlines.length) {
      var rfr = deadlines.filter(function (d) { return d.clock === 'rfr_24h'; });
      var bits = [];
      if (openSerious.length) bits.push(plural(openSerious.length, 'open serious AE'));
      if (rfr.length) bits.push(plural(rfr.length, 'RFR evaluation') + ' on the 24h clock');
      if (!bits.length && openFood.length) bits.push(plural(openFood.length, 'open food-safety report'));
      var next = deadlines.length ? deadlines[0] : null;
      var remaining = next ? deadlineRemaining(next) : '';
      regPart = fit([
        bits.join(' and ') + (remaining ? '; next deadline ' + remaining : '') + ' (n=' + fmtInt(nAll) + ', unfiltered).',
        bits.join(', ') + (remaining ? '; ' + remaining : '') + ' (n=' + fmtInt(nAll) + ', unfiltered).',
        bits.join(', ') + (remaining ? '; ' + remaining : '') + ' (n=' + fmtInt(nAll) + ').',
        bits[0] + ' (n=' + fmtInt(nAll) + ').'
      ]);
    } else regPart = 'No open regulatory clocks (n=' + fmtInt(nAll) + ' records, unfiltered).';

    var outlook = null;
    var p = P();
    var hs = historySeries(derived);
    if (p && typeof p.forecastVolume === 'function' && hs.series.length >= 7) {
      var res = null;
      try { res = p.forecastVolume(hs.series, { horizon: 28, now: nowOf(derived) }); } catch (e) { res = null; }
      if (res && arr(res.forecast).length) {
        var fs = forecastSummary(res);
        if (isNum(fs.perDay)) outlook = fit([
          'Expect about ' + fmtNum(fs.perDay) + ' contacts a day next week' + (isNum(fs.lo) && isNum(fs.hi) ? ', likely ' + fmtNum(fs.lo) + '–' + fmtNum(fs.hi) : '') + ' (n=' + fmtInt(res.n) + ' days).',
          'Expect about ' + fmtNum(fs.perDay) + ' contacts a day next week (n=' + fmtInt(res.n) + ' days).'
        ]);
      }
    }
    if (openSerious.length || openFood.length || deadlines.length) parts.push(regPart);
    else parts.push(outlook || regPart);
    if (parts.length < 3 && outlook && parts.indexOf(outlook) < 0) parts.push(outlook);
    if (parts.length < 3 && parts.indexOf(regPart) < 0) parts.push(regPart);
    return parts.slice(0, 4);
  }

  /* ------------------------------------------------------------------ */
  /* Insight cards                                                       */
  /* ------------------------------------------------------------------ */

  function card(kind, title, text, evidence, drill, severity) {
    return { kind: kind, title: title, text: text, evidence: evidence, drill: drill || null, severity: severity || 'info' };
  }
  function thinCard(kind, title, n, why) {
    return card(kind, title, 'Too few records to say (n=' + fmtInt(n) + ').' + (why ? ' ' + why : ''), 'n=' + fmtInt(n), null, 'info');
  }
  function negShareOf(list) {
    var scored = list.filter(function (r) { return r.sentiment_label !== 'unscored' && isNum(r.sentiment); });
    if (!scored.length) return { share: null, n: 0, k: 0 };
    var k = scored.filter(isNegative).length;
    return { share: k / scored.length, n: scored.length, k: k };
  }
  function dailySeries(derived) {
    var byDay = arr(derived.byDay);
    if (byDay.length) return byDay.map(function (b) { return { key: b.key, value: isNum(b.count) ? b.count : 0 }; });
    var recs = cleanRecords(derived.records);
    var a = A();
    if (a && typeof a.bucket === 'function') {
      try { return a.bucket(recs, 'day').map(function (b) { return { key: b.key, value: b.count }; }); } catch (e) { /* fall through */ }
    }
    var counts = new Map();
    recs.forEach(function (r) { var k = recordDayKey(r); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
    var keys = Array.from(counts.keys()).sort();
    if (!keys.length) return [];
    var out = [];
    for (var d = keys[0]; d <= keys[keys.length - 1]; d = addDays(d, 1)) out.push({ key: d, value: counts.get(d) || 0 });
    return out;
  }

  function dimensionFiltersActive(derived) {
    var f = derived && derived.filters;
    if (!f) return false;
    if (f.search || f.restrictedQueue) return true;
    return LEXICAL_DIMENSIONS.some(function (dim) { return Array.isArray(f[dim]) && f[dim].length > 0; });
  }
  function seriesFromRecords(recs, toDay) {
    var a = A();
    if (a && typeof a.bucket === 'function') {
      try { return a.bucket(recs, 'day', toDay ? { to: toDay } : undefined).map(function (b) { return { key: b.key, value: b.count }; }); } catch (e) { /* fall through */ }
    }
    var counts = new Map();
    recs.forEach(function (r) { var k = recordDayKey(r); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
    var keys = Array.from(counts.keys()).sort();
    if (!keys.length) return [];
    var last = toDay && toDay > keys[keys.length - 1] ? toDay : keys[keys.length - 1];
    var out = [];
    for (var d = keys[0]; d <= last; d = addDays(d, 1)) out.push({ key: d, value: counts.get(d) || 0 });
    return out;
  }

  /**
   * Daily count history for forecasting and anomaly detection. When the range is short (<56 days) and no dimension
   * filter is active, the full unfiltered history (derived.allRecords) up to the as-of day is used so the weekly model can fit.
   * @param {object} derived
   * @returns {{series:Array<{key:string,value:number}>, scope:'range'|'all'}}
   */
  function historySeries(derived) {
    var ranged = dailySeries(derived);
    var all = arr(derived && derived.allRecords);
    if (ranged.length >= 56 || !all.length || dimensionFiltersActive(derived)) return { series: ranged, scope: 'range' };
    var toDay = dayKey(nowOf(derived).toISOString());
    var full = seriesFromRecords(cleanRecords(all).filter(function (r) { var k = recordDayKey(r); return k && k <= toDay; }), toDay);
    return full.length > ranged.length ? { series: full, scope: 'all' } : { series: ranged, scope: 'range' };
  }
  /** Business days with one decimal only when small and fractional. */
  /**
   * "9 business days remaining" / "overdue by 3h" / "deadline Sep 19, 2026" for one entry of derived.regulatory.deadlines.
   * @param {{clock:string, deadline:string, remaining?:number, businessDaysRemaining?:number, rec?:object}} next
   * @returns {string}
   */
  function deadlineRemaining(next) {
    if (!next) return '';
    if (next.clock === 'medwatch_15bd') {
      var bd = isNum(next.businessDaysRemaining) ? next.businessDaysRemaining : (next.rec && isNum(next.rec.business_days_remaining) ? next.rec.business_days_remaining : null);
      return isNum(bd) ? (bd < 0 ? 'overdue by ' + fmtBusinessDays(bd) : fmtBusinessDays(bd) + ' remaining') : 'deadline ' + fmtDate(next.deadline);
    }
    var hrs = isNum(next.remaining) ? next.remaining : (next.rec && isNum(next.rec.hours_remaining) ? next.rec.hours_remaining : null);
    return isNum(hrs) ? (hrs < 0 ? 'overdue by ' + fmtHours(Math.abs(hrs)) : fmtHours(hrs) + ' remaining') : 'deadline ' + fmtDate(next.deadline);
  }
  function fmtBusinessDays(bd) {
    var a = Math.abs(bd);
    return fmtNum(a, a < 10 && a % 1 ? 1 : 0) + ' business day' + (a === 1 ? '' : 's');
  }

  function changeCard(derived) {
    var recs = cleanRecords(derived.records), prior = cleanRecords(derived.compare);
    var n = recs.length;
    if (n < 5) return thinCard('change', 'Not enough records to measure change', n, 'Widen the range to compare periods.');
    var ns0 = negShareOf(recs);
    var held = rangeLabel(derived) + ' holds ' + fmtInt(n) + ' records' + (isNum(ns0.share) ? ', ' + fmtPct01(ns0.share) + ' negative (n=' + fmtInt(ns0.n) + ' scored)' : '');
    if (hasCompare(derived) && thinCompare(derived)) {
      var cm = derived.compareMeta;
      return card('change', 'Comparison window too thin to measure change',
        held + '. ' + capitalize(String(cm.reason || 'the prior period has too few records')).replace(/\.?$/, '') + ', so deltas are withheld; pick a shorter range or a later start to compare periods.',
        fmtInt(n) + ' records · comparison thin (n=' + fmtInt(isNum(cm.n) ? cm.n : prior.length) + ' prior)', { view: 'trends' }, 'info');
    }
    if (!hasCompare(derived)) {
      var offByChoice = !derived.filters || derived.filters.compare === 'none';
      // A comparison can be selected yet empty (e.g. "prior year" before the data starts): say so instead of "not selected".
      if (offByChoice) {
        return card('change', 'No comparison period selected', held + '. Pick a comparison in the filter bar to see what moved.',
          fmtInt(n) + ' records · comparison off', { view: 'trends' }, 'info');
      }
      return card('change', 'No records in the comparison period', held + '. ' + capitalize(priorLabel(derived)) + ' has no records in this data set, so there is nothing to compare against; try "vs prior period" or a later range.',
        fmtInt(n) + ' records · comparison empty (n=0)', { view: 'trends' }, 'info');
    }
    var prev = prior.length;
    var rel = prev ? (n - prev) / prev : null;
    var nsNow = negShareOf(recs), nsPrior = negShareOf(prior);
    var iv = nsNow.n ? wilson(nsNow.k, nsNow.n) : null;
    var si = kpi(derived, 'sentiment_index');
    var pl = priorLabel(derived);
    var title;
    if (!isNum(rel)) title = 'Volume ' + fmtInt(n) + ' with no prior-period baseline';
    else if (Math.abs(rel) < 0.05) title = 'Volume steady vs ' + pl;
    else title = 'Volume ' + (rel > 0 ? 'up ' : 'down ') + fmtPct01(Math.abs(rel)) + ' vs ' + pl;
    var text = fmtInt(n) + ' records against ' + fmtInt(prev) + ' in ' + pl + (isNum(rel) ? ' (' + signed(rel * 100) + '%; n=' + fmtInt(n + prev) + ')' : ' (n=' + fmtInt(n) + ')') + '.';
    if (isNum(nsNow.share)) {
      text += ' Negatives run at ' + fmtPct01(nsNow.share) + (iv && isNum(iv.lo) ? ', likely ' + fmtPct01(iv.lo) + '–' + fmtPct01(iv.hi) : '') +
        (isNum(nsPrior.share) ? ', against ' + fmtPct01(nsPrior.share) + ' before' : '') + ' (n=' + fmtInt(nsNow.n) + ' scored).';
    }
    if (si && isNum(si.value) && isNum(si.prev)) text += ' Sentiment index moved ' + fmtNum(si.prev) + ' → ' + fmtNum(si.value) + ' pts (n=' + fmtInt(si.n) + ' now' + (isNum(si.prevN) ? ' vs ' + fmtInt(si.prevN) + ' prior' : '') + ').';
    var anomalyNote = anomalyCount(derived);
    if (anomalyNote) text += ' ' + anomalyNote;
    var evidence = fmtInt(n) + ' vs ' + fmtInt(prev) + ' records' +
      (isNum(nsNow.share) ? ' · negatives ' + fmtPct01(nsNow.share) + (isNum(nsPrior.share) ? ' vs ' + fmtPct01(nsPrior.share) : '') : '') +
      (si && isNum(si.value) && isNum(si.prev) ? ' · sentiment ' + fmtNum(si.value) + ' vs ' + fmtNum(si.prev) + ' pts' : '');
    var negUp = isNum(nsNow.share) && isNum(nsPrior.share) && nsNow.share - nsPrior.share >= 0.03;
    var negDown = isNum(nsNow.share) && isNum(nsPrior.share) && nsPrior.share - nsNow.share >= 0.03;
    var severity = 'info';
    if ((isNum(rel) && rel >= 0.2 && negUp) || (isNum(rel) && rel >= 0.5)) severity = 'warning';
    else if (negDown && (!isNum(rel) || rel <= 0.1)) severity = 'good';
    return card('change', title, text, evidence, { view: 'trends' }, severity);
  }
  function anomalyCount(derived) {
    var p = P();
    if (!p || typeof p.detectAnomalies !== 'function') return '';
    var hs = historySeries(derived);
    if (hs.series.length < 35) return '';
    var r = derived.filters && derived.filters.range;
    try {
      var res = p.detectAnomalies(hs.series, { mode: 'count', now: nowOf(derived) });
      var events = arr(res && res.events).filter(function (e) { return !r || !r.from || !r.to || (e.start >= r.from && e.start <= r.to); });
      if (!events.length) return '';
      var worst = events.slice().sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); })[0];
      return events.length + ' day' + (events.length === 1 ? '' : 's') + ' in the range ' + (events.length === 1 ? 'sits' : 'sit') + ' outside the expected band (largest z ' + fmtNum(worst.z, 1) + '; n=' + fmtInt(hs.series.length) + ' days of history).';
    } catch (e) { return ''; }
  }

  function localDrivers(recs, minSupport) {
    var groups = new Map();
    recs.forEach(function (r) { var k = r.category || 'unknown'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    var totalNeg = recs.filter(isNegative).length, N = recs.length, base = N ? totalNeg / N : 0;
    var rows = [];
    groups.forEach(function (list, k) {
      if (list.length < minSupport) return;
      var a = list.filter(isNegative).length, rate = a / list.length;
      rows.push({ value: k, label: label('category', k), n: list.length, negatives: a, rate: rate, baseRate: base, lift: base > 0 ? rate / base : null,
        excess: a - list.length * base, significant: null, q: null });
    });
    rows.sort(function (a, b) { return b.excess - a.excess; });
    return { rows: rows, baseRate: base, n: N };
  }
  function driverRows(recs, derived) {
    var p = P();
    if (p && typeof p.driverAnalysis === 'function') {
      try {
        var res = p.driverAnalysis(recs, 'category', { now: nowOf(derived) });
        return { rows: arr(res.rows), baseRate: res.baseRate, n: res.n, tested: true };
      } catch (e) { /* fall through */ }
    }
    var local = localDrivers(recs, 10);
    return { rows: local.rows, baseRate: local.baseRate, n: local.n, tested: false };
  }
  function driverCard(derived) {
    var recs = cleanRecords(derived.records);
    var n = recs.length;
    if (n < 20) return thinCard('driver', 'Too few records to isolate a driver', n, 'Driver analysis needs at least 20 records and 10 per theme.');
    var d = driverRows(recs, derived);
    var rows = d.rows.filter(function (r) { return isNum(r.excess) && r.excess > 0 && r.value !== 'praise'; });
    if (!rows.length) {
      return card('driver', 'No theme carries excess negatives',
        'Every theme with at least 10 records sits at or below the ' + fmtPct01(d.baseRate) + ' base rate of negatives (n=' + fmtInt(n) + ').',
        'base rate ' + fmtPct01(d.baseRate) + ' · n=' + fmtInt(n), { view: 'themes' }, 'good');
    }
    var sig = rows.filter(function (r) { return r.significant; });
    var top = (sig.length ? sig : rows)[0];
    var iv = wilson(top.negatives, top.n);
    var text = (top.label || label('category', top.value)) + ' runs at ' + fmtPct01(top.rate) + ' negative' +
      (isNum(iv.lo) ? ' (likely ' + fmtPct01(iv.lo) + '–' + fmtPct01(iv.hi) + ')' : '') + ' against a ' + fmtPct01(top.baseRate) +
      ' base rate, about ' + fmtNum(top.excess) + ' excess negatives (n=' + fmtInt(top.n) + ' of ' + fmtInt(n) + ').';
    if (d.tested) text += top.significant ? ' The gap survives a chi-square test (q ' + fmtNum(top.q, 3) + ').' : ' The gap does not reach significance yet (q ' + fmtNum(top.q, 2) + '), so treat it as a lead.';
    else text += ' Significance is untested in this build.';
    if (hasCompare(derived)) {
      var lc = leadChange(derived);
      if (lc && lc.label === (top.label || label('category', top.value))) text += ' It also carries ' + signed(lc.negNow - lc.negPrior) + ' of the ' + signed(lc.total) + ' change in negatives vs ' + priorLabel(derived) + ' (' + fmtInt(lc.negPrior) + ' → ' + fmtInt(lc.negNow) + ' negatives; n=' + fmtInt(lc.n) + ' now vs ' + fmtInt(lc.nPrior) + ' prior).';
    }
    var evidence = 'rate ' + fmtPct01(top.rate) + ' vs base ' + fmtPct01(top.baseRate) + (isNum(top.lift) ? ' · lift ' + fmtNum(top.lift, 1) : '') +
      ' · excess ' + signed(top.excess) + (d.tested && isNum(top.q) ? ' · q ' + fmtNum(top.q, 3) : '') + ' · n=' + fmtInt(top.n);
    var severity = 'info';
    if (isNum(top.lift) && top.lift >= 2 && top.excess >= 15 && (top.significant || !d.tested)) severity = 'critical';
    else if (top.significant || (!d.tested && isNum(top.lift) && top.lift >= 1.5)) severity = 'warning';
    var title = (top.label || label('category', top.value)) + ' drives the excess negatives';
    return card('driver', title, text, evidence, { view: 'themes', filters: { category: [top.value] } }, severity);
  }

  function emergingDrill(row, derived) {
    var f = { range: { preset: '30d' } };
    if (row.type === 'category') f.category = [row.value];
    else if (row.type === 'subcategory') { var parts = String(row.value).split('/'); if (parts.length === 2) { f.category = [parts[0]]; f.subcategory = [parts[1]]; } else f.subcategory = [row.value]; }
    else if (row.type === 'product') f.product = [row.value];
    else f.search = String(row.value);
    return { view: 'inbox', filters: f };
  }
  function emergingCard(derived) {
    var p = P();
    var recs = baseRecords(derived);
    var n = recs.length;
    if (!p || typeof p.detectEmerging !== 'function') return card('emerging', 'Emerging-issue detector unavailable', 'The prediction module is not loaded, so nothing can be scored (n=' + fmtInt(n) + ').', 'n=' + fmtInt(n), null, 'info');
    if (n < 20) return thinCard('emerging', 'Too few records to detect emerging issues', n, 'The detector compares the last 7 days with the prior 28.');
    // Negative-leaning units first (a rising complaint is the insight); praise that rises is reported as good news, never as critical.
    var res, positiveOnly = false;
    function flaggedOf(result) { return arr(result && result.rows).filter(function (r) { return r.status === 'new' || r.status === 'emerging'; }); }
    try { res = p.detectEmerging(recs, { asOf: nowOf(derived), negativeOnly: true }); } catch (e) { res = null; }
    if (res && !flaggedOf(res).length) {
      var all;
      try { all = p.detectEmerging(recs, { asOf: nowOf(derived), negativeOnly: false }); } catch (e) { all = null; }
      if (all && flaggedOf(all).length) { res = all; positiveOnly = true; }
    }
    if (!res) return thinCard('emerging', 'Emerging-issue detector returned nothing', n);
    var scope = derived.allRecords ? 'all non-noise records, unfiltered' : 'current filters';
    var flagged = flaggedOf(res);
    var nR = isNum(res.nRecent) ? res.nRecent : 0, nB = isNum(res.nBase) ? res.nBase : 0;
    var window = 'last 7 days vs the prior 28';
    if (!flagged.length) {
      return card('emerging', 'Nothing new or emerging this week',
        'No theme, product, component, lot or phrase rose above its 28-day baseline in the last 7 days (n=' + fmtInt(nR) + ' recent, ' + fmtInt(nB) + ' baseline; ' + scope + ').',
        window + ' · ' + fmtInt(nR) + ' recent · ' + fmtInt(nB) + ' baseline', { view: 'predict' }, 'good');
    }
    var top = flagged[0];
    var title = positiveOnly ? top.label + ' is rising this week (positive signal, z ' + fmtNum(top.z, 1) + ')'
      : top.status === 'new' ? top.label + ' is new this week' : top.label + ' is emerging (z ' + fmtNum(top.z, 1) + ')';
    var text = top.label + ' has ' + fmtInt(top.cR) + ' mention' + (top.cR === 1 ? '' : 's') + ' in the last 7 days against about ' + fmtNum(top.expected, 1) +
      ' expected from the prior 28 days' + (isNum(top.lift) ? ' (lift ' + fmtNum(top.lift, 1) + ', z ' + fmtNum(top.z, 1) + ')' : ' (z ' + fmtNum(top.z, 1) + ')') +
      '; n=' + fmtInt(nR) + ' recent, ' + fmtInt(nB) + ' baseline records, ' + scope + (positiveOnly ? '; no negative-leaning unit rose' : '; negative-leaning units') + '.';
    if (flagged.length > 1) text += ' ' + (flagged.length - 1) + ' more unit' + (flagged.length === 2 ? '' : 's') + ' also flag' + (flagged.length === 2 ? 's' : '') + ': ' +
      flagged.slice(1, 4).map(function (r) { return r.label + ' (' + fmtInt(r.cR) + ')'; }).join(', ') + '.';
    var evidence = 'recent ' + fmtInt(top.cR) + ' · expected ' + fmtNum(top.expected, 1) + (isNum(top.lift) ? ' · lift ' + fmtNum(top.lift, 1) : '') + ' · z ' + fmtNum(top.z, 1) + ' · ' + top.status;
    var severity = positiveOnly ? 'info' : (top.z >= 3 || top.type === 'lot' ? 'critical' : 'warning');
    return card('emerging', title, text, evidence, emergingDrill(top, derived), severity);
  }

  function regulatoryCard(derived) {
    var reg = (derived && derived.regulatory) || {};
    var all = baseRecords(derived);
    var openSerious = arr(reg.openSerious), openFood = arr(reg.openFoodSafety), deadlines = arr(reg.deadlines);
    var rfr = deadlines.filter(function (d) { return d.clock === 'rfr_24h'; });
    var medwatch = deadlines.filter(function (d) { return d.clock === 'medwatch_15bd'; });
    var next = deadlines.length ? deadlines[0] : null;
    var nAll = all.length;
    var scope = 'All records, unfiltered (n=' + fmtInt(nAll) + ').';
    if (!openSerious.length && !openFood.length && !deadlines.length) {
      return card('regulatory', 'No open regulatory clocks', 'No serious adverse event or food-safety report is open, and no MedWatch or Reportable Food Registry deadline is running. ' + scope,
        'serious AE open 0 · RFR open 0 · food safety open 0', { view: 'regulatory' }, 'good');
    }
    var remainingText = next ? deadlineRemaining(next) : '';
    var titleBits = [];
    if (openSerious.length) titleBits.push(fmtInt(openSerious.length) + ' open serious AE' + (openSerious.length === 1 ? '' : 's'));
    if (rfr.length) titleBits.push(fmtInt(rfr.length) + ' RFR evaluation' + (rfr.length === 1 ? '' : 's') + ' on the 24h clock');
    if (!titleBits.length && openFood.length) titleBits.push(fmtInt(openFood.length) + ' open food-safety report' + (openFood.length === 1 ? '' : 's'));
    var title = titleBits.join(', ') + (next ? '; next deadline ' + remainingText : '');
    var text = fmtInt(openSerious.length) + ' serious adverse event' + (openSerious.length === 1 ? '' : 's') + ' and ' + fmtInt(openFood.length) + ' food-safety report' + (openFood.length === 1 ? '' : 's') +
      ' are open; ' + fmtInt(medwatch.length) + ' MedWatch 15-business-day clock' + (medwatch.length === 1 ? '' : 's') + ' and ' + fmtInt(rfr.length) + ' Reportable Food Registry 24-hour clock' + (rfr.length === 1 ? '' : 's') + ' are running.';
    if (next) text += ' The nearest deadline is ' + fmtDate(next.deadline, 'datetime') + ' (' + remainingText + (next.rec && next.rec.product ? '; ' + label('product', next.rec.product) : '') + ').';
    if (next && next.clock !== 'medwatch_15bd' && medwatch.length) {
      var mw = medwatch[0];
      var mwBd = isNum(mw.businessDaysRemaining) ? mw.businessDaysRemaining : (mw.rec && isNum(mw.rec.business_days_remaining) ? mw.rec.business_days_remaining : null);
      text += ' The next MedWatch deadline is ' + fmtDate(mw.deadline) + (isNum(mwBd) ? ' (' + (mwBd < 0 ? 'overdue by ' + fmtBusinessDays(mwBd) : fmtBusinessDays(mwBd) + ' remaining') + ')' : '') + '.';
    }
    text += ' ' + scope;
    var evidence = 'serious AE open ' + fmtInt(openSerious.length) + ' · RFR open ' + fmtInt(rfr.length) + ' · food safety open ' + fmtInt(openFood.length) + (next ? ' · next deadline ' + fmtDate(next.deadline) : '');
    var urgent = deadlines.some(function (d) {
      var bd = isNum(d.businessDaysRemaining) ? d.businessDaysRemaining : null, hrs = isNum(d.remaining) ? d.remaining : null;
      return (d.clock === 'medwatch_15bd' && isNum(bd) && bd <= 3) || (d.clock === 'rfr_24h' && isNum(hrs) && hrs <= 8);
    });
    var severity = urgent || openSerious.length ? 'critical' : 'warning';
    return card('regulatory', title, text, evidence, { view: 'regulatory' }, severity);
  }

  function outlookCard(derived) {
    var p = P();
    var hs = historySeries(derived);
    var series = hs.series;
    var n = series.length;
    if (!p || typeof p.forecastVolume !== 'function') return card('outlook', 'Forecast unavailable', 'The prediction module is not loaded, so there is no volume projection (n=' + fmtInt(n) + ' days).', 'n=' + fmtInt(n) + ' days', null, 'info');
    if (n < 7) return thinCard('outlook', 'Too few days to project volume', n, 'The forecast needs at least 7 days of history.');
    var res;
    try { res = p.forecastVolume(series, { horizon: 28, now: nowOf(derived) }); } catch (e) { res = null; }
    if (!res || !arr(res.forecast).length) return thinCard('outlook', 'Forecast returned nothing', n);
    var s = forecastSummary(res);
    var title = isNum(s.perDay) ? 'Expect about ' + fmtNum(s.perDay) + ' contacts a day next week' + (isNum(s.lo) ? ' (likely ' + fmtNum(s.lo) + '–' + fmtNum(s.hi) + ')' : '') : 'Volume outlook';
    var text = forecastSentence(res) + (hs.scope === 'all' ? ' History covers all records in scope, not only the selected range.' : '');
    var bt = res.backtest || {};
    var evidence = 'method ' + (res.method || 'n/a') + ' · n=' + fmtInt(res.n) + ' days' +
      (isNum(bt.mase) ? ' · MASE ' + fmtNum(bt.mase, 2) : '') +
      (isNum(bt.weeklyMape) ? ' · weekly MAPE ' + fmtPct01(bt.weeklyMape) : (isNum(bt.mape) ? ' · MAPE ' + fmtPct01(bt.mape) : '')) +
      (isNum(bt.coverage80) ? ' · 80% band covers ' + fmtPct01(bt.coverage80) + (arr(bt.folds).length ? ' (n=' + arr(bt.folds).length + ' folds)' : '') : '') + ' · confidence ' + (res.confidence || 'low');
    var severity = isNum(s.trend) && s.trend >= 0.15 ? 'warning' : 'info';
    return card('outlook', title, text, evidence, { view: 'predict' }, severity);
  }

  /**
   * Exactly five insight cards: change, driver, emerging, regulatory, outlook. Each degrades to an honest card when data or modules are thin.
   * @param {object} derived
   * @returns {Array<{kind:string,title:string,text:string,evidence:string,drill:(object|null),severity:string}>}
   */
  function insights(derived) {
    derived = derived || {};
    var builders = { change: changeCard, driver: driverCard, emerging: emergingCard, regulatory: regulatoryCard, outlook: outlookCard };
    return INSIGHT_KINDS.map(function (kind) {
      try { return builders[kind](derived); } catch (e) {
        return card(kind, 'Insight unavailable', 'This card could not be computed for the current filters (n=' + fmtInt(arr(derived.records).length) + ').', 'n=' + fmtInt(arr(derived.records).length), null, 'info');
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Sentences                                                           */
  /* ------------------------------------------------------------------ */

  var DIRECTION_TEXT = { up_good: 'Higher is better.', down_good: 'Lower is better.', neutral: 'Neither direction is better on its own.' };

  /** Format a metric value by unit ('pct' values are 0–100 points). */
  function formatMetric(unit, value, id) {
    if (!isNum(value)) return '—';
    switch (unit) {
      case 'pct': return fmtPct100(value, 0);
      case 'pts': return fmtNum(value) + ' pts';
      case 'hours': return fmtHours(value);
      case 'per_1k': case 'per_10k': return fmtNum(value, 1);
      case 'usd': { var u = U(); return u ? u.fmt.usd(value) : '$' + fmtInt(value); }
      case 'score': return fmtNum(value, id === 'rating_mean' ? 1 : 0);
      default: return fmtInt(value);
    }
  }

  /**
   * Explain a registry metric with its formula and current value, n, interval and change.
   * @param {string} id metric id
   * @param {object} derived
   * @returns {string}
   */
  function explainMetric(id, derived) {
    var m = M(), def = m && m.registry ? m.registry[id] : null;
    var k = kpi(derived, id);
    var name = (def && def.label) || (k && k.label) || String(id);
    var unit = (def && def.unit) || (k && k.unit) || 'count';
    var formula = def && def.formula ? def.formula : null;
    var direction = (def && def.direction) || (k && k.direction) || 'neutral';
    var head = name + (formula ? ' (' + formula + ')' : '') + ': ';
    if (!k || !isNum(k.value)) return head + 'no value for the current filters (n=' + fmtInt(k ? k.n : 0) + '). ' + (formula ? 'Formula ' + formula + '.' : 'Formula unavailable.');
    var s = head + formatMetric(unit, k.value, id) + ' (n=' + fmtInt(k.n);
    if (k.interval && isNum(k.interval.lo) && isNum(k.interval.hi)) s += ', 95% interval ' + formatMetric(unit, k.interval.lo, id) + ' to ' + formatMetric(unit, k.interval.hi, id);
    s += ')';
    if (isNum(k.prev) && hasCompare(derived)) s += ', vs ' + formatMetric(unit, k.prev, id) + ' in ' + priorLabel(derived) + (k.delta && k.delta.text && k.delta.text !== '—' ? ' (' + k.delta.text + ')' : '');
    s += '. ' + (DIRECTION_TEXT[direction] || DIRECTION_TEXT.neutral);
    return s;
  }

  function forecastSummary(result) {
    var fc = arr(result && result.forecast).slice(0, 7);
    var out = { perDay: null, lo: null, hi: null, trend: null, days: fc.length };
    if (!fc.length) return out;
    var total = sum(fc.map(function (f) { return f.value; }));
    out.perDay = total / fc.length;
    var wk = arr(result.weekly)[0];
    if (wk && isNum(wk.lo80) && isNum(wk.hi80) && isNum(wk.days) && wk.days > 0) { out.lo = Math.max(0, wk.lo80 / wk.days); out.hi = wk.hi80 / wk.days; }
    else if (fc.every(function (f) { return isNum(f.lo80) && isNum(f.hi80); })) { out.lo = Math.max(0, sum(fc.map(function (f) { return f.lo80; })) / fc.length); out.hi = sum(fc.map(function (f) { return f.hi80; })) / fc.length; }
    var hist = arr(result.history).slice(-7);
    var lastWeek = sum(hist.map(function (h) { return h.value; }));
    if (hist.length === 7 && lastWeek > 0) out.trend = (total - lastWeek) / lastWeek;
    return out;
  }

  /**
   * Plain-language reading of a forecastVolume result.
   * @param {object} result AnalyticResult from VOC.predict.forecastVolume
   * @returns {string} e.g. 'Expect about 23 messages a day next week, likely 15–31; volume is trending +4% a week (n=365 days, backtest MAPE 12%).'
   */
  function forecastSentence(result) {
    if (!result || !arr(result.forecast).length) return 'Too few days of history to project volume (n=' + fmtInt(result && isNum(result.n) ? result.n : 0) + ' days).';
    var s = forecastSummary(result);
    var bt = result.backtest || {};
    var text = 'Expect about ' + fmtNum(s.perDay) + ' message' + (round(s.perDay, 0) === 1 ? '' : 's') + ' a day next week';
    if (isNum(s.lo) && isNum(s.hi)) text += ', likely ' + fmtNum(s.lo) + '–' + fmtNum(s.hi);
    if (isNum(s.trend)) text += '; volume is trending ' + signed(s.trend * 100) + '% a week';
    text += ' (n=' + fmtInt(result.n) + ' days';
    if (isNum(bt.weeklyMape)) text += ', backtest weekly MAPE ' + fmtPct01(bt.weeklyMape) + (isNum(bt.mape) ? ', daily ' + fmtPct01(bt.mape) : '');
    else text += isNum(bt.mape) ? ', backtest MAPE ' + fmtPct01(bt.mape) : ', backtest unavailable';
    text += ').';
    var caveat = arr(result.caveats)[0];
    if (caveat && result.confidence === 'low') {
      var safe = lintSafeCaveat(caveat, bt);
      if (safe) text += ' ' + safe;
    }
    return text;
  }

  /**
   * Returns a module caveat that passes lint on its own: a percentage without n gets the backtest fold count
   * ("n=4 folds, 28 days scored") appended; a caveat that still fails (e.g. uses "will") is dropped.
   * @param {string} caveat
   * @param {{folds?:Array<{n?:number}>}} [bt]
   * @returns {string} '' when the caveat cannot be made lint-clean
   */
  function lintSafeCaveat(caveat, bt) {
    var c = caveat == null ? '' : String(caveat).trim();
    if (!c) return '';
    if (lint(c).ok) return c;
    var folds = arr(bt && bt.folds);
    if (folds.length) {
      var days = sum(folds.map(function (f) { return f && isNum(f.n) ? f.n : 0; }));
      var withN = c.replace(/[.;,\s]+$/, '') + ' (n=' + folds.length + ' fold' + (folds.length === 1 ? '' : 's') + (days ? ', ' + fmtInt(days) + ' days scored' : '') + ').';
      if (lint(withN).ok) return withN;
    }
    return '';
  }

  /**
   * Plain-language reading of a whatChanged result.
   * @param {object} result AnalyticResult from VOC.predict.whatChanged
   * @returns {string}
   */
  function whatChangedSentence(result) {
    var t = result && result.total;
    if (!result || !t || (!t.volumeNow && !t.volumePrior && !t.now && !t.prior)) return 'Neither period has records to compare (n=0).';
    var outcome = result.params && result.params.outcome === 'complaint' ? 'Complaint' : result.params && result.params.outcome === 'detractor' ? 'Detractor' : 'Negative';
    var nNow = isNum(t.volumeNow) ? t.volumeNow : null, nPrior = isNum(t.volumePrior) ? t.volumePrior : null;
    var text = outcome + ' records moved from ' + fmtInt(t.prior) + ' to ' + fmtInt(t.now) + ' (' + signed(t.delta) + '; n=' +
      (isNum(nNow) && isNum(nPrior) ? fmtInt(nNow) + ' now vs ' + fmtInt(nPrior) + ' prior' : fmtInt(result.n)) + ').';
    var rows = arr(result.rows).filter(function (r) { return r.value !== '__other__' && isNum(r.delta) && r.delta !== 0; });
    if (rows.length) {
      var lead = rows.slice(0, 2).map(function (r) {
        var driver = Math.abs(r.volumeEffect) >= Math.abs(r.rateEffect) ? 'mostly volume' : 'mostly rate';
        return (r.label || label('category', r.value)) + ' ' + (r.delta > 0 ? 'adds ' : 'removes ') + signed(r.delta) + ' (' + driver + ': volume ' + signed(r.volumeEffect, 1) + ', rate ' + signed(r.rateEffect, 1) + '; n=' + fmtInt(r.nNow) + ')';
      });
      text += ' ' + lead.join('; ') + '.';
    }
    var volSum = sum(arr(result.rows).map(function (r) { return r.volumeEffect; })), rateSum = sum(arr(result.rows).map(function (r) { return r.rateEffect; }));
    if (arr(result.rows).length) text += ' Volume shifts explain about ' + signed(volSum, 1) + ' and rate shifts about ' + signed(rateSum, 1) + ' of the change.';
    return text;
  }

  /* ------------------------------------------------------------------ */
  /* Verbatims                                                           */
  /* ------------------------------------------------------------------ */

  function verbatimScore(r) {
    var conf = r.classifier && isNum(r.classifier.confidence) ? r.classifier.confidence : 0.5;
    var len = (r.text || '').length;
    var lenFit = len >= 120 && len <= 400 ? 1 : len >= 60 && len <= 700 ? 0.5 : 0;
    var strength = isNum(r.sentiment) ? Math.min(1, Math.abs(r.sentiment)) : 0.3;
    return conf * 1.5 + lenFit + strength * 0.5 + (r.restricted ? -3 : 0) + (r.language && r.language !== 'en' ? -2 : 0);
  }
  function pick(list, k) {
    var sorted = list.slice().sort(function (a, b) {
      var d = verbatimScore(b) - verbatimScore(a);
      if (d) return d;
      if (a.received_at !== b.received_at) return a.received_at < b.received_at ? 1 : -1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    return sorted.slice(0, Math.max(0, k));
  }

  /**
   * Choose confident, mid-length verbatims: praise first, then complaints. Restricted records come back redacted.
   * @param {object[]} records
   * @param {{praise?:number, complaint?:number}} [want] defaults {praise:1, complaint:2}
   * @returns {object[]}
   */
  function verbatims(records, want) {
    var w = Object.assign({ praise: 1, complaint: 2 }, want || {});
    var recs = cleanRecords(records).filter(function (r) { return r.text && String(r.text).trim().length > 0; });
    var praise = recs.filter(function (r) { return isPositive(r) || r.category === 'praise'; });
    var complaints = recs.filter(function (r) { return !isPositive(r) && r.category !== 'praise' && (isNegative(r) || isComplaint(r)); });
    var u = U();
    return pick(praise, w.praise).concat(pick(complaints, w.complaint)).map(function (r) {
      if (!r.restricted) return r;
      if (u && typeof u.redactRecord === 'function') return u.redactRecord(r);
      var copy = Object.assign({}, r); copy.from_name = 'Redacted'; copy.from_email = null; copy.text = '[restricted — open the queue to view]'; copy.redacted = true; return copy;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Recommendations                                                     */
  /* ------------------------------------------------------------------ */

  function themeImpactRows(recs) {
    var a = A();
    if (a && typeof a.themeImpact === 'function') { try { return arr(a.themeImpact(recs)).filter(function (r) { return isNum(r.impact); }); } catch (e) { return []; } }
    return [];
  }
  function topSubcategory(recs, category) {
    var counts = new Map();
    recs.forEach(function (r) { if (r.category === category && r.subcategory && isNegative(r)) counts.set(r.subcategory, (counts.get(r.subcategory) || 0) + 1); });
    var best = null;
    counts.forEach(function (c, k) { if (!best || c > best.count) best = { id: k, count: c }; });
    return best;
  }

  /**
   * Three actionable recommendations: the largest driver, the highest theme impact on NPS, and the largest SLA gap or emerging risk.
   * @param {object} derived
   * @returns {string[]} exactly three strings
   */
  function recommendations(derived) {
    derived = derived || {};
    var recs = cleanRecords(derived.records);
    var n = recs.length;
    var out = [];

    var d = n >= 20 ? driverRows(recs, derived) : { rows: [] };
    var driver = d.rows.filter(function (r) { return isNum(r.excess) && r.excess > 0 && r.value !== 'praise'; })[0];
    if (driver) {
      var sub = topSubcategory(recs, driver.value);
      out.push('Put a fix owner on ' + (driver.label || label('category', driver.value)) + ': it runs at ' + fmtPct01(driver.rate) + ' negative against a ' + fmtPct01(driver.baseRate) +
        ' base rate, about ' + fmtNum(driver.excess) + ' excess negatives (n=' + fmtInt(driver.n) + ')' + (sub ? '; start with ' + label('subcategory', sub.id) + ' (' + fmtInt(sub.count) + ' negatives)' : '') + '.');
    } else out.push('Too few records to name a driver (n=' + fmtInt(n) + '); widen the range or clear a filter before assigning fix owners.');

    var impacts = themeImpactRows(recs).filter(function (r) { return r.impact < 0 && r.category !== 'praise'; });
    if (impacts.length) {
      var worst = impacts[0];
      out.push('Prioritize ' + label('category', worst.category) + ' for NPS: excluding it moves NPS from ' + fmtNum(worst.npsAll) + ' to ' + fmtNum(worst.npsExcl) + ' (' + signedPct100(-worst.impact) + '; n=' + fmtInt(worst.nAll || worst.n) + ' scored, ' + fmtInt(worst.n) + ' in theme).');
    } else {
      var cats = arr(derived.byCategory).filter(function (c) { return c.count >= 5 && isNum(c.meanSentiment) && c.id !== 'praise' && c.id !== 'other_noise'; }).sort(function (a, b) { return a.meanSentiment - b.meanSentiment; });
      if (cats.length) out.push('Protect sentiment in ' + (cats[0].label || label('category', cats[0].id)) + ': it carries the lowest mean sentiment, ' + fmtNum((cats[0].meanSentiment + 1) / 2 * 100) + ' pts across ' + fmtInt(cats[0].count) + ' records (n=' + fmtInt(n) + '); NPS impact needs survey scores in range.');
      else out.push('Collect NPS on more contacts: too few scored records to rank themes by NPS impact (n=' + fmtInt(n) + ').');
    }

    var sla = kpi(derived, 'sla_breached'), p01 = kpi(derived, 'open_p0_p1'), slaPct = kpi(derived, 'frt_sla_pct');
    if (sla && isNum(sla.value) && sla.value > 0) {
      out.push('Clear the ' + fmtInt(sla.value) + ' open record' + (sla.value === 1 ? '' : 's') + ' past first-response SLA in ' + rangeLabel(derived).toLowerCase() + (p01 && isNum(p01.value) ? ' (' + fmtInt(p01.value) + ' open P0/P1)' : '') + '; ' + fmtInt(sla.n) + ' records are open in this range (n=' + fmtInt(sla.n) + '); the alert strip counts every open record.');
    } else if (slaPct && isNum(slaPct.value) && slaPct.value < 85) {
      out.push('Lift first-response SLA attainment from ' + fmtPct100(slaPct.value) + ' toward 90% by routing P0/P1 mail first (n=' + fmtInt(slaPct.n) + ' with a due response).');
    } else {
      var em = null;
      var p = P();
      if (p && typeof p.detectEmerging === 'function' && baseRecords(derived).length >= 20) {
        try { em = arr(p.detectEmerging(baseRecords(derived), { asOf: nowOf(derived), negativeOnly: true }).rows).filter(function (r) { return r.status === 'new' || r.status === 'emerging'; })[0] || null; } catch (e) { em = null; }
      }
      if (em) out.push('Investigate ' + em.label + ' before it spreads: ' + fmtInt(em.cR) + ' negative mentions in 7 days against about ' + fmtNum(em.expected, 1) + ' expected (z ' + fmtNum(em.z, 1) + '; n=' + fmtInt(em.cR + em.cB) + ').');
      else {
        var dq = derived.dq || {};
        if (isNum(dq.needsReviewPct) && dq.needsReviewPct > 0) out.push('Review the ' + fmtPct01(dq.needsReviewPct) + ' of records the classifier flagged for review so themes stay trustworthy (n=' + fmtInt(dq.n || n) + ').');
        else out.push('Service levels hold and nothing is emerging; keep the weekly review cadence and re-check drivers next period (n=' + fmtInt(n) + ').');
      }
    }
    return out.slice(0, 3);
  }

  VOC.narrate = {
    version: '1.0.0',
    INSIGHT_KINDS: INSIGHT_KINDS.slice(),
    headline: headline,
    headlineParts: headlineParts,
    insights: insights,
    explainMetric: explainMetric,
    forecastSentence: forecastSentence,
    deadlineRemaining: deadlineRemaining,
    whatChangedSentence: whatChangedSentence,
    lintSafeCaveat: lintSafeCaveat,
    verbatims: verbatims,
    recommendations: recommendations,
    lint: lint,
    /** Helpers shared with VOC.report. */
    rangeLabel: rangeLabel,
    priorLabel: priorLabel,
    filterContext: filterContext,
    formatMetric: formatMetric,
    clockMode: clockMode,
    dailySeries: dailySeries,
    historySeries: historySeries
  };
})();
