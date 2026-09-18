/* L-Nutra · Voice of the Customer — Customers view (SPEC §5 item 5)
   Segment comparison (three small bar charts), cancellation-risk table with method badge, score histogram with
   reliability twin when fitted, first-contact cohort heatmap, HCP practice rollup and region bars.
   Classic script; touches the DOM only inside mount/update/unmount. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'customers';
  var TITLE = 'Customers';
  var SMALL_N = 30;          // segments below this are greyed and flagged
  var RISK_TABLE_ROWS = 50;
  var TIERS = [{ id: 'low', lo: 0, hi: 24 }, { id: 'watch', lo: 25, hi: 49 }, { id: 'high', lo: 50, hi: 74 }, { id: 'critical', lo: 75, hi: 100 }];

  /* ------------------------------------------------------------------ helpers */

  function ui() { return VOC.ui || null; }
  function util() { return VOC.util || null; }
  function charts() { return VOC.charts || null; }
  function store() { return VOC.store || null; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function esc(s) {
    if (ui() && ui().esc) return ui().esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function label(kind, id) {
    if (VOC.enums && typeof VOC.enums.label === 'function') return VOC.enums.label(kind, id);
    return String(id == null ? '' : id);
  }
  function titleCase(s) { return String(s == null ? '' : s).replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }); }
  function h(tag, attrs, children) {
    if (ui() && typeof ui().h === 'function') return ui().h(tag, attrs, children);
    var u = util();
    if (u && typeof u.el === 'function') return u.el(tag, attrs, children);
    var el = document.createElement(tag);
    if (attrs && attrs.text) el.textContent = attrs.text;
    return el;
  }
  function fmtInt(n) { var u = util(); return u && u.fmt ? u.fmt.int(n) : String(Math.round(n)); }
  function fmtNum(n, d) { var u = util(); return u && u.fmt ? u.fmt.num(n, d) : String(n); }
  function fmtUsd(n) { var u = util(); return u && u.fmt ? u.fmt.usd(n) : (isNum(n) ? '$' + Math.round(n) : '—'); }
  function fmtDate(iso, gran) { var u = util(); return u && u.fmt ? u.fmt.date(iso, gran) : String(iso); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + fmtInt(derived.n) + ' records' : '';
  }
  /**
   * One bold sentence for the header: customers at high or critical churn risk and the revenue at risk, with n.
   * @param {Object|null} derived
   * @param {Object|null} ct  predict.churnTable result (null before the body computes it)
   */
  function leadText(derived, ct) {
    if (!derived || !isNum(derived.n)) return 'Data is loading.';
    if (!derived.n) return 'No records in this range (n=0); widen the date range or clear a filter.';
    if (!ct || !Array.isArray(ct.rows)) return ct === null && !VOC.predict ? 'Churn scoring unavailable (n=' + fmtInt(derived.n) + ' records).' : 'Scoring cancellation risk for ' + fmtInt(derived.n) + ' records…';
    var rows = ct.rows;
    var risky = rows.filter(function (r) { var t = r.tier || tierOf(r.score); return t === 'high' || t === 'critical'; });
    var revenue = risky.reduce(function (a, r) { return a + (isNum(r.revenueAtRisk) ? r.revenueAtRisk : 0); }, 0);
    var nCust = isNum(ct.n) ? ct.n : rows.length;
    var method = ct.method === 'fitted' ? '' : '; heuristic risk scores';
    if (!rows.length) return 'No customers to score in this range (n=' + fmtInt(derived.n) + ' records' + method + ').';
    return fmtInt(risky.length) + ' of ' + fmtInt(nCust) + ' customers at high or critical churn risk' + (revenue > 0 ? '; ' + fmtUsd(revenue) + ' of subscription revenue at risk' : '') + ' (n=' + fmtInt(nCust) + ' customers' + method + ').';
  }
  function buildHeader(derived) {
    if (ui() && typeof ui().viewHeader === 'function') return ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived, null) });
    return h('header', { class: 'view-header' }, [h('h1', { class: 'view-title', text: TITLE }), h('p', { class: 'view-meta', 'data-role': 'subtitle', text: subtitle(derived) })]);
  }
  function setHeader(derived, ct) {
    var hd = state.header;
    if (!hd) return;
    if (hd.setMeta) hd.setMeta(subtitle(derived)); else { var sub = hd.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(derived); }
    if (hd.setLead) hd.setLead(leadText(derived, ct));
  }
  function drill(target) {
    var s = store();
    if (s && typeof s.drill === 'function') { s.drill(target); return; }
    if (VOC.router && typeof VOC.router.navigate === 'function') VOC.router.navigate(target.view || 'inbox', { id: target.id });
  }
  function customersMap() { var s = store(); return s && typeof s.customers === 'function' ? s.customers() : new Map(); }
  function practicesMap() { var s = store(); return s && typeof s.practices === 'function' ? s.practices() : new Map(); }
  function tierOf(score) {
    for (var i = 0; i < TIERS.length; i++) if (score >= TIERS[i].lo && score <= TIERS[i].hi) return TIERS[i].id;
    return score > 100 ? 'critical' : 'low';
  }

  /* ------------------------------------------------------------------ view state */

  var state = { root: null, header: null, body: null, derived: null, cards: [], gen: 0, riskTable: null, churn: null };

  function destroyCards() {
    state.cards.forEach(function (c) { if (c && typeof c.vocDestroy === 'function') { try { c.vocDestroy(); } catch (e) { /* already gone */ } } });
    state.cards = [];
  }
  function guarded(gen, fn) { return function (canvas) { if (gen !== state.gen) return null; return fn(canvas); }; }
  function card(opts) { var el = ui().chartCard(opts); state.cards.push(el); return el; }

  /**
   * Card shell for HTML renders (heatmap, tables) that mirrors chartCard's header: title, question, n, CSV, ƒ.
   * @param {{id:string, title:string, question?:string, n?:number, formula?:string, csv?:function():{columns,rows}, csvName?:string, footnote?:string}} opts
   * @returns {{el:HTMLElement, body:HTMLElement}}
   */
  function htmlCard(opts) {
    var el = h('section', { class: 'card html-card', dataset: { chart: opts.id } });
    var titles = h('div', {}, [h('h2', { class: 'card__title', text: opts.title })]);
    var q = [];
    if (opts.question) q.push(esc(opts.question));
    if (isNum(opts.n)) q.push('<span class="chart-card__n">n = ' + esc(fmtInt(opts.n)) + '</span>');
    if (q.length) titles.appendChild(h('p', { class: 'card__subtitle', html: q.join(' · ') }));
    var tools = h('div', { class: 'chart-card__tools' });
    if (typeof opts.csv === 'function' && ui().toCsv && ui().downloadText) {
      tools.appendChild(h('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': 'Download CSV of ' + opts.title,
        onclick: function () {
          var data = null; try { data = opts.csv(); } catch (e) { data = null; }
          if (!data || !data.rows || !data.rows.length) { if (ui().toast) ui().toast('No rows to export for this range.', 'warning'); return; }
          ui().downloadText(opts.csvName || ('lnutra-voc-' + opts.id + '.csv'), ui().toCsv(data), 'text/csv;charset=utf-8');
        }
      }, 'CSV'));
    }
    if (opts.formula) {
      tools.appendChild(h('button', {
        class: 'btn btn--f', type: 'button', 'aria-label': 'Formula for ' + opts.title, title: 'Formula',
        onclick: function (e) { if (ui().popover) ui().popover(e.currentTarget, '<div class="popover__title">' + esc(opts.title) + '</div><code class="formula">' + esc(opts.formula) + '</code>'); }
      }, 'ƒ'));
    }
    el.appendChild(h('div', { class: 'card__header' }, [titles, tools]));
    var body = h('div', { class: 'html-card__body' });
    el.appendChild(body);
    if (opts.footnote) el.appendChild(h('p', { class: 'chart-card__foot html-card__foot', text: opts.footnote }));
    return { el: el, body: body };
  }

  /* ------------------------------------------------------------------ restricted handling */

  function restrictedSet(derived) {
    var set = new Set();
    var redact = !derived.settings || derived.settings.redactRestricted !== false;
    if (!redact) return set;
    derived.records.forEach(function (r) { if (r.restricted && r.customer_id) set.add(r.customer_id); });
    customersMap().forEach(function (c, id) { if (c && c.restricted) set.add(id); });
    return set;
  }
  /** Display name, or null when the customer must be redacted (restrictedSet already honors settings.redactRestricted). */
  function customerName(customer, id, restricted) {
    if (restricted.has(id)) return null;
    return (customer && customer.display_name) || (customer && customer.email) || id;
  }

  /* ------------------------------------------------------------------ segment comparison */

  function segmentSection(derived, gen) {
    var A = VOC.analytics, C = charts();
    var rows = [];
    if (A && typeof A.segmentCompare === 'function') { try { rows = A.segmentCompare(derived.records, customersMap()) || []; } catch (e) { rows = []; } }
    rows = rows.filter(function (r) { return r.n > 0; });
    var section = h('section', { class: 'view-section customers-segments-section' });
    section.appendChild(h('h2', { class: 'section-title', text: 'Segments' }));
    if (!rows.length) {
      var empty = h('div', { class: 'card' });
      ui().emptyState(empty, { title: 'No records in this range', text: 'Widen the date range or clear a filter to compare segments.' });
      section.appendChild(empty);
      return section;
    }
    var p = C ? C.palette() : null;
    var labels = rows.map(function (r) { return label('segment', r.segment) + ' (n=' + fmtInt(r.n) + ')'; });
    var smallCount = rows.filter(function (r) { return r.n < SMALL_N; }).length;
    var grid = h('div', { class: 'customers-segments' });

    function metricCard(id, title, question, formula, key, unit, nKey) {
      var data = rows.map(function (r) { return isNum(r[key]) ? r[key] : null; });
      var colors = rows.map(function (r) { return p ? (r.n < SMALL_N ? p.other : p.series[0]) : undefined; });
      var spec = {
        labels: labels, xLabel: unit, datasets: [{ label: title, data: data, colors: colors }], percent: false,
        ariaLabel: title + ' by segment; grey bars mark segments with fewer than ' + SMALL_N + ' records',
        onClick: function (index) { var r = rows[index]; if (r) drill({ view: 'inbox', filters: { segment: [r.segment] } }); }
      };
      if (key === 'nps') { spec.yMin = -100; spec.yMax = 100; spec.diverging = true; spec.datasets[0].colors = colors; }
      var nTotal = rows.reduce(function (s, r) { return s + (isNum(r[nKey]) ? r[nKey] : 0); }, 0);
      return card({
        id: 'customers-seg-' + id, title: title, question: question, formula: formula, n: nTotal, height: Math.max(220, 40 + rows.length * 30),
        footnote: smallCount ? 'Grey bars: small n (fewer than ' + SMALL_N + ' records), read with caution.' : undefined,
        render: guarded(gen, function (canvas) { return C ? C.bar(canvas, spec) : null; }),
        table: function () {
          return { columns: [{ key: 'segment', label: 'Segment' }, { key: 'n', label: 'Records' }, { key: 'value', label: title }, { key: 'basis', label: 'Basis n' }, { key: 'note', label: 'Note' }],
            rows: rows.map(function (r) { return { segment: label('segment', r.segment), n: r.n, value: isNum(r[key]) ? Math.round(r[key] * 10) / 10 : null, basis: isNum(r[nKey]) ? r[nKey] : null, note: r.n < SMALL_N ? 'small n' : '' }; }) };
        },
        csvName: 'lnutra-voc-customers-segments-' + id + '.csv'
      });
    }
    grid.appendChild(metricCard('nps', 'NPS', 'Which segments recommend us?', '%9–10 − %0–6 among records carrying an NPS answer', 'nps', 'NPS (−100 to 100)', 'npsN'));
    grid.appendChild(metricCard('net-sentiment', 'Net sentiment', 'Where does tone run negative?', '%pos(s≥0.05) − %neg(s≤−0.05) among scored records', 'netSentiment', 'Net sentiment (pts)', 'n'));
    grid.appendChild(metricCard('repeat', 'Repeat contact rate', 'Who has to write twice?', 'customers with ≥2 threads in range ÷ customers with ≥1 × 100', 'repeatRate', '% of customers', 'customers'));
    section.appendChild(grid);
    return section;
  }

  /* ------------------------------------------------------------------ cancellation risk */

  function churnResult(derived) {
    var P = VOC.predict;
    if (!P || typeof P.churnTable !== 'function') return null;
    // One churn method for every view: the store's gated bundle (fitted logistic or heuristic) scores this table too.
    var s = store();
    var model = s && typeof s.churnModel === 'function' ? s.churnModel() : null;
    try { return P.churnTable(derived.records, customersMap(), { now: derived.now, top: 1e9, model: model || undefined }); } catch (e) { return null; }
  }
  function methodBadge(ct) {
    if (!ct) return h('span', { class: 'badge', text: 'Churn model unavailable' });
    var fitted = ct.method === 'fitted';
    var nLab = ct.params && ct.params.logistic ? ct.params.logistic.nLabelled : null;
    var text = fitted ? 'Fitted logistic (n=' + (isNum(nLab) ? fmtInt(nLab) : '?') + ' labelled, cross-validated AUC ' + (isNum(ct.auc) ? fmtNum(ct.auc, 2) : '—') + ')' : 'Heuristic risk score';
    var badge = h('span', { class: 'badge method-badge method-badge--' + (fitted ? 'fitted' : 'heuristic'), title: (ct.caveats || []).join(' ') || text }, [
      h('span', { class: 'method-badge__dot', 'aria-hidden': 'true' }), text
    ]);
    return badge;
  }
  function openCustomer(row, restricted) {
    var id = row.customerId;
    var c = row.customer || customersMap().get(id) || null;
    // The hash carries the customer_id only (store filter `customer`); the filter bar resolves the display name locally,
    // so no name or address ever lands in the URL. A restricted customer opens inside the restricted queue.
    if (restricted.has(id) || (c && c.restricted)) { drill({ view: 'inbox', filters: { restrictedQueue: true, search: '', customer: id } }); return; }
    drill({ view: 'inbox', filters: { search: '', customer: id } });
  }
  function riskSection(derived, ct) {
    var restricted = restrictedSet(derived);
    var section = h('section', { class: 'view-section customers-risk' });
    var header = h('div', { class: 'card__header customers-risk__header' }, [
      h('div', {}, [
        h('h2', { class: 'section-title customers-risk__title', text: 'Cancellation risk' }),
        h('p', { class: 'card__subtitle', html: ct
          ? esc('Customers with contact history ranked by risk score · showing top ' + fmtInt(Math.min(RISK_TABLE_ROWS, ct.rows.length))) + ' · <span class="chart-card__n">n = ' + esc(fmtInt(ct.n)) + ' customers</span>'
          : esc('Prediction module unavailable.') })
      ]),
      h('div', { class: 'customers-risk__badges' }, [methodBadge(ct), ct && ui().pill ? ui().pill('confidence', ct.confidence) : null])
    ]);
    section.appendChild(header);
    if (ct && ct.explanation) section.appendChild(h('p', { class: 'customers-risk__explain t-13 text-2', text: ct.explanation }));
    if (!ct || !ct.rows || !ct.rows.length) {
      var empty = h('div', { class: 'card' });
      ui().emptyState(empty, { title: ct ? 'No customers to score in this range' : 'Churn scoring unavailable', text: ct ? 'Risk features look at the last 30–90 days of each customer’s contact history; widen the range to include more customers.' : 'VOC.predict.churnTable is missing, so this table cannot be built.' });
      section.appendChild(empty);
      return section;
    }
    var rows = ct.rows.slice(0, RISK_TABLE_ROWS).map(function (r) {
      var c = r.customer || customersMap().get(r.customerId) || {};
      var name = customerName(c, r.customerId, restricted);
      return {
        id: r.customerId, customerId: r.customerId, customer: c, name: name, isRestricted: name === null,
        segment: c.segment || null, score: r.score, tier: r.tier || tierOf(r.score), reasons: r.reasons || [], lastContact: r.lastContact || null,
        subValue: isNum(c.subscription_value_12m_usd) ? c.subscription_value_12m_usd : null, revenueAtRisk: isNum(r.revenueAtRisk) ? r.revenueAtRisk : null, n: r.n
      };
    });
    var columns = [
      { key: 'name', label: 'Customer', width: 200, render: function (row) {
        var wrap = h('div', { class: 'customer-cell' });
        if (row.isRestricted) wrap.appendChild(h('span', { class: 'customer-cell__name muted', text: 'Restricted customer' }));
        else wrap.appendChild(h('span', { class: 'customer-cell__name', text: row.name }));
        wrap.appendChild(h('span', { class: 'customer-cell__meta muted t-12', text: fmtInt(row.n) + (row.n === 1 ? ' record' : ' records') + (row.customer.subscription_status && row.customer.subscription_status !== 'none' ? ' · ' + titleCase(row.customer.subscription_status) + ' subscription' : '') }));
        return wrap;
      }, sortValue: function (r) { return r.isRestricted ? 'zzz' : (r.name || ''); } },
      { key: 'segment', label: 'Segment', render: function (row) { return esc(label('segment', row.segment)); } },
      { key: 'score', label: 'Score', align: 'right', defaultDir: 'desc', render: function (row) {
        var wrap = h('span', { class: 'score-cell' }, [h('span', { class: 'score-cell__num', text: String(row.score) })]);
        if (ui().pill) wrap.appendChild(ui().pill('tier', row.tier));
        return wrap;
      } },
      { key: 'reasons', label: 'Reasons', sort: false, className: 'wrap', render: function (row) {
        if (!row.reasons.length) return '<span class="muted">No active signals</span>';
        var box = h('div', { class: 'reasons' });
        row.reasons.forEach(function (t) { box.appendChild(h('span', { class: 'tag', text: t })); });
        return box;
      } },
      { key: 'lastContact', label: 'Last contact', render: function (row) { return row.lastContact ? esc(fmtDate(row.lastContact)) : '—'; } },
      { key: 'subValue', label: 'Subscription (12m)', align: 'right', render: function (row) { return isNum(row.subValue) ? esc(fmtUsd(row.subValue)) : '<span class="muted">—</span>'; } },
      { key: 'revenueAtRisk', label: 'Revenue at risk', align: 'right', defaultDir: 'desc', render: function (row) { return isNum(row.revenueAtRisk) && row.revenueAtRisk > 0 ? esc(fmtUsd(row.revenueAtRisk)) : '<span class="muted">—</span>'; } },
      { key: 'open', label: 'Open', sort: false, width: 72, render: function (row) {
        return h('button', { class: 'btn btn--sm', type: 'button', 'aria-label': 'Open ' + (row.isRestricted ? 'the restricted queue' : row.name + ' in the Inbox'), onclick: function () { openCustomer(row, restricted); } }, 'Open');
      } }
    ];
    var table = ui().table({ columns: columns, rows: rows, pageSize: 25, sortKey: 'score', sortDir: 'desc', rowKey: function (r) { return r.customerId; },
      rowClass: function (r) { return r.tier === 'critical' ? 'is-critical' : null; }, onRowClick: function (row) { openCustomer(row, restricted); },
      emptyText: 'No customers to score in this range.' });
    state.riskTable = table;
    section.appendChild(table.el);
    var caveats = (ct.caveats || []).slice();
    caveats.push('Scores are probabilities of cancellation on a 0–100 scale (tiers: 0–24 low · 25–49 watch · 50–74 high · 75+ critical); they describe risk, not a decision.');
    section.appendChild(h('p', { class: 'customers-risk__caveats muted t-12', text: caveats.join(' ') }));
    return section;
  }

  /* ------------------------------------------------------------------ score histogram + reliability */

  function histogramCard(ct, gen) {
    var C = charts();
    var p = C ? C.palette() : null;
    var buckets = [];
    for (var b = 0; b < 10; b++) buckets.push({ label: b === 9 ? '90–100' : (b * 10) + '–' + (b * 10 + 9), lo: b * 10, hi: b === 9 ? 100 : b * 10 + 9, count: 0 });
    var rows = ct && ct.rows ? ct.rows : [];
    rows.forEach(function (r) { var i = Math.min(9, Math.max(0, Math.floor((isNum(r.score) ? r.score : 0) / 10))); buckets[i].count += 1; });
    var fitted = !!(ct && ct.method === 'fitted' && Array.isArray(ct.reliability) && ct.reliability.length);
    var spec = {
      labels: buckets.map(function (x) { return x.label; }), xLabel: 'Risk score', yLabel: 'Customers',
      datasets: [{ label: 'Customers', data: buckets.map(function (x) { return x.count; }), color: p ? p.series[0] : undefined }],
      annotations: [{ x: '50–59', label: 'high ≥ 50' }],
      ariaLabel: 'Histogram of cancellation-risk scores in buckets of ten, ' + fmtInt(rows.length) + ' customers'
    };
    return card({
      id: 'customers-risk-histogram', title: 'Risk score distribution', n: rows.length,
      question: fitted ? 'How are scores spread, and does the model’s probability match what happened?' : 'How are risk scores spread across customers?',
      formula: fitted ? 'histogram of scores in buckets of 10 · reliability: mean predicted vs observed cancellation share per decile of fitted probability' : 'histogram of heuristic scores in buckets of 10 (logit = −3 + Σ w·x, x = min(raw, cap) ÷ cap)',
      footnote: fitted ? 'Table view shows the reliability deciles (predicted vs observed cancellation share).' : 'Tiers: 0–24 low · 25–49 watch · 50–74 high · 75+ critical. Heuristic weights until enough labelled customers exist.',
      height: 260,
      render: guarded(gen, function (canvas) { return C && rows.length ? C.histogram(canvas, spec) : null; }),
      table: function () {
        if (fitted) {
          return { columns: [{ key: 'decile', label: 'Decile' }, { key: 'predicted', label: 'Predicted %' }, { key: 'observed', label: 'Observed %' }, { key: 'n', label: 'n' }],
            rows: ct.reliability.map(function (d) { return { decile: d.decile, predicted: isNum(d.predicted) ? Math.round(d.predicted * 1000) / 10 : null, observed: isNum(d.observed) ? Math.round(d.observed * 1000) / 10 : null, n: d.n }; }) };
        }
        return { columns: [{ key: 'label', label: 'Score' }, { key: 'count', label: 'Customers' }], rows: buckets.map(function (x) { return { label: x.label, count: x.count }; }) };
      },
      csvName: fitted ? 'lnutra-voc-customers-risk-reliability.csv' : 'lnutra-voc-customers-risk-histogram.csv'
    });
  }

  /* ------------------------------------------------------------------ cohorts */

  function cohortCard(derived) {
    var A = VOC.analytics, C = charts();
    var res = null;
    if (A && typeof A.cohorts === 'function') { try { res = A.cohorts(derived.records); } catch (e) { res = null; } }
    var cohorts = res && Array.isArray(res.cohorts) ? res.cohorts.filter(function (c) { return c.size > 0; }) : [];
    var customersN = cohorts.reduce(function (s, c) { return s + c.size; }, 0);
    var cols = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'];
    var shell = htmlCard({
      id: 'customers-cohorts', title: 'First-contact cohorts', n: customersN,
      question: 'Of the customers who first wrote in a month, how many wrote again k months later?',
      formula: 'retention[k] = customers in the cohort with any contact k months after first contact ÷ cohort size × 100 · M0 = 100 by definition · blank = not yet observable',
      footnote: 'Re-contact is a warning signal for support data: a customer who writes again usually has an unresolved problem, so darker cells later in a row are bad news, not loyalty.',
      csv: function () {
        var columns = [{ key: 'month', label: 'Cohort month' }, { key: 'size', label: 'Customers' }].concat(cols.map(function (c) { return { key: c, label: c + ' %' }; }));
        return { columns: columns, rows: cohorts.map(function (c) { var o = { month: c.month, size: c.size }; cols.forEach(function (k, i) { var v = c.retention[i]; o[k] = isNum(v) ? Math.round(v * 1000) / 10 : null; }); return o; }) };
      },
      csvName: 'lnutra-voc-customers-cohorts.csv'
    });
    if (!cohorts.length || !C || typeof C.heatmap !== 'function') {
      ui().emptyState(shell.body, { title: cohorts.length ? 'Heatmap unavailable' : 'No cohorts in this range', text: cohorts.length ? 'VOC.charts.heatmap is missing.' : 'Cohorts need customers with a first contact inside the range.' });
      return shell.el;
    }
    var matrix = cohorts.map(function (c) { return c.retention.map(function (v) { return isNum(v) ? Math.round(v * 100) : 0; }); });
    var rowLabels = cohorts.map(function (c) { return fmtDate(c.month).replace(/^(\w{3})\w* (\d{4})$/, '$1 $2') + ' (n=' + fmtInt(c.size) + ')'; });
    var box = h('div', { class: 'cohort-heatmap' });
    C.heatmap(box, matrix, {
      rowLabels: rowLabels, colLabels: cols, showValues: true, colLabelEvery: 1, ariaLabel: 'First-contact cohort re-contact heatmap',
      format: function (v, r, c) {
        var co = cohorts[r];
        var raw = co ? co.retention[c] : null;
        if (!isNum(raw)) return 'not yet observable';
        return fmtInt(v) + '% re-contacted (' + fmtInt(Math.round(raw * co.size)) + ' of ' + fmtInt(co.size) + ')';
      },
      onClick: function (r) {
        var co = cohorts[r]; if (!co) return;
        var u = util();
        if (!u) return;
        var from = co.month + '-01';
        var to = u.addDays(u.addMonths ? u.addMonths(co.month, 1) + '-01' : from, -1);
        drill({ view: 'inbox', filters: { range: { preset: 'custom', from: from, to: to } } });
      }
    });
    // cells that are not observable yet get a hatched look
    var cells = box.querySelectorAll('.voc-heatmap__cell');
    cohorts.forEach(function (co, r) {
      co.retention.forEach(function (v, c) {
        if (isNum(v)) return;
        var cell = cells[r * cols.length + c];
        if (cell) { cell.classList.add('is-unobserved'); cell.setAttribute('title', rowLabels[r] + ' ' + cols[c] + ' · not yet observable'); }
      });
    });
    shell.body.appendChild(box);
    return shell.el;
  }

  /* ------------------------------------------------------------------ HCP practice rollup */

  function hcpSection(derived) {
    var A = VOC.analytics;
    var rows = [];
    if (A && typeof A.hcpRollup === 'function') { try { rows = A.hcpRollup(derived.records, customersMap(), practicesMap()) || []; } catch (e) { rows = []; } }
    var totalRecords = rows.reduce(function (s, r) { return s + r.records; }, 0);
    var shell = htmlCard({
      id: 'customers-hcp', title: 'Practitioner practices', n: totalRecords,
      question: 'Which practices generate the most mail, and how does it read?',
      formula: 'records linked to a practice through the customer’s practice_id or a matching HCP code · negatives = sentiment label negative · NPS = %9–10 − %0–6 within the practice',
      csv: function () {
        return { columns: [{ key: 'name', label: 'Practice' }, { key: 'type', label: 'Type' }, { key: 'region', label: 'Region' }, { key: 'records', label: 'Records' }, { key: 'negatives', label: 'Negatives' }, { key: 'nps', label: 'NPS' }, { key: 'npsN', label: 'NPS n' }, { key: 'evidenceRequests', label: 'Evidence requests' }],
          rows: rows.map(function (r) { return { name: r.name, type: titleCase(r.type), region: label('region', r.region), records: r.records, negatives: r.negatives, nps: isNum(r.nps) ? Math.round(r.nps) : null, npsN: r.npsN, evidenceRequests: r.evidenceRequests }; }) };
      },
      csvName: 'lnutra-voc-customers-practices.csv',
      footnote: rows.length ? 'NPS per practice rests on very few surveys; the n beside it is the number of answers.' : undefined
    });
    if (!rows.length) {
      ui().emptyState(shell.body, { title: 'No practitioner mail in this range', text: 'Records link to a practice through the customer’s practice or an HCP code in the text.' });
      return shell.el;
    }
    var table = ui().table({
      columns: [
        { key: 'name', label: 'Practice', render: function (r) { return h('div', { class: 'customer-cell' }, [h('span', { class: 'customer-cell__name', text: r.name }), h('span', { class: 'customer-cell__meta muted t-12', text: [titleCase(r.type) || null, r.region ? label('region', r.region) : null].filter(Boolean).join(' · ') })]); } },
        { key: 'records', label: 'Records', align: 'right', defaultDir: 'desc' },
        { key: 'negatives', label: 'Negative', align: 'right', defaultDir: 'desc', render: function (r) { return esc(fmtInt(r.negatives)) + ' <span class="muted">(' + esc(fmtInt(r.records ? Math.round(r.negatives / r.records * 100) : 0)) + '%)</span>'; } },
        { key: 'nps', label: 'NPS', align: 'right', render: function (r) { return isNum(r.nps) ? esc(fmtInt(Math.round(r.nps))) + ' <span class="muted">(n=' + esc(fmtInt(r.npsN)) + ')</span>' : '<span class="muted">—</span>'; } },
        { key: 'evidenceRequests', label: 'Evidence requests', align: 'right', defaultDir: 'desc' }
      ],
      rows: rows, pageSize: 10, sortKey: 'records', sortDir: 'desc', rowKey: function (r) { return r.practice_id; }, flat: true,
      emptyText: 'No practitioner mail in this range.'
    });
    shell.body.appendChild(table.el);
    return shell.el;
  }

  /* ------------------------------------------------------------------ region bars */

  function regionCard(derived, gen) {
    var C = charts();
    var p = C ? C.palette() : null;
    var counts = new Map();
    derived.records.forEach(function (r) { var k = r.region || 'OTHER'; counts.set(k, (counts.get(k) || 0) + 1); });
    var rows = Array.from(counts.entries()).map(function (e) { return { id: e[0], label: label('region', e[0]), count: e[1], share: derived.n ? e[1] / derived.n * 100 : 0 }; })
      .sort(function (a, b) { return b.count - a.count; });
    var spec = {
      labels: rows.map(function (r) { return r.label; }), xLabel: 'Records',
      datasets: [{ label: 'Records', data: rows.map(function (r) { return r.count; }), color: p ? p.series[0] : undefined }],
      ariaLabel: 'Records by customer region, horizontal bars',
      onClick: function (index) { var r = rows[index]; if (r) drill({ view: 'inbox', filters: { region: [r.id] } }); }
    };
    return card({
      id: 'customers-region', title: 'Regions', n: derived.n, question: 'Where does the mail come from?', formula: 'count(records) by customer region',
      footnote: 'Click a bar to open that region in the Inbox.', height: Math.max(220, 40 + rows.length * 28),
      render: guarded(gen, function (canvas) { return C && rows.length ? C.bar(canvas, spec) : null; }),
      table: function () { return { columns: [{ key: 'label', label: 'Region' }, { key: 'count', label: 'Records' }, { key: 'share', label: 'Share %' }], rows: rows.map(function (r) { return { label: r.label, count: r.count, share: Math.round(r.share * 10) / 10 }; }) }; },
      csvName: 'lnutra-voc-customers-regions.csv'
    });
  }

  /* ------------------------------------------------------------------ body */

  function renderBody(derived) {
    destroyCards();
    state.gen += 1;
    var gen = state.gen;
    var body = state.body;
    body.innerHTML = '';
    state.riskTable = null;
    if (!derived || !derived.records) {
      ui().emptyState(body, { title: 'Data is still loading', text: 'The store has not published records yet.' });
      return;
    }
    if (!derived.n) {
      var none = h('div', { class: 'card' });
      ui().emptyState(none, { title: 'No records in this range', text: 'Widen the date range or clear a filter to see customer analytics.' });
      body.appendChild(none);
      return;
    }
    var ct = churnResult(derived);
    state.churn = ct;
    setHeader(derived, ct);

    body.appendChild(segmentSection(derived, gen));
    body.appendChild(riskSection(derived, ct));

    var mid = h('div', { class: 'customers-middle' });
    mid.appendChild(histogramCard(ct, gen));
    mid.appendChild(cohortCard(derived));
    body.appendChild(mid);

    var bottom = h('div', { class: 'customers-bottom' });
    bottom.appendChild(hcpSection(derived));
    bottom.appendChild(regionCard(derived, gen));
    body.appendChild(bottom);
  }

  /* ------------------------------------------------------------------ view contract */

  VOC.views[NAME] = {
    title: TITLE,
    icon: NAME,
    /**
     * @param {HTMLElement} root
     * @param {Object|null} derived  VOC.store.derived()
     */
    mount: function (root, derived) {
      state.root = root;
      state.derived = derived;
      root.innerHTML = '';
      state.header = buildHeader(derived);
      root.appendChild(state.header);
      state.body = h('div', { class: 'customers-body', 'data-role': 'body' });
      root.appendChild(state.body);
      if (!ui()) { root.textContent = 'UI kit unavailable.'; return; }
      renderBody(derived);
    },
    /** @param {Object|null} derived */
    update: function (derived) {
      if (!state.root || !state.body) return;
      state.derived = derived;
      setHeader(derived, null);
      renderBody(derived);
    },
    unmount: function () {
      destroyCards();
      state.gen += 1;
      state.root = null; state.header = null; state.body = null; state.derived = null; state.riskTable = null; state.churn = null;
    }
  };
})();
