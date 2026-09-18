/* L-Nutra · Voice of the Customer — Forecast Lab view (SPEC §5 item 8)
   Model cards, live re-fit sliders for the Holt-Winters volume model, residuals and fold coverage,
   anomaly timeline, emerging-issue table and the detector backtest against planted events.
   Everything replays at an "as of" date: only records received on or before that day feed the models.
   DOM is touched only inside mount/update/unmount so the file parses under jsc. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'predict';
  var TITLE = 'Forecast Lab';
  var Z_LEVELS = { 80: 1.28, 90: 1.645, 95: 1.96 };
  var FALLBACK_HW = { alpha: 0.3, beta: 0.05, gamma: 0.2, phi: 0.9, horizon: 28 };
  var SLIDERS = [
    { id: 'alpha', label: 'α · level', hint: 'Weight on the newest day when the level updates. Higher reacts faster, noisier.' },
    { id: 'beta', label: 'β · trend', hint: 'Weight on the newest level change when the trend updates.' },
    { id: 'gamma', label: 'γ · weekday', hint: 'Weight on the newest day when its weekday effect updates.' },
    { id: 'phi', label: 'φ · damping', hint: 'How much of the trend carries into each further day ahead (1 = undamped).' }
  ];
  var HORIZON = { min: 7, max: 56, step: 7 };
  var HISTORY_SHOWN_DAYS = 112;
  var ANOMALY_SHOWN_DAYS = 182;
  var SIGMA_WINDOW = 56;
  var EMERGING_UNITS = ['category', 'subcategory', 'product', 'kit_component', 'lot', 'bigram'];
  var UNIT_LABELS = { category: 'Category', subcategory: 'Subcategory', product: 'Product', kit_component: 'Kit component', lot: 'Lot', bigram: 'Phrase' };
  var HW_FORMULA = 'Holt-Winters additive, m = 7, damped trend.\nL_t = α(y_t − S_{t−7}) + (1−α)(L_{t−1} + φB_{t−1})\nB_t = β(L_t − L_{t−1}) + (1−β)φB_{t−1}\nS_t = γ(y_t − L_t) + (1−γ)S_{t−7}\nŷ_{t+h} = L_t + (φ+…+φ^h)B_t + S_{t+h−7}\nPI = ŷ ± z·σ·√h, σ over the last 56 residuals, floor 0.\nFallbacks: Holt linear (< 8 weeks), OLS (< 28 days), flat mean (< 7 days).';
  var ANOMALY_FORMULA = 'z_t = (x_t − μ_t·f_dow) / σ_t over a trailing window that excludes day t (28 days; 8 weeks for weekly series).\nσ_t = max(residual sd, √μ, 1.0) for counts and max(residual sd, 0.03) for shares.\nWeekday factors from up to 84 trailing days, clamped 0.3–2.5. Warning |z| ≥ 2, critical |z| ≥ 3; consecutive days merge into one event.';
  var RESIDUAL_FORMULA = 'e_t = y_t − fitted_t for the last 56 days.\nσ = √(Σe²/n) with floor 0.5; the ±2σ lines mark where a day would count as unusual for the fitted model.';

  /* ------------------------------------------------------------------ helpers */

  function U() { return VOC.util || {}; }
  function F() { return (VOC.util && VOC.util.fmt) || {}; }
  function ui() { return VOC.ui || null; }
  function store() { return VOC.store || null; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function esc(s) {
    if (ui() && ui().esc) return ui().esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function h(tag, attrs, children) {
    if (ui() && ui().h) return ui().h(tag, attrs, children);
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    });
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  function fmtNum(n, d) { return F().num ? F().num(n, d || 0) : (isNum(n) ? n.toFixed(d || 0) : '—'); }
  function fmtInt(n) { return F().int ? F().int(n) : (isNum(n) ? String(Math.round(n)) : '—'); }
  function fmtPct(p, d) { return F().pct ? F().pct(p, d || 0) : (isNum(p) ? (p * 100).toFixed(d || 0) + '%' : '—'); }
  function fmtDate(k) { return F().date ? F().date(k) : String(k || '—'); }
  function fmtUsd(n) { return F().usd ? F().usd(n) : (isNum(n) ? '$' + Math.round(n) : '—'); }
  function label(kind, id) { return VOC.enums && VOC.enums.label ? VOC.enums.label(kind, id) : String(id); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + derived.n + ' records' : '';
  }
  function dayKeyOf(iso) { return U().dayKey ? U().dayKey(iso) : String(iso).slice(0, 10); }
  function addDays(k, n) { return U().addDays ? U().addDays(k, n) : new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10); }
  function endOfDayIso(k) {
    if (U().endOfDayCT) { try { var v = U().endOfDayCT(k); if (v) return v instanceof Date ? v.toISOString() : String(v); } catch (e) { /* fall through */ } }
    return k + 'T23:59:59Z';
  }
  /** ISO week key for a 'YYYY-MM-DD' day key (calendar arithmetic, no timezone). */
  function weekKeyOfDay(k) {
    var d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)));
    var dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    var firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    var week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + '-W' + (week < 10 ? '0' : '') + week;
  }
  function weekStartOf(wk) {
    if (U().weekStart) { try { return U().weekStart(wk); } catch (e) { /* fall through */ } }
    return wk;
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function pill(kind, value) {
    if (ui() && ui().pill) return ui().pill(kind, value);
    return h('span', { class: 'pill' }, String(value));
  }
  function statusPill(status) {
    var text = String(status || 'stable');
    return h('span', { class: 'pill pill--plain lab-status lab-status--' + esc(text) }, text.charAt(0).toUpperCase() + text.slice(1));
  }
  function emptyInto(el, title, text) {
    if (ui() && ui().emptyState) ui().emptyState(el, { title: title, text: text });
    else el.innerHTML = '<div class="empty-state"><div class="empty-state__title">' + esc(title) + '</div><p class="empty-state__text">' + esc(text || '') + '</p></div>';
  }
  function setCardN(card, n) {
    if (!card) return;
    var el = card.querySelector('.chart-card__n');
    if (el) el.textContent = 'n = ' + fmtInt(n);
  }
  function drill(filters) {
    var s = store();
    if (s && typeof s.drill === 'function') s.drill({ view: 'inbox', filters: filters });
    else if (VOC.router) VOC.router.navigate('inbox');
  }
  function methodLabel(m) {
    return { holt_winters: 'Holt-Winters (m = 7, damped trend)', holt_linear: 'Holt linear trend', ols: 'Linear trend (OLS)', mean: 'Flat mean',
      ewma: 'EWMA with shrinkage', heuristic: 'Heuristic logit', fitted: 'Fitted logistic (GD)', ridge: 'Ridge regression', fallback: 'Category mean + 0.8·sentiment',
      rolling_z: 'Rolling z with weekday factors', poisson_surprise: 'Poisson surprise / two-proportion z', replay: 'Replay at window end' }[m] || String(m || '—');
  }

  /* ------------------------------------------------------------------ state */

  var S = null;

  function freshState() {
    var d = (VOC.predict && VOC.predict.defaults && VOC.predict.defaults.holtWinters) || FALLBACK_HW;
    return {
      root: null, derived: null, els: {}, cards: {}, tables: {}, handles: {},
      asOf: null, today: null, minDay: null,
      params: { alpha: d.alpha, beta: d.beta, gamma: d.gamma, phi: d.phi }, horizon: d.horizon || 28, level: 80, autoTune: false,
      scopeKey: null, records: [], daily: [], sentDaily: [], firstDay: null,
      fc: null, fitMs: null, sent: null, sentBt: null, churn: null, csat: null,
      anomalyMode: 'count', anomalyGran: 'day', anomaly: null,
      emergingNegOnly: false, emergingUnits: EMERGING_UNITS.slice(), emerging: null,
      backtest: null, backtestKey: null,
      timers: {}, offRecords: null
    };
  }
  function defaults() {
    var d = (VOC.predict && VOC.predict.defaults && VOC.predict.defaults.holtWinters) || FALLBACK_HW;
    return { alpha: d.alpha, beta: d.beta, gamma: d.gamma, phi: d.phi, horizon: d.horizon || 28 };
  }
  function loadPersisted() {
    var s = store();
    if (!s || typeof s.settings !== 'function') return;
    var st = null;
    try { st = s.settings(); } catch (e) { st = null; }
    var p = st && st.predictParams;
    if (!p || typeof p !== 'object') return;
    ['alpha', 'beta', 'gamma', 'phi'].forEach(function (k) { if (isNum(p[k])) S.params[k] = clamp(p[k], 0.01, 0.99); });
    if (isNum(p.horizon)) S.horizon = clamp(Math.round(p.horizon / HORIZON.step) * HORIZON.step, HORIZON.min, HORIZON.max);
    if (Z_LEVELS[p.level]) S.level = +p.level;
  }
  function persist() {
    clearTimeout(S.timers.persist);
    S.timers.persist = setTimeout(function () {
      var s = store();
      if (!s || typeof s.setSettings !== 'function') return;
      try { s.setSettings({ predictParams: { alpha: S.params.alpha, beta: S.params.beta, gamma: S.params.gamma, phi: S.params.phi, horizon: S.horizon, level: S.level } }); } catch (e) { /* settings unavailable */ }
    }, 400);
  }
  function storeNow() {
    var s = store();
    try { if (s && typeof s.now === 'function') return s.now(); } catch (e) { /* fall through */ }
    return new Date();
  }
  function asOfIso() { return endOfDayIso(S.asOf); }

  /* ------------------------------------------------------------------ scope + series */

  var LIST_FILTERS = ['product', 'category', 'subcategory', 'channel', 'sales_channel', 'segment', 'region', 'urgency', 'status', 'assignee'];

  function baseRecords(derived) {
    if (derived && Array.isArray(derived.allRecords)) return derived.allRecords;
    var s = store();
    try { if (s && typeof s.all === 'function') return s.all(); } catch (e) { /* fall through */ }
    return [];
  }
  function dimensionFilter(f) {
    f = f || {};
    var lists = [];
    LIST_FILTERS.forEach(function (k) { if (Array.isArray(f[k]) && f[k].length) lists.push([k, f[k]]); });
    var sentiment = Array.isArray(f.sentiment) && f.sentiment.length ? f.sentiment : null;
    var search = f.search ? String(f.search).toLowerCase() : '';
    return function (r) {
      for (var i = 0; i < lists.length; i++) if (lists[i][1].indexOf(r[lists[i][0]]) < 0) return false;
      if (sentiment && sentiment.indexOf(r.sentiment_label) < 0) return false;
      if (search) {
        var hay = ((r.subject || '') + ' ' + (r.text || '') + ' ' + (r.from_name || '') + ' ' + (r.order_id || '')).toLowerCase();
        if (hay.indexOf(search) < 0) return false;
      }
      return true;
    };
  }
  function filterSummary(f) {
    f = f || {};
    var parts = [];
    LIST_FILTERS.concat(['sentiment']).forEach(function (k) { if (Array.isArray(f[k]) && f[k].length) parts.push(k.replace(/_/g, ' ')); });
    if (f.search) parts.push('search');
    return parts;
  }
  function computeScope(derived) {
    var all = baseRecords(derived);
    var keep = dimensionFilter(derived && derived.filters);
    var asOf = S.asOf;
    var recs = [];
    var first = null;
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r || r.is_noise) continue;
      var dk = r.day_key || dayKeyOf(r.received_at);
      if (!dk || dk > asOf) continue;
      if (!keep(r)) continue;
      recs.push(r);
      if (!first || dk < first) first = dk;
    }
    var f = (derived && derived.filters) || {};
    var key = [asOf, all.length, recs.length, first, JSON.stringify(filterSummary(f)), JSON.stringify(LIST_FILTERS.concat(['sentiment']).map(function (k) { return f[k] || []; })), f.search || ''].join('|');
    return { records: recs, firstDay: first || asOf, key: key, total: all.length };
  }
  function dailyCounts(records, from, to) {
    var m = {};
    records.forEach(function (r) { var k = r.day_key || dayKeyOf(r.received_at); m[k] = (m[k] || 0) + 1; });
    var out = [];
    for (var d = from, guard = 0; d <= to && guard < 5000; d = addDays(d, 1), guard++) out.push({ key: d, value: m[d] || 0 });
    return out;
  }
  function dailySentiment(records, from, to) {
    var sum = {}, n = {};
    records.forEach(function (r) {
      if (r.sentiment_label === 'unscored' || !isNum(r.sentiment)) return;
      var k = r.day_key || dayKeyOf(r.received_at);
      var idx = isNum(r.sentiment_index) ? r.sentiment_index : (r.sentiment + 1) / 2 * 100;
      sum[k] = (sum[k] || 0) + idx; n[k] = (n[k] || 0) + 1;
    });
    var out = [];
    for (var d = from, guard = 0; d <= to && guard < 5000; d = addDays(d, 1), guard++) out.push({ key: d, value: n[d] ? sum[d] / n[d] : null, n: n[d] || 0 });
    return out;
  }
  function dailyNegShare(records, from, to) {
    var neg = {}, n = {};
    records.forEach(function (r) {
      if (r.sentiment_label === 'unscored' || !isNum(r.sentiment)) return;
      var k = r.day_key || dayKeyOf(r.received_at);
      n[k] = (n[k] || 0) + 1;
      if (r.sentiment_label === 'negative') neg[k] = (neg[k] || 0) + 1;
    });
    var out = [];
    for (var d = from, guard = 0; d <= to && guard < 5000; d = addDays(d, 1), guard++) out.push({ key: d, value: n[d] ? (neg[d] || 0) / n[d] : 0, n: n[d] || 0 });
    return out;
  }
  function weeklyFromDaily(daily, share) {
    var m = {}, order = [];
    daily.forEach(function (p) {
      var wk = weekKeyOfDay(p.key);
      if (!m[wk]) { m[wk] = { key: wk, value: 0, n: 0, num: 0 }; order.push(wk); }
      var b = m[wk];
      if (share) { b.num += (isNum(p.n) ? p.n : 0) * (isNum(p.value) ? p.value : 0); b.n += isNum(p.n) ? p.n : 0; }
      else b.value += isNum(p.value) ? p.value : 0;
    });
    return order.map(function (k) { var b = m[k]; return share ? { key: k, value: b.n ? b.num / b.n : 0, n: b.n } : { key: k, value: b.value }; });
  }

  /* ------------------------------------------------------------------ model runs */

  function P() { return VOC.predict || null; }

  function runForecast() {
    var p = P();
    if (!p || typeof p.forecastVolume !== 'function') { S.fc = null; S.fitMs = null; return; }
    var t0 = nowMs();
    try {
      S.fc = p.forecastVolume(S.daily, { horizon: S.horizon, z: [Z_LEVELS[S.level], 1.96], autoTune: S.autoTune,
        params: { alpha: S.params.alpha, beta: S.params.beta, gamma: S.params.gamma, phi: S.params.phi }, now: asOfIso() });
    } catch (e) { S.fc = null; }
    S.fitMs = nowMs() - t0;
    if (S.autoTune && S.fc && S.fc.params && S.fc.params.tuned) {
      ['alpha', 'beta', 'gamma'].forEach(function (k) { if (isNum(S.fc.params[k])) S.params[k] = S.fc.params[k]; });
    }
  }
  function runSentiment() {
    var p = P();
    S.sent = null; S.sentBt = null;
    if (!p || typeof p.forecastSentiment !== 'function') return;
    try { S.sent = p.forecastSentiment(S.sentDaily, { horizon: 14, now: asOfIso() }); } catch (e) { S.sent = null; }
    if (typeof p.backtest === 'function') {
      var scored = S.sentDaily.filter(function (d) { return isNum(d.value) && d.n > 0; });
      try {
        S.sentBt = p.backtest(function (train, horizon) {
          var r = p.forecastSentiment(train, { horizon: horizon, now: asOfIso() });
          return (r.forecast || []).map(function (f) { return { value: f.value, lo80: f.lo, hi80: f.hi }; });
        }, scored, { folds: 4, horizon: 7 });
      } catch (e) { S.sentBt = null; }
    }
  }
  function runChurn() {
    var p = P(), s = store();
    S.churn = null;
    if (!p || typeof p.churnTable !== 'function') return;
    var customers = null;
    try { customers = s && typeof s.customers === 'function' ? s.customers() : null; } catch (e) { customers = null; }
    // Score with the store's shared churn bundle so the Lab, the Customers table and the Inbox drawer agree on method.
    var model = s && typeof s.churnModel === 'function' ? s.churnModel() : null;
    try { S.churn = p.churnTable(S.records, customers || new Map(), { now: asOfIso(), top: 50, model: model || undefined }); } catch (e) { S.churn = null; }
  }
  function runCsat() {
    var p = P();
    S.csat = null;
    if (!p || typeof p.predictCsat !== 'function') return;
    try { S.csat = p.predictCsat(S.records, { now: asOfIso() }); } catch (e) { S.csat = null; }
  }
  function anomalySeries() {
    var share = S.anomalyMode === 'share';
    var daily = share ? dailyNegShare(S.records, S.firstDay, S.asOf) : S.daily;
    return S.anomalyGran === 'week' ? weeklyFromDaily(daily, share) : daily;
  }
  function runAnomalies() {
    var p = P();
    S.anomaly = null;
    if (!p || typeof p.detectAnomalies !== 'function') return;
    try { S.anomaly = p.detectAnomalies(anomalySeries(), { mode: S.anomalyMode, now: asOfIso(), metric: S.anomalyMode === 'share' ? 'negative share' : 'volume' }); } catch (e) { S.anomaly = null; }
  }
  function runEmerging() {
    var p = P();
    S.emerging = null;
    if (!p || typeof p.detectEmerging !== 'function') return;
    try { S.emerging = p.detectEmerging(S.records, { asOf: asOfIso(), negativeOnly: S.emergingNegOnly, units: S.emergingUnits.slice() }); } catch (e) { S.emerging = null; }
  }
  function plantedEvents() {
    var seed = typeof window !== 'undefined' ? window.VOC_SEED : null;
    var ev = seed && seed.meta && Array.isArray(seed.meta.planted_events) ? seed.meta.planted_events : null;
    if (!ev) { var s = store(); try { var m = s && s.meta ? s.meta() : null; ev = m && Array.isArray(m.planted_events) ? m.planted_events : []; } catch (e) { ev = []; } }
    return ev || [];
  }
  function runBacktest() {
    var p = P(), s = store();
    var events = plantedEvents();
    var key = S.asOf + '|' + (s && typeof s.version === 'function' ? s.version() : 0) + '|' + events.length;
    if (S.backtest && S.backtestKey === key) return;
    S.backtestKey = key;
    S.backtest = null;
    if (!p || typeof p.detectorBacktest !== 'function') return;
    var all = [];
    try { all = s && typeof s.allWithNoise === 'function' ? s.allWithNoise() : baseRecords(S.derived); } catch (e) { all = baseRecords(S.derived); }
    var asOf = S.asOf;
    var recs = all.filter(function (r) { var dk = r.day_key || dayKeyOf(r.received_at); return dk && dk <= asOf; });
    var replayable = events.filter(function (e) { return String(e.to || e.from || '').slice(0, 10) <= asOf; });
    var pending = events.filter(function (e) { return String(e.to || e.from || '').slice(0, 10) > asOf; });
    var res = null;
    try { res = p.detectorBacktest(recs, replayable, { now: asOfIso() }); } catch (e) { res = null; }
    S.backtest = { result: res, pending: pending, n: recs.length, replayable: replayable.length };
  }

  function recomputeScope(derived, force) {
    var scope = computeScope(derived);
    if (!force && scope.key === S.scopeKey) return false;
    S.scopeKey = scope.key;
    S.records = scope.records;
    S.firstDay = scope.firstDay;
    S.total = scope.total;
    S.daily = dailyCounts(S.records, S.firstDay, S.asOf);
    S.sentDaily = dailySentiment(S.records, S.firstDay, S.asOf);
    runForecast(); runSentiment(); runChurn(); runCsat(); runAnomalies(); runEmerging(); runBacktest();
    return true;
  }

  /* ------------------------------------------------------------------ rendering: header + scope */

  /** One-line header meta: range · n, plus the as-of date the models read up to. */
  function metaText(derived) {
    var base = subtitle(derived);
    if (!S) return base;
    return base + ' · models as of ' + fmtDate(S.asOf) + ' · range preset does not apply';
  }
  /** One bold sentence for the header: the forecast's first clause ("Expect about 3 messages a day next week, likely 0–4") with n. */
  function leadText() {
    var fc = S.fc;
    var days = S.daily ? S.daily.length : 0;
    if (!fc || !Array.isArray(fc.forecast) || !fc.forecast.length) return 'Too few days of history to project volume (n=' + fmtInt(days) + ' days as of ' + fmtDate(S.asOf) + ').';
    var sentence = '';
    if (VOC.narrate && typeof VOC.narrate.forecastSentence === 'function') { try { sentence = VOC.narrate.forecastSentence(fc) || ''; } catch (e) { sentence = ''; } }
    var m = /^Expect about [^;(]+/.exec(sentence);
    var clause = m ? m[0].trim() : 'Volume forecast fitted';
    var replay = S.asOf !== S.today ? ', replaying as of ' + fmtDate(S.asOf) : '';
    return clause + replay + ' (n=' + fmtInt(isNum(fc.n) ? fc.n : days) + ' days).';
  }
  function setHeader() {
    var hd = S && S.els.header;
    if (!hd) return;
    if (hd.setMeta) hd.setMeta(metaText(S.derived));
    if (hd.setLead) hd.setLead(leadText());
  }

  function renderScopeNotice() {
    var el = S.els.scope;
    if (!el) return;
    var parts = filterSummary(S.derived && S.derived.filters);
    var replay = S.asOf !== S.today;
    var text = (replay ? 'Replaying as of ' + fmtDate(S.asOf) + ': ' : 'As of ' + fmtDate(S.asOf) + ': ') +
      fmtInt(S.records.length) + ' of ' + fmtInt(S.total || 0) + ' records received on or before this day feed every model' +
      (parts.length ? ' (' + parts.join(', ') + ' filters applied; the range preset does not apply here).' : '; the range preset does not apply here, only dimension filters do.');
    el.textContent = text;
    el.className = 'notice lab-scope' + (replay ? ' notice--warning' : '');
  }

  /* ------------------------------------------------------------------ rendering: model cards */

  function kvList(pairs) {
    var dl = h('dl', { class: 'kv model-card__kv' });
    pairs.forEach(function (p) {
      if (p[1] == null || p[1] === '') return;
      dl.appendChild(h('dt', { text: p[0] }));
      dl.appendChild(h('dd', typeof p[1] === 'string' || typeof p[1] === 'number' ? { text: String(p[1]) } : {}, typeof p[1] === 'object' ? p[1] : null));
    });
    return dl;
  }
  function modelCard(opts) {
    var card = h('article', { class: 'card model-card', dataset: { model: opts.id } });
    var head = h('header', { class: 'model-card__head' }, [h('h3', { class: 'card__title', text: opts.title })]);
    if (opts.confidence) head.appendChild(pill('confidence', opts.confidence));
    card.appendChild(head);
    if (opts.method) card.appendChild(h('div', { class: 'model-card__method', text: opts.method }));
    if (opts.pairs) card.appendChild(kvList(opts.pairs));
    if (opts.text) card.appendChild(h('p', { class: 'model-card__text', text: opts.text }));
    if (opts.caveats && opts.caveats.length) {
      card.appendChild(h('ul', { class: 'model-card__caveats' }, opts.caveats.slice(0, 2).map(function (c) { return h('li', { text: c }); })));
    }
    if (opts.empty) { var box = h('div', { class: 'model-card__empty' }); emptyInto(box, opts.empty.title, opts.empty.text); card.appendChild(box); }
    return card;
  }
  function btPairs(bt, levelText) {
    if (!bt || !bt.folds || !bt.folds.length) return [['Backtest', 'not enough history for 4 folds × 7 days']];
    return [
      ['MAE', fmtNum(bt.mae, 2)], ['MAPE', fmtPct(bt.mape, 1)], ['MASE', isNum(bt.mase) ? fmtNum(bt.mase, 2) : '—'],
      ['Coverage ' + (levelText || '80%'), fmtPct(bt.coverage80, 0) + ' of ' + bt.folds.length + ' folds × 7 days']
    ];
  }
  function renderCards() {
    var wrap = S.els.cards;
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!P()) {
      emptyInto(wrap, 'Prediction module not loaded', 'js/predict.js did not load, so no model can run. Reload the page or check the script tags.');
      return;
    }
    var fc = S.fc, sent = S.sent, churn = S.churn, csat = S.csat;
    var levelText = S.level + '%';
    wrap.appendChild(modelCard({
      id: 'volume', title: 'Volume · Holt-Winters', confidence: fc ? fc.confidence : 'low',
      method: fc ? methodLabel(fc.method) + ' · α ' + fmtNum(fc.params.alpha, 2) + ' β ' + fmtNum(fc.params.beta, 2) + ' γ ' + fmtNum(fc.params.gamma, 2) + ' φ ' + fmtNum(fc.params.phi, 2) + (fc.params.tuned ? ' · tuned' : '') : '',
      pairs: fc ? [['n', fmtInt(fc.n) + ' days'], ['Horizon', S.horizon + ' days'], ['σ (56 d)', fmtNum(fc.params.sigma, 2)], ['Fit time', isNum(S.fitMs) ? fmtNum(S.fitMs, 1) + ' ms' : '—']].concat(btPairs(fc.backtest, levelText)) : null,
      text: fc ? fc.explanation : null, caveats: fc ? fc.caveats : null,
      empty: fc ? null : { title: 'No daily history', text: 'No records fall on or before the as-of date for these filters.' }
    }));
    var sentN = sent ? sent.n : 0;
    var sentLast = sent && sent.forecast && sent.forecast.length ? sent.forecast[sent.forecast.length - 1] : null;
    wrap.appendChild(modelCard({
      id: 'sentiment', title: 'Sentiment · EWMA', confidence: sent ? sent.confidence : 'low',
      method: sent ? methodLabel(sent.method) + ' · λ ' + fmtNum(sent.params.lambda, 2) + ' · z ' + fmtNum(sent.params.z, 2) + ' · shrink k ' + sent.params.shrinkK : '',
      pairs: sent ? [['n', fmtInt(sentN) + ' scored records'], ['Horizon', sent.params.horizon + ' days'],
        ['14-day level', sentLast ? fmtNum(sentLast.value, 0) + ' pts, likely ' + fmtNum(sentLast.lo, 0) + '–' + fmtNum(sentLast.hi, 0) : '—']].concat(btPairs(S.sentBt, '80%')) : null,
      text: sent ? sent.explanation : null, caveats: sent ? sent.caveats : null,
      empty: sent ? null : { title: 'No scored sentiment', text: 'Sentiment needs English-language records scored by the lexicon.' }
    }));
    var high = churn && churn.rows ? churn.rows.filter(function (r) { return r.tier === 'high' || r.tier === 'critical'; }).length : 0;
    wrap.appendChild(modelCard({
      id: 'churn', title: 'Cancellation risk · ' + (churn && churn.method === 'fitted' ? 'fitted logistic' : 'heuristic'), confidence: churn ? churn.confidence : 'low',
      method: churn ? methodLabel(churn.method) + ' · intercept ' + fmtNum(churn.params.intercept, 1) + ' · ' + (churn.params.features || []).length + ' features' +
        (churn.params.logistic ? ' · lr ' + churn.params.logistic.lr + ', ' + churn.params.logistic.epochs + ' epochs, L2 ' + churn.params.logistic.l2 : '') : '',
      pairs: churn ? [['n', fmtInt(churn.totalRows != null ? churn.totalRows : churn.n) + ' customers with contact history'],
        ['Labelled', churn.params.logistic ? fmtInt(churn.params.logistic.nLabelled) + ' (' + fmtInt(churn.params.logistic.nPositive) + ' cancelled)' : 'fewer than 40, so weights are heuristic'],
        ['AUC', isNum(churn.auc) ? fmtNum(churn.auc, 2) + ' cross-validated' + (isNum(churn.aucInSample) ? ' (in-sample ' + fmtNum(churn.aucInSample, 2) + ')' : '')
          : (churn.rejectedFit && isNum(churn.rejectedFit.auc) ? 'fit rejected: cross-validated AUC ' + fmtNum(churn.rejectedFit.auc, 2) + ' is below the 0.65 gate, so the heuristic scores everyone' : 'not fitted')],
        ['High or critical', fmtInt(high) + ' of top ' + fmtInt(churn.rows ? churn.rows.length : 0)],
        ['Revenue at risk', fmtUsd(churn.revenueAtRisk) + ' of 12-month subscription value'],
        ['Tiers', '0–24 low · 25–49 watch · 50–74 high · 75+ critical']] : null,
      text: churn ? churn.explanation : null, caveats: churn ? churn.caveats : null,
      empty: churn ? null : { title: 'No customers to score', text: 'Cancellation risk needs records with a customer id.' }
    }));
    var model = csat && csat.model;
    wrap.appendChild(modelCard({
      id: 'csat', title: 'Predicted CSAT · ' + (csat && csat.method === 'ridge' ? 'ridge' : 'fallback'), confidence: csat ? csat.confidence : 'low',
      method: csat ? methodLabel(csat.method) + (csat.method === 'ridge' ? ' · λ ' + csat.params.lambda + ' · ' + (csat.params.features || []).length + ' features · PI ±' + fmtNum(csat.params.z, 2) + 'σ' : ' · σ ' + fmtNum(csat.params.sigma, 2)) : '',
      pairs: csat ? [['n', fmtInt(csat.n) + ' resolved records with CSAT'], ['Open scored', fmtInt(csat.nOpen)],
        ['r² (in-sample)', model ? fmtPct(model.r2, 0) : '—'], ['σ residual', model ? fmtNum(model.sigma, 2) + ' points of 5' : fmtNum(csat.params.sigma, 2)],
        ['Mean prediction', csat.predictions && csat.predictions.length ? fmtNum(csat.predictions.reduce(function (a, p) { return a + p.pred; }, 0) / csat.predictions.length, 2) + ' of 5' : '—']] : null,
      text: csat ? csat.explanation : null, caveats: csat ? csat.caveats : null,
      empty: csat ? null : { title: 'No CSAT data', text: 'Predicted CSAT needs resolved records that carry a 1–5 score.' }
    }));
  }

  /* ------------------------------------------------------------------ rendering: controls */

  function sliderRow(def, value, min, max, step, format) {
    var id = 'lab-' + def.id;
    var out = h('output', { for: id, text: format(value) });
    var input = h('input', { type: 'range', id: id, min: String(min), max: String(max), step: String(step), value: String(value), 'aria-describedby': id + '-hint' });
    var row = h('div', { class: 'field lab-slider' }, [
      h('div', { class: 'row row--between' }, [h('label', { for: id, class: 'label', text: def.label }), out]),
      input,
      h('p', { class: 'field__hint', id: id + '-hint', text: def.hint })
    ]);
    return { el: row, input: input, out: out };
  }
  function renderControls() {
    var wrap = S.els.controls;
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.appendChild(h('h3', { class: 'card__title', text: 'Volume model parameters' }));
    wrap.appendChild(h('p', { class: 'card__subtitle', text: 'Sliders re-fit the Holt-Winters model live (150 ms debounce) and persist in settings.' }));
    S.els.sliders = {};
    SLIDERS.forEach(function (def) {
      var s = sliderRow(def, S.params[def.id], 0.01, 0.99, 0.01, function (v) { return fmtNum(v, 2); });
      s.input.addEventListener('input', function () {
        var v = clamp(parseFloat(s.input.value), 0.01, 0.99);
        S.params[def.id] = v; s.out.textContent = fmtNum(v, 2);
        if (S.autoTune) { S.autoTune = false; syncAutoTuneBtn(); }
        scheduleRefit();
      });
      S.els.sliders[def.id] = s;
      wrap.appendChild(s.el);
    });
    var hz = sliderRow({ id: 'horizon', label: 'Horizon', hint: 'Days ahead to project, in whole weeks.' }, S.horizon, HORIZON.min, HORIZON.max, HORIZON.step, function (v) { return v + ' days'; });
    hz.input.addEventListener('input', function () {
      S.horizon = clamp(parseInt(hz.input.value, 10) || 28, HORIZON.min, HORIZON.max); hz.out.textContent = S.horizon + ' days'; scheduleRefit();
    });
    S.els.sliders.horizon = hz;
    wrap.appendChild(hz.el);

    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Prediction band level' });
    S.els.levelBtns = {};
    [80, 90, 95].forEach(function (lv) {
      var b = h('button', { type: 'button', 'aria-pressed': String(S.level === lv), onclick: function () { S.level = lv; syncLevelBtns(); scheduleRefit(); } }, lv + '%');
      S.els.levelBtns[lv] = b;
      seg.appendChild(b);
    });
    wrap.appendChild(h('div', { class: 'field' }, [h('div', { class: 'row row--between' }, [h('span', { class: 'label', text: 'Inner band' }), seg]),
      h('p', { class: 'field__hint', text: 'z = 1.28 / 1.645 / 1.96. The outer band stays at 95%; coverage is scored on the inner band.' })]));

    var autoBtn = h('button', { type: 'button', class: 'btn btn--sm', 'aria-pressed': String(S.autoTune), title: 'Grid-search α, β, γ on in-sample squared error (Holt-Winters only)',
      onclick: function () { S.autoTune = !S.autoTune; syncAutoTuneBtn(); refit(); } }, 'Auto-tune');
    var resetBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: function () {
      var d = defaults();
      S.params = { alpha: d.alpha, beta: d.beta, gamma: d.gamma, phi: d.phi }; S.horizon = d.horizon; S.level = 80; S.autoTune = false;
      syncSliders(); syncLevelBtns(); syncAutoTuneBtn(); refit();
      if (ui() && ui().toast) ui().toast('Parameters reset to defaults.', 'info', { ms: 3000 });
    } }, 'Reset to defaults');
    S.els.autoBtn = autoBtn;
    wrap.appendChild(h('div', { class: 'row lab-controls__actions' }, [autoBtn, resetBtn]));
    S.els.fit = h('p', { class: 'lab-fit muted t-12', text: '' });
    wrap.appendChild(S.els.fit);
    syncFitLine();
  }
  function syncSliders() {
    if (!S.els.sliders) return;
    SLIDERS.forEach(function (def) { var s = S.els.sliders[def.id]; if (s) { s.input.value = String(S.params[def.id]); s.out.textContent = fmtNum(S.params[def.id], 2); } });
    var hz = S.els.sliders.horizon; if (hz) { hz.input.value = String(S.horizon); hz.out.textContent = S.horizon + ' days'; }
  }
  function syncLevelBtns() { if (S.els.levelBtns) Object.keys(S.els.levelBtns).forEach(function (lv) { S.els.levelBtns[lv].setAttribute('aria-pressed', String(+lv === S.level)); }); }
  function syncAutoTuneBtn() { if (S.els.autoBtn) S.els.autoBtn.setAttribute('aria-pressed', String(S.autoTune)); }
  function syncFitLine() {
    if (!S.els.fit) return;
    var fc = S.fc;
    S.els.fit.textContent = fc ? 'Fit ' + (isNum(S.fitMs) ? fmtNum(S.fitMs, 1) + ' ms' : '—') + ' · ' + methodLabel(fc.method) + ' · n = ' + fmtInt(fc.n) + ' days' +
      (fc.method !== 'holt_winters' ? ' · sliders β/γ apply once 8 weeks of history exist' : '') : 'No fit yet.';
  }
  function scheduleRefit() {
    clearTimeout(S.timers.refit);
    S.timers.refit = setTimeout(refit, 150);
  }
  function refit() {
    runForecast();
    if (S.autoTune) syncSliders();
    persist();
    setHeader();
    syncFitLine();
    renderCards();
    refreshForecastCards();
  }

  /* ------------------------------------------------------------------ rendering: forecast charts */

  function forecastSpec() {
    var fc = S.fc;
    if (!fc || !fc.history || !fc.history.length) return null;
    var hist = fc.history.slice(-HISTORY_SHOWN_DAYS);
    var fcast = fc.forecast || [];
    var labels = hist.map(function (p) { return p.key; }).concat(fcast.map(function (p) { return p.key; }));
    var nH = hist.length, nF = fcast.length;
    var nulls = function (n) { var a = []; for (var i = 0; i < n; i++) a.push(null); return a; };
    var histVals = hist.map(function (p) { return p.value; }).concat(nulls(nF));
    var fitted = hist.map(function (p) { return isNum(p.fitted) ? Math.max(0, p.fitted) : null; }).concat(nulls(nF));
    var lastVal = hist[nH - 1].value;
    var fcVals = nulls(nH - 1).concat([lastVal], fcast.map(function (p) { return p.value; }));
    var lo80 = nulls(nH - 1).concat([lastVal], fcast.map(function (p) { return p.lo80; }));
    var hi80 = nulls(nH - 1).concat([lastVal], fcast.map(function (p) { return p.hi80; }));
    var lo95 = nulls(nH - 1).concat([lastVal], fcast.map(function (p) { return p.lo95; }));
    var hi95 = nulls(nH - 1).concat([lastVal], fcast.map(function (p) { return p.hi95; }));
    var annotations = [{ x: hist[nH - 1].key, label: 'as of' }];
    ((fc.backtest && fc.backtest.folds) || []).forEach(function (f, i) { if (labels.indexOf(f.trainEnd) >= 0) annotations.push({ x: f.trainEnd, label: 'fold ' + (i + 1) }); });
    return {
      labels: labels,
      datasets: [
        { label: 'Actual', data: histVals, slot: 1, pointRadius: 0 },
        { label: 'Fitted', data: fitted, slot: 'other', dash: 'dotted', borderWidth: 1.5, pointRadius: 0 },
        { label: 'Forecast (' + S.level + '% band)', data: fcVals, slot: 3, dashed: true, pointRadius: 0, band: { lo: lo80, hi: hi80 } },
        { label: '95% band', data: fcVals, slot: 3, dash: [2, 4], borderWidth: 1, pointRadius: 0, band: { lo: lo95, hi: hi95 } }
      ],
      yLabel: 'Contacts per day', annotations: annotations,
      ariaLabel: 'Daily contact volume: actual for the last ' + nH + ' days, fitted values, and a ' + nF + '-day forecast with ' + S.level + '% and 95% bands'
    };
  }
  function forecastTable() {
    var fc = S.fc;
    if (!fc) return { columns: [], rows: [] };
    var cols = [{ key: 'key', label: 'Day' }, { key: 'kind', label: 'Kind' }, { key: 'value', label: 'Value' }, { key: 'fitted', label: 'Fitted' },
      { key: 'lo80', label: 'Low ' + S.level + '%' }, { key: 'hi80', label: 'High ' + S.level + '%' }, { key: 'lo95', label: 'Low 95%' }, { key: 'hi95', label: 'High 95%' }];
    var rows = (fc.history || []).slice(-HISTORY_SHOWN_DAYS).map(function (p) { return { key: p.key, kind: 'actual', value: p.value, fitted: p.fitted, lo80: null, hi80: null, lo95: null, hi95: null }; })
      .concat((fc.forecast || []).map(function (p) { return { key: p.key, kind: 'forecast', value: p.value, fitted: null, lo80: p.lo80, hi80: p.hi80, lo95: p.lo95, hi95: p.hi95 }; }));
    return { columns: cols, rows: rows };
  }
  function residuals() {
    var fc = S.fc;
    if (!fc || !fc.history) return [];
    var start = fc.method === 'holt_winters' ? 14 : 0;
    return fc.history.slice(start).slice(-SIGMA_WINDOW).map(function (p) { return { key: p.key, value: isNum(p.fitted) ? p.value - p.fitted : null }; }).filter(function (p) { return isNum(p.value); });
  }
  function residualSpec() {
    var res = residuals();
    if (!res.length) return null;
    var sigma = S.fc && S.fc.params && isNum(S.fc.params.sigma) ? S.fc.params.sigma : null;
    var ann = sigma ? [{ y: 2 * sigma, label: '+2σ = ' + fmtNum(2 * sigma, 1) }, { y: -2 * sigma, label: '−2σ' }] : [];
    return { labels: res.map(function (p) { return p.key; }), datasets: [{ label: 'Actual − fitted', data: res.map(function (p) { return Math.round(p.value * 100) / 100; }), slot: 1 }],
      vertical: true, yLabel: 'Contacts', annotations: ann, ariaLabel: 'Daily residuals of the volume model for the last ' + res.length + ' days with ±2σ reference lines' };
  }
  function residualTable() {
    var res = residuals();
    return { columns: [{ key: 'key', label: 'Day' }, { key: 'value', label: 'Actual − fitted' }], rows: res.map(function (p) { return { key: p.key, value: Math.round(p.value * 100) / 100 }; }) };
  }
  function coverageRows() {
    var bt = S.fc && S.fc.backtest;
    if (!bt || !bt.folds) return [];
    return bt.folds.map(function (f, i) {
      return { id: 'fold' + (i + 1), fold: 'Fold ' + (i + 1), trainEnd: f.trainEnd, testFrom: addDays(f.trainEnd, 1), testTo: addDays(f.trainEnd, f.n || 7), n: f.n, mae: f.mae, mape: f.mape, coverage: f.coverage80 };
    });
  }
  function destroyCardKeys(keys) {
    keys.forEach(function (k) { var c = S.cards[k]; if (c && typeof c.vocDestroy === 'function') { try { c.vocDestroy(); } catch (e) { /* gone */ } } S.cards[k] = null; });
  }
  function renderForecastCards() {
    var wrap = S.els.charts;
    if (!wrap) return;
    destroyCardKeys(['forecast', 'residual']);   // the previous Chart.js instances go before the DOM does, or they leak into VOC.charts' registry
    wrap.innerHTML = '';
    if (!ui() || !ui().chartCard) { emptyInto(wrap, 'UI kit not loaded', 'js/components.js is missing, so charts cannot render.'); return; }
    var fc = S.fc;
    S.cards.forecast = ui().chartCard({
      id: 'lab-forecast', title: 'Daily volume: history, fit and forecast',
      question: 'How many contacts arrive over the next ' + S.horizon + ' days, and how wide is the honest range?',
      formula: HW_FORMULA, n: fc ? fc.n : 0, height: 340, csvName: 'lnutra-voc-forecast-daily.csv',
      render: function (canvas) {
        var spec = forecastSpec();
        if (!spec || !VOC.charts || !VOC.charts.line) return null;
        return VOC.charts.line(canvas, spec);
      },
      table: forecastTable,
      footnote: 'Solid: actual (last ' + HISTORY_SHOWN_DAYS + ' days shown; the model fits on all history). Dotted: fitted. Dashed: forecast with inner and 95% bands. Vertical markers: rolling-origin backtest fold ends and the as-of day.'
    });
    wrap.appendChild(S.cards.forecast);

    var lower = h('div', { class: 'lab-forecast-lower' });
    S.cards.residual = ui().chartCard({
      id: 'lab-residuals', title: 'Residuals, last ' + SIGMA_WINDOW + ' days', question: 'Where did the fitted model miss, and by how much?',
      formula: RESIDUAL_FORMULA, n: residuals().length, height: 260, csvName: 'lnutra-voc-forecast-residuals.csv',
      render: function (canvas) {
        var spec = residualSpec();
        if (!spec || !VOC.charts || !VOC.charts.diverging) return null;
        return VOC.charts.diverging(canvas, spec);
      },
      table: residualTable,
      footnote: 'Bars above zero are days with more contacts than the model fitted. The ±2σ lines use the same σ as the forecast bands.'
    });
    lower.appendChild(S.cards.residual);

    var covCard = h('section', { class: 'card lab-coverage' });
    covCard.appendChild(h('header', { class: 'card__header' }, [h('div', {}, [h('h3', { class: 'card__title', text: 'Backtest coverage per fold' }),
      h('p', { class: 'card__subtitle', text: 'Rolling origin, 4 folds × 7 days: fit on everything before the fold, score the next week.' })])]));
    var covBody = h('div', { class: 'lab-coverage__body' });
    covCard.appendChild(covBody);
    S.els.coverageBody = covBody;
    lower.appendChild(covCard);
    wrap.appendChild(lower);
    renderCoverageTable();
  }
  function renderCoverageTable() {
    var body = S.els.coverageBody;
    if (!body) return;
    var rows = coverageRows();
    var bt = S.fc && S.fc.backtest;
    if (!rows.length) { S.tables.coverage = null; emptyInto(body, 'Not enough history for a backtest', 'Four folds of 7 days need at least 35 days of daily counts before the as-of date.'); return; }
    var cols = [
      { key: 'fold', label: 'Fold' },
      { key: 'testFrom', label: 'Test week', render: function (r) { return esc(fmtDate(r.testFrom)) + ' – ' + esc(fmtDate(r.testTo)); } },
      { key: 'n', label: 'n days', align: 'right' },
      { key: 'mae', label: 'MAE', align: 'right', render: function (r) { return esc(fmtNum(r.mae, 2)); } },
      { key: 'mape', label: 'MAPE', align: 'right', render: function (r) { return esc(fmtPct(r.mape, 0)); } },
      { key: 'coverage', label: 'Coverage ' + S.level + '%', align: 'right', render: function (r) { return esc(fmtPct(r.coverage, 0)); } }
    ];
    if (bt) rows.push({ id: 'all', fold: 'All folds', testFrom: null, testTo: null, n: rows.reduce(function (a, r) { return a + (r.n || 0); }, 0), mae: bt.mae, mape: bt.mape, coverage: bt.coverage80, isTotal: true });
    cols[1].render = function (r) { return r.isTotal ? ('MASE ' + esc(isNum(bt.mase) ? fmtNum(bt.mase, 2) : '—') + ' vs seasonal naive') : esc(fmtDate(r.testFrom)) + ' – ' + esc(fmtDate(r.testTo)); };
    body.innerHTML = '';
    S.tables.coverage = ui().table({ columns: cols, rows: rows, pageSize: 10, footer: false, flat: true, rowClass: function (r) { return r.isTotal ? 'is-total' : ''; }, emptyText: 'No folds.' });
    body.appendChild(S.tables.coverage.el);
    body.appendChild(h('p', { class: 'card__footer', text: 'A well-calibrated ' + S.level + '% band covers about ' + S.level + '% of test days; far above means the band is too wide, far below too narrow.' }));
  }
  function refreshForecastCards() {
    if (S.cards.forecast) {
      var q = S.cards.forecast.querySelector('.chart-card__question');
      if (q) q.innerHTML = esc('How many contacts arrive over the next ' + S.horizon + ' days, and how wide is the honest range?') + ' · <span class="chart-card__n">n = ' + esc(fmtInt(S.fc ? S.fc.n : 0)) + '</span>';
      if (S.cards.forecast.vocRefresh) S.cards.forecast.vocRefresh();
    }
    if (S.cards.residual) { setCardN(S.cards.residual, residuals().length); if (S.cards.residual.vocRefresh) S.cards.residual.vocRefresh(); }
    renderCoverageTable();
  }

  /* ------------------------------------------------------------------ rendering: anomalies */

  function anomalySpec() {
    var res = S.anomaly;
    if (!res || !res.points || !res.points.length) return null;
    var share = S.anomalyMode === 'share';
    var scale = share ? 100 : 1;
    var pts = S.anomalyGran === 'day' ? res.points.slice(-ANOMALY_SHOWN_DAYS) : res.points;
    var labels = pts.map(function (p) { return p.key; });
    var sc = function (v) { return isNum(v) ? Math.round(v * scale * 100) / 100 : null; };
    return {
      labels: labels,
      datasets: [
        { label: share ? 'Negative share' : 'Contacts', data: pts.map(function (p) { return sc(p.value); }), slot: 1, pointRadius: S.anomalyGran === 'day' ? 0 : 2 },
        { label: 'Expected (±2σ band)', data: pts.map(function (p) { return sc(p.expected); }), slot: 'other', dashed: true, pointRadius: 0, band: { lo: pts.map(function (p) { return sc(p.lo); }), hi: pts.map(function (p) { return sc(p.hi); }) } }
      ],
      percent: share, yLabel: share ? 'Negative share of scored records (%)' : (S.anomalyGran === 'day' ? 'Contacts per day' : 'Contacts per week'),
      ariaLabel: (share ? 'Negative sentiment share' : 'Contact volume') + ' per ' + (S.anomalyGran === 'day' ? 'day' : 'week') + ' with the expected baseline and its 2 sigma band; anomalous points are enlarged',
      _points: pts
    };
  }
  function anomalyTable() {
    var res = S.anomaly;
    if (!res) return { columns: [], rows: [] };
    var share = S.anomalyMode === 'share';
    var cols = [{ key: 'key', label: S.anomalyGran === 'day' ? 'Day' : 'Week' }, { key: 'value', label: share ? 'Negative share' : 'Contacts' }, { key: 'expected', label: 'Expected' }, { key: 'lo', label: 'Low' }, { key: 'hi', label: 'High' }, { key: 'z', label: 'z' }];
    return { columns: cols, rows: res.points.map(function (p) { return { key: p.key, value: p.value, expected: p.expected, lo: p.lo, hi: p.hi, z: p.z }; }) };
  }
  function renderAnomalySection() {
    var sec = S.els.anomalies;
    if (!sec) return;
    destroyCardKeys(['anomaly']);
    sec.innerHTML = '';
    var modeSeg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Anomaly metric' });
    [['count', 'Count'], ['share', 'Negative share']].forEach(function (o) {
      modeSeg.appendChild(h('button', { type: 'button', 'aria-pressed': String(S.anomalyMode === o[0]), onclick: function () { S.anomalyMode = o[0]; runAnomalies(); renderAnomalySection(); } }, o[1]));
    });
    var granSeg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Anomaly granularity' });
    [['day', 'Daily'], ['week', 'Weekly']].forEach(function (o) {
      granSeg.appendChild(h('button', { type: 'button', 'aria-pressed': String(S.anomalyGran === o[0]), onclick: function () { S.anomalyGran = o[0]; runAnomalies(); renderAnomalySection(); } }, o[1]));
    });
    var res = S.anomaly;
    sec.appendChild(h('div', { class: 'lab-section-head' }, [
      h('div', {}, [h('h2', { class: 'section-title', text: 'Anomaly timeline' }), h('p', { class: 'muted t-13', text: res ? res.explanation : 'Anomaly detector unavailable.' })]),
      h('div', { class: 'row' }, [modeSeg, granSeg, res ? pill('confidence', res.confidence) : null])
    ]));
    if (!ui() || !ui().chartCard || !res) { var e = h('div', { class: 'card' }); emptyInto(e, 'No series to score', 'The anomaly detector needs daily records on or before the as-of date.'); sec.appendChild(e); return; }
    var grid = h('div', { class: 'lab-anomaly-grid' });
    var share = S.anomalyMode === 'share';
    S.cards.anomaly = ui().chartCard({
      id: 'lab-anomalies', title: (share ? 'Negative share' : 'Volume') + ' vs expected, ' + (S.anomalyGran === 'day' ? 'daily' : 'weekly'),
      question: 'Which ' + (S.anomalyGran === 'day' ? 'days' : 'weeks') + ' depart from their own weekday-adjusted baseline?',
      formula: ANOMALY_FORMULA, n: res.points.filter(function (p) { return isNum(p.z); }).length, height: 300, csvName: 'lnutra-voc-anomalies-' + S.anomalyMode + '-' + S.anomalyGran + '.csv',
      render: function (canvas) {
        var spec = anomalySpec();
        if (!spec || !VOC.charts || !VOC.charts.line) return null;
        var pts = spec._points; delete spec._points;
        // Enlarged, status-colored points for anomalous periods go through the spec (pointRadius / pointColors arrays);
        // a null color falls back to the series color inside VOC.charts.
        var warnColor = VOC.charts.statusColor ? VOC.charts.statusColor('warning') : '#FAB219';
        var critColor = VOC.charts.statusColor ? VOC.charts.statusColor('critical') : '#D03B3B';
        var warn = res.params && isNum(res.params.warn) ? res.params.warn : 2, crit = res.params && isNum(res.params.critical) ? res.params.critical : 3;
        var baseR = S.anomalyGran === 'day' ? 0 : 2;
        spec.datasets[0].pointRadius = pts.map(function (p) { return isNum(p.z) && Math.abs(p.z) >= crit ? 7 : isNum(p.z) && Math.abs(p.z) >= warn ? 5 : baseR; });
        spec.datasets[0].pointColors = pts.map(function (p) { return isNum(p.z) && Math.abs(p.z) >= crit ? critColor : isNum(p.z) && Math.abs(p.z) >= warn ? warnColor : null; });
        return VOC.charts.line(canvas, spec);
      },
      table: anomalyTable,
      footnote: 'Enlarged points: |z| ≥ 2 warning (amber), |z| ≥ 3 critical (red). ' + (S.anomalyGran === 'day' ? 'Last ' + ANOMALY_SHOWN_DAYS + ' days shown; the baseline uses all history.' : 'All weeks shown.') + (share ? ' Shares on low-volume periods shrink toward the baseline before scoring.' : '')
    });
    grid.appendChild(S.cards.anomaly);

    var evCard = h('section', { class: 'card lab-events' });
    evCard.appendChild(h('header', { class: 'card__header' }, [h('div', {}, [h('h3', { class: 'card__title', text: 'Anomalous periods' }),
      h('p', { class: 'card__subtitle', text: fmtInt(res.events.length) + ' events across n = ' + fmtInt(res.points.filter(function (p) { return isNum(p.z); }).length) + ' scored ' + (S.anomalyGran === 'day' ? 'days' : 'weeks') + ' · click a row to open those records' })])]));
    var evBody = h('div', {});
    if (!res.events.length) emptyInto(evBody, 'No anomalies', 'No ' + (S.anomalyGran === 'day' ? 'day' : 'week') + ' departs from its baseline by 2σ or more for this metric.');
    else {
      var rows = res.events.map(function (e, i) { return Object.assign({ id: 'ev' + i }, e); });
      var fmtV = function (v) { return share ? fmtPct(v, 1) : fmtNum(v, share ? 2 : 0); };
      var t = ui().table({
        columns: [
          { key: 'start', label: 'Period', render: function (r) { return esc(fmtDate(r.start)) + (r.end !== r.start ? ' – ' + esc(fmtDate(r.end)) : '') + (r.days > 1 ? ' <span class="muted">(' + r.days + ')</span>' : ''); } },
          { key: 'direction', label: 'Dir.', render: function (r) { return r.direction === 'up' ? '▲ up' : '▼ down'; } },
          { key: 'value', label: share ? 'Peak share' : 'Peak', align: 'right', render: function (r) { return esc(fmtV(r.value)); } },
          { key: 'expected', label: 'Expected', align: 'right', render: function (r) { return esc(fmtV(r.expected)); } },
          { key: 'z', label: 'z', align: 'right', render: function (r) { return esc(fmtNum(r.z, 1)); } },
          { key: 'severity', label: 'Severity', render: function (r) { return pill('severity', r.severity); } }
        ],
        rows: rows, pageSize: 8, sortKey: 'start', sortDir: 'desc', flat: true,
        onRowClick: function (r) {
          var from = r.start, to = r.end;
          if (S.anomalyGran === 'week') { from = weekStartOf(r.start); to = addDays(weekStartOf(r.end), 6); }
          if (to > S.asOf) to = S.asOf;
          var filters = { range: { preset: 'custom', from: from, to: to } };
          if (share) filters.sentiment = ['negative'];
          drill(filters);
        }
      });
      evBody.appendChild(t.el);
    }
    evCard.appendChild(evBody);
    grid.appendChild(evCard);
    sec.appendChild(grid);
  }

  /* ------------------------------------------------------------------ rendering: emerging */

  function emergingDrill(row) {
    var res = S.emerging;
    var filters = { range: { preset: 'custom', from: res && res.params ? res.params.recentFrom : addDays(S.asOf, -6), to: res && res.params ? res.params.recentTo : S.asOf } };
    var v = String(row.value);
    if (row.unit === 'category') filters.category = [v];
    else if (row.unit === 'product') filters.product = [v];
    else if (row.unit === 'subcategory') { var parts = v.split('/'); filters.category = [parts[0]]; if (parts[1]) filters.subcategory = [parts[1]]; }
    else filters.search = row.unit === 'kit_component' ? label('kit_component', v) : v;
    if (S.emergingNegOnly) filters.sentiment = ['negative'];
    drill(filters);
  }
  function renderEmergingSection() {
    var sec = S.els.emerging;
    if (!sec) return;
    sec.innerHTML = '';
    var res = S.emerging;
    var negSwitch = h('label', { class: 'switch', title: 'Score only negative or complaint records' }, [
      h('input', { type: 'checkbox', onchange: function (e) { S.emergingNegOnly = !!e.target.checked; runEmerging(); renderEmergingSection(); } }),
      h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', { class: 'switch__label', text: 'Negative only' })
    ]);
    negSwitch.querySelector('input').checked = S.emergingNegOnly;
    var units = h('div', { class: 'lab-unit-chips', role: 'group', 'aria-label': 'Units to scan' });
    EMERGING_UNITS.forEach(function (u) {
      var on = S.emergingUnits.indexOf(u) >= 0;
      units.appendChild(h('button', { type: 'button', class: 'chip' + (on ? ' chip--active' : ''), 'aria-pressed': String(on), onclick: function () {
        var i = S.emergingUnits.indexOf(u);
        if (i >= 0) { if (S.emergingUnits.length === 1) return; S.emergingUnits.splice(i, 1); } else S.emergingUnits.push(u);
        runEmerging(); renderEmergingSection();
      } }, UNIT_LABELS[u]));
    });
    sec.appendChild(h('div', { class: 'lab-section-head' }, [
      h('div', {}, [h('h2', { class: 'section-title', text: 'Emerging issues' }), h('p', { class: 'muted t-13', text: res ? res.explanation : 'Emerging detector unavailable.' })]),
      h('div', { class: 'row' }, [negSwitch, units, res ? pill('confidence', res.confidence) : null])
    ]));
    var card = h('section', { class: 'card lab-emerging' });
    if (!ui() || !ui().table || !res) { emptyInto(card, 'Nothing to compare', 'The emerging detector needs records in the last 35 days before the as-of date.'); sec.appendChild(card); return; }
    var p = res.params || {};
    card.appendChild(h('header', { class: 'card__header' }, [h('div', {}, [
      h('h3', { class: 'card__title', text: 'Last ' + (p.recentDays || 7) + ' days vs prior ' + (p.baseDays || 28) }),
      h('p', { class: 'card__subtitle', text: 'Recent ' + fmtDate(p.recentFrom) + ' – ' + fmtDate(p.recentTo) + ' (n = ' + fmtInt(res.nRecent) + ') vs baseline ' + fmtDate(p.baseFrom) + ' – ' + fmtDate(p.baseTo) + ' (n = ' + fmtInt(res.nBase) + ') · ' + fmtInt(res.flagged) + ' new or emerging, ' + fmtInt(res.fading) + ' fading · click a row to open the recent records' })
    ]), h('button', { class: 'btn btn--f', type: 'button', 'aria-label': 'Formula for emerging issues', title: 'Formula', onclick: function (e) {
      if (ui().popover) ui().popover(e.currentTarget, '<div class="popover__title">Emerging issues</div><pre class="formula" style="white-space:pre-wrap">' + esc('E = c_B × N_R / N_B\nSparse units: z = (c_R − E) / √(E + 1)\nCategories and products: two-proportion z\nnew: c_B = 0 ∧ c_R ≥ 3 · emerging: z ≥ 2 ∧ lift ≥ 1.5 · fading: z ≤ −2 ∧ c_B ≥ 5') + '</pre>');
    } }, 'ƒ')]));
    var rows = (res.rows || []).map(function (r, i) { return Object.assign({ id: 'em' + i }, r); });
    var body = h('div', {});
    if (!rows.length) emptyInto(body, 'No units with enough mentions', 'Units need at least ' + (p.minRecent || 3) + ' recent mentions to be scored.');
    else {
      var t = ui().table({
        columns: [
          { key: 'label', label: 'Unit', render: function (r) { return '<span class="strong">' + esc(r.label) + '</span>'; } },
          { key: 'unit', label: 'Type', render: function (r) { return esc(UNIT_LABELS[r.unit] || r.unit); } },
          { key: 'status', label: 'Status', render: function (r) { return statusPill(r.status); }, sortValue: function (r) { return { new: 0, emerging: 1, fading: 2, stable: 3 }[r.status]; } },
          { key: 'cR', label: 'Recent', align: 'right' },
          { key: 'cB', label: 'Baseline', align: 'right' },
          { key: 'expected', label: 'Expected', align: 'right', render: function (r) { return esc(fmtNum(r.expected, 1)); } },
          { key: 'lift', label: 'Lift', align: 'right', render: function (r) { return isNum(r.lift) ? esc(fmtNum(r.lift, 1)) + '×' : 'new'; } },
          { key: 'z', label: 'z', align: 'right', render: function (r) { return esc(fmtNum(r.z, 1)); } }
        ],
        rows: rows, pageSize: 12, sortKey: 'z', sortDir: 'desc', flat: true, onRowClick: emergingDrill, rowClass: function (r) { return 'is-' + r.status; }
      });
      body.appendChild(t.el);
    }
    card.appendChild(body);
    sec.appendChild(card);
  }

  /* ------------------------------------------------------------------ rendering: detector backtest */

  function renderBacktestSection() {
    var sec = S.els.backtest;
    if (!sec) return;
    sec.innerHTML = '';
    var bt = S.backtest, res = bt && bt.result;
    sec.appendChild(h('div', { class: 'lab-section-head' }, [
      h('div', {}, [h('h2', { class: 'section-title', text: 'Detector backtest against planted events' }),
        h('p', { class: 'muted t-13', text: res ? res.explanation : 'Detector backtest unavailable.' })]),
      res ? pill('confidence', res.confidence) : null
    ]));
    var card = h('section', { class: 'card lab-backtest' });
    if (!res || !ui() || !ui().table) { emptyInto(card, 'No planted events to replay', 'The seed metadata carries no planted_events, or js/predict.js is missing.'); sec.appendChild(card); return; }
    var rows = (res.rows || []).slice();
    var evaluated = rows.filter(function (r) { return r.detected !== null; });
    var detected = evaluated.filter(function (r) { return r.detected; });
    var leads = detected.map(function (r) { return r.leadDays; }).filter(isNum).sort(function (a, b) { return a - b; });
    var medLead = leads.length ? leads[Math.floor(leads.length / 2)] : null;
    var stat = function (label, value, sub) { return h('div', { class: 'lab-stat' }, [h('div', { class: 'lab-stat__value num', text: value }), h('div', { class: 'lab-stat__label', text: label }), sub ? h('div', { class: 'lab-stat__sub muted', text: sub }) : null]); };
    card.appendChild(h('div', { class: 'lab-stats' }, [
      stat('Detected', fmtInt(detected.length) + ' / ' + fmtInt(evaluated.length), 'planted events with a mapped detector'),
      stat('Recall', isNum(res.recall) ? fmtPct(res.recall, 0) : '—', 'target ≥ 80% · n = ' + fmtInt(evaluated.length)),
      stat('Median lead', isNum(medLead) ? fmtInt(medLead) + ' days' : '—', 'from first flag to window end · n = ' + fmtInt(leads.length)),
      stat('Records replayed', fmtInt(bt.n), 'through ' + fmtDate(S.asOf) + (bt.pending.length ? ' · ' + fmtInt(bt.pending.length) + ' events end later' : ''))
    ]));
    var all = rows.map(function (r) { return Object.assign({ id: r.id, kindLabel: r.detected === null ? 'unmapped' : r.detected ? 'detected' : 'missed' }, r); })
      .concat(bt.pending.map(function (e) { return { id: e.id, title: e.title, detector: e.detector, from: String(e.from || '').slice(0, 10), to: String(e.to || e.from || '').slice(0, 10), detected: null, leadDays: null, kindLabel: 'pending', detail: 'Window ends after the as-of date; move the as-of date to ' + fmtDate(String(e.to || '').slice(0, 10)) + ' or later to replay it.' }; }));
    all.sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
    var t = ui().table({
      columns: [
        { key: 'id', label: 'Event', render: function (r) { return '<span class="strong">' + esc(r.id) + '</span> ' + esc(r.title || ''); } },
        { key: 'from', label: 'Window', render: function (r) { return esc(fmtDate(r.from)) + (r.to && r.to !== r.from ? ' – ' + esc(fmtDate(r.to)) : ''); } },
        { key: 'detector', label: 'Detector', render: function (r) { return '<span class="lab-mono">' + esc(r.detector || '—') + '</span>'; } },
        { key: 'kindLabel', label: 'Result', render: function (r) { return h('span', { class: 'pill pill--plain lab-result lab-result--' + r.kindLabel }, r.kindLabel.charAt(0).toUpperCase() + r.kindLabel.slice(1)); } },
        { key: 'leadDays', label: 'Lead', align: 'right', render: function (r) { return isNum(r.leadDays) ? esc(fmtInt(r.leadDays)) + ' d' : '—'; } },
        { key: 'detail', label: 'Detail', wrap: true, render: function (r) { return '<span class="lab-detail">' + esc(r.detail || '') + '</span>'; } }
      ],
      rows: all, pageSize: 20, footer: false, flat: true,
      onRowClick: function (r) { if (r.from && r.to) drill({ range: { preset: 'custom', from: r.from, to: r.to > S.asOf ? S.asOf : r.to } }); }
    });
    card.appendChild(t.el);
    card.appendChild(h('p', { class: 'card__footer', text: 'Replay uses every record received on or before each window end, ignoring dimension filters; lead days count from the first flag to the end of the planted window. Click a row to open the records in that window.' }));
    sec.appendChild(card);
  }

  /* ------------------------------------------------------------------ orchestration */

  function renderAll() {
    setHeader();
    renderScopeNotice();
    renderCards();
    syncFitLine();
    renderForecastCards();
    renderAnomalySection();
    renderEmergingSection();
    renderBacktestSection();
  }
  function setAsOf(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return;
    if (day > S.today) day = S.today;
    if (S.minDay && day < S.minDay) day = S.minDay;
    if (day === S.asOf) return;
    S.asOf = day;
    if (S.els.asOf) S.els.asOf.value = day;
    recomputeScope(S.derived, true);
    renderAll();
  }
  function destroyCharts() {
    Object.keys(S.cards).forEach(function (k) { var c = S.cards[k]; if (c && typeof c.vocDestroy === 'function') { try { c.vocDestroy(); } catch (e) { /* gone */ } } });
    S.cards = {};
  }

  VOC.views[NAME] = {
    title: TITLE,
    icon: NAME,
    /**
     * @param {HTMLElement} root
     * @param {Object|null} derived  VOC.store.derived()
     */
    mount: function (root, derived) {
      S = freshState();
      S.root = root;
      S.derived = derived || null;
      S.today = dayKeyOf(storeNow().toISOString());
      var seedRange = (typeof window !== 'undefined' && window.VOC_SEED && window.VOC_SEED.meta && window.VOC_SEED.meta.range) || null;
      S.minDay = seedRange && seedRange[0] ? String(seedRange[0]).slice(0, 10) : null;
      S.asOf = S.today;
      loadPersisted();

      root.innerHTML = '';
      var asOfInput = h('input', { type: 'date', class: 'date-input', id: 'lab-asof', value: S.asOf, max: S.today, min: S.minDay || null, 'aria-label': 'Replay as of date' });
      asOfInput.addEventListener('change', function () { setAsOf(asOfInput.value); });
      S.els.asOf = asOfInput;
      var todayBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: function () { setAsOf(S.today); } }, 'Today');
      var jumpBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', title: 'Replay the foreign-material ramp (planted event E6) at its window end',
        onclick: function () { setAsOf('2026-05-31'); } }, 'May 31, 2026');
      var asOfControls = [h('label', { class: 'label', for: 'lab-asof', text: 'As of' }), asOfInput, todayBtn, S.minDay && '2026-05-31' >= S.minDay && '2026-05-31' <= S.today ? jumpBtn : null];
      if (ui() && typeof ui().viewHeader === 'function') {
        S.els.header = ui().viewHeader({ title: TITLE, meta: metaText(derived), lead: 'Fitting the volume model…', actions: asOfControls });
        S.els.header.vocActions.classList.add('lab-asof');
      } else {
        S.els.header = h('header', { class: 'view-header' }, [h('h1', { class: 'view-title', text: TITLE }), h('p', { class: 'view-meta', 'data-role': 'subtitle', text: metaText(derived) }), h('div', { class: 'view-actions lab-asof' }, asOfControls)]);
      }
      root.appendChild(S.els.header);
      // The scope sentence (which records feed the models, replay state) sits in a collapsed block under the header.
      S.els.scope = h('p', { class: 'notice lab-scope', role: 'status' });
      root.appendChild(ui() && typeof ui().howDetails === 'function'
        ? ui().howDetails({ summary: 'How this works: which records feed the models', body: S.els.scope })
        : h('details', { class: 'how' }, [h('summary', { class: 'how__summary', text: 'How this works: which records feed the models' }), h('div', { class: 'how__body' }, [S.els.scope])]));
      var cardsSec = h('section', { class: 'view-section' }, [h('h2', { class: 'section-title', text: 'Model cards' })]);
      S.els.cards = h('div', { class: 'model-cards' });
      cardsSec.appendChild(S.els.cards);
      root.appendChild(cardsSec);
      var lab = h('div', { class: 'lab-layout' });
      S.els.controls = h('aside', { class: 'lab-controls card', 'aria-label': 'Volume model parameters' });
      S.els.charts = h('div', { class: 'lab-charts' });
      lab.appendChild(S.els.controls); lab.appendChild(S.els.charts);
      root.appendChild(lab);
      S.els.anomalies = h('section', { class: 'view-section lab-anomalies' });
      S.els.emerging = h('section', { class: 'view-section lab-emerging-section' });
      S.els.backtest = h('section', { class: 'view-section lab-backtest-section' });
      root.appendChild(S.els.anomalies); root.appendChild(S.els.emerging); root.appendChild(S.els.backtest);

      recomputeScope(derived, true);
      renderControls();
      renderAll();

      var s = store();
      if (s && typeof s.on === 'function') {
        S.offRecords = function () { S.backtestKey = null; S.forceNext = true; };
        s.on('records:changed', S.offRecords);
      }
    },
    /** @param {Object|null} derived */
    update: function (derived) {
      if (!S || !S.root) return;
      S.derived = derived || S.derived;
      setHeader();
      var today = dayKeyOf(storeNow().toISOString());
      if (today !== S.today) { var follow = S.asOf === S.today; S.today = today; if (S.els.asOf) S.els.asOf.max = today; if (follow) S.asOf = today; }
      var force = !!S.forceNext;
      S.forceNext = false;
      if (recomputeScope(derived, force)) renderAll();
    },
    unmount: function () {
      if (!S) return;
      clearTimeout(S.timers.refit); clearTimeout(S.timers.persist);
      destroyCharts();
      var s = store();
      if (s && typeof s.off === 'function' && S.offRecords) s.off('records:changed', S.offRecords);
      S = null;
    }
  };
})();
