/* L-Nutra · Voice of the Customer — Trends view (SPEC §5 item 2)
   Small multiples over time (volume, sentiment index + EWMA band + 14-day forecast, NPS + MoE band,
   first response, resolution median + p90, reopen rate), arrival heatmap, seasonality index and a
   sentiment-drift callout. Loads under jsc: the DOM is touched only inside mount/update/unmount. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'trends';
  var TITLE = 'Trends';
  var DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MIN_DAILY_MEAN = 5;
  var SEASONALITY_MIN_MONTHS = 10;
  var FORECAST_DAYS = 14;
  var PHONE_MAX = 767;
  function isPhone() { return typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth <= PHONE_MAX; }
  /** The EWMA horizon at the display granularity: 14 daily buckets, 2 weekly, 1 monthly (the legend and footnote name it). */
  function forecastHorizon(gran) { return gran === 'day' ? FORECAST_DAYS : gran === 'week' ? 2 : 1; }
  function horizonLabel(gran) { return gran === 'day' ? FORECAST_DAYS + ' days' : gran === 'week' ? '2 weeks' : '1 month'; }
  var EWMA_LAMBDA = { day: 0.15, week: 0.35, month: 0.6 };

  var METRICS = [
    { id: 'volume', title: 'Volume', question: 'How many messages arrived per period?', yLabel: 'messages' },
    { id: 'sentiment_index', title: 'Sentiment index', question: 'Is the tone of customer mail improving or slipping?', yLabel: 'points (0–100)', yMin: 0, yMax: 100, ewma: true },
    { id: 'nps', title: 'NPS', question: 'How does the Net Promoter Score move, with its margin of error?', yLabel: 'NPS', yMin: -100, yMax: 100, moe: true },
    { id: 'frt_median', title: 'First response (median)', question: 'How quickly does the team answer?', yLabel: 'hours' },
    { id: 'resolution_median', title: 'Resolution time', question: 'How long until a case closes, for the typical and the slow cases?', yLabel: 'hours', second: { id: 'resolution_p90', label: 'P90' } },
    { id: 'reopen_rate', title: 'Reopen rate', question: 'How often does a resolved case come back?', yLabel: '% of resolved', yMin: 0 }
  ];

  /* View state persists for the session (SPEC: controls kept in view state). */
  var state = { gran: 'week', rolling: 0, compare: true };

  /* Per-mount runtime. */
  var cur = { root: null, derived: null, cards: {}, els: {}, cache: null, listeners: [] };

  /* ------------------------------------------------------------------ helpers */

  function U() { return VOC.util || null; }
  function EN() { return VOC.enums || (VOC.util && VOC.util.enums) || null; }
  function ui() { return VOC.ui || null; }
  function charts() { return VOC.charts || null; }
  function store() { return VOC.store || null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function esc(s) {
    if (ui() && ui().esc) return ui().esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function h(tag, attrs, children) {
    if (ui() && ui().h) return ui().h(tag, attrs, children);
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    });
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }
  function fmtInt(n) { var u = U(); return u ? u.fmt.int(n) : String(Math.round(n)); }
  function fmtNum(n, d) { var u = U(); return u ? u.fmt.num(n, d || 0) : (isNum(n) ? n.toFixed(d || 0) : '—'); }
  function fmtValue(unit, v) {
    if (ui() && typeof ui().formatValue === 'function') return ui().formatValue(unit, v);
    return isNum(v) ? fmtNum(v, 1) : '—';
  }
  function label(kind, id) { var e = EN(); return e && typeof e.label === 'function' ? e.label(kind, id) : String(id); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + fmtInt(derived.n) + ' records' : '';
  }
  /** "the last 30 days" / "Aug 18 – Sep 16, 2026" for the lead sentence. */
  function rangePhrase(derived) {
    var N = VOC.narrate;
    var r = N && typeof N.rangeLabel === 'function' ? N.rangeLabel(derived) : '';
    if (!r || r === 'Current range') return 'the selected range';
    return /^Last /.test(r) ? 'the ' + r.charAt(0).toLowerCase() + r.slice(1) : r;
  }
  /**
   * One bold sentence for the header: what the small multiples cover and the sentiment index with n.
   * @param {Object|null} derived
   * @param {Object|null} c  data(derived) (for the granularity)
   */
  function leadText(derived, c) {
    if (!derived || !isNum(derived.n)) return 'Data is loading.';
    var gran = c && c.gran ? c.gran : 'week';
    var granWord = gran === 'day' ? 'Daily' : gran === 'month' ? 'Monthly' : 'Weekly';
    var si = derived.kpis && derived.kpis.sentiment_index;
    var head = granWord + ' volume, tone, NPS and service times for ' + rangePhrase(derived);
    if (si && isNum(si.value)) return head + '; sentiment index ' + fmtNum(si.value) + ' pts (n=' + fmtInt(si.n) + ' scored of ' + fmtInt(derived.n) + ').';
    return head + ' (n=' + fmtInt(derived.n) + ' records; no scored records for a sentiment index).';
  }
  function buildHeader(derived) {
    if (ui() && typeof ui().viewHeader === 'function') return ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived, null) });
    return h('header', { class: 'view-header' }, [h('h1', { class: 'view-title' }, TITLE), h('p', { class: 'view-meta', 'data-role': 'subtitle' }, subtitle(derived))]);
  }
  function setHeader(derived, c) {
    var hd = cur.els && cur.els.header;
    if (!hd) return;
    if (hd.setMeta) hd.setMeta(subtitle(derived)); else { var sub = hd.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(derived); }
    if (hd.setLead) hd.setLead(leadText(derived, c));
  }
  function registryDef(id) { return (VOC.metrics && VOC.metrics.registry && VOC.metrics.registry[id]) || null; }
  function unitOf(id) { var d = registryDef(id); return d && d.unit ? d.unit : 'count'; }
  function formulaOf(id) { var d = registryDef(id); return d && d.formula ? d.formula : ''; }

  /** Short axis label for a day / week / month key. */
  function shortLabel(key, gran) {
    var u = U();
    var s = String(key || '');
    if (/^\d{4}-W\d{2}$/.test(s)) { s = u && u.weekStart ? u.weekStart(s) : s; gran = 'day'; }
    if (/^\d{4}-\d{2}$/.test(s)) { var mm = +s.slice(5, 7); return MONTH_SHORT[mm - 1] + ' ’' + s.slice(2, 4); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { var m2 = +s.slice(5, 7), d2 = +s.slice(8, 10); return MONTH_SHORT[m2 - 1] + ' ' + d2; }
    return s;
  }
  /** The key that follows `key` at the given granularity (used to extend the axis for forecasts). */
  function nextKey(key, gran) {
    var u = U();
    if (!u) return String(key) + '+1';
    if (gran === 'week') return u.weekKey(u.addDays(u.weekStart(key), 7) + 'T18:00:00Z');
    if (gran === 'month') return u.addMonths(key, 1);
    return u.addDays(key, 1);
  }
  function setCardN(card, n) {
    if (!card) return;
    var span = card.querySelector('.chart-card__n');
    if (!span) {
      var q = card.querySelector('.chart-card__question');
      if (!q) return;
      span = h('span', { class: 'chart-card__n' });
      q.appendChild(document.createTextNode(' · '));
      q.appendChild(span);
    }
    span.textContent = 'n = ' + fmtInt(isNum(n) ? n : 0);
  }
  function refreshCard(card) { if (card && typeof card.vocRefresh === 'function') card.vocRefresh(); }
  function destroyCard(card) { if (card && typeof card.vocDestroy === 'function') card.vocDestroy(); }

  /**
   * Private helper: lets an HTML renderer (heatmap) live inside a chartCard so it gets the Chart|Table toggle,
   * CSV and ƒ popover. Suggested for components.js as a `renderHtml` option on chartCard.
   */
  function htmlHandle(canvas, renderInto, tableFn) {
    var wrap = canvas && canvas.parentNode;
    if (!wrap) return null;
    var host = wrap.querySelector('.html-chart');
    if (!host) { host = h('div', { class: 'html-chart' }); wrap.appendChild(host); }
    canvas.style.display = 'none';
    host.hidden = false;
    renderInto(host);
    return {
      chart: null, el: host,
      update: function () { renderInto(host); return this; },
      destroy: function () { host.innerHTML = ''; host.hidden = true; canvas.style.display = ''; },
      toTable: tableFn
    };
  }

  /* ------------------------------------------------------------------ data */

  function ctxFor(derived, from, to) {
    var s = store();
    return {
      now: derived.now, from: from, to: to,
      orders: s && typeof s.orders === 'function' ? s.orders() : null,
      ordersInRange: s && typeof s.ordersInRange === 'function' ? s.ordersInRange : null,
      customers: s && typeof s.customers === 'function' ? s.customers() : null,
      allRecords: derived.allRecords || derived.records,
      sla: derived.settings && derived.settings.sla
    };
  }

  /** Effective granularity: daily only when the range averages ≥5 records/day, else weekly with a note. */
  function effectiveGran(derived) {
    var f = derived && derived.filters, u = U();
    if (state.gran !== 'day') return { gran: state.gran, note: null };
    var days = f && f.range && u ? (u.daysBetween(f.range.from, f.range.to) + 1) : null;
    var mean = derived && isNum(days) && days > 0 ? derived.n / days : 0;
    if (mean >= MIN_DAILY_MEAN) return { gran: 'day', note: null };
    return {
      gran: 'week',
      note: 'Daily view needs about ' + MIN_DAILY_MEAN + ' or more messages a day; this range averages ' + fmtNum(mean, 1) +
        ' a day (n = ' + fmtInt(derived ? derived.n : 0) + '), so the charts fall back to weekly buckets.'
    };
  }
  /** Rolling window in buckets for the chosen granularity (7d/28d expressed in days). */
  function rollingBuckets(gran) {
    var days = state.rolling;
    if (!days) return 0;
    if (gran === 'day') return days;
    if (gran === 'week') return Math.max(0, Math.round(days / 7));
    return Math.max(0, Math.round(days / 28));
  }

  function computeSeries(id, records, ctx, gran, rolling) {
    var m = VOC.metrics;
    if (!m || typeof m.series !== 'function') return [];
    try { return m.series(id, records, ctx, { granularity: gran, rolling: rolling }) || []; } catch (e) { return []; }
  }

  /** All series for the current derived state, memoized until the next update. */
  function data(derived) {
    if (cur.cache && cur.cache.derived === derived) return cur.cache;
    var eff = effectiveGran(derived);
    var gran = eff.gran;
    var rolling = rollingBuckets(gran);
    var f = derived.filters;
    var ctx = ctxFor(derived, f.range.from, f.range.to);
    var cr = derived.compareRange || null;
    var hasCompare = state.compare && cr && Array.isArray(derived.compare) && f.compare !== 'none';
    var ctxPrev = hasCompare ? ctxFor(derived, cr.from, cr.to) : null;
    var c = { derived: derived, gran: gran, rolling: rolling, note: eff.note, hasCompare: !!hasCompare, series: {}, prev: {} };
    var ids = [];
    METRICS.forEach(function (m) { ids.push(m.id); if (m.second) ids.push(m.second.id); });
    ids.forEach(function (id) {
      c.series[id] = computeSeries(id, derived.records, ctx, gran, rolling);
      if (hasCompare) c.prev[id] = computeSeries(id, derived.compare, ctxPrev, gran, rolling);
    });
    /* EWMA smoothing + forecast on the sentiment index at the display granularity. */
    c.ewma = null;
    var pr = VOC.predict;
    if (pr && typeof pr.forecastSentiment === 'function') {
      var horizon = forecastHorizon(gran);
      try {
        c.ewma = pr.forecastSentiment(c.series.sentiment_index.map(function (p) { return { key: p.key, value: p.value, n: p.n }; }),
          { horizon: horizon, lambda: EWMA_LAMBDA[gran] || 0.15, now: derived.now });
      } catch (e) { c.ewma = null; }
      if (c.ewma && Array.isArray(c.ewma.forecast) && c.series.sentiment_index.length) {
        var k = c.series.sentiment_index[c.series.sentiment_index.length - 1].key;
        c.ewma.forecast.forEach(function (p) { k = nextKey(k, gran); p.key = k; });
      }
    }
    /* Weekly sentiment drift over the range (or the trailing 12 weeks of history when the range is short). */
    c.drift = null;
    if (pr && typeof pr.sentimentDrift === 'function') {
      var weekly = gran === 'week' ? c.series.sentiment_index : computeSeries('sentiment_index', derived.records, ctx, 'week', 0);
      var scope = 'range';
      var scoredWeeks = weekly.filter(function (p) { return isNum(p.value); }).length;
      if (scoredWeeks < 4 && Array.isArray(derived.allRecords) && U()) {
        var from12 = U().addDays(f.range.to, -83);
        weekly = computeSeries('sentiment_index', derived.allRecords.filter(function (r) { return r.day_key >= from12 && r.day_key <= f.range.to; }), ctxFor(derived, from12, f.range.to), 'week', 0);
        scope = 'history';
      }
      try { c.drift = pr.sentimentDrift(weekly, { weeks: 12, now: derived.now }); } catch (e) { c.drift = null; }
      if (c.drift) c.drift.scope = scope;
    }
    cur.cache = c;
    return c;
  }

  /* ------------------------------------------------------------------ chart specs */

  function alignPrev(prev, len) {
    var out = [];
    for (var i = 0; i < len; i++) out.push(prev && prev[i] && isNum(prev[i].value) ? prev[i].value : null);
    return out;
  }

  /** Build the line spec for one small multiple; returns null when no bucket carries a value. */
  function specFor(metric, c) {
    var C = charts();
    var s = c.series[metric.id] || [];
    var values = s.map(function (p) { return isNum(p.value) ? p.value : null; });
    var anyValue = values.some(isNum);
    var labels = s.map(function (p) { return shortLabel(p.key, c.gran); });
    var datasets = [];
    var unit = unitOf(metric.id);
    var pointRadius = s.length > 40 ? 0 : 2;

    if (metric.ewma && c.ewma && Array.isArray(c.ewma.history) && c.ewma.history.length === s.length) {
      var fc = c.ewma.forecast || [];
      var nHist = s.length;
      fc.forEach(function (p) { labels.push(shortLabel(p.key, c.gran)); });
      var pad = function (arr, tail) { var out = arr.slice(); for (var i = 0; i < tail; i++) out.push(null); return out; };
      datasets.push({ label: 'Observed', data: pad(values, fc.length), slot: 'other', pointRadius: 2 });
      var smoothed = c.ewma.history.map(function (p) { return isNum(p.smoothed) ? p.smoothed : null; });
      var lo = c.ewma.history.map(function (p) { return isNum(p.lo) ? p.lo : null; });
      var hi = c.ewma.history.map(function (p) { return isNum(p.hi) ? p.hi : null; });
      datasets.push({ label: 'Smoothed (EWMA)', data: pad(smoothed, fc.length), slot: 1, pointRadius: 0, band: { lo: pad(lo, fc.length), hi: pad(hi, fc.length) } });
      if (fc.length) {
        var fData = [], fLo = [], fHi = [];
        for (var i = 0; i < nHist - 1; i++) { fData.push(null); fLo.push(null); fHi.push(null); }
        var last = c.ewma.history[nHist - 1];
        fData.push(isNum(last.smoothed) ? last.smoothed : null); fLo.push(isNum(last.lo) ? last.lo : null); fHi.push(isNum(last.hi) ? last.hi : null);
        fc.forEach(function (p) { fData.push(p.value); fLo.push(p.lo); fHi.push(p.hi); });
        datasets.push({ label: 'Forecast (' + horizonLabel(c.gran) + ')', data: fData, slot: 1, dashed: true, pointRadius: 0, band: { lo: fLo, hi: fHi } });
      }
      if (c.hasCompare) datasets.push({ label: 'Prior period', data: pad(alignPrev(c.prev[metric.id], s.length), fc.length), slot: 'other', dashed: true, pointRadius: 0 });
    } else {
      var main = { label: metric.title, data: values, slot: 1, pointRadius: pointRadius };
      if (metric.moe) {
        var lo2 = s.map(function (p) { return p.interval && isNum(p.interval.lo) ? p.interval.lo : null; });
        var hi2 = s.map(function (p) { return p.interval && isNum(p.interval.hi) ? p.interval.hi : null; });
        if (lo2.some(isNum)) main.band = { lo: lo2, hi: hi2 };
        main.label = 'NPS (95% MoE band)';
      }
      datasets.push(main);
      if (metric.second) {
        var s2 = c.series[metric.second.id] || [];
        datasets.push({ label: metric.second.label, data: s2.map(function (p) { return isNum(p.value) ? p.value : null; }), slot: 3, pointRadius: pointRadius });
        main.label = 'Median';
      }
      if (c.hasCompare) datasets.push({ label: 'Prior period', data: alignPrev(c.prev[metric.id], s.length), slot: 'other', dashed: true, pointRadius: 0 });
    }
    if (!anyValue || !C) return null;
    var spec = { labels: labels, datasets: datasets, yLabel: metric.yLabel, ariaLabel: metric.title + ' by ' + c.gran + ', ' + s.length + ' periods' };
    if (metric.yMin != null) spec.yMin = metric.yMin;
    if (metric.yMax != null) spec.yMax = metric.yMax;
    if (unit === 'pct') spec.percent = true;
    return spec;
  }

  /** Table twin for a metric: one row per bucket with value, band, second series, prior and forecast. */
  function tableFor(metric, c) {
    var s = c.series[metric.id] || [];
    var unit = unitOf(metric.id);
    var fmtV = function (v) { return isNum(v) ? fmtValue(unit, v) : '—'; };
    var columns = [{ key: 'period', label: 'Period' }, { key: 'value', label: metric.second ? 'Median' : metric.title, format: fmtV }, { key: 'n', label: 'n' }];
    if (metric.moe) columns.push({ key: 'lo', label: 'MoE low', format: fmtV }, { key: 'hi', label: 'MoE high', format: fmtV });
    if (metric.ewma) columns.push({ key: 'smoothed', label: 'Smoothed', format: fmtV }, { key: 'lo', label: 'Band low', format: fmtV }, { key: 'hi', label: 'Band high', format: fmtV });
    if (metric.second) columns.push({ key: 'second', label: metric.second.label, format: fmtV });
    if (c.hasCompare) columns.push({ key: 'prior', label: 'Prior period', format: fmtV });
    var rows = s.map(function (p, i) {
      var row = { period: String(p.key), value: isNum(p.value) ? p.value : null, n: p.n };
      if (metric.moe && p.interval) { row.lo = p.interval.lo; row.hi = p.interval.hi; }
      if (metric.ewma && c.ewma && c.ewma.history && c.ewma.history[i]) { row.smoothed = c.ewma.history[i].smoothed; row.lo = c.ewma.history[i].lo; row.hi = c.ewma.history[i].hi; }
      if (metric.second) { var s2 = (c.series[metric.second.id] || [])[i]; row.second = s2 && isNum(s2.value) ? s2.value : null; }
      if (c.hasCompare) { var pp = (c.prev[metric.id] || [])[i]; row.prior = pp && isNum(pp.value) ? pp.value : null; }
      return row;
    });
    if (metric.ewma && c.ewma && Array.isArray(c.ewma.forecast)) {
      c.ewma.forecast.forEach(function (p) { rows.push({ period: String(p.key) + ' (forecast)', value: null, n: 0, smoothed: p.value, lo: p.lo, hi: p.hi }); });
    }
    return { columns: columns, rows: rows };
  }

  function nFor(metric, c) {
    var s = c.series[metric.id] || [];
    if (metric.id === 'volume') return c.derived.n;
    var n = 0;
    s.forEach(function (p) { if (isNum(p.n)) n += p.n; });
    if (c.rolling > 1) return c.derived.n;
    return n;
  }

  function footnoteFor(metric, c) {
    var parts = [];
    var g = c.gran === 'day' ? 'daily' : c.gran === 'week' ? 'weekly' : 'monthly';
    parts.push(g + ' buckets');
    if (c.rolling > 1) parts.push('rolling ' + c.rolling + '-' + c.gran + ' window');
    if (metric.ewma && c.ewma) {
      parts.push('EWMA λ ' + fmtNum((c.ewma.params && c.ewma.params.lambda) || 0, 2) + ', band ±1.28σ');
      var fc = c.ewma.forecast || [];
      if (fc.length) {
        var last = fc[fc.length - 1];
        parts.push('next ' + horizonLabel(c.gran) + ' likely ' + fmtNum(last.lo) + '–' + fmtNum(last.hi) + ' points (confidence ' + (c.ewma.confidence || 'low') + ')');
      }
    }
    if (metric.moe) parts.push('band = ±1.96·√((p+d−(p−d)²)/n)·100');
    if (metric.second) parts.push('same unit, same axis');
    if (c.hasCompare) parts.push('dashed grey = prior period aligned by bucket');
    return parts.join(' · ');
  }

  /* ------------------------------------------------------------------ controls */

  function segmented(options, value, onChange, ariaLabel) {
    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': ariaLabel });
    options.forEach(function (o) {
      var b = h('button', { type: 'button', 'aria-pressed': String(o.value === value), 'data-value': String(o.value) }, o.label);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        onChange(o.value);
      });
      seg.appendChild(b);
    });
    return seg;
  }

  function buildControls() {
    var row = h('div', { class: 'controls-row trends-controls' });
    row.appendChild(h('span', { class: 'label' }, 'Granularity'));
    row.appendChild(segmented([{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }], state.gran, function (v) { state.gran = v; rerender(); }, 'Granularity'));
    row.appendChild(h('span', { class: 'label' }, 'Rolling'));
    row.appendChild(segmented([{ value: 0, label: 'None' }, { value: 7, label: '7d' }, { value: 28, label: '28d' }], state.rolling, function (v) { state.rolling = v; rerender(); }, 'Rolling window'));
    var cb = h('input', { type: 'checkbox' });
    cb.checked = !!state.compare;
    cb.addEventListener('change', function () { state.compare = cb.checked; rerender(); });
    row.appendChild(h('label', { class: 'switch' }, [cb, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', { class: 'switch__label' }, 'Compare overlay')]));
    var note = h('span', { class: 'muted t-13 trends-controls__note', 'data-role': 'controls-note' });
    row.appendChild(note);
    cur.els.controlsNote = note;
    return row;
  }

  function rerender() {
    cur.cache = null;
    if (cur.derived) update(cur.derived);
  }

  /* ------------------------------------------------------------------ heatmap + seasonality + drift */

  function heatmapData(derived) {
    var A = VOC.analytics;
    if (!A || typeof A.heatmap !== 'function') return null;
    try { return A.heatmap(derived.records); } catch (e) { return null; }
  }
  function heatmapTable(derived) {
    var hm = heatmapData(derived);
    var columns = [{ key: 'dow', label: 'Weekday' }];
    for (var c = 0; c < 24; c++) columns.push({ key: 'h' + c, label: String(c) });
    columns.push({ key: 'total', label: 'Total' });
    var rows = [];
    if (hm) hm.matrix.forEach(function (r, i) {
      var row = { dow: DOW_LABELS[i] }, t = 0;
      r.forEach(function (v, j) { row['h' + j] = v; t += v; });
      row.total = t;
      rows.push(row);
    });
    return { columns: columns, rows: rows };
  }
  function renderHeatmap(canvas) {
    var derived = cur.derived, C = charts();
    var hm = heatmapData(derived);
    if (!hm || !hm.n || !C || typeof C.heatmap !== 'function') return null;
    var colLabels = []; for (var i = 0; i < 24; i++) colLabels.push(String(i));
    return htmlHandle(canvas, function (host) {
      host.className = 'html-chart trends-heatmap';
      C.heatmap(host, hm.matrix, {
        rowLabels: DOW_LABELS, colLabels: colLabels, colLabelEvery: isPhone() ? 6 : 3,
        ariaLabel: 'Arrivals by weekday and hour, Central Time',
        format: function (v, r, c) {
          var s = hm.sentiment && hm.sentiment[r] ? hm.sentiment[r][c] : null;
          return (v === 1 ? '1 message' : fmtInt(v) + ' messages') + (isNum(s) ? ' · mean sentiment ' + fmtNum(s, 2) : '');
        },
        onClick: function (r, c) {
          // SPEC §5.2: the cell opens the Inbox filtered to that weekday × hour. FilterState has no dow/hour, so the slot
          // travels as view-private hash keys (dow=, hour=) that the Inbox post-filters on and shows as a chip.
          var s = store();
          var q = s && typeof s.toQuery === 'function' ? s.toQuery() : '';
          q += (q ? '&' : '') + 'dow=' + r + '&hour=' + c;
          if (VOC.router) VOC.router.navigate('inbox', { query: q });
        }
      });
    }, function () { return heatmapTable(derived); });
  }

  function seasonalityResult(derived) {
    var pr = VOC.predict;
    if (!pr || typeof pr.seasonalityIndex !== 'function') return null;
    var cat = derived.filters && Array.isArray(derived.filters.category) && derived.filters.category.length ? derived.filters.category[0] : null;
    var recs = Array.isArray(derived.allRecords) ? derived.allRecords : derived.records;
    try { var r = pr.seasonalityIndex(recs, cat, { now: derived.now }); if (r) r.categoryId = cat; return r; } catch (e) { return null; }
  }
  function seasonalitySpec(res) {
    var C = charts();
    var rows = res && Array.isArray(res.rows) ? res.rows : [];
    if (!rows.length || !C) return null;
    return {
      labels: rows.map(function (r) { return shortLabel(r.month, 'month'); }),
      datasets: [{ label: 'Seasonality index', data: rows.map(function (r) { return isNum(r.index) ? r.index : null; }), slot: 1 }],
      vertical: true, yLabel: 'index (100 = average month)', yMin: 0,
      annotations: [{ y: 100, label: 'Average = 100' }],
      ariaLabel: 'Seasonality index by month, ' + rows.length + ' months'
    };
  }
  function seasonalityTable(res) {
    var rows = res && Array.isArray(res.rows) ? res.rows : [];
    return {
      columns: [{ key: 'month', label: 'Month' }, { key: 'index', label: 'Index (100 = avg)' }, { key: 'n', label: 'n' }, { key: 'total', label: 'All records that month' }],
      rows: rows.map(function (r) { return { month: r.month, index: r.index, n: r.n, total: r.total }; })
    };
  }

  function renderDrift(c) {
    var box = cur.els.drift;
    if (!box) return;
    var d = c.drift;
    if (!d || !d.alert) { box.hidden = true; box.innerHTML = ''; return; }
    var scope = d.scope === 'history' ? ' The range is short, so the slope uses the trailing 12 weeks of history with the same filters removed.' : '';
    box.hidden = false;
    box.innerHTML = '<strong>Sentiment drift alert.</strong> ' + esc(d.explanation || '') + esc(scope) +
      ' <span class="muted">(rule: slope × 12 &lt; −5 points; n = ' + esc(fmtInt(d.n)) + ' weeks; confidence ' + esc(d.confidence || 'low') + ')</span>';
  }

  /* ------------------------------------------------------------------ mount / update / unmount */

  function buildCards(derived) {
    var c = data(derived);
    var grid = h('div', { class: 'trends-multiples' });
    METRICS.forEach(function (metric) {
      var card = ui().chartCard({
        id: 'trend-' + metric.id, title: metric.title, question: metric.question, formula: formulaOf(metric.id), n: nFor(metric, c),
        height: 240, csvName: 'lnutra-voc-trends-' + metric.id + '.csv',
        render: function (canvas) {
          var cc = data(cur.derived);
          var spec = specFor(metric, cc);
          return spec ? charts().line(canvas, spec) : null;
        },
        table: function () { return tableFor(metric, data(cur.derived)); },
        footnote: footnoteFor(metric, c)
      });
      cur.cards[metric.id] = card;
      grid.appendChild(card);
    });
    return grid;
  }

  function mount(root, derived) {
    cur.root = root;
    cur.derived = derived;
    cur.cards = {};
    cur.els = {};
    cur.cache = null;

    root.innerHTML = '';
    cur.els.header = buildHeader(derived);
    root.appendChild(cur.els.header);

    if (!derived || !ui() || typeof ui().chartCard !== 'function') {
      var body = h('div', { class: 'card' });
      root.appendChild(body);
      if (ui() && ui().emptyState) ui().emptyState(body, { title: 'Trends needs the data store and UI kit', text: 'The store or components module did not load, so there is nothing to chart yet.' });
      else body.textContent = 'Trends needs the data store and UI kit to render.';
      return;
    }

    root.appendChild(buildControls());
    cur.els.granNote = h('div', { class: 'notice trends-note', hidden: true, role: 'status' });
    root.appendChild(cur.els.granNote);

    if (derived.n < 3) {
      cur.els.empty = h('div', { class: 'card trends-empty' });
      ui().emptyState(cur.els.empty, { title: 'Too few records to chart (n = ' + fmtInt(derived.n) + ')', text: 'Widen the date range or clear a filter. Trend lines need at least a few records per period to say anything.' });
      root.appendChild(cur.els.empty);
    }

    root.appendChild(buildCards(derived));

    cur.els.drift = h('div', { class: 'notice notice--warning trends-drift', hidden: true, role: 'status' });
    root.appendChild(cur.els.drift);

    var bottom = h('div', { class: 'trends-bottom' });
    cur.cards.heatmap = ui().chartCard({
      id: 'trend-heatmap', title: 'Arrival heatmap', question: 'When does mail arrive, by weekday and hour (Central Time)? Click a cell to open the Inbox for that weekday and hour.',
      defaultMode: isPhone() ? 'table' : 'chart',
      formula: 'count(records) per (weekday, hour) in America/Chicago; shade = count ÷ max', n: derived.n, height: 260,
      csvName: 'lnutra-voc-trends-heatmap.csv',
      render: renderHeatmap, table: function () { return heatmapTable(cur.derived); },
      footnote: 'Rows Mon–Sun, columns 0–23 h. Hover a cell for the count and mean sentiment.' + (isPhone() ? ' On a phone the table opens first; the Chart button shows the grid.' : '')
    });
    bottom.appendChild(cur.cards.heatmap);

    var seasonRes = seasonalityResult(derived);
    cur.cards.seasonality = ui().chartCard({
      id: 'trend-seasonality', title: 'Seasonality index', question: seasonalityQuestion(seasonRes),
      formula: 'index_m = value_m ÷ mean(value over months) × 100; value = monthly volume, or the category’s share of monthly volume', n: seasonRes ? seasonRes.n : 0, height: 260,
      csvName: 'lnutra-voc-trends-seasonality.csv',
      render: function (canvas) { var r = seasonalityResult(cur.derived); return charts() ? charts().bar(canvas, seasonalitySpec(r)) : null; },
      table: function () { return seasonalityTable(seasonalityResult(cur.derived)); },
      footnote: 'Uses the full history, not the selected date range. Hidden when fewer than ' + SEASONALITY_MIN_MONTHS + ' months carry records.'
    });
    bottom.appendChild(cur.cards.seasonality);
    root.appendChild(bottom);

    applyDerived(derived, seasonRes);
  }

  function seasonalityQuestion(res) {
    var cat = res && res.categoryId ? label('category', res.categoryId) : null;
    return cat ? 'Which months over- or under-index for ' + cat + ' (share of that month’s mail)?' : 'Which months run hotter or colder than the yearly average? Select a category to see its seasonal share.';
  }

  /** Apply derived state to the notes, subtitles and seasonality visibility (charts refresh separately). */
  function applyDerived(derived, seasonRes) {
    var c = data(derived);
    setHeader(derived, c);
    if (cur.els.granNote) {
      cur.els.granNote.hidden = !c.note;
      cur.els.granNote.textContent = c.note || '';
    }
    if (cur.els.controlsNote) {
      var bits = [];
      if (c.rolling > 1) bits.push('rolling window = ' + c.rolling + ' ' + c.gran + (c.rolling === 1 ? '' : 's'));
      else if (state.rolling && c.rolling <= 1) bits.push('a ' + state.rolling + 'd window equals one ' + c.gran + ' bucket, so no smoothing applies');
      if (state.compare && !c.hasCompare) bits.push('no comparison period selected in the filter bar');
      cur.els.controlsNote.textContent = bits.join(' · ');
    }
    METRICS.forEach(function (m) {
      var card = cur.cards[m.id];
      if (!card) return;
      setCardN(card, nFor(m, c));
      var foot = card.querySelector('.chart-card__foot');
      if (foot) foot.textContent = footnoteFor(m, c);
    });
    renderDrift(c);
    if (cur.cards.heatmap) setCardN(cur.cards.heatmap, derived.n);
    var res = seasonRes || seasonalityResult(derived);
    var months = res && Array.isArray(res.rows) ? res.rows.length : 0;
    if (cur.cards.seasonality) {
      cur.cards.seasonality.hidden = months < SEASONALITY_MIN_MONTHS;
      var q = cur.cards.seasonality.querySelector('.chart-card__question');
      if (q) q.innerHTML = esc(seasonalityQuestion(res));
      setCardN(cur.cards.seasonality, res ? res.n : 0);
    }
    if (cur.els.empty) cur.els.empty.hidden = derived.n >= 3;
  }

  function update(derived) {
    if (!cur.root || !derived) return;
    if (!cur.cards || !Object.keys(cur.cards).length) { mount(cur.root, derived); return; }
    cur.derived = derived;
    cur.cache = null;
    var seasonRes = seasonalityResult(derived);
    applyDerived(derived, seasonRes);
    Object.keys(cur.cards).forEach(function (k) { refreshCard(cur.cards[k]); });
  }

  function unmount() {
    Object.keys(cur.cards || {}).forEach(function (k) { destroyCard(cur.cards[k]); });
    cur.cards = {};
    cur.els = {};
    cur.cache = null;
    cur.root = null;
    cur.derived = null;
  }

  VOC.views[NAME] = { title: TITLE, icon: NAME, mount: mount, update: update, unmount: unmount };
})();
