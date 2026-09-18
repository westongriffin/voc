/* L-Nutra · Voice of the Customer — application shell (SPEC §4.12, §5 common chrome)
   boot(): theme → store.init → nav → filter bar → router → header widgets → keyboard.
   Every teammate call is guarded so the shell boots with modules missing (and says which). */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAV_GROUPS = [
    { heading: 'Report', items: ['briefing', 'trends', 'themes', 'products', 'customers'] },
    { heading: 'Operate', items: ['inbox', 'regulatory', 'alerts'] },
    { heading: 'Lab', items: ['predict', 'reports', 'methods', 'settings'] }
  ];
  var PHONE_TABS = ['briefing', 'inbox', 'themes', 'alerts'];
  var SHORTCUTS = { b: 'briefing', i: 'inbox', t: 'trends', h: 'themes', p: 'products', c: 'customers', a: 'alerts', l: 'predict', r: 'reports', s: 'settings', e: 'regulatory', m: 'methods' };
  var EXPECTED_MODULES = ['util', 'db', 'lexicon', 'rules', 'classify', 'store', 'analytics', 'metrics', 'predict', 'alerts', 'narrate', 'charts', 'ui', 'mime', 'importers', 'exporter', 'connector', 'report', 'router'];
  var RANGE_PRESETS = [['7d', '7d'], ['30d', '30d'], ['90d', '90d'], ['12m', '12m'], ['custom', 'Custom']];
  var COMPARE_OPTIONS = [['prior_period', 'vs prior period'], ['prior_year', 'vs prior year'], ['none', 'No comparison']];
  var FILTER_CHIPS = [
    { key: 'product', label: 'Product', enumKey: 'PRODUCTS' },
    { key: 'category', label: 'Category', enumKey: 'CATEGORIES' },
    { key: 'channel', label: 'Channel', enumKey: 'CHANNELS' },
    { key: 'segment', label: 'Segment', enumKey: 'SEGMENTS' },
    { key: 'sentiment', label: 'Sentiment', options: [{ id: 'positive', label: 'Positive' }, { id: 'neutral', label: 'Neutral' }, { id: 'negative', label: 'Negative' }, { id: 'unscored', label: 'Unscored' }] },
    { key: 'status', label: 'Status', enumKey: 'STATUSES' },
    { key: 'urgency', label: 'Urgency', enumKey: 'URGENCY' }
  ];
  var SINGULAR = { PRODUCTS: 'product', CATEGORIES: 'category', CHANNELS: 'channel', SEGMENTS: 'segment', STATUSES: 'status', URGENCY: 'urgency', SALES_CHANNELS: 'sales_channel', REGIONS: 'region' };

  var STROKE = ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  var ICONS = {
    briefing: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>',
    inbox: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M4 5h16v14H4zM4 13h5l1.5 2.5h3L15 13h5"/></svg>',
    trends: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M4 19h16M5 15l4-5 4 3 6-7"/></svg>',
    themes: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>',
    products: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M4 8l8-4 8 4-8 4-8-4zM4 8v8l8 4 8-4V8M12 12v8"/></svg>',
    customers: '<svg viewBox="0 0 24 24"' + STROKE + '><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 5.5a3 3 0 0 1 0 5.5M17 13.5a5 5 0 0 1 3.5 5.5"/></svg>',
    regulatory: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6zM9 12l2 2 4-4"/></svg>',
    predict: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M8 15h8"/></svg>',
    alerts: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/></svg>',
    reports: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/></svg>',
    methods: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3zM5 4v16M9 8h6M9 12h6"/></svg>',
    settings: '<svg viewBox="0 0 24 24"' + STROKE + '><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>',
    more: '<svg viewBox="0 0 24 24"' + STROKE + '><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></svg>',
    sun: '<svg viewBox="0 0 24 24"' + STROKE + '><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    auto: '<svg viewBox="0 0 24 24"' + STROKE + '><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>',
    filter: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
    caret: '<svg viewBox="0 0 24 24"' + STROKE + '><path d="m6 9 6 6 6-6"/></svg>'
  };

  var state = {
    booted: false,
    theme: 'system',
    currentName: null,
    currentView: null,
    routing: false,
    pendingG: false,
    gTimer: null,
    bars: [],
    missing: [],
    errorsShown: {},
    mediaQuery: null
  };

  /* ------------------------------------------------------------------ helpers */

  function byId(id) { return document.getElementById(id); }
  function ui() { return VOC.ui || null; }
  function store() { return VOC.store || null; }
  function router() { return VOC.router || null; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function el(tag, attrs, children) {
    if (ui() && ui().h) return ui().h(tag, attrs, children);
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    });
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }

  function esc(s) {
    if (ui() && ui().esc) return ui().esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function toast(msg, kind, opts) {
    if (ui() && ui().toast) return ui().toast(msg, kind, opts);
    return null;
  }

  function fmtInt(n) {
    if (VOC.util && VOC.util.fmt && VOC.util.fmt.int) return VOC.util.fmt.int(n);
    return new Intl.NumberFormat('en-US').format(Math.round(n));
  }

  function fmtDay(dateOrIso) {
    var iso = dateOrIso instanceof Date ? dateOrIso.toISOString() : dateOrIso;
    if (VOC.util && VOC.util.fmt && VOC.util.fmt.date) {
      try { return VOC.util.fmt.date(iso, 'day'); } catch (e) { /* fall through */ }
    }
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }).format(d);
  }

  function fmtRange(from, to) {
    if (VOC.util && VOC.util.fmt && VOC.util.fmt.range) {
      try { return VOC.util.fmt.range(from, to); } catch (e) { /* fall through */ }
    }
    var a = new Date(from + 'T12:00:00Z'), b = new Date(to + 'T12:00:00Z');
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return from + ' – ' + to;
    var sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    var f1 = new Intl.DateTimeFormat('en-US', sameYear ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    var f2 = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return f1.format(a) + ' – ' + f2.format(b);
  }

  function debounce(fn, ms) {
    if (VOC.util && typeof VOC.util.debounce === 'function') return VOC.util.debounce(fn, ms);
    var t = null;
    return function () { var args = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, args); }, ms); };
  }

  /** Report a teammate failure once per message, through a toast rather than the console. */
  function reportError(context, err) {
    var msg = context + ': ' + (err && err.message ? err.message : String(err));
    if (state.errorsShown[msg]) return;
    state.errorsShown[msg] = true;
    toast(msg, 'critical', { ms: 12000 });
  }

  function safe(context, fn, fallback) {
    try { return fn(); } catch (e) { reportError(context, e); return fallback; }
  }

  /** Resolve enum options robustly against whatever shape util.js exposes. */
  function enumList(key) {
    var e = VOC.enums;
    if (!e) return [];
    var candidates = [key, SINGULAR[key] || key.toLowerCase(), key.toLowerCase()];
    if (typeof e.list === 'function') {
      for (var i = 0; i < candidates.length; i++) {
        try {
          var r = e.list(candidates[i]);
          if (Array.isArray(r) && r.length) return r.map(normalizeOpt);
        } catch (err) { /* try next */ }
      }
    }
    var raw = e[key];
    if (Array.isArray(raw)) return raw.map(normalizeOpt);
    if (raw && typeof raw === 'object') return Object.keys(raw).map(function (id) { return { id: id, label: typeof raw[id] === 'string' ? raw[id] : (raw[id] && raw[id].label) || id }; });
    return [];
  }
  function normalizeOpt(x) {
    if (typeof x === 'string') return { id: x, label: x };
    return { id: x.id != null ? x.id : x.value, label: x.label || x.id || x.value };
  }
  function optionLabel(chip, id) {
    var opts = chip.options || enumList(chip.enumKey);
    var hit = opts.find(function (o) { return o.id === id; });
    if (hit) return hit.label;
    if (VOC.enums && typeof VOC.enums.label === 'function' && chip.enumKey) {
      try { var l = VOC.enums.label(chip.enumKey, id); if (l) return l; } catch (e) { /* fall through */ }
    }
    return String(id);
  }

  function getFilters() {
    var s = store();
    if (s && typeof s.filters === 'function') return safe('Filters', function () { return s.filters(); }, null) || {};
    return {};
  }
  function setFilters(patch) {
    var s = store();
    if (s && typeof s.setFilters === 'function') safe('Filters', function () { s.setFilters(patch); });
  }
  function getDerived() {
    var s = store();
    if (s && typeof s.derived === 'function') return safe('Derived state', function () { return s.derived(); }, null);
    return null;
  }
  function currentN(derived) {
    if (derived && isNum(derived.n)) return derived.n;
    var s = store();
    if (s && typeof s.filtered === 'function') { var f = safe('Filtered records', function () { return s.filtered(); }, null); if (Array.isArray(f)) return f.length; }
    return null;
  }

  /* ------------------------------------------------------------------ theme */

  function readStoredTheme() {
    try { var t = window.localStorage.getItem('voc.theme'); if (t === 'light' || t === 'dark' || t === 'system') return t; } catch (e) { /* unavailable */ }
    return 'system';
  }
  function settingsTheme() {
    var s = store();
    if (s && typeof s.settings === 'function') {
      var st = safe('Settings', function () { return s.settings(); }, null);
      if (st && (st.theme === 'light' || st.theme === 'dark' || st.theme === 'system')) return st.theme;
    }
    return null;
  }
  function effectiveTheme() {
    if (state.theme === 'light' || state.theme === 'dark') return state.theme;
    return (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function applyThemeAttr(mode) {
    var root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode); else root.removeAttribute('data-theme');
    try { window.localStorage.setItem('voc.theme', mode); } catch (e) { /* unavailable */ }
    var btn = byId('theme-toggle');
    if (btn) {
      var label = 'Theme: ' + mode + (mode === 'system' ? ' (' + effectiveTheme() + ')' : '');
      btn.innerHTML = ICONS[mode === 'system' ? 'auto' : mode === 'dark' ? 'moon' : 'sun'];
      btn.setAttribute('aria-label', label);
      btn.title = label + ' — click to change';
    }
    if (VOC.charts && typeof VOC.charts.rethemeAll === 'function') safe('Chart retheme', function () { VOC.charts.rethemeAll(); });
  }

  /**
   * Set the theme mode, persist it to settings and localStorage, and retheme charts.
   * @param {'system'|'light'|'dark'} mode
   */
  function setTheme(mode) {
    if (mode !== 'light' && mode !== 'dark') mode = 'system';
    state.theme = mode;
    applyThemeAttr(mode);
    var s = store();
    if (s && typeof s.setSettings === 'function') {
      var cur = settingsTheme();
      if (cur !== mode) safe('Settings', function () { s.setSettings({ theme: mode }); });
    }
  }

  function bindThemeToggle() {
    var btn = byId('theme-toggle');
    if (btn) btn.addEventListener('click', function () {
      var order = ['system', 'light', 'dark'];
      setTheme(order[(order.indexOf(state.theme) + 1) % order.length]);
    });
    if (typeof window.matchMedia === 'function') {
      state.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (state.theme === 'system') applyThemeAttr('system'); };
      if (state.mediaQuery.addEventListener) state.mediaQuery.addEventListener('change', onChange);
      else if (state.mediaQuery.addListener) state.mediaQuery.addListener(onChange);
    }
  }

  /* ------------------------------------------------------------------ navigation */

  function viewOrder() {
    var names = [];
    NAV_GROUPS.forEach(function (g) { g.items.forEach(function (n) { if (VOC.views[n]) names.push(n); }); });
    Object.keys(VOC.views).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    return names;
  }
  function iconFor(name) {
    var v = VOC.views[name] || {};
    var ic = v.icon;
    if (typeof ic === 'string' && ic.indexOf('<svg') === 0) return ic;
    if (typeof ic === 'string' && ICONS[ic]) return ICONS[ic];
    if (ICONS[name]) return ICONS[name];
    return '<span aria-hidden="true">' + esc(ic || '•') + '</span>';
  }
  function shortcutFor(name) {
    var k = Object.keys(SHORTCUTS).find(function (key) { return SHORTCUTS[key] === name; });
    return k ? 'g ' + k : '';
  }
  function navHref(name) {
    var r = router();
    return r ? r.build(name) : '#/' + name;
  }

  function renderNav() {
    var rail = byId('rail'), tabbar = byId('tabbar');
    if (rail) {
      rail.innerHTML = '';
      NAV_GROUPS.forEach(function (g) {
        var items = g.items.filter(function (n) { return VOC.views[n]; });
        if (!items.length) return;
        var group = el('div', { class: 'rail__group' }, el('div', { class: 'rail__heading label', text: g.heading }));
        items.forEach(function (n) {
          var v = VOC.views[n];
          var link = el('a', { class: 'rail__link', href: navHref(n), 'data-route': n, title: v.title || n }, [
            el('span', { html: iconFor(n), 'aria-hidden': 'true', class: 'rail__icon' }),
            el('span', { class: 'rail__label', text: v.title || n }),
            el('span', { class: 'rail__count', 'data-count': n, hidden: true }),
            shortcutFor(n) ? el('span', { class: 'rail__key', 'aria-hidden': 'true', text: shortcutFor(n) }) : null
          ]);
          group.appendChild(link);
        });
        rail.appendChild(group);
      });
      var extra = viewOrder().filter(function (n) { return !NAV_GROUPS.some(function (g) { return g.items.indexOf(n) >= 0; }); });
      if (extra.length) {
        var more = el('div', { class: 'rail__group' }, el('div', { class: 'rail__heading label', text: 'More' }));
        extra.forEach(function (n) {
          more.appendChild(el('a', { class: 'rail__link', href: navHref(n), 'data-route': n }, [el('span', { html: iconFor(n), 'aria-hidden': 'true' }), el('span', { class: 'rail__label', text: VOC.views[n].title || n })]));
        });
        rail.appendChild(more);
      }
    }
    if (tabbar) {
      tabbar.innerHTML = '';
      PHONE_TABS.forEach(function (n) {
        if (!VOC.views[n]) return;
        tabbar.appendChild(el('a', { class: 'tabbar__link', href: navHref(n), 'data-route': n }, [
          el('span', { html: iconFor(n), 'aria-hidden': 'true' }), el('span', { text: VOC.views[n].title || n })
        ]));
      });
      tabbar.appendChild(el('button', { class: 'tabbar__link', type: 'button', 'data-route': '__more', onclick: openMoreMenu }, [
        el('span', { html: ICONS.more, 'aria-hidden': 'true' }), el('span', { text: 'More' })
      ]));
    }
  }

  function openMoreMenu() {
    if (!ui() || !ui().drawer) return;
    var list = el('nav', { class: 'menu-list', 'aria-label': 'All views' });
    var cur = router() && router().current();
    viewOrder().forEach(function (n) {
      var v = VOC.views[n];
      list.appendChild(el('a', {
        class: 'menu-list__item', href: navHref(n), 'aria-current': cur && cur.name === n ? 'page' : null,
        onclick: function () { ui().drawer.close(); }
      }, [el('span', { html: iconFor(n), 'aria-hidden': 'true' }), el('span', { text: v.title || n })]));
    });
    ui().drawer.open(list, { title: 'All views' });
  }

  function setActiveNav(name) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-route]'), function (a) {
      var isCurrent = a.getAttribute('data-route') === name;
      if (isCurrent) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var moreBtn = document.querySelector('[data-route="__more"]');
    if (moreBtn && PHONE_TABS.indexOf(name) < 0) moreBtn.setAttribute('aria-current', 'page');
  }

  function updateNavCounts(derived) {
    if (!derived) return;
    var counts = {};
    var kpi = derived.kpis && derived.kpis.open_p0_p1;
    if (kpi && isNum(kpi.value)) counts.inbox = kpi.value;
    if (Array.isArray(derived.alerts)) counts.alerts = derived.alerts.filter(function (a) { return a && !a.acked && a.severity !== 'info'; }).length;
    Array.prototype.forEach.call(document.querySelectorAll('.rail__count'), function (b) {
      var c = counts[b.getAttribute('data-count')];
      if (isNum(c) && c > 0) { b.textContent = c > 99 ? '99+' : String(c); b.hidden = false; } else { b.hidden = true; }
    });
  }

  /* ------------------------------------------------------------------ filter bar */

  function activeChipCount(f) {
    return FILTER_CHIPS.reduce(function (acc, c) { return acc + (Array.isArray(f[c.key]) ? f[c.key].length : 0); }, 0) + (f.search ? 1 : 0) + (f.customer ? 1 : 0);
  }
  /** Chip label for the `customer` filter: display name resolved locally from the store, redacted while the record must stay hidden. */
  function customerChipLabel(id, f) {
    var s = store();
    var c = s && typeof s.customer === 'function' ? safe('Customer lookup', function () { return s.customer(id); }, null) : null;
    var settings = s && typeof s.settings === 'function' ? safe('Settings', function () { return s.settings(); }, null) : null;
    var redact = !!(c && c.restricted) && !(settings && settings.redactRestricted === false) && !(f && f.restrictedQueue);
    if (redact) return 'Restricted customer';
    return (c && (c.display_name || c.email)) || id;
  }

  /** Build one filter bar instance into `container`. Returns { refresh() }. */
  function buildBar(container) {
    var f = getFilters();
    var row = el('div', { class: 'filter-bar__row' });
    var chipsRow = el('div', { class: 'filter-bar__chips' });
    var pushFilters = debounce(setFilters, 120);

    /* Range presets */
    var seg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Date range' });
    var presetBtns = {};
    RANGE_PRESETS.forEach(function (p) {
      var b = el('button', { type: 'button', 'aria-pressed': 'false', 'data-preset': p[0], text: p[1] });
      b.addEventListener('click', function () {
        var cur = getFilters().range || {};
        var patch = { preset: p[0] };
        if (p[0] === 'custom') {
          patch.from = cur.from || defaultFrom(); patch.to = cur.to || defaultTo();
        }
        setFilters({ range: Object.assign({}, cur, patch) });
      });
      presetBtns[p[0]] = b;
      seg.appendChild(b);
    });
    row.appendChild(el('div', { class: 'filter-bar__group' }, seg));

    var dateFrom = el('input', { type: 'date', class: 'date-input', 'aria-label': 'From date' });
    var dateTo = el('input', { type: 'date', class: 'date-input', 'aria-label': 'To date' });
    var dates = el('div', { class: 'filter-bar__group', hidden: true }, [dateFrom, el('span', { class: 'muted', text: '–' }), dateTo]);
    function onDates() {
      if (!dateFrom.value || !dateTo.value) return;
      var from = dateFrom.value, to = dateTo.value;
      if (from > to) { var t = from; from = to; to = t; }
      pushFilters({ range: { preset: 'custom', from: from, to: to } });
    }
    dateFrom.addEventListener('change', onDates); dateTo.addEventListener('change', onDates);
    row.appendChild(dates);

    /* Compare */
    var compare = el('select', { class: 'select', 'aria-label': 'Comparison period' });
    COMPARE_OPTIONS.forEach(function (o) { compare.appendChild(el('option', { value: o[0], text: o[1] })); });
    compare.addEventListener('change', function () { setFilters({ compare: compare.value }); });
    row.appendChild(el('div', { class: 'filter-bar__group' }, compare));
    row.appendChild(el('span', { class: 'filter-bar__sep', 'aria-hidden': 'true' }));

    /* Multi-select chips */
    var chipBtns = {};
    FILTER_CHIPS.forEach(function (chip) {
      var count = el('span', { class: 'chip__count', hidden: true });
      var btn = el('button', { class: 'chip', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-filter': chip.key }, [
        el('span', { text: chip.label }), count, el('span', { class: 'chip__caret', html: ICONS.caret, 'aria-hidden': 'true' })
      ]);
      btn.addEventListener('click', function () { openChipPopover(btn, chip); });
      chipBtns[chip.key] = { btn: btn, count: count };
      row.appendChild(btn);
    });

    row.appendChild(el('span', { class: 'filter-bar__spacer' }));
    var nBadge = el('span', { class: 'filter-bar__n', 'aria-live': 'polite' });
    row.appendChild(nBadge);
    var reset = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Reset' });
    reset.addEventListener('click', function () {
      var s = store();
      if (s && typeof s.resetFilters === 'function') safe('Reset filters', function () { s.resetFilters(); });
      var search = byId('global-search'); if (search) search.value = '';
    });
    row.appendChild(reset);

    container.appendChild(row);
    container.appendChild(chipsRow);

    function openChipPopover(btn, chip) {
      if (!ui() || !ui().popover) return;
      var opts = (chip.options || enumList(chip.enumKey)).slice();
      var selected = new Set((getFilters()[chip.key] || []).map(String));
      // Ids the taxonomy does not list (imported data, an old link or saved view) stay checkable so they can be cleared
      // here instead of silently filtering the table from an invisible chip.
      selected.forEach(function (id) {
        if (!opts.some(function (o) { return String(o.id) === id; })) opts.push({ id: id, label: optionLabel(chip, id), unknown: true });
      });
      var list = el('div', { class: 'popover__list', role: 'group', 'aria-label': chip.label });
      if (!opts.length) list.appendChild(el('div', { class: 'muted', text: 'No options available yet.' }));
      opts.forEach(function (o) {
        var cb = el('input', { type: 'checkbox', value: String(o.id) });
        cb.checked = selected.has(String(o.id));
        cb.addEventListener('change', function () {
          if (cb.checked) selected.add(String(o.id)); else selected.delete(String(o.id));
          var patch = {}; patch[chip.key] = Array.from(selected);
          pushFilters(patch);
        });
        var lbl = el('label', { class: 'popover__option', title: o.unknown ? 'Not in the current taxonomy (kept from imported data or a link)' : null }, [cb, el('span', { text: o.label })]);
        if (o.unknown) lbl.appendChild(el('span', { class: 'muted t-12', text: ' · not in taxonomy' }));
        if (chip.key === 'urgency' && !o.unknown) lbl.appendChild(el('span', { class: 'pill pill--' + esc(o.id) + ' pill--plain', text: String(o.id) }));
        list.appendChild(lbl);
      });
      var actions = el('div', { class: 'popover__actions' }, [
        el('button', { class: 'btn btn--ghost btn--xs', type: 'button', onclick: function () { var patch = {}; patch[chip.key] = []; setFilters(patch); ui().closePopover(); } }, 'Clear'),
        el('button', { class: 'btn btn--xs', type: 'button', onclick: function () { ui().closePopover(); btn.focus(); } }, 'Done')
      ]);
      var content = el('div', {}, [el('div', { class: 'popover__title', text: chip.label }), list, actions]);
      ui().popover(btn, content);
    }

    function defaultFrom() {
      var s = store();
      var now = s && typeof s.now === 'function' ? safe('Clock', function () { return s.now(); }, new Date()) : new Date();
      var d = new Date(now.getTime() - 29 * 86400000);
      return d.toISOString().slice(0, 10);
    }
    function defaultTo() {
      var s = store();
      var now = s && typeof s.now === 'function' ? safe('Clock', function () { return s.now(); }, new Date()) : new Date();
      return now.toISOString().slice(0, 10);
    }

    function refresh(derived) {
      var cur = getFilters();
      var r = cur.range || {};
      Object.keys(presetBtns).forEach(function (k) { presetBtns[k].setAttribute('aria-pressed', String(r.preset === k)); });
      dates.hidden = r.preset !== 'custom';
      if (r.preset === 'custom') { if (r.from && dateFrom.value !== r.from) dateFrom.value = r.from; if (r.to && dateTo.value !== r.to) dateTo.value = r.to; }
      if (cur.compare && compare.value !== cur.compare) compare.value = cur.compare;
      FILTER_CHIPS.forEach(function (chip) {
        var vals = Array.isArray(cur[chip.key]) ? cur[chip.key] : [];
        var c = chipBtns[chip.key];
        c.count.textContent = String(vals.length); c.count.hidden = vals.length === 0;
        c.btn.classList.toggle('chip--active', vals.length > 0);
      });
      var n = currentN(derived);
      nBadge.innerHTML = isNum(n) ? 'n = <b>' + esc(fmtInt(n)) + '</b> ' + (n === 1 ? 'record' : 'records') : '';
      chipsRow.innerHTML = '';
      FILTER_CHIPS.forEach(function (chip) {
        (Array.isArray(cur[chip.key]) ? cur[chip.key] : []).forEach(function (id) {
          chipsRow.appendChild(valueChip(chip.label, optionLabel(chip, id), function () {
            var patch = {}; patch[chip.key] = cur[chip.key].filter(function (x) { return x !== id; }); setFilters(patch);
          }));
        });
      });
      if (cur.search) chipsRow.appendChild(valueChip('Search', '“' + cur.search + '”', function () { setFilters({ search: '' }); var s = byId('global-search'); if (s) s.value = ''; }));
      if (cur.restrictedQueue) chipsRow.appendChild(valueChip('Queue', 'Restricted', function () { setFilters({ restrictedQueue: false }); }));
      if (cur.customer) chipsRow.appendChild(valueChip('Customer', customerChipLabel(cur.customer, cur), function () { setFilters({ customer: null }); }));
      reset.disabled = !activeChipCount(cur) && !cur.restrictedQueue && (!r.preset || r.preset === '30d') && (!cur.compare || cur.compare === 'prior_period');
    }

    function valueChip(dim, label, onRemove) {
      var x = el('button', { class: 'chip__x', type: 'button', 'aria-label': 'Remove ' + dim + ' ' + label, html: '&times;' });
      x.addEventListener('click', onRemove);
      return el('span', { class: 'chip chip--value' }, [el('span', { class: 'chip__dim', text: dim + ':' }), el('span', { text: label }), x]);
    }

    refresh(getDerived());
    return { refresh: refresh, el: container };
  }

  /**
   * Render the global filter bar (desktop row + phone "Filters" sheet toggle), bound to VOC.store.
   */
  function renderFilterBar() {
    var host = byId('filter-bar');
    if (!host) return;
    host.innerHTML = '';
    state.bars = [];
    var inner = el('div', { class: 'filter-bar__inner' });
    host.appendChild(inner);
    if (!store()) {
      inner.appendChild(el('div', { class: 'filter-bar__row muted t-13', text: 'Filters appear once the data store loads.' }));
      return;
    }
    /* Phone toggle row */
    var toggleN = el('span', { class: 'filter-bar__n' });
    var toggleBtn = el('button', { class: 'chip', type: 'button' }, [el('span', { html: ICONS.filter, 'aria-hidden': 'true', class: 'chip__caret' }), el('span', { text: 'Filters' }), el('span', { class: 'chip__count', hidden: true })]);
    toggleBtn.addEventListener('click', function () {
      if (!ui() || !ui().drawer) return;
      var sheet = el('div', { class: 'filter-bar filter-bar--sheet' });
      var inst = buildBar(sheet);
      sheet.querySelector('.filter-bar__row').style.display = 'flex';
      sheet.querySelector('.filter-bar__chips').style.display = 'flex';
      state.bars.push(inst);
      ui().drawer.open(sheet, { title: 'Filters', onClose: function () { state.bars = state.bars.filter(function (b) { return b !== inst; }); } });
    });
    inner.appendChild(el('div', { class: 'filter-bar__toggle' }, [toggleBtn, el('span', { class: 'filter-bar__spacer' }), toggleN]));
    var main = buildBar(inner);
    main.refresh = (function (orig) {
      return function (derived) {
        orig(derived);
        var f = getFilters(); var k = activeChipCount(f);
        var c = toggleBtn.querySelector('.chip__count'); c.textContent = String(k); c.hidden = !k;
        var n = currentN(derived); toggleN.innerHTML = isNum(n) ? 'n = <b>' + esc(fmtInt(n)) + '</b>' : '';
      };
    })(main.refresh);
    state.bars.push(main);
    main.refresh(getDerived());
  }

  function refreshBars(derived) {
    state.bars.forEach(function (b) { safe('Filter bar', function () { b.refresh(derived); }); });
  }

  /* ------------------------------------------------------------------ routing and views */

  function currentQuery() {
    var s = store();
    if (s && typeof s.toQuery === 'function') return safe('Filter query', function () { return s.toQuery(); }, '') || '';
    return '';
  }

  /**
   * Split a hash query into the pairs the store understands (FilterState keys) and view-private pairs such as the
   * Inbox's dow=/hour= slot or Methods' section=. The store decides what it knows (parseQuery of one pair), so the
   * list of filter keys lives in one place.
   */
  function splitQuery(q) {
    var s = store();
    var filters = [], extra = [];
    String(q || '').split('&').forEach(function (pair) {
      if (!pair) return;
      var known = false;
      if (s && typeof s.parseQuery === 'function') {
        try { known = Object.keys(s.parseQuery(pair)).length > 0; } catch (e) { known = false; }
      }
      (known ? filters : extra).push(pair);
    });
    return { filters: filters.join('&'), extra: extra.join('&') };
  }

  function syncHash() {
    var r = router();
    if (!r) return;
    var cur = r.current();
    if (!cur) return;
    var q = currentQuery();
    // Filters own the hash query; view-private keys already in the hash ride along instead of being stripped.
    var extra = splitQuery(cur.query || '').extra;
    var full = q + (extra ? (q ? '&' : '') + extra : '');
    if (full !== (cur.query || '')) r.navigate(cur.name, { id: cur.id || undefined, query: full, replace: true });
    updateNavHrefs(q);
  }

  function updateNavHrefs(q) {
    var r = router();
    if (!r) return;
    Array.prototype.forEach.call(document.querySelectorAll('a[data-route]'), function (a) {
      a.setAttribute('href', r.build(a.getAttribute('data-route'), { query: q }));
    });
  }

  function applyRouteQuery(route) {
    var s = store();
    if (!s) return;
    var q = route.query || '';
    var parts = splitQuery(q);
    // A query with no filter key (empty, or only view-private keys such as section= or dow=) leaves the filters alone;
    // resetting to defaults here would wipe every chip because a Methods TOC link or a heatmap drill carried a view key.
    if (!parts.filters) { syncHash(); return; }
    if (parts.filters === currentQuery()) return;
    if (typeof s.fromQuery === 'function') safe('Filters from URL', function () { s.fromQuery(parts.filters); });
  }

  function onRoute(route) {
    var root = byId('view');
    if (!root) return;
    var views = VOC.views || {};
    var name = views[route.name] ? route.name : (router() ? router().defaultRoute() : 'briefing');
    var view = views[name];
    state.routing = true;
    applyRouteQuery(route);
    state.routing = false;
    var derived = getDerived();

    if (ui() && ui().closePopover) ui().closePopover();

    if (view !== state.currentView) {
      if (state.currentView && typeof state.currentView.unmount === 'function') safe('Leaving ' + state.currentName, function () { state.currentView.unmount(); });
      if (ui() && ui().drawer && ui().drawer.isOpen() && !route.id) ui().drawer.close();
      root.innerHTML = '';
      root.setAttribute('data-view', name);
      state.currentView = view || null;
      state.currentName = name;
      if (view && typeof view.mount === 'function') safe('View ' + name, function () { view.mount(root, derived); });
      else if (ui() && ui().emptyState) ui().emptyState(root, { title: 'No views are registered', text: 'The view scripts did not load. Check the script tags in index.html.' });
      document.title = (view && view.title ? view.title + ' · ' : '') + 'L-Nutra Voice of the Customer';
      setActiveNav(name);
      window.scrollTo(0, 0);
    } else if (view && typeof view.update === 'function') {
      safe('View ' + name, function () { view.update(derived); });
    }
    if (view && typeof view.onRoute === 'function') safe('View ' + name, function () { view.onRoute(route, derived); });
    updateNavCounts(derived);
    updateNavHrefs(currentQuery());
    refreshBars(derived);
  }

  function updateCurrentView(derived) {
    if (state.routing) return;
    var v = state.currentView;
    if (v && typeof v.update === 'function') safe('View ' + state.currentName, function () { v.update(derived); });
  }

  function startRouter() {
    var r = router();
    if (!r) {
      var root = byId('view');
      var first = Object.keys(VOC.views)[0];
      if (root && first) onRoute({ name: first, id: null, query: '' });
      return;
    }
    r.on(onRoute);
    r.start(VOC.views, 'briefing');
  }

  /* ------------------------------------------------------------------ store events */

  function bindStoreEvents() {
    var s = store();
    if (!s || typeof s.on !== 'function') return;
    s.on('filtered', function () {
      var d = getDerived();
      refreshBars(d); syncHash(); syncSearchInput(); updateNavCounts(d); updateCurrentView(d);
    });
    s.on('records:changed', function () {
      var d = getDerived();
      refreshBars(d); updateNavCounts(d); updateClockBadge(); updateCurrentView(d);
    });
    s.on('settings:changed', function () {
      var t = settingsTheme();
      if (t && t !== state.theme) { state.theme = t; applyThemeAttr(t); }
      updateClockBadge();
    });
    s.on('clock:changed', updateClockBadge);
    s.on('theme:changed', function () { var t = settingsTheme(); if (t && t !== state.theme) { state.theme = t; applyThemeAttr(t); } });
  }

  /* ------------------------------------------------------------------ header widgets */

  function updateClockBadge() {
    var badge = byId('clock-badge');
    var s = store();
    if (!badge) return;
    if (!s || typeof s.clockMode !== 'function') { badge.hidden = true; return; }
    var mode = safe('Clock', function () { return s.clockMode(); }, 'demo');
    if (mode === 'demo') {
      var now = safe('Clock', function () { return s.now(); }, null);
      badge.innerHTML = '<span class="badge__long">Demo clock · </span>' + esc(now ? fmtDay(now) : 'as-of');
      badge.title = 'Demo clock: ages, SLAs, deadlines and range presets count from the seed as-of date. Switch to the real clock in Settings.';
      badge.hidden = false;
    } else {
      badge.textContent = 'Live clock';
      badge.title = 'Live clock: every age and deadline uses the current time.';
      badge.hidden = false;
    }
  }

  function setConn(kind, label, title) {
    var c = byId('connector-dot');
    if (!c) return;
    c.className = 'conn conn--' + kind;
    var l = c.querySelector('.conn__label'); if (l) l.textContent = label;
    c.title = title || label;
    c.setAttribute('aria-label', 'Connector status: ' + (title || label));
  }

  function agoLabel(iso) {
    if (!iso) return 'never';
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return 'just now';
    var m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var hrs = Math.round(m / 60);
    return hrs < 48 ? hrs + 'h ago' : Math.round(hrs / 24) + 'd ago';
  }

  /**
   * Header connector dot, kept honest with VOC.connector.mode():
   *   file    grey   file:// — no API at all
   *   static  grey   http(s) but /api/health has never answered {ok:true} (plain web server, or the sidecar is not up yet)
   *   ok      green  the sidecar answered {ok:true} (mode() === 'served')
   *   error   red    the sidecar answered before and now fails, or answered {ok:false}
   * Re-rendered on every connector 'status' event (health() emits one on success and failure).
   */
  function renderConnDot(hlt) {
    var c = VOC.connector;
    var m = c && typeof c.mode === 'function' ? safe('Connector', function () { return c.mode(); }, 'file') : 'file';
    if (m === 'file') {
      setConn('file', 'File mode', 'File mode: the page runs from file://. Start the sidecar (python3 server/voc_server.py) to connect a mailbox.');
      return;
    }
    if (hlt && hlt.ok) {
      setConn('ok', 'Sidecar', 'Sidecar connected · mode ' + (hlt.mode || 'idle') + ' · last sync ' + agoLabel(hlt.last_sync_at));
      return;
    }
    var wasServed = m === 'served' || (typeof c.isServed === 'function' && safe('Connector', function () { return c.isServed(); }, false));
    if (wasServed) {
      var why = hlt && hlt.error ? String(hlt.error) : 'The sidecar did not answer /api/health.';
      setConn('error', 'Sidecar offline', 'Sidecar problem: ' + why + ' Restart python3 server/voc_server.py and reload.');
      return;
    }
    setConn('static', 'Static site', 'Static site: the page is served over HTTP without the sidecar API (/api/health did not answer). Run python3 server/voc_server.py to connect a mailbox.');
  }

  function startConnectorStatus() {
    var dot = byId('connector-dot');
    if (!dot) return;
    dot.addEventListener('click', function () { if (router() && VOC.views.settings) router().navigate('settings'); });
    var c = VOC.connector;
    var mode = c && typeof c.mode === 'function' ? safe('Connector', function () { return c.mode(); }, 'file') : 'file';
    if (mode === 'file' || typeof c.health !== 'function') { renderConnDot(null); return; }
    // http(s): one health check at boot so mode() settles to 'served' or stays 'static' early, then every minute.
    if (typeof c.on === 'function') c.on('status', function (hlt) { renderConnDot(hlt); });
    renderConnDot(null);
    function poll() {
      var p = safe('Connector', function () { return c.health(); }, null);
      if (!p || typeof p.then !== 'function') { renderConnDot({ ok: false, error: 'health() is unavailable' }); return; }
      // health() never rejects and emits 'status' itself; the catch only guards a listener-less connector build.
      p.then(function (hlt) { if (typeof c.on !== 'function') renderConnDot(hlt); }).catch(function (e) { renderConnDot({ ok: false, error: e && e.message ? e.message : String(e) }); });
    }
    poll();
    setInterval(poll, 60000);
  }

  function syncSearchInput() {
    var input = byId('global-search');
    if (!input || document.activeElement === input) return;
    var f = getFilters();
    var v = f.search || '';
    if (input.value !== v) input.value = v;
  }

  function bindSearch() {
    var input = byId('global-search');
    if (!input) return;
    var push = debounce(function (v) { setFilters({ search: v }); }, 250);
    input.addEventListener('input', function () { push(input.value.trim()); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; setFilters({ search: '' }); input.blur(); }
      if (e.key === 'Enter') { setFilters({ search: input.value.trim() }); if (router() && VOC.views.inbox && state.currentName !== 'inbox') router().navigate('inbox'); }
    });
  }

  function bindBanner() {
    var banner = byId('charts-banner');
    if (!banner) return;
    if (window.VOC_CHARTS_FAILED) banner.hidden = false;
    var close = banner.querySelector('[data-action="dismiss-banner"]');
    if (close) close.addEventListener('click', function () { banner.hidden = true; });
  }

  /* ------------------------------------------------------------------ keyboard */

  var HELP_ROWS = [
    ['g then b / i / t / h / p / c', 'Briefing · Inbox · Trends · Themes · Products · Customers'],
    ['g then e / a / l / r / m / s', 'Regulatory · Alerts · Forecast Lab · Reports · Methods · Settings'],
    ['/', 'Focus search'],
    ['?', 'This help'],
    ['Esc', 'Close drawer, popover or search'],
    ['j / k, Enter, o', 'Inbox: move between rows, open record'],
    ['a / s / r / e / n / u', 'Inbox: assign · status · resolve · escalate · note · undo']
  ];

  function showShortcutHelp() {
    if (!ui() || !ui().drawer) return;
    var list = el('div', { class: 'shortcut-list' });
    HELP_ROWS.forEach(function (row) {
      var keys = el('span', { class: 'shortcut-list__keys' });
      row[0].split(' ').forEach(function (k) {
        if (k === 'then' || k === '/') { keys.appendChild(el('span', { class: 'muted', text: k === '/' ? '/' : 'then' })); return; }
        keys.appendChild(el('kbd', { class: 'kbd', text: k }));
      });
      list.appendChild(keys);
      list.appendChild(el('span', { text: row[1] }));
    });
    ui().drawer.open(el('div', { class: 'stack' }, [list, el('p', { class: 'muted t-13', text: 'Shortcuts pause while you type in a field.' })]), { title: 'Keyboard shortcuts', narrow: true });
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (state.pendingG) {
        state.pendingG = false; clearTimeout(state.gTimer);
        var target = SHORTCUTS[e.key.toLowerCase()];
        if (target && VOC.views[target] && router()) { e.preventDefault(); router().navigate(target); }
        return;
      }
      if (e.key === 'g') {
        state.pendingG = true;
        clearTimeout(state.gTimer);
        state.gTimer = setTimeout(function () { state.pendingG = false; }, 1500);
        return;
      }
      if (e.key === '/') {
        var s = byId('global-search');
        if (s) { e.preventDefault(); s.focus(); s.select(); }
        return;
      }
      if (e.key === '?') { e.preventDefault(); showShortcutHelp(); }
    });
    var help = byId('help-toggle');
    if (help) help.addEventListener('click', showShortcutHelp);
  }

  /* ------------------------------------------------------------------ boot */

  function liveRecords() {
    var c = VOC.connector;
    if (c && typeof c.loadLive === 'function') {
      var live = safe('Live data', function () { return c.loadLive(); }, null);
      if (Array.isArray(live) && live.length) return live;
    }
    return Array.isArray(window.VOC_LIVE) ? window.VOC_LIVE : [];
  }

  /**
   * Boot the shell. Resolves once the store is ready (or has failed and been reported) and the first view is mounted.
   * @returns {Promise<void>}
   */
  function boot() {
    if (state.booted) return Promise.resolve();
    state.booted = true;
    state.missing = EXPECTED_MODULES.filter(function (m) { return !VOC[m]; });
    if (!window.VOC_SEED) state.missing.push('data (VOC_SEED)');

    state.theme = readStoredTheme();
    applyThemeAttr(state.theme);
    bindBanner();
    bindThemeToggle();

    var s = store();
    var init = Promise.resolve();
    if (s && typeof s.init === 'function') {
      init = Promise.resolve().then(function () {
        return s.init({ seed: window.VOC_SEED, live: liveRecords() });
      }).catch(function (e) { reportError('Data store failed to start', e); });
    }

    return init.then(function () {
      var t = settingsTheme();
      if (t && t !== state.theme) { state.theme = t; applyThemeAttr(t); }
      renderNav();
      renderFilterBar();
      bindSearch();
      bindStoreEvents();
      bindKeyboard();
      startRouter();
      updateClockBadge();
      startConnectorStatus();
      syncSearchInput();
      if (state.missing.length) {
        toast('Modules not loaded (' + state.missing.length + '): ' + state.missing.join(', ') + '. The shell runs; those features show empty states.', 'warning', { ms: 12000 });
      }
    });
  }

  /**
   * One-line subtitle for a view: the active range and n, e.g. "Aug 18 – Sep 16, 2026 · n = 412 records".
   * @param {Object|null} derived  store.derived()
   * @returns {string}
   */
  function rangeLabel(derived) {
    var f = (derived && derived.filters) || getFilters();
    var r = (f && f.range) || {};
    var text = r.from && r.to ? fmtRange(r.from, r.to) : ({ '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '12m': 'Last 12 months' }[r.preset] || 'All records');
    var n = currentN(derived);
    return text + (isNum(n) ? ' · n = ' + fmtInt(n) + ' ' + (n === 1 ? 'record' : 'records') : '');
  }

  VOC.app = {
    boot: boot,
    setTheme: setTheme,
    renderFilterBar: renderFilterBar,
    currentView: function () { return state.currentView; },
    currentViewName: function () { return state.currentName; },
    rangeLabel: rangeLabel,
    icons: ICONS,
    missingModules: function () { return state.missing.slice(); },
    showShortcutHelp: showShortcutHelp
  };

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', function () { VOC.app.boot(); });
  }
})();
