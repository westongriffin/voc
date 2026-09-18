/*
 * js/predict.js — VOC.predict (PURE)
 *
 * Forecasting, anomaly and emerging-issue detection, churn and escalation risk,
 * CSAT/NPS regression, driver analysis, what-changed decomposition, SLA breach
 * probability, seasonality, sentiment drift and backtests for the L-Nutra
 * Voice of the Customer site. Implements SPEC §4.7 and §8.
 *
 * Every public function returns an AnalyticResult:
 *   { method, params, n, ...payload, explanation, confidence, caveats, asOf }
 *
 * Runs under JavaScriptCore with no DOM. Uses VOC.util helpers when they are
 * present and private fallbacks otherwise; no other module is required.
 */
(function () {
  'use strict';

  window.VOC = window.VOC || {};
  const VOC = window.VOC;

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const DAY_MS = 86400000;
  const HOUR_MS = 3600000;
  const OPEN_STATUSES = ['new', 'open', 'pending', 'reopened', 'escalated'];
  const COMPLAINT_CATEGORIES = ['subscription_billing', 'checkout_website', 'shipping_fulfillment', 'missing_damaged',
    'taste_quality', 'foreign_material_allergen', 'side_effects', 'adverse_event', 'customer_service', 'price_value'];
  const SLA_DEFAULT = { P0: 1, P1: 4, P2: 24, P3: 72 };
  const URGENCY_INDEX = { P0: 3, P1: 2, P2: 1, P3: 0 };
  const PUBLIC_CHANNELS = ['amazon_review', 'trustpilot_review', 'social'];
  const NEG_THRESHOLD = -0.15;
  const POS_THRESHOLD = 0.15;

  const HW_DEFAULTS = { alpha: 0.3, beta: 0.05, gamma: 0.2, phi: 0.9, horizon: 28, z: [1.28, 1.96], sigmaFloor: 0.5, sigmaWindow: 56 };
  const SENTIMENT_DEFAULTS = { horizon: 14, lambda: 0.15, z: 1.28, shrinkK: 5 };
  const ANOMALY_DEFAULTS = { mode: 'count', window: 28, dowAdjust: true, warn: 2, critical: 3, weeklyWindow: 8, shareShrink: 10, dowShrink: 0.5, dowHistory: 84 };
  const EMERGING_DEFAULTS = { recentDays: 7, baseDays: 28, negativeOnly: false, minRecent: 3, minFading: 5,
    units: ['category', 'subcategory', 'product', 'kit_component', 'lot', 'bigram'] };
  const CHURN_TIERS = [[0, 24, 'low'], [25, 49, 'watch'], [50, 74, 'high'], [75, 100, 'critical']];
  // minAuc gates the fitted churn model on cross-validated (folds) AUC; below it the curated heuristic weights stay in charge.
  // reliabilitySlope is the calibration band (observed-on-predicted slope across deciles) outside which a caveat is added.
  const LOGISTIC_DEFAULTS = { lr: 0.1, epochs: 400, l2: 0.01, minLabelled: 40, minAuc: 0.65, folds: 5, reliabilitySlope: [0.7, 1.3] };
  const CSAT_DEFAULTS = { lambda: 1, minN: 50, z: 1.28, topCategories: 8 };
  const DRIVER_DEFAULTS = { minSupport: 10, alpha: 0.05 };

  /**
   * Heuristic churn features: id, cap, weight, extractor description.
   * x = min(raw, cap) / cap so every feature lives in [0, 1]; logit = -3 + Σ w·x.
   */
  const CHURN_FEATURES = [
    { id: 'neg_msgs_30d', cap: 5, w: 1.6, unit: 'negative message', window: '30 days' },
    { id: 'billing_90d', cap: 3, w: 1.8, unit: 'billing complaint', window: '90 days' },
    { id: 'open_tickets', cap: 3, w: 1.2, unit: 'open ticket', window: null },
    { id: 'oldest_open_days', cap: 14, w: 0.8, unit: 'day', window: null },
    { id: 'days_since_positive', cap: 180, w: 0.9, unit: 'day', window: null },
    { id: 'repeat_30d', cap: 4, w: 1.4, unit: 'repeat contact', window: '30 days' },
    { id: 'max_urgency_30d', cap: 3, w: 0.7, unit: null, window: '30 days' },
    { id: 'cancel_intent_30d', cap: 1, w: 2.2, unit: null, window: '30 days' },
    { id: 'side_effects_90d', cap: 3, w: 0.6, unit: 'side-effect message', window: '90 days' }
  ];
  const CHURN_INTERCEPT = -3;

  const ESCALATION_WEIGHTS = { intercept: -2.5, urgency: 1.2, negative: 1.5, severe: 2.5, strong: 1.2, mild: 0.5,
    age: 1.3, repeat: 1.0, noResponse: 0.8, publicChannel: 0.5 };
  const ESCALATION_KEYWORDS = {
    severe: /\b(lawyer|attorney|legal action|lawsuit|sue|suing|class action|bbb|better business bureau|chargeback|dispute|fda|regulator|press|reporter|news)\b/i,
    strong: /\b(unacceptable|furious|outrage|scam|fraud|never again|worst|disgusting|ripped off|rip-off|demand|appalling|horrible)\b/i,
    mild: /\b(disappointed|disappointing|frustrat\w*|unhappy|annoy\w*|still waiting|no response|third time|again|ignored)\b/i
  };

  const LOCAL_STOPWORDS = ['the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'have', 'was', 'were', 'are', 'but', 'not',
    'from', 'they', 'them', 'been', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'just', 'about', 'what', 'when', 'which',
    'who', 'how', 'all', 'any', 'our', 'out', 'get', 'got', 'its', "it's", "i'm", "don't", "didn't", 'did', 'does', 'into', 'than',
    'then', 'there', 'their', 'here', 'also', 'very', 'please', 'thanks', 'thank', 'hello', 'dear', 'team', 'regards', 'best',
    'still', 'because', 'after', 'before', 'over', 'only', 'some', 'more', 'most', 'other', 'such', 'these', 'those', 'being',
    'one', 'two', 'now', 'like', 'want', 'know', 'need', 'let', 'see', 'per', 'via', 'day', 'days', 'order'];

  /* ------------------------------------------------------------------ */
  /* VOC.util accessors with private fallbacks                          */
  /* ------------------------------------------------------------------ */

  function U() { return VOC.util || {}; }
  function ST() { return (VOC.util && VOC.util.stats) || {}; }

  function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
  function nz(x, fallback) { return isNum(x) ? x : (fallback === undefined ? null : fallback); }

  function sum(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
  function mean(a) {
    if (!a || !a.length) return null;
    const s = ST();
    if (typeof s.mean === 'function') return nz(s.mean(a));
    return sum(a) / a.length;
  }
  function std(a) {
    if (!a || a.length < 2) return 0;
    const s = ST();
    if (typeof s.std === 'function') return nz(s.std(a), 0);
    const m = sum(a) / a.length;
    let ss = 0;
    for (let i = 0; i < a.length; i++) ss += (a[i] - m) * (a[i] - m);
    return Math.sqrt(ss / (a.length - 1));
  }
  function median(a) {
    if (!a || !a.length) return null;
    const s = ST();
    if (typeof s.median === 'function') return nz(s.median(a));
    const b = a.slice().sort((x, y) => x - y);
    const mid = Math.floor(b.length / 2);
    return b.length % 2 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
  }
  function wilson(k, n, z) {
    z = z || 1.96;
    const s = ST();
    if (typeof s.wilson === 'function') return s.wilson(k, n, z);
    if (!n) return { lo: null, hi: null };
    const p = k / n, z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
    return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
  }
  function poissonExact(k, z) {
    z = z || 1.96;
    const s = ST();
    if (typeof s.poissonExact === 'function') return s.poissonExact(k, z);
    // Byar's approximation to the exact (Garwood) Poisson interval.
    const lo = k === 0 ? 0 : k * Math.pow(1 - 1 / (9 * k) - z / (3 * Math.sqrt(k)), 3);
    const kk = k + 1;
    const hi = kk * Math.pow(1 - 1 / (9 * kk) + z / (3 * Math.sqrt(kk)), 3);
    return { lo: Math.max(0, lo), hi };
  }

  let dayFormatter = null;
  function dayKeyLocal(iso) {
    if (!dayFormatter) {
      dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return dayFormatter.format(d);
  }
  function dayKey(iso) {
    const u = U();
    if (typeof u.dayKey === 'function') return u.dayKey(iso);
    return dayKeyLocal(iso);
  }
  function monthKey(iso) {
    const u = U();
    if (typeof u.monthKey === 'function') return u.monthKey(iso);
    const k = dayKeyLocal(iso);
    return k ? k.slice(0, 7) : null;
  }
  function isDayKey(k) { return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k); }
  function isWeekKey(k) { return typeof k === 'string' && /^\d{4}-W\d{2}$/.test(k); }
  function dayToMs(k) { const p = k.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function msToDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(k, n) {
    const u = U();
    if (typeof u.addDays === 'function') return u.addDays(k, n);
    return msToDay(dayToMs(k) + n * DAY_MS);
  }
  function daysBetween(a, b) {
    const u = U();
    if (typeof u.daysBetween === 'function') return u.daysBetween(a, b);
    return Math.round((dayToMs(b) - dayToMs(a)) / DAY_MS);
  }
  /** 0 = Monday … 6 = Sunday for a 'YYYY-MM-DD' key (calendar arithmetic, timezone-free). */
  function dowOfDay(k) { return (new Date(dayToMs(k)).getUTCDay() + 6) % 7; }
  /** ISO week key 'YYYY-Www' for a 'YYYY-MM-DD' key. */
  function weekKeyOfDay(k) {
    const d = new Date(dayToMs(k));
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / DAY_MS - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
  }
  function weekKeyOfRecord(rec) {
    if (rec.week_key) return rec.week_key;
    const u = U();
    if (typeof u.weekKey === 'function') return u.weekKey(rec.received_at);
    const dk = dayKeyOfRecord(rec);
    return dk ? weekKeyOfDay(dk) : null;
  }
  function dayKeyOfRecord(rec) { return rec.day_key || dayKey(rec.received_at); }
  function monthKeyOfRecord(rec) { return rec.month_key || monthKey(rec.received_at); }

  function tokenize(text) {
    const u = U();
    if (typeof u.tokenize === 'function') return u.tokenize(text || '');
    return String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(t => t.length >= 2);
  }
  function stopwordSet() {
    const lex = VOC.lexicon;
    const list = (lex && Array.isArray(lex.STOPWORDS)) ? lex.STOPWORDS : LOCAL_STOPWORDS;
    return new Set(list);
  }

  const LABEL_KINDS = {
    category: ['CATEGORIES', 'category'], subcategory: ['SUBCATEGORIES', 'subcategory'], product: ['PRODUCTS', 'product'],
    kit_component: ['KIT_COMPONENTS', 'kit_component'], channel: ['CHANNELS', 'channel'], segment: ['SEGMENTS', 'segment'],
    sales_channel: ['SALES_CHANNELS', 'sales_channel'], region: ['REGIONS', 'region']
  };
  function titleCase(id) {
    return String(id).split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
  }
  function labelOf(dimension, id) {
    if (id === null || id === undefined) return '—';
    if (id === '__other__') return 'Other';
    const enums = VOC.enums || (VOC.util && VOC.util.enums);
    const kinds = LABEL_KINDS[dimension];
    if (enums && typeof enums.label === 'function' && kinds) {
      for (const kind of kinds) {
        const l = enums.label(kind, id);
        if (l && l !== id) return l;
      }
    }
    if (dimension === 'lot' || dimension === 'bigram') return String(id);
    return titleCase(id);
  }

  function fmtNum(x, digits) {
    if (!isNum(x)) return '—';
    const u = U();
    if (u.fmt && typeof u.fmt.num === 'function') return u.fmt.num(x, digits || 0);
    return x.toFixed(digits || 0);
  }
  function fmtPct(p, digits) {
    if (!isNum(p)) return '—';
    return (p * 100).toFixed(digits || 0) + '%';
  }
  function fmtRange(lo, hi, digits) {
    if (!isNum(lo) || !isNum(hi)) return '—';
    return fmtNum(lo, digits) + '–' + fmtNum(hi, digits);
  }
  function plural(n, unit) {
    const word = unit || 'record';
    return n + ' ' + word + (n === 1 ? '' : 's');
  }
  function toIso(d) { return (d instanceof Date ? d : new Date(d)).toISOString(); }
  function nowOf(opts) {
    const cand = opts && (opts.now || opts.asOf);
    if (cand instanceof Date) return cand;
    if (cand) { const d = new Date(cand); if (!Number.isNaN(d.getTime())) return d; }
    return new Date();
  }
  function round(x, d) {
    if (!isNum(x)) return null;
    const u = U();
    if (typeof u.round === 'function') return u.round(x, d);
    const f = Math.pow(10, d || 0);
    return Math.round(x * f) / f;
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  /** Build the AnalyticResult envelope with safe defaults. */
  function result(base) {
    const r = Object.assign({ method: 'none', params: {}, n: 0, explanation: '', confidence: 'low', caveats: [] }, base);
    r.asOf = r.asOf || toIso(new Date());
    if (!Array.isArray(r.caveats)) r.caveats = [];
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* Record field accessors (derived fields from the store, else local)  */
  /* ------------------------------------------------------------------ */

  function msOf(iso) { const t = new Date(iso).getTime(); return Number.isNaN(t) ? null : t; }
  function isOpen(rec) {
    if (typeof rec.is_open === 'boolean') return rec.is_open;
    return OPEN_STATUSES.indexOf(rec.status) >= 0;
  }
  function ageHours(rec, now) {
    if (isNum(rec.age_hours)) return rec.age_hours;
    const t = msOf(rec.received_at);
    return t === null ? null : Math.max(0, (now.getTime() - t) / HOUR_MS);
  }
  function frtHours(rec) {
    if (rec.frt_hours !== undefined) return isNum(rec.frt_hours) ? rec.frt_hours : null;
    if (!rec.first_response_at) return null;
    const a = msOf(rec.received_at), b = msOf(rec.first_response_at);
    return a === null || b === null ? null : Math.max(0, (b - a) / HOUR_MS);
  }
  function resolutionHours(rec) {
    if (rec.resolution_hours !== undefined) return isNum(rec.resolution_hours) ? rec.resolution_hours : null;
    if (!rec.resolved_at) return null;
    const a = msOf(rec.received_at), b = msOf(rec.resolved_at);
    return a === null || b === null ? null : Math.max(0, (b - a) / HOUR_MS);
  }
  function slaHoursOf(rec, opts) {
    if (opts && isNum(opts.slaHours)) return opts.slaHours;
    if (isNum(rec.sla_frt_hours)) return rec.sla_frt_hours;
    const enums = VOC.enums || (VOC.util && VOC.util.enums);
    const table = (enums && enums.SLA_FRT_HOURS) || SLA_DEFAULT;
    return table[rec.urgency] || SLA_DEFAULT.P2;
  }
  function isNegative(rec) {
    if (rec.sentiment_label) return rec.sentiment_label === 'negative';
    return isNum(rec.sentiment) && rec.sentiment <= NEG_THRESHOLD;
  }
  function isPositive(rec) {
    if (rec.sentiment_label) return rec.sentiment_label === 'positive';
    return isNum(rec.sentiment) && rec.sentiment >= POS_THRESHOLD;
  }
  function isComplaint(rec) {
    if (typeof rec.is_complaint === 'boolean') return rec.is_complaint;
    return (isNum(rec.sentiment) && rec.sentiment < -0.1) || COMPLAINT_CATEGORIES.indexOf(rec.category) >= 0;
  }
  function isDetractor(rec) { return isNum(rec.nps) && rec.nps <= 6; }
  function isPromoter(rec) { return isNum(rec.nps) && rec.nps >= 9; }
  function outcomeFn(kind) {
    if (kind === 'complaint') return isComplaint;
    if (kind === 'detractor') return isDetractor;
    return isNegative;
  }
  function sentimentIndex(rec) {
    if (isNum(rec.sentiment_index)) return rec.sentiment_index;
    return isNum(rec.sentiment) ? (rec.sentiment + 1) / 2 * 100 : null;
  }
  function recordText(rec) { return ((rec.subject || '') + ' ' + (rec.text || '')).trim(); }
  function groupBy(arr, keyFn) {
    const m = new Map();
    for (const item of arr) {
      const k = keyFn(item);
      if (k === null || k === undefined) continue;
      const bucket = m.get(k);
      if (bucket) bucket.push(item); else m.set(k, [item]);
    }
    return m;
  }
  function customersToMap(customers) {
    if (customers instanceof Map) return customers;
    const m = new Map();
    if (Array.isArray(customers)) for (const c of customers) if (c && c.customer_id) m.set(c.customer_id, c);
    else if (customers && typeof customers === 'object') for (const k of Object.keys(customers)) m.set(k, customers[k]);
    return m;
  }
  /** Sorted copy of a {key, value, n?} series. Non-numeric values become 0, or stay null with keepNull (a masked day). */
  function sortSeries(series, keepNull) {
    return (Array.isArray(series) ? series : []).filter(p => p && p.key !== undefined)
      .map(p => ({ key: p.key, value: isNum(p.value) ? p.value : (keepNull ? null : 0), n: isNum(p.n) ? p.n : null }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /* ------------------------------------------------------------------ */
  /* Numerical kernels                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Complementary error function (Numerical Recipes erfcc, fractional error < 1.2e-7).
   * @param {number} x
   * @returns {number}
   */
  function erfc(x) {
    const z = Math.abs(x);
    const t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  /** Standard normal survival function P(Z > z). */
  function normalSurvival(z) { return 0.5 * erfc(z / Math.SQRT2); }
  /**
   * Survival function of the chi-square distribution with 1 degree of freedom.
   * @param {number} x
   * @returns {number} p-value
   */
  function chiSquareSurvival1(x) {
    if (!isNum(x) || x <= 0) return 1;
    return clamp(erfc(Math.sqrt(x / 2)), 0, 1);
  }
  /**
   * Yates-corrected chi-square for a 2×2 table [[a, b], [c, d]].
   * @returns {number}
   */
  function chi2Yates(a, b, c, d) {
    const n = a + b + c + d;
    const r1 = a + b, r2 = c + d, c1 = a + c, c2 = b + d;
    if (!n || !r1 || !r2 || !c1 || !c2) return 0;
    const diff = Math.max(0, Math.abs(a * d - b * c) - n / 2);
    return (n * diff * diff) / (r1 * r2 * c1 * c2);
  }
  /**
   * Benjamini–Hochberg adjusted q-values.
   * @param {number[]} pvalues
   * @returns {number[]} q-values in the original order
   */
  function benjaminiHochberg(pvalues) {
    const m = pvalues.length;
    const order = pvalues.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
    const q = new Array(m);
    let running = 1;
    for (let r = m - 1; r >= 0; r--) {
      const [p, idx] = order[r];
      running = Math.min(running, p * m / (r + 1));
      q[idx] = clamp(running, 0, 1);
    }
    return q;
  }
  /**
   * Solve A·x = b by Gaussian elimination with partial pivoting.
   * @param {number[][]} A square matrix (copied, not mutated)
   * @param {number[]} b
   * @returns {number[]|null} null when the matrix is singular
   */
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.slice().concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      if (Math.abs(M[pivot][col]) < 1e-12) return null;
      if (pivot !== col) { const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp; }
      for (let r = col + 1; r < n; r++) {
        const f = M[r][col] / M[col][col];
        if (f === 0) continue;
        for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }
  /**
   * Ridge regression via normal equations: (XᵀX + λI)β = Xᵀy with an unpenalised intercept.
   * @param {number[][]} X rows of features (no intercept column)
   * @param {number[]} y
   * @param {number} lambda
   * @returns {{beta:number[], intercept:number, fitted:number[], r2:number, sigma:number, n:number}|null}
   */
  function ridgeFit(X, y, lambda) {
    const n = y.length;
    if (!n || !X.length || X.length !== n) return null;
    const p = X[0].length + 1;
    const G = Array.from({ length: p }, () => new Array(p).fill(0));
    const v = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const row = [1].concat(X[i]);
      for (let a = 0; a < p; a++) {
        v[a] += row[a] * y[i];
        for (let b = 0; b < p; b++) G[a][b] += row[a] * row[b];
      }
    }
    for (let a = 1; a < p; a++) G[a][a] += lambda || 0;
    const beta = solveLinear(G, v);
    if (!beta) return null;
    const fitted = X.map(row => beta[0] + row.reduce((s, x, j) => s + x * beta[j + 1], 0));
    const yMean = mean(y);
    let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) { sse += (y[i] - fitted[i]) ** 2; sst += (y[i] - yMean) ** 2; }
    return { beta: beta.slice(1), intercept: beta[0], fitted, r2: sst > 0 ? clamp(1 - sse / sst, 0, 1) : 0,
      sigma: Math.sqrt(sse / Math.max(1, n - p)), n };
  }
  /**
   * Logistic regression by batch gradient descent on standardised features (L2 on slopes only).
   * @param {number[][]} X raw feature rows
   * @param {number[]} y labels in [0, 1] (0.5 allowed)
   * @param {{lr?:number, epochs?:number, l2?:number}} [opts]
   * @returns {{beta:number[], intercept:number, mu:number[], sd:number[], predict:function(number[]):number, n:number}|null}
   */
  function fitLogistic(X, y, opts) {
    const o = Object.assign({}, LOGISTIC_DEFAULTS, opts || {});
    const n = y.length;
    if (!n || X.length !== n) return null;
    const p = X[0].length;
    const mu = new Array(p).fill(0), sd = new Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      const col = X.map(r => r[j]);
      mu[j] = mean(col);
      const s = std(col);
      sd[j] = s > 1e-9 ? s : 1;
    }
    const Z = X.map(r => r.map((x, j) => (x - mu[j]) / sd[j]));
    const beta = new Array(p).fill(0);
    let b0 = 0;
    for (let e = 0; e < o.epochs; e++) {
      const g = new Array(p).fill(0);
      let g0 = 0;
      for (let i = 0; i < n; i++) {
        let z = b0;
        for (let j = 0; j < p; j++) z += beta[j] * Z[i][j];
        const err = sigmoid(z) - y[i];
        g0 += err;
        for (let j = 0; j < p; j++) g[j] += err * Z[i][j];
      }
      b0 -= o.lr * g0 / n;
      for (let j = 0; j < p; j++) beta[j] -= o.lr * (g[j] / n + o.l2 * beta[j]);
    }
    return { beta, intercept: b0, mu, sd, n,
      predict(x) { let z = b0; for (let j = 0; j < p; j++) z += beta[j] * ((x[j] - mu[j]) / sd[j]); return sigmoid(z); },
      contributions(x) { return x.map((v, j) => beta[j] * ((v - mu[j]) / sd[j])); } };
  }
  /**
   * Rank-based AUC (Mann–Whitney with tie handling).
   * @param {number[]} scores
   * @param {number[]} labels 1 = positive, 0 = negative
   * @returns {number|null}
   */
  function auc(scores, labels) {
    const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
    const ranks = new Array(scores.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[idx[k]] = r;
      i = j + 1;
    }
    let nPos = 0, nNeg = 0, rankSum = 0;
    for (let k = 0; k < labels.length; k++) {
      if (labels[k] >= 1) { nPos++; rankSum += ranks[k]; } else nNeg++;
    }
    if (!nPos || !nNeg) return null;
    return (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg);
  }
  function olsLine(values) {
    const n = values.length;
    if (n < 2) return { slope: 0, intercept: n ? values[0] : 0, r2: 0 };
    const xm = (n - 1) / 2, ym = mean(values);
    let sxy = 0, sxx = 0, sst = 0;
    for (let t = 0; t < n; t++) { sxy += (t - xm) * (values[t] - ym); sxx += (t - xm) ** 2; sst += (values[t] - ym) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    const intercept = ym - slope * xm;
    let sse = 0;
    for (let t = 0; t < n; t++) sse += (values[t] - (intercept + slope * t)) ** 2;
    return { slope, intercept, r2: sst > 0 ? clamp(1 - sse / sst, 0, 1) : 0 };
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 forecastVolume — Holt-Winters with fallbacks                   */
  /* ------------------------------------------------------------------ */

  function chooseMethod(n) {
    if (n >= 56) return 'holt_winters';
    if (n >= 28) return 'holt_linear';
    if (n >= 7) return 'ols';
    return 'mean';
  }
  function residualSigma(residuals, params) {
    const tail = residuals.slice(-params.sigmaWindow);
    if (!tail.length) return params.sigmaFloor;
    let ss = 0;
    for (const r of tail) ss += r * r;
    return Math.max(params.sigmaFloor, Math.sqrt(ss / tail.length));
  }
  function seasonIndex(keys, t) {
    return isDayKey(keys[t]) ? dowOfDay(keys[t]) : t % 7;
  }
  function seasonIndexAhead(keys, n, h) {
    const last = keys[n - 1];
    return isDayKey(last) ? dowOfDay(addDays(last, h)) : (n - 1 + h) % 7;
  }
  function dampedSum(phi, h) {
    let s = 0, p = 1;
    for (let i = 1; i <= h; i++) { p *= phi; s += p; }
    return s;
  }
  /** Fit Holt-Winters additive (m = 7, damped trend); returns states, fitted and point forecasts. */
  function fitHoltWinters(values, keys, params, horizon) {
    const { alpha, beta, gamma, phi } = params;
    const n = values.length;
    const m1 = mean(values.slice(0, 7)), m2 = mean(values.slice(7, 14));
    let L = m1, B = (m2 - m1) / 7;
    const S = new Array(7).fill(0);
    for (let i = 0; i < 7; i++) S[seasonIndex(keys, i)] = ((values[i] - m1) + (values[i + 7] - m2)) / 2;
    const fitted = new Array(n);
    for (let t = 0; t < n; t++) {
      const si = seasonIndex(keys, t);
      const f = L + phi * B + S[si];
      fitted[t] = f;
      const Lprev = L;
      L = alpha * (values[t] - S[si]) + (1 - alpha) * (Lprev + phi * B);
      B = beta * (L - Lprev) + (1 - beta) * phi * B;
      S[si] = gamma * (values[t] - L) + (1 - gamma) * S[si];
    }
    const point = [];
    for (let h = 1; h <= horizon; h++) point.push(L + dampedSum(phi, h) * B + S[seasonIndexAhead(keys, n, h)]);
    return { fitted, point, states: { level: L, trend: B, seasonal: S.slice() } };
  }
  function fitHoltLinear(values, params, horizon) {
    const { alpha, beta, phi } = params;
    const n = values.length;
    let L = values[0];
    const k = Math.min(7, n - 1);
    let B = k > 0 ? (values[k] - values[0]) / k : 0;
    const fitted = new Array(n);
    for (let t = 0; t < n; t++) {
      fitted[t] = L + phi * B;
      const Lprev = L;
      L = alpha * values[t] + (1 - alpha) * (Lprev + phi * B);
      B = beta * (L - Lprev) + (1 - beta) * phi * B;
    }
    const point = [];
    for (let h = 1; h <= horizon; h++) point.push(L + dampedSum(phi, h) * B);
    return { fitted, point, states: { level: L, trend: B } };
  }
  function fitOls(values, horizon) {
    const n = values.length;
    const line = olsLine(values);
    const fitted = values.map((v, t) => line.intercept + line.slope * t);
    const point = [];
    for (let h = 1; h <= horizon; h++) point.push(line.intercept + line.slope * (n - 1 + h));
    return { fitted, point, states: { slope: line.slope, intercept: line.intercept } };
  }
  function fitMean(values, horizon) {
    const m = values.length ? mean(values) : 0;
    return { fitted: values.map(() => m), point: new Array(horizon).fill(m), states: { mean: m } };
  }
  /**
   * Fit one series with the method chosen for its length and produce point forecasts plus intervals.
   * @returns {{method, fitted, forecast:[{value, lo80, hi80, lo95, hi95, h}], sigma, states}}
   */
  function fitSeries(values, keys, params, horizon, forceMethod) {
    const n = values.length;
    const method = forceMethod || chooseMethod(n);
    let fit;
    if (method === 'holt_winters' && n >= 14) fit = fitHoltWinters(values, keys, params, horizon);
    else if ((method === 'holt_linear' || method === 'holt_winters') && n >= 2) fit = fitHoltLinear(values, params, horizon);
    else if (method === 'ols' && n >= 2) fit = fitOls(values, horizon);
    else fit = fitMean(values, horizon);
    const residuals = values.map((v, t) => v - fit.fitted[t]);
    const sigma = residualSigma(residuals.slice(method === 'holt_winters' ? 14 : 0), params);
    const z80 = params.z[0], z95 = params.z[1];
    const forecast = fit.point.map((f, i) => {
      const h = i + 1, w = sigma * Math.sqrt(h);
      const value = Math.max(0, f);
      return { h, value, lo80: Math.max(0, f - z80 * w), hi80: Math.max(0, f + z80 * w), lo95: Math.max(0, f - z95 * w), hi95: Math.max(0, f + z95 * w) };
    });
    return { method, fitted: fit.fitted, forecast, sigma, states: fit.states };
  }
  function autoTune(values, keys, params) {
    const grid = { alpha: [0.1, 0.2, 0.3, 0.4, 0.5], beta: [0.01, 0.05, 0.1], gamma: [0.1, 0.2, 0.3] };
    let best = null;
    for (const alpha of grid.alpha) for (const beta of grid.beta) for (const gamma of grid.gamma) {
      const p = Object.assign({}, params, { alpha, beta, gamma });
      const fit = fitHoltWinters(values, keys, p, 1);
      let sse = 0;
      for (let t = 14; t < values.length; t++) sse += (values[t] - fit.fitted[t]) ** 2;
      if (!best || sse < best.sse) best = { sse, alpha, beta, gamma };
    }
    return best ? { alpha: best.alpha, beta: best.beta, gamma: best.gamma } : {};
  }
  /**
   * Confidence from the rolling-origin backtest. Daily MAPE on a series of ~3 contacts/day is 60–70% even when the
   * band is well calibrated, so the rule reads MASE (< 1 beats the seasonal naive), 80% coverage in 65–95% and
   * MAPE on WEEKLY block sums (bt.weeklyMape): high when MASE < 0.9 ∧ coverage in band ∧ weeklyMape < 15%;
   * medium when MASE < 1.1 ∨ weeklyMape < 30%; else low. Daily MAPE stays in the backtest object for reference.
   * @param {{folds?:Array, mase?:number, coverage80?:number, weeklyMape?:number, mape?:number}} bt
   * @returns {'high'|'medium'|'low'}
   */
  function forecastConfidence(bt) {
    if (!bt || !Array.isArray(bt.folds) || !bt.folds.length) return 'low';
    const mase = bt.mase, cov = bt.coverage80, wm = bt.weeklyMape;
    const covOk = isNum(cov) && cov >= 0.65 && cov <= 0.95;
    if (isNum(mase) && mase < 0.9 && covOk && isNum(wm) && wm < 0.15) return 'high';
    if ((isNum(mase) && mase < 1.1) || (isNum(wm) && wm < 0.30)) return 'medium';
    return 'low';
  }
  const METHOD_LABELS = { holt_winters: 'Holt-Winters (weekly seasonality, damped trend)', holt_linear: 'Holt linear trend',
    ols: 'linear trend', mean: 'flat mean' };

  /**
   * Forecast a daily count series.
   * @param {Array<{key:string, value:number}>} dailySeries
   * @param {{horizon?:number, z?:number[], autoTune?:boolean, params?:object, now?:Date|string}} [opts]
   * @returns {object} AnalyticResult with history, forecast, weekly, backtest
   */
  function forecastVolume(dailySeries, opts) {
    const o = opts || {};
    const series = sortSeries(dailySeries);
    const n = series.length;
    const params = Object.assign({}, HW_DEFAULTS, o.params || {});
    if (isNum(o.horizon)) params.horizon = o.horizon;
    if (Array.isArray(o.z) && o.z.length === 2) params.z = o.z.slice();
    const asOf = toIso(nowOf(o));
    const keys = series.map(p => p.key), values = series.map(p => p.value);
    if (!n) {
      return result({ method: 'mean', params, n: 0, history: [], forecast: [], weekly: [], backtest: emptyBacktest(),
        explanation: 'No daily history is available yet (n=0), so there is nothing to project.', confidence: 'low',
        caveats: ['Add at least 7 days of records to see a projection.'], asOf });
    }
    let method = chooseMethod(n);
    params.tuned = false;
    if (o.autoTune && method === 'holt_winters') { Object.assign(params, autoTune(values, keys, params)); params.tuned = true; }
    const fit = fitSeries(values, keys, params, params.horizon, method);
    method = fit.method;
    const lastKey = keys[n - 1];
    const history = series.map((p, t) => ({ key: p.key, value: p.value, fitted: round(fit.fitted[t], 3) }));
    const forecast = fit.forecast.map(f => ({ key: isDayKey(lastKey) ? addDays(lastKey, f.h) : String(n - 1 + f.h),
      value: round(f.value, 3), lo80: round(f.lo80, 3), hi80: round(f.hi80, 3), lo95: round(f.lo95, 3), hi95: round(f.hi95, 3) }));
    const weekly = weeklyBlocks(fit.forecast, forecast.map(f => f.key), fit.sigma, params.z[0]);
    // Each fold refits with the SAME method the result reports (n ≥ 56 folds would otherwise drift to Holt/OLS as the
    // training window shrinks) and, when autoTune is on, re-tunes α/β/γ on the fold's training days only, so the
    // MASE/coverage behind `confidence` never see the held-out weeks.
    const bt = backtest((train, horizon) => {
      const vals = train.map(p => p.value), ks = train.map(p => p.key);
      const foldParams = Object.assign({}, params);
      if (o.autoTune && method === 'holt_winters' && vals.length >= 14) Object.assign(foldParams, autoTune(vals, ks, foldParams));
      return fitSeries(vals, ks, foldParams, horizon, method);
    }, series, { folds: 4, horizon: 7 });
    params.backtestMethod = method;
    params.backtestTuning = o.autoTune && method === 'holt_winters' ? 'per fold on training days' : 'none';
    params.sigma = round(fit.sigma, 4);
    const next7 = fit.forecast.slice(0, 7);
    const sum7 = sum(next7.map(f => f.value));
    const w7 = params.z[0] * fit.sigma * Math.sqrt(sum(next7.map(f => f.h)));
    const caveats = [];
    const foldsN = bt.folds.length;
    const daysScored = sum(bt.folds.map(f => f.n || 0));
    const foldNote = 'n=' + foldsN + ' folds, ' + daysScored + ' days scored';
    if (method !== 'holt_winters') caveats.push('Fewer than 8 weeks of history: the weekly pattern is not modelled yet (' + METHOD_LABELS[method] + ').');
    if (!foldsN) caveats.push('Too little history for a rolling-origin backtest; the band is untested.');
    if (foldsN && isNum(bt.coverage80) && (bt.coverage80 < 0.65 || bt.coverage80 > 0.95)) caveats.push('Backtest coverage of the 80% band is ' + fmtPct(bt.coverage80) + ' (' + foldNote + '), so the band width is off; read it as indicative.');
    if (foldsN && isNum(bt.mase) && bt.mase >= 1.1) caveats.push('The model does not beat a seasonal-naive forecast (MASE ' + fmtNum(bt.mase, 2) + ', ' + foldNote + '); read the level, not the shape.');
    else if (foldsN && isNum(bt.weeklyMape) && bt.weeklyMape >= 0.30) caveats.push('Weekly-block error is ' + fmtPct(bt.weeklyMape) + ' (' + foldNote + '), so weekly totals are rough.');
    const explanation = METHOD_LABELS[method].replace(/^./, c => c.toUpperCase()) + ' projects about ' + fmtNum(sum7) +
      ' contacts over the next ' + next7.length + ' days, likely ' + fmtRange(Math.max(0, sum7 - w7), sum7 + w7) +
      ' (80% band), from n=' + n + ' days of history' +
      (foldsN ? '; backtest MASE ' + fmtNum(bt.mase, 2) + ' vs the seasonal naive, weekly-block MAPE ' + fmtPct(bt.weeklyMape) + ' (daily ' + fmtPct(bt.mape) + ') and ' +
        fmtPct(bt.coverage80) + ' coverage of the 80% band over ' + foldNote + '.' : '.');
    return result({ method, params, n, history, forecast, weekly, backtest: bt, states: fit.states, explanation,
      confidence: forecastConfidence(bt), caveats, asOf });
  }
  function weeklyBlocks(fc, keys, sigma, z) {
    const blocks = new Map();
    fc.forEach((f, i) => {
      const wk = isDayKey(keys[i]) ? weekKeyOfDay(keys[i]) : 'block-' + Math.floor(i / 7);
      const b = blocks.get(wk) || { weekKey: wk, value: 0, hSum: 0, days: 0 };
      b.value += f.value; b.hSum += f.h; b.days += 1;
      blocks.set(wk, b);
    });
    return Array.from(blocks.values()).map(b => {
      const w = z * sigma * Math.sqrt(b.hSum);
      return { weekKey: b.weekKey, days: b.days, value: round(b.value, 2), lo80: round(Math.max(0, b.value - w), 2), hi80: round(b.value + w, 2) };
    });
  }
  function emptyBacktest() { return { folds: [], mae: null, mape: null, mase: null, coverage80: null, weeklyMape: null }; }

  /**
   * Rolling-origin backtest. fitFn(trainSeries, horizon) returns {forecast:[{value, lo80, hi80}]} or an array of such points.
   * weeklyMape is MAPE on 7-day block sums (|Σy − ΣF| / max(Σy, 1) per block), which is the error a weekly total carries;
   * mape stays the daily figure.
   * @param {function} fitFn
   * @param {Array<{key, value}>} series
   * @param {{folds?:number, horizon?:number}} [opts]
   * @returns {{folds:Array<{trainEnd, n, mae, mape, weeklyMape, coverage80}>, mae, mape, mase, coverage80, weeklyMape}}
   */
  function backtest(fitFn, series, opts) {
    const o = Object.assign({ folds: 4, horizon: 7 }, opts || {});
    const s = sortSeries(series);
    const n = s.length;
    const out = emptyBacktest();
    const minTrain = 7;
    if (n < minTrain + o.folds * o.horizon) return out;
    let absErr = 0, pctErr = 0, covered = 0, count = 0, naiveErr = 0, naiveCount = 0, blockPct = 0, blocks = 0;
    for (let k = 0; k < o.folds; k++) {
      const trainEnd = n - o.horizon * (o.folds - k);
      const train = s.slice(0, trainEnd);
      const test = s.slice(trainEnd, trainEnd + o.horizon);
      const fitted = fitFn(train, o.horizon);
      const fc = Array.isArray(fitted) ? fitted : (fitted && fitted.forecast) || [];
      let fAbs = 0, fPct = 0, fCov = 0, fCount = 0, fBlockPct = 0, fBlocks = 0, bY = 0, bF = 0;
      for (let i = 0; i < test.length && i < fc.length; i++) {
        const y = test[i].value, f = nz(fc[i].value, 0);
        const e = Math.abs(y - f);
        fAbs += e; fPct += e / Math.max(y, 1);
        if (isNum(fc[i].lo80) && isNum(fc[i].hi80) && y >= fc[i].lo80 - 1e-9 && y <= fc[i].hi80 + 1e-9) fCov++;
        fCount++;
        bY += y; bF += f;
        if (fCount % 7 === 0 || i === Math.min(test.length, fc.length) - 1) { fBlockPct += Math.abs(bY - bF) / Math.max(bY, 1); fBlocks++; bY = 0; bF = 0; }
        const t = trainEnd + i;
        if (t - 7 >= 0) { naiveErr += Math.abs(y - s[t - 7].value); naiveCount++; }
      }
      if (!fCount) continue;
      out.folds.push({ trainEnd: s[trainEnd - 1].key, n: fCount, mae: round(fAbs / fCount, 4), mape: round(fPct / fCount, 4),
        weeklyMape: fBlocks ? round(fBlockPct / fBlocks, 4) : null, coverage80: round(fCov / fCount, 4) });
      absErr += fAbs; pctErr += fPct; covered += fCov; count += fCount; blockPct += fBlockPct; blocks += fBlocks;
    }
    if (!count) return out;
    out.mae = round(absErr / count, 4);
    out.mape = round(pctErr / count, 4);
    out.coverage80 = round(covered / count, 4);
    out.weeklyMape = blocks ? round(blockPct / blocks, 4) : null;
    const naiveMae = naiveCount ? naiveErr / naiveCount : 0;
    out.mase = naiveMae > 0 ? round((absErr / count) / naiveMae, 4) : null;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 forecastSentiment — EWMA with variance band and shrinkage      */
  /* ------------------------------------------------------------------ */

  /**
   * Smooth a daily sentiment-index series (0–100) with an EWMA whose daily weight shrinks with small n.
   * @param {Array<{key:string, value:number, n?:number}>} dailySeries
   * @param {{horizon?:number, lambda?:number, z?:number, now?:Date|string}} [opts]
   */
  function forecastSentiment(dailySeries, opts) {
    const o = opts || {};
    const params = Object.assign({}, SENTIMENT_DEFAULTS);
    if (isNum(o.horizon)) params.horizon = o.horizon;
    if (isNum(o.lambda)) params.lambda = o.lambda;
    if (isNum(o.z)) params.z = o.z;
    const asOf = toIso(nowOf(o));
    const raw = (Array.isArray(dailySeries) ? dailySeries : []).filter(p => p && p.key !== undefined)
      .map(p => ({ key: p.key, value: isNum(p.value) ? p.value : null, n: isNum(p.n) ? p.n : (isNum(p.value) ? 1 : 0) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const scored = raw.filter(p => p.value !== null && p.n > 0);
    const totalN = sum(scored.map(p => p.n));
    if (!scored.length) {
      return result({ method: 'ewma', params, n: 0, history: [], forecast: [],
        explanation: 'No scored sentiment days yet (n=0), so there is no trend to smooth.', confidence: 'low',
        caveats: ['Sentiment needs English-language records scored by the lexicon.'], asOf });
    }
    // Anchor the level and variance on the first min(7, k) scored days (n-weighted mean and n-weighted sample variance)
    // instead of the first day alone: a single n=1 day would otherwise set the level with weight 1 and start the band at
    // zero width, and the recursion would need ~1/λ days to recover. Every update, including the first, then applies
    // the n/(n+K) shrink the docstring promises.
    const anchor = scored.slice(0, Math.min(7, scored.length));
    const anchorN = sum(anchor.map(p => p.n));
    let s = anchorN > 0 ? sum(anchor.map(p => p.n * p.value)) / anchorN : scored[0].value;
    let v = anchorN > 0 ? sum(anchor.map(p => p.n * (p.value - s) ** 2)) / anchorN : 0;
    params.anchorDays = anchor.length;
    const history = raw.map(p => {
      if (p.value === null || p.n <= 0) {
        return { key: p.key, value: null, n: p.n, smoothed: round(s, 2), lo: round(clamp(s - params.z * Math.sqrt(v), 0, 100), 2), hi: round(clamp(s + params.z * Math.sqrt(v), 0, 100), 2) };
      }
      const lam = params.lambda * (p.n / (p.n + params.shrinkK));
      const resid = p.value - s;
      v = params.lambda * resid * resid + (1 - params.lambda) * v;
      s = s + lam * resid;
      const w = params.z * Math.sqrt(v);
      return { key: p.key, value: round(p.value, 2), n: p.n, smoothed: round(s, 2), lo: round(clamp(s - w, 0, 100), 2), hi: round(clamp(s + w, 0, 100), 2) };
    });
    const lastKey = raw[raw.length - 1].key;
    const forecast = [];
    for (let h = 1; h <= params.horizon; h++) {
      const w = params.z * Math.sqrt(v) * Math.sqrt(1 + (h - 1) * params.lambda);
      forecast.push({ key: isDayKey(lastKey) ? addDays(lastKey, h) : String(h), value: round(s, 2), lo: round(clamp(s - w, 0, 100), 2), hi: round(clamp(s + w, 0, 100), 2) });
    }
    const last = forecast[forecast.length - 1];
    const confidence = totalN >= 200 && scored.length >= 28 ? 'high' : totalN >= 60 ? 'medium' : 'low';
    const caveats = [];
    if (scored.length < 14) caveats.push('Fewer than 14 scored days; the smoothed level moves a lot with each new record.');
    const explanation = 'The smoothed sentiment index sits at ' + fmtNum(s, 1) + ' points and stays near ' + fmtRange(last.lo, last.hi, 0) +
      ' over the next ' + params.horizon + ' days if nothing changes (n=' + totalN + ' scored records over ' + scored.length + ' days).';
    return result({ method: 'ewma', params, n: totalN, history, forecast, explanation, confidence, caveats, asOf });
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 detectAnomalies — rolling z with DOW adjustment                */
  /* ------------------------------------------------------------------ */

  /**
   * Score a daily (or weekly) series for spikes and dips against a trailing window that excludes the scored day.
   * A point whose value is null (or, in share mode, whose n is 0) is masked: it is neither scored nor part of any
   * window or weekday history, so a day with no scored records never enters the baseline as a 0% share.
   * @param {Array<{key:string, value:number|null, n?:number}>} series
   * @param {{mode?:'count'|'share', window?:number, dowAdjust?:boolean, warn?:number, critical?:number, metric?:string, now?:Date|string}} [opts]
   */
  function detectAnomalies(series, opts) {
    const o = Object.assign({}, ANOMALY_DEFAULTS, opts || {});
    const s = sortSeries(series, true).map(p => (o.mode === 'share' && p.n === 0 ? Object.assign(p, { value: null }) : p));
    const observed = p => isNum(p.value);
    const n = s.length;
    const weekly = n > 0 && isWeekKey(s[0].key);
    const window = weekly ? (opts && isNum(opts.window) ? opts.window : o.weeklyWindow) : o.window;
    const dowAdjust = weekly ? false : o.dowAdjust;
    const floor = o.mode === 'share' ? 0.03 : 1.0;
    const params = { mode: o.mode, window, dowAdjust, warn: o.warn, critical: o.critical, floor, granularity: weekly ? 'week' : 'day',
      sigmaRule: o.mode === 'count' ? 'max(residual sd, sqrt(expected), 1.0)' : 'max(residual sd, 0.03)', dowClamp: [0.3, 2.5], dowHistory: o.dowHistory };
    const asOf = toIso(nowOf(o));
    const metric = o.metric || (o.mode === 'share' ? 'share' : 'volume');
    const points = [];
    const minWindow = weekly ? 4 : (dowAdjust ? 14 : 7);
    for (let t = 0; t < n; t++) {
      const start = Math.max(0, t - window);
      const win = s.slice(start, t).filter(observed);
      const point = { key: s[t].key, value: observed(s[t]) ? round(s[t].value, 4) : null, expected: null, lo: null, hi: null, z: null };
      if (observed(s[t]) && win.length >= minWindow) {
        const winVals = win.map(p => p.value);
        const mu = mean(winVals);
        let factor = 1;
        let sigma;
        if (dowAdjust && isDayKey(s[t].key)) {
          // Weekday factors from up to `dowHistory` trailing days (more stable than 4 samples per weekday); level from the window.
          const hist = s.slice(Math.max(0, t - o.dowHistory), t).filter(observed);
          const histMu = mean(hist.map(p => p.value));
          const byDow = new Array(7).fill(0), cnt = new Array(7).fill(0);
          for (const p of hist) { const d = dowOfDay(p.key); byDow[d] += p.value; cnt[d]++; }
          const factors = byDow.map((tot, d) => histMu > 0 ? clamp((tot + o.dowShrink * histMu) / ((cnt[d] + o.dowShrink) * histMu), 0.3, 2.5) : 1);
          const winFactorMean = mean(win.map(p => factors[dowOfDay(p.key)])) || 1;
          factor = factors[dowOfDay(s[t].key)] / winFactorMean;
          const resid = win.map(p => p.value - mu * factors[dowOfDay(p.key)] / winFactorMean);
          sigma = Math.sqrt(sum(resid.map(r => r * r)) / Math.max(1, resid.length - 1));
        } else {
          sigma = std(winVals);
        }
        const expected = mu * factor;
        // Counts carry Poisson noise at least: σ ≥ √μ (this is the x > μ + 3√μ rule when μ is small).
        if (o.mode === 'count') sigma = Math.max(sigma, Math.sqrt(Math.max(expected, 0)));
        sigma = Math.max(sigma, floor);
        let value = s[t].value;
        if (o.mode === 'share' && isNum(s[t].n) && s[t].n >= 0) value = (s[t].n * value + o.shareShrink * expected) / (s[t].n + o.shareShrink);
        point.expected = round(expected, 4);
        point.lo = round(Math.max(0, expected - o.warn * sigma), 4);
        point.hi = round(expected + o.warn * sigma, 4);
        point.z = round((value - expected) / sigma, 3);
      }
      points.push(point);
    }
    const events = [];
    let cur = null;
    for (const p of points) {
      const flagged = isNum(p.z) && Math.abs(p.z) >= o.warn;
      if (flagged && cur && Math.sign(p.z) === cur.sign) {
        cur.end = p.key;
        cur.days += 1;
        if (Math.abs(p.z) > Math.abs(cur.z)) { cur.z = p.z; cur.value = p.value; cur.expected = p.expected; cur.peak = p.key; }
      } else if (flagged) {
        cur = { start: p.key, end: p.key, peak: p.key, metric, value: p.value, expected: p.expected, z: p.z, sign: Math.sign(p.z), days: 1 };
        events.push(cur);
      } else {
        cur = null;
      }
    }
    for (const e of events) {
      e.severity = Math.abs(e.z) >= o.critical ? 'critical' : 'warning';
      e.direction = e.sign > 0 ? 'up' : 'down';
      delete e.sign;
    }
    const scored = points.filter(p => isNum(p.z)).length;
    const unit = weekly ? 'week' : 'day';
    let explanation;
    if (!n) explanation = 'No ' + unit + 's to score (n=0).';
    else if (!scored) explanation = 'Fewer than ' + minWindow + ' ' + unit + 's of history, so no baseline exists yet (n=' + n + ' ' + unit + 's).';
    else if (!events.length) explanation = 'No ' + unit + ' departs from its baseline by ' + o.warn + ' standard deviations or more (n=' + scored + ' scored ' + unit + 's).';
    else {
      const top = events.slice().sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0];
      explanation = events.length + ' anomalous ' + (events.length === 1 ? 'period' : 'periods') + ' across n=' + scored + ' scored ' + unit + 's; the largest is ' +
        top.peak + ' at ' + fmtNum(top.value, o.mode === 'share' ? 2 : 0) + ' against an expected ' + fmtNum(top.expected, o.mode === 'share' ? 2 : 1) +
        ' (z ' + fmtNum(top.z, 1) + ', ' + top.severity + ').';
    }
    const confidence = scored >= 56 ? 'high' : scored >= 21 ? 'medium' : 'low';
    const caveats = [];
    if (o.mode === 'share') caveats.push('Shares on low-volume ' + unit + 's shrink toward the baseline before scoring.');
    if (dowAdjust) caveats.push('Weekday factors come from up to ' + o.dowHistory + ' trailing days and are clamped to 0.3–2.5.');
    return result({ method: 'rolling_z', params, n, events, points, explanation, confidence, caveats, asOf });
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 detectEmerging — recent vs baseline by unit                    */
  /* ------------------------------------------------------------------ */

  function bigramSetsLocal(records) {
    const stop = stopwordSet();
    const sets = new Map();
    for (const rec of records) {
      const toks = tokenize(recordText(rec)).filter(t => !stop.has(t) && !/^\d+$/.test(t));
      const grams = new Set();
      for (let i = 0; i + 1 < toks.length; i++) grams.add(toks[i] + ' ' + toks[i + 1]);
      sets.set(rec.id, grams);
    }
    return sets;
  }
  function bigramCounts(recent, base) {
    const A = VOC.analytics;
    const out = new Map();
    if (A && typeof A.ngrams === 'function') {
      const rec = A.ngrams(recent, { n: [2], minDf: 2, top: 200 }) || [];
      const baseRows = A.ngrams(base, { n: [2], minDf: 1, top: 5000 }) || [];
      const baseDf = new Map(baseRows.map(r => [r.gram, r.df]));
      for (const r of rec) out.set(r.gram, { cR: r.df, cB: baseDf.get(r.gram) || 0, sampleIds: (r.sampleIds || []).slice(0, 5) });
      return out;
    }
    const recentSets = bigramSetsLocal(recent), baseSets = bigramSetsLocal(base);
    const recentCount = new Map(), samples = new Map();
    for (const [id, grams] of recentSets) for (const g of grams) {
      recentCount.set(g, (recentCount.get(g) || 0) + 1);
      const s = samples.get(g) || []; if (s.length < 5) s.push(id); samples.set(g, s);
    }
    const baseCount = new Map();
    for (const grams of baseSets.values()) for (const g of grams) baseCount.set(g, (baseCount.get(g) || 0) + 1);
    for (const [g, cR] of recentCount) if (cR >= 2) out.set(g, { cR, cB: baseCount.get(g) || 0, sampleIds: samples.get(g) || [] });
    return out;
  }
  const UNIT_FIELD = { category: r => r.category, subcategory: r => (r.subcategory ? r.category + '/' + r.subcategory : null),
    product: r => r.product, kit_component: r => r.kit_component, lot: r => r.lot_number };
  const DENSE_UNITS = ['category', 'product'];

  /**
   * Compare the last `recentDays` against the prior `baseDays` for every unit and flag new, emerging and fading ones.
   * @param {object[]} records
   * @param {{recentDays?:number, baseDays?:number, asOf?:Date|string, now?:Date|string, negativeOnly?:boolean, units?:string[], minRecent?:number}} [opts]
   */
  function detectEmerging(records, opts) {
    const o = Object.assign({}, EMERGING_DEFAULTS, opts || {});
    const asOfDate = nowOf(o);
    const asOfDay = dayKey(asOfDate.toISOString());
    const recentStart = addDays(asOfDay, -(o.recentDays - 1));
    const baseStart = addDays(recentStart, -o.baseDays);
    const params = { recentDays: o.recentDays, baseDays: o.baseDays, negativeOnly: o.negativeOnly, units: o.units.slice(), minRecent: o.minRecent,
      recentFrom: recentStart, recentTo: asOfDay, baseFrom: baseStart, baseTo: addDays(recentStart, -1), expectedRule: 'E = cB · NR / NB (day ratio when NB = 0)' };
    const recs = (Array.isArray(records) ? records : []).filter(r => r && !r.is_noise && (!o.negativeOnly || isNegative(r) || isComplaint(r)));
    const recent = [], base = [];
    for (const r of recs) {
      const dk = dayKeyOfRecord(r);
      if (!dk) continue;
      if (dk >= recentStart && dk <= asOfDay) recent.push(r);
      else if (dk >= baseStart && dk < recentStart) base.push(r);
    }
    const nR = recent.length, nB = base.length;
    const ratio = o.recentDays / o.baseDays;
    // SPEC §8: E = cB·NR/NB, so a unit is judged against the baseline SHARE scaled to recent volume and a pure volume
    // surge (every unit doubling) lifts nothing. The day ratio is only the fallback when the baseline is empty.
    const volumeRatio = nB > 0 ? nR / nB : ratio;
    const rows = [];
    function scoreUnit(unit, value, label, cR, cB, sampleIds) {
      const expected = cB * volumeRatio;
      let z;
      if (DENSE_UNITS.indexOf(unit) >= 0 && nR > 0 && nB > 0) {
        const pR = cR / nR, pB = cB / nB, pooled = (cR + cB) / (nR + nB);
        const se = Math.sqrt(pooled * (1 - pooled) * (1 / nR + 1 / nB));
        z = se > 0 ? (pR - pB) / se : 0;
      } else {
        z = (cR - expected) / Math.sqrt(expected + 1);
      }
      const lift = expected > 0 ? cR / expected : null;
      let status = 'stable';
      if (cB === 0 && cR >= 3) status = 'new';
      else if (z >= 2 && (lift === null || lift >= 1.5)) status = 'emerging';
      else if (z <= -2 && cB >= o.minFading && (lift === null || lift <= 1 / 1.5)) status = 'fading';
      if (cR < o.minRecent && status !== 'fading') return;
      rows.push({ unit, type: unit, value, label, cR, cB, expected: round(expected, 2), lift: lift === null ? null : round(lift, 2), z: round(z, 2), status, sampleIds: sampleIds.slice(0, 5) });
    }
    for (const unit of o.units) {
      if (unit === 'bigram') {
        for (const [gram, c] of bigramCounts(recent, base)) scoreUnit('bigram', gram, '"' + gram + '"', c.cR, c.cB, c.sampleIds);
        continue;
      }
      const keyFn = UNIT_FIELD[unit];
      if (!keyFn) continue;
      const gR = groupBy(recent, keyFn), gB = groupBy(base, keyFn);
      const values = new Set([...gR.keys(), ...gB.keys()]);
      for (const v of values) {
        if (v === 'general' || v === 'other_noise' || v === 'none') continue;
        const rl = gR.get(v) || [], bl = gB.get(v) || [];
        let label;
        if (unit === 'subcategory') { const parts = v.split('/'); label = labelOf('category', parts[0]) + ' › ' + labelOf('subcategory', parts[1]); }
        else label = labelOf(unit, v);
        scoreUnit(unit, v, label, rl.length, bl.length, rl.map(r => r.id));
      }
    }
    rows.sort((a, b) => b.z - a.z);
    const flagged = rows.filter(r => r.status === 'new' || r.status === 'emerging');
    const fading = rows.filter(r => r.status === 'fading');
    let explanation;
    if (!nR && !nB) explanation = 'No records fall in the last ' + (o.recentDays + o.baseDays) + ' days (n=0), so nothing can emerge.';
    else if (!flagged.length) explanation = 'No unit is new or emerging in the last ' + o.recentDays + ' days against the prior ' + o.baseDays + ' (n=' + nR + ' recent, ' + nB + ' baseline records).';
    else {
      const top = flagged[0];
      explanation = flagged.length + ' of ' + rows.length + ' units are new or emerging in the last ' + o.recentDays + ' days versus the prior ' + o.baseDays +
        '; the strongest is ' + top.label + ' with ' + top.cR + ' recent mentions against about ' + fmtNum(top.expected, 1) + ' expected (z ' + fmtNum(top.z, 1) +
        '; n=' + nR + ' recent, ' + nB + ' baseline records).';
    }
    const confidence = nB >= 100 && nR >= 20 ? 'high' : nB >= 30 ? 'medium' : 'low';
    const caveats = [];
    if (nB < 30) caveats.push('The baseline holds fewer than 30 records, so lifts are unstable.');
    caveats.push('Units with fewer than ' + o.minRecent + ' recent mentions are hidden unless they are fading.');
    return result({ method: 'poisson_surprise', params, n: nR + nB, nRecent: nR, nBase: nB, rows, flagged: flagged.length, fading: fading.length,
      explanation, confidence, caveats, asOf: toIso(asOfDate) });
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 churnRisk / churnTable                                         */
  /* ------------------------------------------------------------------ */

  function churnFeatures(recs, now) {
    const nowMs = now.getTime();
    const within = (rec, days) => { const t = msOf(rec.received_at); return t !== null && nowMs - t <= days * DAY_MS && t <= nowMs + DAY_MS; };
    const r30 = recs.filter(r => within(r, 30)), r90 = recs.filter(r => within(r, 90));
    const open = recs.filter(isOpen);
    const oldestOpen = open.length ? Math.max(...open.map(r => (ageHours(r, now) || 0) / 24)) : 0;
    const positives = recs.filter(isPositive).map(r => msOf(r.received_at)).filter(t => t !== null);
    const allTimes = recs.map(r => msOf(r.received_at)).filter(t => t !== null);
    // No positive message ever: count the days since the customer's first contact instead of the cap.
    const daysSincePositive = positives.length ? Math.max(0, (nowMs - Math.max(...positives)) / DAY_MS)
      : (allTimes.length ? Math.max(0, (nowMs - Math.min(...allTimes)) / DAY_MS) : 0);
    const maxUrg = r30.length ? Math.max(...r30.map(r => URGENCY_INDEX[r.urgency] || 0)) : 0;
    const raw = {
      neg_msgs_30d: r30.filter(isNegative).length,
      billing_90d: r90.filter(r => r.category === 'subscription_billing').length,
      open_tickets: open.length,
      oldest_open_days: oldestOpen,
      days_since_positive: daysSincePositive,
      repeat_30d: Math.max(0, r30.length - 1),
      max_urgency_30d: maxUrg,
      cancel_intent_30d: r30.some(r => r.cancel_intent) ? 1 : 0,
      side_effects_90d: r90.filter(r => r.category === 'side_effects' || r.category === 'adverse_event').length
    };
    const x = {};
    for (const f of CHURN_FEATURES) x[f.id] = clamp(raw[f.id] / f.cap, 0, 1);
    return { raw, x, vector: CHURN_FEATURES.map(f => x[f.id]), noPositiveEver: positives.length === 0, maxUrgency: maxUrg, lastContact: recs.length ? recs.map(r => r.received_at).sort().pop() : null };
  }
  function urgencyName(idx) { return ['P3', 'P2', 'P1', 'P0'][clamp(Math.round(idx), 0, 3)]; }
  function churnReason(f, feat) {
    const raw = feat.raw[f.id];
    switch (f.id) {
      case 'neg_msgs_30d': return plural(raw, 'negative message') + ' in 30 days';
      case 'billing_90d': return plural(raw, 'billing complaint') + ' in 90 days';
      case 'open_tickets': return plural(raw, 'open ticket');
      case 'oldest_open_days': return 'oldest open ticket ' + plural(Math.round(raw), 'day') + ' old';
      case 'days_since_positive': return feat.noPositiveEver ? 'no positive message in ' + plural(Math.round(raw), 'day') + ' of contact' : 'last positive message ' + plural(Math.round(raw), 'day') + ' ago';
      case 'repeat_30d': return plural(raw, 'repeat contact') + ' in 30 days';
      case 'max_urgency_30d': return urgencyName(feat.maxUrgency) + ' urgency in 30 days';
      case 'cancel_intent_30d': return 'asked to cancel in the last 30 days';
      case 'side_effects_90d': return plural(raw, 'side-effect message') + ' in 90 days';
      default: return f.id;
    }
  }
  function tierOf(score) {
    for (const [lo, hi, tier] of CHURN_TIERS) if (score >= lo && score <= hi) return tier;
    return score > 100 ? 'critical' : 'low';
  }
  function scoreChurn(feat, model) {
    let contributions;
    let p;
    if (model) {
      p = model.predict(feat.vector);
      contributions = model.contributions(feat.vector);
    } else {
      contributions = CHURN_FEATURES.map(f => f.w * feat.x[f.id]);
      p = sigmoid(CHURN_INTERCEPT + sum(contributions));
    }
    const score = Math.round(100 * p);
    const reasons = CHURN_FEATURES.map((f, i) => ({ f, c: contributions[i] })).filter(r => r.c > 0 && feat.raw[r.f.id] > 0)
      .sort((a, b) => b.c - a.c).slice(0, 3).map(r => churnReason(r.f, feat));
    return { score, tier: tierOf(score), reasons, p };
  }
  function labelOfCustomer(c) {
    if (!c) return null;
    if (c.subscription_status === 'cancelled') return 1;
    if (c.subscription_status === 'active') return 0;
    if (c.subscription_status === 'paused') return 0.5;
    return null;
  }
  /**
   * Out-of-sample predictions by stratified k-fold cross-validation (positives and negatives dealt to folds in turn,
   * so the split is deterministic for a given customer order). Null when a training fold lacks both classes.
   */
  function cvPredictions(X, y, o) {
    const n = y.length;
    const k = Math.max(2, Math.min(o.folds || 5, n));
    const fold = new Array(n);
    let cp = 0, cn = 0;
    for (let i = 0; i < n; i++) fold[i] = y[i] > 0.5 ? (cp++ % k) : (cn++ % k);
    const preds = new Array(n).fill(null);
    for (let f = 0; f < k; f++) {
      const trX = [], trY = [];
      for (let i = 0; i < n; i++) if (fold[i] !== f) { trX.push(X[i]); trY.push(y[i]); }
      if (trY.length < 2 || !trY.some(v => v > 0.5) || !trY.some(v => v <= 0.5)) return null;
      const m = fitLogistic(trX, trY, o);
      if (!m) return null;
      for (let i = 0; i < n; i++) if (fold[i] === f) preds[i] = m.predict(X[i]);
    }
    return preds.every(isNum) ? preds : null;
  }
  function reliabilityDeciles(preds, y) {
    const order = preds.map((p, i) => i).sort((a, b) => preds[a] - preds[b]);
    const reliability = [];
    for (let d = 0; d < 10; d++) {
      const lo = Math.floor(d * order.length / 10), hi = Math.floor((d + 1) * order.length / 10);
      const idx = order.slice(lo, hi);
      if (!idx.length) continue;
      reliability.push({ decile: d + 1, predicted: round(mean(idx.map(i => preds[i])), 4), observed: round(mean(idx.map(i => y[i])), 4), n: idx.length });
    }
    return reliability;
  }
  /** OLS slope of observed on predicted across the reliability deciles (1 = calibrated); null with < 3 deciles or no spread. */
  function reliabilitySlope(rel) {
    if (!rel || rel.length < 3) return null;
    const xs = rel.map(r => r.predicted), ys = rel.map(r => r.observed);
    const xm = mean(xs), ym = mean(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - xm) * (ys[i] - ym); sxx += (xs[i] - xm) ** 2; }
    return sxx > 1e-12 ? round(sxy / sxx, 4) : null;
  }
  /**
   * Fit and GATE the logistic churn model. The bundle always describes what happened: `model` is the accepted fit
   * (null when the heuristic stays in charge), `method` names the outcome, `auc` is the cross-validated AUC (the
   * in-sample figure is `aucInSample`), `reason` says why a fit was skipped or rejected.
   * @returns {{model:object|null, method:'fitted'|'heuristic', auc:number|null, aucInSample:number|null, reliability:Array, reliabilitySlope:number|null, nLabelled:number, nPositive:number, reason:string|null, gate:object}}
   */
  function fitChurnModel(byCustomer, customerMap, now, opts) {
    const o = Object.assign({}, LOGISTIC_DEFAULTS, opts || {});
    const X = [], y = [], ids = [];
    for (const [id, recs] of byCustomer) {
      const lab = labelOfCustomer(customerMap.get(id));
      if (lab === null) continue;
      X.push(churnFeatures(recs, now).vector); y.push(lab); ids.push(id);
    }
    const binary = y.map(v => (v > 0.5 ? 1 : 0));
    const gate = { minLabelled: o.minLabelled, minAuc: o.minAuc, folds: o.folds, reliabilitySlope: o.reliabilitySlope.slice() };
    const base = { model: null, method: 'heuristic', auc: null, aucInSample: null, reliability: [], reliabilitySlope: null, nLabelled: y.length, nPositive: sum(binary), reason: null, gate };
    if (y.length < o.minLabelled) return Object.assign(base, { reason: 'fewer than ' + o.minLabelled + ' labelled customers (' + y.length + ')' });
    if (!base.nPositive || base.nPositive === y.length) return Object.assign(base, { reason: 'labels hold a single class' });
    const model = fitLogistic(X, y, o);
    if (!model) return Object.assign(base, { reason: 'the logistic fit did not converge' });
    const inSample = X.map(x => model.predict(x));
    base.aucInSample = round(auc(inSample, binary), 4);
    const cv = cvPredictions(X, y, o);
    const scored = cv || inSample;
    base.auc = round(auc(scored, binary), 4);
    base.reliability = reliabilityDeciles(scored, y);
    base.reliabilitySlope = reliabilitySlope(base.reliability);
    base.cv = !!cv;
    if (!isNum(base.auc) || base.auc < o.minAuc) {
      return Object.assign(base, { reason: (cv ? 'cross-validated' : 'in-sample') + ' AUC ' + fmtNum(base.auc, 2) + ' is below the ' + o.minAuc + ' gate' });
    }
    return Object.assign(base, { model, method: 'fitted' });
  }
  /** Accept a churn-model bundle ({model, …}), a bare logistic model ({predict}), or nothing. */
  function modelOf(cand) {
    if (!cand || typeof cand !== 'object') return null;
    if (cand.model && typeof cand.model.predict === 'function') return cand.model;
    if (typeof cand.predict === 'function' && typeof cand.contributions === 'function') return cand;
    return null;
  }
  /**
   * Fit (and gate) the churn model once for a record set, to hand to churnRisk / churnTable as opts.model so every
   * caller scores with the same method. Returns the bundle fitChurnModel describes; `model` is null when the heuristic applies.
   * @param {object[]} records
   * @param {Map|object[]} customers
   * @param {{now?:Date|string}} [opts]
   */
  function churnModel(records, customers, opts) {
    const o = opts || {};
    const now = nowOf(o);
    const customerMap = customersToMap(customers);
    const recs = (Array.isArray(records) ? records : []).filter(r => r && r.customer_id && !r.is_noise);
    return fitChurnModel(groupBy(recs, r => r.customer_id), customerMap, now, o.logistic);
  }

  /**
   * Cancellation risk for one customer. The method is explicit: pass opts.model (a churnModel() bundle or a
   * churnTable().model) to score with the fitted logistic, otherwise the curated heuristic weights apply. Nothing
   * is remembered between calls, so the same inputs always give the same score.
   * @param {string} customerId
   * @param {object[]} records all records (filtered to the customer internally)
   * @param {Map|object[]} customers
   * @param {{now?:Date|string, model?:object}} [opts]
   */
  function churnRisk(customerId, records, customers, opts) {
    const o = opts || {};
    const now = nowOf(o);
    const customerMap = customersToMap(customers);
    const recs = (Array.isArray(records) ? records : []).filter(r => r && r.customer_id === customerId && !r.is_noise);
    const model = modelOf(o.model);
    const feat = churnFeatures(recs, now);
    const scored = scoreChurn(feat, model);
    const customer = customerMap.get(customerId) || null;
    const method = model ? 'fitted' : 'heuristic';
    const params = { intercept: CHURN_INTERCEPT, features: CHURN_FEATURES.map(f => ({ id: f.id, cap: f.cap, w: f.w })), scaling: 'x = min(raw, cap) / cap' };
    const explanation = 'This customer scores ' + scored.score + ' of 100 (' + scored.tier + ') from n=' + recs.length + ' ' + (recs.length === 1 ? 'record' : 'records') +
      (scored.reasons.length ? ', driven by ' + scored.reasons.join(', ') + '.' : ' with no active risk signals.');
    const confidence = recs.length >= 3 ? (method === 'fitted' ? 'high' : 'medium') : 'low';
    const caveats = recs.length ? [] : ['No records for this customer; the score is the population baseline.'];
    if (customer && customer.subscription_status === 'cancelled') caveats.push('Subscription already cancelled; the score describes win-back difficulty rather than risk.');
    return result({ method, params, n: recs.length, score: scored.score, tier: scored.tier, reasons: scored.reasons, features: { raw: feat.raw, scaled: feat.x },
      customerId, lastContact: feat.lastContact, explanation, confidence, caveats, asOf: toIso(now) });
  }

  /**
   * Ranked cancellation-risk table. Scores with opts.model when given (a churnModel() bundle, so the table agrees with
   * every other churnRisk caller), otherwise fits and gates a logistic model on this record set: it is used only when
   * ≥ minLabelled customers carry a subscription label AND its cross-validated AUC clears minAuc; otherwise the
   * heuristic weights score everyone and a caveat names the rejected AUC. The bundle is returned as `model`.
   * @param {object[]} records
   * @param {Map|object[]} customers
   * @param {{now?:Date|string, top?:number, includeCancelled?:boolean, model?:object}} [opts]
   */
  function churnTable(records, customers, opts) {
    const o = Object.assign({ top: 50, includeCancelled: false }, opts || {});
    const now = nowOf(o);
    const customerMap = customersToMap(customers);
    const recs = (Array.isArray(records) ? records : []).filter(r => r && r.customer_id && !r.is_noise);
    const byCustomer = groupBy(recs, r => r.customer_id);
    const fitted = o.model && typeof o.model === 'object' && 'method' in o.model ? o.model : fitChurnModel(byCustomer, customerMap, now, o.logistic);
    const model = fitted.model || null;
    const rows = [];
    let revenueTotal = 0;
    for (const [id, crecs] of byCustomer) {
      const customer = customerMap.get(id) || { customer_id: id };
      if (!o.includeCancelled && customer.subscription_status === 'cancelled') continue;
      const feat = churnFeatures(crecs, now);
      const scored = scoreChurn(feat, model);
      const value = isNum(customer.subscription_value_12m_usd) ? customer.subscription_value_12m_usd : 0;
      const revenueAtRisk = round(scored.p * value, 2);
      revenueTotal += revenueAtRisk;
      rows.push({ customer, customerId: id, score: scored.score, tier: scored.tier, reasons: scored.reasons, revenueAtRisk, lastContact: feat.lastContact, n: crecs.length });
    }
    rows.sort((a, b) => b.score - a.score || b.revenueAtRisk - a.revenueAtRisk);
    const highPlus = rows.filter(r => r.tier === 'high' || r.tier === 'critical').length;
    const method = model ? 'fitted' : 'heuristic';
    const gate = fitted.gate || { minLabelled: LOGISTIC_DEFAULTS.minLabelled, minAuc: LOGISTIC_DEFAULTS.minAuc, folds: LOGISTIC_DEFAULTS.folds, reliabilitySlope: LOGISTIC_DEFAULTS.reliabilitySlope };
    const params = { intercept: CHURN_INTERCEPT, features: CHURN_FEATURES.map(f => ({ id: f.id, cap: f.cap, w: f.w })), top: o.top, gate,
      logistic: model ? { lr: LOGISTIC_DEFAULTS.lr, epochs: LOGISTIC_DEFAULTS.epochs, l2: LOGISTIC_DEFAULTS.l2, nLabelled: fitted.nLabelled, nPositive: fitted.nPositive } : null };
    const aucKind = fitted.cv ? 'cross-validated AUC ' : 'in-sample AUC ';
    const explanation = highPlus + ' of n=' + rows.length + ' customers with contact history score high or critical, and about $' + fmtNum(revenueTotal) +
      ' of 12-month subscription value sits at risk (' + (method === 'fitted' ? 'fitted logistic model, ' + aucKind + fmtNum(fitted.auc, 2) + ' on ' + fitted.nLabelled + ' labelled customers' : 'heuristic weights') + ').';
    const confidence = model ? (fitted.auc >= 0.75 ? 'high' : 'medium') : rows.length >= 50 ? 'medium' : 'low';
    const caveats = [];
    if (!model) {
      if (isNum(fitted.auc)) caveats.push('A logistic fit on ' + fitted.nLabelled + ' labelled customers reached ' + aucKind + fmtNum(fitted.auc, 2) + ', below the ' + gate.minAuc + ' gate, so the curated heuristic weights score every customer.');
      else caveats.push((fitted.reason ? fitted.reason.replace(/^./, c => c.toUpperCase()) : 'Fewer than ' + gate.minLabelled + ' customers carry a subscription label') + ', so weights are heuristic.');
    }
    if (model && isNum(fitted.reliabilitySlope) && (fitted.reliabilitySlope < gate.reliabilitySlope[0] || fitted.reliabilitySlope > gate.reliabilitySlope[1])) {
      caveats.push('Calibration slope ' + fmtNum(fitted.reliabilitySlope, 2) + ' sits outside ' + gate.reliabilitySlope[0] + '–' + gate.reliabilitySlope[1] + ': read scores as a ranking, not as probabilities.');
    }
    caveats.push('Customers already cancelled are excluded from the table but used to fit the model.');
    const out = result({ method, params, n: rows.length, rows: rows.slice(0, o.top), totalRows: rows.length, revenueAtRisk: round(revenueTotal, 2), explanation, confidence, caveats, asOf: toIso(now) });
    out.model = fitted;
    out.nLabelled = fitted.nLabelled;
    if (model) {
      out.auc = fitted.auc; out.aucInSample = fitted.aucInSample; out.reliability = fitted.reliability; out.reliabilitySlope = fitted.reliabilitySlope;
      out.coefficients = CHURN_FEATURES.map((f, i) => ({ id: f.id, beta: round(model.beta[i], 4) }));
    } else if (isNum(fitted.auc)) {
      out.rejectedFit = { auc: fitted.auc, aucInSample: fitted.aucInSample, nLabelled: fitted.nLabelled, reason: fitted.reason };
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 escalationRisk                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Probability that an open record escalates, from a fixed logit over urgency, sentiment, wording, age, repeat contact and channel.
   * @param {object} rec
   * @param {object[]} records
   * @param {{now?:Date|string}} [opts]
   */
  function escalationRisk(rec, records, opts) {
    const o = opts || {};
    const now = nowOf(o);
    if (!rec) return result({ method: 'logit', params: ESCALATION_WEIGHTS, n: 0, score: null, tier: null, reasons: [], explanation: 'No record supplied (n=0).', confidence: 'low', asOf: toIso(now) });
    const text = recordText(rec);
    const open = isOpen(rec);
    const age = open ? (ageHours(rec, now) || 0) : 0;
    const nowMs = now.getTime();
    const siblings = (Array.isArray(records) ? records : []).filter(r => r && r.id !== rec.id && r.customer_id && r.customer_id === rec.customer_id &&
      !r.is_noise && (() => { const t = msOf(r.received_at); return t !== null && nowMs - t <= 30 * DAY_MS; })());
    const sla = slaHoursOf(rec, o);
    const f = {
      urgency: (URGENCY_INDEX[rec.urgency] || 0) / 3,
      negative: isNegative(rec) ? 1 : 0,
      severe: ESCALATION_KEYWORDS.severe.test(text) ? 1 : 0,
      strong: 0, mild: 0,
      age: clamp(age / 48, 0, 1),
      repeat: siblings.length >= 1 ? 1 : 0,
      noResponse: open && !rec.first_response_at && age > sla ? 1 : 0,
      publicChannel: PUBLIC_CHANNELS.indexOf(rec.channel) >= 0 ? 1 : 0
    };
    if (!f.severe && ESCALATION_KEYWORDS.strong.test(text)) f.strong = 1;
    if (!f.severe && !f.strong && ESCALATION_KEYWORDS.mild.test(text)) f.mild = 1;
    const contributions = Object.keys(f).map(k => ({ k, c: ESCALATION_WEIGHTS[k] * f[k] }));
    const logit = ESCALATION_WEIGHTS.intercept + sum(contributions.map(c => c.c));
    const p = sigmoid(logit);
    const score = Math.round(100 * p);
    const phrases = {
      urgency: rec.urgency + ' urgency', negative: 'negative sentiment', severe: 'mentions legal action, regulators or a chargeback', strong: 'strong wording',
      mild: 'frustrated wording', age: 'open for ' + fmtNum(age / 24, 1) + ' days', repeat: plural(siblings.length + 1, 'contact') + ' from this customer in 30 days',
      noResponse: 'no first response after ' + fmtNum(age, 0) + 'h (SLA ' + sla + 'h)', publicChannel: 'public channel'
    };
    const reasons = contributions.filter(c => c.c > 0).sort((a, b) => b.c - a.c).slice(0, 3).map(c => phrases[c.k]);
    const tier = tierOf(score);
    const explanation = 'This record scores ' + score + ' of 100 (' + tier + ') for escalation' + (reasons.length ? ', driven by ' + reasons.join(', ') : '') +
      ' (n=' + (siblings.length + 1) + ' ' + (siblings.length ? 'records' : 'record') + ' from this customer in 30 days).';
    const caveats = open ? [] : ['Record is not open; age and response features count as zero.'];
    return result({ method: 'logit', params: Object.assign({}, ESCALATION_WEIGHTS), n: 1, score, tier, reasons, features: f, explanation,
      confidence: 'medium', caveats, asOf: toIso(now) });
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 predictCsat — ridge regression                                 */
  /* ------------------------------------------------------------------ */

  function csatDesign(rec, ctx) {
    const frt = frtHours(rec), res = resolutionHours(rec);
    const row = [
      isNum(rec.sentiment) ? rec.sentiment : 0,
      Math.log1p(isNum(frt) ? frt : ctx.frtMedian),
      Math.log1p(isNum(res) ? res : ctx.resMedian),
      URGENCY_INDEX[rec.urgency] || 0,
      ctx.repeatCustomers.has(rec.customer_id) ? 1 : 0
    ];
    for (const c of ctx.topCategories) row.push(rec.category === c ? 1 : 0);
    return row;
  }
  /**
   * Predict CSAT (1–5) for open records from resolved records that carry a CSAT score.
   * @param {object[]} records
   * @param {{now?:Date|string, lambda?:number}} [opts]
   */
  function predictCsat(records, opts) {
    const o = Object.assign({}, CSAT_DEFAULTS, opts || {});
    const now = nowOf(o);
    const recs = (Array.isArray(records) ? records : []).filter(r => r && !r.is_noise);
    const train = recs.filter(r => isNum(r.csat) && !isOpen(r));
    const open = recs.filter(isOpen);
    const byCustomer = groupBy(recs, r => r.customer_id);
    const repeatCustomers = new Set([...byCustomer].filter(([, v]) => v.length >= 2).map(([k]) => k));
    const catCounts = groupBy(train, r => r.category);
    const topCategories = [...catCounts].sort((a, b) => b[1].length - a[1].length).slice(0, o.topCategories).map(([k]) => k);
    const ctx = { frtMedian: nz(median(train.map(frtHours).filter(isNum)), 5), resMedian: nz(median(train.map(resolutionHours).filter(isNum)), 30), repeatCustomers, topCategories };
    const featureNames = ['sentiment', 'log1p_frt_hours', 'log1p_resolution_hours', 'urgency_index', 'repeat_customer'].concat(topCategories.map(c => 'category_' + c));
    const asOf = toIso(now);
    let fit = null;
    if (train.length >= o.minN) fit = ridgeFit(train.map(r => csatDesign(r, ctx)), train.map(r => r.csat), o.lambda);
    if (fit) {
      const predictions = open.map(r => {
        const x = csatDesign(r, ctx);
        const pred = clamp(fit.intercept + x.reduce((s, v, j) => s + v * fit.beta[j], 0), 1, 5);
        return { id: r.id, pred: round(pred, 2), lo: round(clamp(pred - o.z * fit.sigma, 1, 5), 2), hi: round(clamp(pred + o.z * fit.sigma, 1, 5), 2) };
      });
      const meanPred = predictions.length ? mean(predictions.map(p => p.pred)) : null;
      const model = { beta: featureNames.map((name, j) => ({ feature: name, beta: round(fit.beta[j], 4) })), intercept: round(fit.intercept, 4), r2: round(fit.r2, 4), sigma: round(fit.sigma, 4), n: fit.n, features: featureNames };
      const explanation = 'Ridge regression on n=' + fit.n + ' resolved records with a CSAT score explains ' + fmtPct(fit.r2) + ' of the variance (σ ' + fmtNum(fit.sigma, 2) + ')' +
        (predictions.length ? ' and expects the ' + open.length + ' open records to land around ' + fmtNum(meanPred, 1) + ' of 5, each within ±' + fmtNum(o.z * fit.sigma, 1) + '.' : '; no records are open to score.');
      const confidence = fit.r2 >= 0.3 && fit.n >= 100 ? 'high' : 'medium';
      const caveats = ['Open records have no response or resolution time yet, so the training medians stand in for them.'];
      return result({ method: 'ridge', params: { lambda: o.lambda, z: o.z, features: featureNames }, n: fit.n, model, predictions, nOpen: open.length, explanation, confidence, caveats, asOf });
    }
    const withCsat = recs.filter(r => isNum(r.csat));
    const globalMean = nz(mean(withCsat.map(r => r.csat)), 3.5);
    const catMeans = new Map([...groupBy(withCsat, r => r.category)].map(([k, v]) => [k, mean(v.map(r => r.csat))]));
    const sigma = withCsat.length >= 2 ? Math.max(0.5, std(withCsat.map(r => r.csat))) : 1;
    const predictions = open.map(r => {
      const base = catMeans.has(r.category) ? catMeans.get(r.category) : globalMean;
      const pred = clamp(base + 0.8 * (isNum(r.sentiment) ? r.sentiment : 0), 1, 5);
      return { id: r.id, pred: round(pred, 2), lo: round(clamp(pred - o.z * sigma, 1, 5), 2), hi: round(clamp(pred + o.z * sigma, 1, 5), 2) };
    });
    const explanation = 'Only n=' + train.length + ' resolved records carry a CSAT score (fewer than ' + o.minN + '), so open records take their category mean plus 0.8 × sentiment' +
      (predictions.length ? ', about ' + fmtNum(mean(predictions.map(p => p.pred)), 1) + ' of 5 on average across ' + open.length + ' open records.' : '.');
    return result({ method: 'fallback', params: { formula: 'categoryMean + 0.8·sentiment', z: o.z, sigma: round(sigma, 3), minN: o.minN }, n: train.length, model: null, predictions, nOpen: open.length,
      explanation, confidence: 'low', caveats: ['Collect at least ' + o.minN + ' resolved CSAT scores to fit the regression.'], asOf });
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 projectedNps                                                   */
  /* ------------------------------------------------------------------ */

  function npsInterval(prom, det, n, z) {
    if (!n) return { lo: null, hi: null };
    const p = prom / n, d = det / n;
    const half = z * Math.sqrt(Math.max(0, (p + d - (p - d) ** 2) / n)) * 100;
    return { lo: (p - d) * 100 - half, hi: (p - d) * 100 + half };
  }
  /**
   * Current NPS plus a projection that adds the expected outcome of open, unsurveyed records by sentiment.
   * @param {object[]} records
   * @param {{now?:Date|string}} [opts]
   */
  function projectedNps(records, opts) {
    const now = nowOf(opts || {});
    const recs = (Array.isArray(records) ? records : []).filter(r => r && !r.is_noise);
    const surveyed = recs.filter(r => isNum(r.nps));
    const n = surveyed.length;
    const openUnsurveyed = recs.filter(r => isOpen(r) && !isNum(r.nps));
    const asOf = toIso(now);
    if (!n) {
      return result({ method: 'sentiment_mapping', params: {}, n: 0, current: null, projected: null, lo: null, hi: null, nOpen: openUnsurveyed.length,
        explanation: 'No NPS responses yet (n=0), so there is no score to project.', confidence: 'low', caveats: ['NPS needs survey responses or emails that carry a 0–10 score.'], asOf });
    }
    const prom = surveyed.filter(isPromoter).length, det = surveyed.filter(isDetractor).length;
    const current = (prom - det) / n * 100;
    const mapping = {};
    const fallback = { negative: -0.5, neutral: 0, positive: 0.4, unscored: 0 };
    for (const lab of ['negative', 'neutral', 'positive', 'unscored']) {
      const grp = surveyed.filter(r => (r.sentiment_label || (isNegative(r) ? 'negative' : isPositive(r) ? 'positive' : 'neutral')) === lab);
      mapping[lab] = grp.length >= 5 ? mean(grp.map(r => (isPromoter(r) ? 1 : isDetractor(r) ? -1 : 0))) : fallback[lab];
    }
    let expectedNet = 0, expectedProm = 0, expectedDet = 0;
    for (const r of openUnsurveyed) {
      const lab = r.sentiment_label || (isNegative(r) ? 'negative' : isPositive(r) ? 'positive' : 'neutral');
      const e = mapping[lab];
      expectedNet += e;
      if (e > 0) expectedProm += e; else expectedDet += -e;
    }
    const total = n + openUnsurveyed.length;
    const projected = ((prom - det) + expectedNet) / total * 100;
    const iv = npsInterval(prom + expectedProm, det + expectedDet, total, 1.96);
    const explanation = 'NPS stands at ' + fmtNum(current) + ' on n=' + n + ' responses; folding in the likely outcome of ' + openUnsurveyed.length +
      ' open, unsurveyed records puts it near ' + fmtNum(projected) + ', likely ' + fmtRange(iv.lo, iv.hi) + '.';
    const confidence = n >= 100 ? 'high' : n >= 30 ? 'medium' : 'low';
    return result({ method: 'sentiment_mapping', params: { mapping: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, round(v, 3)])), z: 1.96 }, n,
      current: round(current, 1), projected: round(projected, 1), lo: round(iv.lo, 1), hi: round(iv.hi, 1), nOpen: openUnsurveyed.length, explanation, confidence,
      caveats: ['Open records are mapped to promoter/detractor odds by sentiment label, not by an actual survey.'], asOf });
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 driverAnalysis / whatChanged                                   */
  /* ------------------------------------------------------------------ */

  function valueOf(rec, dimension) {
    if (dimension === 'subcategory') return rec.subcategory ? rec.category + '/' + rec.subcategory : null;
    return rec[dimension] === undefined ? null : rec[dimension];
  }
  function dimensionLabel(dimension, v) {
    if (dimension === 'subcategory' && typeof v === 'string' && v.indexOf('/') >= 0) {
      const parts = v.split('/');
      return labelOf('category', parts[0]) + ' › ' + labelOf('subcategory', parts[1]);
    }
    return labelOf(dimension, v);
  }
  /**
   * Which values of a dimension carry more negatives than their volume explains (2×2 lift, Yates χ², BH q).
   * @param {object[]} records
   * @param {'category'|'subcategory'|'product'|'channel'|'segment'} dimension
   * @param {{outcome?:'negative'|'complaint'|'detractor', minSupport?:number, alpha?:number, now?:Date|string}} [opts]
   */
  function driverAnalysis(records, dimension, opts) {
    const o = Object.assign({}, DRIVER_DEFAULTS, { outcome: 'negative' }, opts || {});
    const dim = dimension || 'category';
    const neg = outcomeFn(o.outcome);
    const recs = (Array.isArray(records) ? records : []).filter(r => r && !r.is_noise && valueOf(r, dim) !== null);
    const N = recs.length;
    const asOf = toIso(nowOf(o));
    const params = { dimension: dim, outcome: o.outcome, minSupport: o.minSupport, alpha: o.alpha, test: 'Yates chi-square, BH-adjusted' };
    if (!N) return result({ method: 'chi2_lift', params, n: 0, rows: [], baseRate: null, explanation: 'No records to compare (n=0).', confidence: 'low', asOf });
    const totalNeg = recs.filter(neg).length;
    const baseRate = totalNeg / N;
    const groups = groupBy(recs, r => valueOf(r, dim));
    const rows = [];
    for (const [v, list] of groups) {
      const n = list.length;
      if (n < o.minSupport) continue;
      const a = list.filter(neg).length, b = n - a, c = totalNeg - a, d = (N - n) - c;
      const rate = a / n;
      const chi2 = chi2Yates(a, b, c, d);
      rows.push({ value: v, label: dimensionLabel(dim, v), n, negatives: a, rate: round(rate, 4), baseRate: round(baseRate, 4), lift: baseRate > 0 ? round(rate / baseRate, 3) : null,
        excess: round(a - n * baseRate, 2), chi2: round(chi2, 4), p: chiSquareSurvival1(chi2), q: null, significant: false });
    }
    const q = benjaminiHochberg(rows.map(r => r.p));
    rows.forEach((r, i) => { r.q = round(q[i], 6); r.p = round(r.p, 6); r.significant = q[i] < o.alpha; });
    rows.sort((a, b) => b.excess - a.excess);
    const sig = rows.filter(r => r.significant && r.excess > 0);
    let explanation;
    if (!rows.length) explanation = 'No ' + dim + ' value reaches ' + o.minSupport + ' records (n=' + N + '), so lifts are not shown.';
    else if (!sig.length) explanation = 'No ' + dim + ' value carries significantly more ' + o.outcome + ' records than its volume explains (n=' + N + ', base rate ' + fmtPct(baseRate) + ').';
    else explanation = sig[0].label + ' runs at ' + fmtPct(sig[0].rate) + ' ' + o.outcome + ' against a ' + fmtPct(baseRate) + ' base rate, about ' + fmtNum(sig[0].excess) +
      ' excess records (q ' + fmtNum(sig[0].q, 3) + '; n=' + N + ', ' + sig.length + ' of ' + rows.length + ' values significant).';
    const confidence = N >= 200 ? 'high' : N >= 60 ? 'medium' : 'low';
    return result({ method: 'chi2_lift', params, n: N, rows, baseRate: round(baseRate, 4), negatives: totalNeg, explanation, confidence,
      caveats: ['Lift compares each value with the overall base rate; records can carry only one primary ' + dim + '.'], asOf });
  }

  /**
   * Decompose the change in negatives between two periods into volume and rate effects per dimension value; rows sum to the total delta.
   * @param {object[]} recordsNow
   * @param {object[]} recordsPrior
   * @param {string} dimension
   * @param {{outcome?:'negative'|'complaint'|'detractor', top?:number, now?:Date|string}} [opts]
   */
  function whatChanged(recordsNow, recordsPrior, dimension, opts) {
    const o = Object.assign({ outcome: 'negative', top: 8 }, opts || {});
    const dim = dimension || 'category';
    const neg = outcomeFn(o.outcome);
    const nowRecs = (Array.isArray(recordsNow) ? recordsNow : []).filter(r => r && !r.is_noise);
    const priorRecs = (Array.isArray(recordsPrior) ? recordsPrior : []).filter(r => r && !r.is_noise);
    const nowNeg = nowRecs.filter(neg).length, priorNeg = priorRecs.filter(neg).length;
    const priorRate = priorRecs.length ? priorNeg / priorRecs.length : 0;
    const asOf = toIso(nowOf(o));
    const gN = groupBy(nowRecs, r => valueOf(r, dim)), gP = groupBy(priorRecs, r => valueOf(r, dim));
    const values = new Set([...gN.keys(), ...gP.keys()]);
    let rows = [];
    for (const v of values) {
      const ln = gN.get(v) || [], lp = gP.get(v) || [];
      const nNow = ln.length, nPrior = lp.length;
      const negNow = ln.filter(neg).length, negPrior = lp.filter(neg).length;
      const rateNow = nNow ? negNow / nNow : (nPrior ? negPrior / nPrior : priorRate);
      const ratePrior = nPrior ? negPrior / nPrior : (nNow ? rateNow : priorRate);
      const volumeEffect = (nNow - nPrior) * ratePrior;
      const rateEffect = nNow * (rateNow - ratePrior);
      rows.push({ value: v, label: dimensionLabel(dim, v), nNow, nPrior, rateNow, ratePrior, volumeEffect, rateEffect, delta: negNow - negPrior });
    }
    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || Math.abs(b.volumeEffect) + Math.abs(b.rateEffect) - Math.abs(a.volumeEffect) - Math.abs(a.rateEffect));
    if (rows.length > o.top + 1) {
      const head = rows.slice(0, o.top), tail = rows.slice(o.top);
      const other = { value: '__other__', label: 'Other', nNow: 0, nPrior: 0, volumeEffect: 0, rateEffect: 0, delta: 0, grouped: tail.length };
      for (const t of tail) { other.nNow += t.nNow; other.nPrior += t.nPrior; other.volumeEffect += t.volumeEffect; other.rateEffect += t.rateEffect; other.delta += t.delta; }
      other.rateNow = other.nNow ? tail.reduce((s, t) => s + t.rateNow * t.nNow, 0) / other.nNow : null;
      other.ratePrior = other.nPrior ? tail.reduce((s, t) => s + t.ratePrior * t.nPrior, 0) / other.nPrior : null;
      rows = head.concat([other]);
    }
    for (const r of rows) {
      r.volumeEffect = round(r.volumeEffect, 6); r.rateEffect = round(r.rateEffect, 6);
      r.rateNow = round(r.rateNow, 4); r.ratePrior = round(r.ratePrior, 4);
    }
    const total = { now: nowNeg, prior: priorNeg, delta: nowNeg - priorNeg, volumeNow: nowRecs.length, volumePrior: priorRecs.length };
    const volumeSum = sum(rows.map(r => r.volumeEffect)), rateSum = sum(rows.map(r => r.rateEffect));
    let explanation;
    if (!nowRecs.length && !priorRecs.length) explanation = 'Neither period has records (n=0).';
    else {
      const lead = rows[0];
      explanation = (o.outcome === 'negative' ? 'Negative' : o.outcome === 'complaint' ? 'Complaint' : 'Detractor') + ' records moved from ' + priorNeg + ' to ' + nowNeg + ' (' +
        (total.delta >= 0 ? '+' : '') + total.delta + '; n=' + nowRecs.length + ' now vs ' + priorRecs.length + ' prior). Volume shifts account for about ' + fmtNum(volumeSum, 1) +
        ' and rate shifts for about ' + fmtNum(rateSum, 1) + (lead ? '; ' + lead.label + ' contributes ' + (lead.delta >= 0 ? '+' : '') + lead.delta + '.' : '.');
    }
    const confidence = nowRecs.length + priorRecs.length >= 200 ? 'high' : nowRecs.length + priorRecs.length >= 60 ? 'medium' : 'low';
    return result({ method: 'rate_volume_decomposition', params: { dimension: dim, outcome: o.outcome, top: o.top, formula: 'Δ_v = (nNow_v − nPrior_v)·ratePrior_v + nNow_v·(rateNow_v − ratePrior_v)' },
      n: nowRecs.length + priorRecs.length, total, rows, explanation, confidence, caveats: ['Values beyond the top ' + o.top + ' are grouped as Other so the rows still sum to the total change.'], asOf });
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 slaBreachProb, seasonalityIndex, sentimentDrift                */
  /* ------------------------------------------------------------------ */

  /**
   * Probability that a record still awaiting a first response misses its SLA, from the empirical FRT survival curve.
   * @param {object} rec
   * @param {object[]} records
   * @param {{slaHours?:number, now?:Date|string, minCategoryN?:number}} [opts]
   */
  function slaBreachProb(rec, records, opts) {
    const o = Object.assign({ minCategoryN: 30 }, opts || {});
    const now = nowOf(o);
    const asOf = toIso(now);
    if (!rec) return result({ method: 'empirical_survival', params: {}, n: 0, p: null, basis: 'global', explanation: 'No record supplied (n=0).', confidence: 'low', asOf });
    const T = slaHoursOf(rec, o);
    const pool = (Array.isArray(records) ? records : []).filter(r => r && r.id !== rec.id && !r.is_noise && isNum(frtHours(r)));
    const catPool = pool.filter(r => r.category === rec.category);
    const basis = catPool.length >= o.minCategoryN ? 'category' : 'global';
    const sample = basis === 'category' ? catPool : pool;
    const frts = sample.map(frtHours);
    const n = frts.length;
    const survival = t => (frts.filter(x => x > t).length + 0.5) / (n + 1);
    const params = { slaHours: T, basis, minCategoryN: o.minCategoryN, smoothing: 'Laplace 0.5/(n+1)' };
    const frt = frtHours(rec);
    let p, explanation;
    const a = ageHours(rec, now) || 0;
    if (isNum(frt)) {
      p = frt > T ? 1 : 0;
      explanation = 'First response arrived after ' + fmtNum(frt, 1) + 'h against a ' + T + 'h SLA, so the outcome is known (n=' + n + ' comparable records).';
    } else if (!isOpen(rec)) {
      p = null;
      explanation = 'Record is closed without a recorded first response, so breach probability does not apply (n=' + n + ').';
    } else if (a >= T) {
      p = 1;
      explanation = 'Already ' + fmtNum(a, 0) + 'h old with no first response against a ' + T + 'h SLA: the SLA is breached (n=' + n + ' comparable records).';
    } else if (!n) {
      p = null;
      explanation = 'No comparable records with a first-response time yet (n=0), so no breach probability is available.';
    } else {
      p = clamp(survival(T) / survival(a), 0, 1);
      explanation = 'About ' + fmtPct(p) + ' of comparable ' + (basis === 'category' ? labelOf('category', rec.category) : '') + ' records that were still unanswered at ' + fmtNum(a, 0) +
        'h went on to miss the ' + T + 'h SLA (n=' + n + ' ' + basis + ' records with a first response).';
    }
    const confidence = n >= 100 ? 'high' : n >= 30 ? 'medium' : 'low';
    return result({ method: 'empirical_survival', params, n, p: p === null ? null : round(p, 4), basis, ageHours: round(a, 2), explanation, confidence,
      caveats: ['Records still awaiting a first response are not in the survival sample.'], asOf });
  }

  /**
   * Monthly seasonality index (100 = average month) for all records or one category's share.
   * @param {object[]} records
   * @param {string|null} categoryId
   * @param {{now?:Date|string}} [opts]
   */
  function seasonalityIndex(records, categoryId, opts) {
    const recs = (Array.isArray(records) ? records : []).filter(r => r && !r.is_noise);
    const asOf = toIso(nowOf(opts || {}));
    const byMonth = groupBy(recs, monthKeyOfRecord);
    const months = [...byMonth.keys()].sort();
    const params = { category: categoryId || null, basis: categoryId ? 'share of monthly volume' : 'monthly volume' };
    if (!months.length) return result({ method: 'seasonal_index', params, n: 0, rows: [], explanation: 'No months with records (n=0).', confidence: 'low', asOf });
    const values = months.map(m => {
      const list = byMonth.get(m);
      return categoryId ? list.filter(r => r.category === categoryId).length / list.length : list.length;
    });
    const avg = mean(values);
    const rows = months.map((m, i) => ({ month: m, index: avg > 0 ? round(values[i] / avg * 100, 1) : null, n: categoryId ? byMonth.get(m).filter(r => r.category === categoryId).length : byMonth.get(m).length, total: byMonth.get(m).length }));
    const peak = rows.slice().sort((a, b) => (b.index || 0) - (a.index || 0))[0];
    const explanation = (categoryId ? labelOf('category', categoryId) + ' share' : 'Volume') + ' peaks in ' + peak.month + ' at ' + fmtNum(peak.index) + ' against an average of 100 across ' +
      months.length + ' months (n=' + recs.length + ' records).';
    const confidence = months.length >= 12 ? 'high' : months.length >= 10 ? 'medium' : 'low';
    const caveats = months.length < 10 ? ['Fewer than 10 months of data; the index reflects the period, not a seasonal pattern.'] : [];
    if (months.length && (byMonth.get(months[0]).length < 5 || byMonth.get(months[months.length - 1]).length < 5)) caveats.push('The first or last month is partial and carries fewer than 5 records.');
    return result({ method: 'seasonal_index', params, n: recs.length, rows, explanation, confidence, caveats, asOf });
  }

  /**
   * OLS slope over the last `weeks` weekly sentiment-index means; alert when the 12-week change is below −5 points.
   * @param {Array<{key:string, value:number, n?:number}>} weeklyIndexSeries
   * @param {{weeks?:number, alertDrop?:number, now?:Date|string}} [opts]
   */
  /**
   * OLS drift on weekly sentiment-index means. Weeks with n < minWeekN records are dropped before the fit (when n is
   * given). `alert` is true only when the fit rests on ≥ minWeeks solid weeks, the projected 12-week change falls below
   * alertDrop, and the line fits (r² ≥ minR2, or r² ≥ weakR2 with |change| ≥ weakChange points). `reason` names the first
   * blocker: 'too few weeks' | 'weak fit' | 'within threshold' | null; `reasons` carries every blocker with its numbers.
   * @param {Array<{key:string,value:number,n?:number}>} weeklyIndexSeries
   * @param {{weeks?:number, alertDrop?:number, minWeeks?:number, minWeekN?:number, minR2?:number, weakR2?:number, weakChange?:number}} [opts]
   */
  function sentimentDrift(weeklyIndexSeries, opts) {
    const o = Object.assign({ weeks: 12, alertDrop: -5, minWeeks: 8, minWeekN: 3, minR2: 0.2, weakR2: 0.1, weakChange: 8 }, opts || {});
    const all = (Array.isArray(weeklyIndexSeries) ? weeklyIndexSeries : []).filter(p => p && isNum(p.value)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(-o.weeks);
    const solid = all.filter(p => !isNum(p.n) || p.n >= o.minWeekN);
    const thinWeeks = all.length - solid.length;
    const asOf = toIso(nowOf(o));
    const params = { weeks: o.weeks, minWeeks: o.minWeeks, minWeekN: o.minWeekN, minR2: o.minR2, weakR2: o.weakR2, weakChange: o.weakChange,
      alertRule: 'slope × 12 < ' + o.alertDrop + ' on ≥ ' + o.minWeeks + ' weeks with n ≥ ' + o.minWeekN + ' and r² ≥ ' + o.minR2 + ' (or r² ≥ ' + o.weakR2 + ' with |change| ≥ ' + o.weakChange + ')' };
    const s = solid;
    const n = s.length;
    const totalN = sum(s.map(p => (isNum(p.n) ? p.n : 0)));
    if (n < 4) {
      return result({ method: 'ols', params, n, weeksTotal: all.length, thinWeeks, slope: null, intercept: null, projected12w: null, change12w: null, r2: null, alert: false,
        reason: 'too few weeks', reasons: ['too few weeks (' + n + ' usable of ' + all.length + ')'],
        explanation: 'Fewer than 4 usable weeks of sentiment (n=' + n + ' weeks' + (thinWeeks ? ', ' + thinWeeks + ' dropped for n < ' + o.minWeekN : '') + '), so no drift can be measured.', confidence: 'low', asOf });
    }
    const line = olsLine(s.map(p => p.value));
    const fittedEnd = line.intercept + line.slope * (n - 1);
    const change12w = line.slope * 12;
    const projected = clamp(fittedEnd + change12w, 0, 100);
    // 80% prediction interval for the value 12 weeks past the last fitted week, from the OLS residual σ and the
    // leverage of x* = n − 1 + 12: projected ± t(0.9, n−2) · σ · √(1 + 1/n + (x* − x̄)² / Sxx). A weak fit (low r²)
    // widens it; a perfect line collapses it onto the point.
    const xm = (n - 1) / 2;
    let sxx = 0, sse = 0;
    for (let t = 0; t < n; t++) { sxx += (t - xm) ** 2; sse += (s[t].value - (line.intercept + line.slope * t)) ** 2; }
    const df = n - 2;
    const sigma = df > 0 ? Math.sqrt(sse / df) : null;
    const xStar = n - 1 + 12;
    const half = sigma !== null && sxx > 0 ? tQuantile80(df) * sigma * Math.sqrt(1 + 1 / n + (xStar - xm) ** 2 / sxx) : null;
    const projectedLo = half === null ? null : clamp(fittedEnd + change12w - half, 0, 100);
    const projectedHi = half === null ? null : clamp(fittedEnd + change12w + half, 0, 100);
    const slopeSe = sigma !== null && sxx > 0 ? sigma / Math.sqrt(sxx) : null;
    const reasons = [];
    if (n < o.minWeeks) reasons.push('too few weeks (' + n + ' with n ≥ ' + o.minWeekN + '; ' + o.minWeeks + ' needed)');
    if (!(change12w < o.alertDrop)) reasons.push('within threshold (12-week change ' + fmtNum(change12w, 1) + ' vs ' + o.alertDrop + ')');
    const r2 = isNum(line.r2) ? line.r2 : 0;
    const fitOk = r2 >= o.minR2 || (r2 >= o.weakR2 && Math.abs(change12w) >= o.weakChange);
    if (!fitOk) reasons.push('weak fit (r² ' + fmtNum(r2, 2) + ')');
    const alert = reasons.length === 0;
    const reason = alert ? null : /^too few/.test(reasons[0]) ? 'too few weeks' : /^within/.test(reasons[0]) ? 'within threshold' : 'weak fit';
    const explanation = 'Sentiment moves ' + (line.slope >= 0 ? '+' : '') + fmtNum(line.slope, 2) + ' points per week over ' + n + ' weeks (r² ' + fmtNum(line.r2, 2) +
      (thinWeeks ? ', ' + thinWeeks + ' thin week' + (thinWeeks > 1 ? 's' : '') + ' dropped' : '') + '), which points to about ' +
      fmtNum(projected) + ' in 12 weeks if the trend holds' + (projectedLo !== null ? ' (likely ' + fmtRange(projectedLo, projectedHi, 0) + ', 80% band)' : '') +
      (alert ? '; that is a drift alert' : (change12w < o.alertDrop ? '; no alert: ' + reasons[0] : '')) +
      ' (n=' + n + ' weeks' + (totalN ? ', ' + totalN + ' records' : '') + ').';
    const confidence = n >= 12 && line.r2 >= 0.3 ? 'high' : n >= 8 && line.r2 >= o.weakR2 ? 'medium' : 'low';
    return result({ method: 'ols', params, n, weeksTotal: all.length, thinWeeks, slope: round(line.slope, 4), slopeSe: slopeSe === null ? null : round(slopeSe, 4),
      intercept: round(line.intercept, 3), r2: round(line.r2, 4), sigma: sigma === null ? null : round(sigma, 3),
      projected12w: round(projected, 1), projected12wLo: projectedLo === null ? null : round(projectedLo, 1), projected12wHi: projectedHi === null ? null : round(projectedHi, 1), band: 0.8,
      change12w: round(change12w, 2), alert, reason, reasons,
      explanation, confidence, caveats: ['A straight line through weekly means; a single bad week moves the slope.', 'Weeks are spaced by index, so a dropped thin week compresses the axis.'], asOf });
  }
  /** Two-sided 80% Student-t quantile (t₀.₉₀,df), tabulated to df 20 then eased to the normal 1.282. */
  function tQuantile80(df) {
    const T = [null, 3.078, 1.886, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.350, 1.345, 1.341, 1.337, 1.333, 1.330, 1.328, 1.325];
    if (!isNum(df) || df < 1) return 1.282;
    if (df <= 20) return T[Math.floor(df)];
    if (df <= 30) return 1.31;
    if (df <= 60) return 1.296;
    return 1.282;
  }

  /* ------------------------------------------------------------------ */
  /* §4.7 detectorBacktest — replay detectors on planted events          */
  /* ------------------------------------------------------------------ */

  function dailyCounts(records, fromDay, toDay, filterFn) {
    const counts = new Map();
    for (const r of records) {
      if (filterFn && !filterFn(r)) continue;
      const dk = dayKeyOfRecord(r);
      if (dk && dk >= fromDay && dk <= toDay) counts.set(dk, (counts.get(dk) || 0) + 1);
    }
    const out = [];
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push({ key: d, value: counts.get(d) || 0 });
    return out;
  }
  function dailyShare(records, fromDay, toDay, filterFn) {
    const tot = new Map(), hit = new Map();
    for (const r of records) {
      const dk = dayKeyOfRecord(r);
      if (!dk || dk < fromDay || dk > toDay) continue;
      tot.set(dk, (tot.get(dk) || 0) + 1);
      if (filterFn(r)) hit.set(dk, (hit.get(dk) || 0) + 1);
    }
    const out = [];
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) { const n = tot.get(d) || 0; out.push({ key: d, value: n ? (hit.get(d) || 0) / n : 0, n }); }
    return out;
  }
  function weeklyFromDaily(daily) {
    const m = new Map();
    for (const p of daily) { const wk = weekKeyOfDay(p.key); m.set(wk, (m.get(wk) || 0) + p.value); }
    return [...m].map(([key, value]) => ({ key, value }));
  }
  const KNOWN_IDS = {
    category: ['subscription_billing', 'checkout_website', 'shipping_fulfillment', 'missing_damaged', 'taste_quality', 'foreign_material_allergen', 'side_effects', 'adverse_event',
      'efficacy_results', 'price_value', 'customer_service', 'hcp_practitioner', 'marketing_email', 'usage_guidance', 'product_request', 'praise'],
    product: ['prolon_5day', 'prolon_nextgen', 'prolon_reset', 'prolon_52', 'fast_bar', 'fasting_shake', 'l_protein', 'l_pill', 'starter_pack', 'guided_health', 'lnutra_health', 'subscription_account']
  };
  /** Keys of an `expected` object whose string values name a unit/entity the detector should surface. */
  const HINT_ID_KEYS = ['unit', 'value', 'category', 'subcategory', 'product', 'kit_component', 'lot', 'lot_number', 'entity', 'id', 'label', 'segment', 'segments', 'subcategories', 'units', 'categories', 'products'];
  /** Keys whose string values are phrases (bigrams/quotes) rather than ids. */
  const HINT_PHRASE_KEYS = ['bigram', 'phrase', 'phrases', 'bigrams', 'quote', 'text'];
  /** Keys whose values are settings, not units (skipped when collecting ids). */
  const HINT_SKIP_KEYS = ['status', 'metric', 'granularity', 'urgency', 'as_of', 'weekly', 'min_z', 'min_lift', 'min_recent', 'multiplier', 'count', 'hours', 'index_delta_pts', 'detector', 'from', 'to', 'title', 'direction'];
  const UNIT_TYPES = ['category', 'subcategory', 'product', 'kit_component', 'lot', 'bigram', 'segment', 'channel', 'region'];
  const LOT_RE = /\b[A-Z]{2}-\d{4}-[A-Z]\b/g;
  const SNAKE_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g;
  const QUOTE_RE = /["“']([^"”']{3,40})["”']/g;
  const PAIR_RE = /\b[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*\b/g;

  /**
   * Walks an `expected` value (string, array or nested object) and collects id-like strings, phrases and unit/value pairs.
   * Object KEYS are collected only where the key itself names a unit (e.g. `category_share: {checkout_website: .25}`).
   */
  function collectHints(value, key, hints, depth) {
    if (value == null || depth > 4) return;
    if (typeof value === 'string') {
      const v = value.trim();
      if (!v) return;
      if (HINT_PHRASE_KEYS.indexOf(key) >= 0) { hints.phrases.push(v.toLowerCase()); return; }
      if (HINT_SKIP_KEYS.indexOf(key) >= 0) return;
      hints.text.push(v);
      if (key === 'unit') { if (UNIT_TYPES.indexOf(v) >= 0) hints.unitType = v; return; }
      if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(v) || LOT_RE.test(v) || /^[A-Z]{2}-\d{4}-[A-Z]$/.test(v)) hints.ids.add(v);
      LOT_RE.lastIndex = 0;
      if (key === 'value') hints.value = v;
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return;
    if (Array.isArray(value)) { value.forEach(v => collectHints(v, key, hints, depth + 1)); return; }
    if (typeof value === 'object') {
      for (const k of Object.keys(value)) {
        const child = value[k];
        // `<unit>_share: {id: share}` and `{id: count}` maps: the keys are the unit ids
        if (/_share$|_counts?$|^by_/.test(k) && child && typeof child === 'object' && !Array.isArray(child)) {
          for (const id of Object.keys(child)) { hints.ids.add(id); hints.text.push(id); }
          continue;
        }
        collectHints(child, k, hints, depth + 1);
      }
    }
  }
  /**
   * Hints for matching an emerging row to a planted event. Accepts `expected` as a string (legacy) or an object with
   * fields such as unit/value/subcategory/product/lot/bigram/phrase/category_share.
   * @returns {{ids:Set<string>, phrases:string[], unitType:string|null, value:string|null, text:string}}
   */
  function eventHints(ev) {
    const hints = { ids: new Set(), phrases: [], unitType: null, value: null, text: [] };
    if (!ev) return Object.assign(hints, { text: '' });
    for (const k of ['title', 'detail']) if (typeof ev[k] === 'string') hints.text.push(ev[k]);
    for (const k of ['category', 'subcategory', 'product', 'lot', 'value', 'unit', 'kit_component']) if (typeof ev[k] === 'string') collectHints(ev[k], k, hints, 0);
    if (typeof ev.expected === 'string') hints.text.push(ev.expected);
    else collectHints(ev.expected, null, hints, 0);
    const text = hints.text.join(' ');
    for (const id of ['category', 'product']) for (const v of KNOWN_IDS[id]) if (text.indexOf(v) >= 0) hints.ids.add(v);
    const lot = text.match(LOT_RE);
    if (lot) lot.forEach(l => hints.ids.add(l));
    const sub = text.match(SNAKE_RE);
    if (sub) sub.forEach(x => { if (HINT_SKIP_KEYS.indexOf(x) < 0) hints.ids.add(x); });
    // `category/subcategory` pairs as written in titles or legacy string hints: the pair and both halves
    const pairs = text.match(PAIR_RE);
    if (pairs) pairs.forEach(pr => { hints.ids.add(pr); pr.split('/').forEach(half => { if (HINT_SKIP_KEYS.indexOf(half) < 0) hints.ids.add(half); }); });
    const quoted = text.match(QUOTE_RE);
    if (quoted) quoted.forEach(q => hints.phrases.push(q.replace(/["“”']/g, '').toLowerCase()));
    hints.phrases = hints.phrases.filter((p, i, a) => p && a.indexOf(p) === i);
    hints.text = text;
    return hints;
  }
  function detectorKind(ev) {
    const d = String(ev.detector || '').toLowerCase();
    const e = (typeof ev.expected === 'string' ? ev.expected : (ev.expected && typeof ev.expected === 'object' ? JSON.stringify(ev.expected) : '')).toLowerCase();
    if (/neg_share|share/.test(d)) return 'neg_share';
    if (/volume|anomal|zscore|spike/.test(d) || (!d && /anomaly|z\s*≥|z>=/.test(e))) return 'volume';
    if (/emerg|new|ramp|lift/.test(d) || (!d && /emerging|'new'/.test(e))) return 'emerging';
    if (/drift|sentiment/.test(d)) return 'drift';
    if (/p1_cluster|cluster/.test(d)) return 'p1_cluster';
    if (/food_safety/.test(d)) return 'food_safety';
    if (/(^|_)ae(_|$)|adverse/.test(d)) return 'ae';
    if (/sla/.test(d)) return 'sla';
    if (/restricted|phi/.test(d)) return 'restricted';
    if (/noise/.test(d)) return 'noise';
    return null;
  }
  function primaryMatch(row, hints) {
    return hints.unitType && hints.value && row.unit === hints.unitType && idMatches(String(row.value).toLowerCase(), hints.value) ? 1 : 0;
  }
  function idMatches(v, id) {
    const s = String(id).toLowerCase();
    return v === s || v.endsWith('/' + s) || v.startsWith(s + '/');
  }
  /**
   * True when an emerging row names one of the event's units: by unit type + value, by id (also `cat/sub` pairs),
   * by display label, or by phrase for bigram rows.
   */
  function rowMatchesHints(row, hints) {
    const v = String(row.value).toLowerCase();
    const lbl = String(row.label || '').toLowerCase();
    if (hints.unitType && hints.value && row.unit === hints.unitType && idMatches(v, hints.value)) return true;
    for (const id of hints.ids) {
      if (idMatches(v, id)) return true;
      const s = String(id).toLowerCase();
      if (lbl && lbl === s) return true;
      if (row.unit && row.unit !== 'bigram' && UNIT_TYPES.indexOf(row.unit) >= 0) {
        const l = String(labelOf(row.unit === 'subcategory' ? 'subcategory' : row.unit, id) || '').toLowerCase();
        if (l && l !== s && (lbl === l || lbl.endsWith('› ' + l))) return true;
      }
    }
    for (const ph of hints.phrases) if (row.unit === 'bigram' && (v === ph || ph.indexOf(v) >= 0 || v.indexOf(ph) >= 0)) return true;
    return false;
  }
  /**
   * Replay the detectors at each planted event's window end and report whether it fired and how early.
   * @param {object[]} records
   * @param {Array<{id, from, to, title, detector, expected}>} plantedEvents
   * @param {{now?:Date|string}} [opts]
   */
  function detectorBacktest(records, plantedEvents, opts) {
    const recs = (Array.isArray(records) ? records : []).filter(r => r && r.received_at);
    const events = Array.isArray(plantedEvents) ? plantedEvents : [];
    const asOf = toIso(nowOf(opts || {}));
    const allDays = recs.map(dayKeyOfRecord).filter(Boolean).sort();
    const firstDay = allDays[0] || null;
    const nonNoise = recs.filter(r => !r.is_noise);
    const rows = [];
    for (const ev of events) {
      const kind = detectorKind(ev);
      const from = String(ev.from || '').slice(0, 10), to = String(ev.to || ev.from || '').slice(0, 10);
      const row = { id: ev.id, title: ev.title, detector: ev.detector || null, kind, from, to, detected: null, leadDays: null, detail: '' };
      if (!kind || !isDayKey(from) || !isDayKey(to) || !firstDay) {
        row.detail = kind ? 'Event window is missing dates.' : 'No detector is mapped to "' + (ev.detector || 'unknown') + '".';
        rows.push(row);
        continue;
      }
      const hints = eventHints(ev);
      const inWindow = r => { const dk = dayKeyOfRecord(r); return dk >= from && dk <= to; };
      const windowRecs = recs.filter(inWindow);
      if (kind === 'volume' || kind === 'neg_share' || kind === 'p1_cluster') {
        const start = addDays(from, -56) < firstDay ? firstDay : addDays(from, -56);
        let series;
        if (kind === 'volume') series = dailyCounts(nonNoise, start, to);
        else if (kind === 'p1_cluster') series = dailyCounts(nonNoise, start, to, r => r.urgency === 'P1' || r.urgency === 'P0');
        else {
          const cat = [...hints.ids].find(id => KNOWN_IDS.category.indexOf(id) >= 0);
          series = dailyShare(nonNoise, start, to, r => isNegative(r) && (!cat || r.category === cat));
        }
        const daily = detectAnomalies(series, { mode: kind === 'neg_share' ? 'share' : 'count', asOf: to });
        const weekly = kind === 'neg_share' ? { events: [] } : detectAnomalies(weeklyFromDaily(series), { mode: 'count', asOf: to });
        const hitsDaily = daily.events.filter(e => e.direction === 'up' && e.end >= from && e.start <= to);
        const fromWeek = weekKeyOfDay(from), toWeek = weekKeyOfDay(to);
        const hitsWeekly = weekly.events.filter(e => e.direction === 'up' && e.end >= fromWeek && e.start <= toWeek);
        let clusterHit = null;
        if (kind === 'p1_cluster') {
          for (let i = 2; i < series.length; i++) {
            const c = series[i].value + series[i - 1].value + series[i - 2].value;
            if (c >= 6 && series[i].key >= from && series[i].key <= to) { clusterHit = series[i].key; break; }
          }
        }
        const firstHit = [hitsDaily.map(e => (e.start > from ? e.start : from)), clusterHit ? [clusterHit] : []].flat().sort()[0] || null;
        row.detected = !!(firstHit || hitsWeekly.length);
        if (firstHit) row.leadDays = Math.max(0, daysBetween(firstHit, to));
        else if (hitsWeekly.length) row.leadDays = Math.max(0, daysBetween(addDays(to, -dowOfDay(to)), to));
        const peak = hitsDaily.slice().sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0] || hitsWeekly[0];
        row.detail = row.detected ? (peak ? 'Flagged ' + peak.start + (peak.end !== peak.start ? '–' + peak.end : '') + ' at z ' + fmtNum(peak.z, 1) + ' (' + peak.severity + ')' : 'Flagged by the 3-day P1 cluster rule on ' + clusterHit) +
          '; ' + plural(windowRecs.length) + ' in the window.' : 'No day or week in the window exceeded z 2 (' + plural(windowRecs.length) + ' in the window).';
      } else if (kind === 'emerging') {
        const checkpoints = [];
        for (let d = addDays(from, 6); d < to; d = addDays(d, 7)) checkpoints.push(d);
        checkpoints.push(to);
        let firstHit = null, best = null;
        for (const cp of checkpoints) {
          const res = detectEmerging(recs, { asOf: cp + 'T23:59:59Z' });
          const flagged = res.rows.filter(r => r.status === 'new' || r.status === 'emerging');
          const matched = hints.ids.size || hints.phrases.length ? flagged.filter(r => rowMatchesHints(r, hints)) : flagged.filter(r => r.sampleIds.some(id => windowRecs.some(w => w.id === id)));
          if (matched.length) {
            // prefer the row that names the event's primary unit/value, then the largest surprise
            const top = matched.sort((a, b) => (primaryMatch(b, hints) - primaryMatch(a, hints)) || (b.z - a.z))[0];
            if (!firstHit) { firstHit = cp; best = top; }
            if (cp === to) best = top;
          }
        }
        row.detected = !!firstHit;
        row.leadDays = firstHit ? Math.max(0, daysBetween(firstHit, to)) : null;
        row.detail = firstHit ? best.label + ' flagged ' + best.status + ' by ' + firstHit + ' (z ' + fmtNum(best.z, 1) + ', ' + best.cR + ' recent vs ' + fmtNum(best.expected, 1) + ' expected).'
          : 'No matching unit reached new or emerging by ' + to + ' (' + plural(windowRecs.length) + ' in the window).';
      } else if (kind === 'drift') {
        const cat = [...hints.ids].find(id => KNOWN_IDS.category.indexOf(id) >= 0) || null;
        const pool = nonNoise.filter(r => (!cat || r.category === cat) && isNum(sentimentIndex(r)) && r.sentiment_label !== 'unscored');
        const start = addDays(to, -83);
        const byWeek = groupBy(pool.filter(r => { const dk = dayKeyOfRecord(r); return dk >= start && dk <= to; }), weekKeyOfRecord);
        const weekly = [...byWeek].map(([key, list]) => ({ key, value: mean(list.map(sentimentIndex)), n: list.length })).sort((a, b) => (a.key < b.key ? -1 : 1));
        const drift = sentimentDrift(weekly, { weeks: 12 });
        row.detected = !!drift.alert;
        row.leadDays = 0;
        row.detail = (cat ? labelOf('category', cat) + ' ' : '') + 'slope ' + fmtNum(drift.slope, 2) + ' pts/week over ' + drift.n + ' weeks (12-week change ' + fmtNum(drift.change12w, 1) + '; alert below −5).';
      } else {
        const test = { ae: r => r.serious_ae || r.is_adverse_event, food_safety: r => r.food_safety, sla: r => r.sla_frt_breached, restricted: r => r.restricted,
          noise: r => r.is_noise || r.status === 'closed_noise' }[kind];
        const hits = windowRecs.filter(test);
        row.detected = hits.length > 0;
        row.leadDays = hits.length ? Math.max(0, daysBetween(hits.map(dayKeyOfRecord).sort()[0], to)) : null;
        row.detail = hits.length ? plural(hits.length) + ' carry the ' + kind.replace('_', ' ') + ' flag in the window.' : 'No record in the window carries the ' + kind.replace('_', ' ') + ' flag.';
      }
      rows.push(row);
    }
    const evaluated = rows.filter(r => r.detected !== null);
    const detected = evaluated.filter(r => r.detected).length;
    const recall = evaluated.length ? round(detected / evaluated.length, 4) : null;
    const explanation = events.length ? 'The detectors catch ' + detected + ' of ' + evaluated.length + ' planted events when replayed at each window end (recall ' + fmtPct(recall) + '; n=' + recs.length + ' records, ' +
      (rows.length - evaluated.length) + ' events without a mapped detector).' : 'No planted events to replay (n=' + recs.length + ' records).';
    return result({ method: 'replay', params: { detectors: ['rolling_z', 'poisson_surprise', 'ols_drift', 'flag_presence'], checkpointDays: 7 }, n: recs.length, rows, recall, detected, evaluated: evaluated.length,
      explanation, confidence: evaluated.length >= 8 ? 'high' : evaluated.length >= 4 ? 'medium' : 'low', caveats: ['Replay uses only records received on or before each window end.'], asOf });
  }

  /* ------------------------------------------------------------------ */
  /* rateInterval                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Interval for a rate: Wilson for proportions, Poisson (Garwood/Byar) for counts.
   * @param {number} k
   * @param {number} n
   * @param {'wilson'|'poisson'} kind
   * @param {number} [z=1.96]
   * @returns {{lo:number|null, hi:number|null}}
   */
  function rateInterval(k, n, kind, z) {
    if (!isNum(k)) return { lo: null, hi: null };
    if (kind === 'poisson') { const iv = poissonExact(k, z || 1.96); return { lo: round(iv.lo, 4), hi: round(iv.hi, 4) }; }
    if (!isNum(n) || n <= 0) return { lo: null, hi: null };
    const iv = wilson(k, n, z || 1.96);
    return { lo: round(iv.lo, 6), hi: round(iv.hi, 6) };
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                              */
  /* ------------------------------------------------------------------ */

  VOC.predict = {
    version: '1.0.0',
    defaults: { holtWinters: HW_DEFAULTS, sentiment: SENTIMENT_DEFAULTS, anomalies: ANOMALY_DEFAULTS, emerging: EMERGING_DEFAULTS, logistic: LOGISTIC_DEFAULTS, csat: CSAT_DEFAULTS, drivers: DRIVER_DEFAULTS,
      churn: { intercept: CHURN_INTERCEPT, features: CHURN_FEATURES, tiers: CHURN_TIERS }, escalation: ESCALATION_WEIGHTS },
    forecastVolume, forecastSentiment, detectAnomalies, detectEmerging, churnModel, churnRisk, churnTable, escalationRisk, predictCsat, projectedNps,
    driverAnalysis, whatChanged, slaBreachProb, seasonalityIndex, sentimentDrift, backtest, detectorBacktest, rateInterval,
    // numerical kernels and rules exposed for tests and the Methods view
    solveLinear, ridgeFit, fitLogistic, auc, chi2Yates, chiSquareSurvival1, benjaminiHochberg, normalSurvival,
    forecastConfidence, eventHints
  };
})();
