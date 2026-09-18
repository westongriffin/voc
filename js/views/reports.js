/* L-Nutra · Voice of the Customer — Reports view (SPEC §5 item 10)
 * Weekly / monthly report preview (VOC.report), carried-forward actions (settings.reportActions), print, save to the
 * sidecar, CSV / JSON export, restore from a backup, and the data-quality panel (derived.dq). Touches the DOM only
 * inside mount/update/unmount so the file parses and runs silently under jsc.
 */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'reports';
  var TITLE = 'Reports';
  var UPDATE_DEBOUNCE_MS = 300;

  /* ------------------------------------------------------------------ */
  /* Small helpers (module-safe; no DOM at load time)                    */
  /* ------------------------------------------------------------------ */

  function U() { return VOC.util || null; }
  function ui() { return VOC.ui || null; }
  function store() { return VOC.store || null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }

  function esc(s) {
    if (ui() && ui().esc) return ui().esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function h(tag, attrs, children) {
    if (ui() && typeof ui().h === 'function') return ui().h(tag, attrs, children);
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'class') el.className = v;
      else if (typeof v === 'function' && /^on/.test(k)) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function toast(msg, kind, opts) { if (ui() && ui().toast) ui().toast(msg, kind || 'info', opts); }
  function fmtInt(n) { var u = U(); return u ? u.fmt.int(n) : (isNum(n) ? String(Math.round(n)) : '—'); }
  function fmtPct01(p) { var u = U(); return u ? u.fmt.pct(p, Math.abs(p) < 0.1 && p !== 0 ? 1 : 0) : (isNum(p) ? Math.round(p * 100) + '%' : '—'); }
  function fmtDate(iso, gran) { var u = U(); return u ? u.fmt.date(iso, gran || 'day') : String(iso || '—'); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && typeof derived.n === 'number' ? 'n = ' + derived.n + ' records' : '';
  }
  function nowDate() {
    var s = store();
    if (s && typeof s.now === 'function') { try { var d = s.now(); if (d instanceof Date && !isNaN(d.getTime())) return d; } catch (e) { /* fall through */ } }
    return new Date();
  }
  function dayKey(d) { var u = U(); return u ? u.dayKey(d instanceof Date ? d.toISOString() : d) : String(d).slice(0, 10); }
  function addDays(day, n) {
    var u = U();
    if (u) return u.addDays(day, n);
    return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  }
  function dowOf(day) {
    var u = U();
    if (u) { var p = u.parts(day); return p ? p.dow : null; }
    return (new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7;
  }
  /** Last Sunday strictly before `nowD` (CT day keys; dow 0 = Monday, 6 = Sunday). */
  function lastSundayBefore(nowD) {
    var today = dayKey(nowD);
    var dow = dowOf(today);
    var back = dow === null ? 7 : (dow === 6 ? 7 : dow + 1);
    return addDays(today, -back);
  }
  function monthKeyOf(day) { return String(day).slice(0, 7); }
  function addMonths(key, n) {
    var u = U();
    if (u && typeof u.addMonths === 'function') return u.addMonths(key, n);
    var y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + (m + 1 < 10 ? '0' : '') + (m + 1);
  }
  function daysInMonth(key) {
    var u = U();
    if (u && typeof u.daysInMonth === 'function') return u.daysInMonth(key);
    return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();
  }
  function settingsOf() {
    var s = store();
    if (s && typeof s.settings === 'function') { try { return s.settings() || {}; } catch (e) { return {}; } }
    return {};
  }
  function uid(prefix) {
    var u = U();
    if (u && typeof u.uid === 'function') return u.uid(prefix);
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
  }
  function download(filename, text, mime) {
    var ex = VOC.exporter;
    if (ex && typeof ex.downloadText === 'function') return ex.downloadText(filename, text, mime);
    if (ui() && typeof ui().downloadText === 'function') return Promise.resolve(ui().downloadText(filename, text, mime));
    return Promise.resolve('failed');
  }
  function exportName(view, ext) {
    var ex = VOC.exporter;
    if (ex && typeof ex.filename === 'function') return ex.filename(view, ext || 'csv');
    return 'lnutra-voc-' + view + '.' + (ext || 'csv');
  }

  /* ------------------------------------------------------------------ */
  /* Actions carried forward (persisted in settings.reportActions)        */
  /* ------------------------------------------------------------------ */

  function loadActions() {
    var list = settingsOf().reportActions;
    return arr(list).filter(function (a) { return a && typeof a === 'object' && a.text; }).map(function (a) {
      return { id: a.id || uid('act'), text: String(a.text), owner: a.owner || '', due: a.due || '', done: !!a.done, doneAt: a.doneAt || null, createdAt: a.createdAt || null };
    });
  }
  function saveActions(list) {
    var s = store();
    if (s && typeof s.setSettings === 'function') s.setSettings({ reportActions: list.map(function (a) { return Object.assign({}, a); }) });
  }
  /** Actions for the report: open items first, then items completed inside the current period. */
  function actionsForReport(list, periodFrom) {
    return list.filter(function (a) { return !a.done || (a.doneAt && (!periodFrom || a.doneAt.slice(0, 10) >= periodFrom)); })
      .map(function (a) { return { text: a.text, owner: a.owner || null, due: a.due || null, status: a.done ? 'done' : 'open' }; });
  }

  /* ------------------------------------------------------------------ */
  /* View state                                                          */
  /* ------------------------------------------------------------------ */

  var st = {
    root: null, derived: null,
    kind: 'weekly', weekEnding: null, month: null, align: true,
    actions: [], editingId: null,
    generated: false, html: '', lastPeriod: null,
    updateTimer: null, printClassTimer: null,
    els: {}
  };

  function periodFor(kind) {
    if (kind === 'weekly') {
      var to = st.weekEnding || lastSundayBefore(nowDate());
      return { from: addDays(to, -6), to: to, label: 'Week ending ' + fmtDate(to) };
    }
    var m = st.month || monthKeyOf(dayKey(nowDate()));
    var dim = daysInMonth(m);
    return { from: m + '-01', to: m + '-' + (dim < 10 ? '0' : '') + dim, label: fmtDate(m, 'month') };
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function renderControls() {
    var card = h('section', { class: 'card reports-controls', 'aria-labelledby': 'reports-controls-title' });
    card.appendChild(h('div', { class: 'card__header' }, h('h2', { class: 'card__title', id: 'reports-controls-title', text: 'Generate a report' })));

    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Report type', id: 'report-type' });
    var btnWeekly = h('button', { type: 'button', id: 'report-type-weekly', 'aria-pressed': String(st.kind === 'weekly') }, 'Weekly');
    var btnMonthly = h('button', { type: 'button', id: 'report-type-monthly', 'aria-pressed': String(st.kind === 'monthly') }, 'Monthly');
    seg.appendChild(btnWeekly); seg.appendChild(btnMonthly);
    card.appendChild(h('div', { class: 'field' }, [h('span', { class: 'label', text: 'Report type' }), seg]));

    var weekField = h('div', { class: 'field', id: 'report-week-field' }, [
      h('label', { class: 'label', for: 'report-week-ending', text: 'Week ending (Sunday)' }),
      h('input', { type: 'date', id: 'report-week-ending', class: 'input', value: st.weekEnding || '' }),
      h('span', { class: 'field__hint', text: 'Defaults to the last Sunday before the as-of date.' })
    ]);
    var monthSel = h('select', { id: 'report-month' });
    var cur = monthKeyOf(dayKey(nowDate()));
    for (var i = 0; i < 14; i++) {
      var k = addMonths(cur, -i);
      monthSel.appendChild(h('option', { value: k, selected: k === st.month ? true : null }, fmtDate(k, 'month')));
    }
    var monthField = h('div', { class: 'field', id: 'report-month-field' }, [h('label', { class: 'label', for: 'report-month', text: 'Month' }), monthSel]);
    card.appendChild(weekField); card.appendChild(monthField);

    var alignBox = h('input', { type: 'checkbox', id: 'report-align-range' });
    alignBox.checked = st.align;
    card.appendChild(h('label', { class: 'checkbox-row', for: 'report-align-range' }, [alignBox, h('span', { text: 'Set the global date range to this period' })]));
    card.appendChild(h('p', { class: 'field__hint', id: 'report-period-hint' }));

    var gen = h('button', { type: 'button', class: 'btn btn--primary', id: 'report-generate' }, 'Generate');
    card.appendChild(h('div', { class: 'row mt-2' }, gen));

    function setKind(k) {
      st.kind = k;
      btnWeekly.setAttribute('aria-pressed', String(k === 'weekly'));
      btnMonthly.setAttribute('aria-pressed', String(k === 'monthly'));
      weekField.hidden = k !== 'weekly';
      monthField.hidden = k !== 'monthly';
      refreshPeriodHint();
    }
    btnWeekly.addEventListener('click', function () { setKind('weekly'); });
    btnMonthly.addEventListener('click', function () { setKind('monthly'); });
    weekField.querySelector('input').addEventListener('change', function (e) {
      var v = e.target.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        var dow = dowOf(v);
        if (dow !== null && dow !== 6) { var snapped = addDays(v, 6 - dow); e.target.value = snapped; toast('Snapped to the following Sunday, ' + fmtDate(snapped) + '.', 'info', { ms: 3500 }); v = snapped; }
        st.weekEnding = v;
      } else st.weekEnding = null;
      refreshPeriodHint();
    });
    monthSel.addEventListener('change', function () { st.month = monthSel.value; refreshPeriodHint(); });
    alignBox.addEventListener('change', function () { st.align = alignBox.checked; });
    gen.addEventListener('click', function () { generate(true); });
    st.els.periodHint = card.querySelector('#report-period-hint');
    setKind(st.kind);
    return card;
  }

  function refreshPeriodHint() {
    setHeader(st.derived);
    if (!st.els.periodHint) return;
    var p = periodFor(st.kind);
    var u = U();
    st.els.periodHint.textContent = p.label + ' · ' + (u ? u.fmt.range(p.from, p.to) : p.from + ' – ' + p.to) + '.';
  }
  /** One bold sentence for the header: the selected report and period, with n under the current filters. */
  function leadText(derived) {
    var p = periodFor(st.kind);
    var u = U();
    var span = u ? u.fmt.range(p.from, p.to) : p.from + ' – ' + p.to;
    var n = derived && typeof derived.n === 'number' ? derived.n : null;
    var period = st.kind === 'weekly' ? 'the week ending ' + fmtDate(p.to) : fmtDate(p.from, 'month');
    return (st.kind === 'weekly' ? 'Weekly' : 'Monthly') + ' report for ' + period + ' (' + span + '); the preview and exports use the current filters (n = ' + (n === null ? '—' : fmtInt(n)) + ' records).';
  }
  function setHeader(derived) {
    var hd = st.els && st.els.header;
    if (!hd) return;
    if (hd.setMeta) hd.setMeta(subtitle(derived)); else { var sub = hd.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(derived); }
    if (hd.setLead) hd.setLead(leadText(derived));
  }

  function renderActions() {
    var card = h('section', { class: 'card reports-actions', 'aria-labelledby': 'reports-actions-title' });
    card.appendChild(h('div', { class: 'card__header' }, [
      h('div', {}, [h('h2', { class: 'card__title', id: 'reports-actions-title', text: 'Actions carried forward' }),
        h('p', { class: 'card__subtitle', text: 'Open items appear in every report until you mark them done.' })])
    ]));
    var list = h('ul', { class: 'action-list', id: 'report-actions-list', 'aria-label': 'Carried-forward actions' });
    card.appendChild(list);
    var form = h('form', { class: 'action-add', id: 'report-action-add' });
    var text = h('input', { type: 'text', id: 'report-action-text', class: 'input', placeholder: 'New action, e.g. Confirm carrier credit for the December delays', 'aria-label': 'Action text', required: true, maxlength: '240' });
    var owner = h('input', { type: 'text', id: 'report-action-owner', class: 'input input--sm', placeholder: 'Owner', 'aria-label': 'Owner', maxlength: '60' });
    var due = h('input', { type: 'date', id: 'report-action-due', class: 'input input--sm', 'aria-label': 'Due date' });
    var add = h('button', { type: 'submit', class: 'btn btn--sm', id: 'report-action-submit' }, 'Add action');
    form.appendChild(text);
    form.appendChild(h('div', { class: 'action-add__row' }, [owner, due, add]));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var t = text.value.trim();
      if (!t) return;
      st.actions.push({ id: uid('act'), text: t, owner: owner.value.trim(), due: due.value || '', done: false, doneAt: null, createdAt: nowDate().toISOString() });
      saveActions(st.actions);
      text.value = ''; owner.value = ''; due.value = '';
      renderActionList();
      if (st.generated) scheduleRegenerate();
      toast('Action added. It appears under “Actions carried forward”.', 'good', { ms: 3000 });
    });
    card.appendChild(form);
    st.els.actionList = list;
    renderActionList();
    return card;
  }

  function renderActionList() {
    var list = st.els.actionList;
    if (!list) return;
    list.innerHTML = '';
    if (!st.actions.length) {
      list.appendChild(h('li', { class: 'action-list__empty muted', text: 'No actions yet. Add the follow-ups the team owns and they carry forward week to week.' }));
      return;
    }
    var open = st.actions.filter(function (a) { return !a.done; }), done = st.actions.filter(function (a) { return a.done; });
    open.concat(done).forEach(function (a) {
      var li = h('li', { class: 'action-item' + (a.done ? ' is-done' : ''), 'data-id': a.id });
      if (st.editingId === a.id) {
        var et = h('input', { type: 'text', class: 'input input--sm', value: a.text, 'aria-label': 'Edit action text', id: 'report-action-edit-text' });
        var eo = h('input', { type: 'text', class: 'input input--sm', value: a.owner || '', placeholder: 'Owner', 'aria-label': 'Edit owner' });
        var ed = h('input', { type: 'date', class: 'input input--sm', value: a.due || '', 'aria-label': 'Edit due date' });
        var save = h('button', { type: 'button', class: 'btn btn--xs btn--primary', onclick: function () {
          a.text = et.value.trim() || a.text; a.owner = eo.value.trim(); a.due = ed.value || '';
          st.editingId = null; saveActions(st.actions); renderActionList(); if (st.generated) scheduleRegenerate();
        } }, 'Save');
        var cancel = h('button', { type: 'button', class: 'btn btn--xs btn--ghost', onclick: function () { st.editingId = null; renderActionList(); } }, 'Cancel');
        li.appendChild(h('div', { class: 'action-item__edit' }, [et, h('div', { class: 'action-add__row' }, [eo, ed, save, cancel])]));
        list.appendChild(li);
        return;
      }
      var box = h('input', { type: 'checkbox', id: 'report-action-done-' + a.id, 'aria-label': 'Mark done: ' + a.text });
      box.checked = a.done;
      box.addEventListener('change', function () {
        a.done = box.checked; a.doneAt = a.done ? nowDate().toISOString() : null;
        saveActions(st.actions); renderActionList(); if (st.generated) scheduleRegenerate();
      });
      var meta = [a.owner ? 'owner ' + a.owner : null, a.due ? 'due ' + fmtDate(a.due) : null, a.done && a.doneAt ? 'done ' + fmtDate(a.doneAt) : null].filter(Boolean).join(' · ');
      li.appendChild(box);
      li.appendChild(h('div', { class: 'action-item__body' }, [
        h('label', { class: 'action-item__text', for: box.id, text: a.text }),
        meta ? h('div', { class: 'action-item__meta muted', text: meta }) : null
      ]));
      li.appendChild(h('div', { class: 'action-item__tools' }, [
        h('button', { type: 'button', class: 'btn btn--xs btn--ghost', 'aria-label': 'Edit action: ' + a.text, onclick: function () { st.editingId = a.id; renderActionList(); } }, 'Edit'),
        h('button', { type: 'button', class: 'btn btn--xs btn--ghost', 'aria-label': 'Remove action: ' + a.text, onclick: function () {
          var idx = st.actions.indexOf(a); if (idx < 0) return;
          var removed = st.actions.splice(idx, 1)[0];
          saveActions(st.actions); renderActionList(); if (st.generated) scheduleRegenerate();
          toast('Action removed.', 'info', { undo: function () { st.actions.splice(Math.min(idx, st.actions.length), 0, removed); saveActions(st.actions); renderActionList(); if (st.generated) scheduleRegenerate(); } });
        } }, 'Remove')
      ]));
      list.appendChild(li);
    });
  }

  function renderExports() {
    var card = h('section', { class: 'card reports-exports', 'aria-labelledby': 'reports-exports-title' });
    card.appendChild(h('div', { class: 'card__header' }, [
      h('div', {}, [h('h2', { class: 'card__title', id: 'reports-exports-title', text: 'Export and backup' }),
        h('p', { class: 'card__subtitle', id: 'reports-exports-sub' })])
    ]));
    var ex = VOC.exporter;
    if (!ex) {
      if (ui() && ui().emptyState) ui().emptyState(h('div'), {});
      card.appendChild(h('p', { class: 'muted', text: 'The exporter module did not load, so CSV and JSON exports are unavailable in this build.' }));
      return card;
    }
    var grid = h('div', { class: 'export-grid' });
    grid.appendChild(h('button', { type: 'button', class: 'btn', id: 'export-records-csv', onclick: exportRecords }, 'Records CSV'));
    grid.appendChild(h('button', { type: 'button', class: 'btn', id: 'export-metrics-csv', onclick: exportMetrics }, 'Metrics CSV'));
    grid.appendChild(h('button', { type: 'button', class: 'btn', id: 'export-regulatory-csv', onclick: exportRegulatory }, 'Regulatory CSV'));
    grid.appendChild(h('button', { type: 'button', class: 'btn', id: 'export-backup-json', onclick: exportBackup }, 'Backup JSON'));
    card.appendChild(grid);
    var fileInput = h('input', { type: 'file', id: 'restore-file', accept: '.json,application/json', class: 'sr-only', 'aria-label': 'Choose a backup JSON file to restore' });
    fileInput.addEventListener('change', function () { if (fileInput.files && fileInput.files[0]) restoreFrom(fileInput.files[0]); fileInput.value = ''; });
    card.appendChild(h('div', { class: 'row mt-2' }, [
      h('button', { type: 'button', class: 'btn btn--ghost', id: 'restore-backup', onclick: function () { fileInput.click(); } }, 'Restore from backup…'),
      fileInput
    ]));
    card.appendChild(h('p', { class: 'field__hint', text: 'Records CSV follows the current filters; Regulatory CSV covers every adverse-event and food-safety record regardless of filters. Restricted mail is redacted when the redaction setting is on.' }));
    st.els.exportSub = card.querySelector('#reports-exports-sub');
    return card;
  }

  function dqItems(dq) {
    dq = dq || {};
    var n = isNum(dq.n) ? dq.n : (st.derived ? st.derived.n : 0);
    function pctItem(label, v, nn) { return { label: label, value: isNum(v) ? fmtPct01(v) : '—', n: nn }; }
    return [
      pctItem('Needs review', dq.needsReviewPct, n),
      pctItem('Non-English', dq.nonEnglishPct, n),
      { label: 'Noise dropped', value: fmtInt(isNum(dq.noiseDropped) ? dq.noiseDropped : 0), n: n, hint: 'auto-replies, bounces, newsletters in range' },
      { label: 'Duplicates removed', value: fmtInt(isNum(dq.duplicatesRemoved) ? dq.duplicatesRemoved : 0), n: null, hint: 'across every import' },
      pctItem('Category agreement', dq.agreementCategory, isNum(dq.agreementCategoryN) ? dq.agreementCategoryN : n),
      pctItem('Sentiment agreement', dq.agreementSentiment, isNum(dq.agreementSentimentN) ? dq.agreementSentimentN : n),
      { label: 'Orders coverage', value: fmtInt(isNum(dq.ordersCoverageMonths) ? dq.ordersCoverageMonths : 0) + ' mo', n: null, hint: 'months with an order total' },
      { label: 'Reclassify failures', value: fmtInt(isNum(dq.reclassifyFailures) ? dq.reclassifyFailures : 0), n: null, hint: 'seed records the pipeline could not rescore' }
    ];
  }

  function renderDq(derived) {
    var card = h('section', { class: 'card reports-dq', 'aria-labelledby': 'reports-dq-title' });
    card.appendChild(h('div', { class: 'card__header' }, [
      h('div', {}, [h('h2', { class: 'card__title', id: 'reports-dq-title', text: 'Data quality' }),
        h('p', { class: 'card__subtitle', id: 'reports-dq-sub' })]),
      h('a', { href: '#/methods', class: 'btn btn--ghost btn--sm', id: 'reports-dq-methods' }, 'Methods')
    ]));
    var grid = h('div', { class: 'dq-grid', id: 'reports-dq-grid' });
    card.appendChild(grid);
    st.els.dqGrid = grid;
    st.els.dqSub = card.querySelector('#reports-dq-sub');
    fillDq(derived);
    return card;
  }

  function fillDq(derived) {
    var grid = st.els.dqGrid;
    if (!grid) return;
    grid.innerHTML = '';
    var dq = derived && derived.dq;
    if (!dq || !derived.n) {
      if (ui() && ui().emptyState) ui().emptyState(grid, { title: 'No records in range', text: 'Widen the date range to compute data-quality figures.' });
      else grid.textContent = 'No records in range.';
      if (st.els.dqSub) st.els.dqSub.textContent = 'n = 0';
      return;
    }
    dqItems(dq).forEach(function (it) {
      grid.appendChild(h('div', { class: 'dq-item' }, [
        h('div', { class: 'dq-item__value', text: it.value }),
        h('div', { class: 'dq-item__label', text: it.label }),
        h('div', { class: 'dq-item__n muted', text: isNum(it.n) ? 'n = ' + fmtInt(it.n) : (it.hint || '') })
      ]));
    });
    if (st.els.dqSub) st.els.dqSub.textContent = 'Current filters · n = ' + fmtInt(derived.n) + ' records. Agreement compares the rule classifier with the stored label.';
  }

  function renderPreviewShell() {
    var wrap = h('section', { class: 'card card--flush report-preview', 'aria-labelledby': 'report-preview-title' });
    var head = h('div', { class: 'report-preview__bar' }, [
      h('div', {}, [h('h2', { class: 'card__title', id: 'report-preview-title', text: 'Preview' }), h('p', { class: 'card__subtitle', id: 'report-preview-sub', text: 'Nothing generated yet.' })]),
      h('div', { class: 'row', id: 'report-preview-tools' })
    ]);
    wrap.appendChild(head);
    var body = h('div', { class: 'report-preview__body', id: 'report-preview-body' });
    wrap.appendChild(body);
    st.els.previewBody = body;
    st.els.previewSub = head.querySelector('#report-preview-sub');
    st.els.previewTools = head.querySelector('#report-preview-tools');
    renderPreviewTools();
    showPreviewEmpty();
    return wrap;
  }

  function renderPreviewTools() {
    var tools = st.els.previewTools;
    if (!tools) return;
    tools.innerHTML = '';
    tools.appendChild(h('button', { type: 'button', class: 'btn btn--sm', id: 'report-print', onclick: printReport, disabled: !st.generated ? true : null }, 'Print'));
    tools.appendChild(h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'report-download-html', onclick: downloadHtml, disabled: !st.generated ? true : null }, 'Download HTML'));
    var c = VOC.connector;
    if (c && typeof c.mode === 'function' && c.mode() === 'served' && typeof c.saveReport === 'function') {
      tools.appendChild(h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'report-save-server', onclick: saveToServer, disabled: !st.generated ? true : null }, 'Save to server'));
    }
  }

  function showPreviewEmpty() {
    var body = st.els.previewBody;
    if (!body) return;
    var text = VOC.report ? 'Choose Weekly or Monthly, pick the period and press Generate. The report reads the current filters and lists every statistic with its n.' : 'The report module (js/report.js) did not load, so nothing can be generated in this build.';
    if (ui() && ui().emptyState) ui().emptyState(body, { title: 'No report yet', text: text, icon: 'build', action: VOC.report ? { label: 'Generate ' + st.kind + ' report', onClick: function () { generate(true); } } : null });
    else body.innerHTML = '<div class="empty-state"><div class="empty-state__title">No report yet</div><p class="empty-state__text">' + esc(text) + '</p></div>';
  }

  /* ------------------------------------------------------------------ */
  /* Generate / print / save                                             */
  /* ------------------------------------------------------------------ */

  function generate(fromButton) {
    var rep = VOC.report, s = store();
    if (!rep || typeof rep.weekly !== 'function') { showPreviewEmpty(); return; }
    var p = periodFor(st.kind);
    st.lastPeriod = p;
    if (fromButton && st.align && s && typeof s.setFilters === 'function') {
      var f = s.filters ? s.filters() : null;
      var same = f && f.range && f.range.from === p.from && f.range.to === p.to;
      if (!same) {
        // setFilters emits 'filtered'; the app calls update() and the debounced regenerate renders with the new derived.
        st.generated = true;
        s.setFilters({ range: { preset: 'custom', from: p.from, to: p.to } });
        return;
      }
    }
    var derived = st.derived || (s && typeof s.derived === 'function' ? s.derived() : null);
    if (!derived) return;
    var ctx = { actions: actionsForReport(st.actions, p.from), generatedAt: new Date().toISOString() };
    if (st.kind === 'weekly') ctx.weekEnding = p.to; else ctx.month = monthKeyOf(p.from);
    var html;
    try { html = st.kind === 'weekly' ? rep.weekly(derived, ctx) : rep.monthly(derived, ctx); }
    catch (e) {
      html = null;
      if (typeof console !== 'undefined') console.error('Report generation failed:', e);
    }
    var body = st.els.previewBody;
    if (!body) return;
    if (!html) {
      st.generated = false; st.html = '';
      if (ui() && ui().emptyState) ui().emptyState(body, { title: 'The report could not be built', text: 'The report module threw an error for the current filters (n = ' + fmtInt(derived.n) + '). Try a different range or check the console.' });
      renderPreviewTools();
      return;
    }
    st.html = html;
    st.generated = true;
    body.innerHTML = html;
    var u = U();
    var f2 = derived.filters && derived.filters.range;
    var rangeTxt = f2 && f2.from && f2.to ? (u ? u.fmt.range(f2.from, f2.to) : f2.from + ' – ' + f2.to) : 'current range';
    var mismatch = f2 && (f2.from !== p.from || f2.to !== p.to);
    if (st.els.previewSub) st.els.previewSub.textContent = (st.kind === 'weekly' ? 'Weekly' : 'Monthly') + ' · ' + p.label + ' · data ' + rangeTxt + ' · n = ' + fmtInt(derived.n) + (mismatch ? ' · the data range differs from the report period' : '');
    renderPreviewTools();
    if (fromButton) toast((st.kind === 'weekly' ? 'Weekly' : 'Monthly') + ' report generated (n = ' + fmtInt(derived.n) + ').', 'good', { ms: 3000 });
  }

  function scheduleRegenerate() {
    if (st.updateTimer) clearTimeout(st.updateTimer);
    st.updateTimer = setTimeout(function () { st.updateTimer = null; if (st.root && st.generated) generate(false); }, UPDATE_DEBOUNCE_MS);
  }

  function reportTitle() {
    var p = st.lastPeriod || periodFor(st.kind);
    return 'L-Nutra VoC · ' + (st.kind === 'weekly' ? 'Weekly report · ' : 'Monthly report · ') + p.label;
  }
  function reportFilename(ext) {
    var p = st.lastPeriod || periodFor(st.kind);
    return 'lnutra-voc-' + st.kind + '-' + (st.kind === 'weekly' ? p.to : monthKeyOf(p.from)) + '.' + ext;
  }
  function printableDocument() {
    var rep = VOC.report;
    if (rep && typeof rep.wrapPrintable === 'function') return rep.wrapPrintable(st.html, { title: reportTitle(), derived: st.derived });
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(reportTitle()) + '</title></head><body>' + st.html + '</body></html>';
  }

  function printInPlace() {
    var body = document.body;
    body.classList.add('voc-print-report');
    var done = function () { body.classList.remove('voc-print-report'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    if (st.printClassTimer) clearTimeout(st.printClassTimer);
    st.printClassTimer = setTimeout(done, 60000);
    try { window.print(); } catch (e) { done(); toast('Printing is not available in this browser.', 'critical'); }
  }

  function printReport() {
    if (!st.generated || !st.html) { toast('Generate a report first.', 'warning'); return; }
    var doc = printableDocument();
    var win = null;
    try { win = window.open('', '_blank', 'noopener=no,width=900,height=1100'); } catch (e) { win = null; }
    if (!win || win.closed || typeof win.document === 'undefined') {
      toast('The browser blocked the print window; printing this page instead. Allow pop-ups for a clean report window.', 'warning', { ms: 8000 });
      printInPlace();
      return;
    }
    try {
      win.document.open();
      win.document.write(doc);
      win.document.close();
      win.focus();
      var fired = false;
      var go = function () { if (fired) return; fired = true; try { win.print(); } catch (e2) { /* the user can print from the window */ } };
      if (win.document.readyState === 'complete') setTimeout(go, 250); else win.addEventListener('load', function () { setTimeout(go, 250); });
      setTimeout(go, 1500);
    } catch (e) {
      toast('Could not write the print window; printing this page instead.', 'warning');
      printInPlace();
    }
  }

  function downloadHtml() {
    if (!st.generated || !st.html) { toast('Generate a report first.', 'warning'); return; }
    download(reportFilename('html'), printableDocument(), 'text/html;charset=utf-8').then(function (how) {
      if (how === 'download') toast('Report saved as ' + reportFilename('html') + '.', 'good', { ms: 3000 });
    });
  }

  function saveToServer() {
    var c = VOC.connector;
    if (!st.generated || !st.html) { toast('Generate a report first.', 'warning'); return; }
    if (!c || typeof c.saveReport !== 'function') { toast('The connector module is unavailable.', 'critical'); return; }
    var btn = st.root && st.root.querySelector('#report-save-server');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    c.saveReport(reportFilename('html'), printableDocument()).then(function (res) {
      toast('Saved on the server' + (res && res.path ? ' at ' + res.path : '') + '.', 'good', { ms: 6000 });
    }).catch(function (err) {
      var msg = err && err.message ? err.message : 'unknown error';
      // The connector's own 401 message already says where the token goes; add the hint only when it does not.
      var hint = err && err.status === 401 && !/token/i.test(msg) ? ' Paste the API token in Settings → Connector.' : '';
      toast('Save failed: ' + msg + hint, 'critical', { ms: 8000 });
    }).then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save to server'; } });
  }

  /* ------------------------------------------------------------------ */
  /* Exports                                                             */
  /* ------------------------------------------------------------------ */

  function redactFlag() { var s = settingsOf(); return s.redactRestricted !== false; }

  function exportRecords() {
    var ex = VOC.exporter, d = st.derived;
    if (!ex || !d) return;
    var recs = arr(d.records);
    if (!recs.length) { toast('No records in the current range to export.', 'warning'); return; }
    download(exportName('records'), ex.recordsCsv(recs, { redact: redactFlag(), now: d.now }), 'text/csv;charset=utf-8').then(function (how) {
      if (how === 'download') toast('Exported ' + fmtInt(recs.length) + ' records.', 'good', { ms: 3000 });
    });
  }

  function exportMetrics() {
    var ex = VOC.exporter, d = st.derived;
    if (!ex || !d) return;
    var f = d.filters && d.filters.range || {};
    var rows = Object.keys(d.kpis || {}).map(function (id) {
      var k = d.kpis[id] || {};
      var def = VOC.metrics && VOC.metrics.registry && VOC.metrics.registry[id];
      return { metric: id, label: k.label || id, unit: k.unit || '', direction: k.direction || '', value: k.value, n: k.n, prior: k.prev,
        delta: k.delta ? { text: k.delta.text, abs: k.delta.abs, rel: k.delta.rel } : null, interval: k.interval || null,
        range_from: f.from || '', range_to: f.to || '', compare: d.filters ? d.filters.compare : '', formula: def && def.formula ? def.formula : '' };
    });
    if (!rows.length) { toast('No metrics computed for the current range.', 'warning'); return; }
    download(exportName('metrics'), ex.metricsCsv(rows), 'text/csv;charset=utf-8').then(function (how) {
      if (how === 'download') toast('Exported ' + fmtInt(rows.length) + ' metrics.', 'good', { ms: 3000 });
    });
  }

  function exportRegulatory() {
    var ex = VOC.exporter, d = st.derived, s = store();
    if (!ex) return;
    var all = d && arr(d.allRecords).length ? d.allRecords : (s && typeof s.all === 'function' ? s.all() : []);
    var csv = ex.regulatoryCsv(all, { redact: redactFlag(), now: d ? d.now : undefined });
    var lines = csv.split(/\r?\n/).filter(Boolean).length - 1;
    if (lines <= 0) { toast('No adverse-event or food-safety records to export.', 'warning'); return; }
    download(exportName('regulatory'), csv, 'text/csv;charset=utf-8').then(function (how) {
      if (how === 'download') toast('Exported the regulatory register (' + fmtInt(lines) + ' rows, all records).', 'good', { ms: 3000 });
    });
  }

  function exportBackup() {
    var ex = VOC.exporter, s = store();
    if (!ex || typeof ex.backupJson !== 'function') return;
    var json = ex.backupJson(s);
    var parsed = null;
    try { parsed = JSON.parse(json); } catch (e) { parsed = null; }
    download(exportName('backup', 'json'), json, 'application/json;charset=utf-8').then(function (how) {
      if (how === 'download') toast('Backup saved: ' + fmtInt(parsed ? arr(parsed.records).length : 0) + ' imported records, ' + fmtInt(parsed ? arr(parsed.overlays).length : 0) + ' overlays, settings and orders. Seed records are not included; they ship with the site.', 'good', { ms: 7000 });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Restore                                                             */
  /* ------------------------------------------------------------------ */

  function readText(file) {
    return new Promise(function (resolve, reject) {
      if (typeof FileReader === 'undefined') { reject(new Error('FileReader unavailable')); return; }
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(r.error || new Error('Could not read ' + file.name)); };
      r.readAsText(file, 'utf-8');
    });
  }

  /** Apply backup overlays through the public store API (update/addNote) since the store has no direct overlay import. */
  function applyOverlays(overlays, s) {
    var applied = 0, missing = 0, notes = 0;
    var fields = ['status', 'assignee', 'tags', 'category', 'subcategory', 'product', 'urgency', 'recovered', 'is_adverse_event', 'serious_ae'];
    arr(overlays).forEach(function (ov) {
      if (!ov || !ov.id) return;
      var existing = typeof s.record === 'function' ? s.record(ov.id) : null;
      if (!existing) { missing += 1; return; }
      var patch = {};
      fields.forEach(function (f) { if (ov[f] !== undefined) patch[f] = ov[f]; });
      if (Object.keys(patch).length && typeof s.update === 'function') { s.update(ov.id, patch, 'Restore'); applied += 1; }
      if (Array.isArray(ov.notes) && typeof s.addNote === 'function') {
        var have = arr(existing.notes).map(function (n) { return n && n.text; });
        ov.notes.forEach(function (n) { if (n && n.text && have.indexOf(n.text) < 0) { s.addNote(ov.id, n.text, n.by || 'Restore'); notes += 1; } });
      }
    });
    return { applied: applied, missing: missing, notes: notes };
  }

  function mergeOrders(base, add) {
    var out = JSON.parse(JSON.stringify(base || { _total: {} }));
    Object.keys(add || {}).forEach(function (pid) {
      out[pid] = out[pid] || {};
      Object.keys(add[pid] || {}).forEach(function (mo) { if (isNum(add[pid][mo])) out[pid][mo] = add[pid][mo]; });
    });
    return out;
  }

  function restoreFrom(file) {
    var imp = VOC.importers, s = store();
    if (!imp || !s) { toast('The importer or store module is unavailable.', 'critical'); return; }
    var confirmP = ui() && typeof ui().confirm === 'function'
      ? ui().confirm({ title: 'Restore from ' + file.name + '?', text: 'Imported records, overlays (status, assignee, tags, notes, reclassifications), settings and monthly orders in the backup are merged into this browser. Nothing is deleted; duplicates are skipped.', confirmLabel: 'Restore' })
      : Promise.resolve(true);
    confirmP.then(function (ok) {
      if (!ok) return null;
      return readText(file).then(function (text) {
        var full = typeof imp.parseJsonFull === 'function' ? imp.parseJsonFull(text) : { kind: 'records', items: imp.parseJsonText(text) };
        var items = arr(full.items);
        var addP = items.length && typeof s.addRecords === 'function' ? s.addRecords(items, 'json') : Promise.resolve({ added: 0, duplicates: 0 });
        return Promise.resolve(addP).then(function (sum) {
          sum = sum || { added: 0, duplicates: 0 };
          var bits = [fmtInt(sum.added) + ' record' + (sum.added === 1 ? '' : 's') + ' added', fmtInt(sum.duplicates || 0) + ' duplicate' + (sum.duplicates === 1 ? '' : 's') + ' skipped'];
          var ovRes = null;
          if (arr(full.overlays).length) { ovRes = applyOverlays(full.overlays, s); bits.push(fmtInt(ovRes.applied) + ' overlay' + (ovRes.applied === 1 ? '' : 's') + ' applied' + (ovRes.notes ? ', ' + fmtInt(ovRes.notes) + ' notes' : '') + (ovRes.missing ? ', ' + fmtInt(ovRes.missing) + ' for unknown records' : '')); }
          if (full.ordersByMonth && typeof s.setOrders === 'function') { s.setOrders(mergeOrders(s.orders(), full.ordersByMonth)); bits.push('orders merged'); }
          if (full.settings && typeof s.setSettings === 'function') {
            var patch = Object.assign({}, full.settings);
            delete patch.theme; // theme belongs to this device
            s.setSettings(patch);
            bits.push('settings restored');
          }
          var kindNote = full.kind === 'backup' ? '' : ' This file was not a full backup, so only records were imported.';
          toast('Restore complete: ' + bits.join(', ') + '.' + kindNote, 'good', { ms: 9000 });
          st.actions = loadActions();
          renderActionList();
        });
      });
    }).catch(function (err) {
      toast('Restore failed: ' + (err && err.message ? err.message : String(err)), 'critical', { ms: 8000 });
    });
  }

  /* ------------------------------------------------------------------ */
  /* View contract                                                       */
  /* ------------------------------------------------------------------ */

  VOC.views[NAME] = {
    title: TITLE,
    icon: NAME,
    /**
     * @param {HTMLElement} root
     * @param {Object|null} derived  VOC.store.derived()
     */
    mount: function (root, derived) {
      st.root = root;
      st.derived = derived || null;
      st.els = {};
      st.generated = false; st.html = '';
      st.editingId = null;
      if (!st.weekEnding) st.weekEnding = lastSundayBefore(nowDate());
      if (!st.month) st.month = addMonths(monthKeyOf(dayKey(nowDate())), -1); // last complete month
      st.actions = loadActions();

      root.innerHTML = '';
      st.els.header = ui() && typeof ui().viewHeader === 'function'
        ? ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived) })
        : h('header', { class: 'view-header' }, [h('h1', { class: 'view-title', text: TITLE }), h('p', { class: 'view-meta', 'data-role': 'subtitle', text: subtitle(derived) })]);
      root.appendChild(st.els.header);
      var layout = h('div', { class: 'reports-layout' });
      var side = h('div', { class: 'reports-side' });
      side.appendChild(renderControls());
      side.appendChild(renderActions());
      side.appendChild(renderExports());
      side.appendChild(renderDq(derived));
      layout.appendChild(renderPreviewShell());
      layout.appendChild(side);
      root.appendChild(layout);
      refreshPeriodHint();
      if (st.els.exportSub) st.els.exportSub.textContent = 'Downloads use the current filters (n = ' + fmtInt(derived ? derived.n : 0) + ').';
      // Render the default weekly report right away so the page is never blank; the user can regenerate for another period.
      if (VOC.report && derived && derived.n) generate(false);
    },
    /** @param {Object|null} derived */
    update: function (derived) {
      st.derived = derived || st.derived;
      if (!st.root) return;
      setHeader(derived);
      if (st.els.exportSub) st.els.exportSub.textContent = 'Downloads use the current filters (n = ' + fmtInt(derived ? derived.n : 0) + ').';
      fillDq(derived);
      var fresh = loadActions();
      if (JSON.stringify(fresh) !== JSON.stringify(st.actions)) { st.actions = fresh; renderActionList(); }
      if (st.generated) scheduleRegenerate();
    },
    unmount: function () {
      if (st.updateTimer) { clearTimeout(st.updateTimer); st.updateTimer = null; }
      if (st.printClassTimer) { clearTimeout(st.printClassTimer); st.printClassTimer = null; }
      if (typeof document !== 'undefined' && document.body) document.body.classList.remove('voc-print-report');
      st.root = null; st.els = {}; st.generated = false; st.html = '';
    }
  };
})();
