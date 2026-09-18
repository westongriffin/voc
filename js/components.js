/* L-Nutra · Voice of the Customer — UI kit (SPEC §4.10)
   DOM-only module. Loads under jsc (nothing touches the DOM at parse time); every builder is a function.
   Uses VOC.util / VOC.charts / VOC.exporter when present and degrades quietly when they are missing. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};

  var DOC = function () { return typeof document !== 'undefined' ? document : null; };
  var util = function () { return VOC.util || null; };

  /* ------------------------------------------------------------------ helpers */

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    var u = util();
    if (u && typeof u.escapeHtml === 'function') return u.escapeHtml(s == null ? '' : String(s));
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  /** Tiny DOM builder: h('div', {class:'x', onclick: fn, dataset:{id:1}}, [children|string]) */
  function h(tag, attrs, children) {
    var d = DOC();
    var el = d.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.keys(v).forEach(function (dk) { el.dataset[dk] = v[dk]; });
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    });
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    if (children == null) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c == null || c === false) return;
      if (typeof c === 'string' || typeof c === 'number') el.appendChild(DOC().createTextNode(String(c)));
      else el.appendChild(c);
    });
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var nf0, nf1;
  function fmtInt(n) {
    var u = util();
    if (u && u.fmt && u.fmt.int) return u.fmt.int(n);
    nf0 = nf0 || new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    return nf0.format(Math.round(n));
  }
  function fmtNum(n, digits) {
    var u = util();
    if (u && u.fmt && u.fmt.num) return u.fmt.num(n, digits);
    if (digits === 1) { nf1 = nf1 || new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); return nf1.format(n); }
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits == null ? 0 : digits }).format(n);
  }
  function fmtPct01(p, digits) {
    var u = util();
    if (u && u.fmt && u.fmt.pct) return u.fmt.pct(p, digits);
    return fmtNum(p * 100, digits || 0) + '%';
  }
  function fmtHours(hrs) {
    var u = util();
    if (u && u.fmt && u.fmt.hours) return u.fmt.hours(hrs);
    if (hrs < 1) return Math.round(hrs * 60) + 'm';
    if (hrs < 48) return fmtNum(hrs, 1) + 'h';
    return fmtNum(hrs / 24, 1) + 'd';
  }
  function fmtUsd(n) {
    var u = util();
    if (u && u.fmt && u.fmt.usd) return u.fmt.usd(n);
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  }

  var UNITS = ['count', 'pct', 'pts', 'hours', 'per_1k', 'per_10k', 'score', 'usd'];
  function unitFor(idOrUnit) {
    if (UNITS.indexOf(idOrUnit) >= 0) return idOrUnit;
    var reg = VOC.metrics && VOC.metrics.registry;
    if (reg && reg[idOrUnit] && reg[idOrUnit].unit) return reg[idOrUnit].unit;
    return 'count';
  }

  /**
   * Format a metric value for display by metric id or unit. Never returns NaN/undefined: null → '—'.
   * pct values are percent points on the 0–100 scale, exactly as VOC.metrics.registry reports them
   * (0.8 → '0.8%', 23.4 → '23%'); intervals use the same scale. Callers holding a 0–1 fraction multiply by 100 first.
   * @param {string} idOrUnit  metric id from VOC.metrics.registry or a unit name
   * @param {number|null} value
   * @returns {string}
   */
  function formatValue(idOrUnit, value) {
    if (!isNum(value)) return '—';
    var unit = unitFor(idOrUnit);
    switch (unit) {
      case 'pct': return fmtNum(value, Math.abs(value) < 10 && value % 1 !== 0 ? 1 : 0) + '%';
      case 'pts': return (util() && util().fmt && util().fmt.pts) ? util().fmt.pts(value) : fmtNum(value, 0) + ' pts';
      case 'hours': return fmtHours(value);
      case 'per_1k': return fmtNum(value, Math.abs(value) < 10 ? 1 : 0) + ' /1k';
      case 'per_10k': return fmtNum(value, Math.abs(value) < 10 ? 1 : 0) + ' /10k';
      case 'score': return fmtNum(value, Math.abs(value) < 10 && value % 1 !== 0 ? 1 : 0);
      case 'usd': return fmtUsd(value);
      default: return Math.abs(value) < 10 && value % 1 !== 0 ? fmtNum(value, 1) : fmtInt(value);
    }
  }

  function labelFor(kind, id) {
    var e = VOC.enums;
    if (e && typeof e.label === 'function') {
      try { var l = e.label(kind, id); if (l) return l; } catch (err) { /* fall through */ }
    }
    return String(id == null ? '' : id).replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
  }

  function focusables(root) {
    var sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(root.querySelectorAll(sel), function (el) {
      return el.offsetParent !== null || el === DOC().activeElement;
    });
  }

  function rootFor(id, className) {
    var d = DOC();
    var el = d.getElementById(id);
    if (!el) {
      el = d.createElement('div');
      el.id = id;
      if (className) el.className = className;
      d.body.appendChild(el);
    }
    return el;
  }

  function reducedMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  var ICON = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4zM4 14h4l2 3h4l2-3h4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5m0 0-4 4m4-4 4 4M4 17v3h16v-3"/></svg>',
    build: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 14 10m0 0 2.5-2.5a3 3 0 0 0 3.5-3.5L17 7l-3-3 3-3a3 3 0 0 0-3.5 3.5L11 7l3 3z"/></svg>'
  };

  /* ------------------------------------------------------------------ popover */

  var activePopover = null;
  var popoverSeq = 0;

  function closePopover() {
    if (!activePopover) return;
    var p = activePopover;
    activePopover = null;
    if (p.anchor) p.anchor.setAttribute('aria-expanded', 'false');
    // Focus moved into the dialog on open; hand it back to the anchor so it does not fall to <body>.
    var active = DOC().activeElement;
    if (active && p.el.contains(active) && p.anchor && typeof p.anchor.focus === 'function' && DOC().contains(p.anchor)) {
      try { p.anchor.focus({ preventScroll: true }); } catch (e) { /* detached anchor */ }
    }
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    DOC().removeEventListener('pointerdown', p.onDown, true);
    DOC().removeEventListener('keydown', p.onKey, true);
    window.removeEventListener('resize', p.onResize);
    if (typeof p.onClose === 'function') p.onClose();
  }

  function positionPopover(el, anchor) {
    var r = anchor.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    el.style.left = '0px'; el.style.top = '0px';
    var w = el.offsetWidth, hgt = el.offsetHeight;
    var left = Math.min(Math.max(8, r.left), vw - w - 8);
    var top = r.bottom + 6;
    if (top + hgt > vh - 8 && r.top - hgt - 6 > 8) top = r.top - hgt - 6;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  /**
   * Show a popover anchored to an element. Calling it again for the same anchor toggles it closed.
   * @param {HTMLElement} anchorEl
   * @param {string|HTMLElement} html  HTML string or an element to place inside
   * @param {{onClose?:function, className?:string}} [opts]
   * @returns {HTMLElement|null} the popover element (null when toggled closed)
   */
  function popover(anchorEl, html, opts) {
    opts = opts || {};
    if (activePopover && activePopover.anchor === anchorEl) { closePopover(); return null; }
    closePopover();
    var root = rootFor('popover-root');
    var el = h('div', { class: 'popover' + (opts.className ? ' ' + opts.className : ''), role: 'dialog', tabindex: '-1' });
    if (typeof html === 'string') el.innerHTML = html; else if (html) el.appendChild(html);
    // Accessible name: the .popover__title when there is one, else the anchor's own label.
    var titleEl = el.querySelector('.popover__title');
    if (titleEl) {
      if (!titleEl.id) titleEl.id = 'popover-title-' + (++popoverSeq);
      el.setAttribute('aria-labelledby', titleEl.id);
    } else {
      var anchorName = anchorEl.getAttribute('aria-label') || anchorEl.getAttribute('title') || anchorEl.textContent || '';
      if (anchorName.trim()) el.setAttribute('aria-label', anchorName.trim());
    }
    root.appendChild(el);
    positionPopover(el, anchorEl);
    anchorEl.setAttribute('aria-expanded', 'true');
    var state = {
      el: el, anchor: anchorEl, onClose: opts.onClose,
      onDown: function (e) { if (!el.contains(e.target) && !anchorEl.contains(e.target)) closePopover(); },
      onKey: function (e) { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); anchorEl.focus(); } },
      onResize: function () { positionPopover(el, anchorEl); }
    };
    activePopover = state;
    DOC().addEventListener('pointerdown', state.onDown, true);
    DOC().addEventListener('keydown', state.onKey, true);
    window.addEventListener('resize', state.onResize);
    // Move focus into the dialog (first control, else the dialog itself) so keyboard users land in it; Esc and
    // closePopover() return focus to the anchor.
    var f = focusables(el);
    var target = f.length ? f[0] : el;
    setTimeout(function () { if (activePopover === state && DOC().contains(target)) { try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }, 0);
    return el;
  }

  function formulaPopover(btn, label, formula) {
    return popover(btn, '<div class="popover__title">' + esc(label) + '</div><code class="formula">' + esc(formula) + '</code>');
  }

  /* ------------------------------------------------------------------ toast */

  var toasts = [];
  var MAX_TOASTS = 4;

  /**
   * Show a toast. Returns a dismiss function.
   * @param {string} message
   * @param {'info'|'good'|'warning'|'critical'} [kind='info']
   * @param {{undo?:function, ms?:number}} [opts]  ms defaults to 6000 (10000 when an undo is offered)
   * @returns {function} dismiss
   */
  function toast(message, kind, opts) {
    opts = opts || {};
    kind = kind || 'info';
    var root = rootFor('toast-root', 'toast-root');
    var el = h('div', { class: 'toast toast--' + kind, role: kind === 'critical' ? 'alert' : 'status' });
    el.appendChild(h('span', { class: 'toast__msg', text: String(message) }));
    var timer = null;
    function dismiss() {
      if (timer) clearTimeout(timer);
      if (el.parentNode) el.parentNode.removeChild(el);
      toasts = toasts.filter(function (t) { return t !== el; });
    }
    if (typeof opts.undo === 'function') {
      el.appendChild(h('button', { class: 'toast__undo', type: 'button', onclick: function () { dismiss(); opts.undo(); } }, 'Undo'));
    }
    el.appendChild(h('button', { class: 'toast__close', type: 'button', 'aria-label': 'Dismiss', html: '&times;', onclick: dismiss }));
    root.appendChild(el);
    toasts.push(el);
    while (toasts.length > MAX_TOASTS) {
      var old = toasts.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    var ms = isNum(opts.ms) ? opts.ms : (opts.undo ? 10000 : 6000);
    if (ms > 0) timer = setTimeout(dismiss, ms);
    return dismiss;
  }

  /* ------------------------------------------------------------------ pills */

  function confidenceBucket(v) {
    if (typeof v === 'string') return v.toLowerCase();
    if (!isNum(v)) return 'low';
    return v >= 0.7 ? 'high' : v >= 0.5 ? 'medium' : 'low';
  }

  /**
   * Build a pill for an enum-like value.
   * @param {'urgency'|'status'|'sentiment'|'tier'|'severity'|'confidence'} kind
   * @param {*} value  the id (for confidence, a 0..1 number or 'high'|'medium'|'low')
   * @returns {HTMLElement}
   */
  function pill(kind, value) {
    var cls = 'pill pill--' + kind;
    var text;
    switch (kind) {
      case 'urgency':
        text = labelFor('URGENCY', value);
        if (/^P\d · /.test(text)) text = text.split(' · ')[0];
        cls += ' pill--' + esc(value);
        break;
      case 'status':
        text = labelFor('STATUSES', value);
        cls += ' pill--' + esc(value);
        break;
      case 'sentiment':
        text = value == null ? 'Unscored' : String(value).replace(/^\w/, function (c) { return c.toUpperCase(); });
        cls += ' pill--' + esc(value == null ? 'unscored' : value);
        break;
      case 'tier':
        text = String(value || 'low').replace(/^\w/, function (c) { return c.toUpperCase(); });
        cls += ' pill--' + esc(value || 'low');
        break;
      case 'severity':
        text = String(value || 'info').replace(/^\w/, function (c) { return c.toUpperCase(); });
        cls += ' pill--severity-' + esc(value || 'info');
        break;
      case 'confidence': {
        var b = confidenceBucket(value);
        text = b.charAt(0).toUpperCase() + b.slice(1);
        if (isNum(value)) text += ' · ' + Math.round(value * 100) + '%';
        cls += ' pill--confidence-' + b;
        break;
      }
      default:
        text = String(value);
    }
    return h('span', { class: cls, title: kind + ': ' + text }, text);
  }

  /* ------------------------------------------------------------------ empty state */

  /**
   * Fill an element with an empty state.
   * @param {HTMLElement} el
   * @param {{title:string, text?:string, action?:{label:string, onClick:function}, icon?:'inbox'|'check'|'upload'|'build', kind?:'good'|'progress'}} opts
   * @returns {HTMLElement} el
   */
  function emptyState(el, opts) {
    opts = opts || {};
    el.innerHTML = '';
    var box = h('div', { class: 'empty-state' + (opts.kind ? ' empty-state--' + opts.kind : '') });
    box.appendChild(h('div', { class: 'empty-state__icon', 'aria-hidden': 'true', html: ICON[opts.icon || 'inbox'] || ICON.inbox }));
    box.appendChild(h('div', { class: 'empty-state__title', text: opts.title || 'Nothing here yet' }));
    if (opts.text) box.appendChild(h('p', { class: 'empty-state__text', text: opts.text }));
    if (opts.action && typeof opts.action.onClick === 'function') {
      box.appendChild(h('button', { class: 'btn btn--sm empty-state__action', type: 'button', onclick: opts.action.onClick }, opts.action.label || 'Continue'));
    }
    el.appendChild(box);
    return el;
  }

  /* ------------------------------------------------------------------ KPI tile */

  /** True when the caller withheld the delta on purpose (kpis[id].delta === null with a deltaNote saying why). */
  function deltaWithheld(opts) {
    return opts.delta === null && typeof opts.deltaNote === 'string' && opts.deltaNote.trim().length > 0;
  }

  function deltaParts(opts) {
    var u = util();
    var value = opts.value, prev = opts.prev, delta = opts.delta, unit = unitFor(opts.unit || opts.id);
    // A withheld delta (thin comparison window) is never recomputed from prev: the tile shows the note instead.
    if (deltaWithheld(opts)) return null;
    if (isNum(value) && isNum(prev) && u && u.fmt && typeof u.fmt.delta === 'function') {
      var d = u.fmt.delta(value, prev, { unit: unit });
      if (d && d.text) return { text: d.text, sign: d.sign };
    }
    if (delta && typeof delta === 'object' && delta.text) return { text: delta.text, sign: isNum(delta.sign) ? delta.sign : 0 };
    if (isNum(delta)) {
      var sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
      var abs = Math.abs(delta);
      var text;
      if (unit === 'pts' || unit === 'score' || unit === 'pct' || unit === 'hours') text = formatValue(unit, abs).replace(/^/, sign > 0 ? '+' : sign < 0 ? '−' : '±');
      else text = (sign > 0 ? '+' : sign < 0 ? '−' : '±') + Math.round(abs * 100) + '%';
      return { text: text, sign: sign };
    }
    if (isNum(value) && isNum(prev)) {
      var diff = value - prev;
      var s = diff > 0 ? 1 : diff < 0 ? -1 : 0;
      var t = prev !== 0 && ['count', 'per_1k', 'per_10k', 'usd'].indexOf(unit) >= 0
        ? (s > 0 ? '+' : s < 0 ? '−' : '±') + Math.round(Math.abs(diff) / Math.abs(prev) * 100) + '%'
        : (s > 0 ? '+' : s < 0 ? '−' : '±') + formatValue(unit, Math.abs(diff));
      return { text: t, sign: s };
    }
    return null;
  }

  /**
   * KPI tile with value, signed delta, n, optional interval, sparkline slot and a ƒ (formula) button.
   * @param {{id?:string, label:string, value:number|null, unit?:string, delta?:number|{text,sign}|null, deltaNote?:string|null, prev?:number,
   *          direction?:'up_good'|'down_good'|'neutral', n?:number, interval?:{lo:number,hi:number}, spark?:number[],
   *          formula?:string, onClick?:function, emptyText?:string}} opts
   *   emptyText replaces the value when `value` is null (default 'No data'), so a tile can say why it is empty.
   *   When `delta === null` and `deltaNote` is set (store withheld the delta because the comparison window is thin),
   *   no arrow is drawn even if `prev` is present and the note renders as the tile's muted footnote.
   * @returns {HTMLElement}
   */
  function kpiTile(opts) {
    opts = opts || {};
    var unit = unitFor(opts.unit || opts.id);
    var clickable = typeof opts.onClick === 'function';
    var el = h(clickable ? 'button' : 'div', {
      class: 'kpi-tile' + (clickable ? ' is-clickable' : ''),
      type: clickable ? 'button' : null,
      dataset: opts.id ? { metric: opts.id } : null,
      onclick: clickable ? function (e) { if (e.target.closest('.btn--f')) return; opts.onClick(opts); } : null
    });

    var head = h('div', { class: 'kpi-tile__head' }, h('span', { class: 'kpi-tile__label', text: opts.label || opts.id || '' }));
    if (opts.formula) {
      head.appendChild(h('button', {
        class: 'btn btn--f', type: 'button', 'aria-label': 'Formula for ' + (opts.label || opts.id), title: 'Formula',
        onclick: function (e) { e.stopPropagation(); formulaPopover(e.currentTarget, opts.label || opts.id, opts.formula); }
      }, 'ƒ'));
    }
    el.appendChild(head);

    var hasValue = isNum(opts.value);
    var emptyText = typeof opts.emptyText === 'string' && opts.emptyText.trim() ? opts.emptyText : 'No data';
    el.appendChild(h('div', {
      class: 'kpi-tile__value' + (hasValue ? '' : ' kpi-tile__value--empty' + (emptyText !== 'No data' ? ' kpi-tile__value--reason' : '')),
      text: hasValue ? formatValue(unit, opts.value) : emptyText
    }));

    var meta = h('div', { class: 'kpi-tile__meta' });
    var dp = hasValue ? deltaParts(Object.assign({}, opts, { unit: unit })) : null;
    if (dp) {
      var dir = opts.direction || 'neutral';
      var good = dp.sign === 0 ? 'flat' : dir === 'neutral' ? 'flat' : ((dp.sign > 0) === (dir === 'up_good') ? 'good' : 'bad');
      meta.appendChild(h('span', { class: 'kpi-tile__delta kpi-tile__delta--' + good, title: 'Change vs comparison period' },
        (dp.sign > 0 ? '▲ ' : dp.sign < 0 ? '▼ ' : '') + dp.text));
    }
    if (opts.interval && isNum(opts.interval.lo) && isNum(opts.interval.hi)) {
      meta.appendChild(h('span', { class: 'kpi-tile__interval', title: '95% interval' },
        formatValue(unit, opts.interval.lo) + '–' + formatValue(unit, opts.interval.hi)));
    }
    meta.appendChild(h('span', { class: 'kpi-tile__n' }, 'n = ' + (isNum(opts.n) ? fmtInt(opts.n) : '0')));
    el.appendChild(meta);
    if (hasValue && deltaWithheld(opts)) {
      el.appendChild(h('div', { class: 'kpi-tile__note kpi-tile__note--delta', title: 'Why there is no change arrow', text: opts.deltaNote.trim() }));
    }

    var spark = h('div', { class: 'kpi-tile__spark', 'aria-hidden': 'true' });
    if (Array.isArray(opts.spark) && opts.spark.filter(isNum).length >= 2 && VOC.charts && typeof VOC.charts.sparkline === 'function') {
      try { VOC.charts.sparkline(spark, opts.spark, { width: 120, height: 28 }); } catch (e) { spark.innerHTML = ''; }
    }
    el.appendChild(spark);
    return el;
  }

  /* ------------------------------------------------------------------ table twin + CSV */

  function renderTwin(container, data, caption) {
    container.innerHTML = '';
    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows) || data.rows.length === 0) {
      emptyState(container, { title: 'No data for this range', text: 'Widen the date range or clear a filter to see values here.' });
      return;
    }
    if (VOC.charts && typeof VOC.charts.tableTwin === 'function') {
      var cols = data.columns.map(function (c) { return typeof c === 'string' ? { key: c, label: c } : c; });
      var objRows = data.rows.map(function (r) {
        if (!Array.isArray(r)) return r;
        var o = {}; cols.forEach(function (c, i) { o[c.key] = r[i]; }); return o;
      });
      try { VOC.charts.tableTwin(container, { columns: cols, rows: objRows, caption: caption }); return; } catch (e) { container.innerHTML = ''; }
    }
    var tbl = h('table');
    if (caption) tbl.appendChild(h('caption', { text: caption }));
    var thead = h('thead'); var tr = h('tr');
    data.columns.forEach(function (c, i) {
      var label = typeof c === 'string' ? c : (c.label || c.key || '');
      var numeric = data.rows.some(function (r) { return isNum(Array.isArray(r) ? r[i] : r[typeof c === 'string' ? c : c.key]); });
      tr.appendChild(h('th', { scope: 'col', class: numeric ? 'num' : null, text: label }));
    });
    thead.appendChild(tr); tbl.appendChild(thead);
    var tbody = h('tbody');
    data.rows.forEach(function (r) {
      var row = h('tr');
      data.columns.forEach(function (c, i) {
        var key = typeof c === 'string' ? c : c.key;
        var v = Array.isArray(r) ? r[i] : r[key];
        row.appendChild(h('td', { class: isNum(v) ? 'num' : null, text: v == null ? '—' : (isNum(v) ? fmtNum(v, Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0) : String(v)) }));
      });
      tbody.appendChild(row);
    });
    tbl.appendChild(tbody);
    container.appendChild(tbl);
  }

  function csvEscape(v) {
    var s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(data) {
    var cols = data.columns.map(function (c) { return typeof c === 'string' ? { key: c, label: c } : c; });
    var lines = [cols.map(function (c) { return csvEscape(c.label || c.key); }).join(',')];
    data.rows.forEach(function (r) {
      lines.push(cols.map(function (c, i) { return csvEscape(Array.isArray(r) ? r[i] : r[c.key]); }).join(','));
    });
    return '﻿' + lines.join('\r\n');
  }

  function downloadText(filename, text, mime) {
    if (VOC.exporter && typeof VOC.exporter.downloadText === 'function') { VOC.exporter.downloadText(filename, text, mime); return; }
    try {
      var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = h('a', { href: url, download: filename, style: { display: 'none' } });
      DOC().body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
    } catch (e) {
      toast('Download failed in this browser. Copy the table instead.', 'warning');
    }
  }

  function datestamp() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  /* ------------------------------------------------------------------ chart card */

  /**
   * Chart card with Chart|Table toggle, CSV export, ƒ popover and a fixed-height body. When Chart.js is
   * unavailable or `render` returns null, the table twin shows with a notice.
   * The returned element also carries `vocHandle` (the chart Handle), `vocRefresh()` to re-render, and header setters
   * `setN(n)`, `setQuestion(text)`, `setFootnote(text)` so a live card can update its own copy without querying the DOM.
   * `extra` (an element or an HTML string) renders between the body and the footnote, for legends, deltas or controls.
   * @param {{id?:string, title:string, question?:string, formula?:string, n?:number, render:(function(HTMLCanvasElement):Object|null),
   *          table?:(function():{columns:Array, rows:Array}), csvName?:string, footnote?:string, height?:number, defaultMode?:'chart'|'table',
   *          extra?:(HTMLElement|string)}} opts
   * @returns {HTMLElement}
   */
  function chartCard(opts) {
    opts = opts || {};
    var chartsOk = !!(VOC.charts && typeof VOC.charts.available === 'function' ? VOC.charts.available() : (typeof window.Chart !== 'undefined' && !window.VOC_CHARTS_FAILED));
    var titleId = 'cc-' + (opts.id || Math.random().toString(36).slice(2, 8)) + '-title';
    var el = h('section', { class: 'chart-card', 'aria-labelledby': titleId, dataset: opts.id ? { chart: opts.id } : null });

    var titles = h('div', { class: 'chart-card__titles' }, h('h3', { class: 'chart-card__title', id: titleId, text: opts.title || '' }));
    var curQuestion = opts.question ? String(opts.question) : '';
    var curN = isNum(opts.n) ? opts.n : null;
    // Always present (CSS hides it while :empty) so a view or setN()/setQuestion() can fill it later.
    var question = h('p', { class: 'chart-card__question' });
    titles.appendChild(question);
    function renderQuestion() {
      var html = curQuestion ? esc(curQuestion) : '';
      // Keep the separator glued to the n so a wrapping question never starts a line with a lone "·".
      if (isNum(curN)) html += (html ? ' ' : '') + '<span class="chart-card__n">' + (html ? '· ' : '') + 'n = ' + esc(fmtInt(curN)) + '</span>';
      question.innerHTML = html;
    }
    renderQuestion();

    var tools = h('div', { class: 'chart-card__tools' });
    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show as' });
    var btnChart = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Chart');
    var btnTable = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Table');
    seg.appendChild(btnChart); seg.appendChild(btnTable);
    tools.appendChild(seg);
    if (typeof opts.table === 'function') {
      tools.appendChild(h('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', title: 'Download CSV', 'aria-label': 'Download CSV of ' + (opts.title || 'chart'),
        onclick: function () {
          var data = safeTable();
          if (!data || !data.rows || !data.rows.length) { toast('No rows to export for this range.', 'warning'); return; }
          downloadText(opts.csvName || ('lnutra-voc-' + (opts.id || 'chart') + '-' + datestamp() + '.csv'), toCsv(data), 'text/csv;charset=utf-8');
        }
      }, [h('span', { html: ICON.download, 'aria-hidden': 'true' }), 'CSV']));
    }
    if (opts.formula) {
      tools.appendChild(h('button', {
        class: 'btn btn--f', type: 'button', 'aria-label': 'Formula for ' + (opts.title || 'chart'), title: 'Formula',
        onclick: function (e) { formulaPopover(e.currentTarget, opts.title || '', opts.formula); }
      }, 'ƒ'));
    }
    el.appendChild(h('header', { class: 'chart-card__header' }, [titles, tools]));

    var notice = h('div', { class: 'chart-card__notice', hidden: true });
    el.appendChild(notice);

    var body = h('div', { class: 'chart-card__body', style: { height: (isNum(opts.height) ? opts.height : 300) + 'px' } });
    var wrap = h('div', { class: 'chart-card__canvas-wrap' });
    var canvas = h('canvas', { role: 'img', 'aria-label': opts.title || 'Chart' });
    wrap.appendChild(canvas);
    var twin = h('div', { class: 'table-twin' });
    body.appendChild(wrap); body.appendChild(twin);
    el.appendChild(body);
    var extraEl = null;
    if (opts.extra != null && opts.extra !== false) {
      extraEl = h('div', { class: 'chart-card__extra' });
      if (typeof opts.extra === 'string') extraEl.innerHTML = opts.extra;
      else if (typeof opts.extra === 'object') { try { extraEl.appendChild(opts.extra); } catch (e) { /* not a node: leave the slot empty */ } }
      el.appendChild(extraEl);
    }
    var foot = null;
    function setFootnote(text) {
      var t = text == null ? '' : String(text);
      if (!t) { if (foot) foot.hidden = true; return; }
      if (!foot) { foot = h('footer', { class: 'chart-card__foot' }); el.appendChild(foot); }
      foot.textContent = t;
      foot.hidden = false;
    }
    if (opts.footnote) setFootnote(opts.footnote);

    var handle = null, mode = 'chart', twinFresh = false;
    // `destroyed` is set by vocDestroy so a render still pending in requestAnimationFrame never builds a Chart.js
    // instance on a card the view has already thrown away (it would live on in VOC.charts' registry and be
    // re-themed forever). `rafId` lets vocDestroy cancel that pending frame outright.
    var destroyed = false, rafId = null, detachedRetries = 0;

    function safeTable() {
      if (typeof opts.table === 'function') { try { return opts.table(); } catch (e) { return null; } }
      if (handle && typeof handle.toTable === 'function') { try { return handle.toTable(); } catch (e2) { return null; } }
      return null;
    }
    function showNotice(text) { notice.textContent = text; notice.hidden = !text; }
    function setMode(m) {
      mode = m;
      body.classList.toggle('is-table', m === 'table');
      btnChart.setAttribute('aria-pressed', String(m === 'chart'));
      btnTable.setAttribute('aria-pressed', String(m === 'table'));
      if (m === 'table' && !twinFresh) { renderTwin(twin, safeTable(), opts.title); twinFresh = true; }
    }
    function destroyHandle() {
      if (handle && typeof handle.destroy === 'function') { try { handle.destroy(); } catch (e) { /* already gone */ } }
      handle = null; el.vocHandle = null;
    }
    function destroyCard() {
      destroyed = true;
      if (rafId != null && typeof cancelAnimationFrame === 'function') { try { cancelAnimationFrame(rafId); } catch (e) { /* ignore */ } }
      rafId = null;
      destroyHandle();
    }
    function scheduleRender() {
      if (destroyed) return;
      if (typeof requestAnimationFrame === 'function') { if (rafId == null) rafId = requestAnimationFrame(doRender); }
      else doRender();
    }
    function doRender() {
      rafId = null;
      if (destroyed) return;
      // A card that was created but never attached (or already removed) must not draw: Chart.js would size a 0×0
      // canvas and keep it alive. Give a late append a couple of frames, then give up until vocRefresh().
      if (el.isConnected === false) {
        if (detachedRetries < 3) { detachedRetries += 1; scheduleRender(); }
        return;
      }
      detachedRetries = 0;
      destroyHandle();
      twinFresh = false;
      if (!chartsOk || typeof opts.render !== 'function') {
        btnChart.disabled = true;
        showNotice(chartsOk ? 'No chart defined; showing the table.' : 'Chart library unavailable; showing the table twin.');
        setMode('table');
        return;
      }
      var result = null;
      try { result = opts.render(canvas); } catch (e) { result = null; }
      if (!result) {
        btnChart.disabled = true;
        var data = safeTable();
        if (data && data.rows && data.rows.length) { showNotice('Not enough data to draw this chart for the current range; showing the table.'); setMode('table'); }
        else { showNotice(''); body.classList.add('is-table'); emptyState(twin, { title: 'No data for this range', text: 'Widen the date range or clear a filter to populate this chart.' }); twinFresh = true; btnTable.setAttribute('aria-pressed', 'true'); btnChart.setAttribute('aria-pressed', 'false'); }
        return;
      }
      handle = result; el.vocHandle = result;
      btnChart.disabled = false;
      showNotice('');
      setMode(opts.defaultMode === 'table' ? 'table' : 'chart');
    }

    btnChart.addEventListener('click', function () { if (!btnChart.disabled) setMode('chart'); });
    btnTable.addEventListener('click', function () { setMode('table'); });

    el.vocHandle = null;
    /** Re-render now (no-op once the card has been destroyed). */
    el.vocRefresh = function () { if (destroyed) return; doRender(); };
    /** Destroy the chart and cancel any pending first render; the card renders nothing afterwards. */
    el.vocDestroy = destroyCard;
    el.vocDestroyed = function () { return destroyed; };
    el.vocMode = function () { return mode; };
    /** Update the "n = …" in the header (null hides it). */
    el.setN = function (n) { curN = isNum(n) ? n : null; renderQuestion(); return el; };
    /** Replace the question line under the title (empty hides it, n is kept). */
    el.setQuestion = function (text) { curQuestion = text == null ? '' : String(text); renderQuestion(); return el; };
    /** Replace (or add) the footnote; empty text hides it. */
    el.setFootnote = function (text) { setFootnote(text); return el; };
    /** The extra slot element (between body and footnote), or null when none was given. */
    el.vocExtra = extraEl;

    scheduleRender();
    return el;
  }

  /* ------------------------------------------------------------------ insight card */

  /**
   * Insight card with severity stripe, evidence line and a "Show me" drill button.
   * @param {{kind:string, title:string, text:string, evidence?:string, drill?:{view:string, filters?:Object, id?:string}|null, severity?:'info'|'warning'|'critical'|'good'}} card
   * @returns {HTMLElement}
   */
  function insightCard(card) {
    card = card || {};
    var sev = card.severity || 'info';
    var el = h('article', { class: 'insight-card insight-card--' + esc(sev), dataset: { kind: card.kind || '' } });
    el.appendChild(h('div', { class: 'insight-card__kind', text: String(card.kind || sev).replace(/_/g, ' ') }));
    el.appendChild(h('h3', { class: 'insight-card__title', text: card.title || '' }));
    if (card.text) el.appendChild(h('p', { class: 'insight-card__text', text: card.text }));
    if (card.evidence) el.appendChild(h('p', { class: 'insight-card__evidence', text: card.evidence }));
    if (card.drill && card.drill.view) {
      el.appendChild(h('button', {
        class: 'btn btn--link insight-card__drill', type: 'button',
        onclick: function () {
          if (VOC.store && typeof VOC.store.drill === 'function') { VOC.store.drill(card.drill); return; }
          if (VOC.router) VOC.router.navigate(card.drill.view, { id: card.drill.id || undefined });
        }
      }, 'Show me →'));
    }
    return el;
  }

  /* ------------------------------------------------------------------ table */

  function defaultCompare(a, b) {
    var an = a == null, bn = b == null;
    if (an && bn) return 0; if (an) return 1; if (bn) return -1;
    if (isNum(a) && isNum(b)) return a - b;
    if (a instanceof Date && b instanceof Date) return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  /**
   * Sortable, paginated data table with optional row selection.
   * Column: { key, label, render?(row, value) → string(HTML)|Node, sort?: boolean|((a,b)=>number), sortValue?(row), width?, align?:'left'|'right'|'center', className? }
   * @param {{columns:Array, rows:Array, pageSize?:number, sortKey?:string, sortDir?:'asc'|'desc', onRowClick?:function(row, Event),
   *          rowClass?:function(row):string, rowKey?:function(row):string, emptyText?:string, selectable?:boolean,
   *          onSelectionChange?:function(string[], Array), footer?:boolean, activeKey?:string, flat?:boolean}} opts
   * @returns {{el:HTMLElement, update:function(Array, {keepPage?:boolean, keepSelection?:boolean}=), selection:function():string[], selectedRows:function():Array,
   *            clearSelection:function(), setSort:function(string, string=), setActive:function(string|null), page:function():number, setPage:function(number), rows:function():Array}}
   */
  function table(opts) {
    opts = opts || {};
    var columns = (opts.columns || []).map(function (c) { return typeof c === 'string' ? { key: c, label: c } : c; });
    var rows = Array.isArray(opts.rows) ? opts.rows.slice() : [];
    var pageSize = isNum(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : 50;
    var sortKey = opts.sortKey || null;
    var sortDir = opts.sortDir || 'asc';
    var page = 0;
    var selected = new Set();
    var activeKey = opts.activeKey || null;
    var rowKey = typeof opts.rowKey === 'function' ? opts.rowKey : function (r, i) { return r && r.id != null ? String(r.id) : String(i); };
    var emptyText = opts.emptyText || 'No records match these filters.';
    var selectable = !!opts.selectable;
    var showFooter = opts.footer !== false;

    var wrap = h('div', { class: 'table-wrap' + (opts.flat ? ' table-wrap--flat' : '') });
    var tbl = h('table', { class: 'table' });
    var thead = h('thead'); var tbody = h('tbody');
    tbl.appendChild(thead); tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    var footer = h('div', { class: 'table__footer' });
    var footInfo = h('span', { class: 'table__info' });
    var footSel = h('span', { class: 'table__selection' });
    var pager = h('div', { class: 'table__pager' });
    var btnPrev = h('button', { class: 'btn btn--ghost btn--xs', type: 'button', 'aria-label': 'Previous page', onclick: function () { setPage(page - 1); } }, '‹');
    var pageLabel = h('span', { class: 'table__pager-page' });
    var btnNext = h('button', { class: 'btn btn--ghost btn--xs', type: 'button', 'aria-label': 'Next page', onclick: function () { setPage(page + 1); } }, '›');
    pager.appendChild(btnPrev); pager.appendChild(pageLabel); pager.appendChild(btnNext);
    footer.appendChild(h('span', {}, [footInfo, ' ', footSel]));
    footer.appendChild(pager);
    if (showFooter) wrap.appendChild(footer);

    var headerCheck = null;

    function sortedRows() {
      if (!sortKey) return rows;
      var col = columns.find(function (c) { return c.key === sortKey; });
      if (!col || col.sort === false) return rows;
      var cmp = typeof col.sort === 'function' ? col.sort : null;
      var val = typeof col.sortValue === 'function' ? col.sortValue : function (r) { return r ? r[sortKey] : null; };
      var dir = sortDir === 'desc' ? -1 : 1;
      return rows.slice().sort(function (a, b) {
        var r = cmp ? cmp(a, b) : defaultCompare(val(a), val(b));
        return r * dir;
      });
    }

    function pageCount() { return Math.max(1, Math.ceil(rows.length / pageSize)); }

    function renderHead() {
      thead.innerHTML = '';
      var tr = h('tr');
      if (selectable) {
        headerCheck = h('input', { type: 'checkbox', 'aria-label': 'Select all rows on this page' });
        headerCheck.addEventListener('change', function () {
          var visible = sortedRows().slice(page * pageSize, (page + 1) * pageSize);
          visible.forEach(function (r, i) { var k = rowKey(r, page * pageSize + i); if (headerCheck.checked) selected.add(k); else selected.delete(k); });
          renderBody(); emitSelection();
        });
        tr.appendChild(h('th', { class: 'table__check', scope: 'col' }, headerCheck));
      }
      columns.forEach(function (c) {
        var sortable = c.sort !== false;
        var text = c.label || c.key;
        // The <th> stays a columnheader (aria-sort is only valid there); the click/keyboard target is a real
        // <button> inside it, so screen readers hear "Urgency, column header, sorted ascending" and Enter/Space work natively.
        var th = h('th', {
          scope: 'col',
          class: [(c.align === 'right' ? 'num' : c.align === 'center' ? 'align-center' : ''), sortable ? 'is-sortable' : '', c.className || ''].filter(Boolean).join(' ') || null,
          style: c.width ? { width: typeof c.width === 'number' ? c.width + 'px' : c.width } : null,
          'aria-sort': sortKey === c.key ? (sortDir === 'desc' ? 'descending' : 'ascending') : (sortable ? 'none' : null)
        });
        if (sortable) {
          var toggle = function () { setSort(c.key, sortKey === c.key ? (sortDir === 'asc' ? 'desc' : 'asc') : (c.defaultDir || 'asc')); };
          var btn = h('button', { class: 'table__sortbtn', type: 'button', title: text ? 'Sort by ' + text : 'Sort' }, [
            text, h('span', { class: 'table__sort', 'aria-hidden': 'true', text: sortKey === c.key ? (sortDir === 'desc' ? '▼' : '▲') : '⇅' })
          ]);
          th.appendChild(btn);
          // One listener on the cell: the button's own click (mouse, Enter, Space) bubbles up to it.
          th.addEventListener('click', toggle);
        } else if (text) {
          th.appendChild(DOC().createTextNode(text));
        }
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }

    function cellContent(td, c, row) {
      var v = row ? row[c.key] : null;
      if (typeof c.render === 'function') {
        var out = c.render(row, v);
        if (out == null) td.textContent = '—';
        else if (typeof out === 'string' || typeof out === 'number') td.innerHTML = String(out);
        else td.appendChild(out);
      } else {
        td.textContent = v == null || v === '' ? '—' : (isNum(v) ? (v % 1 !== 0 ? fmtNum(v, 1) : fmtInt(v)) : String(v));
      }
    }

    function renderBody() {
      tbody.innerHTML = '';
      var all = sortedRows();
      var start = page * pageSize;
      var visible = all.slice(start, start + pageSize);
      if (!visible.length) {
        tbody.appendChild(h('tr', {}, h('td', { class: 'table__empty', colspan: String(columns.length + (selectable ? 1 : 0)), text: emptyText })));
      }
      visible.forEach(function (row, i) {
        var key = rowKey(row, start + i);
        var cls = ['is-clickable'];
        if (typeof opts.onRowClick !== 'function') cls = [];
        if (selected.has(key)) cls.push('is-selected');
        if (activeKey != null && key === activeKey) cls.push('is-active');
        if (typeof opts.rowClass === 'function') { var extra = opts.rowClass(row); if (extra) cls.push(extra); }
        var tr = h('tr', { class: cls.join(' ') || null, dataset: { key: key }, tabindex: typeof opts.onRowClick === 'function' ? '0' : null, 'aria-selected': selectable ? String(selected.has(key)) : null });
        if (selectable) {
          var cb = h('input', { type: 'checkbox', 'aria-label': 'Select row' });
          cb.checked = selected.has(key);
          cb.addEventListener('click', function (e) { e.stopPropagation(); });
          cb.addEventListener('change', function () { if (cb.checked) selected.add(key); else selected.delete(key); tr.classList.toggle('is-selected', cb.checked); tr.setAttribute('aria-selected', String(cb.checked)); syncHeaderCheck(); emitSelection(); });
          tr.appendChild(h('td', { class: 'table__check' }, cb));
        }
        columns.forEach(function (c) {
          var td = h('td', { class: [(c.align === 'right' ? 'num' : c.align === 'center' ? 'align-center' : ''), c.className || '', c.wrap ? 'wrap' : ''].filter(Boolean).join(' ') || null });
          cellContent(td, c, row);
          tr.appendChild(td);
        });
        if (typeof opts.onRowClick === 'function') {
          tr.addEventListener('click', function (e) {
            if (e.target.closest('button, a, input, select, textarea, label')) return;
            opts.onRowClick(row, e);
          });
          tr.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onRowClick(row, e); }
          });
        }
        tbody.appendChild(tr);
      });
      syncHeaderCheck();
      renderFooter(all.length, start, visible.length);
    }

    function syncHeaderCheck() {
      if (!headerCheck) return;
      var visible = sortedRows().slice(page * pageSize, (page + 1) * pageSize);
      var sel = visible.filter(function (r, i) { return selected.has(rowKey(r, page * pageSize + i)); }).length;
      headerCheck.checked = visible.length > 0 && sel === visible.length;
      headerCheck.indeterminate = sel > 0 && sel < visible.length;
    }

    function renderFooter(total, start, count) {
      if (!showFooter) return;
      footInfo.textContent = total ? ('Showing ' + fmtInt(start + 1) + '–' + fmtInt(start + count) + ' of ' + fmtInt(total)) : 'No rows';
      footSel.textContent = selected.size ? ('· ' + fmtInt(selected.size) + ' selected') : '';
      var pc = pageCount();
      pageLabel.textContent = 'Page ' + (page + 1) + ' of ' + pc;
      btnPrev.disabled = page <= 0;
      btnNext.disabled = page >= pc - 1;
      pager.hidden = pc <= 1;
    }

    function emitSelection() {
      if (typeof opts.onSelectionChange === 'function') opts.onSelectionChange(selection(), selectedRows());
    }

    function selection() { return Array.from(selected); }
    function selectedRows() {
      var keys = selected;
      return rows.filter(function (r, i) { return keys.has(rowKey(r, i)); });
    }
    function clearSelection() { selected.clear(); renderBody(); emitSelection(); }
    function setSort(key, dir) {
      sortKey = key; sortDir = dir || (sortDir === 'asc' ? 'desc' : 'asc');
      page = 0; renderHead(); renderBody();
    }
    function setPage(p) {
      page = Math.min(Math.max(0, p), pageCount() - 1);
      renderBody();
      if (wrap.scrollTop > 0) wrap.scrollTop = 0;
    }
    function update(newRows, o) {
      o = o || {};
      rows = Array.isArray(newRows) ? newRows.slice() : [];
      if (!o.keepSelection) {
        var keys = new Set(rows.map(function (r, i) { return rowKey(r, i); }));
        Array.from(selected).forEach(function (k) { if (!keys.has(k)) selected.delete(k); });
      }
      if (!o.keepPage) page = 0; else page = Math.min(page, pageCount() - 1);
      renderBody();
    }
    function setActive(key) {
      activeKey = key == null ? null : String(key);
      Array.prototype.forEach.call(tbody.children, function (tr) { tr.classList.toggle('is-active', tr.dataset.key === activeKey); });
    }

    renderHead();
    renderBody();

    return {
      el: wrap, update: update, selection: selection, selectedRows: selectedRows, clearSelection: clearSelection,
      setSort: setSort, setActive: setActive, page: function () { return page; }, setPage: setPage,
      rows: function () { return sortedRows(); }
    };
  }

  /* ------------------------------------------------------------------ focus trap (drawer + modal) */

  function trapKeydown(container, onEscape) {
    return function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEscape(); return; }
      if (e.key !== 'Tab') return;
      var f = focusables(container);
      if (!f.length) { e.preventDefault(); container.focus(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (DOC().activeElement === first || !container.contains(DOC().activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && DOC().activeElement === last) { e.preventDefault(); first.focus(); }
    };
  }

  /* ------------------------------------------------------------------ drawer */

  var drawerState = { open: false, el: null, backdrop: null, body: null, title: null, onClose: null, opener: null, keyHandler: null };

  function ensureDrawer() {
    if (drawerState.el) return;
    var root = rootFor('drawer-root');
    var backdrop = h('div', { class: 'drawer-backdrop', onclick: function () { drawerClose(); } });
    var title = h('h2', { class: 'drawer__title', id: 'drawer-title' });
    var closeBtn = h('button', { class: 'icon-btn drawer__close', type: 'button', 'aria-label': 'Close panel', html: ICON.close, onclick: function () { drawerClose(); } });
    var body = h('div', { class: 'drawer__body' });
    var el = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title', tabindex: '-1' }, [
      h('header', { class: 'drawer__header' }, [title, closeBtn]), body
    ]);
    root.appendChild(backdrop); root.appendChild(el);
    drawerState.el = el; drawerState.backdrop = backdrop; drawerState.body = body; drawerState.title = title;
  }

  /**
   * Open the drawer (right 60% on desktop, full-screen sheet on phone) with focus trap; Esc and backdrop close it.
   * @param {HTMLElement|string} contentEl
   * @param {{title?:string, onClose?:function, narrow?:boolean, footer?:HTMLElement}} [opts]
   */
  function drawerOpen(contentEl, opts) {
    opts = opts || {};
    ensureDrawer();
    var s = drawerState;
    // Re-populating an open drawer with the same onClose (a view re-rendering its own record) is not a close, so
    // the previous callback must not run; only a different opener replacing the content retires the old one.
    if (s.open && typeof s.onClose === 'function' && s.onClose !== opts.onClose) { var prev = s.onClose; s.onClose = null; prev(); }
    s.onClose = opts.onClose || null;
    if (!s.open) s.opener = DOC().activeElement;
    s.title.textContent = opts.title || '';
    s.body.innerHTML = '';
    if (typeof contentEl === 'string') s.body.innerHTML = contentEl; else if (contentEl) s.body.appendChild(contentEl);
    var oldFoot = s.el.querySelector('.drawer__footer');
    if (oldFoot) oldFoot.remove();
    if (opts.footer) s.el.appendChild(h('div', { class: 'drawer__footer' }, opts.footer));
    s.el.classList.toggle('drawer--narrow', !!opts.narrow);
    s.el.classList.add('is-open'); s.backdrop.classList.add('is-open');
    DOC().body.classList.add('has-drawer');
    if (!s.open) {
      s.keyHandler = trapKeydown(s.el, drawerClose);
      DOC().addEventListener('keydown', s.keyHandler, true);
    }
    s.open = true;
    var f = focusables(s.body);
    var target = f.length ? f[0] : s.el.querySelector('.drawer__close');
    if (target) setTimeout(function () { target.focus({ preventScroll: true }); }, reducedMotion() ? 0 : 60);
  }

  /** Close the drawer, run onClose once and return focus to the opener. */
  function drawerClose() {
    var s = drawerState;
    if (!s.open) return;
    s.open = false;
    s.el.classList.remove('is-open'); s.backdrop.classList.remove('is-open');
    DOC().body.classList.remove('has-drawer');
    if (s.keyHandler) { DOC().removeEventListener('keydown', s.keyHandler, true); s.keyHandler = null; }
    var cb = s.onClose; s.onClose = null;
    var opener = s.opener; s.opener = null;
    setTimeout(function () { if (!s.open) s.body.innerHTML = ''; }, reducedMotion() ? 0 : 180);
    if (typeof cb === 'function') cb();
    if (opener && typeof opener.focus === 'function' && DOC().contains(opener)) opener.focus({ preventScroll: true });
  }

  var drawer = {
    open: drawerOpen,
    close: drawerClose,
    isOpen: function () { return drawerState.open; },
    setTitle: function (t) { if (drawerState.title) drawerState.title.textContent = t || ''; },
    body: function () { return drawerState.body; }
  };

  /* ------------------------------------------------------------------ confirm */

  /**
   * Modal confirmation. Resolves true on confirm, false on cancel/Esc/backdrop.
   * @param {{title:string, text?:string, confirmLabel?:string, cancelLabel?:string, danger?:boolean}} opts
   * @returns {Promise<boolean>}
   */
  function confirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var root = rootFor('modal-root');
      var opener = DOC().activeElement;
      var done = false;
      function finish(v) {
        if (done) return; done = true;
        DOC().removeEventListener('keydown', keyHandler, true);
        backdrop.remove();
        if (opener && typeof opener.focus === 'function' && DOC().contains(opener)) opener.focus({ preventScroll: true });
        resolve(v);
      }
      var cancelBtn = h('button', { class: 'btn', type: 'button', onclick: function () { finish(false); } }, opts.cancelLabel || 'Cancel');
      var okBtn = h('button', { class: 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary'), type: 'button', onclick: function () { finish(true); } }, opts.confirmLabel || 'Confirm');
      var modal = h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title', tabindex: '-1' }, [
        h('h2', { class: 'modal__title', id: 'modal-title', text: opts.title || 'Are you sure?' }),
        opts.text ? h('p', { class: 'modal__text', text: opts.text }) : null,
        h('div', { class: 'modal__actions' }, [cancelBtn, okBtn])
      ]);
      var backdrop = h('div', { class: 'modal-backdrop', onclick: function (e) { if (e.target === backdrop) finish(false); } }, modal);
      var keyHandler = trapKeydown(modal, function () { finish(false); });
      DOC().addEventListener('keydown', keyHandler, true);
      root.appendChild(backdrop);
      (opts.danger ? cancelBtn : okBtn).focus();
    });
  }

  /* ------------------------------------------------------------------ drop zone */

  /**
   * Turn an element into a file drop zone (drag-over state, click/keyboard to browse).
   * @param {HTMLElement} el
   * @param {function(FileList)} onFiles
   * @param {{accept?:string, hint?:string, multiple?:boolean}} [opts]
   * @returns {HTMLElement} el
   */
  function dropZone(el, onFiles, opts) {
    opts = opts || {};
    var accept = opts.accept || '.eml,.mbox,.csv,.json';
    el.classList.add('dropzone');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Import files: drop here or press Enter to browse');
    el.innerHTML = '';
    var input = h('input', { type: 'file', accept: accept, multiple: opts.multiple === false ? null : true });
    el.appendChild(h('div', { class: 'dropzone__icon', 'aria-hidden': 'true', html: ICON.upload }));
    el.appendChild(h('div', { class: 'dropzone__hint', text: opts.hint || 'Drop mail exports here or click to choose files. Everything stays in this browser.' }));
    el.appendChild(h('div', { class: 'dropzone__accept', text: 'Accepts ' + accept.split(',').join(', ') }));
    el.appendChild(input);

    function emit(files) { if (files && files.length && typeof onFiles === 'function') onFiles(files); }
    input.addEventListener('change', function () { emit(input.files); input.value = ''; });
    el.addEventListener('click', function (e) { if (e.target !== input) input.click(); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) {
      el.addEventListener(ev, function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('is-over'); });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      el.addEventListener(ev, function (e) { if (!el.contains(e.relatedTarget)) el.classList.remove('is-over'); });
    });
    el.addEventListener('drop', function (e) { e.preventDefault(); el.classList.remove('is-over'); emit(e.dataTransfer && e.dataTransfer.files); });
    return el;
  }

  /* ------------------------------------------------------------------ view header */

  /**
   * Shared top-of-view block: title (display face), one-line meta, an actions slot and a bold one-sentence lead.
   * The element exposes setMeta(text), setLead(text) and setActions(nodes) so update() can refresh it in place;
   * the meta keeps data-role="subtitle" for views that already query it.
   * @param {{title:string, meta?:string, lead?:string, actions?:(HTMLElement|HTMLElement[]|null), level?:number}} opts
   * @returns {HTMLElement} <header class="view-header">
   */
  function viewHeader(opts) {
    opts = opts || {};
    var title = h('h1', { class: 'view-title', text: opts.title || '' });
    var meta = h('p', { class: 'view-meta', 'data-role': 'subtitle', text: opts.meta || '' });
    var text = h('div', { class: 'view-header__text' }, [title, meta]);
    var actions = h('div', { class: 'view-actions view-header__actions', 'data-role': 'header-actions' });
    var lead = h('p', { class: 'view-lead', 'data-role': 'lead', 'aria-live': 'polite' });
    var row = h('div', { class: 'view-header__row' }, [text, actions]);
    var el = h('header', { class: 'view-header' }, [row, lead]);
    function setActions(nodes) {
      actions.innerHTML = '';
      appendChildren(actions, nodes);
      actions.hidden = !actions.childNodes.length;
    }
    function setLead(t) {
      var v = t == null ? '' : String(t).trim();
      lead.textContent = v;
      lead.hidden = !v;
    }
    function setMeta(t) { meta.textContent = t == null ? '' : String(t); }
    setActions(opts.actions || null);
    setLead(opts.lead || '');
    el.vocTitle = title; el.vocMeta = meta; el.vocLead = lead; el.vocActions = actions;
    el.setMeta = setMeta; el.setLead = setLead; el.setActions = setActions;
    return el;
  }

  /**
   * Collapsed "How this works" block for the explanations that used to open a view as prose.
   * @param {{summary?:string, body?:(HTMLElement|HTMLElement[]|string|null), html?:string, open?:boolean, className?:string}} opts
   * @returns {HTMLElement} <details class="how">
   */
  function howDetails(opts) {
    opts = opts || {};
    var body = h('div', { class: 'how__body' });
    if (opts.html) body.innerHTML = opts.html;
    else if (typeof opts.body === 'string') body.appendChild(h('p', { text: opts.body }));
    else appendChildren(body, opts.body || null);
    return h('details', { class: 'how' + (opts.className ? ' ' + opts.className : ''), open: opts.open ? true : null }, [
      h('summary', { class: 'how__summary' }, opts.summary || 'How this works'),
      body
    ]);
  }

  /* ------------------------------------------------------------------ exports */

  VOC.ui = {
    kpiTile: kpiTile,
    chartCard: chartCard,
    insightCard: insightCard,
    viewHeader: viewHeader,
    howDetails: howDetails,
    pill: pill,
    table: table,
    drawer: drawer,
    toast: toast,
    popover: popover,
    closePopover: closePopover,
    emptyState: emptyState,
    confirm: confirm,
    dropZone: dropZone,
    formatValue: formatValue,
    h: h,
    esc: esc,
    downloadText: downloadText,
    toCsv: toCsv,
    icons: ICON
  };
})();
