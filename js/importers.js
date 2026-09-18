/**
 * VOC.importers — browser import of .eml / .mbox / .csv / .json into
 * RawEmail / Record items (SPEC §4.11, §9).
 *
 * PURE* module: parsing functions run under JavaScriptCore; file reading
 * (handleFiles) and mapping memory (localStorage) are guarded.
 *
 * Public surface:
 *   parseEmlText(text) → RawEmail
 *   parseMboxText(text) → RawEmail[]
 *   parseCsvText(text) → { headers: string[], rows: string[][], delimiter }
 *   TEMPLATES, detectTemplate(headers) → 'helpdesk'|'reviews'|'orders_monthly'|'records'|null
 *   buildMapping(headers, templateId) → Mapping
 *   mapRows(rows, mapping) → Partial<Record>[] | RawEmail[] | { ordersByMonth }
 *   parseJsonText(text) → Record[] | RawEmail[]
 *   parseJsonFull(text) → { kind, items, overlays?, settings?, ordersByMonth?, seed_meta? }
 *   headerFingerprint(headers), rememberMapping(headers, mapping), recallMapping(headers), forgetMappings()
 *   handleFiles(files, opts) → Promise<{ items, summary, ordersByMonth?, overlays?, settings? }>   (browser only; per-file size caps in FILE_LIMITS)
 *   mergeOrders(target, add), sanitizeOrders(obj), stripUnsafeKeys(value)   prototype-pollution-safe handling of file-sourced objects
 *   buildSummary(result) → summary   rebuilds summary counts + summary.text from result.items / pending / errors
 *
 * Mapping = { template: TemplateId, headers: string[], fingerprint: hex16, columns: {[field]: index|null}, missing: string[] }
 */
