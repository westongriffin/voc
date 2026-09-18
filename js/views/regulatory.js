/* L-Nutra · Voice of the Customer — Regulatory view (SPEC §5.7)
   Two clocks over the whole record set (the global range is ignored and the header meta says so):
   MedWatch 3500A 15 business days for serious adverse events (statutory on the L-Pill dietary supplement, a voluntary
   report on conventional-food kits and programs); Reportable Food Registry 24 hours for foreign material or allergen
   reports on conventional food and supplements. Tiles, deadline table, seriousness and AE-by-product bars, lot table,
   register CSV export, green all-clear state. Loads under jsc: nothing touches the DOM at parse time. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'regulatory';
  var TITLE = 'Regulatory';

  /* Shared checklist definitions; inbox.js defines the same object when it loads first. */
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
  function fmtNum(n, d) { return U().fmt && U().fmt.num ? U().fmt.num(n, d) : (isNum(n) ? n.toFixed(d || 0) : '—'); }
  function fmtHours(hrs) { return U().fmt && U().fmt.hours ? U().fmt.hours(hrs) : (isNum(hrs) ? Math.round(hrs) + 'h' : '—'); }
  function fmtDate(iso, gran) { return U().fmt && U().fmt.date ? U().fmt.date(iso, gran || 'datetime') : String(iso || '—'); }
  function pill(kind, value) { return ui() && ui().pill ? ui().pill(kind, value) : h('span', { class: 'pill' }, String(value)); }
  function toast(msg, kind, opts) { if (ui() && ui().toast) return ui().toast(msg, kind, opts); return null; }
  function openRecord(id) {
    var r = VOC.router, s = store();
    if (!r) return;
    r.navigate('inbox', { id: id, query: s && s.toQuery ? s.toQuery() : undefined });
  }
  function drill(filtersPatch) {
    var s = store();
    if (s && typeof s.drill === 'function') s.drill({ view: 'inbox', filters: Object.assign({ range: { preset: '12m' }, flags: [], restrictedQueue: false }, filtersPatch || {}) });
  }

  /* ------------------------------------------------------------------ data */

  var S = { root: null, els: {}, charts: [], sig: '', tableHandle: null, lotHandle: null };

  function allRecords(derived) {
    if (derived && Array.isArray(derived.allRecords)) return derived.allRecords;
    var s = store();
    return s && typeof s.all === 'function' ? s.all() : [];
  }

  function window12m(nowDate) {
    var u = U();
    var to = u.dayKey ? u.dayKey(nowDate.toISOString()) : nowDate.toISOString().slice(0, 10);
    var from = u.addDays ? u.addDays(to, -364) : to;
    return { from: from, to: to };
  }

  function compute(derived) {
    var s = store();
    var now = s && s.now ? s.now() : new Date();
    var all = allRecords(derived);
    var w = window12m(now);
    var in12m = all.filter(function (r) { return r.day_key && r.day_key >= w.from && r.day_key <= w.to; });
    var reg = (derived && derived.regulatory) || null;
    var openSerious = reg ? reg.openSerious : all.filter(function (r) { return r.serious_ae && r.is_open; });
    var deadlines = reg ? reg.deadlines : [];
    var nonSerious12m = in12m.filter(function (r) { return r.is_adverse_event && !r.serious_ae; });
    var ae12m = in12m.filter(function (r) { return r.is_adverse_event; });
    var serious12m = in12m.filter(function (r) { return r.serious_ae; });
    var openRfr = all.filter(function (r) { return r.regulatory_clock === 'rfr_24h' && r.is_open; });
    var openForeign = all.filter(function (r) { return r.is_open && (r.food_safety || r.category === 'foreign_material_allergen'); });
    var contra12m = in12m.filter(function (r) { return Array.isArray(r.contraindication_flags) && r.contraindication_flags.length > 0; });
    var regulatoryAll = all.filter(function (r) { return r.is_adverse_event || r.serious_ae || r.food_safety || r.regulatory_clock !== 'none'; });

    var aeRate = null;
    var orders = null;
    if (s && typeof s.ordersInRange === 'function') { try { orders = s.ordersInRange(w.from, w.to); } catch (e) { orders = null; } }
    if (VOC.metrics && typeof VOC.metrics.compute === 'function') {
      try {
        aeRate = VOC.metrics.compute('ae_rate', nonSerious12m, {
          now: now, from: w.from, to: w.to, orders: s && s.orders ? s.orders() : null,
          ordersInRange: s && s.ordersInRange ? s.ordersInRange : null, customers: s && s.customers ? s.customers() : null, allRecords: all,
          sla: s && s.settings ? s.settings().sla : null
        });
      } catch (e) { aeRate = null; }
    }

    var critCounts = {};
    serious12m.forEach(function (r) { (r.ae_criteria || []).forEach(function (c) { critCounts[c] = (critCounts[c] || 0) + 1; }); });
    var byProduct = {};
    ae12m.forEach(function (r) { byProduct[r.product] = (byProduct[r.product] || 0) + 1; });

    var lots = VOC.analytics && typeof VOC.analytics.lotMatrix === 'function' ? VOC.analytics.lotMatrix(all) : [];

    return {
      now: now, window: w, all: all, in12m: in12m, openSerious: openSerious, deadlines: deadlines, nonSerious12m: nonSerious12m, ae12m: ae12m, serious12m: serious12m,
      openRfr: openRfr, openForeign: openForeign, contra12m: contra12m, regulatoryAll: regulatoryAll, aeRate: aeRate, orders: orders,
      critCounts: critCounts, byProduct: byProduct, lots: lots,
      allClear: !openSerious.length && !openRfr.length && !openForeign.length && !deadlines.length
    };
  }

  function signature(d) {
    return [d.openSerious.length, d.openRfr.length, d.openForeign.length, d.deadlines.map(function (x) { return x.rec.id + ':' + Math.round(x.remaining || 0) + ':' + (x.rec.tags || []).length + ':' + x.rec.status; }).join(','),
      d.nonSerious12m.length, d.contra12m.length, JSON.stringify(d.critCounts), JSON.stringify(d.byProduct), d.lots.length, d.aeRate && d.aeRate.value].join('|');
  }

  /* ------------------------------------------------------------------ tiles */

  function renderTiles(d) {
    var strip = S.els.tiles;
    if (!strip || !ui() || !ui().kpiTile) return;
    strip.innerHTML = '';
    var rate = d.aeRate;
    var hasOrders = rate && isNum(rate.value) && isNum(d.orders) && d.orders > 0;
    strip.appendChild(ui().kpiTile({
      id: 'reg_open_serious', label: 'Open serious AE', unit: 'count', value: d.openSerious.length, n: d.all.filter(function (r) { return r.serious_ae; }).length, direction: 'down_good',
      formula: 'serious_ae ∧ status ∈ {new, open, pending, reopened, escalated} — every record, no date range',
      onClick: function () { drill({ flags: ['serious_ae', 'open'] }); }
    }));
    strip.appendChild(ui().kpiTile({
      id: 'reg_nonserious', label: hasOrders ? 'Non-serious AE · per 10k orders (12m)' : 'Non-serious AE (12m)', unit: hasOrders ? 'per_10k' : 'count',
      value: hasOrders ? rate.value : d.nonSerious12m.length, n: d.nonSerious12m.length, interval: hasOrders && rate.interval ? rate.interval : null, direction: 'down_good',
      formula: hasOrders ? 'non-serious AE records / orders × 10,000 over the last 12 months · 95% Poisson (Garwood) interval · orders = ' + fmtInt(d.orders) : 'count of is_adverse_event ∧ ¬serious_ae over the last 12 months (no order data for the window, so no rate)',
      onClick: function () { drill({ flags: ['ae'] }); }
    }));
    strip.appendChild(ui().kpiTile({
      id: 'reg_open_rfr', label: 'Open RFR evaluations (24h)', unit: 'count', value: d.openRfr.length, n: d.all.filter(function (r) { return r.regulatory_clock === 'rfr_24h'; }).length, direction: 'down_good',
      formula: 'food_safety ∧ product_class = conventional_food ∧ open — Reportable Food Registry clock, received_at + 24h',
      onClick: function () { drill({ flags: ['food_safety', 'open'] }); }
    }));
    strip.appendChild(ui().kpiTile({
      id: 'reg_open_foreign', label: 'Open foreign material / allergen', unit: 'count', value: d.openForeign.length, n: d.all.filter(function (r) { return r.food_safety || r.category === 'foreign_material_allergen'; }).length, direction: 'down_good',
      formula: 'open ∧ (food_safety ∨ category = foreign_material_allergen)',
      onClick: function () { drill({ category: ['foreign_material_allergen'], flags: ['open'] }); }
    }));
    strip.appendChild(ui().kpiTile({
      id: 'reg_contra', label: 'Contraindication matches (12m)', unit: 'count', value: d.contra12m.length, n: d.in12m.length, direction: 'down_good',
      formula: 'records with ≥1 contraindication flag (pregnancy, minor, glucose-lowering medication, nut/soy allergy, low BMI, serious disease) in the last 12 months — no Inbox flag filter exists for this yet, so the tile does not drill'
    }));
  }

  /* ------------------------------------------------------------------ deadline table */

  function remainingCell(row) {
    var rec = row.rec;
    var text, cls = '';
    if (row.clock === 'medwatch_15bd') {
      var bd = isNum(row.businessDaysRemaining) ? row.businessDaysRemaining : rec.business_days_remaining;
      if (!isNum(bd)) return '<span class="muted">—</span>';
      if (bd < 0) { text = 'overdue by ' + fmtNum(-bd, 1) + ' business days'; cls = 'countdown--due'; }
      else { text = fmtNum(bd, 1) + ' business days'; if (bd < 2) cls = 'countdown--soon'; }
      text += ' <span class="muted">(' + esc(fmtHours(row.remaining)) + ')</span>';
    } else {
      var hrs = isNum(row.remaining) ? row.remaining : rec.hours_remaining;
      if (!isNum(hrs)) return '<span class="muted">—</span>';
      if (hrs < 0) { text = 'overdue by ' + esc(fmtHours(-hrs)); cls = 'countdown--due'; }
      else { text = esc(fmtHours(hrs)) + ' left'; if (hrs < 48) cls = 'countdown--soon'; }
    }
    return '<span class="reg-remaining ' + cls + '">' + text + '</span>';
  }

  /** 'statutory' | 'voluntary' for a deadline row: the store derives it; older rows fall back to the product class. */
  function clockBasis(r) {
    var rec = r && r.rec ? r.rec : {};
    if (rec.regulatory_clock_basis) return rec.regulatory_clock_basis;
    if (r.clock === 'medwatch_15bd') return rec.product_class === 'supplement' ? 'statutory' : 'voluntary';
    return 'statutory';
  }
  function deadlineColumns() {
    var RC = VOC.regulatoryChecklist;
    return [
      { key: 'record', label: 'Record', className: 'reg-record', sortValue: function (r) { return r.rec.id; }, render: function (r) {
        var red = r.rec.restricted && (store() && store().settings().redactRestricted !== false) && !(store().filters().restrictedQueue);
        return '<span class="strong">' + esc(r.rec.id) + '</span><br><span class="muted truncate reg-subject" title="' + esc(red ? 'Restricted record' : r.rec.subject) + '">' + esc(red ? 'Restricted record' : (r.rec.subject || '(no subject)')) + '</span>';
      } },
      { key: 'received', label: 'Received (CT)', sortValue: function (r) { return r.rec.received_at; }, render: function (r) { return esc(fmtDate(r.rec.received_at)); } },
      { key: 'product', label: 'Product · class', sortValue: function (r) { return label('product', r.rec.product); }, render: function (r) {
        return esc(label('product', r.rec.product)) + '<br><span class="muted">' + esc(label('product_class', r.rec.product_class)) + '</span>';
      } },
      { key: 'clock', label: 'Clock', sortValue: function (r) { return r.clock + ':' + clockBasis(r); }, render: function (r) {
        if (r.clock !== 'medwatch_15bd') return '<span class="tag" title="Reportable Food Registry · 24 hours">RFR · 24 hours</span>';
        return clockBasis(r) === 'voluntary'
          ? '<span class="tag" title="MedWatch 3500A · 15 business days · voluntary report: the statutory serious-AE filing applies to dietary supplements, not to conventional food or programs">MedWatch · 15 business days · voluntary</span>'
          : '<span class="tag" title="MedWatch 3500A · 15 business days · statutory serious-AE report for a dietary supplement">MedWatch · 15 business days</span>';
      } },
      { key: 'deadline', label: 'Deadline', sortValue: function (r) { return r.deadline; }, render: function (r) { return esc(fmtDate(r.deadline)); } },
      { key: 'remaining', label: 'Remaining', sortValue: function (r) { return isNum(r.remaining) ? r.remaining : 1e9; }, render: remainingCell },
      { key: 'checklist', label: 'Checklist', align: 'right', sortValue: function (r) { var p = RC.progress(r.rec); return p.pct == null ? -1 : p.pct; }, render: function (r) {
        var p = RC.progress(r.rec);
        if (!p.total) return '<span class="muted">—</span>';
        var pct = Math.round(p.pct * 100);
        return '<span class="reg-check" title="' + p.done + ' of ' + p.total + ' items ticked"><span class="progress progress--inline" aria-hidden="true"><span class="progress__fill" style="width:' + pct + '%"></span></span> ' + pct + '%</span>';
      } },
      { key: 'lot', label: 'Lot', sortValue: function (r) { return r.rec.lot_number || ''; }, render: function (r) { return r.rec.lot_number ? esc(r.rec.lot_number) : '<span class="muted">—</span>'; } },
      { key: 'status', label: 'Status', sortValue: function (r) { return r.rec.status; }, render: function (r) { return pill('status', r.rec.status); } }
    ];
  }

  function renderDeadlines(d) {
    var host = S.els.deadlines;
    if (!host) return;
    host.innerHTML = '';
    var rows = d.deadlines.slice().sort(function (a, b) { return (isNum(a.remaining) ? a.remaining : 1e9) - (isNum(b.remaining) ? b.remaining : 1e9); });
    var head = h('div', { class: 'card__header' }, [
      h('div', {}, [h('h2', { class: 'card__title', text: 'Open clocks' }), h('p', { class: 'card__subtitle', text: rows.length ? fmtInt(rows.length) + (rows.length === 1 ? ' open record on a mandatory reporting clock' : ' open records on a mandatory reporting clock') + ', soonest first. Overdue rows are in red.' : 'No open record is on a mandatory reporting clock.' })]),
      h('div', { class: 'row' }, [h('button', { class: 'btn btn--sm', type: 'button', onclick: function () { drill({ flags: ['ae'] }); } }, 'AE register in Inbox →')])
    ]);
    host.appendChild(head);
    if (!rows.length) {
      var empty = h('div', {});
      if (ui() && ui().emptyState) ui().emptyState(empty, { kind: 'good', icon: 'check', title: d.allClear ? 'All clear' : 'No deadlines pending', text: d.allClear ? 'No open serious adverse events, no open food-safety evaluations and nothing on a reporting clock. Closed records stay in the register export.' : 'Open food-safety or AE records exist but none carries a live mandatory clock.' });
      host.appendChild(empty);
      return;
    }
    if (!ui() || !ui().table) return;
    S.tableHandle = ui().table({
      columns: deadlineColumns(), rows: rows, pageSize: 50, rowKey: function (r) { return r.rec.id; },
      rowClass: function (r) { return isNum(r.remaining) && r.remaining < 0 ? 'is-critical' : ''; },
      onRowClick: function (r) { openRecord(r.rec.id); },
      emptyText: 'Nothing on a clock.'
    });
    host.appendChild(S.tableHandle.el);
  }

  /* ------------------------------------------------------------------ charts */

  function destroyCharts() {
    S.charts.forEach(function (el) { if (el && typeof el.vocDestroy === 'function') { try { el.vocDestroy(); } catch (e) { /* gone */ } } });
    S.charts = [];
  }

  function renderCharts(d) {
    var host = S.els.charts;
    if (!host || !ui() || !ui().chartCard) return;
    destroyCharts();
    host.innerHTML = '';
    var e = E();
    var critIds = e && e.list ? e.list('ae_criteria').map(function (o) { return o.id; }) : Object.keys(d.critCounts);
    var critLabels = critIds.map(function (id) { return label('ae_criteria', id); });
    var critData = critIds.map(function (id) { return d.critCounts[id] || 0; });
    var critTotal = critData.reduce(function (a, b) { return a + b; }, 0);
    var crit = ui().chartCard({
      id: 'reg-seriousness', title: 'Seriousness criteria', question: 'Which criteria made the last 12 months of AEs serious? One record can meet several.',
      formula: 'count of serious AE records (12m) per ae_criteria value; a record with two criteria counts in both bars', n: d.serious12m.length, height: 260,
      render: function (canvas) {
        if (!critTotal || !VOC.charts || typeof VOC.charts.bar !== 'function') return null;
        return VOC.charts.bar(canvas, { labels: critLabels, datasets: [{ label: 'Serious AE records', data: critData, slot: 1 }], xLabel: 'Records', ariaLabel: 'Horizontal bars of serious adverse-event records by seriousness criterion over the last 12 months', onClick: function (i) { drill({ flags: ['serious_ae'], search: '' }); } });
      },
      table: function () { return { columns: [{ key: 'label', label: 'Criterion' }, { key: 'count', label: 'Serious AE records' }], rows: critIds.map(function (id, i) { return { label: critLabels[i], count: critData[i] }; }) }; },
      csvName: 'lnutra-voc-regulatory-seriousness.csv',
      footnote: critTotal ? 'Multi-label: ' + fmtInt(critTotal) + ' criterion hits across ' + fmtInt(d.serious12m.length) + ' serious records.' : 'No serious AE in the last 12 months.'
    });
    host.appendChild(crit); S.charts.push(crit);

    var prodIds = Object.keys(d.byProduct).sort(function (a, b) { return d.byProduct[b] - d.byProduct[a]; });
    var prodLabels = prodIds.map(function (id) { return label('product', id); });
    var prodData = prodIds.map(function (id) { return d.byProduct[id]; });
    var prod = ui().chartCard({
      id: 'reg-ae-product', title: 'Adverse events by product (12m)', question: 'Where do AE reports concentrate? Counts, not rates — see Products for per-order rates.',
      formula: 'count of is_adverse_event records in the last 12 months grouped by product (serious and non-serious)', n: d.ae12m.length, height: 260,
      render: function (canvas) {
        if (!prodIds.length || !VOC.charts || typeof VOC.charts.bar !== 'function') return null;
        return VOC.charts.bar(canvas, { labels: prodLabels, datasets: [{ label: 'AE records', data: prodData, slot: 1 }], xLabel: 'Records', ariaLabel: 'Horizontal bars of adverse-event records by product over the last 12 months', onClick: function (i) { if (prodIds[i]) drill({ product: [prodIds[i]], flags: ['ae'] }); } });
      },
      table: function () { return { columns: [{ key: 'label', label: 'Product' }, { key: 'count', label: 'AE records' }], rows: prodIds.map(function (id, i) { return { label: prodLabels[i], count: prodData[i] }; }) }; },
      csvName: 'lnutra-voc-regulatory-ae-by-product.csv',
      footnote: 'Single color on purpose: the bars are one measure across products, not a ranking.'
    });
    host.appendChild(prod); S.charts.push(prod);
  }

  /* ------------------------------------------------------------------ lot table */

  function renderLots(d) {
    var host = S.els.lots;
    if (!host) return;
    host.innerHTML = '';
    var lots = d.lots || [];
    host.appendChild(h('div', { class: 'card__header' }, [
      h('div', {}, [h('h2', { class: 'card__title', text: 'Lots mentioned' }), h('p', { class: 'card__subtitle', text: lots.length ? fmtInt(lots.length) + ' lot numbers extracted from the message text across every record; food-safety lots first and in bold. Click a lot to search the Inbox for it.' : 'No lot numbers extracted yet.' })])
    ]));
    if (!lots.length) {
      var empty = h('div', {});
      if (ui() && ui().emptyState) ui().emptyState(empty, { title: 'No lots yet', text: 'Lot numbers appear here once the classifier extracts them from message text (for example “lot NG-0426-B”).' });
      host.appendChild(empty);
      return;
    }
    if (!ui() || !ui().table) return;
    var rows = lots.map(function (l) {
      var weeks = Object.keys(l.weeks || {}).sort();
      var peak = weeks.reduce(function (best, wk) { return l.weeks[wk] > (best ? l.weeks[best] : -1) ? wk : best; }, null);
      var products = Object.keys(l.products || {}).sort(function (a, b) { return l.products[b] - l.products[a]; });
      return { id: l.lot, lot: l.lot, products: products, total: l.total, foodSafety: !!l.foodSafety, weeks: weeks.length, first: weeks[0] || null, last: weeks[weeks.length - 1] || null, peak: peak, peakCount: peak ? l.weeks[peak] : null, series: weeks.map(function (wk) { return l.weeks[wk]; }) };
    });
    S.lotHandle = ui().table({
      columns: [
        { key: 'lot', label: 'Lot', render: function (r) { return '<span class="' + (r.foodSafety ? 'strong' : '') + '">' + esc(r.lot) + '</span>'; } },
        { key: 'products', label: 'Product(s)', sort: false, render: function (r) { return esc(r.products.map(function (p) { return label('product', p); }).join(', ') || '—'); } },
        { key: 'foodSafety', label: 'Food safety', align: 'center', sortValue: function (r) { return r.foodSafety ? 1 : 0; }, render: function (r) { return r.foodSafety ? '<span class="badge-mini badge-mini--critical" title="At least one food-safety record cites this lot">FS</span>' : '<span class="muted">—</span>'; } },
        { key: 'total', label: 'Records', align: 'right', defaultDir: 'desc' },
        { key: 'weeks', label: 'Weeks active', align: 'right' },
        { key: 'first', label: 'First week', render: function (r) { return r.first ? esc(fmtDate(r.first)) : '—'; } },
        { key: 'last', label: 'Last week', render: function (r) { return r.last ? esc(fmtDate(r.last)) : '—'; } },
        { key: 'peakCount', label: 'Peak week', align: 'right', render: function (r) { return r.peak ? esc(fmtInt(r.peakCount)) + ' <span class="muted">' + esc(fmtDate(r.peak)) + '</span>' : '—'; } },
        { key: 'series', label: 'Trend', sort: false, render: function (r) {
          var span = h('span', { class: 'sparkline', 'aria-label': 'Weekly mentions ' + r.series.join(', ') });
          if (r.series.length >= 2 && VOC.charts && typeof VOC.charts.sparkline === 'function') { try { VOC.charts.sparkline(span, r.series, { width: 96, height: 24 }); } catch (e) { span.textContent = r.series.join(' '); } }
          else span.textContent = r.series.join(' ');
          return span;
        } }
      ],
      rows: rows, pageSize: 50, rowKey: function (r) { return r.lot; },
      rowClass: function (r) { return r.foodSafety ? 'is-food-safety' : ''; },
      onRowClick: function (r) { drill({ search: r.lot }); },
      emptyText: 'No lots.'
    });
    host.appendChild(S.lotHandle.el);
  }

  /* ------------------------------------------------------------------ export */

  function exportRegister(d) {
    var ex = VOC.exporter, s = store();
    if (!ex || typeof ex.regulatoryCsv !== 'function') { toast('Exporter module is not loaded.', 'warning'); return; }
    var st = s ? s.settings() : {};
    var csv = ex.regulatoryCsv(d.all, { redact: st.redactRestricted !== false, now: d.now });
    var name = typeof ex.filename === 'function' ? ex.filename('regulatory') : 'lnutra-voc-regulatory.csv';
    if (typeof ex.downloadText === 'function') ex.downloadText(name, csv, 'text/csv;charset=utf-8');
    else if (ui() && ui().downloadText) ui().downloadText(name, csv, 'text/csv;charset=utf-8');
    // Count rows from the record set, not CSV lines: quoted message text spans several lines per RFC 4180.
    var rows = typeof ex.regulatoryCount === 'function' ? ex.regulatoryCount(d.all) : d.regulatoryAll.length;
    var extra = Math.max(0, rows - d.regulatoryAll.length);
    toast('Register exported: ' + fmtInt(rows) + ' records with clock and deadline columns' + (extra ? ' (' + fmtInt(d.regulatoryAll.length) + ' AE / food-safety plus ' + fmtInt(extra) + ' contraindication ' + (extra === 1 ? 'match' : 'matches') + ')' : '') + (st.redactRestricted !== false ? '; restricted rows redacted.' : '.'), 'info');
  }

  /* ------------------------------------------------------------------ view */

  /** One-line header meta: scope (every open clock, no date range), the 12-month anchor and the register size. */
  function subtitleText(d) {
    return 'All open clocks, regardless of the date range · 12-month tiles count back from ' + fmtDate(d.now.toISOString(), 'day') + ' · n = ' + fmtInt(d.regulatoryAll.length) + ' register records';
  }
  /** One bold sentence for the header: open serious AE and RFR evaluations with the soonest deadline, always with n. */
  function leadText(d) {
    var n = ' (n = ' + fmtInt(d.regulatoryAll.length) + ' register records)';
    if (d.allClear) return 'No open serious adverse event or RFR evaluation; every reporting clock is clear' + n + '.';
    var bits = [];
    if (d.openSerious.length) bits.push(fmtInt(d.openSerious.length) + ' open serious AE' + (d.openSerious.length === 1 ? '' : 's'));
    if (d.openRfr.length) bits.push(fmtInt(d.openRfr.length) + ' RFR evaluation' + (d.openRfr.length === 1 ? '' : 's') + ' on the 24h clock');
    if (!bits.length && d.openForeign.length) bits.push(fmtInt(d.openForeign.length) + ' open foreign-material or allergen report' + (d.openForeign.length === 1 ? '' : 's'));
    if (!bits.length && d.deadlines.length) bits.push(fmtInt(d.deadlines.length) + ' record' + (d.deadlines.length === 1 ? '' : 's') + ' on a reporting clock');
    var next = d.deadlines.length ? d.deadlines[0] : null;
    var soon = '';
    if (next) {
      // "9 business days remaining" / "overdue by 3h"; the deadline table below carries the exact timestamps.
      var rem = VOC.narrate && typeof VOC.narrate.deadlineRemaining === 'function' ? VOC.narrate.deadlineRemaining(next) : '';
      soon = '; soonest clock ' + (rem || 'due ' + fmtDate(next.deadline, 'datetime'));
    }
    return bits.join(' and ') + soon + n + '.';
  }
  function setHeader(d) {
    var hd = S.els.header;
    if (!hd) return;
    if (hd.setMeta) hd.setMeta(subtitleText(d)); else if (S.els.subtitle) S.els.subtitle.textContent = subtitleText(d);
    if (hd.setLead) hd.setLead(leadText(d));
  }

  function renderAll(d) {
    setHeader(d);
    renderTiles(d);
    renderDeadlines(d);
    renderCharts(d);
    renderLots(d);
    if (S.els.allClear) {
      S.els.allClear.hidden = !d.allClear;
      if (d.allClear && ui() && ui().emptyState) ui().emptyState(S.els.allClear, { kind: 'good', icon: 'check', title: 'All clear', text: 'No open serious adverse events, no open food-safety evaluations and no record on a mandatory reporting clock as of ' + fmtDate(d.now.toISOString()) + '.' });
    }
  }

  function mount(root, derived) {
    S.root = root;
    var d = compute(derived);
    root.innerHTML = '';
    var exportBtn = h('button', { class: 'btn btn--sm', type: 'button', title: 'CSV of every AE and food-safety record with clock and deadline', onclick: function () { exportRegister(compute(store() ? store().derived() : null)); } }, 'Export register CSV');
    if (ui() && typeof ui().viewHeader === 'function') S.els.header = ui().viewHeader({ title: TITLE, meta: subtitleText(d), lead: leadText(d), actions: [exportBtn] });
    else S.els.header = h('header', { class: 'view-header' }, [h('h1', { class: 'view-title', text: TITLE }), h('p', { class: 'view-meta', 'data-role': 'subtitle', text: subtitleText(d) }), h('div', { class: 'view-actions' }, [exportBtn])]);
    root.appendChild(S.els.header);
    S.els.subtitle = root.querySelector('[data-role="subtitle"]');

    // The two clock explanations live in a collapsed "How this works" block so the top of the view stays compact.
    var clocks = h('div', { class: 'reg-clocks' }, [
      h('div', { class: 'notice reg-clock reg-clock--medwatch' }, [h('span', { class: 'strong', text: 'MedWatch 3500A · 15 business days. ' }), h('span', { text: 'A serious adverse event (death, life-threatening, hospitalization, disability, birth defect or medical intervention) starts a 15-business-day clock counted from the day the report is received, skipping US federal holidays. Filing FDA Form 3500A is statutory for the L-Pill dietary supplement; on ProLon kits, bars, shakes and programs the same clock tracks a voluntary MedWatch report, and the deadline table labels those rows “voluntary”.' })]),
      h('div', { class: 'notice reg-clock reg-clock--rfr' }, [h('span', { class: 'strong', text: 'Reportable Food Registry · 24 hours. ' }), h('span', { text: 'A foreign-material or allergen report on a conventional food (ProLon kits, Fast Bar, shakes, L-Protein) or a dietary supplement (L-Pill) starts a 24-hour clock to evaluate whether there is a reasonable probability of serious adverse health consequences and, if so, to submit to the Reportable Food Registry.' })])
    ]);
    root.appendChild(ui() && typeof ui().howDetails === 'function'
      ? ui().howDetails({ summary: 'How this works: the two reporting clocks', body: clocks })
      : h('details', { class: 'how' }, [h('summary', { class: 'how__summary', text: 'How this works: the two reporting clocks' }), h('div', { class: 'how__body' }, [clocks])]));

    S.els.allClear = h('div', { class: 'card empty-state--good reg-allclear', hidden: true });
    root.appendChild(S.els.allClear);
    S.els.tiles = h('div', { class: 'kpi-strip reg-tiles' });
    root.appendChild(S.els.tiles);
    S.els.deadlines = h('div', { class: 'card regulatory-table reg-deadlines' });
    root.appendChild(S.els.deadlines);
    S.els.charts = h('div', { class: 'regulatory-charts' });
    root.appendChild(S.els.charts);
    S.els.lots = h('div', { class: 'card regulatory-lots reg-lots' });
    root.appendChild(S.els.lots);

    renderAll(d);
    S.sig = signature(d);
  }

  function update(derived) {
    if (!S.root) return;
    var d = compute(derived);
    var sig = signature(d);
    setHeader(d);
    if (sig === S.sig) return;
    S.sig = sig;
    renderAll(d);
  }

  function unmount() {
    destroyCharts();
    S.root = null; S.els = {}; S.tableHandle = null; S.lotHandle = null; S.sig = '';
  }

  VOC.views[NAME] = {
    title: TITLE,
    icon: NAME,
    mount: mount,
    update: update,
    unmount: unmount,
    /** Exposed for tests. */
    compute: compute
  };
})();
