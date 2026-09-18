/* L-Nutra Voice of the Customer — store.js (A1)
 * Integration hub: records (seed + imported + live), filters, overlays with audit, derived state, settings,
 * saved views and a tiny event emitter. SPEC §4.5. PURE*: loads under jsc; every browser API is guarded and
 * every sibling module (classify, metrics, predict, alerts, db, router) is called only when present.
 */
window.VOC = window.VOC || {};
(function () {
  'use strict';

  const LS_SETTINGS = 'voc.settings';
  const LS_VIEWS = 'voc.savedViews';
  const OVERLAY_FIELDS = ['status', 'assignee', 'tags', 'notes', 'category', 'subcategory', 'product', 'urgency', 'recovered', 'is_adverse_event', 'serious_ae'];
  /* Reportable Food Registry (24h) covers conventional food and dietary supplements; programs and accounts carry no RFR clock. */
  const RFR_CLASSES = ['conventional_food', 'supplement'];
  const LIST_FILTERS = ['product', 'category', 'subcategory', 'channel', 'sales_channel', 'segment', 'region', 'urgency', 'status', 'sentiment', 'assignee', 'flags'];
  const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };
  const HOUR_MS = 3600000;
  /** Below this many prior-period records a KPI delta is withheld (deltaNote explains why). */
  const COMPARE_MIN_N = 20;
  /** Open records older than this many days count toward dq.openOlderThan45d. */
  const STALE_OPEN_DAYS = 45;
  /** Quoted-reply and signature markers that make VOC.classify.preprocess worth running on stored text (cheap pre-check). */
  const RE_TEXT_MARKERS = /wrote:\s*$|-{2,}\s*Original Message|^Sent from (?:my |Mail|Outlook|Yahoo Mail)|^Get Outlook for |^Sent via |^-- ?$|^From: [^\n]+\n(?:Sent|Date): |^_{6,}\s*$/mi;

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const listeners = {};
  const st = {
    meta: {}, asOfMs: null, newestNonSeedMs: 0, ready: false, version: 0,
    base: new Map(), seedIds: new Set(), fingerprints: new Map(), overlays: new Map(),
    customers: new Map(), practices: new Map(), orders: { _total: {} }, seedOrders: { _total: {} },
    settings: null, filters: null, customViews: [], batches: new Map(), lastBatchId: null,
    dq: { duplicatesRemoved: 0, reclassifyFailures: 0 },
    cache: {}
  };

  function U() { return VOC.util; }
  function E() { return VOC.enums; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function deepEqual(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
  function safeNum(x) { return isNum(x) ? x : null; }

  function lsGet(key) {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsSet(key, value) {
    if (typeof localStorage === 'undefined') return;
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage unavailable: settings live in memory for this session */ }
  }

  function bump() {
    st.version += 1;
    st.cache = {};
  }

  function emit(evt, payload) {
    (listeners[evt] || []).slice().forEach((fn) => {
      try { fn(payload); } catch (e) { if (typeof console !== 'undefined') console.error('VOC.store listener for ' + evt + ' failed:', e && e.message ? e.message : e); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */

  function defaultSettings() {
    return {
      clock: 'demo', theme: 'system',
      sla: Object.assign({}, E().SLA_FRT_HOURS),
      agents: (st.meta && Array.isArray(st.meta.agents)) ? st.meta.agents.slice() : [],
      me: 'You',
      connector: {
        provider_preset: 'gmail', host: 'imap.gmail.com', port: 993, username: '', auth: 'password', folder: 'INBOX', sent_folder: '[Gmail]/Sent Mail',
        agent_addresses: [], poll_interval_s: 300, since: '', max_per_poll: 200, sender_allow: [], sender_deny: [], subject_include: '', subject_exclude: '',
        skip_autoreplies: true, order_prefix: '#', restricted_recipients: ['Med.Ed@l-nutra.com'], restricted_domains: [], redact_restricted_on_server: true, data_dir: ''
      },
      redactRestricted: true,
      predictParams: {},      // Forecast Lab slider state (alpha, beta, gamma, phi, horizon, level) — views/predict.js
      reportActions: []       // actions carried forward between weekly/monthly reports — views/reports.js
    };
  }
  /**
   * Merge a settings patch over `base`. sla/connector/predictParams merge one level deep; every other key, including
   * keys this module does not know about, is copied as-is so views can persist their own state (unknown keys survive
   * localStorage round-trips because the stored object is merged over defaultSettings() at init).
   */
  function mergeSettings(base, patch) {
    const out = Object.assign({}, base);
    if (!patch || typeof patch !== 'object') return out;
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      if ((k === 'sla' || k === 'connector' || k === 'predictParams') && v && typeof v === 'object' && !Array.isArray(v)) out[k] = Object.assign({}, base[k] || {}, v);
      else if (v !== undefined) out[k] = Array.isArray(v) ? v.slice() : v;
    });
    if (out.clock !== 'real') out.clock = 'demo';
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Clock                                                               */
  /* ------------------------------------------------------------------ */

  /** @returns {Date} demo as_of while settings.clock === 'demo' and no newer imported mail exists; else wall clock. */
  function now() {
    if (!st.settings || st.settings.clock === 'real' || st.asOfMs === null) return new Date();
    if (st.newestNonSeedMs > st.asOfMs) return new Date();
    return new Date(st.asOfMs);
  }
  function clockMode() {
    return (st.settings && st.settings.clock === 'real') || st.asOfMs === null || st.newestNonSeedMs > st.asOfMs ? 'real' : 'demo';
  }

  /* ------------------------------------------------------------------ */
  /* Filters                                                             */
  /* ------------------------------------------------------------------ */

  function defaultFilters() {
    const f = { range: { preset: '30d', from: null, to: null }, compare: 'prior_period', search: '', restrictedQueue: false, customer: null };
    LIST_FILTERS.forEach((k) => { f[k] = []; });
    f.range = resolveRange(f.range, now());
    return f;
  }
  function resolveRange(range, nowDate) {
    const u = U();
    const today = u.dayKey(nowDate);
    const r = range || {};
    if (r.preset === 'custom') {
      let from = /^\d{4}-\d{2}-\d{2}$/.test(r.from || '') ? r.from : u.addDays(today, -29);
      let to = /^\d{4}-\d{2}-\d{2}$/.test(r.to || '') ? r.to : today;
      if (from > to) { const t = from; from = to; to = t; }
      return { preset: 'custom', from, to };
    }
    const preset = RANGE_DAYS[r.preset] ? r.preset : '30d';
    return { preset, from: u.addDays(today, -(RANGE_DAYS[preset] - 1)), to: today };
  }
  function normalizeList(v) {
    if (v === null || v === undefined || v === '') return [];
    const arr = Array.isArray(v) ? v : String(v).split(',');
    return arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
  }
  function filters() { return clone(st.filters); }
  /**
   * Merge a partial FilterState. Lists accept arrays or comma strings; range presets resolve against now().
   * @param {object} patch
   */
  function setFilters(patch) {
    st.filters = mergeFilters(st.filters, patch);
    st.cache.filtered = null; st.cache.compare = null; st.cache.derived = null;
    emit('filtered', filters());
  }
  /** Pure merge of a partial FilterState onto `base` (a fresh object; nothing is mutated or emitted). */
  function mergeFilters(base, patch) {
    const f = clone(base);
    const p = patch || {};
    if (p.range) f.range = resolveRange(Object.assign({}, f.range, p.range), now());
    if (p.compare !== undefined) f.compare = ['prior_period', 'prior_year', 'none'].includes(p.compare) ? p.compare : 'prior_period';
    LIST_FILTERS.forEach((k) => { if (p[k] !== undefined) f[k] = normalizeList(p[k]); });
    if (p.search !== undefined) f.search = p.search === null ? '' : String(p.search);
    if (p.restrictedQueue !== undefined) f.restrictedQueue = !!p.restrictedQueue;
    if (p.customer !== undefined) f.customer = normalizeCustomer(p.customer);
    return f;
  }
  /** A customer filter is one customer_id (c_ + 16 hex); anything else clears it so a hash never carries a name or address. */
  function normalizeCustomer(v) {
    const s = v === null || v === undefined ? '' : String(v).trim();
    return /^c_[0-9a-f]{16}$/.test(s) ? s : null;
  }
  function resetFilters() {
    st.filters = defaultFilters();
    st.cache.filtered = null; st.cache.compare = null; st.cache.derived = null;
    emit('filtered', filters());
  }
  /**
   * Drop every memo (filtered, compare, derived, per-record prediction caches), bump version() and emit 'filtered'
   * so views re-render and derived() re-runs alert evaluation. Use after VOC.alerts.setRule or any external change
   * that derived() cannot see; setFilters({}) keeps working as the older idiom.
   * @param {string} [reason] carried on the emitted payload as `reason`
   */
  function invalidate(reason) {
    bump();
    const f = filters();
    if (reason) f.reason = String(reason);
    emit('filtered', f);
  }
  /**
   * The non-range part of the store's own matcher: chips (product, category, …, assignee, flags), the restricted
   * queue toggle and the free-text search — without the date range, so a view can honor the filter bar on a
   * full-history series. Lists accept arrays or comma strings; missing keys match everything.
   * @param {object[]} records  projected records (store.all() or a subset)
   * @param {object} [filters]  partial FilterState; defaults to the current filters
   * @returns {object[]}
   */
  function applyDimensionFilters(records, filtersIn) {
    const src = filtersIn && typeof filtersIn === 'object' ? filtersIn : st.filters;
    const f = { restrictedQueue: !!src.restrictedQueue, customer: normalizeCustomer(src.customer) };
    LIST_FILTERS.forEach((k) => { f[k] = normalizeList(src[k]); });
    const search = String(src.search || '').trim().toLowerCase();
    return (Array.isArray(records) ? records : []).filter((r) => r && matchesNonRange(r, f, search));
  }
  /** Serialize the current FilterState: 'range=30d&product=a,b' or 'range=custom&from=…&to=…'. */
  function toQuery(f) {
    const s = f || st.filters;
    const parts = ['range=' + s.range.preset];
    if (s.range.preset === 'custom') parts.push('from=' + s.range.from, 'to=' + s.range.to);
    if (s.compare !== 'prior_period') parts.push('compare=' + s.compare);
    LIST_FILTERS.forEach((k) => { if (s[k] && s[k].length) parts.push(k + '=' + s[k].map(encodeURIComponent).join(',')); });
    if (s.search) parts.push('search=' + encodeURIComponent(s.search));
    if (s.restrictedQueue) parts.push('restricted=1');
    if (s.customer) parts.push('customer=' + encodeURIComponent(s.customer));
    return parts.join('&');
  }
  /** Parse a query string into a FilterState patch (does not apply it). */
  function parseQuery(str) {
    const q = String(str || '').replace(/^[?#]/, '');
    const out = {};
    if (!q) return out;
    const range = {};
    q.split('&').forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf('=');
      const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1));
      if (k === 'range') range.preset = v;
      else if (k === 'from') range.from = v;
      else if (k === 'to') range.to = v;
      else if (k === 'compare') out.compare = v;
      else if (k === 'search' || k === 'q') out.search = v;
      else if (k === 'restricted') out.restrictedQueue = v === '1' || v === 'true';
      else if (k === 'customer') out.customer = normalizeCustomer(v);
      else if (LIST_FILTERS.includes(k)) out[k] = normalizeList(v.split(',').map(decodeURIComponent));
    });
    if (range.preset || range.from || range.to) out.range = Object.assign({ preset: range.from ? 'custom' : '30d' }, range);
    return out;
  }
  /** Apply a query string produced by toQuery(); unspecified keys reset to defaults. Returns the resulting FilterState. */
  function fromQuery(str) {
    const patch = parseQuery(str);
    st.filters = defaultFilters();
    setFilters(patch);
    return filters();
  }

  /* ------------------------------------------------------------------ */
  /* Records: normalization, fingerprints, registration                  */
  /* ------------------------------------------------------------------ */

  function isoOrNull(x) {
    if (!x) return null;
    const d = new Date(x);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  function fingerprintOf(rec) {
    const u = U();
    const email = u.normalizeEmail(rec.from_email) || '';
    const subject = String(rec.subject || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return u.fnv64(email + '|' + (rec.received_at || '') + '|' + subject);
  }
  function isRawEmail(item) {
    return !!item && typeof item === 'object' && item.received_at === undefined && item.date !== undefined &&
      (item.subject !== undefined || item.from_email !== undefined || item.message_id !== undefined);
  }
  function htmlToText(html) {
    return String(html || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  function headerNoise(headers) {
    const h = headers || {};
    if (h.auto_submitted && String(h.auto_submitted).toLowerCase() !== 'no') return 'auto_reply';
    if (h.x_autoreply) return 'auto_reply';
    if (h.precedence && /bulk|junk|list/i.test(String(h.precedence))) return 'newsletter';
    if (h.list_id || h.list_unsubscribe) return 'newsletter';
    return null;
  }

  /**
   * Strip quoted-reply tails and signatures from rec.text through VOC.classify.preprocess, keeping the original in
   * rec.text_raw. Runs only when a marker is present (one regex test per record) and is idempotent: cleaned text carries
   * no marker, and an existing text_raw is never overwritten. Mutates and returns rec.
   * @param {object} rec
   * @returns {object}
   */
  function cleanText(rec) {
    if (!rec || typeof rec.text !== 'string' || !rec.text) return rec;
    const cls = VOC.classify;
    if (!cls || typeof cls.preprocess !== 'function' || !RE_TEXT_MARKERS.test(rec.text)) return rec;
    let cleaned;
    try { cleaned = cls.preprocess(rec.text); } catch (e) { return rec; }
    if (typeof cleaned !== 'string' || !cleaned.trim() || cleaned === rec.text) return rec;
    if (rec.text_raw === undefined || rec.text_raw === null) rec.text_raw = rec.text;
    rec.text = cleaned;
    return rec;
  }

  /** Fill every §2 field with a default so downstream code never sees undefined. */
  function normalizeRecord(item, source) {
    const u = U();
    const r = Object.assign({}, item);
    r.schema_version = 1;
    r.received_at = isoOrNull(r.received_at || r.date) || now().toISOString();
    r.channel = r.channel || 'email';
    r.sales_channel = r.sales_channel || 'dtc_web';
    r.from_name = r.from_name ?? null;
    r.from_email = r.from_email ?? null;
    r.subject = r.subject == null ? '' : String(r.subject);
    r.text = r.text == null ? (r.html ? htmlToText(r.html) : '') : String(r.text);
    cleanText(r);
    r.language = r.language || 'unknown';
    r.has_attachment = !!r.has_attachment;
    r.product = r.product || 'general';
    r.product_variant = r.product_variant ?? null;
    r.kit_component = r.kit_component ?? null;
    r.product_class = r.product_class || E().productClass(r.product);
    r.category = r.category || 'usage_guidance';
    r.subcategory = r.subcategory || (E().subcategories(r.category)[0] || {}).id || 'general_question';
    r.secondary_categories = Array.isArray(r.secondary_categories) ? r.secondary_categories : [];
    r.sentiment = isNum(r.sentiment) ? r.sentiment : 0;
    r.sentiment_min = isNum(r.sentiment_min) ? r.sentiment_min : r.sentiment;
    r.sentiment_label = r.sentiment_label || (r.language !== 'en' ? 'unscored' : (r.sentiment > 0.15 ? 'positive' : r.sentiment < -0.15 ? 'negative' : 'neutral'));
    r.nps = isNum(r.nps) ? r.nps : null;
    r.rating = isNum(r.rating) ? r.rating : null;
    r.csat = isNum(r.csat) ? r.csat : null;
    r.urgency = ['P0', 'P1', 'P2', 'P3'].includes(r.urgency) ? r.urgency : 'P2';
    r.status = E().STATUSES[r.status] ? r.status : 'new';
    r.first_response_at = isoOrNull(r.first_response_at);
    r.resolved_at = isoOrNull(r.resolved_at);
    r.reopen_count = isNum(r.reopen_count) ? r.reopen_count : 0;
    r.service_fields_source = r.service_fields_source || (source === 'seed' ? 'seed' : 'unavailable');
    r.escalated_to = r.escalated_to || 'none';
    r.is_adverse_event = !!r.is_adverse_event;
    r.serious_ae = !!r.serious_ae;
    r.ae_criteria = Array.isArray(r.ae_criteria) ? r.ae_criteria : [];
    r.contraindication_flags = Array.isArray(r.contraindication_flags) ? r.contraindication_flags : [];
    r.food_safety = !!r.food_safety;
    r.lot_number = r.lot_number ?? null;
    r.order_id = r.order_id ?? null;
    r.hcp_code = r.hcp_code ?? null;
    r.claim_related = !!r.claim_related;
    r.cancel_intent = !!r.cancel_intent;
    r.restricted = !!r.restricted || r.segment === 'lnh_patient' || r.segment === 'hcp_patient';
    r.customer_id = r.customer_id || ('c_' + u.fnv64(u.normalizeEmail(r.from_email) || ('anon|' + r.received_at + '|' + r.subject)));
    r.segment = r.segment || 'first_time';
    r.region = r.region || 'US';
    r.thread_id = r.thread_id || ('t_' + u.fnv64((u.normalizeEmail(r.from_email) || '') + '|' + r.subject.trim().toLowerCase()));
    r.is_first_contact = r.is_first_contact === undefined ? true : !!r.is_first_contact;
    r.message_id = r.message_id ?? null;
    r.source = (r.source && !(r.source === 'seed' && source && source !== 'seed')) ? r.source : (source || 'manual');
    r.is_noise = !!r.is_noise;
    r.noise_reason = r.noise_reason ?? null;
    if (r.is_noise && r.status !== 'closed_noise') r.status = 'closed_noise';
    r.assignee = r.assignee ?? null;
    r.tags = Array.isArray(r.tags) ? r.tags : [];
    r.notes = Array.isArray(r.notes) ? r.notes : [];
    const c = r.classifier || {};
    r.classifier = {
      confidence: isNum(c.confidence) ? c.confidence : 0,
      rule_category: c.rule_category || r.category,
      rule_subcategory: c.rule_subcategory || r.subcategory,
      rule_product: c.rule_product || r.product,
      manual_override: !!c.manual_override,
      needs_review: c.needs_review === undefined ? false : !!c.needs_review
    };
    if (c.seed_sentiment_label) r.classifier.seed_sentiment_label = c.seed_sentiment_label;
    if (!r.id) {
      const prefix = (r.source === 'imap') ? 'em_' : 'im_';
      r.id = prefix + fingerprintOf(r);
    }
    return r;
  }

  /** Build a Record from a RawEmail through VOC.classify when present, else a conservative local default. */
  function recordFromRaw(raw, source) {
    const src = raw.source || source || 'eml';
    const cls = VOC.classify;
    if (cls && typeof cls.classifyRecord === 'function') {
      const rec = cls.classifyRecord(raw, { now: now(), settings: st.settings, source: src });
      if (rec) return normalizeRecord(Object.assign({ source: src }, rec), src);
    }
    const reason = headerNoise(raw.headers);
    const rec = normalizeRecord({
      received_at: raw.date, from_name: raw.from_name ?? null, from_email: raw.from_email ?? null, subject: raw.subject || '',
      text: raw.text || (raw.html ? htmlToText(raw.html) : ''), has_attachment: Array.isArray(raw.attachments) && raw.attachments.length > 0,
      message_id: raw.message_id ?? null, thread_id: raw.thread_id || null, source: src, status: 'new',
      is_noise: !!reason, noise_reason: reason, language: 'unknown', sentiment_label: 'unscored',
      classifier: { confidence: 0, rule_category: 'usage_guidance', rule_subcategory: 'general_question', rule_product: 'general', manual_override: false, needs_review: true }
    }, src);
    return rec;
  }

  function registerBase(rec, source) {
    st.base.set(rec.id, rec);
    st.fingerprints.set(fingerprintOf(rec), rec.id);
    if (source === 'seed') st.seedIds.add(rec.id);
    else {
      const ms = Date.parse(rec.received_at);
      if (isNum(ms) && ms > st.newestNonSeedMs) st.newestNonSeedMs = ms;
    }
  }

  /** Outbound (Sent-folder) mail: set first_response_at on the earliest unanswered inbound record of the same thread. */
  function applyOutbound(raw) {
    const ids = new Set([raw.in_reply_to].concat(raw.references || []).filter(Boolean));
    const at = isoOrNull(raw.date);
    if (!at) return null;
    let target = null;
    st.base.forEach((rec) => {
      const sameThread = (raw.thread_id && rec.thread_id === raw.thread_id) || (rec.message_id && ids.has(rec.message_id));
      if (!sameThread || rec.received_at > at) return;
      if (!target || rec.received_at < target.received_at) target = rec;
    });
    if (!target || (target.first_response_at && target.first_response_at <= at)) return null;
    target.first_response_at = at;
    target.service_fields_source = 'sent_folder';
    return target;
  }

  /* ------------------------------------------------------------------ */
  /* Derived fields                                                      */
  /* ------------------------------------------------------------------ */

  function slaFor(urgency) {
    const sla = (st.settings && st.settings.sla) || E().SLA_FRT_HOURS;
    return isNum(sla[urgency]) ? sla[urgency] : (E().SLA_FRT_HOURS[urgency] || 24);
  }

  /**
   * Attach derived fields (§2) to a record in place and return it. Churn/escalation/predicted CSAT are lazy getters
   * that call VOC.predict when present and yield null otherwise.
   * @param {object} rec record with overlays applied
   * @param {Date} [nowDate]
   * @returns {object}
   */
  function derive(rec, nowDate) {
    const u = U();
    const en = E();
    const nowD = nowDate || now();
    const nowMs = nowD.getTime();
    const recMs = Date.parse(rec.received_at);
    const p = u.parts(rec.received_at);

    rec.sentiment_index = isNum(rec.sentiment) ? (rec.sentiment + 1) / 2 * 100 : null;
    rec.is_complaint = (isNum(rec.sentiment) && rec.sentiment < -0.1) || en.COMPLAINT_CATEGORIES.includes(rec.category);
    rec.is_detractor = isNum(rec.nps) && rec.nps <= 6;
    rec.is_promoter = isNum(rec.nps) && rec.nps >= 9;
    rec.age_hours = isNum(recMs) ? Math.max(0, (nowMs - recMs) / HOUR_MS) : null;
    const frtMs = rec.first_response_at ? Date.parse(rec.first_response_at) : NaN;
    rec.frt_hours = isNum(frtMs) && isNum(recMs) ? Math.max(0, (frtMs - recMs) / HOUR_MS) : null;
    const resMs = rec.resolved_at ? Date.parse(rec.resolved_at) : NaN;
    rec.resolution_hours = isNum(resMs) && isNum(recMs) ? Math.max(0, (resMs - recMs) / HOUR_MS) : null;
    rec.sla_frt_hours = slaFor(rec.urgency);
    rec.is_open = en.OPEN_STATUSES.includes(rec.status);
    rec.sla_frt_breached = rec.frt_hours !== null ? rec.frt_hours > rec.sla_frt_hours : (rec.is_open && rec.age_hours !== null && rec.age_hours > rec.sla_frt_hours);
    rec.day_key = p ? u.dayKey(rec.received_at) : null;
    rec.week_key = p ? u.weekKey(rec.received_at) : null;
    rec.month_key = p ? u.monthKey(rec.received_at) : null;
    rec.dow = p ? p.dow : null;
    rec.hour = p ? p.hour : null;

    const cls = rec.product_class || en.productClass(rec.product);
    let clock = 'none';
    if (rec.serious_ae) clock = 'medwatch_15bd';
    else if (rec.food_safety && RFR_CLASSES.includes(cls)) clock = 'rfr_24h';
    rec.regulatory_clock = clock;
    // The 15-business-day serious-AE report is statutory for dietary supplements (L-Pill); on a conventional-food kit or a
    // program the same clock tracks a voluntary MedWatch report. RFR is statutory wherever it applies.
    rec.regulatory_clock_basis = clock === 'none' ? null : (clock === 'medwatch_15bd' && cls !== 'supplement' ? 'voluntary' : 'statutory');
    rec.regulatory_deadline = null;
    rec.business_days_remaining = null;
    rec.hours_remaining = null;
    if (clock !== 'none' && isNum(recMs)) {
      rec.regulatory_deadline = clock === 'medwatch_15bd' ? u.addBusinessDays(rec.received_at, 15) : new Date(recMs + 24 * HOUR_MS).toISOString();
      const dlMs = Date.parse(rec.regulatory_deadline);
      rec.hours_remaining = isNum(dlMs) ? (dlMs - nowMs) / HOUR_MS : null;
      if (clock === 'medwatch_15bd') rec.business_days_remaining = u.businessDaysBetween(nowD.toISOString(), rec.regulatory_deadline);
    }

    defineLazy(rec, 'churn_score', () => churnScoreFor(rec.customer_id));
    defineLazy(rec, 'escalation_score', () => (rec.is_open ? escalationScoreFor(rec) : null));
    defineLazy(rec, 'pred_csat', () => (rec.is_open ? predCsatFor(rec.id) : null));
    return rec;
  }

  function defineLazy(obj, key, compute) {
    let done = false, value = null;
    Object.defineProperty(obj, key, {
      enumerable: true, configurable: true,
      get() { if (!done) { done = true; value = compute(); } return value; },
      set(v) { done = true; value = v; }
    });
  }

  function predictCache(name) {
    if (!st.cache.predict) st.cache.predict = {};
    if (!st.cache.predict[name]) st.cache.predict[name] = new Map();
    return st.cache.predict[name];
  }
  /**
   * The one churn model every score in this store uses: VOC.predict.churnModel fitted once per data version over
   * all records and customers (a gated logistic fit, or the heuristic bundle when the fit is rejected or impossible).
   * Views pass it to churnRisk/churnTable as opts.model so the Overview KPI, the Inbox drawer and the Customers table
   * agree on method and scores instead of depending on which view rendered first.
   * @returns {object|null} the bundle ({model, method, auc, …}) or null when predict is absent
   */
  function churnModel() {
    const pr = VOC.predict;
    if (!pr || typeof pr.churnModel !== 'function') return null;
    const cache = predictCache('churnModel');
    if (cache.has('_bundle')) return cache.get('_bundle');
    let bundle = null;
    try { bundle = pr.churnModel(all(), st.customers, { now: now() }) || null; } catch (e) { bundle = null; }
    cache.set('_bundle', bundle);
    return bundle;
  }
  /** 'fitted' | 'heuristic': the method churnModel() settled on for this data version. */
  function churnMethod() {
    const b = churnModel();
    return b && b.model ? 'fitted' : 'heuristic';
  }
  function churnScoreFor(customerId) {
    const pr = VOC.predict;
    if (!customerId || !pr || typeof pr.churnRisk !== 'function') return null;
    const cache = predictCache('churn');
    if (cache.has(customerId)) return cache.get(customerId);
    let score = null;
    try {
      const r = pr.churnRisk(customerId, all(), st.customers, { now: now(), model: churnModel() });
      score = r && isNum(r.score) ? r.score : null;
    } catch (e) { score = null; }
    cache.set(customerId, score);
    return score;
  }
  function escalationScoreFor(rec) {
    const pr = VOC.predict;
    if (!pr || typeof pr.escalationRisk !== 'function') return null;
    const cache = predictCache('escalation');
    if (cache.has(rec.id)) return cache.get(rec.id);
    let score = null;
    try {
      const r = pr.escalationRisk(rec, all(), { now: now() });
      score = r && isNum(r.score) ? r.score : null;
    } catch (e) { score = null; }
    cache.set(rec.id, score);
    return score;
  }
  function predCsatFor(id) {
    const pr = VOC.predict;
    if (!pr || typeof pr.predictCsat !== 'function') return null;
    const cache = predictCache('csat');
    if (!cache.has('_all')) {
      const map = new Map();
      try {
        const r = pr.predictCsat(all(), { now: now() });
        ((r && r.predictions) || []).forEach((pdn) => { if (pdn && isNum(pdn.pred)) map.set(pdn.id, pdn.pred); });
      } catch (e) { /* prediction unavailable: pred_csat stays null */ }
      cache.set('_all', map);
    }
    const m = cache.get('_all');
    return m.has(id) ? m.get(id) : null;
  }

  /* ------------------------------------------------------------------ */
  /* Projection: base + overlay + derived                                */
  /* ------------------------------------------------------------------ */

  function project(base, nowDate) {
    const rec = Object.assign({}, base);
    rec.tags = (base.tags || []).slice();
    rec.notes = (base.notes || []).slice();
    rec.secondary_categories = (base.secondary_categories || []).slice();
    rec.classifier = Object.assign({}, base.classifier);
    rec.recovered = null;
    const ov = st.overlays.get(base.id);
    if (ov) {
      OVERLAY_FIELDS.forEach((f) => { if (ov[f] !== undefined) rec[f] = Array.isArray(ov[f]) ? ov[f].slice() : ov[f]; });
      if (ov.category !== undefined || ov.subcategory !== undefined || ov.product !== undefined) {
        rec.classifier.manual_override = true;
        rec.classifier.needs_review = false;
      }
      if (ov.product !== undefined) rec.product_class = E().productClass(rec.product);
      rec.audit = (ov.audit || []).slice();
      rec.updated_at = ov.updated_at || null;
    } else {
      rec.audit = [];
      rec.updated_at = null;
    }
    return derive(rec, nowDate);
  }

  function nowMinuteKey() { return Math.floor(now().getTime() / 60000); }

  /** Every record including noise, overlays applied, derived fields, newest first. */
  function allWithNoise() {
    const key = st.version + ':' + nowMinuteKey();
    if (st.cache.allWithNoise && st.cache.allWithNoise.key === key) return st.cache.allWithNoise.list;
    const nowD = now();
    const list = [];
    st.base.forEach((b) => list.push(project(b, nowD)));
    list.sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0));
    st.cache.allWithNoise = { key, list };
    st.cache.all = null;
    return list;
  }
  /** Non-noise records, overlays applied, derived fields, newest first. */
  function all() {
    const full = allWithNoise();
    if (!st.cache.all || st.cache.all.src !== full) st.cache.all = { src: full, list: full.filter((r) => !r.is_noise) };
    return st.cache.all.list;
  }
  /** One projected record by id, or null. */
  function record(id) {
    const base = st.base.get(id);
    return base ? project(base, now()) : null;
  }

  /* ------------------------------------------------------------------ */
  /* Filtering                                                           */
  /* ------------------------------------------------------------------ */

  const FLAG_PREDICATES = {
    open: (r) => r.is_open,
    unassigned: (r) => r.is_open && !r.assignee,
    sla_breached: (r) => r.is_open && r.frt_hours === null && r.sla_frt_breached,
    aging_48h: (r) => r.is_open && r.age_hours > 48,
    detractor_followup: (r) => r.is_detractor && r.recovered === null,
    needs_review: (r) => !!(r.classifier && r.classifier.needs_review),
    ae: (r) => r.is_adverse_event,
    serious_ae: (r) => r.serious_ae,
    food_safety: (r) => r.food_safety,
    p0_p1: (r) => r.urgency === 'P0' || r.urgency === 'P1',
    mine: (r) => !!r.assignee && r.assignee === ((st.settings && st.settings.me) || 'You'),
    restricted: (r) => r.restricted,
    complaint: (r) => r.is_complaint,
    detractor: (r) => r.is_detractor,
    promoter: (r) => r.is_promoter
  };

  function matchesNonRange(rec, f, search) {
    for (let i = 0; i < LIST_FILTERS.length; i++) {
      const k = LIST_FILTERS[i];
      const list = f[k];
      if (!list || !list.length) continue;
      if (k === 'flags') {
        for (let j = 0; j < list.length; j++) {
          const pred = FLAG_PREDICATES[list[j]];
          if (pred && !pred(rec)) return false;
        }
      } else if (k === 'sentiment') {
        if (!list.includes(rec.sentiment_label)) return false;
      } else if (k === 'assignee') {
        if (!list.includes(rec.assignee === null || rec.assignee === undefined ? 'unassigned' : rec.assignee)) return false;
      } else if (!list.includes(rec[k])) return false;
    }
    if (f.restrictedQueue && !rec.restricted) return false;
    if (f.customer && rec.customer_id !== f.customer) return false;
    if (search) {
      // A restricted (PHI-adjacent) record outside the restricted queue is searchable by id only while client-side
      // redaction is on, so a distinctive word from its subject, body, sender or order never confirms the record exists.
      const readable = !rec.restricted || f.restrictedQueue || (st.settings && st.settings.redactRestricted === false);
      const hay = readable
        ? ((rec.subject || '') + '\n' + (rec.text || '') + '\n' + (rec.from_name || '') + '\n' + (U().normalizeEmail(rec.from_email) || '') + '\n' + (rec.order_id || '') + '\n' + rec.id).toLowerCase()
        : String(rec.id).toLowerCase();
      if (hay.indexOf(search) < 0) return false;
    }
    return true;
  }
  function applyFilters(records, f, from, to) {
    const search = (f.search || '').trim().toLowerCase();
    return records.filter((r) => r.day_key !== null && r.day_key >= from && r.day_key <= to && matchesNonRange(r, f, search));
  }
  function filtersKey() { return JSON.stringify(st.filters); }

  /** all() ∩ current filters (range on received_at CT dates, inclusive). */
  function filtered() {
    const key = st.version + ':' + nowMinuteKey() + ':' + filtersKey();
    if (st.cache.filtered && st.cache.filtered.key === key) return st.cache.filtered.list;
    const f = st.filters;
    const list = applyFilters(all(), f, f.range.from, f.range.to);
    st.cache.filtered = { key, list };
    return list;
  }
  function shiftYear(dateKey, n) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dim = U().daysInMonth((y + n) + '-' + (m < 10 ? '0' : '') + m);
    return (y + n) + '-' + (m < 10 ? '0' : '') + m + '-' + (Math.min(d, dim) < 10 ? '0' : '') + Math.min(d, dim);
  }
  /** Prior-period range for the current filters, or null when compare === 'none'. */
  function compareRange(f) {
    const u = U();
    const s = f || st.filters;
    if (s.compare === 'none') return null;
    const { from, to } = s.range;
    if (s.compare === 'prior_year') return { from: shiftYear(from, -1), to: shiftYear(to, -1) };
    const len = u.daysBetween(from, to) + 1;
    return { from: u.addDays(from, -len), to: u.addDays(from, -1) };
  }
  /** Same filters shifted to the prior period (or prior year); [] when compare === 'none'. */
  function compareSet() {
    const key = st.version + ':' + nowMinuteKey() + ':' + filtersKey();
    if (st.cache.compare && st.cache.compare.key === key) return st.cache.compare.list;
    const cr = compareRange(st.filters);
    const list = cr ? applyFilters(all(), st.filters, cr.from, cr.to) : [];
    st.cache.compare = { key, list };
    return list;
  }

  /* ------------------------------------------------------------------ */
  /* Aggregates and derived state                                        */
  /* ------------------------------------------------------------------ */

  function sentimentRoll() {
    return { count: 0, neg: 0, pos: 0, neu: 0, scored: 0, sum: 0 };
  }
  function rollAdd(roll, r) {
    roll.count += 1;
    if (r.sentiment_label !== 'unscored' && isNum(r.sentiment)) {
      roll.scored += 1;
      roll.sum += r.sentiment;
      if (r.sentiment_label === 'negative') roll.neg += 1;
      else if (r.sentiment_label === 'positive') roll.pos += 1;
      else roll.neu += 1;
    }
  }
  function rollOut(roll) {
    return {
      count: roll.count, neg: roll.neg, pos: roll.pos, neu: roll.neu,
      meanSentiment: roll.scored ? roll.sum / roll.scored : null,
      negShare: roll.scored ? roll.neg / roll.scored : null,
      posShare: roll.scored ? roll.pos / roll.scored : null
    };
  }
  function bucketByKey(records, keyField, keys) {
    const rolls = new Map();
    keys.forEach((k) => rolls.set(k, sentimentRoll()));
    records.forEach((r) => {
      const k = r[keyField];
      if (!rolls.has(k)) rolls.set(k, sentimentRoll());
      rollAdd(rolls.get(k), r);
    });
    return keys.map((k) => Object.assign({ key: k }, rollOut(rolls.get(k))));
  }
  function dayKeys(from, to) {
    const u = U();
    const out = [];
    let d = from;
    let guard = 0;
    while (d <= to && guard < 5000) { out.push(d); d = u.addDays(d, 1); guard += 1; }
    return out;
  }
  function weekKeys(from, to) {
    const u = U();
    const out = [];
    let monday = u.weekStart(u.weekKey(from));
    const last = u.weekKey(to);
    let guard = 0;
    while (guard < 1000) {
      const wk = u.weekKey(monday);
      out.push(wk);
      if (wk === last) break;
      monday = u.addDays(monday, 7);
      guard += 1;
    }
    return out;
  }
  function byDimension(records, field, ids, n) {
    const rolls = new Map();
    ids.forEach((id) => rolls.set(id, sentimentRoll()));
    records.forEach((r) => {
      const k = r[field];
      if (!rolls.has(k)) rolls.set(k, sentimentRoll());
      rollAdd(rolls.get(k), r);
    });
    const en = E();
    const out = [];
    rolls.forEach((roll, id) => {
      const o = rollOut(roll);
      out.push({ id, label: en.label(field, id), count: o.count, share: n ? o.count / n : 0, meanSentiment: o.meanSentiment, negShare: o.negShare, neg: o.neg, pos: o.pos, neu: o.neu });
    });
    return out;
  }

  /**
   * Describe the comparison window: how many records it holds and whether it is too thin to support a delta.
   * A window is thin when it has fewer than COMPARE_MIN_N records or starts before the earliest record in the store
   * (the prior period then predates the data, and any delta would compare against a near-empty set).
   * @param {object[]} compare compareSet()
   * @param {{from:string,to:string}|null} cr compareRange()
   * @param {string|null} earliest day_key of the earliest non-noise record, or null when the store is empty
   * @returns {{n:number, from:string|null, to:string|null, thin:boolean, reason:string|null, earliest:string|null}}
   */
  function compareMetaFor(compare, cr, earliest) {
    const n = compare.length;
    if (!cr) return { n, from: null, to: null, thin: false, reason: null, earliest };
    let reason = null;
    if (earliest && cr.from < earliest) reason = 'no data before ' + earliest + ' (prior period n=' + n + ')';
    else if (n < COMPARE_MIN_N) reason = 'prior period has too few records (n=' + n + ')';
    return { n, from: cr.from, to: cr.to, thin: reason !== null, reason, earliest };
  }
  function earliestDayKey(records) {
    let min = null;
    records.forEach((r) => { if (r.day_key && (min === null || r.day_key < min)) min = r.day_key; });
    return min;
  }

  /**
   * KPIs for the current set with prior-period values. When the comparison is thin (compareMeta.thin) `delta` is null and
   * `deltaNote` explains why; `prev` keeps the prior value so narration can still say "vs X" without a percentage.
   */
  function computeKpis(records, compare, ctx, ctxPrev, hasCompare, compareMeta) {
    const u = U();
    const kpis = {};
    const thin = !!(compareMeta && compareMeta.thin);
    const note = thin ? compareMeta.reason : null;
    function deltaFor(value, prevValue, unit) {
      if (value === null || prevValue === null || thin) return null;
      return u.fmt.delta(value, prevValue, { unit });
    }
    const m = VOC.metrics;
    if (m && m.registry && typeof m.compute === 'function') {
      Object.keys(m.registry).forEach((id) => {
        const def = m.registry[id] || {};
        let cur = null, prev = null;
        try { cur = m.compute(id, records, ctx); } catch (e) { cur = null; }
        if (hasCompare) { try { prev = m.compute(id, compare, ctxPrev); } catch (e) { prev = null; } }
        const value = cur ? safeNum(cur.value) : null;
        const prevValue = prev ? safeNum(prev.value) : null;
        const interval = cur && cur.interval && isNum(cur.interval.lo) && isNum(cur.interval.hi) ? { lo: cur.interval.lo, hi: cur.interval.hi } : null;
        kpis[id] = {
          id, label: def.label || id, unit: def.unit || 'count', direction: def.direction || 'neutral',
          value, n: cur && isNum(cur.n) ? cur.n : 0, prev: prevValue, prevN: prev && isNum(prev.n) ? prev.n : (hasCompare ? 0 : null),
          delta: deltaFor(value, prevValue, def.unit),
          deltaNote: hasCompare && prevValue !== null && value !== null ? note : null,
          interval, extra: cur && cur.extra !== undefined ? cur.extra : null
        };
      });
      return kpis;
    }
    const prevValue = hasCompare ? compare.length : null;
    kpis.volume = {
      id: 'volume', label: 'Volume', unit: 'count', direction: 'neutral', value: records.length, n: records.length, prev: prevValue, prevN: prevValue,
      delta: deltaFor(records.length, prevValue, 'count'), deltaNote: prevValue !== null ? note : null, interval: null, extra: null
    };
    return kpis;
  }

  function computeDq(records, from, to) {
    const n = records.length;
    let needsReview = 0, nonEnglish = 0, agreeCat = 0, catN = 0, agreeSent = 0, sentN = 0;
    records.forEach((r) => {
      if (r.classifier && r.classifier.needs_review) needsReview += 1;
      if (r.language !== 'en') nonEnglish += 1;
      if (r.classifier && r.classifier.rule_category) {
        catN += 1;
        if (r.classifier.rule_category === r.category) agreeCat += 1;
      }
      if (r.classifier && r.classifier.seed_sentiment_label && r.language === 'en') {
        sentN += 1;
        if (r.classifier.seed_sentiment_label === r.sentiment_label) agreeSent += 1;
      }
    });
    let noise = 0;
    allWithNoise().forEach((r) => { if (r.is_noise && r.day_key >= from && r.day_key <= to) noise += 1; });
    // Stale backlog is a whole-store fact (like the SLA alert), not a property of the filtered range.
    let openStale = 0, openAll = 0;
    all().forEach((r) => {
      if (!r.is_open) return;
      openAll += 1;
      if (isNum(r.age_hours) && r.age_hours > STALE_OPEN_DAYS * 24) openStale += 1;
    });
    const months = Object.keys((st.orders && st.orders._total) || {}).filter((k) => isNum(st.orders._total[k]));
    return {
      n, needsReviewPct: n ? needsReview / n : null, nonEnglishPct: n ? nonEnglish / n : null, noiseDropped: noise,
      duplicatesRemoved: st.dq.duplicatesRemoved, agreementCategory: catN ? agreeCat / catN : null, agreementCategoryN: catN,
      agreementSentiment: sentN ? agreeSent / sentN : null, agreementSentimentN: sentN, ordersCoverageMonths: months.length,
      reclassifyFailures: st.dq.reclassifyFailures,
      openOlderThan45d: openStale, openTotal: openAll, staleOpenDays: STALE_OPEN_DAYS
    };
  }

  function regulatoryState(records) {
    const openSerious = records.filter((r) => r.serious_ae && r.is_open);
    const openFoodSafety = records.filter((r) => r.food_safety && r.is_open);
    const deadlines = records.filter((r) => r.regulatory_clock !== 'none' && r.is_open && r.regulatory_deadline)
      .map((r) => ({ rec: r, clock: r.regulatory_clock, deadline: r.regulatory_deadline, remaining: r.hours_remaining, businessDaysRemaining: r.business_days_remaining }))
      .sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0));
    return { openSerious, openFoodSafety, deadlines };
  }

  /**
   * Memoized DerivedState for the current filters (SPEC §4.5). Recomputed when records, overlays, settings or filters change.
   * Beyond the §4.5 shape it carries:
   *  - compareMeta {n, from, to, thin, reason, earliest}: the comparison window; `thin` when it holds fewer than 20 records
   *    or starts before the earliest record. When thin, every kpis[id].delta is null and kpis[id].deltaNote says why
   *    ('prior period has too few records (n=5)' / 'no data before 2025-09-15 (prior period n=5)'); prev and prevN stay.
   *  - dq.openOlderThan45d / dq.openTotal / dq.staleOpenDays: open-state backlog over the whole store (not the range).
   * @returns {object}
   */
  function derived() {
    const key = st.version + ':' + nowMinuteKey() + ':' + filtersKey();
    if (st.cache.derived && st.cache.derived.key === key) return st.cache.derived.value;
    const u = U();
    const en = E();
    const nowD = now();
    const f = clone(st.filters);
    const records = filtered();
    const compare = compareSet();
    const cr = compareRange(st.filters);
    const n = records.length;
    const everything = all();
    const ctx = {
      now: nowD, from: f.range.from, to: f.range.to, orders: st.orders, ordersInRange, customers: st.customers, allRecords: everything,
      sla: st.settings.sla, settings: st.settings, churnMethod: churnMethod()
    };
    const ctxPrev = cr ? Object.assign({}, ctx, { from: cr.from, to: cr.to }) : null;
    const compareMeta = compareMetaFor(compare, cr, earliestDayKey(everything));

    const value = {
      now: nowD, clockMode: clockMode(), filters: f, records, compare, compareRange: cr, compareMeta, n, allRecords: everything,
      kpis: computeKpis(records, compare, ctx, ctxPrev, !!cr, compareMeta),
      byDay: bucketByKey(records, 'day_key', dayKeys(f.range.from, f.range.to)),
      byWeek: bucketByKey(records, 'week_key', weekKeys(f.range.from, f.range.to)),
      byCategory: byDimension(records, 'category', Object.keys(en.CATEGORIES), n),
      byProduct: byDimension(records, 'product', Object.keys(en.PRODUCTS), n),
      bySubcategory: byDimension(records, 'subcategory', [], n).map((row) => Object.assign(row, { category: en.categoryOf(row.id) })),
      byChannel: byDimension(records, 'channel', Object.keys(en.CHANNELS), n),
      bySegment: byDimension(records, 'segment', Object.keys(en.SEGMENTS), n),
      regulatory: regulatoryState(everything),
      alerts: [],
      dq: computeDq(records, f.range.from, f.range.to),
      meta: st.meta,
      settings: clone(st.settings)
    };
    value.bySubcategory.sort((a, b) => b.count - a.count);
    if (VOC.alerts && typeof VOC.alerts.evaluate === 'function') {
      try { value.alerts = VOC.alerts.evaluate(value, { predict: VOC.predict }) || []; } catch (e) { value.alerts = []; }
    }
    st.cache.derived = { key, value };
    return value;
  }

  /* ------------------------------------------------------------------ */
  /* Customers, practices, orders                                        */
  /* ------------------------------------------------------------------ */

  function customers() { return st.customers; }
  function customer(id) { return st.customers.get(id) || null; }
  function recordsFor(customerId) { return all().filter((r) => r.customer_id === customerId); }
  function practices() { return st.practices; }
  function orders() { return st.orders; }
  /**
   * Orders in a CT date range, prorated by days for partial months. Null when any month in the span lacks data.
   * The prorated total is returned unrounded (a one-day slice of a 23-order month is 0.77, not 1) so per-order
   * metrics and daily series keep an exact denominator; VOC.metrics.perOrders rounds n for display.
   * @param {string} fromIso
   * @param {string} toIso
   * @param {string|null} [productId]
   * @returns {number|null}
   */
  function ordersInRange(fromIso, toIso, productId = null) {
    const u = U();
    const series = productId ? st.orders[productId] : (st.orders && st.orders._total);
    if (!series) return null;
    const from = u.dayKey(fromIso), to = u.dayKey(toIso);
    if (!from || !to || from > to) return null;
    let m = from.slice(0, 7);
    const lastM = to.slice(0, 7);
    let total = 0;
    let guard = 0;
    while (m <= lastM && guard < 240) {
      if (!isNum(series[m])) return null;
      const dim = u.daysInMonth(m);
      const mStart = m + '-01';
      const mEnd = m + '-' + (dim < 10 ? '0' : '') + dim;
      const s = from > mStart ? from : mStart;
      const e = to < mEnd ? to : mEnd;
      total += series[m] * (u.daysBetween(s, e) + 1) / dim;
      m = u.addMonths(m, 1);
      guard += 1;
    }
    return total;
  }
  function setOrders(obj) {
    // File-sourced order tables pass through the importers' sanitizer (product/month key shapes, finite counts, no prototype keys).
    const imp = VOC.importers;
    const clean = imp && typeof imp.sanitizeOrders === 'function' && obj && typeof obj === 'object' ? imp.sanitizeOrders(obj) : obj;
    st.orders = clean && typeof clean === 'object' ? clone(Object.assign({ _total: {} }, clean)) : { _total: {} };
    persistMeta('orders', st.orders);
    bump();
    emit('records:changed', { reason: 'orders' });
  }

  /* ------------------------------------------------------------------ */
  /* Persistence helpers                                                 */
  /* ------------------------------------------------------------------ */

  function dbReady() { return !!(VOC.db && typeof VOC.db.bulkPut === 'function'); }
  function persistRecords(recs) {
    if (!dbReady()) return Promise.resolve(0);
    return VOC.db.bulkPut('records', recs.map((r) => clone(r))).catch(() => 0);
  }
  function persistOverlay(ov) {
    if (!dbReady()) return Promise.resolve(null);
    return VOC.db.put('overlays', clone(ov)).catch(() => null);
  }
  function persistMeta(id, value) {
    if (!dbReady()) return Promise.resolve(null);
    return VOC.db.put('meta', { id, value: clone(value) }).catch(() => null);
  }

  /* ------------------------------------------------------------------ */
  /* Mutations                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Add RawEmail or Record items. RawEmail is classified through VOC.classify when present. Dedupes by id then fingerprint,
   * persists non-seed records to VOC.db, emits 'records:changed'.
   * @param {Array} items
   * @param {string} source 'imap'|'eml'|'mbox'|'csv'|'json'|'manual'|'seed'
   * @returns {Promise<{added:number, duplicates:number, noise:number, needsReview:number, nonEnglish:number, responses:number}>}
   */
  function addRecords(items, source) {
    const summary = { added: 0, duplicates: 0, noise: 0, needsReview: 0, nonEnglish: 0, responses: 0 };
    const toPersist = [];
    (items || []).forEach((item) => {
      if (!item || typeof item !== 'object') return;
      let rec;
      if (isRawEmail(item)) {
        if (item.direction === 'outbound') {
          const target = applyOutbound(item);
          if (target) { summary.responses += 1; toPersist.push(target); }
          return;
        }
        rec = recordFromRaw(item, source);
      } else {
        const needsClassification = !item.category || !item.sentiment_label;
        if (needsClassification && VOC.classify && typeof VOC.classify.classifyRecord === 'function') {
          const out = VOC.classify.classifyRecord(item, { now: now(), settings: st.settings, source });
          rec = normalizeRecord(Object.assign({}, item, out || {}), source);
        } else {
          rec = normalizeRecord(item, source);
        }
      }
      if (st.base.has(rec.id) || st.fingerprints.has(fingerprintOf(rec))) { summary.duplicates += 1; return; }
      registerBase(rec, source);
      summary.added += 1;
      if (rec.is_noise) summary.noise += 1;
      if (rec.classifier && rec.classifier.needs_review) summary.needsReview += 1;
      if (rec.language !== 'en') summary.nonEnglish += 1;
      if (source !== 'seed') toPersist.push(rec);
    });
    st.dq.duplicatesRemoved += summary.duplicates;
    const work = [];
    if (toPersist.length) work.push(persistRecords(toPersist));
    if (summary.duplicates) work.push(persistMeta('dq', st.dq));
    if (summary.added || summary.responses) {
      bump();
      emit('records:changed', Object.assign({ source }, summary));
      if (summary.added && clockMode() === 'real' && st.settings.clock !== 'real') emit('clock:changed', 'real');
    }
    return Promise.all(work).then(() => summary);
  }

  function auditEntry(at, actor, field, from, to, extra) {
    return Object.assign({ at, by: actor || 'You', field, from: from === undefined ? null : clone(from), to: to === undefined ? null : clone(to) }, extra || {});
  }
  function overlayFor(id) {
    return st.overlays.get(id) || { id, audit: [], updated_at: null };
  }
  function applyPatch(id, patch, actor, at) {
    const base = st.base.get(id);
    if (!base) return false;
    const current = project(base, now());
    const ov = overlayFor(id);
    let changed = false;
    Object.keys(patch || {}).forEach((key) => {
      if (!OVERLAY_FIELDS.includes(key)) return;
      const to = patch[key] === undefined ? null : patch[key];
      const from = current[key] === undefined ? null : current[key];
      if (deepEqual(from, to)) return;
      ov[key] = clone(to);
      ov.audit.push(auditEntry(at, actor, key, from, to));
      changed = true;
    });
    if (changed) {
      ov.updated_at = at;
      st.overlays.set(id, ov);
      persistOverlay(ov);
    }
    return changed;
  }
  function snapshotOverlays(ids) {
    return ids.map((id) => ({ id, before: st.overlays.has(id) ? clone(st.overlays.get(id)) : null }));
  }

  /**
   * Update overlay-owned fields of one record with an append-only audit trail. Returns the projected record (or null).
   * @param {string} id
   * @param {object} patch subset of status/assignee/tags/notes/category/subcategory/product/urgency/recovered/is_adverse_event/serious_ae
   * @param {string} [actor='You']
   * @returns {object|null}
   */
  function update(id, patch, actor = 'You') {
    if (!st.base.has(id)) return null;
    const at = now().toISOString();
    const snapshot = snapshotOverlays([id]);
    if (applyPatch(id, patch, actor, at)) {
      const batchId = U().uid('b');
      st.batches.set(batchId, { at, actor, entries: snapshot });
      st.lastBatchId = batchId;
      bump();
      emit('records:changed', { ids: [id], batchId });
    }
    return record(id);
  }
  /**
   * Apply one patch to many records as an undoable batch.
   * @returns {string} batchId
   */
  function bulkUpdate(ids, patch, actor = 'You') {
    const at = now().toISOString();
    const list = (ids || []).filter((id) => st.base.has(id));
    const snapshot = snapshotOverlays(list);
    let changed = 0;
    list.forEach((id) => { if (applyPatch(id, patch, actor, at)) changed += 1; });
    const batchId = U().uid('b');
    st.batches.set(batchId, { at, actor, entries: snapshot });
    st.lastBatchId = batchId;
    if (changed) {
      bump();
      emit('records:changed', { ids: list, batchId });
    }
    return batchId;
  }
  /** Id of the most recent update/bulkUpdate batch, for toast Undo. */
  function lastBatchId() { return st.lastBatchId; }
  /**
   * Revert a batch. Field values return to their pre-batch state; the audit trail keeps every entry and appends undo entries.
   * @param {string} batchId
   * @returns {boolean}
   */
  function undo(batchId) {
    const batch = st.batches.get(batchId);
    if (!batch) return false;
    const at = now().toISOString();
    const nowD = now();
    const ids = [];
    batch.entries.forEach((entry) => {
      const base = st.base.get(entry.id);
      const cur = st.overlays.get(entry.id);
      if (!base || !cur) return;
      const beforeRec = project(base, nowD);
      const restored = entry.before ? clone(entry.before) : { id: entry.id, audit: [], updated_at: null };
      const audit = cur.audit.slice();
      st.overlays.set(entry.id, restored);
      const afterRec = project(base, nowD);
      OVERLAY_FIELDS.forEach((f) => {
        if (!deepEqual(beforeRec[f], afterRec[f])) audit.push(auditEntry(at, batch.actor, f, beforeRec[f], afterRec[f], { undo: batchId }));
      });
      restored.audit = audit;
      restored.updated_at = at;
      persistOverlay(restored);
      ids.push(entry.id);
    });
    st.batches.delete(batchId);
    if (st.lastBatchId === batchId) st.lastBatchId = null;
    bump();
    emit('records:changed', { ids, undo: batchId });
    return true;
  }
  /**
   * Append a note to a record (overlay-owned), with an audit entry.
   * @returns {object|null} projected record
   */
  function addNote(id, text, actor = 'You') {
    const base = st.base.get(id);
    const body = String(text || '').trim();
    if (!base || !body) return record(id);
    const at = now().toISOString();
    const current = project(base, now());
    const ov = overlayFor(id);
    ov.notes = current.notes.concat([{ at, by: actor, text: body }]);
    ov.audit.push(auditEntry(at, actor, 'note', null, body));
    ov.updated_at = at;
    st.overlays.set(id, ov);
    persistOverlay(ov);
    bump();
    emit('records:changed', { ids: [id] });
    return record(id);
  }
  function overlays() { return st.overlays; }

  function sanitizeAudit(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((a) => a && typeof a === 'object' && typeof a.field === 'string').map((a) => {
      const at = isoOrNull(a.at) || now().toISOString();
      return Object.assign({}, clone(a), { at, by: a.by ? String(a.by) : 'Unknown', from: a.from === undefined ? null : clone(a.from), to: a.to === undefined ? null : clone(a.to) });
    });
  }
  /**
   * Reinstate Overlay objects (for example from a backup's `overlays` array) with their original audit trail instead
   * of replaying them through update()/addNote(). Only ids that exist in the store are applied; overlay-owned fields
   * outside OVERLAY_FIELDS are dropped. An existing overlay for the same id is replaced. One audit entry
   * ({field:'overlay', to:'restored'}) records the import itself.
   * @param {object[]} list  Overlay[] ({id, status?, assignee?, tags?, notes?, …, audit?: AuditEntry[], updated_at?})
   * @param {{actor?:string, emit?:boolean}} [opts]  actor defaults to 'Restore'
   * Enum-valued fields (status, urgency, category, subcategory, product) must be known to VOC.enums and the flag
   * fields must be booleans; an invalid value is dropped and counted in `invalidFields` (the rest of the overlay still applies).
   * @returns {{applied:number, skipped:number, invalidFields:number, ids:string[], unknownIds:string[]}}
   */
  const OVERLAY_ENUM_KIND = { status: 'status', urgency: 'urgency', category: 'category', subcategory: 'subcategory', product: 'product' };
  /** True when an overlay field value is acceptable: enum ids known to VOC.enums, booleans for flags, strings for tags. */
  function overlayFieldValid(k, v) {
    if (OVERLAY_ENUM_KIND[k]) {
      if (v === null) return k === 'subcategory';   // a cleared subcategory is legitimate; the others always hold an id
      if (typeof v !== 'string') return false;
      const table = E().list(OVERLAY_ENUM_KIND[k]);
      return table.some((row) => row.id === v);
    }
    if (k === 'is_adverse_event' || k === 'serious_ae') return typeof v === 'boolean';
    if (k === 'recovered') return v === null || typeof v === 'boolean';
    if (k === 'assignee') return v === null || typeof v === 'string';
    if (k === 'tags') return v.every((t) => typeof t === 'string');
    return true;
  }
  function importOverlays(list, opts) {
    const o = opts || {};
    const actor = o.actor ? String(o.actor) : 'Restore';
    const at = now().toISOString();
    const out = { applied: 0, skipped: 0, invalidFields: 0, ids: [], unknownIds: [] };
    (Array.isArray(list) ? list : []).forEach((src) => {
      if (!src || typeof src !== 'object' || typeof src.id !== 'string') { out.skipped += 1; return; }
      if (!st.base.has(src.id)) { out.skipped += 1; out.unknownIds.push(src.id); return; }
      const ov = { id: src.id, audit: sanitizeAudit(src.audit), updated_at: isoOrNull(src.updated_at) || at };
      let fields = 0;
      OVERLAY_FIELDS.forEach((k) => {
        if (src[k] === undefined) return;
        if (k === 'tags' && !Array.isArray(src[k])) return;
        if (!overlayFieldValid(k, src[k])) { out.invalidFields += 1; return; }
        if (k === 'notes') {
          if (!Array.isArray(src[k])) return;
          ov.notes = src[k].filter((n) => n && typeof n.text === 'string').map((n) => ({ at: isoOrNull(n.at) || at, by: n.by ? String(n.by) : actor, text: String(n.text) }));
        } else ov[k] = clone(src[k]);
        fields += 1;
      });
      if (!fields && !ov.audit.length) { out.skipped += 1; return; }
      ov.audit.push(auditEntry(at, actor, 'overlay', st.overlays.has(src.id) ? 'replaced' : null, 'restored'));
      st.overlays.set(src.id, ov);
      persistOverlay(ov);
      out.applied += 1;
      out.ids.push(src.id);
    });
    if (out.applied) {
      st.batches = new Map(); st.lastBatchId = null;   // undo batches predate the restore and no longer describe reality
      bump();
      if (o.emit !== false) emit('records:changed', { ids: out.ids, reason: 'import_overlays', actor });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Settings, saved views, navigation                                   */
  /* ------------------------------------------------------------------ */

  function settings() { return clone(st.settings); }
  /**
   * Merge a settings patch (sla/connector merge one level deep), persist to localStorage when available, emit events.
   * @param {object} patch
   */
  function setSettings(patch) {
    const before = st.settings;
    st.settings = mergeSettings(before, patch);
    lsSet(LS_SETTINGS, st.settings);
    bump();
    emit('settings:changed', settings());
    if (before.theme !== st.settings.theme) emit('theme:changed', st.settings.theme);
    if (before.clock !== st.settings.clock) {
      st.filters.range = resolveRange(st.filters.range, now());
      emit('clock:changed', clockMode());
      emit('filtered', filters());
    }
  }

  const BUILTIN_VIEWS = [
    { id: 'all_open', name: 'All open', filters: { range: { preset: '12m' }, flags: ['open'] } },
    { id: 'unassigned_p0_p1', name: 'Unassigned P0/P1', filters: { range: { preset: '12m' }, flags: ['open', 'unassigned', 'p0_p1'] } },
    { id: 'sla_breached', name: 'SLA breached', filters: { range: { preset: '12m' }, flags: ['sla_breached'] } },
    { id: 'aging_48h', name: 'Aging > 48h', filters: { range: { preset: '12m' }, flags: ['aging_48h'] } },
    { id: 'detractor_followup', name: 'Detractors awaiting follow-up', filters: { range: { preset: '12m' }, flags: ['detractor_followup'] } },
    { id: 'needs_review', name: 'Needs review', filters: { range: { preset: '12m' }, flags: ['needs_review'] } },
    { id: 'ae_register', name: 'AE register', filters: { range: { preset: '12m' }, flags: ['ae'] } },
    { id: 'restricted', name: 'Restricted queue', filters: { range: { preset: '12m' }, restrictedQueue: true } },
    { id: 'mine', name: 'Mine', filters: { range: { preset: '12m' }, flags: ['mine'] } }
  ];
  /** Built-in inbox views followed by custom saved views. */
  function savedViews() {
    return BUILTIN_VIEWS.map((v) => Object.assign(clone(v), { builtin: true })).concat(st.customViews.map((v) => Object.assign(clone(v), { builtin: false })));
  }
  function saveView(view) {
    if (!view || !view.name) return null;
    const v = { id: view.id || U().uid('view'), name: String(view.name), filters: clone(view.filters || st.filters) };
    const idx = st.customViews.findIndex((x) => x.id === v.id);
    if (idx >= 0) st.customViews[idx] = v; else st.customViews.push(v);
    lsSet(LS_VIEWS, st.customViews);
    emit('views:changed', savedViews());
    return clone(v);
  }
  function deleteView(id) {
    const before = st.customViews.length;
    st.customViews = st.customViews.filter((v) => v.id !== id);
    if (st.customViews.length !== before) {
      lsSet(LS_VIEWS, st.customViews);
      emit('views:changed', savedViews());
      return true;
    }
    return false;
  }
  /**
   * Navigate to a view with a filter patch applied on arrival.
   * With VOC.router present the route carries the query and nothing is set here: the target route applies the
   * filters when it dispatches (app.applyRouteQuery → fromQuery). Setting them first would emit 'filtered' on the
   * origin route, which rewrites the origin's history entry with the drilled query (Back then returns to the wrong
   * state) and re-renders the origin view once just before it unmounts. Without a router the filters are applied
   * directly so callers can read them back.
   * @param {{view:string, filters?:object, id?:string}} target
   */
  function drill(target) {
    const t = target || {};
    const view = t.view || 'inbox';
    let query;
    if (VOC.router && typeof VOC.router.navigate === 'function') {
      query = toQuery(t.filters ? mergeFilters(st.filters, t.filters) : st.filters);
      VOC.router.navigate(view, { id: t.id, query });
    } else {
      if (t.filters) setFilters(t.filters);
      query = toQuery();
    }
    emit('drill', { view, id: t.id || null, query });
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  function loadSeedRecords(seedRecords) {
    const cls = VOC.classify;
    const canReclassify = !!(cls && typeof cls.reclassify === 'function');
    (seedRecords || []).forEach((raw) => {
      let rec = clone(raw);
      const seedLabel = rec.sentiment_label || null;
      cleanText(rec);   // 10% of seed bodies carry a quoted tail + signature on purpose; classify on the customer's own words
      if (canReclassify) {
        try {
          const out = cls.reclassify(rec);
          if (out) rec = out;
        } catch (e) { st.dq.reclassifyFailures += 1; }
      }
      rec = normalizeRecord(rec, 'seed');
      if (seedLabel) rec.classifier.seed_sentiment_label = seedLabel;
      registerBase(rec, 'seed');
    });
    if (st.dq.reclassifyFailures && typeof console !== 'undefined') console.warn('VOC.store: reclassify failed on ' + st.dq.reclassifyFailures + ' seed records; kept seed labels for those.');
  }

  function loadFromDb() {
    if (!dbReady()) return Promise.resolve();
    const db = VOC.db;
    const safe = (p) => p.catch(() => []);
    return db.open().then(() => Promise.all([safe(db.getAll('overlays')), safe(db.getAll('records')), safe(db.getAll('meta'))])).then((res) => {
      const [ovs, recs, metas] = res;
      (ovs || []).forEach((ov) => { if (ov && ov.id) st.overlays.set(ov.id, Object.assign({ audit: [], updated_at: null }, ov)); });
      (recs || []).forEach((r) => {
        if (!r || !r.id || st.base.has(r.id)) return;
        registerBase(normalizeRecord(r, r.source || 'json'), r.source || 'json');
      });
      (metas || []).forEach((m) => {
        if (!m) return;
        if (m.id === 'orders' && m.value && typeof m.value === 'object') st.orders = Object.assign({ _total: {} }, m.value);
        if (m.id === 'dq' && m.value && typeof m.value === 'object') st.dq.duplicatesRemoved = isNum(m.value.duplicatesRemoved) ? m.value.duplicatesRemoved : 0;
      });
    }).catch(() => undefined);
  }

  /**
   * Initialize from a seed (window.VOC_SEED by default), stored overlays/imports and live RawEmail[]. Emits 'ready'.
   * @param {{seed?:object, live?:Array, settings?:object}} [opts]
   * @returns {Promise<void>}
   */
  function init(opts) {
    const o = opts || {};
    const seed = o.seed || (typeof window !== 'undefined' && window.VOC_SEED) || {};
    st.meta = seed.meta || {};
    st.asOfMs = st.meta.as_of ? Date.parse(st.meta.as_of) : null;
    if (!isNum(st.asOfMs)) st.asOfMs = null;
    st.newestNonSeedMs = 0;
    st.base = new Map(); st.seedIds = new Set(); st.fingerprints = new Map(); st.overlays = new Map(); st.batches = new Map(); st.lastBatchId = null;
    st.dq = { duplicatesRemoved: 0, reclassifyFailures: 0 };
    st.ready = false;
    st.settings = mergeSettings(mergeSettings(defaultSettings(), lsGet(LS_SETTINGS)), o.settings);
    st.customViews = Array.isArray(lsGet(LS_VIEWS)) ? lsGet(LS_VIEWS) : [];
    st.customers = new Map((seed.customers || []).map((c) => [c.customer_id, c]));
    st.practices = new Map((seed.practices || []).map((p) => [p.practice_id, p]));
    st.seedOrders = clone(seed.orders_by_month || { _total: {} });
    st.orders = clone(st.seedOrders);
    loadSeedRecords(seed.records);
    st.filters = defaultFilters();
    bump();
    const live = Array.isArray(o.live) ? o.live : ((typeof window !== 'undefined' && Array.isArray(window.VOC_LIVE)) ? window.VOC_LIVE : []);
    return loadFromDb().then(() => (live.length ? addRecords(live, 'imap') : null)).then(() => {
      st.filters = defaultFilters();
      st.ready = true;
      bump();
      emit('ready', { n: st.base.size, clock: clockMode() });
    });
  }
  function ready() { return st.ready; }
  /** Seed metadata (as_of, planted_events, agents). */
  function meta() { return clone(st.meta); }
  /** Monotonic change counter; bumps on any records/overlays/settings change. */
  function version() { return st.version; }

  /**
   * Clear imported records, overlays, settings and saved views; return to the seed. Emits settings/records events.
   * @returns {Promise<void>}
   */
  function resetDemo() {
    const clears = dbReady() ? ['records', 'overlays', 'meta'].map((s) => VOC.db.clear(s).catch(() => null)) : [];
    return Promise.all(clears).then(() => {
      Array.from(st.base.keys()).forEach((id) => { if (!st.seedIds.has(id)) st.base.delete(id); });
      st.fingerprints = new Map();
      st.base.forEach((rec) => st.fingerprints.set(fingerprintOf(rec), rec.id));
      st.overlays = new Map();
      st.batches = new Map();
      st.lastBatchId = null;
      st.newestNonSeedMs = 0;
      st.orders = clone(st.seedOrders);
      st.dq = { duplicatesRemoved: 0, reclassifyFailures: st.dq.reclassifyFailures };
      st.customViews = [];
      [LS_SETTINGS, LS_VIEWS, 'voc.alerts.state', 'voc.alerts.rules', 'voc.alerts.history'].forEach((k) => lsSet(k, null));
      const before = st.settings;
      st.settings = defaultSettings();
      st.filters = defaultFilters();
      bump();
      emit('settings:changed', settings());
      if (before.theme !== st.settings.theme) emit('theme:changed', st.settings.theme);
      emit('clock:changed', clockMode());
      emit('records:changed', { reason: 'reset' });
      emit('filtered', filters());
      emit('views:changed', savedViews());
    });
  }

  function on(evt, fn) {
    if (typeof fn !== 'function') return;
    (listeners[evt] = listeners[evt] || []).push(fn);
  }
  function off(evt, fn) {
    if (!listeners[evt]) return;
    listeners[evt] = listeners[evt].filter((f) => f !== fn);
  }

  VOC.store = {
    init, ready, now, clockMode, meta, version,
    all, allWithNoise, record, filtered, compareSet, compareRange, derive, cleanText,
    filters, setFilters, resetFilters, invalidate, applyDimensionFilters, toQuery, fromQuery, parseQuery, FLAGS: Object.keys(FLAG_PREDICATES),
    derived,
    customers, customer, recordsFor, practices, churnModel, churnMethod,
    orders, ordersInRange, setOrders,
    addRecords, update, bulkUpdate, undo, lastBatchId, addNote, overlays, importOverlays,
    settings, setSettings,
    savedViews, saveView, deleteView, drill, resetDemo,
    on, off
  };
})();
