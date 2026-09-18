/* L-Nutra · Voice of the Customer — Briefing view (SPEC §5 item 1)
 * Executive headline (3–4 bold statements from narrate.headlineParts), five insight cards, KPI strip with 8-week sparklines, weekly volume + 4-week outlook,
 * theme impact on NPS, share of voice vs order share, topic share by sentiment, alert feed and verbatims.
 * Touches the DOM only inside mount/update/unmount (loads silently under jsc).
 */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'briefing';
  var TITLE = 'Briefing';
  var KPI_IDS = ['volume', 'net_sentiment', 'nps', 'csat', 'frt_median', 'complaints_per_1k', 'open_p0_p1', 'detractor_recovery'];
  var EMPTY_REASON = {
    volume: 'No records in range',
    net_sentiment: 'No scored records in range',
    nps: 'No survey responses in range',
    csat: 'No CSAT responses in range',
    frt_median: 'No first responses recorded',
    complaints_per_1k: 'No orders on file for this range',
    open_p0_p1: 'No open P0/P1 records',
    detractor_recovery: 'No detractors awaiting follow-up'
  };
  var LIST_KEYS = ['product', 'category', 'subcategory', 'channel', 'sales_channel', 'segment', 'region', 'urgency', 'status', 'assignee'];
  var SPARK_WEEKS = 8;
  var HISTORY_DAYS = 182;          // 26 weeks of daily history for the forecast fit
  var MIN_HISTORY_WEEKS = 8;       // weeks of history always shown for context
  var VERBATIM_MAX_CHARS = 320;

  /* ------------------------------------------------------------------ helpers */

  function U() { return VOC.util || null; }
  function ui() { return VOC.ui || null; }
  function charts() { return VOC.charts || null; }
  function store() { return VOC.store || null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function round(x, d) { var m = Math.pow(10, d || 0); return Math.round(x * m) / m; }

  function esc(s) {
    var u = U();
    if (u && typeof u.escapeHtml === 'function') return u.escapeHtml(s == null ? '' : String(s));
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  /** Tiny DOM builder (mirrors VOC.ui.h so the view renders even if components.js is late). */
  function h(tag, attrs, children) {
    if (ui() && typeof ui().h === 'function') return ui().h(tag, attrs, children);
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.keys(v).forEach(function (dk) { el.dataset[dk] = v[dk]; });
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    });
    if (children != null) (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  function label(kind, id) {
    var e = VOC.enums;
    if (e && typeof e.label === 'function') { try { return e.label(kind, id); } catch (err) { /* fall through */ } }
    return String(id == null ? '—' : id);
  }
  function fmtInt(n) { var u = U(); return u ? u.fmt.int(n) : (isNum(n) ? String(Math.round(n)) : '—'); }
  function fmtNum(n, d) { var u = U(); return u ? u.fmt.num(n, d || 0) : (isNum(n) ? String(round(n, d || 0)) : '—'); }
  function fmtDate(iso, gran) { var u = U(); return u ? u.fmt.date(iso, gran || 'day') : String(iso || '—'); }
  function fmtValue(unit, v) { return ui() && ui().formatValue ? ui().formatValue(unit, v) : fmtNum(v, 1); }
  function shortWeek(weekKey) {
    var u = U();
    if (!u) return weekKey;
    return fmtDate(u.weekStart(weekKey), 'day').replace(/, \d{4}$/, '');
  }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + fmtInt(derived.n) + ' records' : '';
  }
  function toast(msg, kind) { if (ui() && ui().toast) ui().toast(msg, kind || 'info'); }
  function drill(target) {
    var s = store();
    if (s && typeof s.drill === 'function') { s.drill(target); return; }
    if (VOC.router && typeof VOC.router.navigate === 'function') VOC.router.navigate(target.view, { id: target.id });
  }
  function emptyInto(el, opts) {
    if (ui() && ui().emptyState) { ui().emptyState(el, opts); return; }
    el.innerHTML = '<div class="empty-state"><div class="empty-state__title">' + esc(opts.title) + '</div>' + (opts.text ? '<p class="empty-state__text">' + esc(opts.text) + '</p>' : '') + '</div>';
  }
  function sparkInto(el, values, opts) {
    var c = charts();
    if (c && typeof c.sparkline === 'function' && arr(values).filter(isNum).length >= 2) { try { c.sparkline(el, values, opts || {}); } catch (e) { el.innerHTML = ''; } }
  }
  /** Card wrapper with an h2 title, optional subtitle and a right-side link. */
  function sectionCard(title, subtitleText, link) {
    var head = h('div', { class: 'card__header' }, [
      h('div', {}, [h('h2', { class: 'card__title' }, title), h('p', { class: 'card__subtitle' }, subtitleText || '')]),
      link ? h('a', { class: 'card__link', href: link.href }, link.text) : null
    ]);
    var body = h('div', { class: 'card__body' });
    var card = h('section', { class: 'card', 'aria-label': title }, [head, body]);
    card.vocBody = body;
    return card;
  }

  /* ------------------------------------------------------------------ record scoping */

  /** All non-noise records that match every current filter except the date range (for sparklines and forecast history). */
  function contextRecords(d) {
    var f = d.filters || {};
    var recs = arr(d.allRecords).length ? d.allRecords : arr(d.records);
    var search = String(f.search || '').trim().toLowerCase();
    var lists = LIST_KEYS.filter(function (k) { return arr(f[k]).length; });
    var sentiment = arr(f.sentiment);
    if (!lists.length && !sentiment.length && !f.restrictedQueue && !search) return recs;
    return recs.filter(function (r) {
      for (var i = 0; i < lists.length; i++) { if (f[lists[i]].indexOf(r[lists[i]]) < 0) return false; }
      if (sentiment.length && sentiment.indexOf(r.sentiment_label) < 0) return false;
      if (f.restrictedQueue && !r.restricted) return false;
      if (search) {
        var hay = ((r.subject || '') + '\n' + (r.text || '') + '\n' + (r.from_name || '') + '\n' + (r.order_id || '')).toLowerCase();
        if (hay.indexOf(search) < 0) return false;
      }
      return true;
    });
  }
  function ctxFor(d, from, to) {
    var s = store() || {};
    return {
      now: d.now, from: from, to: to,
      orders: typeof s.orders === 'function' ? s.orders() : null,
      ordersInRange: typeof s.ordersInRange === 'function' ? s.ordersInRange : null,
      customers: typeof s.customers === 'function' ? s.customers() : null,
      allRecords: arr(d.allRecords), sla: d.settings && d.settings.sla, settings: d.settings
    };
  }

  /* ------------------------------------------------------------------ KPI strip */

  /** Weekly metric values for the last 8 ISO weeks ending in the range's last week. */
  function sparkSeries(d, ctxRecs) {
    var m = VOC.metrics, u = U(), out = {};
    if (!m || typeof m.series !== 'function' || !u || !d.filters || !d.filters.range) return out;
    var to = d.filters.range.to;
    var from = u.addDays(u.weekStart(u.weekKey(to)), -7 * (SPARK_WEEKS - 1));
    var recs = ctxRecs.filter(function (r) { return r.day_key >= from && r.day_key <= to; });
    var ctx = ctxFor(d, from, to);
    KPI_IDS.forEach(function (id) {
      try { out[id] = m.series(id, recs, ctx, { granularity: 'week' }).slice(-SPARK_WEEKS).map(function (p) { return p.value; }); } catch (e) { out[id] = null; }
    });
    return out;
  }
  function renderKpis(S, d) {
    var host = S.els.kpis;
    host.innerHTML = '';
    if (!ui() || typeof ui().kpiTile !== 'function') { emptyInto(host, { title: 'UI kit missing', text: 'components.js did not load; the KPI strip needs VOC.ui.kpiTile.' }); return; }
    var sparks = sparkSeries(d, S.ctxRecs);
    var reg = (VOC.metrics && VOC.metrics.registry) || {};
    KPI_IDS.forEach(function (id) {
      var k = (d.kpis || {})[id] || null;
      var def = reg[id] || {};
      var tile = ui().kpiTile({
        id: id,
        label: (k && k.label) || def.label || id,
        value: k ? k.value : null,
        unit: (k && k.unit) || def.unit || 'count',
        prev: k ? k.prev : null,
        delta: k ? k.delta : null,
        deltaNote: k ? k.deltaNote || null : null,
        direction: (k && k.direction) || def.direction || 'neutral',
        n: k ? k.n : 0,
        interval: k && isNum(k.n) && k.n < 200 ? k.interval : null,
        spark: sparks[id] || null,
        formula: def.formula || null,
        onClick: function () { drill({ view: 'trends' }); }
      });
      if (!k || !isNum(k.value)) {
        var v = tile.querySelector('.kpi-tile__value');
        if (v) { v.textContent = k ? (EMPTY_REASON[id] || 'No data') : 'Metric unavailable'; v.classList.add('kpi-tile__value--reason'); }
      }
      tile.setAttribute('title', 'Open Trends');
      host.appendChild(tile);
    });
  }

  /* ------------------------------------------------------------------ charts */

  function destroyCards(S) {
    S.cards.forEach(function (c) { if (c && typeof c.vocDestroy === 'function') { try { c.vocDestroy(); } catch (e) { /* gone */ } } });
    S.cards = [];
  }
  function addCard(S, host, opts) {
    if (!ui() || typeof ui().chartCard !== 'function') {
      var box = h('section', { class: 'card' });
      emptyInto(box, { title: opts.title, text: 'Chart cards need VOC.ui.chartCard (components.js).' });
      host.appendChild(box);
      return box;
    }
    var card = ui().chartCard(opts);
    S.cards.push(card);
    host.appendChild(card);
    return card;
  }
  function weekCount(u, from, to) {
    return Math.floor(u.daysBetween(u.weekStart(u.weekKey(from)), u.weekStart(u.weekKey(to))) / 7) + 1;
  }

  /** History (complete weeks), forecast blocks (current partial week blended + 4 full weeks) and anomalous weeks. */
  function buildVolumeModel(d, ctxRecs) {
    var u = U(), A = VOC.analytics, P = VOC.predict;
    if (!u || !A || typeof A.bucket !== 'function' || !d.filters || !d.filters.range) return null;
    var range = d.filters.range, to = range.to;
    var rangeWeeks = weekCount(u, range.from, to);
    var histFrom = u.weekStart(u.weekKey(u.addDays(to, -(HISTORY_DAYS - 1))));
    if (range.from < histFrom) histFrom = u.weekStart(u.weekKey(range.from));
    var recs = ctxRecs.filter(function (r) { return r.day_key >= histFrom && r.day_key <= to; });
    var daily = A.bucket(recs, 'day', { from: histFrom, to: to }).map(function (b) { return { key: b.key, value: b.count }; });
    var weekly = A.bucket(recs, 'week', { from: histFrom, to: to }).map(function (b) { return { key: b.key, value: b.count }; });
    var curWk = u.weekKey(to);
    var sunday = u.addDays(u.weekStart(curWk), 6);
    var partial = to < sunday;
    var complete = partial ? weekly.filter(function (w) { return w.key !== curWk; }) : weekly;
    var history = complete.slice(-Math.max(rangeWeeks, MIN_HISTORY_WEEKS));

    var anomalies = {};
    if (P && typeof P.detectAnomalies === 'function' && complete.length >= 5) {
      try {
        var res = P.detectAnomalies(complete, { mode: 'count', warn: 2, critical: 3, now: d.now });
        arr(res && res.events).forEach(function (e) {
          complete.forEach(function (w) { if (w.key >= e.start && w.key <= e.end) anomalies[w.key] = e; });
        });
      } catch (e) { anomalies = {}; }
    }

    var fc = null, blocks = [];
    if (P && typeof P.forecastVolume === 'function' && daily.length >= 7) {
      var horizon = (partial ? u.daysBetween(to, sunday) : 0) + 28;
      try { fc = P.forecastVolume(daily, { horizon: horizon, z: [1.28, 1.96], now: d.now }); } catch (e) { fc = null; }
    }
    if (fc && arr(fc.forecast).length) {
      var sigma = fc.params && isNum(fc.params.sigma) ? fc.params.sigma : null;
      var map = new Map();
      fc.forecast.forEach(function (f, i) {
        var wk = u.weekKey(f.key);
        var b = map.get(wk);
        if (!b) { b = { key: wk, value: 0, hSum: 0, days: 0, lo80: null, hi80: null }; map.set(wk, b); }
        b.value += isNum(f.value) ? f.value : 0; b.hSum += i + 1; b.days += 1;
      });
      arr(fc.weekly).forEach(function (w) { var b = map.get(w.weekKey); if (b && isNum(w.value)) { b.value = w.value; b.lo80 = w.lo80; b.hi80 = w.hi80; } });
      blocks = Array.from(map.values()).map(function (b) {
        var w80 = sigma !== null ? 1.28 * sigma * Math.sqrt(b.hSum) : null;
        var w95 = sigma !== null ? 1.96 * sigma * Math.sqrt(b.hSum) : null;
        if (!isNum(b.lo80) && w80 !== null) { b.lo80 = Math.max(0, b.value - w80); b.hi80 = b.value + w80; }
        b.lo95 = w95 !== null ? Math.max(0, b.value - w95) : null;
        b.hi95 = w95 !== null ? b.value + w95 : null;
        return b;
      });
      if (partial && blocks.length && blocks[0].key === curWk) {
        var cur = weekly.filter(function (w) { return w.key === curWk; })[0];
        var actual = cur ? cur.value : 0;
        var b0 = blocks[0];
        b0.actual = actual; b0.blend = true;
        ['value', 'lo80', 'hi80', 'lo95', 'hi95'].forEach(function (k) { if (isNum(b0[k])) b0[k] += actual; });
      }
    }
    return { history: history, blocks: blocks, anomalies: anomalies, fc: fc, partial: partial, curWk: curWk, histFrom: histFrom,
      daily: daily, rangeFrom: range.from, to: to, n: daily.reduce(function (s, p) { return s + p.value; }, 0) };
  }
  function volumeRows(model) {
    var rows = model.history.map(function (w) {
      var a = model.anomalies[w.key];
      return { week: shortWeek(w.key) + ' (' + w.key + ')', records: w.value, forecast: null, lo80: null, hi80: null, lo95: null, hi95: null, anomaly: a ? 'z = ' + fmtNum(a.z, 1) + ' (' + a.severity + ')' : '' };
    });
    model.blocks.forEach(function (b) {
      rows.push({ week: shortWeek(b.key) + ' (' + b.key + ')' + (b.blend ? ' · in progress' : ''), records: b.blend ? b.actual : null, forecast: round(b.value, 1),
        lo80: isNum(b.lo80) ? round(b.lo80, 1) : null, hi80: isNum(b.hi80) ? round(b.hi80, 1) : null, lo95: isNum(b.lo95) ? round(b.lo95, 1) : null, hi95: isNum(b.hi95) ? round(b.hi95, 1) : null, anomaly: '' });
    });
    return {
      columns: [{ key: 'week', label: 'Week starting' }, { key: 'records', label: 'Records' }, { key: 'forecast', label: 'Forecast' },
        { key: 'lo80', label: 'Low (80%)' }, { key: 'hi80', label: 'High (80%)' }, { key: 'lo95', label: 'Low (95%)' }, { key: 'hi95', label: 'High (95%)' }, { key: 'anomaly', label: 'Anomaly' }],
      rows: rows
    };
  }
  function volumeSpec(model) {
    var hist = model.history, blocks = model.blocks, hLen = hist.length;
    var keys = hist.map(function (w) { return w.key; }).concat(blocks.map(function (b) { return b.key; }));
    var labels = keys.map(shortWeek);
    var nulls = function () { return keys.map(function () { return null; }); };
    var histData = hist.map(function (w) { return w.value; }).concat(blocks.map(function () { return null; }));
    var fcData = nulls(), lo80 = nulls(), hi80 = nulls(), lo95 = nulls(), hi95 = nulls();
    if (hLen && blocks.length) { var last = hist[hLen - 1].value; fcData[hLen - 1] = last; lo80[hLen - 1] = hi80[hLen - 1] = lo95[hLen - 1] = hi95[hLen - 1] = last; }
    blocks.forEach(function (b, i) {
      var j = hLen + i;
      fcData[j] = round(b.value, 1);
      lo80[j] = isNum(b.lo80) ? round(b.lo80, 1) : null; hi80[j] = isNum(b.hi80) ? round(b.hi80, 1) : null;
      lo95[j] = isNum(b.lo95) ? round(b.lo95, 1) : null; hi95[j] = isNum(b.hi95) ? round(b.hi95, 1) : null;
    });
    var anom = hist.map(function (w) { return model.anomalies[w.key] ? w.value : null; }).concat(blocks.map(function () { return null; }));
    var datasets = [{ label: 'Weekly volume', data: histData, slot: 1, pointRadius: 2 }];
    if (blocks.length) {
      if (lo95.some(isNum)) datasets.push({ label: '95% band', data: nulls(), slot: 1, band: { lo: lo95, hi: hi95 }, pointRadius: 0 });
      datasets.push({ label: 'Forecast (80% band)', data: fcData, slot: 1, dashed: true, band: { lo: lo80, hi: hi80 }, pointRadius: 3 });
    }
    if (anom.some(isNum)) datasets.push({ label: 'Anomalous week (|z| ≥ 2)', data: anom, slot: 1, pointRadius: 7 });
    var annotations = hLen && blocks.length ? [{ x: labels[hLen - 1], label: 'Forecast →' }] : [];
    return {
      labels: labels, datasets: datasets, yLabel: 'Records per week', xLabel: 'Week starting (Mon)', annotations: annotations,
      ariaLabel: 'Weekly record volume for ' + hLen + ' weeks with a ' + blocks.filter(function (b) { return !b.blend; }).length + '-week forecast, 80% and 95% bands' + (anom.some(isNum) ? ' and anomalous weeks marked' : ''),
      onClick: function (index) {
        var u = U();
        if (!u) return;
        if (index < hLen) {
          var from = u.weekStart(hist[index].key);
          var to = u.addDays(from, 6);
          if (to > model.to) to = model.to;
          drill({ view: 'inbox', filters: { range: { preset: 'custom', from: from, to: to } } });
          return;
        }
        var b = blocks[index - hLen];
        if (b && b.blend) { drill({ view: 'inbox', filters: { range: { preset: 'custom', from: u.weekStart(b.key), to: model.to } } }); return; }
        toast('That week is a forecast; there are no records to open yet.', 'info');
      }
    };
  }
  function volumeFootnote(model) {
    var parts = [];
    if (model.fc && VOC.narrate && typeof VOC.narrate.forecastSentence === 'function') { try { parts.push(VOC.narrate.forecastSentence(model.fc)); } catch (e) { /* skip */ } }
    else if (model.fc && model.fc.explanation) parts.push(model.fc.explanation);
    if (!model.fc) parts.push('Fewer than 7 days of history in scope, so no projection is drawn.');
    parts.push('Dashed = projection; shading = 80% (inner) and 95% (outer) bands; enlarged points = weeks at least 2σ from their trailing baseline.');
    if (model.partial && model.blocks.length && model.blocks[0].blend) parts.push('The week in progress combines ' + fmtInt(model.blocks[0].actual) + ' records so far with the projected remainder.');
    if (model.history.length && model.history[0].key < U().weekKey(model.rangeFrom)) parts.push('Weeks before ' + fmtDate(model.rangeFrom) + ' are shown for context (n = ' + fmtInt(model.n) + ' records in the fitted window).');
    if (model.fc && model.fc.confidence && model.fc.confidence !== 'high') parts.push('Model confidence: ' + model.fc.confidence + '; read the band as indicative.');
    return parts.join(' ');
  }
  function renderVolumeCard(S, d, host) {
    var model = null;
    try { model = buildVolumeModel(d, S.ctxRecs); } catch (e) { model = null; }
    var c = charts();
    addCard(S, host, {
      id: 'volume-forecast',
      title: 'Weekly volume and 4-week outlook',
      question: 'How much feedback is arriving, and what should the next four weeks look like?',
      formula: 'history = count(records) per ISO week · forecast = Holt-Winters additive (m = 7, damped trend) on zero-filled daily counts, summed into weekly blocks · band = z · σ · √Σh (z = 1.28 for 80%, 1.96 for 95%) · anomaly = |value − trailing-baseline mean| ≥ 2σ',
      n: model ? model.n : 0,
      height: 320,
      render: function (canvas) {
        if (!model || !model.history.length || !c || typeof c.line !== 'function') return null;
        return c.line(canvas, volumeSpec(model));
      },
      table: function () { return model ? volumeRows(model) : { columns: [], rows: [] }; },
      csvName: 'lnutra-voc-briefing-volume-forecast.csv',
      footnote: model ? volumeFootnote(model) : 'The analytics or predict module is missing, so the volume outlook cannot be drawn.'
    });
  }

  function renderImpactCard(S, d, host) {
    var A = VOC.analytics, c = charts();
    var rows = [];
    if (A && typeof A.themeImpact === 'function') {
      try { rows = A.themeImpact(arr(d.records)).filter(function (r) { return isNum(r.impact); }); } catch (e) { rows = []; }
    }
    rows.sort(function (a, b) { return Math.abs(b.impact) - Math.abs(a.impact); });
    rows = rows.slice(0, 10);
    var nAll = rows.length ? rows[0].nAll : 0;
    addCard(S, host, {
      id: 'theme-impact',
      title: 'Theme impact on NPS',
      question: 'Which topics move the score most when they show up?',
      formula: 'Impact = NPS(all respondents) − NPS(respondents not tagged with the category, primary or secondary) · sorted by |impact|',
      n: nAll,
      render: function (canvas) {
        if (!rows.length || !c || typeof c.diverging !== 'function') return null;
        return c.diverging(canvas, {
          labels: rows.map(function (r) { return label('category', r.category); }),
          datasets: [{ label: 'NPS impact (points)', data: rows.map(function (r) { return round(r.impact, 1); }) }],
          xLabel: 'Impact on NPS (points)',
          ariaLabel: 'Signed horizontal bars: change in NPS attributable to each of ' + rows.length + ' categories',
          onClick: function (i) { if (rows[i]) drill({ view: 'themes', filters: { category: [rows[i].category] } }); }
        });
      },
      table: function () {
        return {
          columns: [{ key: 'category', label: 'Category' }, { key: 'impact', label: 'Impact (pts)' }, { key: 'npsAll', label: 'NPS all' }, { key: 'npsExcl', label: 'NPS excluding' }, { key: 'n', label: 'Respondents tagged' }],
          rows: rows.map(function (r) { return { category: label('category', r.category), impact: round(r.impact, 1), npsAll: isNum(r.npsAll) ? round(r.npsAll, 1) : null, npsExcl: isNum(r.npsExcl) ? round(r.npsExcl, 1) : null, n: r.n }; })
        };
      },
      csvName: 'lnutra-voc-briefing-theme-impact.csv',
      footnote: rows.length
        ? 'Negative bars drag NPS down, positive bars lift it. n = ' + fmtInt(nAll) + ' NPS respondents in range; a category with few respondents swings more. Click a bar to open Themes.'
        : 'Needs survey responses with an NPS score (0–10); none are in this range.'
    });
  }

  function renderSovCard(S, d, host) {
    var A = VOC.analytics, c = charts(), s = store(), u = U();
    var rows = [];
    var f = d.filters || {};
    var range = f.range || {};
    if (A && typeof A.shareOfVoice === 'function' && range.from && range.to) {
      try { rows = A.shareOfVoice(arr(d.records), s && typeof s.orders === 'function' ? s.orders() : null, range.from, range.to); } catch (e) { rows = []; }
    }
    rows = rows.filter(function (r) { return r.mentions > 0; }).slice(0, 8);
    var hasOrders = rows.some(function (r) { return isNum(r.orderShare); });
    var card = addCard(S, host, {
      id: 'share-of-voice',
      title: 'Share of voice vs share of orders',
      question: 'Which products draw more feedback than their sales would predict?',
      formula: 'mention share = mentions(product) / mentions(all) · order share = orders(product) / orders(all) over the months in range · index = mention share ÷ order share',
      n: arr(d.records).length,
      render: function (canvas) {
        if (!rows.length || !c || typeof c.paired !== 'function') return null;
        // Mentions take each product's fixed slot color; orders are one neutral grey (--s-other) so the two series differ
        // by hue, not by translucency. The Chart.js legend would show only the first bar's color per series, so it is off
        // and the footnote + the per-product index badges carry the key.
        var datasets = [{ label: 'Share of mentions', data: rows.map(function (r) { return round(r.mentionShare * 100, 1); }), colors: rows.map(function (r) { return c.slotColor(r.product); }) }];
        if (hasOrders) datasets.push({ label: 'Share of orders', data: rows.map(function (r) { return isNum(r.orderShare) ? round(r.orderShare * 100, 1) : null; }), slot: 'other' });
        return c.paired(canvas, {
          labels: rows.map(function (r) { return label('product', r.product); }),
          datasets: datasets, percent: true, xLabel: 'Share (%)', legend: false,
          ariaLabel: 'Paired horizontal bars comparing share of mentions with share of orders for ' + rows.length + ' products',
          onClick: function (i) { if (rows[i]) drill({ view: 'products', filters: { product: [rows[i].product] } }); }
        });
      },
      table: function () {
        return {
          columns: [{ key: 'product', label: 'Product' }, { key: 'mentions', label: 'Mentions' }, { key: 'mentionShare', label: 'Mention share %' }, { key: 'orders', label: 'Orders' }, { key: 'orderShare', label: 'Order share %' }, { key: 'index', label: 'Index' }],
          rows: rows.map(function (r) { return { product: label('product', r.product), mentions: r.mentions, mentionShare: round(r.mentionShare * 100, 1), orders: isNum(r.orders) ? Math.round(r.orders) : null, orderShare: isNum(r.orderShare) ? round(r.orderShare * 100, 1) : null, index: isNum(r.index) ? round(r.index, 2) : null }; })
        };
      },
      csvName: 'lnutra-voc-briefing-share-of-voice.csv',
      footnote: !rows.length ? 'No product mentions in range.'
        : hasOrders ? 'Colored bar = share of mentions in the product’s own color; grey bar = share of orders. Index = mention share ÷ order share; above 1.2 a product draws more feedback than its sales predict, below 0.8 less. Orders come from the monthly order counts for the months in this range' + (u && range.from ? ' (' + fmtDate(range.from, 'month') + ' – ' + fmtDate(range.to, 'month') + ')' : '') + '.'
        : 'No orders are on file for the months in this range, so only the share of mentions is shown. Add orders by month in Settings → Orders to compare against order share.'
    });
    if (hasOrders && card && card.classList && card.classList.contains('chart-card')) {
      var badges = h('div', { class: 'sov-badges', role: 'list', 'aria-label': 'Share-of-voice index by product' });
      rows.forEach(function (r) {
        if (!isNum(r.index)) return;
        var flag = r.index > 1.2;
        badges.appendChild(h('span', { class: 'sov-badge' + (flag ? ' sov-badge--flag' : r.index < 0.8 ? ' sov-badge--under' : ''), role: 'listitem', title: label('product', r.product) + ': ' + fmtInt(r.mentions) + ' mentions vs ' + fmtInt(r.orders) + ' orders' }, [
          h('span', { class: 'sov-badge__swatch', 'aria-hidden': 'true', style: { background: c ? c.slotColor(r.product) : 'var(--s-other)' } }),
          h('span', { class: 'sov-badge__name' }, label('product', r.product)),
          h('span', { class: 'sov-badge__index' }, fmtNum(r.index, 2) + '×' + (flag ? ' over-indexed' : ''))
        ]));
      });
      var foot = card.querySelector('.chart-card__foot');
      if (foot) card.insertBefore(badges, foot); else card.appendChild(badges);
    }
  }

  function renderTopicCard(S, d, host) {
    var c = charts();
    var n = arr(d.records).length;
    var counts = {};
    arr(d.byCategory).forEach(function (row) { counts[row.id] = { id: row.id, count: row.count, primary: row.count, mean: row.meanSentiment, neg: row.neg }; });
    arr(d.records).forEach(function (r) {
      arr(r.secondary_categories).forEach(function (cat) {
        if (!counts[cat]) counts[cat] = { id: cat, count: 0, primary: 0, mean: null, neg: 0 };
        counts[cat].count += 1;
      });
    });
    var rows = Object.keys(counts).map(function (k) { return counts[k]; })
      .filter(function (r) { return r.count > 0 && r.id !== 'other_noise'; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 12);
    // One sentiment→color mapping site-wide (VOC.charts.sentimentColor: neutral band ±0.15, poles at ±1) so a category
    // keeps the same shade here and on Themes.
    function colorFor(mean) {
      if (!c) return undefined;
      return c.sentimentColor(isNum(mean) ? mean : null);
    }
    addCard(S, host, {
      id: 'topic-share',
      title: 'Topic share by sentiment',
      question: 'What are people writing about, and how do they feel about each topic?',
      formula: 'share = records tagged with the category (primary or secondary) / records in range × 100 · color = mean lexicon sentiment of primary-category records',
      n: n,
      render: function (canvas) {
        if (!rows.length || !n || !c || typeof c.bar !== 'function') return null;
        return c.bar(canvas, {
          labels: rows.map(function (r) { return label('category', r.id); }),
          datasets: [{ label: 'Share of records', data: rows.map(function (r) { return round(r.count / n * 100, 1); }), colors: rows.map(function (r) { return colorFor(r.mean); }) }],
          percent: true, xLabel: 'Share of records (%)',
          ariaLabel: 'Horizontal bars: share of records per category for ' + rows.length + ' categories, colored by mean sentiment',
          onClick: function (i) { if (rows[i]) drill({ view: 'themes', filters: { category: [rows[i].id] } }); }
        });
      },
      table: function () {
        return {
          columns: [{ key: 'category', label: 'Category' }, { key: 'count', label: 'Records (multi-label)' }, { key: 'share', label: 'Share %' }, { key: 'mean', label: 'Mean sentiment' }, { key: 'primary', label: 'Primary records' }],
          rows: rows.map(function (r) { return { category: label('category', r.id), count: r.count, share: n ? round(r.count / n * 100, 1) : null, mean: isNum(r.mean) ? round(r.mean, 2) : null, primary: r.primary }; })
        };
      },
      csvName: 'lnutra-voc-briefing-topic-share.csv',
      footnote: 'Multi-label — a record can carry a primary and secondary categories, so shares of the n = ' + fmtInt(n) + ' records can exceed 100%. Bar color = mean sentiment on the shared scale: red negative, grey neutral (within ±0.15), blue positive, full color at ±1 — the same shade the Themes category bars use. Click a bar to open Themes.'
    });
  }

  function renderCharts(S, d) {
    var host = S.els.charts;
    destroyCards(S);
    host.innerHTML = '';
    renderVolumeCard(S, d, host);
    renderImpactCard(S, d, host);
    renderSovCard(S, d, host);
    renderTopicCard(S, d, host);
  }

  /* ------------------------------------------------------------------ headline + insights */

  /** The headline as 3–4 bold statements (narrate.headlineParts); falls back to the prose headline as one item. */
  function renderHeadline(S, d) {
    var parts = [];
    var N = VOC.narrate;
    if (N && typeof N.headlineParts === 'function') { try { parts = arr(N.headlineParts(d)).filter(Boolean); } catch (e) { parts = []; } }
    if (!parts.length && N && typeof N.headline === 'function') { try { parts = [N.headline(d) || '']; } catch (e) { parts = []; } }
    parts = parts.filter(Boolean);
    if (!parts.length) parts = [isNum(d.n) ? fmtInt(d.n) + ' records in range.' : 'Data is loading.'];
    var host = S.els.headline;
    host.innerHTML = '';
    parts.forEach(function (text) { host.appendChild(h('li', { class: 'briefing-lead__item', text: text })); });
  }
  function renderInsights(S, d) {
    var host = S.els.insights;
    host.innerHTML = '';
    var cards = [];
    if (VOC.narrate && typeof VOC.narrate.insights === 'function') { try { cards = arr(VOC.narrate.insights(d)); } catch (e) { cards = []; } }
    if (!cards.length) {
      var box = h('div', { class: 'card', style: { gridColumn: '1 / -1' } });
      emptyInto(box, { title: 'Insights unavailable', text: VOC.narrate ? 'No insight could be computed for the current filters (n = ' + fmtInt(d.n || 0) + ').' : 'The narrative module (narrate.js) did not load.' });
      host.appendChild(box);
      return;
    }
    cards.slice(0, 5).forEach(function (card) {
      if (ui() && typeof ui().insightCard === 'function') { host.appendChild(ui().insightCard(card)); return; }
      host.appendChild(h('article', { class: 'insight-card insight-card--' + esc(card.severity || 'info') }, [
        h('div', { class: 'insight-card__kind', text: card.kind || '' }), h('h3', { class: 'insight-card__title', text: card.title || '' }),
        h('p', { class: 'insight-card__text', text: card.text || '' }), card.evidence ? h('p', { class: 'insight-card__evidence', text: card.evidence }) : null,
        card.drill ? h('button', { class: 'btn btn--link insight-card__drill', type: 'button', onclick: function () { drill(card.drill); } }, 'Show me →') : null
      ]));
    });
  }

  /* ------------------------------------------------------------------ alert feed */

  function alertSpark(a, d) {
    if (arr(a.spark).filter(isNum).length >= 2) return a.spark;
    var days = arr(d.byDay).slice(-28);
    if (a.ruleId === 'volume_zscore') return days.map(function (p) { return p.count; });
    if (a.ruleId === 'neg_share_zscore') return days.map(function (p) { var s = p.neg + p.pos + p.neu; return s ? round(p.neg / s * 100, 1) : null; });
    if (a.ruleId === 'sentiment_drift') return arr(d.byWeek).filter(function (w) { return isNum(w.meanSentiment); }).slice(-12).map(function (w) { return round((w.meanSentiment + 1) / 2 * 100, 1); });
    return null;
  }
  function ruleLabel(ruleId) {
    var rules = VOC.alerts && typeof VOC.alerts.rules === 'function' ? VOC.alerts.rules() : [];
    var r = rules.filter(function (x) { return x.id === ruleId; })[0];
    return r ? r.label : String(ruleId || '');
  }
  function alertRow(S, d, a) {
    var body = h('div', { class: 'alert-row__body' }, [
      h('div', { class: 'alert-row__title', text: a.title || '' }),
      a.detail ? h('div', { class: 'alert-row__detail', text: a.detail }) : null
    ]);
    var meta = h('div', { class: 'alert-row__meta' }, [
      h('span', { class: 'alert-row__when', title: 'When (Central Time)' }, fmtDate(a.at, 'datetime')),
      h('span', { class: 'alert-row__rule' }, ruleLabel(a.ruleId))
    ]);
    var sparkVals = alertSpark(a, d);
    if (sparkVals) {
      var sp = h('span', { class: 'alert-row__spark', 'aria-hidden': 'true' });
      sparkInto(sp, sparkVals, { width: 96, height: 22 });
      meta.appendChild(sp);
    }
    body.appendChild(meta);
    var pill = ui() && ui().pill ? ui().pill('severity', a.severity) : h('span', { class: 'pill pill--severity-' + esc(a.severity) }, a.severity);
    var actions = h('div', { class: 'alert-row__actions' }, [
      h('button', {
        class: 'btn btn--ghost btn--xs', type: 'button', 'aria-label': 'Acknowledge: ' + (a.title || ''),
        onclick: function () {
          if (!VOC.alerts || typeof VOC.alerts.ack !== 'function') return;
          VOC.alerts.ack(a.id);
          S.hiddenAlerts[a.id] = true;
          renderAlerts(S, S.derived);
          if (ui() && ui().toast) ui().toast('Alert acknowledged.', 'good', { undo: function () { if (VOC.alerts.unack) VOC.alerts.unack(a.id); delete S.hiddenAlerts[a.id]; renderAlerts(S, S.derived); } });
        }
      }, 'Ack'),
      a.drill ? h('button', { class: 'btn btn--link btn--xs', type: 'button', onclick: function () { drill(a.drill); } }, 'Show me →') : null
    ]);
    return h('article', { class: 'alert-row alert-row--' + esc(a.severity || 'info'), dataset: { alert: a.id } }, [pill, body, actions]);
  }
  function renderAlerts(S, d) {
    var body = S.els.alertsBody;
    body.innerHTML = '';
    var all = arr(d.alerts);
    var active = all.filter(function (a) { return !a.acked && !a.snoozedUntil && !S.hiddenAlerts[a.id]; });
    var sub = S.els.alertsCard.querySelector('.card__subtitle');
    if (sub) sub.textContent = active.length ? fmtInt(active.length) + ' active · showing the top ' + Math.min(5, active.length) + ' by severity' : (VOC.alerts ? 'Rules re-run on every filter change' : 'alerts.js did not load');
    if (!active.length) {
      emptyInto(body, { title: 'No active alerts — all quiet', text: VOC.alerts ? 'Statistical rules need at least 14 days in range; pick 30d or longer to score spikes.' : 'The alerts module did not load, so no rules were evaluated.', icon: 'check', kind: 'good' });
      return;
    }
    var list = h('div', { class: 'alert-feed' });
    active.slice(0, 5).forEach(function (a) { list.appendChild(alertRow(S, d, a)); });
    body.appendChild(list);
  }

  /* ------------------------------------------------------------------ verbatims */

  function hitTerms(text) {
    var C = VOC.classify;
    if (C && typeof C.scoreSentiment === 'function') {
      try {
        var r = C.scoreSentiment(text);
        var hits = arr(r && r.hits).map(function (x) { return typeof x === 'string' ? x : (x && (x.term || x.token || x.word || x.text)) || ''; }).filter(Boolean);
        if (hits.length) return hits;
      } catch (e) { /* fall through to lexicon */ }
    }
    var L = VOC.lexicon, u = U();
    if (L && u && typeof u.tokenize === 'function') {
      var stop = arr(L.BRAND_STOPLIST);
      return u.tokenize(text).filter(function (t) {
        if (stop.indexOf(t) >= 0) return false;
        var v = typeof L.valence === 'function' ? L.valence(t) : (L.DOMAIN && L.DOMAIN[t]) != null ? L.DOMAIN[t] : (L.BASE ? L.BASE[t] : undefined);
        return isNum(v) && Math.abs(v) >= 2;
      });
    }
    return [];
  }
  /** Escapes text and wraps lexicon hits in <mark>; single-word terms only, matched case-insensitively. */
  function markedHtml(text, terms) {
    var set = {};
    arr(terms).forEach(function (t) { String(t).toLowerCase().split(/\s+/).forEach(function (w) { if (w.length >= 3) set[w.replace(/[^a-z0-9'’-]/g, '')] = true; }); });
    return String(text).split(/([A-Za-z0-9'’-]+)/).map(function (piece, i) {
      var safe = esc(piece);
      return i % 2 === 1 && set[piece.toLowerCase()] ? '<mark>' + safe + '</mark>' : safe;
    }).join('');
  }
  function verbatimCard(rec) {
    var positive = rec.sentiment_label === 'positive' || rec.category === 'praise';
    var redacted = !!rec.redacted || (rec.restricted && /^\[restricted/.test(String(rec.text || '')));
    var text = String(rec.text || '').replace(/\s+/g, ' ').trim();
    if (text.length > VERBATIM_MAX_CHARS) text = text.slice(0, VERBATIM_MAX_CHARS).replace(/\s+\S*$/, '') + '…';
    var textEl = h('p', { class: 'verbatim__text' });
    if (redacted) textEl.textContent = text; else textEl.innerHTML = markedHtml(text, hitTerms(text));
    var open = function () { drill({ view: 'inbox', id: rec.id }); };
    var card = h('article', {
      class: 'verbatim ' + (positive ? 'verbatim--positive' : 'verbatim--negative') + (redacted ? ' verbatim--redacted' : ''),
      role: 'button', tabindex: '0', 'aria-label': 'Open in Inbox: ' + (rec.subject || 'record'),
      onclick: open, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }
    }, [
      h('div', { class: 'verbatim__subject', text: rec.subject || '(no subject)' }),
      textEl,
      h('div', { class: 'verbatim__meta' }, [
        ui() && ui().pill ? ui().pill('sentiment', rec.sentiment_label) : null,
        h('span', { class: 'tag' }, label('channel', rec.channel)),
        h('span', { class: 'tag' }, label('product', rec.product)),
        h('span', { class: 'tag' }, label('category', rec.category)),
        h('span', { class: 'verbatim__date' }, fmtDate(rec.received_at, 'day')),
        redacted ? h('span', { class: 'tag' }, 'Restricted · redacted') : null,
        h('span', { class: 'verbatim__open' }, 'Open →')
      ])
    ]);
    return card;
  }
  function renderVerbatims(S, d) {
    var body = S.els.verbatimsBody;
    body.innerHTML = '';
    var recs = [];
    if (VOC.narrate && typeof VOC.narrate.verbatims === 'function') { try { recs = arr(VOC.narrate.verbatims(arr(d.records), { praise: 1, complaint: 2 })); } catch (e) { recs = []; } }
    var sub = S.els.verbatimsCard.querySelector('.card__subtitle');
    if (sub) sub.textContent = recs.length ? 'One praise, two complaints, chosen by sentiment score from n = ' + fmtInt(arr(d.records).length) : '';
    if (!recs.length) {
      emptyInto(body, { title: 'No verbatims to show', text: VOC.narrate ? 'No records with text in this range (n = ' + fmtInt(d.n || 0) + ').' : 'The narrative module (narrate.js) did not load.' });
      return;
    }
    var list = h('div', { class: 'verbatims' });
    recs.forEach(function (r) { list.appendChild(verbatimCard(r)); });
    body.appendChild(list);
    body.appendChild(h('p', { class: 'briefing-foot' }, 'Quotes are picked by sentiment score, not by typicality. Review any quote for representativeness before reusing it as a testimonial (FTC endorsement guides), and keep restricted mail redacted.'));
  }

  /* ------------------------------------------------------------------ view */

  var S = null;

  function renderAll(d) {
    if (!S) return;
    d = d || {};
    S.derived = d;
    S.ctxRecs = contextRecords(d);
    if (S.els.header && S.els.header.setMeta) S.els.header.setMeta(subtitle(d));
    else { var sub = S.root.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(d); }
    renderHeadline(S, d);
    renderInsights(S, d);
    renderKpis(S, d);
    renderCharts(S, d);
    renderAlerts(S, d);
    renderVerbatims(S, d);
  }

  VOC.views[NAME] = {
    title: TITLE,
    icon: NAME,
    /**
     * @param {HTMLElement} root
     * @param {Object|null} derived  VOC.store.derived()
     */
    mount: function (root, derived) {
      root.innerHTML = '';
      S = { root: root, els: {}, cards: [], hiddenAlerts: {}, derived: null, ctxRecs: [] };
      var header = ui() && typeof ui().viewHeader === 'function'
        ? ui().viewHeader({ title: TITLE, meta: subtitle(derived) })
        : h('header', { class: 'view-header' }, [h('h1', { class: 'view-title' }, TITLE), h('p', { class: 'view-meta', 'data-role': 'subtitle' }, subtitle(derived))]);
      S.els.header = header;
      // The headline is the Briefing's lead: 3–4 bold statements, no bullet glyphs (css/views/briefing.css .briefing-lead).
      S.els.headline = h('ul', { class: 'briefing-lead', 'aria-label': 'Headline', 'aria-live': 'polite' });
      S.els.insights = h('section', { class: 'briefing-insights', 'aria-label': 'Insights' });
      S.els.kpis = h('section', { class: 'kpi-strip briefing-kpis', 'aria-label': 'Key metrics' });
      S.els.charts = h('section', { class: 'briefing-charts', 'aria-label': 'Charts' });
      S.els.alertsCard = sectionCard('Alerts', '', { href: '#/alerts', text: 'All alerts →' });
      S.els.alertsBody = S.els.alertsCard.vocBody;
      S.els.verbatimsCard = sectionCard('In their words', '', { href: '#/inbox', text: 'Open Inbox →' });
      S.els.verbatimsBody = S.els.verbatimsCard.vocBody;
      var bottom = h('section', { class: 'briefing-bottom' }, [S.els.alertsCard, S.els.verbatimsCard]);
      [header, S.els.headline, S.els.insights, S.els.kpis, S.els.charts, bottom].forEach(function (el) { root.appendChild(el); });
      if (!derived) {
        emptyInto(S.els.insights, { title: 'Data is loading', text: 'The store has not finished initializing; the briefing fills in as soon as it is ready.' });
        return;
      }
      renderAll(derived);
    },
    /** @param {Object|null} derived */
    update: function (derived) {
      if (!S || !S.root || !S.root.isConnected) return;
      if (!derived) return;
      renderAll(derived);
    },
    unmount: function () {
      if (!S) return;
      destroyCards(S);
      if (ui() && ui().closePopover) { try { ui().closePopover(); } catch (e) { /* none open */ } }
      S = null;
    }
  };
})();
