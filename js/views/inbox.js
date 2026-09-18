/* L-Nutra · Voice of the Customer — Inbox view (SPEC §5.6)
   Operator desk: command strip, saved views, selectable triage table, bulk actions with Undo, import drop zone,
   and the record drawer (#/inbox/:id) with editing, notes, customer/prediction panels, regulatory checklist, audit.
   Loads under jsc: nothing touches the DOM at parse time. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'inbox';
  var TITLE = 'Inbox';
  var PAGE_SIZE = 50;
  var URGENCY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

  /* Shared regulatory checklist definitions (regulatory.js reads the same object; whichever loads first defines it). */
  VOC.regulatoryChecklist = VOC.regulatoryChecklist || {
    medwatch: [
      { id: 'patient_id', label: 'Patient identifier (initials or code), age, sex, weight' },
      { id: 'event_description', label: 'Description of the event and outcome attributed' },
      { id: 'event_date', label: 'Date of event and date of this report' },
      { id: 'tests_labs', label: 'Relevant tests and laboratory data' },
      { id: 'history', label: 'Other relevant history (conditions, medications, allergies)' },
      { id: 'product_lot', label: 'Product name, strength/variant and lot number' },
      { id: 'dose_dates', label: 'Dose, frequency, route and dates of use' },
      { id: 'dechallenge', label: 'Event abated after use stopped (dechallenge)' },
      { id: 'reporter_contact', label: 'Reporter name, address and contact' },
      { id: 'hcp_reporter', label: 'Health professional reporter identified (if any)' },
      { id: 'manufacturer_block', label: 'Manufacturer block: report source, date received, initial vs follow-up' },
      { id: 'submitted', label: 'Form 3500A submitted to FDA (record confirmation number in a note)' }
    ],
    rfr: [
      { id: 'lot_identified', label: 'Lot and product identified' },
      { id: 'hazard_evaluated', label: 'Reasonable probability of serious adverse health consequences evaluated' },
      { id: 'quarantined', label: 'Affected inventory quarantined' },
      { id: 'sample_retained', label: 'Customer sample or photos retained' },
      { id: 'supplier_notified', label: 'Supplier / co-packer notified' },
      { id: 'rfr_submitted', label: 'Reportable Food Registry report submitted within 24 hours (or documented as not reportable)' },
      { id: 'customer_followup', label: 'Customer follow-up completed' }
    ],
    tagPrefix: { medwatch: 'ae:', rfr: 'rfr:', criteria: 'ae:crit:' },
    /** @returns {{done:number,total:number,pct:number|null,kind:'medwatch'|'rfr'|null}} */
    progress: function (rec) {
      var kind = rec && rec.regulatory_clock === 'rfr_24h' ? 'rfr' : (rec && (rec.serious_ae || rec.is_adverse_event || rec.regulatory_clock === 'medwatch_15bd') ? 'medwatch' : (rec && rec.food_safety ? 'rfr' : null));
      if (!kind) return { done: 0, total: 0, pct: null, kind: null };
      var list = VOC.regulatoryChecklist[kind];
      var prefix = VOC.regulatoryChecklist.tagPrefix[kind];
      var tags = Array.isArray(rec.tags) ? rec.tags : [];
      var done = list.filter(function (f) { return tags.indexOf(prefix + f.id) >= 0; }).length;
      return { done: done, total: list.length, pct: list.length ? done / list.length : null, kind: kind };
    }
  };

  /* ------------------------------------------------------------------ helpers */

  function ui() { return VOC.ui || null; }
  function store() { return VOC.store || null; }
  function U() { return VOC.util || {}; }
  function E() { return VOC.enums || null; }
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
  function label(kind, id) {
    var e = E();
    if (e && typeof e.label === 'function') { try { return e.label(kind, id); } catch (err) { /* fall through */ } }
    return id == null ? '—' : String(id);
  }
  function fmtInt(n) { return U().fmt && U().fmt.int ? U().fmt.int(n) : String(n); }
  function fmtHours(hrs) { return U().fmt && U().fmt.hours ? U().fmt.hours(hrs) : (isNum(hrs) ? Math.round(hrs) + 'h' : '—'); }
  function fmtDate(iso, gran) { return U().fmt && U().fmt.date ? U().fmt.date(iso, gran || 'datetime') : String(iso || '—'); }
  function fmtNum(n, d) { return U().fmt && U().fmt.num ? U().fmt.num(n, d) : (isNum(n) ? n.toFixed(d || 0) : '—'); }
  function fmtUsd(n) { return U().fmt && U().fmt.usd ? U().fmt.usd(n) : (isNum(n) ? '$' + Math.round(n) : '—'); }
  function toast(msg, kind, opts) { if (ui() && ui().toast) return ui().toast(msg, kind, opts); return null; }
  function pill(kind, value) {
    if (ui() && ui().pill) return ui().pill(kind, value);
    return h('span', { class: 'pill' }, String(value));
  }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + derived.n + ' records' : '';
  }
  function me() { var s = store() && store().settings ? store().settings() : null; return (s && s.me) || 'You'; }
  function agents() { var s = store() && store().settings ? store().settings() : null; return (s && Array.isArray(s.agents)) ? s.agents : []; }
  function settings() { return store() && store().settings ? store().settings() : {}; }
  function filters() { return store() && store().filters ? store().filters() : {}; }
  function currentQuery() { return store() && store().toQuery ? store().toQuery() : ''; }
  function navigate(id, opts) {
    var r = VOC.router;
    if (!r) return;
    r.navigate(NAME, Object.assign({ id: id || undefined, query: routeQuery() }, opts || {}));
  }
  /** The filter query plus the view-private weekday × hour slot (dow=, hour=) when one is active. */
  function routeQuery() {
    var q = currentQuery();
    if (S.slot) q += (q ? '&' : '') + 'dow=' + S.slot.dow + '&hour=' + S.slot.hour;
    return q;
  }
  function sameSet(a, b) {
    a = (a || []).slice().sort(); b = (b || []).slice().sort();
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /* ------------------------------------------------------------------ state */

  var S = {
    root: null, derived: null, els: {}, table: null, rows: [], selected: [], cursor: null, openId: null,
    keyHandler: null, pendingG: false, gTimer: null, viewsHandler: null, pendingFocus: null, csatCache: null,
    stripSig: '', drawerScroll: 0, viewsSig: '',
    /* drawerSig: store version + redaction inputs the open drawer was last built from; rerendering: true while
       renderDrawer() re-populates the already-open drawer so onDrawerClosed ignores a spurious callback. */
    drawerSig: '', rerendering: false,
    moreColumns: readMoreColumns(),
    /* slot: {dow 0–6 (Mon–Sun), hour 0–23} from the Trends heatmap drill; a view-local post-filter on the table rows. */
    slot: null
  };
  var DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /* ------------------------------------------------------------------ weekday × hour slot (heatmap drill) */

  /** Parse dow=/hour= out of a hash query; null when absent or out of range. */
  function slotFromQuery(query) {
    var r = VOC.router;
    if (!r || typeof r.parseQuery !== 'function' || !query) return null;
    var q = r.parseQuery(query);
    if (q.dow === undefined || q.hour === undefined) return null;
    var dow = parseInt(q.dow, 10), hour = parseInt(q.hour, 10);
    if (!isNum(dow) || !isNum(hour) || dow < 0 || dow > 6 || hour < 0 || hour > 23) return null;
    return { dow: dow, hour: hour };
  }
  function sameSlot(a, b) { return (!a && !b) || (!!a && !!b && a.dow === b.dow && a.hour === b.hour); }
  function slotLabel(slot) {
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return DOW_LABELS[slot.dow] + ' ' + two(slot.hour) + ':00–' + two(slot.hour + 1) + ':00 CT';
  }
  function slotFilter(rows) {
    if (!S.slot) return rows;
    return rows.filter(function (r) { return r.dow === S.slot.dow && r.hour === S.slot.hour; });
  }
  /** Set (or clear) the slot, refilter the table and keep the hash in step. */
  function setSlot(slot, fromRoute) {
    if (sameSlot(slot, S.slot)) return;
    S.slot = slot || null;
    S.rows = slotFilter(rowsFromDerived(S.derived));
    if (S.table) { S.table.update(S.rows, { keepSelection: true }); S.selected = S.table.selection(); renderBulk(); }
    renderSlot();
    if (!fromRoute) navigate(S.openId, { replace: true });
  }
  function renderSlot() {
    var host = S.els.slot;
    if (!host) return;
    host.innerHTML = '';
    if (!S.slot) { host.hidden = true; return; }
    host.hidden = false;
    var inRange = S.derived && Array.isArray(S.derived.records) ? S.derived.records.length : 0;
    var x = h('button', { class: 'chip__x', type: 'button', 'aria-label': 'Remove the weekday and hour filter', html: '&times;', onclick: function () { setSlot(null); } });
    host.appendChild(h('span', { class: 'label', text: 'Table limited to' }));
    host.appendChild(h('span', { class: 'chip chip--value' }, [h('span', { class: 'chip__dim', text: 'Weekday × hour:' }), h('span', { text: slotLabel(S.slot) }), x]));
    host.appendChild(h('span', { class: 'muted t-13', text: fmtInt(S.rows.length) + ' of ' + fmtInt(inRange) + ' records in range arrived in this slot; the tiles above still count the whole range.' }));
  }

  var MORE_COLUMNS_KEY = 'voc.inbox.moreColumns';
  function readMoreColumns() {
    try { return window.localStorage.getItem(MORE_COLUMNS_KEY) === '1'; } catch (e) { return false; }
  }
  function writeMoreColumns(on) {
    try { window.localStorage.setItem(MORE_COLUMNS_KEY, on ? '1' : '0'); } catch (e) { /* unavailable */ }
  }

  function rowsFromDerived(derived) {
    var recs = (derived && Array.isArray(derived.records)) ? derived.records.slice() : [];
    recs.sort(function (a, b) {
      var ua = URGENCY_RANK[a.urgency], ub = URGENCY_RANK[b.urgency];
      if (ua !== ub) return (ua == null ? 9 : ua) - (ub == null ? 9 : ub);
      var aa = isNum(a.age_hours) ? a.age_hours : -1, ab = isNum(b.age_hours) ? b.age_hours : -1;
      return ab - aa;
    });
    return recs;
  }

  /* ------------------------------------------------------------------ command strip */

  var TILES = [
    { id: 'open_p0', label: 'Open P0', tone: 'critical', formula: 'open ∧ urgency = P0', count: function (r) { return r.is_open && r.urgency === 'P0'; }, view: { flags: ['open'], urgency: ['P0'] } },
    { id: 'open_p1', label: 'Open P1', tone: 'serious', formula: 'open ∧ urgency = P1', count: function (r) { return r.is_open && r.urgency === 'P1'; }, view: { flags: ['open'], urgency: ['P1'] } },
    { id: 'sla_breached', label: 'SLA breached', tone: 'critical', kpi: 'sla_breached', formula: 'open ∧ no first response ∧ age > SLA[urgency]', count: function (r) { return r.is_open && r.frt_hours === null && r.sla_frt_breached; }, view: { flags: ['sla_breached'] } },
    { id: 'unassigned', label: 'Unassigned', tone: 'warning', kpi: 'unassigned', formula: 'open ∧ assignee = null', count: function (r) { return r.is_open && !r.assignee; }, view: { flags: ['open', 'unassigned'] } },
    { id: 'aging_48h', label: 'Aging > 48h', tone: 'warning', kpi: 'backlog_48h', formula: 'open ∧ age > 48h', count: function (r) { return r.is_open && isNum(r.age_hours) && r.age_hours > 48; }, view: { flags: ['aging_48h'] } },
    { id: 'detractor_followup', label: 'Detractors awaiting follow-up', tone: 'warning', formula: 'nps ≤ 6 ∧ recovered = null', count: function (r) { return r.is_detractor && r.recovered === null; }, view: { flags: ['detractor_followup'] } }
  ];

  function tileFiltersActive(view) {
    var f = filters();
    if (!sameSet(f.flags, view.flags)) return false;
    if (view.urgency && !sameSet(f.urgency, view.urgency)) return false;
    if (!view.urgency && f.urgency && f.urgency.length) return false;
    return true;
  }

  /**
   * One bold sentence for the header: open P0 and P1 counts and first-response SLA breaches, with n in range.
   * @param {Object|null} derived
   * @param {Array<{tile:Object, value:number}>} [items]  the command-strip values when already computed
   */
  function leadText(derived, items) {
    if (!derived || !Array.isArray(derived.records)) return 'Data is loading.';
    var recs = derived.records;
    var kpis = derived.kpis || {};
    function valueOf(id) {
      var it = items && items.filter(function (x) { return x.tile.id === id; })[0];
      if (it) return it.value;
      var t = TILES.filter(function (x) { return x.id === id; })[0];
      if (!t) return 0;
      return t.kpi && kpis[t.kpi] && isNum(kpis[t.kpi].value) ? kpis[t.kpi].value : recs.filter(t.count).length;
    }
    var p0 = valueOf('open_p0'), p1 = valueOf('open_p1'), sla = valueOf('sla_breached');
    if (!recs.length) return 'No records match the current filters (n=0).';
    return fmtInt(p0) + ' open P0 and ' + fmtInt(p1) + ' open P1; ' + fmtInt(sla) + ' past the first-response SLA (n=' + fmtInt(recs.length) + ' in range).';
  }
  function renderStrip(derived) {
    var strip = S.els.strip;
    if (!strip) return;
    var recs = (derived && derived.records) || [];
    var kpis = (derived && derived.kpis) || {};
    var sig = [];
    var items = TILES.map(function (t) {
      var k = t.kpi && kpis[t.kpi] && isNum(kpis[t.kpi].value) ? kpis[t.kpi].value : recs.filter(t.count).length;
      sig.push(k, tileFiltersActive(t.view) ? 1 : 0);
      return { tile: t, value: k };
    });
    if (S.els.header && S.els.header.setLead) S.els.header.setLead(leadText(derived, items));
    var sigStr = sig.join('|');
    if (sigStr === S.stripSig) return;
    S.stripSig = sigStr;
    strip.innerHTML = '';
    items.forEach(function (it) {
      var t = it.tile;
      var active = tileFiltersActive(t.view);
      var btn = h('button', {
        class: 'command-tile command-tile--' + t.tone, type: 'button', 'aria-pressed': String(active),
        title: t.formula + ' · click to filter the table',
        onclick: function () { applyViewFilters(active ? null : t.view, true); }
      }, [
        h('span', { class: 'command-tile__label', text: t.label }),
        h('span', { class: 'command-tile__value' + (it.value === 0 ? ' is-zero' : ''), text: fmtInt(it.value) }),
        h('span', { class: 'command-tile__n', text: 'of ' + fmtInt(recs.length) + ' in range' })
      ]);
      strip.appendChild(btn);
    });
  }

  /* ------------------------------------------------------------------ saved views */

  /**
   * Apply a view's filter patch on top of a clean flags/urgency/restricted slate.
   * Command-strip tiles keep the current range (so the tile count matches the table); saved views bring their own.
   */
  function applyViewFilters(viewFilters, keepRange) {
    var s = store();
    if (!s) return;
    var patch = { flags: [], restrictedQueue: false, urgency: [] };
    if (viewFilters) {
      Object.keys(viewFilters).forEach(function (k) {
        if (k === 'range') { if (!keepRange) patch.range = { preset: viewFilters.range.preset || '12m', from: viewFilters.range.from, to: viewFilters.range.to }; }
        else patch[k] = viewFilters[k];
      });
      if (!patch.range && !keepRange) patch.range = { preset: '12m' };
    }
    s.setFilters(patch);
    S.cursor = null;
  }

  function viewIsActive(view) {
    var f = filters();
    var vf = view.filters || {};
    var keys = Object.keys(vf);
    if (!keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'range') { if (vf.range && vf.range.preset && f.range && f.range.preset !== vf.range.preset) return false; continue; }
      if (Array.isArray(vf[k])) { if (!sameSet(vf[k], f[k])) return false; }
      else if (k === 'restrictedQueue') { if (!!vf[k] !== !!f[k]) return false; }
      else if (k === 'search' || k === 'compare') { if ((vf[k] || '') !== (f[k] || '')) return false; }
    }
    if (!vf.flags && f.flags && f.flags.length) return false;
    if (vf.flags && !vf.restrictedQueue && f.restrictedQueue) return false;
    return true;
  }

  function renderViews() {
    var bar = S.els.views;
    var s = store();
    if (!bar || !s || typeof s.savedViews !== 'function') return;
    var views = s.savedViews();
    var sig = views.map(function (v) { return v.id + ':' + (viewIsActive(v) ? 1 : 0); }).join('|');
    if (sig === S.viewsSig) return;
    S.viewsSig = sig;
    bar.innerHTML = '';
    bar.appendChild(h('span', { class: 'label inbox-views__label', text: 'Views' }));
    views.forEach(function (v) {
      var active = viewIsActive(v);
      var chip = h('button', {
        class: 'chip' + (active ? ' chip--active' : ''), type: 'button', 'aria-pressed': String(active), title: v.builtin ? 'Built-in view' : 'Saved view',
        onclick: function () { if (active) applyViewFilters(null); else applySavedView(v); }
      }, h('span', { text: v.name }));
      if (!v.builtin) {
        var x = h('button', { class: 'chip__x', type: 'button', 'aria-label': 'Delete view ' + v.name, html: '&times;' });
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          var ask = ui() && ui().confirm ? ui().confirm({ title: 'Delete view “' + v.name + '”?', text: 'Only the saved filter combination is removed; records are untouched.', confirmLabel: 'Delete', danger: true }) : Promise.resolve(true);
          ask.then(function (ok) { if (ok) { s.deleteView(v.id); toast('View deleted.', 'info'); S.viewsSig = ''; renderViews(); } });
        });
        chip.appendChild(x);
      }
      bar.appendChild(chip);
    });
    var saveBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, 'Save current as view…');
    saveBtn.addEventListener('click', function () { openSaveViewForm(saveBtn); });
    bar.appendChild(saveBtn);
  }

  function applySavedView(v) {
    var s = store();
    if (!s) return;
    var vf = v.filters || {};
    if (v.builtin) { applyViewFilters(vf); return; }
    /* Custom views store a full FilterState: apply it wholesale (range preset re-resolves against now()). */
    var patch = Object.assign({}, vf);
    if (patch.range) patch.range = { preset: patch.range.preset, from: patch.range.from, to: patch.range.to };
    s.setFilters(patch);
    S.cursor = null;
  }

  function openSaveViewForm(anchor) {
    var s = store();
    if (!ui() || !ui().popover || !s) return;
    var input = h('input', { class: 'input input--sm', type: 'text', placeholder: 'e.g. Amazon detractors', 'aria-label': 'View name', maxlength: '60' });
    var err = h('div', { class: 'field__error', hidden: true });
    var f = filters();
    var summary = [];
    ['product', 'category', 'channel', 'segment', 'urgency', 'status', 'sentiment', 'flags'].forEach(function (k) { if (f[k] && f[k].length) summary.push(k + ': ' + f[k].length); });
    if (f.search) summary.push('search');
    if (f.restrictedQueue) summary.push('restricted queue');
    var form = h('form', { class: 'stack stack--tight inbox-saveview' }, [
      h('div', { class: 'popover__title', text: 'Save current filters as a view' }),
      h('p', { class: 'muted t-12', text: 'Range ' + ((f.range && f.range.preset) || '30d') + (summary.length ? ' · ' + summary.join(' · ') : ' · no other filters') }),
      h('div', { class: 'field' }, [h('span', { class: 'label', text: 'Name' }), input, err]),
      h('div', { class: 'popover__actions' }, [
        h('button', { class: 'btn btn--ghost btn--xs', type: 'button', onclick: function () { ui().closePopover(); anchor.focus(); } }, 'Cancel'),
        h('button', { class: 'btn btn--primary btn--xs', type: 'submit' }, 'Save view')
      ])
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = input.value.trim();
      if (!name) { err.textContent = 'Give the view a name.'; err.hidden = false; input.focus(); return; }
      var v = s.saveView({ name: name, filters: s.filters() });
      ui().closePopover();
      toast('Saved view “' + (v ? v.name : name) + '”.', 'good');
      S.viewsSig = '';
      renderViews();
      anchor.focus();
    });
    ui().popover(anchor, form);
    setTimeout(function () { input.focus(); }, 0);
  }

  /* ------------------------------------------------------------------ table */

  function dot(kind, title) { return '<span class="dot dot--' + esc(kind) + '" title="' + esc(title || kind) + '" aria-hidden="true"></span>'; }
  function confidenceBucket(c) { return !isNum(c) ? 'low' : c >= 0.7 ? 'high' : c >= 0.5 ? 'medium' : 'low'; }

  /**
   * Table columns. Escalation and classifier confidence sit behind the "More columns" switch (default off) so the
   * default table — through Status and Assignee — fits its card at 1440px without a horizontal scroll.
   * @param {boolean} [more]  include the optional columns
   */
  function columns(more) {
    var cols = [
      { key: 'urgency', label: 'Urgency', width: 64, sortValue: function (r) { return URGENCY_RANK[r.urgency]; }, render: function (r) { return pill('urgency', r.urgency); } },
      { key: 'age_hours', label: 'Age', width: 52, align: 'right', defaultDir: 'desc', className: 'inbox-col-age', sortValue: function (r) { return r.age_hours; },
        render: function (r) {
          var late = r.is_open && r.sla_frt_breached;
          return '<span class="inbox-age' + (late ? ' inbox-age--late' : '') + '" title="' + esc(late ? 'Past the ' + r.sla_frt_hours + 'h first-response SLA' : 'Received ' + fmtDate(r.received_at)) + '">' + esc(fmtHours(r.age_hours)) + '</span>';
        } },
      { key: 'badges', label: '', width: 44, sort: false, className: 'inbox-badges', render: function (r) {
        var out = [];
        if (r.serious_ae) out.push('<span class="badge-mini badge-mini--critical" title="Serious adverse event">AE!</span>');
        else if (r.is_adverse_event) out.push('<span class="badge-mini badge-mini--serious" title="Adverse event (non-serious)">AE</span>');
        if (r.food_safety) out.push('<span class="badge-mini badge-mini--critical" title="Food safety">FS</span>');
        if (r.restricted) out.push('<span class="badge-mini badge-mini--muted" title="Restricted (PHI-adjacent)">R</span>');
        return out.join('') || '<span class="muted">·</span>';
      } },
      { key: 'subject', label: 'Subject', className: 'inbox-subject', sortValue: function (r) { return isRedacted(r) ? '' : r.subject; }, render: function (r) {
        // Redaction applies to the list too: a restricted subject can name a medication or condition (SPEC §8).
        var red = isRedacted(r);
        var text = red ? '[restricted]' : (r.subject || '(no subject)');
        return '<span class="truncate inbox-subject__text' + (red ? ' muted' : '') + '" title="' + esc(red ? 'Restricted record — open the restricted queue to read it' : text) + '">' + esc(text) + '</span>' +
          (r.has_attachment ? '<span class="muted" title="Has attachment"> ⌁</span>' : '');
      } },
      { key: 'product', label: 'Product', className: 'inbox-col-product', sortValue: function (r) { return label('product', r.product); }, render: function (r) {
        var t = label('product', r.product);
        return '<span class="truncate inbox-cell__text" title="' + esc(t) + '">' + esc(t) + '</span>';
      } },
      { key: 'category', label: 'Category › Subcategory', className: 'inbox-col-category', sortValue: function (r) { return label('category', r.category) + label('subcategory', r.subcategory); }, render: function (r) {
        var cat = label('category', r.category), sub = label('subcategory', r.subcategory);
        return '<span class="truncate inbox-cell__text" title="' + esc(cat + ' › ' + sub) + '">' + esc(cat) + ' <span class="muted">›</span> ' + esc(sub) + '</span>';
      } },
      { key: 'sentiment', label: 'Sentiment', width: 96, sortValue: function (r) { return isNum(r.sentiment) ? r.sentiment : -9; }, render: function (r) {
        var lbl = r.sentiment_label || 'unscored';
        var score = isNum(r.sentiment) && lbl !== 'unscored' ? fmtNum(r.sentiment, 2) : null;
        return '<span title="' + esc(label('sentiment', lbl) + (score ? ' · compound ' + score : '')) + '">' + dot(lbl, lbl) + ' ' + esc(label('sentiment', lbl)) + '</span>';
      } },
      { key: 'score', label: 'Score', width: 70, align: 'right', sortValue: function (r) { return isNum(r.nps) ? r.nps : (isNum(r.rating) ? r.rating * 2 : null); }, render: function (r) {
        if (isNum(r.nps)) return '<span title="NPS score (0–10)">NPS ' + r.nps + '</span>';
        if (isNum(r.rating)) return '<span title="Review rating (1–5 stars)">★ ' + r.rating + '</span>';
        return '<span class="muted">—</span>';
      } },
      { key: 'status', label: 'Status', width: 88, sortValue: function (r) { return r.status; }, render: function (r) { return pill('status', r.status); } },
      { key: 'assignee', label: 'Assignee', width: 96, className: 'inbox-col-assignee', sortValue: function (r) { return r.assignee || ''; }, render: function (r) {
        return r.assignee ? '<span class="truncate inbox-cell__text" title="' + esc(r.assignee) + '">' + esc(r.assignee) + '</span>' : '<span class="muted">Unassigned</span>';
      } }
    ];
    if (more) {
      cols.push(
        { key: 'escalation_score', label: 'Escalation', width: 80, align: 'right', defaultDir: 'desc', sortValue: function (r) { return isNum(r.escalation_score) ? r.escalation_score : -1; }, render: function (r) {
          var v = r.escalation_score;
          if (!isNum(v)) return '<span class="muted" title="Escalation risk applies to open records">—</span>';
          var tier = v >= 75 ? 'critical' : v >= 50 ? 'high' : v >= 25 ? 'watch' : 'low';
          return '<span class="inbox-score inbox-score--' + tier + '" title="Escalation risk ' + v + ' of 100 (' + tier + ')">' + v + '</span>';
        } },
        { key: 'confidence', label: 'Conf.', width: 50, align: 'center', sortValue: function (r) { return r.classifier ? r.classifier.confidence : 0; }, render: function (r) {
          var c = r.classifier || {};
          var b = confidenceBucket(c.confidence);
          var t = 'Classifier confidence ' + (isNum(c.confidence) ? Math.round(c.confidence * 100) + '%' : '—') + (c.needs_review ? ' · needs review' : '') + (c.manual_override ? ' · manually set' : '');
          return '<span class="conf-dot conf-dot--' + b + (c.needs_review ? ' conf-dot--review' : '') + '" title="' + esc(t) + '" role="img" aria-label="' + esc(t) + '"></span>';
        } }
      );
    }
    return cols;
  }

  function rowClass(r) {
    var cls = [];
    if (r.urgency === 'P0') cls.push('is-critical');
    if (!r.is_open) cls.push('is-muted');
    return cls.join(' ');
  }

  function buildTable() {
    var host = S.els.table;
    if (!host || !ui() || !ui().table) return;
    host.innerHTML = '';
    host.classList.toggle('inbox-table--more', !!S.moreColumns);
    S.table = ui().table({
      columns: columns(S.moreColumns), rows: S.rows, pageSize: PAGE_SIZE, selectable: true, rowClass: rowClass,
      rowKey: function (r) { return r.id; },
      emptyText: 'No records match these filters. Widen the range, clear a chip, or pick another view.',
      onRowClick: function (r) { S.cursor = r.id; openRecord(r.id); },
      onSelectionChange: function (ids) { S.selected = ids; renderBulk(); }
    });
    host.appendChild(S.table.el);
    if (S.openId) S.table.setActive(S.openId);
    else if (S.cursor) S.table.setActive(S.cursor);
  }

  /** Toggle the optional Escalation / Confidence columns and rebuild the table (selection is cleared). */
  function setMoreColumns(on) {
    on = !!on;
    if (on === S.moreColumns) return;
    S.moreColumns = on;
    writeMoreColumns(on);
    S.selected = [];
    buildTable();
    renderBulk();
  }

  /* ------------------------------------------------------------------ bulk bar */

  function selectedRecords() {
    var set = {};
    S.selected.forEach(function (id) { set[id] = true; });
    return S.rows.filter(function (r) { return set[r.id]; });
  }

  function undoBatches(batchIds) {
    var s = store();
    var ok = 0;
    (batchIds || []).forEach(function (b) { if (b && s.undo(b)) ok += 1; });
    toast(ok ? 'Undone.' : 'Nothing to undo.', ok ? 'info' : 'warning');
  }

  function bulkPatch(ids, patch, message) {
    var s = store();
    if (!s || !ids.length) return;
    var batch = s.bulkUpdate(ids, patch, me());
    toast(message, 'good', { undo: function () { undoBatches([batch]); } });
    if (S.table) S.table.clearSelection();
  }

  function bulkAddTag(ids, tag) {
    var s = store();
    if (!s || !ids.length || !tag) return;
    var groups = {};
    S.rows.forEach(function (r) {
      if (ids.indexOf(r.id) < 0) return;
      var tags = Array.isArray(r.tags) ? r.tags : [];
      if (tags.indexOf(tag) >= 0) return;
      var key = JSON.stringify(tags);
      (groups[key] = groups[key] || { tags: tags, ids: [] }).ids.push(r.id);
    });
    var batches = [];
    var n = 0;
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      batches.push(s.bulkUpdate(g.ids, { tags: g.tags.concat([tag]) }, me()));
      n += g.ids.length;
    });
    if (!n) { toast('Every selected record already carries “' + tag + '”.', 'info'); return; }
    toast('Added tag “' + tag + '” to ' + fmtInt(n) + (n === 1 ? ' record.' : ' records.'), 'good', { undo: function () { undoBatches(batches); } });
    if (S.table) S.table.clearSelection();
  }

  function exportRecords(recs, view) {
    var ex = VOC.exporter;
    if (!ex || typeof ex.recordsCsv !== 'function') { toast('Exporter module is not loaded.', 'warning'); return; }
    var st = settings();
    var csv = ex.recordsCsv(recs, { redact: st.redactRestricted !== false, now: store().now() });
    var name = typeof ex.filename === 'function' ? ex.filename(view || 'inbox') : 'lnutra-voc-inbox.csv';
    if (typeof ex.downloadText === 'function') ex.downloadText(name, csv, 'text/csv;charset=utf-8');
    else if (ui() && ui().downloadText) ui().downloadText(name, csv, 'text/csv;charset=utf-8');
    toast('Exported ' + fmtInt(recs.length) + (recs.length === 1 ? ' record' : ' records') + (st.redactRestricted !== false ? ' (restricted rows redacted).' : '.'), 'info');
  }

  function statusOptions() {
    var e = E();
    var list = e && e.list ? e.list('status') : [];
    return list.filter(function (o) { return o.id !== 'closed_noise'; });
  }

  function renderBulk() {
    var bar = S.els.bulk;
    if (!bar) return;
    bar.innerHTML = '';
    var n = S.selected.length;
    if (!n) { bar.hidden = true; return; }
    bar.hidden = false;
    var ids = S.selected.slice();
    bar.appendChild(h('span', { class: 'inbox-bulk__count strong', text: fmtInt(n) + ' selected' }));

    var assign = h('select', { class: 'select', 'aria-label': 'Assign selected records to', 'data-bulk': 'assign' });
    assign.appendChild(h('option', { value: '', text: 'Assign to…' }));
    assign.appendChild(h('option', { value: '__unassign', text: 'Unassigned' }));
    var myName = me();
    var names = agents().slice();
    if (names.indexOf(myName) < 0) names.unshift(myName);
    names.forEach(function (a) { assign.appendChild(h('option', { value: a, text: a })); });
    assign.addEventListener('change', function () {
      if (!assign.value) return;
      var who = assign.value === '__unassign' ? null : assign.value;
      bulkPatch(ids, { assignee: who }, (who ? 'Assigned ' : 'Unassigned ') + fmtInt(n) + (n === 1 ? ' record' : ' records') + (who ? ' to ' + who + '.' : '.'));
    });
    bar.appendChild(assign);

    var status = h('select', { class: 'select', 'aria-label': 'Set status of selected records', 'data-bulk': 'status' });
    status.appendChild(h('option', { value: '', text: 'Status…' }));
    statusOptions().forEach(function (o) { status.appendChild(h('option', { value: o.id, text: o.label })); });
    status.addEventListener('change', function () {
      if (!status.value) return;
      bulkPatch(ids, { status: status.value }, 'Set ' + fmtInt(n) + (n === 1 ? ' record' : ' records') + ' to ' + label('status', status.value) + '.');
    });
    bar.appendChild(status);

    var tagInput = h('input', { class: 'input input--sm inbox-bulk__tag', type: 'text', placeholder: 'Add tag…', 'aria-label': 'Tag to add to selected records', maxlength: '40', list: 'inbox-tag-suggestions' });
    var known = {};
    S.rows.forEach(function (r) { (r.tags || []).forEach(function (t) { if (t.indexOf('ae:') !== 0 && t.indexOf('rfr:') !== 0) known[t] = true; }); });
    var dl = h('datalist', { id: 'inbox-tag-suggestions' });
    Object.keys(known).sort().slice(0, 30).forEach(function (t) { dl.appendChild(h('option', { value: t })); });
    var tagBtn = h('button', { class: 'btn btn--sm', type: 'button', onclick: function () { var t = tagInput.value.trim(); if (t) { bulkAddTag(ids, t); tagInput.value = ''; } } }, 'Add tag');
    tagInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tagBtn.click(); } });
    bar.appendChild(h('span', { class: 'row inbox-bulk__taggroup' }, [tagInput, dl, tagBtn]));

    bar.appendChild(h('button', { class: 'btn btn--sm', type: 'button', onclick: function () { exportRecords(selectedRecords(), 'inbox-selection'); } }, 'Export CSV'));
    bar.appendChild(h('span', { class: 'flex-1' }));
    bar.appendChild(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: function () { if (S.table) S.table.clearSelection(); } }, 'Clear'));
  }

  /* ------------------------------------------------------------------ import drop zone */

  function mountDropZone() {
    var el = S.els.drop;
    if (!el || !ui() || !ui().dropZone) return;
    ui().dropZone(el, onFiles, { hint: 'Drop .eml, .mbox, .csv or .json exports here (or click to choose). Files are parsed in this browser; nothing is uploaded.' });
  }

  function onFiles(files) {
    var imp = VOC.importers, s = store();
    if (!imp || typeof imp.handleFiles !== 'function') { toast('Importer module is not loaded.', 'warning'); return; }
    if (!s) return;
    var zone = S.els.drop;
    if (zone) zone.classList.add('is-loading');
    var st = settings();
    imp.handleFiles(files, { agentAddresses: st.connector && st.connector.agent_addresses }).then(function (res) {
      var counts = res.summary && res.summary.byType ? res.summary.byType : {};
      var kind = ['mbox', 'eml', 'csv', 'json'].reduce(function (best, k) { return (counts[k] || 0) > (counts[best] || 0) ? k : best; }, 'json');
      var after = function (sum) {
        var parts = [];
        if (sum) {
          parts.push(fmtInt(sum.added) + ' added');
          if (sum.duplicates) parts.push(fmtInt(sum.duplicates) + ' duplicate' + (sum.duplicates === 1 ? '' : 's'));
          if (sum.noise) parts.push(fmtInt(sum.noise) + ' noise');
          if (sum.needsReview) parts.push(fmtInt(sum.needsReview) + ' need review');
          if (sum.nonEnglish) parts.push(fmtInt(sum.nonEnglish) + ' non-English');
          if (sum.responses) parts.push(fmtInt(sum.responses) + ' first responses matched');
        }
        if (res.ordersByMonth && typeof s.setOrders === 'function') {
          s.setOrders(Object.assign({}, s.orders(), res.ordersByMonth, { _total: Object.assign({}, (s.orders() || {})._total, res.ordersByMonth._total) }));
          parts.push(fmtInt(res.summary.orderMonths || 0) + ' order months');
        }
        var pending = (res.summary && res.summary.pending) || [];
        var errors = (res.summary && res.summary.errors) || [];
        toast('Import: ' + (parts.length ? parts.join(' · ') : 'nothing new') + '.', sum && sum.added ? 'good' : 'info', { ms: 9000 });
        if (pending.length) toast(pending.length + ' CSV file' + (pending.length === 1 ? '' : 's') + ' need a column mapping — finish the import in Settings › Import.', 'warning', { ms: 12000 });
        if (errors.length) toast(errors.length + ' file' + (errors.length === 1 ? '' : 's') + ' failed: ' + errors.map(function (e) { return e.file + ' (' + e.message + ')'; }).join('; '), 'critical', { ms: 12000 });
      };
      if (res.items && res.items.length) return s.addRecords(res.items, kind).then(after);
      return after(null);
    }).catch(function (err) {
      toast('Import failed: ' + (err && err.message ? err.message : String(err)), 'critical');
    }).then(function () { if (zone) zone.classList.remove('is-loading'); });
  }

  /* ------------------------------------------------------------------ text marking */

  var SAFETY_RE = /\b(faint(?:ed|ing)?|passed out|hospital(?:ized|isation|ization)?|\bER\b|emergency room|ambulance|anaphyla\w*|epipen|allergic reaction|chest pain|seizure|couldn'?t breathe|blood sugar (?:crashed|dropped)|hypoglyc\w*|headache|dizz\w*|lighthead\w*|nause\w*|vomit\w*|fatigue|brain fog|rash|hives|palpitation\w*|diarrhea|constipat\w*|shell|hard bits?|foreign|glass|plastic|metal|moldy?|spoiled|seal (?:was )?broken|smell(?:ed|s) off|undeclared|pregnan\w*|nursing|breastfeeding|metformin|insulin|under 18|teenager)\b/gi;
  var ENTITY_RE = /(#\s?\d{5,7}\b|\b\d{3}-\d{7}-\d{7}\b|\bPP-\d{4,6}\b|\b(?:lot|batch)\s*(?:#|no\.?|number)?\s*[:#]?\s*[A-Z]{1,3}-?\d{3,5}-?[A-Z0-9]{0,3}\b)/gi;

  function lexiconRanges(text) {
    var out = [];
    var cls = VOC.classify;
    var lex = VOC.lexicon;
    var lower = text.toLowerCase();
    var terms = {};
    if (cls && typeof cls.scoreSentiment === 'function') {
      try {
        var res = cls.scoreSentiment(text);
        ((res && res.hits) || []).forEach(function (hit) { if (hit && hit.term) terms[String(hit.term).toLowerCase()] = hit.valence; });
      } catch (e) { /* fall back to the lexicon */ }
    }
    if (!Object.keys(terms).length && lex && typeof lex.valence === 'function') {
      var phrases = Object.keys(lex.DOMAIN || {}).filter(function (k) { return k.indexOf(' ') > 0; });
      phrases.forEach(function (p) { if (lower.indexOf(p) >= 0) terms[p] = lex.valence(p); });
      var toks = lower.match(/[a-z][a-z']+/g) || [];
      toks.forEach(function (t) { var v = lex.valence(t); if (v !== undefined && Math.abs(v) >= 1) terms[t] = v; });
    }
    Object.keys(terms).forEach(function (term) {
      var v = terms[term];
      if (!isNum(v)) return;
      var re = new RegExp('(^|[^a-z0-9])(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![a-z0-9])', 'gi');
      var m;
      while ((m = re.exec(text)) !== null) {
        var start = m.index + m[1].length;
        out.push({ start: start, end: start + m[2].length, cls: v < 0 ? 'mark--neg' : 'mark--pos', title: 'Lexicon ' + (v > 0 ? '+' : '') + v });
        if (m[0].length === 0) re.lastIndex += 1;
      }
    });
    return out;
  }

  function regexRanges(text, re, cls, title) {
    var out = [], m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      out.push({ start: m.index, end: m.index + m[0].length, cls: cls, title: title });
    }
    return out;
  }

  /** Escaped HTML with <mark> around lexicon hits, safety keywords and entities (non-overlapping, earliest wins). */
  function markedHtml(text) {
    text = String(text || '');
    if (!text) return '<span class="muted">(no body text)</span>';
    var ranges = [];
    var rules = VOC.rules;
    if (rules && rules.safety) {
      [].concat(rules.safety.serious || [], rules.safety.nonSerious || [], rules.safety.food || []).forEach(function (re) {
        if (re instanceof RegExp) ranges = ranges.concat(regexRanges(text, new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g'), 'mark--safety', 'Safety keyword'));
      });
    } else {
      ranges = ranges.concat(regexRanges(text, SAFETY_RE, 'mark--safety', 'Safety keyword'));
    }
    ranges = ranges.concat(regexRanges(text, ENTITY_RE, 'mark--entity', 'Order / lot reference'));
    ranges = ranges.concat(lexiconRanges(text));
    ranges.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start); });
    var html = '', pos = 0;
    ranges.forEach(function (r) {
      if (r.start < pos) return;
      html += esc(text.slice(pos, r.start));
      html += '<mark class="' + r.cls + '" title="' + esc(r.title) + '">' + esc(text.slice(r.start, r.end)) + '</mark>';
      pos = r.end;
    });
    html += esc(text.slice(pos));
    return html;
  }

  /* ------------------------------------------------------------------ drawer */

  function isRedacted(rec) {
    var st = settings();
    return !!(rec && rec.restricted && st.redactRestricted !== false && !filters().restrictedQueue);
  }

  function kv(pairs) {
    var dl = h('dl', { class: 'kv' });
    pairs.forEach(function (p) {
      if (!p) return;
      dl.appendChild(h('dt', { text: p[0] }));
      var dd = h('dd');
      if (typeof p[1] === 'string' || typeof p[1] === 'number') dd.textContent = String(p[1]); else if (p[1]) dd.appendChild(p[1]);
      else dd.textContent = '—';
      dl.appendChild(dd);
    });
    return dl;
  }

  function section(title, children, opts) {
    opts = opts || {};
    var sec = h('section', { class: 'drawer-section' + (opts.className ? ' ' + opts.className : ''), 'data-section': opts.id || null });
    var head = h('div', { class: 'drawer-section__head' }, h('h3', { class: 'drawer-section__title', text: title }));
    if (opts.aside) head.appendChild(typeof opts.aside === 'string' ? h('span', { class: 'muted t-12', text: opts.aside }) : opts.aside);
    sec.appendChild(head);
    (Array.isArray(children) ? children : [children]).forEach(function (c) { if (c) sec.appendChild(c); });
    return sec;
  }

  function select(opts) {
    var sel = h('select', { class: 'select', 'aria-label': opts.aria, 'data-field': opts.field });
    (opts.options || []).forEach(function (o) {
      var op = h('option', { value: o.id, text: o.label });
      if (o.id === opts.value) op.selected = true;
      sel.appendChild(op);
    });
    if (opts.value != null && !(opts.options || []).some(function (o) { return o.id === opts.value; })) {
      var extra = h('option', { value: opts.value, text: label(opts.kind || opts.field, opts.value) }); extra.selected = true; sel.appendChild(extra);
    }
    sel.addEventListener('change', function () { opts.onChange(sel.value); });
    return h('label', { class: 'field' }, [h('span', { class: 'label', text: opts.label }), sel]);
  }

  function updateRecord(id, patch) {
    var s = store();
    if (!s) return;
    S.drawerScroll = ui() && ui().drawer && ui().drawer.body() ? ui().drawer.body().scrollTop : 0;
    var before = s.record(id);
    var rec = s.update(id, patch, me());
    var field = Object.keys(patch)[0];
    if (before && rec && field && JSON.stringify(before[field]) !== JSON.stringify(rec[field])) {
      var batch = s.lastBatchId ? s.lastBatchId() : null;
      toast('Updated ' + field.replace(/_/g, ' ') + '.', 'good', { undo: batch ? function () { undoBatches([batch]); } : undefined, ms: 5000 });
    }
  }

  function editPanel(rec) {
    var e = E();
    var cats = e && e.list ? e.list('category') : [];
    var subs = e && e.subcategories ? e.subcategories(rec.category) : [];
    var products = e && e.list ? e.list('product') : [];
    var urg = e && e.list ? e.list('urgency') : [];
    var names = agents().slice();
    if (names.indexOf(me()) < 0) names.unshift(me());
    if (rec.assignee && names.indexOf(rec.assignee) < 0) names.push(rec.assignee);
    var assigneeOpts = [{ id: '', label: 'Unassigned' }].concat(names.map(function (a) { return { id: a, label: a }; }));

    var grid = h('div', { class: 'form-grid' }, [
      select({ field: 'category', label: 'Category', aria: 'Category', options: cats, value: rec.category, onChange: function (v) {
        var first = e && e.subcategories ? (e.subcategories(v)[0] || {}).id : null;
        updateRecord(rec.id, { category: v, subcategory: first || rec.subcategory });
      } }),
      select({ field: 'subcategory', label: 'Subcategory', aria: 'Subcategory', options: subs, value: rec.subcategory, onChange: function (v) { updateRecord(rec.id, { subcategory: v }); } }),
      select({ field: 'product', label: 'Product', aria: 'Product', options: products, value: rec.product, onChange: function (v) { updateRecord(rec.id, { product: v }); } }),
      select({ field: 'urgency', label: 'Urgency', aria: 'Urgency', options: urg, value: rec.urgency, onChange: function (v) { updateRecord(rec.id, { urgency: v }); } }),
      select({ field: 'status', label: 'Status', aria: 'Status', options: statusOptions(), value: rec.status, onChange: function (v) { updateRecord(rec.id, { status: v }); } }),
      select({ field: 'assignee', label: 'Assignee', aria: 'Assignee', options: assigneeOpts, value: rec.assignee || '', onChange: function (v) { updateRecord(rec.id, { assignee: v || null }); } })
    ]);

    var tags = (rec.tags || []).filter(function (t) { return t.indexOf('ae:') !== 0 && t.indexOf('rfr:') !== 0; });
    var tagWrap = h('div', { class: 'row inbox-tags' });
    tags.forEach(function (t) {
      var x = h('button', { class: 'chip__x', type: 'button', 'aria-label': 'Remove tag ' + t, html: '&times;', onclick: function () {
        updateRecord(rec.id, { tags: (rec.tags || []).filter(function (k) { return k !== t; }) });
      } });
      tagWrap.appendChild(h('span', { class: 'tag' }, [h('span', { text: t }), x]));
    });
    var tagInput = h('input', { class: 'input input--sm inbox-tags__input', type: 'text', placeholder: tags.length ? 'Add tag…' : 'Add a tag and press Enter', 'aria-label': 'Add tag', 'data-field': 'tags', maxlength: '40' });
    tagInput.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var t = tagInput.value.trim();
      if (!t) return;
      if ((rec.tags || []).indexOf(t) >= 0) { tagInput.value = ''; return; }
      updateRecord(rec.id, { tags: (rec.tags || []).concat([t]) });
    });
    tagWrap.appendChild(tagInput);

    var c = rec.classifier || {};
    var aside = h('span', { class: 'muted t-12' }, [
      pill('confidence', c.confidence),
      c.manual_override ? h('span', { class: 'tag', text: 'manual', title: 'Category, subcategory or product set by hand' }) : null,
      c.needs_review ? h('span', { class: 'tag', text: 'needs review', title: 'Rule category ' + label('category', c.rule_category) + ' disagrees or confidence is low' }) : null
    ]);
    return section('Classification & handling', [grid, h('div', { class: 'field' }, [h('span', { class: 'label', text: 'Tags' }), tagWrap])], { id: 'edit', aside: aside });
  }

  function notesPanel(rec) {
    var list = h('div', { class: 'stack stack--tight inbox-notes' });
    var notes = (rec.notes || []).slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    if (!notes.length) list.appendChild(h('p', { class: 'muted t-13', text: 'No notes yet.' }));
    notes.forEach(function (n) {
      list.appendChild(h('div', { class: 'inbox-note' }, [
        h('div', { class: 'inbox-note__meta muted t-12', text: (n.by || 'Someone') + ' · ' + fmtDate(n.at) }),
        h('div', { class: 'inbox-note__text', text: n.text })
      ]));
    });
    var ta = h('textarea', { class: 'textarea inbox-note__input', rows: '2', placeholder: 'Add a note (⌘/Ctrl+Enter to save)', 'aria-label': 'New note', 'data-field': 'note' });
    var btn = h('button', { class: 'btn btn--sm', type: 'button' }, 'Add note');
    function save() {
      var t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      S.drawerScroll = ui().drawer.body().scrollTop;
      store().addNote(rec.id, t, me());
      toast('Note added.', 'good', { ms: 3000 });
    }
    btn.addEventListener('click', save);
    ta.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); save(); } });
    return section('Notes', [list, h('div', { class: 'row inbox-note__form' }, [ta, btn])], { id: 'notes', aside: notes.length ? fmtInt(notes.length) + (notes.length === 1 ? ' note' : ' notes') : null });
  }

  function threadPanel(rec) {
    var s = store();
    var all = s ? s.all() : [];
    var thread = all.filter(function (r) { return r.thread_id === rec.thread_id && r.id !== rec.id; }).sort(function (a, b) { return a.received_at < b.received_at ? -1 : 1; });
    if (!thread.length) return null;
    var list = h('ol', { class: 'inbox-thread' });
    thread.forEach(function (r) {
      list.appendChild(h('li', { class: 'inbox-thread__item' }, [
        h('span', { class: 'muted t-12 nowrap', text: fmtDate(r.received_at) }),
        pill('status', r.status),
        h('button', { class: 'btn btn--link t-13 inbox-thread__link', type: 'button', text: isRedacted(r) ? 'Restricted record' : (r.subject || '(no subject)'), onclick: function () { openRecord(r.id); } })
      ]));
    });
    return section('Thread history', list, { id: 'thread', aside: fmtInt(thread.length + 1) + ' messages' });
  }

  function customerPanel(rec) {
    var s = store();
    var cust = s && s.customer ? s.customer(rec.customer_id) : null;
    var red = isRedacted(rec);
    var pr = VOC.predict;
    var churn = null;
    if (pr && typeof pr.churnRisk === 'function' && s) {
      // opts.model: the store's shared churn bundle, so this score matches the Customers table and the Overview KPI.
      var model = typeof s.churnModel === 'function' ? s.churnModel() : null;
      try { churn = pr.churnRisk(rec.customer_id, s.all(), s.customers(), { now: s.now(), model: model || undefined }); } catch (e) { churn = null; }
    }
    var history = s && s.recordsFor ? s.recordsFor(rec.customer_id).filter(function (r) { return r.id !== rec.id; }).slice(0, 8) : [];
    var pairs = [
      ['Customer', red ? 'Redacted' : (cust && cust.display_name) || rec.from_name || '—'],
      ['Segment', label('segment', (cust && cust.segment) || rec.segment)],
      ['Region', label('region', (cust && cust.region) || rec.region)],
      ['Sales channel', label('sales_channel', (cust && cust.sales_channel) || rec.sales_channel)],
      cust ? ['Orders (12m)', fmtInt(cust.orders_12m)] : null,
      cust ? ['Lifetime value', fmtUsd(cust.ltv_usd)] : null,
      cust ? ['Subscription', cust.subscription_status === 'none' ? 'None' : (cust.subscription_status.charAt(0).toUpperCase() + cust.subscription_status.slice(1)) + (cust.subscription_cadence_months ? ' · every ' + cust.subscription_cadence_months + ' mo' : '') + (isNum(cust.subscription_value_12m_usd) ? ' · ' + fmtUsd(cust.subscription_value_12m_usd) + '/yr' : '')] : null,
      cust && cust.hcp_code ? ['HCP code', cust.hcp_code] : null,
      ['Records', fmtInt(history.length + 1)]
    ];
    var churnEl = null;
    if (churn && isNum(churn.score)) {
      var reasons = h('div', { class: 'row inbox-reasons' });
      (churn.reasons || []).forEach(function (r) { reasons.appendChild(h('span', { class: 'tag', text: r })); });
      churnEl = h('div', { class: 'inbox-risk' }, [
        h('div', { class: 'row' }, [h('span', { class: 'inbox-risk__score', text: String(churn.score) }), h('span', { class: 'muted t-12', text: '/ 100' }), pill('tier', churn.tier), h('span', { class: 'muted t-12', text: (churn.method === 'fitted' ? 'fitted model' : 'rule-based score') + ' · n = ' + fmtInt(churn.n) + (churn.n === 1 ? ' record' : ' records') })]),
        (churn.reasons || []).length ? reasons : h('p', { class: 'muted t-12', text: 'No active risk signals.' }),
        (churn.caveats || []).length ? h('p', { class: 'muted t-12', text: churn.caveats.join(' ') }) : null
      ]);
    } else {
      churnEl = h('p', { class: 'muted t-13', text: 'Cancellation risk needs the predict module.' });
    }
    var hist = h('ul', { class: 'inbox-history' });
    history.forEach(function (r) {
      hist.appendChild(h('li', {}, [
        h('span', { class: 'muted t-12 nowrap', text: fmtDate(r.received_at, 'day') }),
        h('span', { class: 'dot dot--' + esc(r.sentiment_label || 'unscored'), title: label('sentiment', r.sentiment_label), 'aria-hidden': 'true' }),
        h('button', { class: 'btn btn--link t-13 truncate', type: 'button', text: isRedacted(r) ? 'Restricted record' : (r.subject || '(no subject)'), onclick: function () { openRecord(r.id); } })
      ]));
    });
    return section('Customer', [
      kv(pairs),
      h('div', { class: 'label mt-2', text: 'Cancellation risk' }), churnEl,
      history.length ? h('div', { class: 'label mt-2', text: 'History' }) : null,
      history.length ? hist : null
    ], { id: 'customer' });
  }

  function csatFor(rec) {
    var s = store(), pr = VOC.predict;
    if (!s || !pr || typeof pr.predictCsat !== 'function') return null;
    var v = s.version ? s.version() : 0;
    if (!S.csatCache || S.csatCache.version !== v) {
      var res = null;
      try { res = pr.predictCsat(s.all(), { now: s.now() }); } catch (e) { res = null; }
      var map = {};
      ((res && res.predictions) || []).forEach(function (p) { if (p && p.id) map[p.id] = p; });
      S.csatCache = { version: v, map: map, method: res && res.method, model: res && res.model };
    }
    var p = S.csatCache.map[rec.id];
    if (!p && isNum(rec.pred_csat)) p = { pred: rec.pred_csat };
    return p ? Object.assign({ method: S.csatCache.method, n: S.csatCache.model ? S.csatCache.model.n : null }, p) : null;
  }

  function predictionsPanel(rec) {
    var s = store(), pr = VOC.predict;
    if (!s || !pr) return section('Predictions', h('p', { class: 'muted t-13', text: 'Predictions need the predict module.' }), { id: 'predict' });
    var all = s.all();
    var esc_ = null, sla = null;
    try { esc_ = typeof pr.escalationRisk === 'function' ? pr.escalationRisk(rec, all, { now: s.now() }) : null; } catch (e) { esc_ = null; }
    try { sla = typeof pr.slaBreachProb === 'function' ? pr.slaBreachProb(rec, all, { slaHours: rec.sla_frt_hours, now: s.now() }) : null; } catch (e) { sla = null; }
    var csat = rec.is_open ? csatFor(rec) : null;
    var items = [];
    if (esc_ && isNum(esc_.score)) {
      var reasons = h('div', { class: 'row inbox-reasons' });
      (esc_.reasons || []).forEach(function (r) { reasons.appendChild(h('span', { class: 'tag', text: r })); });
      items.push(h('div', { class: 'inbox-pred' }, [
        h('div', { class: 'label', text: 'Escalation risk' }),
        h('div', { class: 'row' }, [h('span', { class: 'inbox-risk__score', text: String(esc_.score) }), h('span', { class: 'muted t-12', text: '/ 100' }), pill('tier', esc_.tier), h('span', { class: 'muted t-12', text: 'risk score · n = ' + fmtInt(esc_.n) })]),
        (esc_.reasons || []).length ? reasons : null,
        !rec.is_open ? h('p', { class: 'muted t-12', text: 'Closed record: age and response features count as zero.' }) : null
      ]));
    }
    if (sla) {
      var pText = isNum(sla.p) ? Math.round(sla.p * 100) + '%' : '—';
      items.push(h('div', { class: 'inbox-pred' }, [
        h('div', { class: 'label', text: 'First-response SLA breach' }),
        h('div', { class: 'row' }, [h('span', { class: 'inbox-risk__score' + (isNum(sla.p) && sla.p >= 0.5 ? ' inbox-risk__score--bad' : ''), text: pText }), h('span', { class: 'muted t-12', text: 'SLA ' + rec.sla_frt_hours + 'h · based on ' + (sla.basis === 'category' ? 'this category’s' : 'all') + ' response times · n = ' + fmtInt(sla.n) })]),
        h('p', { class: 'muted t-12', text: sla.explanation || '' })
      ]));
    }
    if (rec.is_open) {
      var csatEl;
      if (csat && isNum(csat.pred)) {
        var range = isNum(csat.lo) && isNum(csat.hi) ? ' (likely ' + fmtNum(csat.lo, 1) + '–' + fmtNum(csat.hi, 1) + ')' : '';
        csatEl = h('div', { class: 'row' }, [h('span', { class: 'inbox-risk__score', text: 'about ' + fmtNum(csat.pred, 1) }), h('span', { class: 'muted t-12', text: 'of 5' + range + ' · ' + (csat.method === 'ridge' ? 'fitted model' : 'category average + sentiment') + (isNum(csat.n) ? ' · n = ' + fmtInt(csat.n) : '') })]);
      } else {
        csatEl = h('p', { class: 'muted t-13', text: 'No CSAT prediction: too few resolved records with a CSAT score.' });
      }
      items.push(h('div', { class: 'inbox-pred' }, [h('div', { class: 'label', text: 'Predicted CSAT' }), csatEl]));
    }
    if (!items.length) items.push(h('p', { class: 'muted t-13', text: 'No predictions available for this record.' }));
    return section('Predictions', items, { id: 'predict', aside: 'ranges, not promises' });
  }

  function regulatoryPanel(rec) {
    if (!(rec.is_adverse_event || rec.serious_ae || rec.food_safety || rec.regulatory_clock !== 'none')) return null;
    var RC = VOC.regulatoryChecklist;
    var prog = RC.progress(rec);
    var kind = prog.kind || (rec.food_safety ? 'rfr' : 'medwatch');
    var e = E();
    var clockLabel = rec.regulatory_clock === 'medwatch_15bd' ? 'MedWatch 3500A · 15 business days' : rec.regulatory_clock === 'rfr_24h' ? 'Reportable Food Registry · 24 hours' : 'No mandatory clock (non-serious)';
    var remaining = null;
    if (rec.regulatory_clock === 'medwatch_15bd' && isNum(rec.business_days_remaining)) {
      remaining = rec.business_days_remaining < 0 ? 'overdue by ' + fmtNum(-rec.business_days_remaining, 1) + ' business days' : fmtNum(rec.business_days_remaining, 1) + ' business days · ' + fmtHours(rec.hours_remaining);
    } else if (rec.regulatory_clock === 'rfr_24h' && isNum(rec.hours_remaining)) {
      remaining = rec.hours_remaining < 0 ? 'overdue by ' + fmtHours(-rec.hours_remaining) : fmtHours(rec.hours_remaining) + ' left';
    }
    var due = isNum(rec.hours_remaining) && rec.hours_remaining < 0;
    var soon = !due && (rec.regulatory_clock === 'medwatch_15bd' ? isNum(rec.business_days_remaining) && rec.business_days_remaining < 2 : isNum(rec.hours_remaining) && rec.hours_remaining < 6);
    var countdown = remaining ? h('div', { class: 'countdown' + (due ? ' countdown--due' : soon ? ' countdown--soon' : ''), text: remaining }) : (rec.is_open ? h('div', { class: 'muted t-13', text: 'Not on a mandatory clock.' }) : h('div', { class: 'muted t-13', text: 'Record closed.' }));

    var pairs = [
      ['Clock', clockLabel],
      ['Received', fmtDate(rec.received_at)],
      ['Aware date', fmtDate(rec.received_at) + ' (first receipt)'],
      rec.regulatory_deadline ? ['Deadline', fmtDate(rec.regulatory_deadline)] : null,
      ['Product', label('product', rec.product) + ' · ' + label('product_class', rec.product_class)],
      ['Lot', rec.lot_number || '— (ask the customer for the lot on the box)'],
      ['Reporter contact', isRedacted(rec) ? 'Redacted' : ((rec.from_name || '—') + (rec.from_email ? ' · ' + rec.from_email : ''))],
      ['Escalated to', label('escalated_to', rec.escalated_to)]
    ];

    function toggleTag(tag, on, extraPatch) {
      var tags = (rec.tags || []).filter(function (t) { return t !== tag; });
      if (on) tags.push(tag);
      updateRecord(rec.id, Object.assign({ tags: tags }, extraPatch || {}));
    }

    var critList = h('div', { class: 'checklist' });
    var criteria = e && e.list ? e.list('ae_criteria') : [];
    criteria.forEach(function (c) {
      var tag = RC.tagPrefix.criteria + c.id;
      var fromRecord = (rec.ae_criteria || []).indexOf(c.id) >= 0;
      var checked = fromRecord || (rec.tags || []).indexOf(tag) >= 0;
      var cb = h('input', { type: 'checkbox', 'data-crit': c.id });
      cb.checked = checked;
      if (fromRecord) { cb.disabled = true; cb.title = 'Set by the classifier from the message text'; }
      cb.addEventListener('change', function () {
        toggleTag(tag, cb.checked, cb.checked && !rec.serious_ae ? { serious_ae: true, is_adverse_event: true } : null);
      });
      critList.appendChild(h('label', {}, [cb, h('span', { text: c.label })]));
    });

    var fields = RC[kind];
    var prefix = RC.tagPrefix[kind];
    var list = h('div', { class: 'checklist' });
    fields.forEach(function (f) {
      var tag = prefix + f.id;
      var cb = h('input', { type: 'checkbox', 'data-check': tag });
      cb.checked = (rec.tags || []).indexOf(tag) >= 0;
      cb.addEventListener('change', function () { toggleTag(tag, cb.checked); });
      list.appendChild(h('label', {}, [cb, h('span', { text: f.label })]));
    });
    var pct = prog.total ? Math.round(prog.done / prog.total * 100) : 0;
    var bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Checklist completion' }, h('span', { class: 'progress__fill', style: { width: pct + '%' } }));

    return section(kind === 'rfr' ? 'Food-safety evaluation (RFR)' : 'Adverse-event report (MedWatch 3500A)', [
      countdown,
      kv(pairs),
      kind === 'medwatch' ? h('div', { class: 'label mt-2', text: 'Seriousness criteria' }) : null,
      kind === 'medwatch' ? critList : null,
      h('div', { class: 'row row--between mt-2' }, [h('span', { class: 'label', text: kind === 'rfr' ? 'RFR checklist' : '3500A checklist' }), h('span', { class: 'muted t-12', text: prog.done + ' of ' + prog.total + ' · ' + pct + '%' })]),
      bar,
      list,
      h('p', { class: 'muted t-12', text: 'Checklist state is saved as tags on this record (' + prefix + '…) with an audit entry per change.' })
    ], { id: 'regulatory', className: 'drawer-section--regulatory' + (due ? ' is-due' : '') });
  }

  function auditPanel(rec) {
    var audit = (rec.audit || []).slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    var list = h('div', { class: 'record-drawer__audit' });
    if (!audit.length) list.appendChild(h('span', { text: 'No changes yet. Edits, notes and bulk actions land here with who and when.' }));
    audit.slice(0, 40).forEach(function (a) {
      var from = a.from == null ? '—' : (Array.isArray(a.from) ? a.from.join(', ') : String(a.from));
      var to = a.to == null ? '—' : (Array.isArray(a.to) ? a.to.join(', ') : String(a.to));
      var txt = a.field === 'note' ? 'added a note' : 'set ' + a.field.replace(/_/g, ' ') + ' ' + from + ' → ' + to;
      list.appendChild(h('div', { class: 'inbox-audit__row' }, [h('span', { class: 'nowrap', text: fmtDate(a.at) }), h('span', { text: (a.by || 'Someone') + ' ' + txt + (a.undo ? ' (undo)' : '') })]));
    });
    if (audit.length > 40) list.appendChild(h('span', { text: '… ' + fmtInt(audit.length - 40) + ' earlier entries' }));
    return section('Audit log', list, { id: 'audit', aside: audit.length ? fmtInt(audit.length) + (audit.length === 1 ? ' entry' : ' entries') : null });
  }

  function buildDrawer(rec) {
    var red = isRedacted(rec);
    var s = store();
    var header = h('div', { class: 'record-drawer__header stack stack--tight' }, [
      h('div', { class: 'record-drawer__subject' }, [
        h('span', { class: 'muted t-13 nowrap', text: rec.id, title: 'Record id' }), h('span', { class: 'muted t-13', text: ' · ' }),
        h('span', { text: label('category', rec.category) + (rec.subcategory ? ' › ' + label('subcategory', rec.subcategory) : '') })
      ]),
      h('div', { class: 'row' }, [
        pill('urgency', rec.urgency), pill('status', rec.status),
        rec.serious_ae ? h('span', { class: 'badge-mini badge-mini--critical', text: 'Serious AE' }) : (rec.is_adverse_event ? h('span', { class: 'badge-mini badge-mini--serious', text: 'AE' }) : null),
        rec.food_safety ? h('span', { class: 'badge-mini badge-mini--critical', text: 'Food safety' }) : null,
        rec.claim_related ? h('span', { class: 'tag', text: 'claim-related' }) : null,
        rec.cancel_intent ? h('span', { class: 'tag', text: 'cancel intent' }) : null,
        h('span', { class: 'muted t-13', text: fmtDate(rec.received_at) + ' · ' + label('channel', rec.channel) + ' · ' + label('product', rec.product) + (rec.kit_component ? ' · ' + label('kit_component', rec.kit_component) : '') + ' · age ' + fmtHours(rec.age_hours) })
      ])
    ]);
    var from;
    if (red) {
      from = h('div', { class: 'notice notice--warning record-drawer__from' }, [
        h('span', { text: 'From: Redacted · restricted (PHI-adjacent) record. ' }),
        h('button', { class: 'btn btn--link t-13', type: 'button', text: 'Reveal in restricted queue', onclick: function () { s.setFilters({ restrictedQueue: true }); } }),
        h('span', { class: 'muted t-12', text: ' — the restricted queue shows sender and body; client-side redaction is a display convenience, not access control.' })
      ]);
    } else {
      from = h('div', { class: 'record-drawer__from t-13' }, [
        h('span', { class: 'muted', text: 'From ' }), h('span', { class: 'strong', text: rec.from_name || 'Unknown sender' }),
        rec.from_email ? h('span', { class: 'muted', text: ' <' + rec.from_email + '>' }) : null,
        rec.order_id ? h('span', { class: 'muted', text: ' · order ' + rec.order_id }) : null,
        rec.lot_number ? h('span', { class: 'muted', text: ' · lot ' + rec.lot_number }) : null,
        rec.language !== 'en' ? h('span', { class: 'tag', text: rec.language === 'other' ? 'non-English · sentiment unscored' : 'language unknown' }) : null,
        rec.restricted ? h('span', { class: 'tag', text: 'restricted queue view' }) : null
      ]);
    }
    var body = h('div', { class: 'record-drawer__text' });
    if (red) body.textContent = '[restricted — open the queue to view]';
    else body.innerHTML = markedHtml(rec.text);
    var legend = red ? null : h('div', { class: 'muted t-12 inbox-marklegend' }, [
      h('mark', { class: 'mark--pos', text: 'positive' }), ' ', h('mark', { class: 'mark--neg', text: 'negative' }), ' lexicon hits · ',
      h('mark', { class: 'mark--safety', text: 'safety' }), ' keywords · ', h('mark', { class: 'mark--entity', text: 'order / lot' })
    ]);

    var main = h('div', { class: 'record-drawer__main' }, [
      header, from,
      section('Message', [body, legend], { id: 'message', aside: (rec.sentiment_label !== 'unscored' && isNum(rec.sentiment)) ? 'sentiment ' + fmtNum(rec.sentiment, 2) + ' (worst sentence ' + fmtNum(rec.sentiment_min, 2) + ')' : 'sentiment unscored' }),
      threadPanel(rec),
      editPanel(rec),
      notesPanel(rec),
      auditPanel(rec)
    ]);
    var side = h('div', { class: 'record-drawer__side' }, [
      regulatoryPanel(rec),
      predictionsPanel(rec),
      customerPanel(rec)
    ]);
    return h('div', { class: 'record-drawer' }, [main, side]);
  }

  function drawerFooter(rec) {
    var openBtn = function (lbl, key, status, kind) {
      return h('button', { class: 'btn btn--sm' + (kind ? ' ' + kind : ''), type: 'button', title: lbl + ' (' + key + ')', disabled: rec.status === status, onclick: function () { updateRecord(rec.id, { status: status }); } }, [lbl, h('kbd', { class: 'kbd', text: key })]);
    };
    var nav = h('span', { class: 'row inbox-drawer-nav' }, [
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Previous record (k)', onclick: function () { stepOpen(-1); } }, '‹ Prev'),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Next record (j)', onclick: function () { stepOpen(1); } }, 'Next ›')
    ]);
    return h('div', { class: 'row inbox-drawer-foot' }, [
      nav, h('span', { class: 'flex-1' }),
      openBtn('Resolve', 'r', 'resolved'),
      openBtn('Escalate', 'e', 'escalated', 'btn--danger'),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: function () { ui().drawer.close(); } }, 'Close')
    ]);
  }

  /** What the open drawer was built from: record id, store version (edits, notes, imports) and the redaction inputs. */
  function drawerSigFor(id) {
    var s = store();
    var f = filters(), st = settings();
    return [id, s && typeof s.version === 'function' ? s.version() : 0, st.redactRestricted === false ? 0 : 1, f.restrictedQueue ? 1 : 0].join('|');
  }
  /** drawer.open while re-populating the same record: components skips the old onClose, and this flag guards the rest. */
  function openDrawer(content, opts) {
    S.rerendering = true;
    try { ui().drawer.open(content, opts); } finally { S.rerendering = false; }
  }

  function renderDrawer(id) {
    var s = store();
    if (!ui() || !ui().drawer || !s) return;
    var rec = s.record(id);
    if (!rec) {
      S.openId = id; S.drawerSig = drawerSigFor(id);
      openDrawer(h('div', {}, [h('p', { class: 'muted', text: 'Record ' + id + ' is not in this data set. It may have been filtered as noise or come from a data set that is no longer loaded.' })]), { title: 'Record not found', onClose: onDrawerClosed });
      return;
    }
    var wasOpen = ui().drawer.isOpen() && S.openId === id;
    var bodyEl = ui().drawer.body();
    var scroll = wasOpen && bodyEl ? bodyEl.scrollTop : 0;
    var focusField = wasOpen && document.activeElement && bodyEl && bodyEl.contains(document.activeElement) ? (document.activeElement.getAttribute('data-field') || document.activeElement.getAttribute('data-check') || document.activeElement.getAttribute('data-crit')) : null;
    var focusAttr = focusField ? (document.activeElement.hasAttribute('data-field') ? 'data-field' : document.activeElement.hasAttribute('data-check') ? 'data-check' : 'data-crit') : null;
    S.openId = id;
    S.drawerSig = drawerSigFor(id);
    var content = buildDrawer(rec);
    // The dialog is named by what the operator reads first (the subject); the record id sits in the meta row below it.
    var title = isRedacted(rec) ? 'Restricted record' : (rec.subject || '(no subject)');
    openDrawer(content, { title: title, onClose: onDrawerClosed, footer: drawerFooter(rec) });
    if (S.table) S.table.setActive(id);
    if (wasOpen && bodyEl) {
      var keepScroll = scroll || S.drawerScroll || 0;
      bodyEl.scrollTop = keepScroll;
      /* drawer.open refocuses its first control after ~60ms; restore the operator's field and scroll after that. */
      setTimeout(function () {
        bodyEl.scrollTop = keepScroll;
        if (!focusField) { if (document.activeElement && bodyEl.contains(document.activeElement)) document.activeElement.blur(); return; }
        var again = bodyEl.querySelector('[' + focusAttr + '="' + focusField + '"]');
        if (again) again.focus({ preventScroll: true });
      }, 90);
    }
    S.drawerScroll = 0;
    if (S.pendingFocus) {
      var target = S.pendingFocus; S.pendingFocus = null;
      setTimeout(function () { focusDrawerField(target); }, 80);
    }
  }

  function focusDrawerField(field) {
    var bodyEl = ui() && ui().drawer ? ui().drawer.body() : null;
    if (!bodyEl) return;
    var el = bodyEl.querySelector('[data-field="' + field + '"]');
    if (el) { el.focus(); if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); }
  }

  function onDrawerClosed() {
    // A re-render of the open record is not a close (components skips the callback for the same opener; this guards
    // any other path). A different opener taking the drawer over is a real close for this record.
    if (S.rerendering) return;
    S.openId = null; S.drawerSig = '';
    if (S.table) S.table.setActive(S.cursor);
    var r = VOC.router;
    var cur = r && r.current();
    if (cur && cur.name === NAME && cur.id) navigate(null, { replace: true });
  }

  function openRecord(id) {
    if (!id) return;
    S.cursor = id;
    var r = VOC.router;
    if (r) navigate(id); else renderDrawer(id);
  }

  function stepOpen(dir) {
    if (!S.table) return;
    var rows = S.table.rows();
    var idx = rows.findIndex(function (r) { return r.id === S.openId; });
    var next = rows[idx + dir];
    if (!next) { toast(dir > 0 ? 'Last record in this list.' : 'First record in this list.', 'info', { ms: 2000 }); return; }
    openRecord(next.id);
  }

  /* ------------------------------------------------------------------ keyboard */

  var KEYS = [
    ['j / k', 'Move down / up (also next / previous record while the drawer is open)'],
    ['Enter / o', 'Open the highlighted record'],
    ['x', 'Select / deselect the highlighted row'],
    ['Esc', 'Close the drawer, or clear the selection'],
    ['a', 'Assign (focuses the assignee select)'],
    ['s', 'Status (focuses the status select)'],
    ['r', 'Resolve the open record or the selection'],
    ['e', 'Escalate the open record or the selection'],
    ['n', 'Note (opens the record and focuses the note box)'],
    ['u', 'Undo the last change'],
    ['/', 'Focus search'],
    ['g then i / e / b', 'Go to Inbox · Regulatory · Briefing (app-wide)']
  ];

  function showKeys(anchor) {
    if (!ui() || !ui().popover) return;
    var list = h('div', { class: 'shortcut-list' });
    KEYS.forEach(function (row) {
      var keys = h('span', { class: 'shortcut-list__keys' });
      row[0].split(' ').forEach(function (k) {
        if (k === 'then') { keys.appendChild(h('span', { class: 'muted', text: 'then' })); return; }
        if (k === '/') { keys.appendChild(h('span', { class: 'muted', text: '/' })); return; }
        keys.appendChild(h('kbd', { class: 'kbd', text: k }));
      });
      list.appendChild(keys);
      list.appendChild(h('span', { class: 't-13', text: row[1] }));
    });
    ui().popover(anchor, h('div', {}, [h('div', { class: 'popover__title', text: 'Inbox keys' }), list, h('p', { class: 'muted t-12 mt-2', text: 'Keys pause while you type in a field. Bulk actions apply to the selection, or to the highlighted row when nothing is selected.' })]), { className: 'popover--wide' });
  }

  function visibleRows() {
    if (!S.table) return [];
    var rows = S.table.rows();
    var p = S.table.page();
    return { all: rows, page: rows.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), pageIndex: p };
  }

  function moveCursor(dir) {
    if (!S.table) return;
    if (S.openId && ui().drawer.isOpen()) { stepOpen(dir); return; }
    var v = visibleRows();
    if (!v.all.length) return;
    var idx = v.all.findIndex(function (r) { return r.id === S.cursor; });
    var next = idx < 0 ? (dir > 0 ? 0 : v.all.length - 1) : Math.min(v.all.length - 1, Math.max(0, idx + dir));
    var rec = v.all[next];
    S.cursor = rec.id;
    var page = Math.floor(next / PAGE_SIZE);
    if (page !== v.pageIndex) S.table.setPage(page);
    S.table.setActive(rec.id);
    var tr = S.table.el.querySelector('tr[data-key="' + rec.id + '"]');
    if (tr) { tr.scrollIntoView({ block: 'nearest' }); tr.focus({ preventScroll: true }); }
  }

  function targetIds() {
    if (S.openId && ui().drawer.isOpen()) return [S.openId];
    if (S.selected.length) return S.selected.slice();
    return S.cursor ? [S.cursor] : [];
  }

  function ensureBulkFor(ids) {
    if (S.selected.length) return;
    if (!ids.length || !S.table) return;
    var tr = S.table.el.querySelector('tr[data-key="' + ids[0] + '"] input[type="checkbox"]');
    if (tr && !tr.checked) { tr.checked = true; tr.dispatchEvent(new Event('change', { bubbles: true })); }
  }

  function keyHandler(e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (S.pendingG) { S.pendingG = false; clearTimeout(S.gTimer); return; }
    var key = e.key;
    if (key === 'g') { S.pendingG = true; clearTimeout(S.gTimer); S.gTimer = setTimeout(function () { S.pendingG = false; }, 1500); return; }
    var drawerOpen = ui() && ui().drawer && ui().drawer.isOpen() && S.openId;
    var s = store();
    switch (key) {
      case 'j': case 'ArrowDown': if (key === 'j' || !drawerOpen) { e.preventDefault(); moveCursor(1); } break;
      case 'k': case 'ArrowUp': if (key === 'k' || !drawerOpen) { e.preventDefault(); moveCursor(-1); } break;
      case 'Enter': case 'o':
        if (drawerOpen) return;
        if (S.cursor) { e.preventDefault(); openRecord(S.cursor); }
        break;
      case 'x':
        if (drawerOpen || !S.cursor || !S.table) return;
        e.preventDefault();
        var cb = S.table.el.querySelector('tr[data-key="' + S.cursor + '"] input[type="checkbox"]');
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        break;
      case 'Escape':
        if (drawerOpen) return;
        if (S.selected.length && S.table) { e.preventDefault(); S.table.clearSelection(); }
        break;
      case 'a': case 's': {
        e.preventDefault();
        var field = key === 'a' ? 'assignee' : 'status';
        if (drawerOpen) { focusDrawerField(field); return; }
        var ids = targetIds();
        if (!ids.length) { toast('Highlight a row with j / k first.', 'info', { ms: 2500 }); return; }
        ensureBulkFor(ids);
        var sel = S.els.bulk && S.els.bulk.querySelector('[data-bulk="' + (key === 'a' ? 'assign' : 'status') + '"]');
        if (sel) sel.focus();
        break;
      }
      case 'r': case 'e': {
        e.preventDefault();
        var status = key === 'r' ? 'resolved' : 'escalated';
        var ids2 = targetIds();
        if (!ids2.length || !s) { toast('Highlight a row with j / k first.', 'info', { ms: 2500 }); return; }
        if (ids2.length === 1) updateRecord(ids2[0], { status: status });
        else bulkPatch(ids2, { status: status }, (key === 'r' ? 'Resolved ' : 'Escalated ') + fmtInt(ids2.length) + ' records.');
        break;
      }
      case 'n':
        e.preventDefault();
        if (drawerOpen) { focusDrawerField('note'); return; }
        if (S.cursor) { S.pendingFocus = 'note'; openRecord(S.cursor); }
        else toast('Highlight a row with j / k first.', 'info', { ms: 2500 });
        break;
      case 'u': {
        e.preventDefault();
        var last = s && s.lastBatchId ? s.lastBatchId() : null;
        if (!last) { toast('Nothing to undo.', 'info', { ms: 2500 }); return; }
        undoBatches([last]);
        break;
      }
      default: break;
    }
  }

  /* ------------------------------------------------------------------ header */

  function renderHeaderControls() {
    var f = filters();
    var sw = S.els.restricted;
    if (sw) sw.checked = !!f.restrictedQueue;
    var badge = S.els.restrictedBadge;
    if (badge) badge.hidden = !f.restrictedQueue;
  }

  /* ------------------------------------------------------------------ view */

  function mount(root, derived) {
    S.root = root;
    S.derived = derived;
    S.stripSig = ''; S.viewsSig = ''; S.selected = []; S.csatCache = null;
    var f = filters();
    var sw = h('input', { type: 'checkbox', 'aria-label': 'Restricted queue: show only restricted (PHI-adjacent) records and reveal their contents' });
    sw.checked = !!f.restrictedQueue;
    sw.addEventListener('change', function () { store() && store().setFilters({ restrictedQueue: sw.checked }); });
    var keysBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Inbox keyboard shortcuts' }, [h('kbd', { class: 'kbd', text: '?' }), 'Keys']);
    keysBtn.addEventListener('click', function () { showKeys(keysBtn); });
    var exportBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Export every record in the current filter as CSV', onclick: function () { exportRecords(S.rows, 'inbox'); } }, 'Export CSV');
    var moreSw = h('input', { type: 'checkbox', 'aria-label': 'More columns: show escalation score and classifier confidence' });
    moreSw.checked = !!S.moreColumns;
    moreSw.addEventListener('change', function () { setMoreColumns(moreSw.checked); });
    var restrictedBadge = h('span', { class: 'badge inbox-restricted-badge', hidden: !f.restrictedQueue, text: 'Restricted queue · contents revealed' });

    root.innerHTML = '';
    var actions = [
      restrictedBadge,
      h('label', { class: 'switch' }, [sw, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', { class: 'switch__label t-13', text: 'Restricted queue' })]),
      h('label', { class: 'switch', title: 'Adds the Escalation and Conf. columns to the table' }, [moreSw, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), h('span', { class: 'switch__label t-13', text: 'More columns' })]),
      exportBtn, keysBtn
    ];
    if (ui() && typeof ui().viewHeader === 'function') {
      S.els.header = ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived), actions: actions });
      S.els.header.vocActions.classList.add('inbox-header-actions');
    } else {
      S.els.header = h('header', { class: 'view-header' }, [h('h1', { class: 'view-title', text: TITLE }), h('p', { class: 'view-meta', 'data-role': 'subtitle', text: subtitle(derived) }), h('div', { class: 'view-actions inbox-header-actions' }, actions)]);
    }
    root.appendChild(S.els.header);
    S.els.subtitle = root.querySelector('[data-role="subtitle"]');
    S.els.restricted = sw;
    S.els.restrictedBadge = restrictedBadge;
    S.els.strip = h('div', { class: 'command-strip inbox-strip', role: 'group', 'aria-label': 'Queue status' });
    S.els.views = h('div', { class: 'inbox-views', role: 'group', 'aria-label': 'Saved views' });
    S.els.bulk = h('div', { class: 'inbox-bulk', role: 'toolbar', 'aria-label': 'Bulk actions', hidden: true });
    S.els.slot = h('div', { class: 'inbox-slot', role: 'status', hidden: true });
    S.els.table = h('div', { class: 'inbox-table' });
    S.els.drop = h('div', { class: 'inbox-drop' });
    root.appendChild(S.els.strip);
    root.appendChild(S.els.views);
    root.appendChild(S.els.slot);
    root.appendChild(S.els.bulk);
    root.appendChild(S.els.table);
    root.appendChild(S.els.drop);

    var r0 = VOC.router;
    var cur0 = r0 && r0.current();
    S.slot = cur0 && cur0.name === NAME ? slotFromQuery(cur0.query) : null;
    S.rows = slotFilter(rowsFromDerived(derived));
    renderStrip(derived);
    renderViews();
    renderSlot();
    buildTable();
    renderBulk();
    mountDropZone();

    S.keyHandler = keyHandler;
    document.addEventListener('keydown', S.keyHandler);
    var s = store();
    if (s && typeof s.on === 'function') {
      S.viewsHandler = function () { S.viewsSig = ''; renderViews(); };
      s.on('views:changed', S.viewsHandler);
    }
    var r = VOC.router;
    var cur = r && r.current();
    if (cur && cur.name === NAME && cur.id) renderDrawer(cur.id);
  }

  function update(derived) {
    S.derived = derived;
    if (S.els.subtitle) S.els.subtitle.textContent = subtitle(derived);
    S.rows = slotFilter(rowsFromDerived(derived));
    renderStrip(derived);
    S.viewsSig = ''; renderViews();
    renderHeaderControls();
    renderSlot();
    if (S.table) {
      S.table.update(S.rows, { keepPage: true, keepSelection: true });
      S.selected = S.table.selection();
      renderBulk();
      if (S.openId) S.table.setActive(S.openId); else if (S.cursor) S.table.setActive(S.cursor);
    } else buildTable();
    if (S.openId && ui() && ui().drawer && ui().drawer.isOpen()) {
      // Rebuild the open drawer only when its inputs changed (record edits bump the store version; a search keystroke
      // does not), and never for a record the pending onRoute is about to replace (j / k, Next ›).
      var r = VOC.router, cur = r && r.current();
      var routeSwitching = cur && cur.name === NAME && cur.id && cur.id !== S.openId;
      if (!routeSwitching && drawerSigFor(S.openId) !== S.drawerSig) renderDrawer(S.openId);
    }
  }

  function onRoute(route) {
    if (!route || route.name !== NAME) return;
    var slot = slotFromQuery(route.query);
    if (!sameSlot(slot, S.slot)) setSlot(slot, true);
    if (route.id) { if (route.id !== S.openId || !(ui() && ui().drawer.isOpen())) renderDrawer(route.id); }
    else if (S.openId && ui() && ui().drawer && ui().drawer.isOpen()) { S.openId = null; ui().drawer.close(); }
  }

  function unmount() {
    if (S.keyHandler) document.removeEventListener('keydown', S.keyHandler);
    S.keyHandler = null;
    var s = store();
    if (s && S.viewsHandler && typeof s.off === 'function') s.off('views:changed', S.viewsHandler);
    S.viewsHandler = null;
    clearTimeout(S.gTimer);
    if (ui() && ui().closePopover) ui().closePopover();
    S.table = null; S.els = {}; S.root = null; S.openId = null; S.selected = []; S.csatCache = null; S.slot = null; S.drawerSig = '';
  }

  VOC.views[NAME] = {
    title: TITLE,
    icon: NAME,
    mount: mount,
    update: update,
    unmount: unmount,
    onRoute: onRoute,
    /** Exposed for tests and the Regulatory view. */
    TILES: TILES,
    markedHtml: markedHtml,
    rowsFromDerived: rowsFromDerived
  };
})();
