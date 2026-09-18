/**
 * VOC.exporter — CSV / JSON building and browser downloads (SPEC §4.11).
 *
 * PURE* module: every builder runs under JavaScriptCore; downloadText is
 * browser-only and guarded.
 *
 * Public surface:
 *   recordsCsv(records, {redact, now}) → string   UTF-8 BOM + RFC 4180, every SPEC §2 column + sentiment_index/is_complaint/age_hours
 *   metricsCsv(rows) → string                      generic rows → CSV (one level of nesting flattened)
 *   regulatoryCsv(records, {redact, now, all}) → string   AE / food-safety register with clock and deadline
 *   backupJson(store) → string                     { schema_version, exported_at, seed_meta, records (imported only), overlays, settings, orders }
 *   downloadText(filename, text, mime) → Promise<'download'|'clipboard'|'failed'>   (browser only)
 *   filename(view, ext='csv') → 'lnutra-voc-{view}-{YYYYMMDD}.csv'
 * Additions: RECORD_COLUMNS, REGULATORY_COLUMNS, toCsv(columns, rows), csvCell(v).
 */
window.VOC = window.VOC || {};
VOC.exporter = (function () {
  'use strict';

  var BOM = '﻿';
  var CRLF = '\r\n';

  var COMPLAINT_CATEGORIES = ['subscription_billing', 'checkout_website', 'shipping_fulfillment', 'missing_damaged', 'taste_quality',
    'foreign_material_allergen', 'side_effects', 'adverse_event', 'customer_service', 'price_value'];

  /** Every SPEC §2 record column, in order, plus the derived trio at the end. */
  var RECORD_COLUMNS = ['id', 'schema_version', 'received_at', 'channel', 'sales_channel', 'from_name', 'from_email', 'subject', 'text', 'language',
    'has_attachment', 'product', 'product_variant', 'kit_component', 'product_class', 'category', 'subcategory', 'secondary_categories',
    'sentiment', 'sentiment_min', 'sentiment_label', 'nps', 'rating', 'csat', 'urgency', 'status', 'first_response_at', 'resolved_at', 'reopen_count',
    'service_fields_source', 'escalated_to', 'is_adverse_event', 'serious_ae', 'ae_criteria', 'contraindication_flags', 'food_safety',
    'lot_number', 'order_id', 'hcp_code', 'claim_related', 'cancel_intent', 'restricted', 'customer_id', 'segment', 'region', 'thread_id',
    'is_first_contact', 'message_id', 'source', 'is_noise', 'noise_reason', 'assignee', 'tags', 'notes',
    'classifier_confidence', 'classifier_rule_category', 'classifier_rule_subcategory', 'classifier_rule_product', 'classifier_manual_override', 'classifier_needs_review',
    'sentiment_index', 'is_complaint', 'age_hours'];

  var REGULATORY_COLUMNS = ['id', 'received_at', 'received_ct', 'product', 'product_class', 'product_variant', 'kit_component', 'lot_number',
    'category', 'subcategory', 'is_adverse_event', 'serious_ae', 'ae_criteria', 'contraindication_flags', 'food_safety',
    'regulatory_clock', 'regulatory_clock_basis', 'regulatory_deadline', 'business_days_remaining', 'hours_remaining', 'urgency', 'status', 'escalated_to', 'assignee',
    'from_name', 'from_email', 'order_id', 'hcp_code', 'segment', 'region', 'restricted', 'subject', 'text'];

  /** Derived, never-persisted fields stripped before backup. */
  var DERIVED_FIELDS = ['sentiment_index', 'is_complaint', 'is_detractor', 'is_promoter', 'age_hours', 'frt_hours', 'resolution_hours', 'sla_frt_hours',
    'sla_frt_breached', 'is_open', 'day_key', 'week_key', 'month_key', 'dow', 'hour', 'regulatory_clock', 'regulatory_clock_basis', 'regulatory_deadline',
    'business_days_remaining', 'hours_remaining', 'churn_score', 'escalation_score', 'pred_csat'];

  /* ------------------------------------------------------------- helpers */

  function util() { return window.VOC && window.VOC.util; }

  function nowIso(opts) {
    if (opts && opts.now) return opts.now instanceof Date ? opts.now.toISOString() : String(opts.now);
    var st = window.VOC && VOC.store;
    if (st && typeof st.now === 'function') { try { var d = st.now(); if (d) return d instanceof Date ? d.toISOString() : String(d); } catch (e) { /* fall through */ } }
    return new Date().toISOString();
  }

  function roundTo(n, d) { var f = Math.pow(10, d); return Math.round(n * f) / f; }

  function fmtNumber(v) {
    if (!isFinite(v)) return '';
    return Number.isInteger(v) ? String(v) : String(roundTo(v, 4));
  }

  /** Leading characters a spreadsheet reads as a formula or DDE call (OWASP CSV-injection list: = + - @ tab CR). */
  var FORMULA_LEAD_RE = /^[=+\-@\t\r]/;

  /** Prefix text that would evaluate as a formula with an apostrophe. Applied to every text cell, including joined arrays. */
  function neutralizeFormula(s) {
    return FORMULA_LEAD_RE.test(s) ? "'" + s : s;
  }

  /**
   * Format one value for a CSV cell: null/undefined → '', arrays joined with '|',
   * booleans 'true'/'false', numbers rounded to 4 dp (negative numbers stay numbers),
   * objects JSON. Text that spreadsheets would read as a formula — a leading =, +, -, @,
   * tab or CR, also when it is the first element of an array — gets a leading apostrophe.
   */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return fmtNumber(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
    if (Array.isArray(v)) return neutralizeFormula(v.map(function (x) { return x === null || x === undefined ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x)); }).join('|'));
    if (typeof v === 'object') return JSON.stringify(v);
    return neutralizeFormula(String(v));
  }

  function quote(s) {
    if (s === '') return '';
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * Build an RFC 4180 CSV string (with UTF-8 BOM and CRLF rows).
   * @param {string[]} columns header names in order
   * @param {Object[]} rows objects keyed by column
   * @returns {string}
   */
  function toCsv(columns, rows) {
    var lines = [columns.map(function (c) { return quote(csvCell(c)); }).join(',')];
    (rows || []).forEach(function (row) {
      lines.push(columns.map(function (c) { return quote(csvCell(row ? row[c] : null)); }).join(','));
    });
    return BOM + lines.join(CRLF) + CRLF;
  }

  function isoOrEmpty(v) {
    if (!v) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().replace(/\.\d{3}Z$/, 'Z');
    var s = String(v);
    var t = Date.parse(s);
    return isNaN(t) ? s : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function redactCopy(rec) {
    var u = util();
    if (u && typeof u.redactRecord === 'function') return u.redactRecord(rec);
    var copy = Object.assign({}, rec);
    copy.from_name = 'Redacted'; copy.from_email = null; copy.subject = '[restricted]'; copy.text = '[restricted — open the queue to view]';
    copy.order_id = null; copy.hcp_code = null; copy.redacted = true;
    return copy;
  }

  function sentimentIndex(rec) {
    if (typeof rec.sentiment_index === 'number' && isFinite(rec.sentiment_index)) return roundTo(rec.sentiment_index, 1);
    if (typeof rec.sentiment === 'number' && isFinite(rec.sentiment)) return roundTo((rec.sentiment + 1) / 2 * 100, 1);
    return null;
  }

  function isComplaint(rec) {
    if (typeof rec.is_complaint === 'boolean') return rec.is_complaint;
    return (typeof rec.sentiment === 'number' && rec.sentiment < -0.1) || COMPLAINT_CATEGORIES.indexOf(rec.category) >= 0;
  }

  function ageHours(rec, nowMs) {
    if (typeof rec.age_hours === 'number' && isFinite(rec.age_hours)) return roundTo(rec.age_hours, 1);
    var t = Date.parse(rec.received_at || '');
    if (isNaN(t) || !isFinite(nowMs)) return null;
    return roundTo(Math.max(0, (nowMs - t) / 3600000), 1);
  }

  function noteText(n) {
    if (!n || typeof n !== 'object') return String(n || '');
    return [isoOrEmpty(n.at), n.by ? n.by + ':' : '', n.text || ''].filter(Boolean).join(' ');
  }

  /* ---------------------------------------------------------- recordsCsv */

  /**
   * Records → CSV with every SPEC §2 column plus sentiment_index, is_complaint, age_hours.
   * @param {Object[]} records
   * @param {{redact?: boolean, now?: Date|string}} [opts] redact → restricted records lose from_name/from_email/text
   * @returns {string}
   */
  function recordsCsv(records, opts) {
    opts = opts || {};
    var nowMs = Date.parse(nowIso(opts));
    var rows = (records || []).map(function (rec0) {
      var rec = opts.redact && rec0.restricted ? redactCopy(rec0) : rec0;
      var c = rec.classifier || {};
      var row = {};
      RECORD_COLUMNS.forEach(function (col) { row[col] = rec[col]; });
      ['received_at', 'first_response_at', 'resolved_at'].forEach(function (k) { row[k] = isoOrEmpty(rec[k]); });
      row.notes = Array.isArray(rec.notes) ? rec.notes.map(noteText).join(' || ') : (rec.notes || '');
      row.classifier_confidence = typeof c.confidence === 'number' ? roundTo(c.confidence, 3) : null;
      row.classifier_rule_category = c.rule_category || null;
      row.classifier_rule_subcategory = c.rule_subcategory || null;
      row.classifier_rule_product = c.rule_product || null;
      row.classifier_manual_override = typeof c.manual_override === 'boolean' ? c.manual_override : null;
      row.classifier_needs_review = typeof c.needs_review === 'boolean' ? c.needs_review : null;
      row.sentiment_index = sentimentIndex(rec);
      row.is_complaint = isComplaint(rec);
      row.age_hours = ageHours(rec, nowMs);
      return row;
    });
    return toCsv(RECORD_COLUMNS, rows);
  }

  /* ---------------------------------------------------------- metricsCsv */

  function flattenRow(row) {
    var out = {};
    Object.keys(row || {}).forEach(function (k) {
      var v = row[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        Object.keys(v).forEach(function (sub) { out[k + '_' + sub] = v[sub]; });
      } else out[k] = v;
    });
    return out;
  }

  /**
   * Generic metric rows → CSV. Column order follows first appearance; nested
   * objects one level deep become `key_sub` columns (interval_lo, delta_text …).
   * @param {Object[]} rows
   * @returns {string}
   */
  function metricsCsv(rows) {
    var flat = (rows || []).map(flattenRow), columns = [];
    flat.forEach(function (r) { Object.keys(r).forEach(function (k) { if (columns.indexOf(k) < 0) columns.push(k); }); });
    return toCsv(columns, flat);
  }

  /* ------------------------------------------------------- regulatoryCsv */

  function addBusinessDaysFallback(iso, n) {
    var d = new Date(iso); if (isNaN(d.getTime())) return null;
    var left = n;
    while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); var dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) left--; }
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function businessDaysBetweenFallback(aIso, bIso) {
    var a = new Date(aIso), b = new Date(bIso);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
    var sign = b >= a ? 1 : -1, lo = sign > 0 ? a : b, hi = sign > 0 ? b : a, count = 0, cur = new Date(lo.getTime());
    while (cur < hi) {
      var next = new Date(cur.getTime() + 86400000);
      var dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6) count += Math.min(1, (Math.min(hi.getTime(), next.getTime()) - cur.getTime()) / 86400000);
      cur = next;
    }
    return roundTo(sign * count, 2);
  }

  function clockFor(rec) {
    if (rec.regulatory_clock) return rec.regulatory_clock;
    var cls = rec.product_class;
    if (rec.serious_ae) return 'medwatch_15bd';
    if (rec.food_safety && (cls === 'conventional_food' || cls === 'supplement')) return 'rfr_24h';
    return 'none';
  }

  /** 'statutory' | 'voluntary' | '' — the 15-business-day MedWatch clock is statutory only for dietary supplements. */
  function clockBasisFor(rec, clock) {
    if (rec.regulatory_clock_basis) return rec.regulatory_clock_basis;
    if (clock === 'none' || !clock) return '';
    if (clock === 'medwatch_15bd') return rec.product_class === 'supplement' ? 'statutory' : 'voluntary';
    return 'statutory';
  }

  function deadlineFor(rec, clock) {
    if (rec.regulatory_deadline) return isoOrEmpty(rec.regulatory_deadline);
    if (clock === 'none' || !rec.received_at) return '';
    var u = util();
    if (clock === 'medwatch_15bd') {
      if (u && typeof u.addBusinessDays === 'function') { try { var d = u.addBusinessDays(rec.received_at, 15); if (d) return isoOrEmpty(d); } catch (e) { /* fallback */ } }
      return addBusinessDaysFallback(rec.received_at, 15) || '';
    }
    var t = Date.parse(rec.received_at);
    return isNaN(t) ? '' : new Date(t + 24 * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function receivedCt(iso) {
    if (!iso) return '';
    var u = util();
    if (u && u.fmt && typeof u.fmt.date === 'function') { try { return u.fmt.date(iso, 'datetime'); } catch (e) { /* fallback */ } }
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
    } catch (e) { return iso; }
  }

  function isRegulatory(rec) {
    return !!(rec.is_adverse_event || rec.serious_ae || rec.food_safety || (Array.isArray(rec.contraindication_flags) && rec.contraindication_flags.length) ||
      (rec.regulatory_clock && rec.regulatory_clock !== 'none'));
  }

  /**
   * AE / food-safety register → CSV, with the regulatory clock, deadline and time remaining.
   * By default only regulatory-relevant records are kept; pass {all:true} to keep every record.
   * @param {Object[]} records
   * @param {{redact?: boolean, now?: Date|string, all?: boolean}} [opts]
   * @returns {string}
   */
  function regulatoryCsv(records, opts) {
    opts = opts || {};
    var now = nowIso(opts), nowMs = Date.parse(now), u = util();
    var rows = (records || []).filter(function (r) { return opts.all || isRegulatory(r); }).map(function (rec0) {
      var rec = opts.redact && rec0.restricted ? redactCopy(rec0) : rec0;
      var clock = clockFor(rec), deadline = deadlineFor(rec, clock), row = {};
      REGULATORY_COLUMNS.forEach(function (col) { row[col] = rec[col]; });
      row.received_at = isoOrEmpty(rec.received_at);
      row.received_ct = receivedCt(row.received_at);
      row.regulatory_clock = clock;
      row.regulatory_clock_basis = clockBasisFor(rec, clock);
      row.regulatory_deadline = deadline;
      row.business_days_remaining = null;
      row.hours_remaining = null;
      if (deadline && isFinite(nowMs)) {
        if (typeof rec.hours_remaining === 'number') row.hours_remaining = roundTo(rec.hours_remaining, 1);
        else row.hours_remaining = roundTo((Date.parse(deadline) - nowMs) / 3600000, 1);
        if (clock === 'medwatch_15bd') {
          if (typeof rec.business_days_remaining === 'number') row.business_days_remaining = roundTo(rec.business_days_remaining, 2);
          else if (u && typeof u.businessDaysBetween === 'function') { try { row.business_days_remaining = roundTo(u.businessDaysBetween(now, deadline), 2); } catch (e) { row.business_days_remaining = businessDaysBetweenFallback(now, deadline); } }
          else row.business_days_remaining = businessDaysBetweenFallback(now, deadline);
        }
      }
      return row;
    });
    return toCsv(REGULATORY_COLUMNS, rows);
  }

  /* ---------------------------------------------------------- backupJson */

  function stripDerived(rec) {
    var copy = {};
    Object.keys(rec).forEach(function (k) { if (DERIVED_FIELDS.indexOf(k) < 0) copy[k] = rec[k]; });
    return copy;
  }

  function mapToArray(m) {
    if (!m) return [];
    if (Array.isArray(m)) return m;
    if (typeof m.forEach === 'function' && typeof m.get === 'function') { var arr = []; m.forEach(function (v, k) { arr.push(v && v.id ? v : Object.assign({ id: k }, v)); }); return arr; }
    if (typeof m === 'object') return Object.keys(m).map(function (k) { return m[k] && m[k].id ? m[k] : Object.assign({ id: k }, m[k]); });
    return [];
  }

  function call(obj, name, fallback) {
    if (obj && typeof obj[name] === 'function') { try { return obj[name](); } catch (e) { return fallback; } }
    if (obj && name in obj) return obj[name];
    return fallback;
  }

  /**
   * Serialise a restorable backup. Accepts the store module (VOC.store) or a
   * plain object { records, overlays, settings, orders, seed_meta }.
   * Only imported records (source !== 'seed') are included; derived fields are stripped.
   * @param {Object} store
   * @returns {string} JSON
   */
  function backupJson(store) {
    store = store || (window.VOC && VOC.store) || {};
    var records = call(store, 'allWithNoise', null) || call(store, 'all', null) || call(store, 'records', []) || [];
    var seedMeta = call(store, 'seedMeta', null) || (window.VOC_SEED && window.VOC_SEED.meta) || store.seed_meta || null;
    var out = {
      schema_version: 1,
      exported_at: nowIso(),
      seed_meta: seedMeta,
      records: (records || []).filter(function (r) { return r && r.source !== 'seed'; }).map(stripDerived),
      overlays: mapToArray(call(store, 'overlays', [])),
      settings: call(store, 'settings', {}) || {},
      orders: call(store, 'orders', null)
    };
    return JSON.stringify(out);
  }

  /* -------------------------------------------------------- downloadText */

  function toast(message, kind) {
    var ui = window.VOC && VOC.ui;
    if (ui && typeof ui.toast === 'function') { try { ui.toast(message, kind || 'info'); } catch (e) { /* ignore */ } }
  }

  function copyToClipboard(text) {
    if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return Promise.reject(new Error('clipboard unavailable'));
    return navigator.clipboard.writeText(text);
  }

  /**
   * Trigger a file download in the browser. Falls back to copying the text to
   * the clipboard (and toasting) when Blob/anchor download is unavailable or throws.
   * @param {string} filename
   * @param {string} text
   * @param {string} [mime='text/csv;charset=utf-8']
   * @returns {Promise<'download'|'clipboard'|'failed'>}
   */
  function downloadText(filename, text, mime) {
    var type = mime || (/\.json$/i.test(filename) ? 'application/json;charset=utf-8' : (/\.html?$/i.test(filename) ? 'text/html;charset=utf-8' : 'text/csv;charset=utf-8'));
    var attempted = false;
    try {
      if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        var a = document.createElement('a');
        if ('download' in a) {
          attempted = true;
          var blob = new Blob([text], { type: type });
          var url = URL.createObjectURL(blob);
          a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 1000);
          return Promise.resolve('download');
        }
      }
    } catch (e) { attempted = true; }
    return copyToClipboard(text).then(function () {
      toast((attempted ? 'Download blocked here — ' : '') + 'copied ' + filename + ' to the clipboard instead.', 'warning');
      return 'clipboard';
    }, function () {
      toast('Could not download or copy ' + filename + '.', 'critical');
      return 'failed';
    });
  }

  /* ------------------------------------------------------------ filename */

  function yyyymmdd(opts) {
    var iso = nowIso(opts), u = util();
    var day = null;
    if (u && typeof u.isoDate === 'function') { try { day = u.isoDate(new Date(iso)); } catch (e) { day = null; } }
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      try {
        var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
        var get = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value; };
        day = get('year') + '-' + get('month') + '-' + get('day');
      } catch (e) { day = iso.slice(0, 10); }
    }
    return day.replace(/-/g, '');
  }

  /**
   * Standard export filename: lnutra-voc-{view}-{YYYYMMDD}.{ext} (date in America/Chicago, store clock).
   * @param {string} view e.g. 'inbox', 'metrics', 'regulatory', 'backup'
   * @param {string} [ext='csv']
   * @param {{now?: Date|string}} [opts]
   * @returns {string}
   */
  function filename(view, ext, opts) {
    var slug = String(view || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
    return 'lnutra-voc-' + slug + '-' + yyyymmdd(opts) + '.' + (ext || 'csv').replace(/^\./, '');
  }

  return {
    RECORD_COLUMNS: RECORD_COLUMNS,
    REGULATORY_COLUMNS: REGULATORY_COLUMNS,
    csvCell: csvCell,
    toCsv: toCsv,
    recordsCsv: recordsCsv,
    metricsCsv: metricsCsv,
    regulatoryCsv: regulatoryCsv,
    isRegulatory: isRegulatory,
    /** Number of rows regulatoryCsv(records) writes: AE, food-safety, contraindication and clocked records. */
    regulatoryCount: function (records) { return (records || []).filter(isRegulatory).length; },
    backupJson: backupJson,
    downloadText: downloadText,
    filename: filename
  };
})();
