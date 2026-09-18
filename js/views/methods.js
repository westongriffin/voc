/* L-Nutra · Voice of the Customer — Methods view (SPEC §5 item 11)
   Metric registry, classification pipeline with thresholds, lexicon/rules versions and sizes, model parameter
   defaults, planted events with detection status, data provenance, agreement statistics and how confidence
   pills are assigned. Mostly static tables; sections carry ids so other views can link with ?section=<id>.
   DOM is touched only inside mount/update/unmount so the file parses under jsc. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'methods';
  var TITLE = 'Methods';
  var SECTIONS = [
    { id: 'registry', title: 'Metric registry' },
    { id: 'pipeline', title: 'Classification pipeline' },
    { id: 'models', title: 'Model parameter defaults' },
    { id: 'events', title: 'Planted events' },
    { id: 'provenance', title: 'Data provenance' },
    { id: 'agreement', title: 'Agreement and data quality' },
    { id: 'confidence', title: 'How confidence is assigned' }
  ];

  /* SPEC §7 thresholds, stated here so the page reads correctly even before rules.js/classify.js load. */
  var PIPELINE = [
    { name: 'preprocess', title: 'Preprocess', text: 'HTML becomes text; quoted replies are cut at "On … wrote:", "-----Original Message-----" and "From: … Sent:"; lines starting with ">" are dropped; signatures are cut at "-- " or "Sent from my"; whitespace collapses. Case and ! ? are kept for the sentiment stage.' },
    { name: 'isNoise', title: 'Noise gate', text: 'Auto-replies, bounces, newsletters and duplicates are flagged from headers (Auto-Submitted, Precedence, List-Id, List-Unsubscribe, X-Autoreply) and a subject pattern; they close as noise and leave every metric.' },
    { name: 'detectLanguage', title: 'Language gate', text: 'Share of English stopwords ≥ 0.18 → en. Below 0.08 with ≥ 20 tokens → other (sentiment stays unscored). Otherwise unknown.', thresholds: ['en ≥ 0.18', 'other < 0.08 (≥ 20 tokens)'] },
    { name: 'scoreSentiment', title: 'Sentiment (VADER-style)', text: 'Base valence −4..+4 plus an L-Nutra domain layer; phrases match before tokens. Negation within 3 preceding tokens × −0.74; boosters +0.293, dampeners −0.293; ALL-CAPS +0.733 when the text is mixed case; each "!" +0.292 (max 4); tokens after the last "but" × 1.5, before × 0.5. Sentence compound = Σv / √(Σv² + 15); the record takes the mean of sentence compounds and keeps the worst sentence as sentiment_min.', thresholds: ['positive ≥ +0.15', 'negative ≤ −0.15', 'brand stoplist carries no valence'] },
    { name: 'scoreCategories', title: 'Category and subcategory', text: 'Each subcategory has 3–10 word-boundary patterns with weights; subject hits × 1.5. Category score = best subcategory + 0.5 × the other subcategories in that category. Every category scoring ≥ 2 becomes secondary; the primary is the argmax, ties (top two within 20%) resolve by a fixed priority order that puts adverse events and foreign material first.', thresholds: ['secondary ≥ 2', 'confidence = top / (top + 2)', 'no hits → praise/general_praise if compound > 0.3, else usage_guidance/general_question at 0.2'] },
    { name: 'detectProduct', title: 'Product and kit component', text: 'Product aliases (subject × 1.5): Next Gen, 5-Day, 1-Day Reset, 5:2, Fast Bar, Fasting Shake, L-Protein, L-Pill, Starter Pack, Guided Health, L-Nutra Health. Subscription terms with no product ≥ 2 → Subscription & Account; nothing → General. Kit components match by name, longest phrase first (e.g. "minestrone quinoa" before "minestrone").' },
    { name: 'assessSafety', title: 'Safety', text: 'Serious terms (faint, passed out, hospital, ER, ambulance, anaphylaxis, allergic reaction, chest pain, seizure, blood sugar crashed, hypoglyc…) set serious_ae; non-serious terms set is_adverse_event; contraindication flags for pregnancy, minors, glucose medication, nut/soy allergy, low BMI and serious disease; food-safety terms (shell, hard bit, foreign, glass, plastic, metal, mold, spoiled, broken seal, undeclared).', thresholds: ['MedWatch clock: serious AE → 15 business days (US federal holidays excluded)', 'RFR clock: food safety on conventional food → 24 hours'] },
    { name: 'assignUrgency', title: 'Urgency and escalation', text: 'P0: serious AE, food safety, pregnancy/minor contraindication, or legal/BBB/chargeback/FDA/press wording. P1: any adverse event, duplicate charge, unauthorized signup, post-cancel shipment, lost parcel, leaking, NPS ≤ 6 with sentiment ≤ −0.5, or a negative practitioner/wholesale message. P2: taste, shipping ETA, promo, guidance, checkout, price. P3: praise, requests, marketing.', thresholds: ['P0 → Quality & Regulatory (+ Medical for AE/contraindication)', 'P1 billing → Finance', 'claim-related → Legal'] },
    { name: 'extractEntities', title: 'Entities', text: 'Order ids (Shopify #1xxxxx, Amazon 113-xxxxxxx-xxxxxxx, practitioner PP-xxxxx), lot numbers and HCP codes.' },
    { name: 'flags', title: 'Flags', text: 'claim_related (misleading, false advertising, clinically proven, autophagy, remission, biological age, scam); cancel_intent (cancel, unsubscribe, stop my subscription, refund); restricted when the segment is an L-Nutra Health or practitioner patient, the text mentions A1c, HbA1c, creatinine, a prescribing doctor or a diagnosis, or the recipient is Med.Ed@.' },
    { name: 'identity', title: 'Identity and thread', text: 'customer_id is a hash of the normalized email (lower-case, +tags stripped, Gmail dots removed); thread_id comes from message headers or, failing that, the normalised subject and counterpart within 30 days. Every remaining field takes its schema default.' }
  ];
  /* SPEC §8 defaults used only when js/predict.js is absent. */
  var SPEC_DEFAULTS = {
    holtWinters: { alpha: 0.3, beta: 0.05, gamma: 0.2, phi: 0.9, horizon: 28, z: [1.28, 1.96], sigmaWindow: 56 },
    sentiment: { horizon: 14, lambda: 0.15 },
    anomalies: { window: 28, warn: 2, critical: 3, dowClamp: [0.3, 2.5], floors: 'counts 1.0 / shares 0.03' },
    emerging: { recentDays: 7, baseDays: 28, minRecent: 3, rules: 'new: cB = 0 ∧ cR ≥ 3 · emerging: z ≥ 2 ∧ lift ≥ 1.5 · fading: z ≤ −2 ∧ cB ≥ 5' },
    logistic: { lr: 0.1, epochs: 400, l2: 0.01, minLabelled: 40 },
    csat: { lambda: 1, minN: 50, z: 1.28 },
    drivers: { minSupport: 10, alpha: 0.05 },
    churn: { intercept: -3, tiers: '0–24 low · 25–49 watch · 50–74 high · 75+ critical' },
    escalation: { intercept: -2.5, urgency: 1.2, negative: 1.5, severe: 2.5, strong: 1.2, mild: 0.5, age: 1.3, repeat: 1.0, noResponse: 0.8, publicChannel: 0.5 }
  };
  var MODEL_TITLES = { holtWinters: 'Volume forecast (Holt-Winters)', sentiment: 'Sentiment smoothing (EWMA)', anomalies: 'Anomaly detection (rolling z)', emerging: 'Emerging issues (Poisson surprise)',
    churn: 'Cancellation risk (heuristic logit)', logistic: 'Cancellation risk (fitted logistic)', escalation: 'Escalation risk (fixed logit)', csat: 'Predicted CSAT (ridge)', drivers: 'Driver analysis (χ² lift)' };
  var PARAM_NOTES = {
    'holtWinters.alpha': 'level smoothing', 'holtWinters.beta': 'trend smoothing', 'holtWinters.gamma': 'weekday smoothing', 'holtWinters.phi': 'trend damping', 'holtWinters.horizon': 'days ahead',
    'holtWinters.z': 'inner / outer band', 'holtWinters.sigmaFloor': 'minimum σ', 'holtWinters.sigmaWindow': 'days of residuals for σ',
    'sentiment.lambda': 'EWMA weight', 'sentiment.shrinkK': 'daily weight shrinks by n/(n+k)', 'sentiment.z': 'band width',
    'anomalies.window': 'trailing days, excluding day t', 'anomalies.weeklyWindow': 'trailing weeks for weekly series', 'anomalies.warn': '|z| for warning', 'anomalies.critical': '|z| for critical',
    'anomalies.shareShrink': 'pseudo-count pulling small-n shares to baseline', 'anomalies.dowShrink': 'weekday factor shrinkage', 'anomalies.dowHistory': 'days used for weekday factors',
    'emerging.recentDays': 'recent window', 'emerging.baseDays': 'baseline window', 'emerging.minRecent': 'hide units with fewer recent mentions', 'emerging.minFading': 'baseline count needed to call fading',
    'logistic.lr': 'gradient-descent step', 'logistic.epochs': 'passes', 'logistic.l2': 'ridge penalty on slopes', 'logistic.minLabelled': 'labelled customers needed to fit',
    'csat.lambda': 'ridge penalty', 'csat.minN': 'resolved CSAT records needed', 'csat.z': 'prediction interval ±zσ', 'csat.topCategories': 'category one-hots',
    'drivers.minSupport': 'records per value', 'drivers.alpha': 'BH-adjusted q threshold', 'churn.intercept': 'logit intercept', 'escalation.intercept': 'logit intercept'
  };

  /* ------------------------------------------------------------------ helpers */

  function ui() { return VOC.ui || null; }
  function store() { return VOC.store || null; }
  function F() { return (VOC.util && VOC.util.fmt) || {}; }
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
  function fmtInt(n) { return F().int ? F().int(n) : (isNum(n) ? String(Math.round(n)) : '—'); }
  function fmtNum(n, d) { return F().num ? F().num(n, d || 0) : (isNum(n) ? n.toFixed(d || 0) : '—'); }
  function fmtPct(p, d) { return F().pct ? F().pct(p, d || 0) : (isNum(p) ? (p * 100).toFixed(d || 0) + '%' : '—'); }
  function fmtDate(iso, gran) { return F().date ? F().date(iso, gran || 'day') : String(iso || '—'); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + derived.n + ' records' : '';
  }
  /** One bold sentence for the header: what this page documents, as counts, with n in scope. */
  function leadText(derived) {
    var reg = VOC.metrics && VOC.metrics.registry ? Object.keys(VOC.metrics.registry).length : 0;
    var rules = VOC.rules && Array.isArray(VOC.rules.categories) ? VOC.rules.categories : [];
    var subs = 0;
    rules.forEach(function (c) { subs += (c.subcategories || []).length; });
    var events = Array.isArray(seedMeta().planted_events) ? seedMeta().planted_events.length : 0;
    var n = derived && isNum(derived.n) ? derived.n : null;
    return fmtInt(reg) + ' metrics, ' + fmtInt(rules.length) + ' categories, ' + fmtInt(subs) + ' subcategories and ' + fmtInt(events) + ' planted events documented here' +
      (n === null ? '.' : ' (n = ' + fmtInt(n) + ' records in the current scope).');
  }
  function pill(kind, value) { return ui() && ui().pill ? ui().pill(kind, value) : h('span', { class: 'pill' }, String(value)); }
  function mono(text) { return h('code', { class: 'methods-mono', text: String(text) }); }
  function emptyInto(el, title, text) {
    if (ui() && ui().emptyState) ui().emptyState(el, { title: title, text: text });
    else el.innerHTML = '<div class="empty-state"><div class="empty-state__title">' + esc(title) + '</div><p class="empty-state__text">' + esc(text || '') + '</p></div>';
  }
  function fmtValue(v) {
    if (v === null || v === undefined) return '—';
    if (Array.isArray(v)) return v.map(fmtValue).join(', ');
    if (typeof v === 'number') return Math.abs(v) >= 100 ? fmtInt(v) : String(Math.round(v * 1000) / 1000);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'object') return Object.keys(v).map(function (k) { return k + ' ' + fmtValue(v[k]); }).join(' · ');
    return String(v);
  }
  function seedMeta() {
    var seed = typeof window !== 'undefined' ? window.VOC_SEED : null;
    if (seed && seed.meta) return seed.meta;
    var s = store();
    try { if (s && typeof s.meta === 'function') return s.meta() || {}; } catch (e) { /* fall through */ }
    return {};
  }
  function section(id, title, lede) {
    var sec = h('section', { class: 'card methods-section', id: 'methods-' + id, 'aria-labelledby': 'methods-' + id + '-title' });
    sec.appendChild(h('header', { class: 'card__header' }, [h('div', {}, [h('h2', { class: 'card__title methods-section__title', id: 'methods-' + id + '-title', text: title }), lede ? h('p', { class: 'card__subtitle', text: lede }) : null])]));
    return sec;
  }
  function simpleTable(columns, rows, opts) {
    opts = opts || {};
    if (ui() && ui().table) return ui().table(Object.assign({ columns: columns, rows: rows, pageSize: opts.pageSize || 100, footer: false, flat: true, emptyText: opts.emptyText || 'Nothing to show.' }, opts)).el;
    var wrap = h('div', { class: 'table-wrap' });
    var t = h('table', { class: 'table' });
    t.appendChild(h('thead', {}, h('tr', {}, columns.map(function (c) { return h('th', { text: c.label }); }))));
    t.appendChild(h('tbody', {}, rows.map(function (r) { return h('tr', {}, columns.map(function (c) { var v = typeof c.render === 'function' ? c.render(r, r[c.key]) : r[c.key]; return h('td', typeof v === 'string' ? { html: v } : {}, typeof v === 'object' ? v : null); })); })));
    wrap.appendChild(t);
    return wrap;
  }

  /* ------------------------------------------------------------------ state */

  var S = null;

  /* ------------------------------------------------------------------ sections */

  function renderToc() {
    var nav = h('nav', { class: 'methods-toc', 'aria-label': 'Sections' });
    SECTIONS.forEach(function (s) {
      nav.appendChild(h('a', { class: 'chip', href: '#/methods?section=' + s.id, onclick: function (e) { e.preventDefault(); scrollToSection(s.id); } }, s.title));
    });
    return nav;
  }
  function scrollToSection(id) {
    if (!S || !S.root) return;
    var el = S.root.querySelector('#methods-' + id);
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(); }
    var focus = el.querySelector('.methods-section__title');
    if (focus) { focus.setAttribute('tabindex', '-1'); focus.focus({ preventScroll: true }); }
  }

  function renderRegistry() {
    var sec = section('registry', 'Metric registry', 'Every KPI on the site comes from this table; views never compute a metric by hand. Direction says which way is good.');
    var reg = VOC.metrics && VOC.metrics.registry;
    if (!reg) { var e = h('div'); emptyInto(e, 'Metric registry not loaded', 'js/analytics.js is missing, so no metric definitions are available.'); sec.appendChild(e); return sec; }
    var dirLabel = { up_good: '↑ higher is better', down_good: '↓ lower is better', neutral: '· neutral' };
    var rows = Object.keys(reg).map(function (id) { var m = reg[id]; return { id: id, label: m.label, unit: m.unit, direction: m.direction, formula: m.formula }; });
    sec.appendChild(h('p', { class: 'card__subtitle methods-count', text: fmtInt(rows.length) + ' metrics · pct-unit values are percent points 0–100 in the registry; data-quality shares are 0–1 fractions' }));
    sec.appendChild(simpleTable([
      { key: 'id', label: 'Id', render: function (r) { return mono(r.id); } },
      { key: 'label', label: 'Label' },
      { key: 'unit', label: 'Unit', render: function (r) { return mono(r.unit); } },
      { key: 'direction', label: 'Direction', render: function (r) { return esc(dirLabel[r.direction] || r.direction); } },
      { key: 'formula', label: 'Formula', wrap: true, render: function (r) { return '<span class="formula">' + esc(r.formula || '—') + '</span>'; } }
    ], rows, { pageSize: 50 }));
    return sec;
  }

  function renderPipeline() {
    var sec = section('pipeline', 'Classification pipeline', 'Stages run in this order inside classifyRecord; thresholds are the SPEC §7 values the tests check against.');
    var lex = VOC.lexicon, rules = VOC.rules, cls = VOC.classify;
    var stats = h('div', { class: 'methods-stats' });
    function stat(label, value, sub) { return h('div', { class: 'methods-stat' }, [h('div', { class: 'methods-stat__value', text: value }), h('div', { class: 'methods-stat__label', text: label }), sub ? h('div', { class: 'methods-stat__sub', text: sub }) : null]); }
    if (lex) {
      var size = function (o) { return o && typeof o === 'object' ? (Array.isArray(o) ? o.length : Object.keys(o).length) : 0; };
      stats.appendChild(stat('Lexicon', 'v' + (lex.version || '—'), fmtInt(size(lex.BASE)) + ' base terms · ' + fmtInt(size(lex.DOMAIN)) + ' domain terms'));
      stats.appendChild(stat('Modifiers', fmtInt(size(lex.BOOSTERS) + size(lex.DAMPENERS)), fmtInt(size(lex.BOOSTERS)) + ' boosters · ' + fmtInt(size(lex.DAMPENERS)) + ' dampeners · ' + fmtInt(size(lex.NEGATORS)) + ' negators'));
      stats.appendChild(stat('Stopwords', fmtInt(size(lex.STOPWORDS)), fmtInt(size(lex.BRAND_STOPLIST)) + ' brand tokens carry no valence'));
    } else stats.appendChild(stat('Lexicon', 'not loaded', 'js/lexicon.js is missing'));
    if (rules && Array.isArray(rules.categories)) {
      var subs = 0, pats = 0;
      rules.categories.forEach(function (c) { (c.subcategories || []).forEach(function (s) { subs += 1; pats += (s.patterns || []).length; }); });
      stats.appendChild(stat('Rules', 'v' + (rules.version || '—'), fmtInt(rules.categories.length) + ' categories · ' + fmtInt(subs) + ' subcategories · ' + fmtInt(pats) + ' patterns'));
      stats.appendChild(stat('Product aliases', fmtInt((rules.productAliases || []).length), fmtInt((rules.components || []).length) + ' kit-component patterns'));
    } else stats.appendChild(stat('Rules', 'not loaded', 'js/rules.js is absent in this build; records keep their seed classification'));
    stats.appendChild(stat('Classifier', cls && typeof cls.classifyRecord === 'function' ? 'active' : 'not loaded', cls ? 'reclassify() runs on every seed record at start-up' : 'js/classify.js is absent; agreement below compares the seed’s stored rule_* fields with its labels'));
    sec.appendChild(stats);
    var ol = h('ol', { class: 'pipeline-steps' });
    PIPELINE.forEach(function (st) {
      var li = h('li', { class: 'pipeline-step' }, [
        h('div', { class: 'pipeline-step__head' }, [h('span', { class: 'pipeline-step__title', text: st.title }), mono(st.name)]),
        h('p', { class: 'pipeline-step__text', text: st.text })
      ]);
      if (st.thresholds) li.appendChild(h('div', { class: 'pipeline-step__thresholds' }, st.thresholds.map(function (t) { return h('span', { class: 'tag', text: t }); })));
      ol.appendChild(li);
    });
    sec.appendChild(ol);
    sec.appendChild(h('p', { class: 'prose', text: 'Tie-break priority when the top two categories are within 20%: adverse event › foreign material & allergen › subscription & billing › shipping › missing or damaged › taste › side effects › customer service › checkout › price › results › practitioner › usage guidance › product requests › marketing › praise. A record is flagged needs_review when the rule category disagrees with its stored category or confidence falls below 0.5.' }));
    return sec;
  }

  function renderModels() {
    var sec = section('models', 'Model parameter defaults', 'Values come from VOC.predict.defaults at run time; the Forecast Lab sliders start here.');
    var d = (VOC.predict && VOC.predict.defaults) || null;
    var source = d ? d : SPEC_DEFAULTS;
    var rows = [];
    Object.keys(source).forEach(function (model) {
      var obj = source[model];
      if (!obj || typeof obj !== 'object') return;
      if (model === 'churn') {
        rows.push({ model: model, param: 'intercept', value: fmtValue(obj.intercept), note: 'logit = intercept + Σ w·x, x = min(raw, cap)/cap' });
        (obj.features || []).forEach(function (f) { rows.push({ model: model, param: f.id, value: 'cap ' + fmtValue(f.cap) + ' · w ' + fmtValue(f.w), note: f.window ? 'window ' + f.window : '' }); });
        if (obj.tiers) rows.push({ model: model, param: 'tiers', value: Array.isArray(obj.tiers) ? obj.tiers.map(function (t) { return t[2] + ' ' + t[0] + '–' + t[1]; }).join(' · ') : String(obj.tiers), note: 'score 0–100' });
        return;
      }
      Object.keys(obj).forEach(function (k) {
        rows.push({ model: model, param: k, value: fmtValue(obj[k]), note: PARAM_NOTES[model + '.' + k] || '' });
      });
    });
    if (!d) sec.appendChild(h('p', { class: 'notice notice--warning', text: 'js/predict.js is not loaded; these are the SPEC §8 values, not live defaults.' }));
    sec.appendChild(h('p', { class: 'card__subtitle methods-count', text: fmtInt(rows.length) + ' parameters across ' + fmtInt(Object.keys(source).length) + ' models' + (d && VOC.predict.version ? ' · predict.js v' + VOC.predict.version : '') }));
    sec.appendChild(simpleTable([
      { key: 'model', label: 'Model', render: function (r) { return esc(MODEL_TITLES[r.model] || r.model); } },
      { key: 'param', label: 'Parameter', render: function (r) { return mono(r.param); } },
      { key: 'value', label: 'Default', render: function (r) { return '<span class="num">' + esc(r.value) + '</span>'; } },
      { key: 'note', label: 'Meaning', wrap: true }
    ], rows, { pageSize: 200 }));
    return sec;
  }

  function computeBacktest() {
    var p = VOC.predict, s = store();
    var events = Array.isArray(seedMeta().planted_events) ? seedMeta().planted_events : [];
    var version = 0;
    try { version = s && typeof s.version === 'function' ? s.version() : 0; } catch (e) { version = 0; }
    var key = version + '|' + events.length;
    if (S.backtest && S.backtestKey === key) return S.backtest;
    S.backtestKey = key;
    S.backtest = null;
    if (!p || typeof p.detectorBacktest !== 'function' || !events.length) return null;
    var recs = [];
    try { recs = s && typeof s.allWithNoise === 'function' ? s.allWithNoise() : []; } catch (e) { recs = []; }
    var nowIso = null;
    try { nowIso = s && typeof s.now === 'function' ? s.now().toISOString() : null; } catch (e) { nowIso = null; }
    try { S.backtest = p.detectorBacktest(recs, events, nowIso ? { now: nowIso } : {}); } catch (e) { S.backtest = null; }
    return S.backtest;
  }
  function renderEvents() {
    var events = Array.isArray(seedMeta().planted_events) ? seedMeta().planted_events : [];
    var sec = section('events', 'Planted events', 'The seed generator plants these patterns so every detector can be checked against a known answer; the status column replays the detectors at each window end.');
    if (!events.length) { var e = h('div'); emptyInto(e, 'No planted events', 'The seed metadata carries no planted_events list.'); sec.appendChild(e); return sec; }
    var bt = computeBacktest();
    var byId = {};
    ((bt && bt.rows) || []).forEach(function (r) { byId[r.id] = r; });
    var body = h('div', { class: 'methods-events' });
    body.appendChild(h('p', { class: 'card__subtitle methods-count', text: bt ? bt.explanation : fmtInt(events.length) + ' events · detection status needs js/predict.js' }));
    var rows = events.map(function (ev) {
      var r = byId[ev.id] || null;
      var status = !r ? 'unavailable' : r.detected === null ? 'unmapped' : r.detected ? 'detected' : 'missed';
      return { id: ev.id, title: ev.title, from: String(ev.from || '').slice(0, 10), to: String(ev.to || ev.from || '').slice(0, 10), detector: ev.detector || '—', expected: ev.expected, status: status, leadDays: r ? r.leadDays : null, detail: r ? r.detail : '' };
    });
    body.appendChild(simpleTable([
      { key: 'id', label: 'Event', render: function (r) { return '<span class="strong">' + esc(r.id) + '</span> ' + esc(r.title); } },
      { key: 'from', label: 'Window', render: function (r) { return esc(fmtDate(r.from)) + (r.to !== r.from ? ' – ' + esc(fmtDate(r.to)) : ''); } },
      { key: 'detector', label: 'Detector', render: function (r) { return mono(r.detector); } },
      { key: 'expected', label: 'Expected', wrap: true, render: function (r) { return '<span class="methods-expected">' + esc(fmtValue(r.expected)) + '</span>'; } },
      { key: 'status', label: 'Status', render: function (r) { return h('span', { class: 'pill pill--plain methods-result methods-result--' + r.status }, r.status.charAt(0).toUpperCase() + r.status.slice(1)); } },
      { key: 'leadDays', label: 'Lead', align: 'right', render: function (r) { return isNum(r.leadDays) ? esc(fmtInt(r.leadDays)) + ' d' : '—'; } },
      { key: 'detail', label: 'Detail', wrap: true, render: function (r) { return '<span class="methods-detail">' + esc(r.detail || '') + '</span>'; } }
    ], rows, { pageSize: 30 }));
    if (bt) body.appendChild(h('p', { class: 'card__footer', text: 'Recall ' + fmtPct(bt.recall, 0) + ' over n = ' + fmtInt(bt.evaluated) + ' events with a mapped detector (target ≥ 80%). Lead days count from the first flag to the end of the planted window. The Forecast Lab replays the same table at any as-of date.' }));
    sec.appendChild(body);
    return sec;
  }

  function renderProvenance(derived) {
    var meta = seedMeta();
    var seed = typeof window !== 'undefined' ? window.VOC_SEED : null;
    var s = store();
    var sec = section('provenance', 'Data provenance', 'Where the records come from and which module versions produced the numbers on this page.');
    var total = null, nonNoise = null, imported = null, clock = null, persistence = null;
    try {
      if (s && typeof s.allWithNoise === 'function') { var all = s.allWithNoise(); total = all.length; nonNoise = all.filter(function (r) { return !r.is_noise; }).length; imported = all.filter(function (r) { return r.source !== 'seed'; }).length; }
      if (s && typeof s.clockMode === 'function') clock = s.clockMode();
    } catch (e) { /* store unavailable */ }
    try { if (VOC.db && typeof VOC.db.persistence === 'function') persistence = VOC.db.persistence(); } catch (e) { persistence = null; }
    var dl = h('dl', { class: 'kv methods-kv' });
    function kv(k, v) { if (v === null || v === undefined || v === '') return; dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', { text: String(v) })); }
    kv('Schema version', meta.schema_version != null ? meta.schema_version : '—');
    kv('Seed generated', meta.generated ? fmtDate(meta.generated) + ' (seed ' + (meta.seed != null ? meta.seed : '—') + ', tools/generate_seed.py)' : '—');
    kv('As of', meta.as_of ? fmtDate(meta.as_of, 'datetime') : '—');
    kv('Range', Array.isArray(meta.range) && meta.range.length === 2 ? fmtDate(meta.range[0]) + ' – ' + fmtDate(meta.range[1]) : '—');
    kv('Timezone', meta.timezone || 'America/Chicago');
    kv('Seed records', seed && Array.isArray(seed.records) ? fmtInt(seed.records.length) : '—');
    kv('Records in store', isNum(total) ? fmtInt(total) + ' (' + fmtInt(nonNoise) + ' after noise, ' + fmtInt(imported) + ' imported or live)' : '—');
    kv('Customers · practices', seed ? fmtInt((seed.customers || []).length) + ' · ' + fmtInt((seed.practices || []).length) : '—');
    kv('Agents', Array.isArray(meta.agents) ? meta.agents.join(', ') : '—');
    kv('Clock', clock ? (clock === 'demo' ? 'Demo (ages and deadlines count from the seed as-of date)' : 'Live wall clock') : '—');
    kv('Persistence', persistence ? (persistence === 'idb' ? 'IndexedDB (imports and edits survive reloads)' : persistence === 'memory' ? 'Memory only (this session)' : persistence) : '—');
    var versions = [];
    [['predict', VOC.predict], ['metrics', VOC.metrics], ['analytics', VOC.analytics], ['lexicon', VOC.lexicon], ['rules', VOC.rules], ['classify', VOC.classify], ['alerts', VOC.alerts], ['narrate', VOC.narrate]].forEach(function (m) {
      versions.push(m[0] + ' ' + (m[1] ? (m[1].version ? 'v' + m[1].version : 'loaded') : 'absent'));
    });
    kv('Modules', versions.join(' · '));
    kv('Current view scope', derived ? subtitle(derived) : '—');
    sec.appendChild(dl);
    sec.appendChild(h('p', { class: 'prose', text: 'Seed records are synthetic: names, emails and order ids are generated, and the mailbox never leaves the browser. Imported mail keeps its message id and a fingerprint so re-imports add nothing. Restricted (patient) mail is redacted on display only; that is a convenience, not access control.' }));
    return sec;
  }

  function agreementRows(derived) {
    var dq = (derived && derived.dq) || {};
    return [
      { id: 'agreementCategory', label: 'Category agreement', value: dq.agreementCategory, n: dq.agreementCategoryN, target: '≥ 85%', note: 'rule category equals the stored category' },
      { id: 'agreementSentiment', label: 'Sentiment-band agreement', value: dq.agreementSentiment, n: dq.agreementSentimentN, target: '≥ 85%', note: 'lexicon label equals the drawn band (English only)' },
      { id: 'needsReviewPct', label: 'Needs review', value: dq.needsReviewPct, n: dq.n, target: 'low', note: 'rule disagrees or confidence < 0.5' },
      { id: 'nonEnglishPct', label: 'Non-English', value: dq.nonEnglishPct, n: dq.n, target: '—', note: 'sentiment stays unscored' },
      { id: 'noiseDropped', label: 'Noise dropped', count: dq.noiseDropped, target: '—', note: 'auto-replies, bounces, newsletters in range' },
      { id: 'duplicatesRemoved', label: 'Duplicates removed', count: dq.duplicatesRemoved, target: '—', note: 'by message id or fingerprint at import' },
      { id: 'ordersCoverageMonths', label: 'Order months available', count: dq.ordersCoverageMonths, target: '12', note: 'per-order rates need every month in range' }
    ];
  }
  function renderAgreement(derived) {
    var sec = section('agreement', 'Agreement and data quality', 'How far the rule classifier and lexicon agree with the seed labels for the records in the current filter scope.');
    S.agreementBody = h('div', {});
    sec.appendChild(S.agreementBody);
    fillAgreement(derived);
    return sec;
  }
  function fillAgreement(derived) {
    var body = S.agreementBody;
    if (!body) return;
    body.innerHTML = '';
    if (!derived || !derived.dq) { emptyInto(body, 'No derived state yet', 'Agreement statistics appear once the store is ready.'); return; }
    var rows = agreementRows(derived);
    body.appendChild(h('p', { class: 'card__subtitle methods-count', text: 'Scope: ' + subtitle(derived) + ' · shares are fractions of the records in scope' }));
    body.appendChild(simpleTable([
      { key: 'label', label: 'Statistic' },
      { key: 'value', label: 'Value', align: 'right', render: function (r) { return '<span class="num strong">' + esc(isNum(r.value) ? fmtPct(r.value, 1) : isNum(r.count) ? fmtInt(r.count) : '—') + '</span>'; } },
      { key: 'n', label: 'n', align: 'right', render: function (r) { return esc(isNum(r.n) ? fmtInt(r.n) : '—'); } },
      { key: 'target', label: 'Target' },
      { key: 'note', label: 'Meaning', wrap: true }
    ], rows));
    if (!isNum(rows[0].value) && !isNum(rows[1].value)) body.appendChild(h('p', { class: 'notice', text: 'No records in scope carry classifier.rule_* fields, so agreement cannot be measured; widen the range or load js/classify.js so reclassify() fills them.' }));
  }

  function renderConfidence() {
    var sec = section('confidence', 'How confidence is assigned', 'Confidence pills are rules of thumb about sample size and backtest error, not probabilities. Every statistic carries its n so you can judge for yourself.');
    var list = h('div', { class: 'methods-confidence' });
    function rule(title, pillsHtml, text) {
      list.appendChild(h('div', { class: 'methods-rule' }, [h('div', { class: 'methods-rule__head' }, [h('span', { class: 'methods-rule__title', text: title }), h('span', { class: 'row' }, pillsHtml)]), h('p', { class: 'methods-rule__text', text: text })]));
    }
    rule('Volume forecast', [pill('confidence', 'high'), pill('confidence', 'medium'), pill('confidence', 'low')], 'High when backtest MAPE < 15% and the 80% band covers 65–95% of test days; medium when MAPE < 30%; low otherwise or when fewer than 35 days allow no backtest.');
    rule('Sentiment smoothing', [pill('confidence', 'high'), pill('confidence', 'medium')], 'High with ≥ 200 scored records over ≥ 28 days; medium with ≥ 60 scored records; low below that.');
    rule('Anomalies', [pill('confidence', 'high'), pill('confidence', 'medium')], 'High with ≥ 56 scored periods, medium with ≥ 21; the first 14 days (4 weeks for weekly series) have no baseline and are never scored.');
    rule('Emerging issues', [pill('confidence', 'high'), pill('confidence', 'medium')], 'High with ≥ 100 baseline and ≥ 20 recent records; medium with ≥ 30 baseline records. Units with fewer than 3 recent mentions are hidden unless they are fading.');
    rule('Cancellation risk', [pill('confidence', 'high'), pill('confidence', 'medium')], 'High only when a logistic model is fitted (≥ 40 labelled customers) and its in-sample AUC ≥ 0.75; medium for a fitted model below that or for the heuristic on ≥ 50 customers; low otherwise. Per customer: medium with ≥ 3 records under the heuristic, high under a fitted model, low with fewer records.');
    rule('Predicted CSAT', [pill('confidence', 'high'), pill('confidence', 'medium'), pill('confidence', 'low')], 'Ridge regression needs ≥ 50 resolved records with a CSAT score; high when r² ≥ 0.3 on ≥ 100 records, otherwise medium. The category-mean fallback is always low.');
    rule('Drivers and what changed', [pill('confidence', 'high'), pill('confidence', 'medium')], 'High with ≥ 200 records, medium with ≥ 60. Driver significance uses a Yates χ² with Benjamini–Hochberg q < 0.05 and at least 10 records per value.');
    rule('Classifier', [pill('confidence', 0.8), pill('confidence', 0.55), pill('confidence', 0.3)], 'Record confidence is top / (top + 2) on the winning category score: ≥ 0.7 high, ≥ 0.5 medium, below that low and flagged for review.');
    sec.appendChild(list);
    sec.appendChild(h('p', { class: 'prose', text: 'Forecast copy always states a range ("about 23, likely 15–31") and never claims what will happen; the narrative linter rejects the word "will" and any percentage without an n.' }));
    return sec;
  }

  /* ------------------------------------------------------------------ mount / update */

  function pendingSection(query) {
    var q = null;
    try { q = VOC.router && VOC.router.parseQuery ? VOC.router.parseQuery(query || '') : null; } catch (e) { q = null; }
    var id = q && q.section ? String(q.section).replace(/^methods-/, '') : null;
    return id && SECTIONS.some(function (s) { return s.id === id; }) ? id : null;
  }

  VOC.views[NAME] = {
    title: TITLE,
    icon: NAME,
    /**
     * @param {HTMLElement} root
     * @param {Object|null} derived  VOC.store.derived()
     */
    mount: function (root, derived) {
      S = { root: root, header: null, backtest: null, backtestKey: null, agreementBody: null, provenance: null };
      root.innerHTML = '';
      var labLink = h('a', { class: 'btn btn--sm btn--ghost', href: '#/predict' }, 'Open Forecast Lab →');
      S.header = ui() && typeof ui().viewHeader === 'function'
        ? ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived), actions: [labLink] })
        : h('header', { class: 'view-header' }, [h('h1', { class: 'view-title', text: TITLE }), h('p', { class: 'view-meta', 'data-role': 'subtitle', text: subtitle(derived) }), h('div', { class: 'view-actions' }, [labLink])]);
      root.appendChild(S.header);
      root.appendChild(renderToc());
      var layout = h('div', { class: 'methods-layout' });
      layout.appendChild(renderRegistry());
      layout.appendChild(renderPipeline());
      layout.appendChild(renderModels());
      layout.appendChild(renderEvents());
      S.provenance = renderProvenance(derived);
      layout.appendChild(S.provenance);
      layout.appendChild(renderAgreement(derived));
      layout.appendChild(renderConfidence());
      root.appendChild(layout);
      var cur = null;
      try { cur = VOC.router && VOC.router.current ? VOC.router.current() : null; } catch (e) { cur = null; }
      var sectionId = pendingSection(cur && cur.query);
      if (sectionId) setTimeout(function () { scrollToSection(sectionId); }, 0);
    },
    /** Called by the shell with the route that mounted or re-entered the view; honors ?section=<id>. */
    onRoute: function (route) {
      var id = pendingSection(route && route.query);
      if (id) setTimeout(function () { scrollToSection(id); }, 0);
    },
    /** @param {Object|null} derived */
    update: function (derived) {
      if (!S || !S.root) return;
      if (S.header && S.header.setMeta) S.header.setMeta(subtitle(derived));
      else { var sub = S.root.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(derived); }
      if (S.header && S.header.setLead) S.header.setLead(leadText(derived));
      fillAgreement(derived);
      var scope = S.provenance && S.provenance.querySelector('.methods-kv dd:last-child');
      if (scope && derived) scope.textContent = subtitle(derived);
    },
    unmount: function () { S = null; }
  };
})();
