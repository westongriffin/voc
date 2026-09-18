/* L-Nutra · Voice of the Customer — Alerts view (SPEC §5 item 9)
 * Active alerts grouped by severity (Ack / Snooze 24h / Show me), rules with enable toggles and threshold inputs
 * (edits re-evaluate through the store), and a paginated history. Touches the DOM only inside mount/update/unmount.
 */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'alerts';
  var TITLE = 'Alerts';
  var SEVERITIES = ['critical', 'warning', 'info'];
  var STEP_BY_UNIT = { z: 0.5, 'pts / 12 weeks': 1, 'records / 24h': 1, records: 1 };
  var EXPLAIN = 'Daily volume and negative-share z-scores against a 28-day, weekday-adjusted baseline; emerging units ' +
    '(a category, subcategory, product, kit component, lot or bigram whose 7-day count outruns the prior 28 days, Poisson surprise); 12-week sentiment drift ' +
    '(OLS slope on weekly index means); P1 clusters (several P1 reports of one subcategory inside 24 hours); regulatory events (open serious adverse events ' +
    'on the MedWatch 15-business-day clock, open food-safety reports on the 24-hour RFR clock) and open records past their first-response SLA. ' +
    'Rules re-run on every filter change over the records in range.';

  /* ------------------------------------------------------------------ helpers */

  function U() { return VOC.util || null; }
  function ui() { return VOC.ui || null; }
  function store() { return VOC.store || null; }
  function AL() { return VOC.alerts || null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function round(x, d) { var m = Math.pow(10, d || 0); return Math.round(x * m) / m; }

  function esc(s) {
    var u = U();
    if (u && typeof u.escapeHtml === 'function') return u.escapeHtml(s == null ? '' : String(s));
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
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
  function fmtInt(n) { var u = U(); return u ? u.fmt.int(n) : (isNum(n) ? String(Math.round(n)) : '—'); }
  function fmtNum(n, d) { var u = U(); return u ? u.fmt.num(n, d || 0) : (isNum(n) ? String(round(n, d || 0)) : '—'); }
  function fmtDate(iso, gran) { var u = U(); return u ? u.fmt.date(iso, gran || 'day') : String(iso || '—'); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + fmtInt(derived.n) + ' records' : '';
  }
  /**
   * One bold sentence for the header: active alerts by severity, with n records in range.
   * @param {Object|null} derived
   * @param {Array} [active]  the active list when renderActive already filtered it
   */
  function leadText(derived, active) {
    if (!derived || !Array.isArray(derived.records)) return 'Data is loading.';
    var list = active || arr(derived.alerts).filter(function (a) { return !a.acked && !a.snoozedUntil; });
    var n = ' (n=' + fmtInt(derived.records.length) + ' records in range)';
    if (!list.length) return 'No active alerts' + n + '.';
    var by = SEVERITIES.map(function (sev) { var k = list.filter(function (a) { return a.severity === sev; }).length; return k ? fmtInt(k) + ' ' + sev : null; }).filter(Boolean);
    return fmtInt(list.length) + ' active alert' + (list.length === 1 ? '' : 's') + ': ' + by.join(', ') + n + '.';
  }
  function toast(msg, kind, opts) { if (ui() && ui().toast) ui().toast(msg, kind || 'info', opts); }
  function drill(target) {
    var s = store();
    if (s && typeof s.drill === 'function') { s.drill(target); return; }
    if (VOC.router && typeof VOC.router.navigate === 'function') VOC.router.navigate(target.view, { id: target.id });
  }
  function emptyInto(el, opts) {
    if (ui() && ui().emptyState) { ui().emptyState(el, opts); return; }
    el.innerHTML = '<div class="empty-state"><div class="empty-state__title">' + esc(opts.title) + '</div>' + (opts.text ? '<p class="empty-state__text">' + esc(opts.text) + '</p>' : '') + '</div>';
  }
  function pill(kind, value) {
    if (ui() && typeof ui().pill === 'function') return ui().pill(kind, value);
    return h('span', { class: 'pill pill--' + kind + ' pill--' + esc(value) }, String(value));
  }
  function sparkInto(el, values) {
    var c = VOC.charts;
    if (c && typeof c.sparkline === 'function' && arr(values).filter(isNum).length >= 2) { try { c.sparkline(el, values, { width: 96, height: 22 }); } catch (e) { el.innerHTML = ''; } }
  }
  function rulesList() { var a = AL(); return a && typeof a.rules === 'function' ? arr(a.rules()) : []; }
  function ruleById(id) { return rulesList().filter(function (r) { return r.id === id; })[0] || null; }

  /**
   * Ask the store to recompute derived state (and therefore alerts) after a rule edit.
   * setFilters({}) clears the memo and emits 'filtered', which makes the app call update() with fresh alerts.
   */
  function reevaluate(S) {
    var s = store();
    if (s && typeof s.setFilters === 'function') { s.setFilters({}); return; }
    if (AL() && typeof AL().evaluate === 'function' && S.derived) {
      try { S.derived.alerts = AL().evaluate(S.derived, { predict: VOC.predict }); } catch (e) { /* keep old */ }
      renderAll(S.derived);
    }
  }

  /* ------------------------------------------------------------------ active alerts */

  function alertSpark(a, d) {
    if (arr(a.spark).filter(isNum).length >= 2) return a.spark;
    var days = arr(d.byDay).slice(-28);
    if (a.ruleId === 'volume_zscore') return days.map(function (p) { return p.count; });
    if (a.ruleId === 'neg_share_zscore') return days.map(function (p) { var s = p.neg + p.pos + p.neu; return s ? round(p.neg / s * 100, 1) : null; });
    if (a.ruleId === 'sentiment_drift') return arr(d.byWeek).filter(function (w) { return isNum(w.meanSentiment); }).slice(-12).map(function (w) { return round((w.meanSentiment + 1) / 2 * 100, 1); });
    return null;
  }
  function alertRow(S, d, a, opts) {
    opts = opts || {};
    var rule = ruleById(a.ruleId);
    var body = h('div', { class: 'alert-row__body' }, [
      h('div', { class: 'alert-row__title', text: a.title || '' }),
      a.detail ? h('div', { class: 'alert-row__detail', text: a.detail }) : null
    ]);
    var meta = h('div', { class: 'alert-row__meta' }, [
      h('span', { class: 'alert-row__when', title: 'When (Central Time)' }, fmtDate(a.at, 'datetime')),
      h('span', { class: 'alert-row__rule' }, rule ? rule.label : String(a.ruleId || '')),
      isNum(a.n) ? h('span', { class: 'alert-row__n' }, 'n = ' + fmtInt(a.n)) : null,
      a.snoozedUntil ? h('span', { class: 'alert-row__state' }, 'snoozed until ' + fmtDate(a.snoozedUntil, 'datetime')) : null,
      a.acked && !a.snoozedUntil ? h('span', { class: 'alert-row__state' }, 'acknowledged') : null
    ]);
    var sparkVals = alertSpark(a, d);
    if (sparkVals) { var sp = h('span', { class: 'alert-row__spark', 'aria-hidden': 'true' }); sparkInto(sp, sparkVals); meta.appendChild(sp); }
    body.appendChild(meta);

    var actions = h('div', { class: 'alert-row__actions' });
    if (!opts.inactive) {
      actions.appendChild(h('button', {
        class: 'btn btn--ghost btn--xs', type: 'button', 'aria-label': 'Acknowledge: ' + (a.title || ''),
        onclick: function () {
          var al = AL();
          if (!al || typeof al.ack !== 'function') return;
          al.ack(a.id);
          S.hidden[a.id] = 'acked';
          renderActive(S, S.derived);
          toast('Alert acknowledged.', 'good', { undo: function () { if (al.unack) al.unack(a.id); delete S.hidden[a.id]; renderActive(S, S.derived); } });
        }
      }, 'Ack'));
      actions.appendChild(h('button', {
        class: 'btn btn--ghost btn--xs', type: 'button', 'aria-label': 'Snooze 24 hours: ' + (a.title || ''),
        onclick: function () {
          var al = AL();
          if (!al || typeof al.snooze !== 'function') return;
          var until = al.snooze(a.id, 24);
          S.hidden[a.id] = 'snoozed';
          renderActive(S, S.derived);
          toast('Snoozed until ' + (until ? fmtDate(until, 'datetime') : 'tomorrow') + '.', 'info');
        }
      }, 'Snooze 24h'));
    } else if (a.acked && !a.snoozedUntil) {
      actions.appendChild(h('button', {
        class: 'btn btn--ghost btn--xs', type: 'button', 'aria-label': 'Un-acknowledge: ' + (a.title || ''),
        onclick: function () { var al = AL(); if (al && al.unack) al.unack(a.id); delete S.hidden[a.id]; a.acked = false; renderActive(S, S.derived); }
      }, 'Unack'));
    }
    if (a.drill) actions.appendChild(h('button', { class: 'btn btn--link btn--xs', type: 'button', onclick: function () { drill(a.drill); } }, 'Show me →'));

    return h('article', { class: 'alert-row alert-row--' + esc(a.severity || 'info') + (opts.inactive ? ' is-acked' : ''), dataset: { alert: a.id } }, [pill('severity', a.severity), body, actions]);
  }
  function renderActive(S, d) {
    var host = S.els.active;
    host.innerHTML = '';
    var all = arr(d.alerts);
    var active = all.filter(function (a) { return !a.acked && !a.snoozedUntil && !S.hidden[a.id]; });
    var inactive = all.filter(function (a) { return a.acked || a.snoozedUntil || S.hidden[a.id]; });
    var count = S.els.activeCount;
    if (count) count.textContent = active.length ? fmtInt(active.length) + ' active' : 'none active';
    if (S.els.header && S.els.header.setLead) S.els.header.setLead(leadText(d, active));

    if (!AL()) {
      emptyInto(host, { title: 'Alerts module missing', text: 'alerts.js did not load, so no rules were evaluated.' });
      return;
    }
    if (!active.length) {
      emptyInto(host, { title: 'No active alerts — all quiet', text: 'Rules re-run on every filter change. Statistical rules need at least 14 days in range, so pick 30d or longer to score spikes and drift.', icon: 'check', kind: 'good' });
    } else {
      var groups = h('div', { class: 'alert-groups' });
      SEVERITIES.forEach(function (sev) {
        var items = active.filter(function (a) { return a.severity === sev; });
        if (!items.length) return;
        var list = h('div', { class: 'alert-list' });
        items.forEach(function (a) { list.appendChild(alertRow(S, d, a)); });
        groups.appendChild(h('section', { class: 'alert-group alert-group--' + sev, 'aria-label': sev + ' alerts' }, [
          h('h3', { class: 'alert-group__title' }, [pill('severity', sev), h('span', {}, fmtInt(items.length) + (items.length === 1 ? ' alert' : ' alerts'))]),
          list
        ]));
      });
      host.appendChild(groups);
    }
    if (inactive.length) {
      var details = h('details', { class: 'alerts-acked', open: S.ackedOpen ? true : null });
      details.addEventListener('toggle', function () { S.ackedOpen = details.open; });
      details.appendChild(h('summary', {}, 'Acknowledged or snoozed (' + fmtInt(inactive.length) + ')'));
      var list2 = h('div', { class: 'alert-list' });
      inactive.forEach(function (a) {
        var copy = Object.assign({}, a);
        if (S.hidden[a.id] === 'acked') copy.acked = true;
        list2.appendChild(alertRow(S, d, copy, { inactive: true }));
      });
      details.appendChild(list2);
      host.appendChild(details);
    }
  }

  /* ------------------------------------------------------------------ rules */

  function ruleRow(S, d, rule) {
    var activeCount = arr(d.alerts).filter(function (a) { return a.ruleId === rule.id && !a.acked && !a.snoozedUntil; }).length;
    var toggleId = 'rule-toggle-' + rule.id;
    var input = h('input', { type: 'checkbox', id: toggleId, checked: rule.enabled ? true : null, 'aria-label': 'Enable rule: ' + rule.label });
    input.addEventListener('change', function () {
      var al = AL();
      if (!al || typeof al.setRule !== 'function') return;
      al.setRule(rule.id, { enabled: input.checked });
      toast('Rule "' + rule.label + '" ' + (input.checked ? 'enabled' : 'disabled') + '; alerts re-evaluated.', 'info');
      reevaluate(S);
    });
    var toggle = h('label', { class: 'switch', for: toggleId }, [input, h('span', { class: 'switch__track', 'aria-hidden': 'true' })]);

    var step = STEP_BY_UNIT[rule.unit] || 1;
    var thr = h('input', {
      class: 'input input--sm rule-row__input', type: 'number', step: String(step), value: String(rule.threshold),
      'aria-label': 'Threshold for ' + rule.label + (rule.unit ? ' (' + rule.unit + ')' : ''), inputmode: 'decimal'
    });
    function commit() {
      var v = parseFloat(thr.value);
      if (!isNum(v)) { thr.value = String(rule.threshold); return; }
      if (v === rule.threshold) return;
      var al = AL();
      if (!al || typeof al.setRule !== 'function') return;
      al.setRule(rule.id, { threshold: v });
      toast('Threshold for "' + rule.label + '" set to ' + fmtNum(v, step < 1 ? 1 : 0) + (rule.unit ? ' ' + rule.unit : '') + '; alerts re-evaluated.', 'info');
      reevaluate(S);
    }
    thr.addEventListener('change', commit);
    thr.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); thr.blur(); } });

    return h('div', { class: 'rule-row' + (rule.enabled ? '' : ' is-disabled'), dataset: { rule: rule.id } }, [
      toggle,
      h('div', { class: 'rule-row__text' }, [
        h('div', { class: 'rule-row__label' }, [rule.label, ' ', h('code', { class: 'rule-row__type' }, rule.type)]),
        rule.detail ? h('div', { class: 'rule-row__detail', text: rule.detail }) : null
      ]),
      h('div', { class: 'rule-row__threshold' }, [thr, rule.unit ? h('span', { class: 'rule-row__unit' }, rule.unit) : null]),
      h('div', { class: 'rule-row__count', title: 'Active alerts from this rule' }, rule.enabled ? fmtInt(activeCount) : '—')
    ]);
  }
  function renderRules(S, d) {
    var host = S.els.rules;
    host.innerHTML = '';
    var rules = rulesList();
    if (!rules.length) { emptyInto(host, { title: 'No rules available', text: 'alerts.js did not load.' }); return; }
    host.appendChild(h('div', { class: 'rule-row rule-row--head', 'aria-hidden': 'true' }, [
      h('span', {}, 'On'), h('span', {}, 'Rule'), h('span', {}, 'Threshold'), h('span', { class: 'rule-row__count' }, 'Active')
    ]));
    rules.forEach(function (r) { host.appendChild(ruleRow(S, d, r)); });
    host.appendChild(h('p', { class: 'rules-foot' }, 'Thresholds and toggles persist in this browser. Restore defaults from Settings → Reset demo data.'));
  }

  /* ------------------------------------------------------------------ history */

  function historyRows() {
    var al = AL();
    var rows = al && typeof al.history === 'function' ? arr(al.history()) : [];
    var labels = {};
    rulesList().forEach(function (r) { labels[r.id] = r.label; });
    return rows.map(function (hRow) {
      return { id: hRow.id, first_seen: hRow.first_seen || hRow.at || '', last_seen: hRow.last_seen || '', severity: hRow.severity, title: hRow.title, rule: labels[hRow.ruleId] || hRow.ruleId || '' };
    });
  }
  function renderHistory(S, d) {
    var host = S.els.history;
    var rows = historyRows();
    var sub = S.els.historyCount;
    if (sub) sub.textContent = rows.length ? fmtInt(rows.length) + ' recorded · newest first · 50 per page' : '';
    if (!ui() || typeof ui().table !== 'function') {
      host.innerHTML = '';
      if (!rows.length) { emptyInto(host, { title: 'No alerts recorded yet', text: 'Every alert seen by the evaluator is appended here.' }); return; }
      var ul = h('ul', { class: 'history-fallback' });
      rows.slice(0, 50).forEach(function (r) { ul.appendChild(h('li', {}, fmtDate(r.first_seen, 'datetime') + ' · ' + r.severity + ' · ' + r.title)); });
      host.appendChild(ul);
      return;
    }
    if (S.historyTable) { S.historyTable.update(rows, { keepPage: true }); return; }
    host.innerHTML = '';
    S.historyTable = ui().table({
      columns: [
        { key: 'first_seen', label: 'First seen (CT)', sort: true, render: function (row, v) { return esc(fmtDate(v, 'datetime')); } },
        { key: 'severity', label: 'Severity', sort: true, render: function (row, v) { return pill('severity', v); } },
        { key: 'title', label: 'Alert', sort: true, className: 'wrap', width: '40%' },
        { key: 'rule', label: 'Rule', sort: true, className: 'wrap' },
        { key: 'last_seen', label: 'Last seen (CT)', sort: true, render: function (row, v) { return esc(fmtDate(v, 'datetime')); } }
      ],
      rows: rows, pageSize: 50, sortKey: 'first_seen', sortDir: 'desc',
      rowKey: function (r) { return r.id; },
      emptyText: 'No alerts recorded yet — every alert the evaluator sees is appended here.',
      onRowClick: function (row) {
        var live = arr(S.derived && S.derived.alerts).filter(function (a) { return a.id === row.id; })[0];
        if (live && live.drill) drill(live.drill);
        else toast('This alert is not active for the current filters, so there is nothing to open.', 'info');
      }
    });
    host.appendChild(S.historyTable.el);
  }

  /* ------------------------------------------------------------------ view */

  var S = null;

  function renderAll(d) {
    if (!S) return;
    d = d || {};
    S.derived = d;
    if (S.els.header && S.els.header.setMeta) S.els.header.setMeta(subtitle(d));
    else { var sub = S.root.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(d); }
    renderActive(S, d);
    renderRules(S, d);
    renderHistory(S, d);
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
      S = { root: root, els: {}, hidden: {}, derived: null, historyTable: null, ackedOpen: false };
      var methodsLink = h('a', { class: 'btn btn--ghost btn--sm', href: '#/methods' }, 'Methods →');
      var header = ui() && typeof ui().viewHeader === 'function'
        ? ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived), actions: [methodsLink] })
        : h('header', { class: 'view-header' }, [h('h1', { class: 'view-title' }, TITLE), h('p', { class: 'view-meta', 'data-role': 'subtitle' }, subtitle(derived)), h('div', { class: 'view-actions' }, [methodsLink])]);
      S.els.header = header;
      // The rule explanations sit in a collapsed block under the header (the top of the view is never a paragraph).
      var explainBody = h('p', { class: 'alerts-explain' }, [EXPLAIN, ' ', h('a', { href: '#/methods' }, 'Read the methods →')]);
      var explain = ui() && typeof ui().howDetails === 'function'
        ? ui().howDetails({ summary: 'How this works: how alerts are computed', body: explainBody })
        : h('details', { class: 'how' }, [h('summary', { class: 'how__summary', text: 'How this works: how alerts are computed' }), h('div', { class: 'how__body' }, [explainBody])]);

      S.els.activeCount = h('span', { class: 'section-count' });
      S.els.active = h('div', { class: 'alerts-active' });
      var activeSection = h('section', { class: 'view-section', 'aria-labelledby': 'alerts-active-title' }, [
        h('h2', { class: 'section-title', id: 'alerts-active-title' }, ['Active ', S.els.activeCount]),
        S.els.active
      ]);

      S.els.rules = h('div', { class: 'rules-grid' });
      var rulesCard = h('section', { class: 'card', 'aria-labelledby': 'alerts-rules-title' }, [
        h('div', { class: 'card__header' }, [h('div', {}, [h('h2', { class: 'card__title', id: 'alerts-rules-title' }, 'Rules'), h('p', { class: 'card__subtitle' }, 'Toggle a rule or edit its threshold; alerts re-evaluate immediately.')])]),
        S.els.rules
      ]);
      S.els.historyCount = h('p', { class: 'card__subtitle' });
      S.els.history = h('div', { class: 'alerts-history' });
      var historyCard = h('section', { class: 'card', 'aria-labelledby': 'alerts-history-title' }, [
        h('div', { class: 'card__header' }, [h('div', {}, [h('h2', { class: 'card__title', id: 'alerts-history-title' }, 'History'), S.els.historyCount])]),
        S.els.history
      ]);
      var layout = h('div', { class: 'alerts-layout view-section' }, [rulesCard, historyCard]);

      [header, explain, activeSection, layout].forEach(function (el) { root.appendChild(el); });
      if (!derived) {
        emptyInto(S.els.active, { title: 'Data is loading', text: 'The store has not finished initializing; alerts appear as soon as it is ready.' });
        renderRules(S, {});
        renderHistory(S, {});
        return;
      }
      renderAll(derived);
    },
    /** @param {Object|null} derived */
    update: function (derived) {
      if (!S || !S.root || !S.root.isConnected || !derived) return;
      renderAll(derived);
    },
    unmount: function () {
      if (!S) return;
      if (ui() && ui().closePopover) { try { ui().closePopover(); } catch (e) { /* none open */ } }
      S = null;
    }
  };
})();
