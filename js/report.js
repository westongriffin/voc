/* L-Nutra Voice of the Customer — report.js (H)
 * Weekly and monthly report HTML fragments plus a printable wrapper (SPEC §4.8, §5 Reports). PURE: string building only, no DOM.
 * Every piece of record text passes through escapeHtml. Uses VOC.narrate for prose, VOC.metrics / VOC.analytics / VOC.predict when loaded.
 */
window.VOC = window.VOC || {};
(function () {
  'use strict';

  var KPI_ROWS = ['volume', 'net_sentiment', 'sentiment_index', 'nps', 'csat', 'complaints_per_1k', 'contact_rate', 'frt_median', 'frt_sla_pct', 'resolution_median', 'open_p0_p1', 'detractor_recovery'];
  var SERVICE_ROWS = ['frt_median', 'frt_sla_pct', 'resolution_median', 'resolution_p90', 'reopen_rate', 'escalation_rate', 'repeat_contact_rate', 'backlog_48h', 'sla_breached', 'unassigned'];
  var MEDIAN_UNITS = { pct: 1, pts: 1, score: 1, hours: 1, per_1k: 1, per_10k: 1 };
  var EXCLUDED_PRODUCTS = { general: 1, subscription_account: 1 };
  var SECTIONS = {
    headline: 'Headline', recommendations: 'Recommendations', kpis: 'Key metrics', themes: 'Top themes', emerging: 'Emerging issues and anomalies',
    product: 'Product spotlight', regulatory: 'Regulatory', service: 'Service performance', verbatims: 'Verbatims', actions: 'Actions carried forward',
    forecast: 'Four-week forecast', dq: 'Data quality', methodology: 'Methodology'
  };
  var WEEKLY_ORDER = ['headline', 'kpis', 'themes', 'emerging', 'product', 'regulatory', 'service', 'verbatims', 'actions', 'forecast', 'dq'];
  var MONTHLY_ORDER = ['headline', 'recommendations', 'kpis', 'themes', 'emerging', 'product', 'regulatory', 'service', 'verbatims', 'actions', 'forecast', 'dq', 'methodology'];

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function U() { return VOC.util || null; }
  function N() { return VOC.narrate || null; }
  function M() { return VOC.metrics || null; }
  function A() { return VOC.analytics || null; }
  function P() { return VOC.predict || null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  var HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    var u = U();
    if (u && typeof u.escapeHtml === 'function') return u.escapeHtml(s);
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) { return HTML_ESC[c]; });
  }
  function label(kind, id) {
    var en = VOC.enums || (VOC.util && VOC.util.enums);
    if (en && typeof en.label === 'function') { try { return en.label(kind, id); } catch (e) { /* fall through */ } }
    return String(id == null ? '' : id).replace(/_/g, ' ');
  }
  /* Emerging-unit type ids → the labels the Predict view uses; status/severity enums print capitalized, never as raw ids. */
  var UNIT_LABELS = { category: 'Category', subcategory: 'Subcategory', product: 'Product', kit_component: 'Kit component', lot: 'Lot', bigram: 'Phrase', segment: 'Segment', channel: 'Channel', region: 'Region' };
  function unitLabel(type) { return UNIT_LABELS[type] || capitalize(String(type == null ? '' : type).replace(/_/g, ' ')); }
  function capitalize(s) { s = s == null ? '' : String(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function fmtInt(n) { var u = U(); return u ? u.fmt.int(n) : (isNum(n) ? String(Math.round(n)) : '—'); }
  function fmtNum(n, d) { var u = U(); return u ? u.fmt.num(n, d || 0) : (isNum(n) ? n.toFixed(d || 0) : '—'); }
  function fmtPct01(p, d) { var u = U(); return u ? u.fmt.pct(p, d || 0) : (isNum(p) ? (p * 100).toFixed(d || 0) + '%' : '—'); }
  function fmtHours(h) { var u = U(); return u ? u.fmt.hours(h) : (isNum(h) ? h.toFixed(1) + 'h' : '—'); }
  function fmtDate(iso, gran) { var u = U(); return u ? u.fmt.date(iso, gran || 'day') : String(iso || '—'); }
  function fmtRange(a, b) { var u = U(); return u ? u.fmt.range(a, b) : a + ' – ' + b; }
  function signed(n, d) { if (!isNum(n)) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + fmtNum(Math.abs(n), d || 0); }
  function dayKey(iso) { var u = U(); return u ? u.dayKey(iso) : String(iso).slice(0, 10); }
  function weekKey(iso) { var u = U(); return u ? u.weekKey(iso) : null; }
  function weekStart(wk) { var u = U(); return u ? u.weekStart(wk) : null; }
  function addDays(day, n) { var u = U(); return u ? u.addDays(day, n) : new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function monthKey(iso) { var u = U(); return u ? u.monthKey(iso) : String(iso).slice(0, 7); }
  function median(a) {
    var u = U();
    if (u && u.stats) return u.stats.median(a);
    var v = a.filter(isNum).sort(function (x, y) { return x - y; });
    return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
  }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) if (isNum(a[i])) s += a[i]; return s; }
  function nowOf(derived) {
    var n = derived && derived.now;
    if (n instanceof Date && !isNaN(n.getTime())) return n;
    if (typeof n === 'string') { var d = new Date(n); if (!isNaN(d.getTime())) return d; }
    return new Date();
  }
  function clockMode(derived) {
    var n = N();
    if (n && typeof n.clockMode === 'function') return n.clockMode(derived);
    return derived && derived.settings ? derived.settings.clock || null : null;
  }
  function formatMetric(unit, value, id) {
    var n = N();
    if (n && typeof n.formatMetric === 'function') return n.formatMetric(unit, value, id);
    return isNum(value) ? fmtNum(value, unit === 'hours' || unit === 'per_1k' || unit === 'per_10k' ? 1 : 0) : '—';
  }
  function kpi(derived, id) { var k = derived && derived.kpis && derived.kpis[id]; return k && typeof k === 'object' ? k : null; }
  function cleanRecords(list) { return arr(list).filter(function (r) { return r && !r.is_noise; }); }
  function baseRecords(derived) { return cleanRecords(derived && (derived.allRecords || derived.records)); }
  function isNegative(r) { return r.sentiment_label === 'negative' || (isNum(r.sentiment) && r.sentiment <= -0.15 && r.sentiment_label !== 'unscored'); }
  function hasCompare(derived) { return arr(derived && derived.compare).length > 0 && (!derived.filters || derived.filters.compare !== 'none'); }
  function filterContext(derived) { var n = N(); return n && typeof n.filterContext === 'function' ? n.filterContext(derived) : 'current filters'; }
  function priorLabel(derived) { var n = N(); return n && typeof n.priorLabel === 'function' ? n.priorLabel(derived) : 'the prior period'; }
  function rangeText(derived) {
    var r = derived && derived.filters && derived.filters.range;
    if (r && r.from && r.to) return fmtRange(r.from, r.to);
    var n = N();
    return n ? n.rangeLabel(derived) : 'current range';
  }
  function rangeDays(derived) {
    var r = derived && derived.filters && derived.filters.range;
    var u = U();
    if (r && r.from && r.to && u) return Math.max(1, u.daysBetween(r.from, r.to) + 1);
    return null;
  }
  function historySeries(derived) {
    var n = N();
    if (n && typeof n.historySeries === 'function') return n.historySeries(derived);
    return { series: arr(derived && derived.byDay).map(function (b) { return { key: b.key, value: isNum(b.count) ? b.count : 0 }; }), scope: 'range' };
  }
  function section(id, bodyHtml, extraClass) {
    return '<section class="report-section report__section' + (extraClass ? ' ' + extraClass : '') + '" data-section="' + id + '">' +
      '<h2 class="report-h2">' + esc(SECTIONS[id]) + '</h2>' + bodyHtml + '</section>';
  }
  function table(className, columns, rows, caption) {
    var head = '<thead><tr>' + columns.map(function (c) { return '<th' + (c.num ? ' class="num"' : '') + ' scope="col">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead>';
    var body = '<tbody>' + rows.map(function (cells) {
      return '<tr>' + cells.map(function (v, i) { return '<td' + (columns[i] && columns[i].num ? ' class="num"' : '') + '>' + (v && v.html ? v.html : esc(v)) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody>';
    return '<table class="' + className + '">' + (caption ? '<caption>' + esc(caption) + '</caption>' : '') + head + body + '</table>';
  }
  function note(text) { return '<p class="report-note">' + esc(text) + '</p>'; }
  function ordersOf(derived, ctx) {
    if (ctx && ctx.orders) return ctx.orders;
    if (derived && derived.orders) return derived.orders;
    if (VOC.store && typeof VOC.store.orders === 'function') { try { return VOC.store.orders(); } catch (e) { return null; } }
    return null;
  }
  function customersOf(derived, ctx) {
    if (ctx && ctx.customers) return ctx.customers;
    if (derived && derived.customers) return derived.customers;
    if (VOC.store && typeof VOC.store.customers === 'function') { try { return VOC.store.customers(); } catch (e) { return null; } }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Sections                                                            */
  /* ------------------------------------------------------------------ */

  function headerHtml(kind, derived, ctx) {
    var now = nowOf(derived);
    var n = isNum(derived.n) ? derived.n : cleanRecords(derived.records).length;
    var periodLabel;
    if (kind === 'weekly') periodLabel = 'Week ending ' + fmtDate(ctx.weekEnding || dayKey(now.toISOString()));
    else periodLabel = fmtDate(ctx.month || monthKey(now.toISOString()), 'month');
    var clock = clockMode(derived);
    var meta = [periodLabel, 'Data range ' + rangeText(derived), 'n=' + fmtInt(n)];
    if (clock === 'demo') meta.push('Demo clock · as of ' + fmtDate(now.toISOString()));
    var title = ctx.title || (kind === 'weekly' ? 'Weekly Voice of the Customer report' : 'Monthly Voice of the Customer report');
    return '<header class="report-header"><p class="report-kicker">L-Nutra · Voice of the Customer</p>' +
      '<h1 class="report-h1 report__title">' + esc(title) + '</h1>' +
      '<p class="report-meta report__meta">' + esc(meta.join(' · ')) + '</p></header>';
  }

  function headlineHtml(derived) {
    var n = N();
    var text = n && typeof n.headline === 'function' ? n.headline(derived) : 'Narrative module unavailable (n=' + fmtInt(cleanRecords(derived.records).length) + ').';
    return section('headline', '<p class="report-lede">' + esc(text) + '</p>');
  }

  function recommendationsHtml(derived) {
    var n = N();
    var recs = n && typeof n.recommendations === 'function' ? n.recommendations(derived) : [];
    if (!recs.length) return section('recommendations', note('No recommendations: the narrative module is unavailable.'));
    return section('recommendations', '<ol class="report-recommendations">' + recs.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ol>');
  }

  function weeklyMedian(id, derived, ctx) {
    var recs = baseRecords(derived);
    if (!recs.length) return null;
    var nowDay = dayKey(nowOf(derived).toISOString());
    var keys = [];
    for (var i = 1; i <= 8; i++) { var k = weekKey(addDays(nowDay, -7 * i)); if (k && keys.indexOf(k) < 0) keys.push(k); }
    if (!keys.length) return null;
    var byWeek = new Map();
    recs.forEach(function (r) { var k = r.week_key || (r.received_at ? weekKey(r.received_at) : null); if (k && keys.indexOf(k) >= 0) { if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(r); } });
    var m = M();
    var values = [];
    keys.forEach(function (k) {
      var list = byWeek.get(k) || [];
      if (id === 'volume') { values.push(list.length); return; }
      if (!m || typeof m.compute !== 'function' || !list.length) return;
      var start = weekStart(k);
      var c = { now: nowOf(derived), from: start, to: start ? addDays(start, 6) : null, orders: ordersOf(derived, ctx), customers: customersOf(derived, ctx), sla: derived.settings && derived.settings.sla };
      if (VOC.store && typeof VOC.store.ordersInRange === 'function') c.ordersInRange = VOC.store.ordersInRange;
      try { var res = m.compute(id, list, c); if (res && isNum(res.value)) values.push(res.value); } catch (e) { /* skip week */ }
    });
    return values.length >= 3 ? median(values) : null;
  }

  function kpiTableHtml(derived, ctx) {
    var days = rangeDays(derived);
    var compare = hasCompare(derived);
    var rows = [];
    KPI_ROWS.forEach(function (id) {
      var k = kpi(derived, id);
      if (!k) return;
      var unit = k.unit || 'count';
      var med = (id === 'volume' || MEDIAN_UNITS[unit]) ? weeklyMedian(id, derived, ctx) : null;
      var medText = isNum(med) ? formatMetric(unit, med, id) + (id === 'volume' ? ' /wk' : '') : '—';
      var interval = k.interval && isNum(k.interval.lo) && isNum(k.interval.hi) ? formatMetric(unit, k.interval.lo, id) + ' – ' + formatMetric(unit, k.interval.hi, id) : '—';
      rows.push([k.label || label('metric', id), formatMetric(unit, k.value, id), compare && isNum(k.prev) ? formatMetric(unit, k.prev, id) : '—',
        compare && k.delta && k.delta.text ? k.delta.text : '—', medText, interval, 'n=' + fmtInt(k.n)]);
    });
    if (!rows.length) return section('kpis', note('No metrics are available for the current filters (n=' + fmtInt(cleanRecords(derived.records).length) + ').'));
    var cols = [{ label: 'Metric' }, { label: 'This period', num: true }, { label: 'Prior', num: true }, { label: 'Δ', num: true }, { label: '8-week median', num: true }, { label: '95% interval', num: true }, { label: 'n', num: true }];
    var foot = 'Prior = ' + priorLabel(derived) + (days ? '; this period spans ' + fmtInt(days) + ' days' : '') + '. The 8-week median takes the eight complete weeks before the as-of date (volume as a weekly total; open-state counts have no weekly median). Every row carries its own n.';
    return section('kpis', table('report-kpis report-table', cols, rows, 'Key metrics; n per row') + note(foot));
  }

  function themeImpactMap(records) {
    var a = A(), out = new Map();
    if (a && typeof a.themeImpact === 'function') { try { arr(a.themeImpact(records)).forEach(function (r) { if (isNum(r.impact)) out.set(r.category, r); }); } catch (e) { /* none */ } }
    return out;
  }
  function themesHtml(derived) {
    var recs = cleanRecords(derived.records), prior = cleanRecords(derived.compare);
    var cats = arr(derived.byCategory).filter(function (c) { return c.count > 0 && c.id !== 'other_noise'; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
    if (!cats.length) return section('themes', note('No themes in range (n=0).'));
    var priorCounts = new Map();
    prior.forEach(function (r) { priorCounts.set(r.category, (priorCounts.get(r.category) || 0) + 1); });
    var impacts = themeImpactMap(recs);
    var compare = hasCompare(derived);
    var rows = cats.map(function (c) {
      var prev = priorCounts.get(c.id) || 0;
      var imp = impacts.get(c.id);
      return [c.label || label('category', c.id), fmtInt(c.count), fmtPct01(c.share), compare ? signed(c.count - prev) : '—', isNum(c.negShare) ? fmtPct01(c.negShare) : '—',
        imp ? signed(imp.impact) + ' pts (n=' + fmtInt(imp.nAll || imp.n) + ')' : '—'];
    });
    var cols = [{ label: 'Theme' }, { label: 'Records', num: true }, { label: 'Share', num: true }, { label: 'Δ vs prior', num: true }, { label: 'Negative', num: true }, { label: 'NPS impact', num: true }];
    return section('themes', table('report-table', cols, rows) + note('NPS impact = NPS(all) − NPS(excluding the theme), on records that carry a score; negative values mean the theme pulls NPS down. n=' + fmtInt(recs.length) + '.'));
  }

  function emergingHtml(derived) {
    var p = P();
    var recs = baseRecords(derived);
    if (!p || typeof p.detectEmerging !== 'function' || typeof p.detectAnomalies !== 'function') return section('emerging', note('Detectors unavailable: the prediction module is not loaded (n=' + fmtInt(recs.length) + ').'));
    var parts = [];
    var em = null;
    try { em = p.detectEmerging(recs, { asOf: nowOf(derived), negativeOnly: false }); } catch (e) { em = null; }
    var flagged = em ? arr(em.rows).filter(function (r) { return r.status === 'new' || r.status === 'emerging'; }).slice(0, 5) : [];
    parts.push('<h3>Emerging units (last 7 days vs the prior 28, all records)</h3>');
    if (!flagged.length) parts.push(note('Nothing is new or emerging (n=' + fmtInt(em ? em.nRecent : 0) + ' recent, ' + fmtInt(em ? em.nBase : 0) + ' baseline records).'));
    else {
      var cols = [{ label: 'Unit' }, { label: 'Type' }, { label: 'Recent', num: true }, { label: 'Expected', num: true }, { label: 'Lift', num: true }, { label: 'z', num: true }, { label: 'Status' }];
      parts.push(table('report-table', cols, flagged.map(function (r) { return [r.label, unitLabel(r.type), fmtInt(r.cR), fmtNum(r.expected, 1), isNum(r.lift) ? fmtNum(r.lift, 1) : '—', fmtNum(r.z, 1), capitalize(r.status)]; })));
      parts.push(note('n=' + fmtInt(em.nRecent) + ' recent, ' + fmtInt(em.nBase) + ' baseline records.'));
    }
    var hs = historySeries(derived), series = hs.series;
    var range = derived.filters && derived.filters.range;
    parts.push('<h3>Anomalous days in range</h3>');
    if (series.length < 35) parts.push(note('Fewer than 35 days of history, so the day-level anomaly detector has no baseline (n=' + fmtInt(series.length) + ' days).'));
    else {
      var an = null;
      try { an = p.detectAnomalies(series, { mode: 'count', now: nowOf(derived) }); } catch (e) { an = null; }
      var events = an ? arr(an.events).filter(function (e) { return !range || !range.from || !range.to || (e.start >= range.from && e.start <= range.to); })
        .sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); }).slice(0, 6) : [];
      if (!events.length) parts.push(note('No day in range sits outside the expected band (n=' + fmtInt(series.length) + ' days of history).'));
      else {
        var acols = [{ label: 'Period' }, { label: 'Records', num: true }, { label: 'Expected', num: true }, { label: 'z', num: true }, { label: 'Severity' }];
        parts.push(table('report-table', acols, events.map(function (e) { return [e.start === e.end || !e.end ? fmtDate(e.start) : fmtRange(e.start, e.end), fmtNum(e.value), fmtNum(e.expected, 1), fmtNum(e.z, 1), capitalize(e.severity)]; })));
        parts.push(note('n=' + fmtInt(series.length) + ' days of history' + (hs.scope === 'all' ? ' (all records in scope)' : '') + '; z = (observed − expected) / expected spread, day-of-week adjusted.'));
      }
    }
    return section('emerging', parts.join(''));
  }

  function productHtml(derived) {
    var recs = cleanRecords(derived.records), prior = cleanRecords(derived.compare);
    var products = arr(derived.byProduct).filter(function (p) { return p.count > 0 && !EXCLUDED_PRODUCTS[p.id]; });
    if (!products.length) return section('product', note('No product mentions in range (n=' + fmtInt(recs.length) + ').'));
    var spot = products.slice().sort(function (a, b) { return (b.neg || 0) - (a.neg || 0) || b.count - a.count; })[0];
    var priorCounts = new Map();
    prior.forEach(function (r) { priorCounts.set(r.product, (priorCounts.get(r.product) || 0) + 1); });
    var inProduct = recs.filter(function (r) { return r.product === spot.id; });
    var catCounts = new Map();
    inProduct.forEach(function (r) { if (isNegative(r)) catCounts.set(r.category, (catCounts.get(r.category) || 0) + 1); });
    var topCats = Array.from(catCounts.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3);
    var scored = inProduct.filter(function (r) { return r.sentiment_label !== 'unscored' && isNum(r.sentiment); });
    var compare = hasCompare(derived);
    var prev = priorCounts.get(spot.id) || 0;
    var lead = (spot.label || label('product', spot.id)) + ' carries the most negatives: ' + fmtInt(spot.count) + ' records (' + fmtPct01(spot.share) + ' of volume)' +
      (isNum(spot.negShare) ? ', ' + fmtPct01(spot.negShare) + ' negative' : '') +
      (isNum(spot.meanSentiment) ? ', sentiment index ' + fmtNum((spot.meanSentiment + 1) / 2 * 100) + ' pts' : '') + ' (n=' + fmtInt(scored.length) + ' scored)' +
      (compare && prev ? '; ' + signed((spot.count - prev) / prev * 100) + '% vs ' + priorLabel(derived) + ' (n=' + fmtInt(prev) + ' prior)' : '') + '.';
    if (topCats.length) lead += ' Negative themes inside it: ' + topCats.map(function (e) { return label('category', e[0]) + ' ' + fmtInt(e[1]); }).join(', ') + '.';
    var cols = [{ label: 'Product' }, { label: 'Records', num: true }, { label: 'Share', num: true }, { label: 'Negative', num: true }, { label: 'Sentiment', num: true }, { label: 'Δ vs prior', num: true }];
    var rows = products.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 6).map(function (p) {
      var pv = priorCounts.get(p.id) || 0;
      return [p.label || label('product', p.id), fmtInt(p.count), fmtPct01(p.share), isNum(p.negShare) ? fmtPct01(p.negShare) : '—',
        isNum(p.meanSentiment) ? fmtNum((p.meanSentiment + 1) / 2 * 100) + ' pts' : '—', compare ? signed(p.count - pv) : '—'];
    });
    return section('product', '<p>' + esc(lead) + '</p>' + table('report-table', cols, rows) + note('n=' + fmtInt(recs.length) + ' records; general and account-only mail excluded.'));
  }

  function remainingText(d) {
    if (d.clock === 'medwatch_15bd') {
      var bd = isNum(d.businessDaysRemaining) ? d.businessDaysRemaining : (d.rec && isNum(d.rec.business_days_remaining) ? d.rec.business_days_remaining : null);
      if (!isNum(bd)) return '—';
      var a = Math.abs(bd);
      return (bd < 0 ? 'overdue ' : '') + fmtNum(a, a < 10 && a % 1 ? 1 : 0) + ' business day' + (a === 1 ? '' : 's');
    }
    var hrs = isNum(d.remaining) ? d.remaining : (d.rec && isNum(d.rec.hours_remaining) ? d.rec.hours_remaining : null);
    if (!isNum(hrs)) return '—';
    return (hrs < 0 ? 'overdue ' : '') + fmtHours(Math.abs(hrs));
  }
  function regulatoryHtml(derived) {
    var reg = derived.regulatory || {};
    var openSerious = arr(reg.openSerious), openFood = arr(reg.openFoodSafety), deadlines = arr(reg.deadlines);
    var rfr = deadlines.filter(function (d) { return d.clock === 'rfr_24h'; });
    var nAll = baseRecords(derived).length;
    var tiles = [['Open serious AEs', openSerious.length], ['RFR 24h clocks', rfr.length], ['Open food-safety reports', openFood.length], ['Deadlines running', deadlines.length]];
    var box = '<div class="report-box report-regulatory"><p class="report-box__label">All records, unfiltered (n=' + fmtInt(nAll) + ')</p><ul class="report-tiles">' +
      tiles.map(function (t) { return '<li><span class="report-tile__value">' + fmtInt(t[1]) + '</span><span class="report-tile__label">' + esc(t[0]) + '</span></li>'; }).join('') + '</ul>';
    if (!deadlines.length) box += note('No MedWatch or Reportable Food Registry deadline is running.');
    else {
      var cols = [{ label: 'Record' }, { label: 'Received (CT)' }, { label: 'Product' }, { label: 'Clock' }, { label: 'Deadline (CT)' }, { label: 'Remaining', num: true }];
      var rows = deadlines.slice(0, 10).map(function (d) {
        var r = d.rec || {};
        return [r.id || '—', r.received_at ? fmtDate(r.received_at, 'datetime') : '—', r.product ? label('product', r.product) : '—',
          d.clock === 'medwatch_15bd' ? 'MedWatch 15 business days' : 'RFR 24 hours', fmtDate(d.deadline, 'datetime'), remainingText(d)];
      });
      box += table('report-table', cols, rows);
    }
    box += '</div>';
    return section('regulatory', box);
  }

  function serviceHtml(derived) {
    var compare = hasCompare(derived);
    var rows = [];
    SERVICE_ROWS.forEach(function (id) {
      var k = kpi(derived, id);
      if (!k) return;
      rows.push([k.label || id, formatMetric(k.unit, k.value, id), compare && isNum(k.prev) ? formatMetric(k.unit, k.prev, id) : '—', compare && k.delta && k.delta.text ? k.delta.text : '—', 'n=' + fmtInt(k.n)]);
    });
    if (!rows.length) return section('service', note('No service metrics for the current filters (n=' + fmtInt(cleanRecords(derived.records).length) + ').'));
    var cols = [{ label: 'Metric' }, { label: 'This period', num: true }, { label: 'Prior', num: true }, { label: 'Δ', num: true }, { label: 'n', num: true }];
    var sla = derived.settings && derived.settings.sla;
    var slaNote = sla ? 'First-response SLA hours: P0 ' + sla.P0 + ', P1 ' + sla.P1 + ', P2 ' + sla.P2 + ', P3 ' + sla.P3 + '.' : '';
    return section('service', table('report-table', cols, rows, 'Service performance; n per row') + (slaNote ? note(slaNote) : ''));
  }

  function truncate(s, max) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s; }
  function verbatimsHtml(derived) {
    var n = N();
    var recs = cleanRecords(derived.records);
    var picks = n && typeof n.verbatims === 'function' ? n.verbatims(recs, { praise: 2, complaint: 3 }) : [];
    if (!picks.length) return section('verbatims', note('No verbatims available for the current filters (n=' + fmtInt(recs.length) + ').'));
    var html = picks.map(function (r) {
      var kind = r.sentiment_label === 'positive' || r.category === 'praise' ? 'praise' : 'complaint';
      var meta = [label('product', r.product), label('category', r.category) + (r.subcategory ? ' › ' + label('subcategory', r.subcategory) : ''), r.received_at ? fmtDate(r.received_at) : null,
        r.sentiment_label ? 'sentiment ' + r.sentiment_label : null, isNum(r.nps) ? 'NPS ' + r.nps : null, r.redacted ? 'restricted record, redacted' : null, r.id].filter(Boolean);
      return '<blockquote class="report-verbatim report-verbatim--' + kind + '">' +
        (r.subject ? '<p class="report-verbatim__subject">' + esc(truncate(r.subject, 120)) + '</p>' : '') +
        '<p class="report-verbatim__text">' + esc(truncate(r.text, 420)) + '</p>' +
        '<footer class="report-verbatim__meta">' + esc(meta.join(' · ')) + '</footer></blockquote>';
    }).join('');
    return section('verbatims', html + note('Two praise and three complaint verbatims, chosen for classifier confidence and length; restricted mail is redacted. n=' + fmtInt(recs.length) + '.'));
  }

  function actionsHtml(ctx) {
    var actions = arr(ctx && ctx.actions);
    if (!actions.length) return section('actions', note('No actions carried forward.'));
    var items = actions.map(function (a) {
      if (typeof a === 'string') return '<li>' + esc(a) + '</li>';
      var bits = [a.owner ? 'owner ' + a.owner : null, a.due ? 'due ' + fmtDate(a.due) : null, a.status || null].filter(Boolean);
      return '<li>' + esc(a.text || a.title || '') + (bits.length ? ' <span class="report-muted">(' + esc(bits.join(' · ')) + ')</span>' : '') + '</li>';
    });
    return section('actions', '<ul class="report-actions">' + items.join('') + '</ul>');
  }

  function forecastHtml(derived) {
    var p = P(), n = N();
    var hs = historySeries(derived), series = hs.series;
    if (!p || typeof p.forecastVolume !== 'function') return section('forecast', note('Forecast unavailable: the prediction module is not loaded (n=' + fmtInt(series.length) + ' days).'));
    if (series.length < 7) return section('forecast', note('Too few days of history to project volume (n=' + fmtInt(series.length) + ' days).'));
    var res = null;
    try { res = p.forecastVolume(series, { horizon: 28, now: nowOf(derived) }); } catch (e) { res = null; }
    if (!res || !arr(res.weekly).length) return section('forecast', note('The forecast returned no weekly blocks (n=' + fmtInt(series.length) + ' days).'));
    var cols = [{ label: 'Week' }, { label: 'Days', num: true }, { label: 'Expected', num: true }, { label: 'Likely (80% band)', num: true }];
    var rows = arr(res.weekly).slice(0, 5).map(function (w) { return [fmtDate(w.weekKey, 'week'), fmtInt(w.days), fmtNum(w.value), fmtNum(w.lo80) + ' – ' + fmtNum(w.hi80)]; });
    var sentence = n && typeof n.forecastSentence === 'function' ? n.forecastSentence(res) : (res.explanation || '');
    var prm = res.params || {}, bt = res.backtest || {};
    var modelBits = ['Model: ' + (res.method || 'n/a')];
    if (isNum(prm.alpha)) modelBits.push('α ' + fmtNum(prm.alpha, 2) + (isNum(prm.beta) ? ', β ' + fmtNum(prm.beta, 2) : '') + (isNum(prm.gamma) ? ', γ ' + fmtNum(prm.gamma, 2) : '') + (isNum(prm.phi) ? ', φ ' + fmtNum(prm.phi, 2) : ''));
    modelBits.push('n=' + fmtInt(res.n) + ' days of history' + (hs.scope === 'all' ? ' (all records in scope, not only the selected range)' : ''));
    modelBits.push(isNum(bt.mape) ? 'backtest MAPE ' + fmtPct01(bt.mape) + (isNum(bt.coverage80) ? ', 80% band coverage ' + fmtPct01(bt.coverage80) : '') + ' over ' + fmtInt(arr(bt.folds).length) + ' folds' : 'no backtest');
    modelBits.push('confidence ' + (res.confidence || 'low'));
    var caveats = arr(res.caveats).map(function (c) { return n && typeof n.lintSafeCaveat === 'function' ? n.lintSafeCaveat(c, bt) : c; })
      .filter(Boolean).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
    return section('forecast', '<p>' + esc(sentence) + '</p>' + table('report-table', cols, rows) + note(modelBits.join(' · ')) + (caveats ? '<ul class="report-caveats">' + caveats + '</ul>' : ''));
  }

  function dqHtml(derived) {
    var dq = derived.dq || {};
    var n = isNum(dq.n) ? dq.n : cleanRecords(derived.records).length;
    var bits = [
      'needs review ' + (isNum(dq.needsReviewPct) ? fmtPct01(dq.needsReviewPct) : '—'),
      'non-English ' + (isNum(dq.nonEnglishPct) ? fmtPct01(dq.nonEnglishPct) : '—'),
      'noise dropped ' + fmtInt(isNum(dq.noiseDropped) ? dq.noiseDropped : 0),
      'duplicates removed ' + fmtInt(isNum(dq.duplicatesRemoved) ? dq.duplicatesRemoved : 0),
      'category agreement ' + (isNum(dq.agreementCategory) ? fmtPct01(dq.agreementCategory) + (isNum(dq.agreementCategoryN) ? ' (n=' + fmtInt(dq.agreementCategoryN) + ')' : '') : '—'),
      'sentiment agreement ' + (isNum(dq.agreementSentiment) ? fmtPct01(dq.agreementSentiment) + (isNum(dq.agreementSentimentN) ? ' (n=' + fmtInt(dq.agreementSentimentN) + ')' : '') : '—'),
      'orders coverage ' + fmtInt(isNum(dq.ordersCoverageMonths) ? dq.ordersCoverageMonths : 0) + ' months'
    ];
    return section('dq', '<p class="report-dq">Data quality (n=' + fmtInt(n) + '): ' + esc(bits.join(' · ')) + '.</p>');
  }

  function methodologyHtml(derived) {
    var m = M();
    var parts = [];
    if (m && m.registry) {
      var cols = [{ label: 'Metric' }, { label: 'Formula' }, { label: 'Unit' }, { label: 'Better' }];
      var rows = Object.keys(m.registry).map(function (id) { var d = m.registry[id]; return [d.label || id, d.formula || '—', d.unit || '—', d.direction === 'up_good' ? 'higher' : d.direction === 'down_good' ? 'lower' : 'neither']; });
      parts.push('<h3>Metric registry</h3>' + table('report-table report-methods', cols, rows));
    } else parts.push(note('Metric registry unavailable in this build.'));
    var lex = VOC.lexicon && VOC.lexicon.version ? VOC.lexicon.version : null, rules = VOC.rules && VOC.rules.version ? VOC.rules.version : null;
    var notes = [
      'Sentiment: lexicon-based (VADER-style) compound per sentence, averaged per record; labels at ±0.15' + (lex ? '; lexicon v' + lex : '') + (rules ? '; rules v' + rules : '') + '.',
      'Sentiment index = (sentiment + 1) / 2 × 100. NPS interval = ±1.96·√((p+d−(p−d)²)/n)·100. Proportions carry Wilson intervals; per-order rates carry Poisson intervals.',
      'Volume forecast: Holt-Winters additive with weekly seasonality and damped trend (falls back to Holt linear, OLS or a flat mean on short history); rolling-origin backtest of 4 folds × 7 days.',
      'Emerging issues: last 7 days vs the prior 28, Poisson surprise z = (recent − expected) / √(expected + 1) for sparse units and a two-proportion z for categories; "new" when the baseline is empty and recent ≥ 3.',
      'Drivers: 2×2 lift against the base negative rate with Yates chi-square and Benjamini–Hochberg adjustment; minimum support 10 records.',
      'What changed: Δ_v = (nNow_v − nPrior_v)·ratePrior_v + nNow_v·(rateNow_v − ratePrior_v), tail grouped as Other.',
      'Regulatory clocks: MedWatch 15 business days (US federal holidays excluded) for every serious adverse event; the statutory 15-day filing applies to dietary supplements (L-Pill), so on a conventional-food kit or a program the same clock tracks a voluntary MedWatch report and the register marks it voluntary. Reportable Food Registry 24 hours for food-safety reports on conventional food and dietary supplements.'
    ];
    parts.push('<h3>Methods</h3><ul class="report-methods-notes">' + notes.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>');
    return section('methodology', parts.join(''));
  }

  /**
   * Footer line: generated timestamp (CT), clock mode, filter context, n, lexicon version.
   * @param {object} derived
   * @param {{generatedAt?:string}} [opts]
   * @returns {string} plain text (not HTML)
   */
  function footerText(derived, opts) {
    opts = opts || {};
    var gen = opts.generatedAt || new Date().toISOString();
    var bits = ['Generated ' + fmtDate(gen, 'datetime')];
    var clock = clockMode(derived);
    if (clock) bits.push(clock === 'demo' ? 'Demo clock · as of ' + fmtDate(nowOf(derived).toISOString()) : 'Real clock');
    if (derived) bits.push('Filters: ' + filterContext(derived));
    var n = derived && isNum(derived.n) ? derived.n : cleanRecords(derived && derived.records).length;
    bits.push('n=' + fmtInt(n));
    if (VOC.lexicon && VOC.lexicon.version) bits.push('Lexicon v' + VOC.lexicon.version);
    bits.push('L-Nutra · Voice of the Customer');
    return bits.join(' · ');
  }
  function footerHtml(derived, ctx) {
    return '<footer class="report-footer report__footer">' + esc(footerText(derived, { generatedAt: ctx && ctx.generatedAt })) + '</footer>';
  }

  /* ------------------------------------------------------------------ */
  /* Assembly                                                            */
  /* ------------------------------------------------------------------ */

  var BUILDERS = {
    headline: function (d) { return headlineHtml(d); },
    recommendations: function (d) { return recommendationsHtml(d); },
    kpis: function (d, c) { return kpiTableHtml(d, c); },
    themes: function (d) { return themesHtml(d); },
    emerging: function (d) { return emergingHtml(d); },
    product: function (d) { return productHtml(d); },
    regulatory: function (d) { return regulatoryHtml(d); },
    service: function (d) { return serviceHtml(d); },
    verbatims: function (d) { return verbatimsHtml(d); },
    actions: function (d, c) { return actionsHtml(c); },
    forecast: function (d) { return forecastHtml(d); },
    dq: function (d) { return dqHtml(d); },
    methodology: function (d) { return methodologyHtml(d); }
  };
  function build(kind, order, derived, ctx) {
    derived = derived || {};
    ctx = ctx || {};
    var body = order.map(function (id) {
      try { return BUILDERS[id](derived, ctx); } catch (e) {
        return section(id, note('This section could not be computed for the current filters (n=' + fmtInt(cleanRecords(derived.records).length) + ').'));
      }
    }).join('');
    return '<article class="report report--' + kind + '" lang="en">' + headerHtml(kind, derived, ctx) + body + footerHtml(derived, ctx) + '</article>';
  }

  /**
   * Weekly report as a self-contained HTML fragment (.report classes).
   * @param {object} derived store.derived()
   * @param {{actions?:Array<string|{text:string,owner?:string,due?:string,status?:string}>, weekEnding?:string, title?:string, orders?:object, customers?:object, generatedAt?:string}} [ctx]
   * @returns {string}
   */
  function weekly(derived, ctx) { return build('weekly', WEEKLY_ORDER, derived, ctx); }

  /**
   * Monthly report: weekly sections plus three recommendations up front and a methodology appendix.
   * @param {object} derived
   * @param {{actions?:Array, month?:string, title?:string, orders?:object, customers?:object, generatedAt?:string}} [ctx]
   * @returns {string}
   */
  function monthly(derived, ctx) { return build('monthly', MONTHLY_ORDER, derived, ctx); }

  var PRINT_CSS = [
    ':root{--bg:#FFFFFF;--surface:#FFFFFF;--surface-2:#F2EAE5;--text:#1C1D1D;--text-2:#3F4A46;--muted:#5F6A66;--border:#E6DED8;--brand:#1E4036;--accent:#56A511;--accent-strong:#3B6D11;--accent-soft:#EAF4DF;',
    '--good:#0CA30C;--warning:#FAB219;--serious:#EC835A;--critical:#D03B3B;--good-text:#006300;--info:#2E6FB8;--font-ui:"Hanken Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;--font-display:"Lora",Georgia,"Times New Roman",serif}',
    '*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:14px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '.report-print{max-width:820px;margin:0 auto;padding:32px 24px}',
    '.report{color:var(--text)}.report-kicker{margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--brand);font-weight:600}',
    '.report-h1{font-family:var(--font-display);font-weight:700;font-size:28px;line-height:1.2;margin:0 0 8px;color:var(--brand)}',
    '.report-h2{font-family:var(--font-display);font-weight:600;font-size:20px;margin:24px 0 12px;padding-bottom:4px;border-bottom:1px solid var(--border);break-after:avoid}',
    '.report h3{font-size:16px;font-weight:600;margin:16px 0 8px}.report p{margin:0 0 12px}.report-meta{color:var(--muted);font-size:13px;margin:0 0 20px}',
    '.report-lede{font-family:var(--font-display);font-size:18px;line-height:1.45;color:var(--text)}.report-note,.report-muted{color:var(--muted);font-size:12px}',
    '.report table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;margin:0 0 12px}.report caption{text-align:left;color:var(--muted);font-size:12px;padding:4px 0}',
    '.report th,.report td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}.report th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;font-weight:600}',
    '.report td.num,.report th.num{text-align:right;white-space:nowrap}.report tr{break-inside:avoid}',
    '.report ul,.report ol{margin:0 0 12px;padding-left:1.3em}.report li{margin:0 0 6px}',
    '.report-section{break-inside:avoid}.report-box{border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 12px;background:var(--surface-2)}',
    '.report-box__label{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}',
    '.report-tiles{list-style:none;padding:0;margin:0 0 12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.report-tiles li{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 12px}',
    '.report-tile__value{display:block;font-size:24px;font-weight:600;line-height:1.1}.report-tile__label{display:block;font-size:12px;color:var(--muted)}',
    '.report-verbatim{margin:0 0 12px;padding:10px 14px;border-left:3px solid var(--border);background:var(--surface-2);border-radius:0 6px 6px 0;break-inside:avoid}',
    '.report-verbatim--praise{border-left-color:var(--good)}.report-verbatim--complaint{border-left-color:var(--critical)}',
    '.report-verbatim__subject{font-weight:600;margin:0 0 4px}.report-verbatim__text{margin:0 0 6px}.report-verbatim__meta{font-size:12px;color:var(--muted)}',
    '.report-footer{margin-top:24px;padding-top:12px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}',
    '@page{size:Letter;margin:14mm}@media print{.report-print{padding:0;max-width:none}.report-h2{break-after:avoid}}'
  ].join('');

  /**
   * Wrap a report fragment in a complete HTML document with inlined light-theme tokens and report styles,
   * so it prints correctly in a new window without the site CSS.
   * @param {string} fragmentHtml
   * @param {{title?:string, footer?:string, derived?:object, generatedAt?:string}} [opts] footer text (plain) or a derived state to build it from
   * @returns {string} full HTML document beginning with <!doctype html>
   */
  function wrapPrintable(fragmentHtml, opts) {
    opts = opts || {};
    var title = opts.title || 'L-Nutra · Voice of the Customer report';
    var footer = typeof opts.footer === 'string' && opts.footer ? opts.footer : footerText(opts.derived || null, { generatedAt: opts.generatedAt });
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + esc(title) + '</title>' +
      '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;family=Lora:wght@600;700&amp;display=swap">' +
      '<style>' + PRINT_CSS + '</style></head><body><main class="report-print">' + (fragmentHtml || '') +
      '</main><footer class="report-footer report-print__footer">' + esc(footer) + '</footer></body></html>';
  }

  VOC.report = {
    version: '1.0.0',
    SECTIONS: SECTIONS,
    WEEKLY_SECTIONS: WEEKLY_ORDER.slice(),
    MONTHLY_SECTIONS: MONTHLY_ORDER.slice(),
    weekly: weekly,
    monthly: monthly,
    wrapPrintable: wrapPrintable,
    footerText: footerText,
    printCss: function () { return PRINT_CSS; }
  };
})();