window.VOC = window.VOC || {};
VOC.importers = (function () {
  'use strict';

  var STORAGE_KEY = 'voc.csv.mappings';

  /* ------------------------------------------------------------- helpers */

  function util() { return window.VOC && window.VOC.util; }

  function fallbackFnv64(str) {
    var s = String(str), h = 0xcbf29ce484222325n, p = 0x100000001b3n, mask = 0xFFFFFFFFFFFFFFFFn;
    for (var i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i) & 0xFF); h = (h * p) & mask; }
    return h.toString(16).padStart(16, '0');
  }

  function fnv64(str) {
    var u = util();
    return u && typeof u.fnv64 === 'function' ? u.fnv64(str) : fallbackFnv64(str);
  }

  function normHeader(h) {
    return String(h === null || h === undefined ? '' : h).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function clean(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\r\n?/g, '\n').trim();
  }

  function toNum(v, lo, hi, integer) {
    var s = clean(v).replace(/[^0-9.+-]/g, '');
    if (!s) return null;
    var n = Number(s);
    if (!isFinite(n)) return null;
    if (integer) n = Math.round(n);
    if (lo !== undefined && n < lo) return null;
    if (hi !== undefined && n > hi) return null;
    return n;
  }

  function toBool(v) {
    var s = clean(v).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === '') return false;
    return null;
  }

  function splitList(v) {
    var s = clean(v);
    if (!s) return [];
    if (s[0] === '[') { try { var arr = JSON.parse(s); if (Array.isArray(arr)) return arr.map(function (x) { return String(x).trim(); }).filter(Boolean); } catch (e) { /* fall through */ } }
    return s.split(/[|;,]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function toIsoNoMs(ms) {
    if (!isFinite(ms)) return null;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * Parse a date in the shapes help-desk exports use. Naive timestamps are
   * read as UTC. Returns ISO-8601 UTC or null.
   */
  function parseLooseDate(v) {
    var s = clean(v);
    if (!s) return null;
    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (iso) {
      var off = 0;
      if (iso[7] && /^[+-]/.test(iso[7])) off = (iso[7][0] === '-' ? -1 : 1) * (parseInt(iso[7].substr(1, 2), 10) * 60 + parseInt(iso[7].replace(':', '').substr(3, 2), 10));
      return toIsoNoMs(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], iso[4] ? +iso[4] : 0, iso[5] ? +iso[5] : 0, iso[6] ? +iso[6] : 0) - off * 60000);
    }
    var us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s);
    if (us) {
      var year = +us[3]; if (us[3].length === 2) year += year < 50 ? 2000 : 1900;
      var hour = us[4] ? +us[4] : 0;
      if (us[7]) { var pm = us[7].toLowerCase() === 'pm'; if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0; }
      return toIsoNoMs(Date.UTC(year, +us[1] - 1, +us[2], hour, us[5] ? +us[5] : 0, us[6] ? +us[6] : 0));
    }
    if (/^\d{10,13}$/.test(s)) return toIsoNoMs(s.length > 10 ? +s : +s * 1000);
    if (window.VOC && VOC.mime && typeof VOC.mime.parseDate === 'function') {
      var d = VOC.mime.parseDate(s);
      if (d) return d;
    }
    var t = Date.parse(s);
    return isNaN(t) ? null : toIsoNoMs(t);
  }

  /** Normalise many month spellings to 'YYYY-MM'. */
  function normMonth(v) {
    var s = clean(v);
    if (!s) return null;
    var m;
    if ((m = /^(\d{4})[-\/.](\d{1,2})(?:[-\/.]\d{1,2})?(?:[T ].*)?$/.exec(s))) return m[1] + '-' + ('0' + m[2]).slice(-2);
    if ((m = /^(\d{4})(\d{2})$/.exec(s))) return m[1] + '-' + m[2];
    if ((m = /^(\d{1,2})[-\/.](\d{4})$/.exec(s))) return m[2] + '-' + ('0' + m[1]).slice(-2);
    if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(s))) return m[3] + '-' + ('0' + m[1]).slice(-2);
    var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
    if ((m = /^([A-Za-z]{3,9})[\s,.-]+(\d{4})$/.exec(s)) && MON[m[1].slice(0, 3).toLowerCase()]) return m[2] + '-' + ('0' + MON[m[1].slice(0, 3).toLowerCase()]).slice(-2);
    if ((m = /^(\d{4})[\s,.-]+([A-Za-z]{3,9})$/.exec(s)) && MON[m[2].slice(0, 3).toLowerCase()]) return m[1] + '-' + ('0' + MON[m[2].slice(0, 3).toLowerCase()]).slice(-2);
    return null;
  }

  var PRODUCT_ALIASES = [
    ['prolon_nextgen', /next\s*-?\s*gen|ready.to.eat/i],
    ['prolon_reset', /\breset\b|\b1.?day\b|one.day/i],
    ['prolon_52', /\b5\s*:\s*2\b|five.two/i],
    ['starter_pack', /starter\s*pack/i],
    ['fast_bar', /fast(ing)?\s?bars?/i],
    ['fasting_shake', /shake/i],
    ['l_protein', /l.?protein|protein powder/i],
    ['l_pill', /l.?pill/i],
    ['guided_health', /guided|coach|dietitian/i],
    ['lnutra_health', /l.?nutra\s*health|diabetes remission|metabolic health program/i],
    ['prolon_5day', /5.?day|prolon|fmd|fasting.mimicking|\bkit\b/i],
    ['subscription_account', /subscription|auto.?renew|autoship/i]
  ];

  /**
   * Resolve a product name / id / SKU string to a ProductId. Prefers
   * VOC.classify.detectProduct when loaded, else the local alias table.
   * @returns {string|null}
   */
  function resolveProduct(v) {
    var s = clean(v);
    if (!s) return null;
    var id = s.toLowerCase().replace(/[\s-]+/g, '_');
    for (var i = 0; i < PRODUCT_ALIASES.length; i++) if (PRODUCT_ALIASES[i][0] === id) return id;
    if (id === 'general') return 'general';
    var cls = window.VOC && VOC.classify;
    if (cls && typeof cls.detectProduct === 'function') {
      try {
        var r = cls.detectProduct(s, s);
        if (r && r.product && r.product !== 'general' && (r.score === undefined || r.score > 0)) return r.product;
      } catch (e) { /* fall back to aliases */ }
    }
    for (var j = 0; j < PRODUCT_ALIASES.length; j++) if (PRODUCT_ALIASES[j][1].test(s)) return PRODUCT_ALIASES[j][0];
    return null;
  }

  var STATUS_MAP = [
    [/^(new|unassigned|untriaged)$/, 'new'],
    [/^(open|in.?progress|active|assigned|working|triaged|replied|awaiting.?agent)$/, 'open'],
    [/^(pending|on.?hold|hold|waiting|awaiting.?customer|waiting.?on.?customer|snoozed|paused)$/, 'pending'],
    [/^(solved|resolved|done|completed|complete|answered|fixed)$/, 'resolved'],
    [/^(closed|archived)$/, 'resolved'],
    [/^(reopened|re-?opened)$/, 'reopened'],
    [/^(escalated|escalation|tier.?2|urgent)$/, 'escalated'],
    [/^(spam|deleted|trash|junk|noise|suspended)$/, 'closed_noise']
  ];

  function normStatus(v, closedAt) {
    var s = clean(v).toLowerCase().replace(/[_\s]+/g, ' ').trim();
    for (var i = 0; i < STATUS_MAP.length; i++) if (STATUS_MAP[i][0].test(s.replace(/ /g, ''))) return STATUS_MAP[i][1];
    return closedAt ? 'resolved' : (s ? 'open' : 'new');
  }

  /* ------------------------------------------------------------- .eml */

  /**
   * Parse one raw .eml message (latin1-preserving text) into a RawEmail.
   * @param {string} text
   * @param {{agentAddresses?: string[], agentDomains?: string[]}} [opts]
   * @returns {Object} RawEmail with source 'eml'
   */
  function parseEmlText(text, opts) {
    var parsed = VOC.mime.parse(text);
    return VOC.mime.toRawEmail(parsed, 'eml', opts);
  }

  /* ------------------------------------------------------------- .mbox */

  // RFC 4155 separator: "From " + envelope sender + asctime-style date at line start.
  var MBOX_SEP = /^From \S+ (?:[A-Za-z]{3},? )?[A-Za-z]{3} [ \d]?\d \d\d:\d\d(?::\d\d)? (?:[A-Z]{1,5} )?\d{4}(?: [+-]\d{4})?[ \t]*$/;

  /**
   * Split an mbox file into RawEmail[]. Lines escaped as '>From ' inside a
   * body are un-escaped (one '>' removed).
   * @param {string} text latin1-preserving mbox text
   * @param {Object} [opts] passed to toRawEmail
   * @returns {Object[]} RawEmail[] with source 'mbox'
   */
  function parseMboxText(text, opts) {
    var s = String(text || '').replace(/\r\n|\r/g, '\n');
    var lines = s.split('\n'), chunks = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (MBOX_SEP.test(line) && (i === 0 || lines[i - 1] === '' || cur === null)) {
        if (cur) chunks.push(cur);
        cur = [];
        continue;
      }
      if (cur === null) { if (!line.trim()) continue; cur = []; }
      cur.push(/^>+From /.test(line) ? line.slice(1) : line);
    }
    if (cur && cur.length) chunks.push(cur);
    var out = [];
    for (var c = 0; c < chunks.length; c++) {
      var raw = chunks[c].join('\n').replace(/\n+$/, '\n');
      if (!raw.trim()) continue;
      var parsed = VOC.mime.parse(raw);
      out.push(VOC.mime.toRawEmail(parsed, 'mbox', opts));
    }
    return out;
  }

  /* ------------------------------------------------------------- .csv */

  function detectDelimiter(text) {
    var firstLine = text.split(/\r?\n/, 1)[0] || '';
    var counts = { ',': 0, ';': 0, '\t': 0, '|': 0 }, inQ = false;
    for (var i = 0; i < firstLine.length; i++) {
      var ch = firstLine[i];
      if (ch === '"') inQ = !inQ;
      else if (!inQ && counts[ch] !== undefined) counts[ch]++;
    }
    var best = ',', bestN = counts[','];
    [';', '\t', '|'].forEach(function (d) { if (counts[d] > bestN) { best = d; bestN = counts[d]; } });
    return best;
  }

  /**
   * RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF/LF/CR, embedded
   * newlines. Auto-detects ',', ';', tab or '|' from the header line.
   * @param {string} text
   * @param {{delimiter?: string}} [opts]
   * @returns {{headers: string[], rows: string[][], delimiter: string}}
   */
  function parseCsvText(text, opts) {
    var s = String(text || '').replace(/^\uFEFF/, '');
    var delim = (opts && opts.delimiter) || detectDelimiter(s);
    var records = [], row = [], field = '', inQ = false, i = 0, n = s.length;
    while (i < n) {
      var ch = s[i];
      if (inQ) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === delim) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); field = '';
        records.push(row); row = [];
        if (ch === '\r' && s[i + 1] === '\n') i++;
        i++; continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); records.push(row); }
    records = records.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });
    if (!records.length) return { headers: [], rows: [], delimiter: delim };
    var headers = records[0].map(function (h) { return h.trim(); });
    var rows = records.slice(1).map(function (r) {
      var out = r.slice(0, headers.length);
      while (out.length < headers.length) out.push('');
      return out;
    });
    return { headers: headers, rows: rows, delimiter: delim };
  }

  /* --------------------------------------------------------- templates */

  var NATIVE_COLUMNS = ['id', 'schema_version', 'received_at', 'channel', 'sales_channel', 'from_name', 'from_email', 'subject', 'text', 'language',
    'has_attachment', 'product', 'product_variant', 'kit_component', 'product_class', 'category', 'subcategory', 'secondary_categories',
    'sentiment', 'sentiment_min', 'sentiment_label', 'nps', 'rating', 'csat', 'urgency', 'status', 'first_response_at', 'resolved_at', 'reopen_count',
    'service_fields_source', 'escalated_to', 'is_adverse_event', 'serious_ae', 'ae_criteria', 'contraindication_flags', 'food_safety',
    'lot_number', 'order_id', 'hcp_code', 'claim_related', 'cancel_intent', 'restricted', 'customer_id', 'segment', 'region', 'thread_id',
    'is_first_contact', 'message_id', 'source', 'is_noise', 'noise_reason', 'assignee', 'tags', 'notes',
    'classifier_confidence', 'classifier_rule_category', 'classifier_rule_subcategory', 'classifier_rule_product', 'classifier_manual_override', 'classifier_needs_review'];

  function nativeFields() {
    var f = {};
    NATIVE_COLUMNS.forEach(function (c) { f[c] = { required: c === 'received_at' || c === 'subject' || c === 'category', synonyms: [c] }; });
    return f;
  }

  /** CSV templates: field → synonyms (matched case/space/punctuation-insensitively). */
  var TEMPLATES = {
    helpdesk: {
      id: 'helpdesk', label: 'Help desk export', kind: 'records',
      description: 'Zendesk / Freshdesk / Gorgias / HubSpot ticket exports: one row per ticket.',
      fields: {
        ticket_id: { synonyms: ['ticket id', 'id', 'ticket', 'ticket number', 'ticket #', '#', 'case id', 'case number', 'conversation id', 'number'] },
        subject: { required: true, synonyms: ['subject', 'title', 'ticket subject', 'summary', 'ticket title'] },
        body: { required: true, synonyms: ['body', 'description', 'message', 'text', 'content', 'ticket body', 'first message', 'latest comment', 'ticket description', 'initial message', 'comment'] },
        from_email: { synonyms: ['from email', 'from', 'requester email', 'requester', 'customer email', 'email', 'sender', 'sender email', 'contact email', 'user email', 'from address'] },
        from_name: { synonyms: ['from name', 'requester name', 'customer name', 'name', 'customer', 'contact name', 'user name', 'sender name'] },
        created_at: { required: true, synonyms: ['created at', 'created', 'date', 'received', 'received at', 'opened', 'opened at', 'timestamp', 'ticket created', 'creation date', 'date created', 'submitted at'] },
        status: { synonyms: ['status', 'state', 'ticket status'] },
        assignee: { synonyms: ['assignee', 'agent', 'owner', 'assigned to', 'assigned agent', 'assignee name', 'agent name'] },
        first_replied_at: { synonyms: ['first replied at', 'first reply', 'first response', 'first replied', 'first response at', 'first response time', 'first reply at', 'initially replied at', 'first public reply'] },
        closed_at: { synonyms: ['closed at', 'closed', 'resolved', 'resolved at', 'solved at', 'solved', 'closed date', 'resolution date', 'date closed', 'date resolved'] },
        tags: { synonyms: ['tags', 'labels', 'tag', 'label'] },
        csat: { synonyms: ['csat', 'satisfaction', 'satisfaction rating', 'satisfaction score', 'csat score'] },
        nps: { synonyms: ['nps', 'nps score', 'recommend score', 'likelihood to recommend'] },
        priority: { synonyms: ['priority', 'urgency', 'severity'] },
        order_id: { synonyms: ['order id', 'order', 'order number', 'order #'] }
      }
    },
    reviews: {
      id: 'reviews', label: 'Product reviews', kind: 'records',
      description: 'Amazon or Trustpilot review exports: one row per review with a 1–5 rating.',
      fields: {
        title: { synonyms: ['title', 'review title', 'headline', 'subject', 'summary'] },
        body: { required: true, synonyms: ['body', 'review', 'review text', 'text', 'content', 'review body', 'comment', 'description'] },
        rating: { required: true, synonyms: ['rating', 'stars', 'star rating', 'score', 'review rating', 'overall rating'] },
        author: { synonyms: ['author', 'reviewer', 'name', 'reviewer name', 'customer', 'user', 'profile name'] },
        date: { synonyms: ['date', 'review date', 'created at', 'created', 'posted', 'posted at', 'published', 'time'] },
        product: { synonyms: ['product', 'product name', 'item', 'sku', 'asin', 'product title', 'variant'] },
        source: { synonyms: ['source', 'platform', 'site', 'marketplace', 'channel', 'store'] },
        verified: { synonyms: ['verified', 'verified purchase'] },
        review_id: { synonyms: ['review id', 'id'] }
      }
    },
    orders_monthly: {
      id: 'orders_monthly', label: 'Orders by month', kind: 'orders',
      description: 'One row per month × product with the order count.',
      fields: {
        month: { required: true, synonyms: ['month', 'period', 'year month', 'yearmonth', 'date', 'order month'] },
        product: { required: true, synonyms: ['product', 'product name', 'sku', 'item', 'product id'] },
        orders: { required: true, synonyms: ['orders', 'units', 'quantity', 'qty', 'order count', 'count', 'sales', 'orders count', 'n'] }
      }
    },
    records: {
      id: 'records', label: 'VoC records (native)', kind: 'records',
      description: 'Columns exported by this site (recordsCsv).',
      fields: nativeFields()
    }
  };

  var TEMPLATE_ORDER = ['records', 'orders_monthly', 'reviews', 'helpdesk'];

  function synonymIndex(template) {
    var idx = {};
    Object.keys(template.fields).forEach(function (field) {
      template.fields[field].synonyms.forEach(function (syn) {
        var k = normHeader(syn);
        if (!(k in idx)) idx[k] = field;
      });
    });
    return idx;
  }

  /**
   * Build a column mapping for a template from a CSV header row.
   * @param {string[]} headers
   * @param {string} templateId
   * @returns {Object} Mapping (see file header)
   */
  function buildMapping(headers, templateId) {
    var template = TEMPLATES[templateId];
    if (!template) return null;
    var idx = synonymIndex(template), columns = {}, used = {};
    Object.keys(template.fields).forEach(function (f) { columns[f] = null; });
    headers.forEach(function (h, i) {
      var field = idx[normHeader(h)];
      if (field && columns[field] === null && !used[i]) { columns[field] = i; used[i] = true; }
    });
    var missing = Object.keys(template.fields).filter(function (f) { return template.fields[f].required && columns[f] === null; });
    return { template: templateId, headers: headers.slice(), fingerprint: headerFingerprint(headers), columns: columns, missing: missing };
  }

  /**
   * Detect which CSV template a header row belongs to.
   * @param {string[]} headers
   * @returns {'helpdesk'|'reviews'|'orders_monthly'|'records'|null}
   */
  function detectTemplate(headers) {
    if (!headers || !headers.length) return null;
    var best = null, bestScore = -1;
    TEMPLATE_ORDER.forEach(function (id) {
      var m = buildMapping(headers, id);
      if (m.missing.length) return;
      var matched = Object.keys(m.columns).filter(function (f) { return m.columns[f] !== null; }).length;
      var score = matched + (id === 'records' ? 100 : 0);
      if (score > bestScore) { best = id; bestScore = score; }
    });
    return best;
  }

  /* ---------------------------------------------------------- mapRows */

  function resolveMapping(mapping) {
    if (typeof mapping === 'string') return { template: mapping, headers: [], columns: {}, missing: [] };
    var m = { template: mapping.template, headers: mapping.headers || [], columns: {}, missing: mapping.missing || [] };
    var cols = mapping.columns || {};
    Object.keys(cols).forEach(function (f) {
      var v = cols[f];
      if (typeof v === 'string') {
        var i = m.headers.indexOf(v);
        if (i < 0) i = m.headers.map(normHeader).indexOf(normHeader(v));
        m.columns[f] = i >= 0 ? i : null;
      } else m.columns[f] = typeof v === 'number' ? v : null;
    });
    return m;
  }

  function cellGetter(row, mapping) {
    var isObj = row && !Array.isArray(row) && typeof row === 'object';
    return function (field) {
      var i = mapping.columns[field];
      if (i === null || i === undefined) return '';
      if (isObj) {
        var key = mapping.headers[i];
        return key in row ? row[key] : (field in row ? row[field] : '');
      }
      return row[i] === undefined ? '' : row[i];
    };
  }

  function mapHelpdesk(rows, mapping) {
    var out = [];
    rows.forEach(function (row) {
      var g = cellGetter(row, mapping);
      var subject = clean(g('subject')), body = clean(g('body'));
      if (!subject && !body) return;
      var created = parseLooseDate(g('created_at'));
      var closed = parseLooseDate(g('closed_at'));
      var ticket = clean(g('ticket_id'));
      var email = clean(g('from_email')).toLowerCase() || null;
      var rec = {
        subject: subject || '(no subject)',
        text: body,
        from_email: email,
        from_name: clean(g('from_name')) || null,
        received_at: created,
        channel: 'email',
        status: normStatus(g('status'), closed),
        assignee: clean(g('assignee')) || null,
        first_response_at: parseLooseDate(g('first_replied_at')),
        resolved_at: closed,
        tags: splitList(g('tags')),
        service_fields_source: 'helpdesk_import',
        source: 'csv'
      };
      var csat = toNum(g('csat'), 1, 5, true); if (csat !== null) rec.csat = csat;
      var nps = toNum(g('nps'), 0, 10, true); if (nps !== null) rec.nps = nps;
      var order = clean(g('order_id')); if (order) rec.order_id = order;
      if (ticket) rec.message_id = 'helpdesk:' + ticket;
      out.push(rec);
    });
    return out;
  }

  function reviewChannel(sourceValue, productValue) {
    var s = (clean(sourceValue) + ' ' + clean(productValue)).toLowerCase();
    if (/trustpilot/.test(s)) return 'trustpilot_review';
    return 'amazon_review';
  }

  function mapReviews(rows, mapping) {
    var out = [];
    var cls = window.VOC && VOC.classify;
    rows.forEach(function (row) {
      var g = cellGetter(row, mapping);
      var title = clean(g('title')), body = clean(g('body'));
      if (!title && !body) return;
      var channel = reviewChannel(g('source'), '');
      var rec = {
        subject: title || body.slice(0, 80),
        text: body,
        from_name: clean(g('author')) || null,
        from_email: null,
        received_at: parseLooseDate(g('date')),
        channel: channel,
        sales_channel: channel === 'amazon_review' ? 'amazon' : 'dtc_web',
        rating: toNum(g('rating'), 1, 5, true),
        status: 'resolved',
        service_fields_source: 'unavailable',
        source: 'csv'
      };
      var productCol = clean(g('product'));
      var product = productCol ? resolveProduct(productCol) : null;
      if (!product && cls && typeof cls.detectProduct === 'function') {
        try { var d = cls.detectProduct(body, title); if (d && d.product) product = d.product; } catch (e) { product = null; }
      }
      if (product) rec.product = product;
      if (productCol) rec.product_variant = productCol;
      var rid = clean(g('review_id'));
      if (rid) rec.message_id = 'review:' + rid;
      out.push(rec);
    });
    return out;
  }

  function mapOrders(rows, mapping) {
    var orders = { _total: {} }, skipped = 0;
    rows.forEach(function (row) {
      var g = cellGetter(row, mapping);
      var month = normMonth(g('month')), product = resolveProduct(g('product')), n = toNum(g('orders'), 0, undefined, true);
      if (!month || n === null) { skipped++; return; }
      var pid = product || 'general';
      orders[pid] = orders[pid] || {};
      orders[pid][month] = (orders[pid][month] || 0) + n;
      orders._total[month] = (orders._total[month] || 0) + n;
    });
    return { ordersByMonth: orders, skipped: skipped, months: Object.keys(orders._total).sort() };
  }

  var NUMERIC = { sentiment: [-1, 1, false], sentiment_min: [-1, 1, false], nps: [0, 10, true], rating: [1, 5, true], csat: [1, 5, true], reopen_count: [0, undefined, true], schema_version: [1, undefined, true] };
  var BOOLEAN = ['has_attachment', 'is_adverse_event', 'serious_ae', 'food_safety', 'claim_related', 'cancel_intent', 'restricted', 'is_first_contact', 'is_noise'];
  var LISTS = ['secondary_categories', 'ae_criteria', 'contraindication_flags', 'tags'];
  var DATES = ['received_at', 'first_response_at', 'resolved_at'];

  function mapRecords(rows, mapping) {
    var out = [];
    rows.forEach(function (row) {
      var g = cellGetter(row, mapping), rec = {}, classifier = {}, any = false;
      Object.keys(mapping.columns).forEach(function (field) {
        if (mapping.columns[field] === null) return;
        var raw = g(field), s = clean(raw);
        if (s === '') return;
        any = true;
        if (field.indexOf('classifier_') === 0) {
          var key = field.slice('classifier_'.length);
          classifier[key] = key === 'confidence' ? toNum(s, 0, 1) : (key === 'manual_override' || key === 'needs_review' ? toBool(s) : s);
        } else if (NUMERIC[field]) rec[field] = toNum(s, NUMERIC[field][0], NUMERIC[field][1], NUMERIC[field][2]);
        else if (BOOLEAN.indexOf(field) >= 0) rec[field] = toBool(s);
        else if (LISTS.indexOf(field) >= 0) rec[field] = splitList(s);
        else if (DATES.indexOf(field) >= 0) rec[field] = parseLooseDate(s);
        else if (field === 'notes') { try { rec.notes = JSON.parse(s); } catch (e) { rec.notes = [{ at: null, by: 'import', text: s }]; } }
        else rec[field] = s;
      });
      if (!any) return;
      if (Object.keys(classifier).length) rec.classifier = classifier;
      if (!rec.source) rec.source = 'csv';
      out.push(rec);
    });
    return out;
  }

  /**
   * Map parsed CSV rows through a template mapping.
   * helpdesk / reviews / records → Partial<Record>[]; orders_monthly → { ordersByMonth, months, skipped }.
   * @param {string[][]|Object[]} rows
   * @param {Object|string} mapping Mapping or template id (template id only works with object rows)
   */
  function mapRows(rows, mapping) {
    var m = resolveMapping(mapping || {});
    var list = Array.isArray(rows) ? rows : [];
    switch (m.template) {
      case 'helpdesk': return mapHelpdesk(list, m);
      case 'reviews': return mapReviews(list, m);
      case 'orders_monthly': return mapOrders(list, m);
      case 'records': return mapRecords(list, m);
      default: return [];
    }
  }

  /** Parse CSV text and map it in one step. */
  function applyCsv(text, mapping) {
    var parsed = parseCsvText(text);
    var m = mapping || (detectTemplate(parsed.headers) ? buildMapping(parsed.headers, detectTemplate(parsed.headers)) : null);
    if (!m) return null;
    if (!m.headers || !m.headers.length) m = Object.assign({}, m, { headers: parsed.headers });
    return mapRows(parsed.rows, m);
  }

  /* -------------------------------------------------------- mapping memory */

  /** Stable fingerprint of a header row (order-sensitive, case/punctuation-insensitive). */
  function headerFingerprint(headers) {
    return fnv64((headers || []).map(normHeader).join('|'));
  }

  function storage() {
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* blocked */ }
    return null;
  }

  function loadMappings() {
    var ls = storage(); if (!ls) return {};
    try { var raw = ls.getItem(STORAGE_KEY); var obj = raw ? JSON.parse(raw) : {}; return obj && typeof obj === 'object' ? obj : {}; } catch (e) { return {}; }
  }

  /**
   * Remember a mapping for this header row in localStorage['voc.csv.mappings'].
   * @returns {boolean} true when stored
   */
  function rememberMapping(headers, mapping) {
    var ls = storage(); if (!ls || !mapping) return false;
    try {
      var all = loadMappings();
      all[headerFingerprint(headers)] = { template: mapping.template, columns: mapping.columns, headers: headers.slice(), saved_at: new Date().toISOString() };
      ls.setItem(STORAGE_KEY, JSON.stringify(all));
      return true;
    } catch (e) { return false; }
  }

  /** Recall a remembered mapping for this header row, or null. */
  function recallMapping(headers) {
    var all = loadMappings(), m = all[headerFingerprint(headers)];
    if (!m || !m.template) return null;
    return { template: m.template, headers: headers.slice(), fingerprint: headerFingerprint(headers), columns: m.columns || {}, missing: [] };
  }

  /** Forget every remembered mapping. */
  function forgetMappings() {
    var ls = storage(); if (!ls) return false;
    try { ls.removeItem(STORAGE_KEY); return true; } catch (e) { return false; }
  }

  /* ------------------------------------------------------------- .json */

  function looksLikeRawEmail(item) {
    return !!item && typeof item === 'object' && 'from_email' in item && 'date' in item && 'subject' in item && !('category' in item);
  }

  /**
   * Parse JSON text: native Record[], {records}, a backup {seed_meta, records, overlays, settings, orders}, or RawEmail[].
   * @param {string} text
   * @returns {{kind: 'records'|'raw'|'backup'|'empty', items: Object[], overlays?: Object[], settings?: Object, ordersByMonth?: Object, seed_meta?: Object}}
   */
  function parseJsonFull(text) {
    var data;
    try { data = JSON.parse(String(text || '').replace(/^\uFEFF/, '')); } catch (e) { throw new Error('Not valid JSON: ' + e.message); }
    var result = { kind: 'empty', items: [] };
    var arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && typeof data === 'object') {
      if (Array.isArray(data.records)) arr = data.records;
      else if (Array.isArray(data.items)) arr = data.items;
      else if (looksLikeRawEmail(data) || ('subject' in data && 'category' in data)) arr = [data];
      if ('overlays' in data || 'settings' in data || 'seed_meta' in data) {
        result.kind = 'backup';
        var ov = data.overlays;
        var ovList = Array.isArray(ov) ? ov : (ov && typeof ov === 'object' ? Object.keys(ov).filter(function (k) { return !unsafeKey(k); }).map(function (k) { return Object.assign({ id: k }, ov[k]); }) : []);
        result.overlays = stripUnsafeKeys(ovList);
        result.settings = data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? stripUnsafeKeys(data.settings) : null;
        result.ordersByMonth = sanitizeOrders(data.orders) || sanitizeOrders(data.orders_by_month);
        result.seed_meta = data.seed_meta && typeof data.seed_meta === 'object' ? stripUnsafeKeys(data.seed_meta) : null;
      } else if (data.orders_by_month || (data._total && typeof data._total === 'object')) {
        result.ordersByMonth = sanitizeOrders(data.orders_by_month || data);
        result.kind = 'orders';
      }
    }
    if (!arr) return result;
    var items = arr.filter(function (x) { return x && typeof x === 'object'; });
    var rawCount = items.filter(looksLikeRawEmail).length;
    var isRaw = items.length > 0 && rawCount >= items.length / 2;
    result.items = items.map(function (it) {
      if (!it.source) it.source = 'json';
      return it;
    });
    if (result.kind !== 'backup') result.kind = isRaw ? 'raw' : (items.length ? 'records' : 'empty');
    return result;
  }

  /**
   * Parse JSON text into importable items (Record[] or RawEmail[]).
   * @param {string} text
   * @returns {Object[]}
   */
  function parseJsonText(text) { return parseJsonFull(text).items; }

  /* --------------------------------------------- untrusted-object hygiene */

  var hasOwn = Object.prototype.hasOwnProperty;
  var PRODUCT_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
  var MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  /** Keys that would reach Object.prototype (or a constructor) when written through a plain object. */
  function unsafeKey(k) { return k === '__proto__' || k === 'constructor' || k === 'prototype'; }

  /**
   * Deep copy of plain JSON data (objects and arrays) without __proto__/constructor/prototype keys at any level.
   * JSON.parse creates "__proto__" as an own property; assigning it back onto a plain object would rewrite the
   * prototype chain, so backups and settings pass through here before anything merges them.
   * @param {*} value
   * @returns {*}
   */
  function stripUnsafeKeys(value) {
    if (Array.isArray(value)) return value.map(stripUnsafeKeys);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).forEach(function (k) { if (!unsafeKey(k)) out[k] = stripUnsafeKeys(value[k]); });
    return out;
  }

  /**
   * Validate an orders-by-month map from a file: `{ _total: {'YYYY-MM': n}, <productId>: {'YYYY-MM': n} }`.
   * Product keys must match /^[A-Za-z0-9_.-]{1,64}$/ (or be `_total`), month keys YYYY-MM, values finite numbers;
   * anything else is dropped. Returns null when `src` is not an object.
   * @param {*} src
   * @returns {Object|null}
   */
  function sanitizeOrders(src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    var out = { _total: {} };
    Object.keys(src).forEach(function (pid) {
      if (unsafeKey(pid) || !PRODUCT_KEY_RE.test(pid)) return;
      var byMonth = src[pid];
      if (!byMonth || typeof byMonth !== 'object' || Array.isArray(byMonth)) return;
      Object.keys(byMonth).forEach(function (mo) {
        if (unsafeKey(mo) || !MONTH_KEY_RE.test(mo)) return;
        var n = typeof byMonth[mo] === 'number' ? byMonth[mo] : Number(byMonth[mo]);
        if (!isFinite(n)) return;
        if (!hasOwn.call(out, pid)) out[pid] = {};
        out[pid][mo] = n;
      });
    });
    return out;
  }

  /* -------------------------------------------------------- file reading */

  function bytesToBinaryString(bytes) {
    var out = [], CH = 8192;
    for (var i = 0; i < bytes.length; i += CH) out.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length))));
    return out.join('');
  }

  /** Read a File as latin1-preserving text (one char per byte) or as UTF-8 text. */
  function readFile(file, mode) {
    return new Promise(function (resolve, reject) {
      if (mode === 'binary' && typeof file.arrayBuffer === 'function') {
        file.arrayBuffer().then(function (buf) { resolve(bytesToBinaryString(new Uint8Array(buf))); }, reject);
        return;
      }
      if (mode !== 'binary' && typeof file.text === 'function') { file.text().then(resolve, reject); return; }
      if (typeof FileReader === 'undefined') { reject(new Error('File reading is not available here')); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error || new Error('Could not read ' + file.name)); };
      if (mode === 'binary') fr.readAsBinaryString(file); else fr.readAsText(file);
    });
  }

  function extOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  var MB = 1024 * 1024;
  /** Per-file byte limits: everything is parsed in memory (arrayBuffer → binary string → lines), so a multi-GB Takeout .mbox would kill the tab. */
  var FILE_LIMITS = { eml: 25 * MB, csv: 50 * MB, json: 50 * MB, mbox: 150 * MB };

  function fmtMb(bytes) { return String(Math.round(bytes / MB * 10) / 10); }

  /** Error message for an oversize file, or null when the file may be read. */
  function sizeProblem(file, kind) {
    var limit = FILE_LIMITS[kind];
    if (!limit || typeof file.size !== 'number' || !(file.size > limit)) return null;
    return 'File is ' + fmtMb(file.size) + ' MB; the limit for .' + kind + ' is ' + fmtMb(limit) + ' MB. ' +
      (kind === 'mbox' ? 'Export one label or one date range at a time (Google Takeout offers both) and drop the parts one by one.' : 'Split the file and import the parts one by one.');
  }

  function guessKind(file) {
    var ext = extOf(file.name), type = String(file.type || '').toLowerCase();
    if (ext === 'eml' || type === 'message/rfc822') return 'eml';
    if (ext === 'mbox' || ext === 'mbx' || type === 'application/mbox') return 'mbox';
    if (ext === 'csv' || ext === 'tsv' || (ext === 'txt' && type.indexOf('csv') >= 0) || type === 'text/csv') return 'csv';
    if (ext === 'json' || type === 'application/json') return 'json';
    return null;
  }

  /**
   * Add an orders map onto `target` (same shape as sanitizeOrders). `add` is sanitized first, so a crafted key such as
   * "__proto__" never reaches the prototype chain and only YYYY-MM months with finite counts are summed.
   * @param {Object} target
   * @param {Object} add
   * @returns {Object} target
   */
  function mergeOrders(target, add) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) target = { _total: {} };
    var clean = sanitizeOrders(add) || { _total: {} };
    Object.keys(clean).forEach(function (pid) {
      if (!hasOwn.call(target, pid) || !target[pid] || typeof target[pid] !== 'object') target[pid] = {};
      Object.keys(clean[pid]).forEach(function (mo) { target[pid][mo] = (Number(target[pid][mo]) || 0) + clean[pid][mo]; });
    });
    return target;
  }

  function pendingRows(pending) {
    return pending.reduce(function (n, p) { return n + (p && Array.isArray(p.rows) ? p.rows.length : 0); }, 0);
  }
  /**
   * One sentence for the import toast/log. Counts only items actually parsed; CSV files still waiting for a
   * column mapping are named separately so "n = 0" never reads as "nothing found".
   * @param {{files?:number, items?:number, orderMonths?:number, pending?:Object[], errors?:Object[]}} s
   * @returns {string}
   */
  function summaryText(s) {
    s = s || {};
    var pending = Array.isArray(s.pending) ? s.pending : [], errors = Array.isArray(s.errors) ? s.errors : [];
    var items = typeof s.items === 'number' ? s.items : 0, files = typeof s.files === 'number' ? s.files : 0;
    var parts = [];
    if (items) parts.push(items + ' item' + (items === 1 ? '' : 's') + ' parsed');
    if (s.orderMonths) parts.push('orders for ' + s.orderMonths + ' month' + (s.orderMonths === 1 ? '' : 's'));
    if (pending.length) {
      var rows = pendingRows(pending);
      parts.push(pending.length + ' CSV file' + (pending.length === 1 ? '' : 's') + (rows ? ' with ' + rows + ' row' + (rows === 1 ? '' : 's') : '') +
        ' await' + (pending.length === 1 ? 's' : '') + ' a column mapping');
    }
    if (errors.length) parts.push(errors.length + ' error' + (errors.length === 1 ? '' : 's'));
    if (!parts.length) parts.push('nothing to import');
    return 'Read ' + files + ' file' + (files === 1 ? '' : 's') + ': ' + parts.join(', ') + ' (n = ' + items + (pending.length ? ' parsed so far' : '') + ').';
  }

  /**
   * (Re)builds result.summary from what the result actually holds: items parsed, order months, pending CSV
   * mappings, errors and the sentence in summary.text. Call it again after resolving pending mappings
   * (push the mapped rows onto result.items, drop the entry from result.summary.pending, then buildSummary(result)).
   * @param {{items?:Object[], summary?:Object, ordersByMonth?:Object}} result
   * @returns {Object} the summary (also assigned to result.summary)
   */
  function buildSummary(result) {
    result = result || {};
    var s = result.summary = result.summary || {};
    s.files = typeof s.files === 'number' ? s.files : 0;
    s.byType = s.byType || { eml: 0, mbox: 0, csv: 0, json: 0, other: 0 };
    s.errors = Array.isArray(s.errors) ? s.errors : [];
    s.pending = Array.isArray(s.pending) ? s.pending : [];
    s.items = Array.isArray(result.items) ? result.items.length : 0;
    s.orderMonths = result.ordersByMonth && result.ordersByMonth._total ? Object.keys(result.ordersByMonth._total).length : 0;
    s.text = summaryText(s);
    return s;
  }

  /**
   * Browser entry point: read a FileList/File[] and parse every supported file.
   * .eml/.mbox are read as latin1-preserving text so mime.js can decode charsets.
   * CSV files with no detectable/remembered mapping land in summary.pending for the mapping dialog.
   * Files over FILE_LIMITS for their kind (25 MB .eml, 50 MB .csv/.json, 150 MB .mbox) are not read; they land in
   * summary.errors with the limit and how to split the export.
   * @param {FileList|File[]} files
   * @param {{mappings?: Object<string, Object>, agentAddresses?: string[], agentDomains?: string[]}} [opts] mappings keyed by header fingerprint
   * @returns {Promise<{items: Object[], summary: Object, ordersByMonth?: Object, overlays?: Object[], settings?: Object}>}
   */
  function handleFiles(files, opts) {
    opts = opts || {};
    var list = files ? Array.prototype.slice.call(files) : [];
    var result = { items: [], summary: { files: list.length, byType: { eml: 0, mbox: 0, csv: 0, json: 0, other: 0 }, items: 0, orderMonths: 0, errors: [], pending: [], text: '' } };
    var orders = null, overlays = null, settings = null;
    var mailOpts = { agentAddresses: opts.agentAddresses, agentDomains: opts.agentDomains };

    var chain = Promise.resolve();
    list.forEach(function (file) {
      chain = chain.then(function () {
        var kind = guessKind(file);
        if (!kind) { result.summary.byType.other++; result.summary.errors.push({ file: file.name, message: 'Unsupported file type (use .eml, .mbox, .csv or .json)' }); return; }
        result.summary.byType[kind]++;
        var tooBig = sizeProblem(file, kind);
        if (tooBig) { result.summary.errors.push({ file: file.name, message: tooBig }); return; }
        return readFile(file, kind === 'eml' || kind === 'mbox' ? 'binary' : 'text').then(function (text) {
          if (kind === 'eml') { result.items.push(parseEmlText(text, mailOpts)); return; }
          if (kind === 'mbox') { parseMboxText(text, mailOpts).forEach(function (r) { result.items.push(r); }); return; }
          if (kind === 'json') {
            var full = parseJsonFull(text);
            full.items.forEach(function (r) { result.items.push(r); });
            if (full.ordersByMonth) orders = mergeOrders(orders || { _total: {} }, full.ordersByMonth);
            if (full.overlays && full.overlays.length) overlays = (overlays || []).concat(full.overlays);
            if (full.settings) settings = Object.assign(settings || {}, full.settings);
            return;
          }
          var parsed = parseCsvText(text);
          if (!parsed.headers.length) { result.summary.errors.push({ file: file.name, message: 'Empty CSV' }); return; }
          var fp = headerFingerprint(parsed.headers);
          var mapping = (opts.mappings && opts.mappings[fp]) || recallMapping(parsed.headers);
          if (!mapping) { var tid = detectTemplate(parsed.headers); if (tid) mapping = buildMapping(parsed.headers, tid); }
          if (!mapping) {
            result.summary.pending.push({ file: file.name, headers: parsed.headers, fingerprint: fp, rows: parsed.rows, sample: parsed.rows.slice(0, 5), suggestions: TEMPLATE_ORDER.map(function (id) { return buildMapping(parsed.headers, id); }) });
            return;
          }
          if (!mapping.headers || !mapping.headers.length) mapping = Object.assign({}, mapping, { headers: parsed.headers });
          if (opts.mappings && opts.mappings[fp]) rememberMapping(parsed.headers, mapping);
          var mapped = mapRows(parsed.rows, mapping);
          if (mapped && mapped.ordersByMonth) { orders = mergeOrders(orders || { _total: {} }, mapped.ordersByMonth); return; }
          mapped.forEach(function (r) { result.items.push(r); });
        });
      }).catch(function (err) {
        result.summary.errors.push({ file: file.name, message: err && err.message ? err.message : String(err) });
      });
    });

    return chain.then(function () {
      if (orders) result.ordersByMonth = orders;
      if (overlays) result.overlays = overlays;
      if (settings) result.settings = settings;
      buildSummary(result);
      return result;
    });
  }

  return {
    TEMPLATES: TEMPLATES,
    parseEmlText: parseEmlText,
    parseMboxText: parseMboxText,
    parseCsvText: parseCsvText,
    detectTemplate: detectTemplate,
    buildMapping: buildMapping,
    mapRows: mapRows,
    applyCsv: applyCsv,
    parseJsonText: parseJsonText,
    parseJsonFull: parseJsonFull,
    headerFingerprint: headerFingerprint,
    rememberMapping: rememberMapping,
    recallMapping: recallMapping,
    forgetMappings: forgetMappings,
    resolveProduct: resolveProduct,
    parseLooseDate: parseLooseDate,
    normMonth: normMonth,
    summaryText: summaryText,
    buildSummary: buildSummary,
    handleFiles: handleFiles,
    mergeOrders: mergeOrders,
    sanitizeOrders: sanitizeOrders,
    stripUnsafeKeys: stripUnsafeKeys,
    FILE_LIMITS: FILE_LIMITS
  };
})();
