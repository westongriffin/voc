/*
 * js/charts.js — VOC.charts (SPEC §4.9)
 * Chart.js 4.5.1 wrappers, palette/slot mapping, sparkline, heatmap, table twin.
 *
 * Classic script. Loads under jsc (no DOM); every browser/Chart access lives
 * inside functions and is guarded. Chart.js is referenced only as window.Chart.
 */
(function () {
  'use strict';

  window.VOC = window.VOC || {};

  /** Fixed series slot per entity (§4.9). Everything else maps to 'other'. */
  var SLOTS = {
    prolon_5day: 1, prolon_nextgen: 2, prolon_reset: 3, fast_bar: 4,
    fasting_shake: 5, l_protein: 6, l_pill: 7, subscription_account: 8
  };

  var FONT_FALLBACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  /** Light-theme token values (§10) used when a token is missing or there is no DOM. */
  var FALLBACK = {
    '--s1': '#56A511', '--s2': '#E87BA4', '--s3': '#2A78D6', '--s4': '#EB6834',
    '--s5': '#1BAF7A', '--s6': '#EDA100', '--s7': '#4A3AA7', '--s8': '#E34948',
    '--s-other': '#9AA39E',
    '--seq-1': '#EAF4DF', '--seq-2': '#CFE6B8', '--seq-3': '#B0D68F', '--seq-4': '#8FC466',
    '--seq-5': '#6DB13D', '--seq-6': '#56A511', '--seq-7': '#3F7F0D', '--seq-8': '#2C5A0B',
    '--div-neg': '#E34948', '--div-mid': '#ECE7E1', '--div-pos': '#2A78D6',
    '--good': '#0CA30C', '--warning': '#FAB219', '--serious': '#EC835A', '--critical': '#D03B3B',
    '--info': '#2E6FB8', '--text': '#1C1D1D', '--text-2': '#3F4A46', '--muted': '#5F6A66',
    '--grid': '#ECE6E0', '--axis': '#C9C0B8', '--surface': '#FFFFFF', '--surface-2': '#F2EAE5',
    '--border': '#E6DED8', '--brand': '#1E4036', '--accent': '#56A511', '--font-ui': FONT_FALLBACK
  };

  var paletteCache = null;
  var live = [];              // live chart handles, for rethemeAll/destroyAll
  var pluginRegistered = false;
  var styleInjected = false;

  /* ------------------------------------------------------------------ */
  /* Small local helpers (VOC.util preferred when present)               */
  /* ------------------------------------------------------------------ */

  function util() {
    return (window.VOC && window.VOC.util) || null;
  }

  function escapeHtml(s) {
    var u = util();
    if (u && typeof u.escapeHtml === 'function') return u.escapeHtml(s == null ? '' : String(s));
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var intFmt = null, decFmt = null;
  function fmtInt(n) {
    if (!isNum(n)) return '—';
    if (!intFmt) intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    return intFmt.format(n);
  }
  function fmtNum(n) {
    if (!isNum(n)) return '—';
    if (Math.abs(n - Math.round(n)) < 1e-9) return fmtInt(n);
    if (!decFmt) decFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
    return decFmt.format(n);
  }
  function fmtPct(n) { return isNum(n) ? fmtNum(Math.round(n * 10) / 10) + '%' : '—'; }
  function fmtSigned(n) { return isNum(n) ? (n > 0 ? '+' : '') + fmtNum(n) : '—'; }
  function round(x, d) { var m = Math.pow(10, d || 0); return Math.round(x * m) / m; }

  /* ------------------------------------------------------------------ */
  /* Colors                                                              */
  /* ------------------------------------------------------------------ */

  /** Parses #rgb, #rrggbb(aa), rgb()/rgba() → {r,g,b,a} or null. */
  function parseColor(c) {
    c = String(c == null ? '' : c).trim();
    var m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(c))) {
      return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
    }
    if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c))) {
      return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    }
    if ((m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s\/]+([\d.]+)(%?))?\s*\)$/i.exec(c))) {
      var a = m[4] == null ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
      return { r: +m[1], g: +m[2], b: +m[3], a: a };
    }
    return null;
  }

  /** Returns the color as rgba() with the given alpha; unparseable input passes through. */
  function withAlpha(color, alpha) {
    var p = parseColor(color);
    if (!p) return color;
    return 'rgba(' + Math.round(p.r) + ',' + Math.round(p.g) + ',' + Math.round(p.b) + ',' + round(alpha, 3) + ')';
  }

  function toHex(rgb) {
    var h = function (v) { var s = Math.round(clamp(v, 0, 255)).toString(16); return s.length < 2 ? '0' + s : s; };
    return '#' + h(rgb.r) + h(rgb.g) + h(rgb.b);
  }

  function mix(c1, c2, t) {
    var a = parseColor(c1), b = parseColor(c2);
    if (!a || !b) return t < 0.5 ? c1 : c2;
    return toHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  }

  /* ------------------------------------------------------------------ */
  /* Palette                                                             */
  /* ------------------------------------------------------------------ */

  function readToken(style, name) {
    var v = '';
    if (style && typeof style.getPropertyValue === 'function') {
      try { v = String(style.getPropertyValue(name) || '').trim(); } catch (e) { v = ''; }
    }
    return v || FALLBACK[name] || '';
  }

  /**
   * Reads the design tokens at call time (cached until rethemeAll()).
   * @returns {{series:string[], other:string, text:string, text2:string, muted:string, grid:string, axis:string,
   *   surface:string, surface2:string, border:string, brand:string, accent:string, info:string,
   *   pos:string, neg:string, mid:string, seq:string[], status:{good:string,warning:string,serious:string,critical:string}, font:string}}
   */
  function palette() {
    if (paletteCache) return paletteCache;
    var style = null;
    if (typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document && document.documentElement) {
      try { style = getComputedStyle(document.documentElement); } catch (e) { style = null; }
    }
    var t = function (name) { return readToken(style, name); };
    var series = [], seq = [];
    for (var i = 1; i <= 8; i++) { series.push(t('--s' + i)); seq.push(t('--seq-' + i)); }
    paletteCache = {
      series: series,
      other: t('--s-other'),
      text: t('--text'), text2: t('--text-2'), muted: t('--muted'),
      grid: t('--grid'), axis: t('--axis'),
      surface: t('--surface'), surface2: t('--surface-2'), border: t('--border'),
      brand: t('--brand'), accent: t('--accent'), info: t('--info'),
      pos: t('--div-pos'), neg: t('--div-neg'), mid: t('--div-mid'),
      seq: seq,
      status: { good: t('--good'), warning: t('--warning'), serious: t('--serious'), critical: t('--critical') },
      font: t('--font-ui') || FONT_FALLBACK
    };
    return paletteCache;
  }

  /**
   * Fixed slot color for an entity id (product / account). Unknown ids get the 'other' grey.
   * @param {string} entityId
   * @returns {string}
   */
  function slotColor(entityId) {
    var p = palette();
    var slot = SLOTS[entityId];
    return slot ? p.series[slot - 1] : p.other;
  }

  /**
   * Status color (never used as a series color).
   * @param {'good'|'warning'|'serious'|'critical'|'info'} kind
   */
  function statusColor(kind) {
    var p = palette();
    if (kind === 'info') return p.info;
    return p.status[kind] || p.muted;
  }

  /**
   * Color on the diverging scale for a value in [lo, hi] (neg → mid → pos).
   * @param {number} value
   * @param {number} [lo=-1]
   * @param {number} [hi=1]
   */
  function divergingColor(value, lo, hi) {
    var p = palette();
    if (!isNum(value)) return p.muted;
    lo = lo == null ? -1 : lo; hi = hi == null ? 1 : hi;
    var t = hi === lo ? 0.5 : clamp((value - lo) / (hi - lo), 0, 1);
    return t < 0.5 ? mix(p.neg, p.mid, t * 2) : mix(p.mid, p.pos, (t - 0.5) * 2);
  }

  /**
   * Sentiment color for charts: a label ('positive'|'negative'|'neutral'|'unscored') or a
   * numeric compound in [-1, 1] interpolated on the diverging scale.
   * @param {string|number} label
   */
  var NEUTRAL_BAND = 0.15;
  function sentimentColor(label) {
    var p = palette();
    if (isNum(label)) {
      // |v| < 0.15 is the neutral band: the muted grey used for the 'neutral' label (--div-mid is nearly
      // invisible on a white card); outside it, blend from that grey to the pole at |v| = 1.
      var v = clamp(label, -1, 1);
      if (Math.abs(v) < NEUTRAL_BAND) return p.muted;
      var t = (Math.abs(v) - NEUTRAL_BAND) / (1 - NEUTRAL_BAND);
      return mix(p.muted, v < 0 ? p.neg : p.pos, t);
    }
    if (label === 'positive') return p.pos;
    if (label === 'negative') return p.neg;
    return p.muted;
  }

  /** Resolves a dataset's dash pattern: dash 'dotted'|'dashed'|'solid'|number[], borderDash, or the boolean dashed. */
  function dashFor(ds) {
    var d = ds.dash != null ? ds.dash : ds.borderDash;
    if (Array.isArray(d)) return d.slice();
    if (d === 'dotted') return [2, 3];
    if (d === 'dashed') return [6, 4];
    if (d === 'solid' || d === false) return [];
    return ds.dashed ? [6, 4] : [];
  }
  function hasBand(ds) { return !!(ds && ds.band && Array.isArray(ds.band.lo) && Array.isArray(ds.band.hi)); }
  /** A dataset that carries a band but no drawn line (data omitted, null or all-null). */
  function isBandOnly(ds) {
    if (!hasBand(ds)) return false;
    var data = ds.data;
    if (!Array.isArray(data)) return true;
    return !data.some(function (v) { return v != null && (isNum(v) || typeof v === 'object'); });
  }

  /** Resolves a dataset's color: explicit color → slot → entity → single series s1 → index. */
  function datasetColor(ds, index, visibleCount, p) {
    if (typeof ds.color === 'string' && ds.color) return ds.color;
    if (ds.slot != null) {
      if (ds.slot === 'other') return p.other;
      return p.series[ds.slot - 1] || p.other;
    }
    if (ds.entity) return slotColor(ds.entity);
    if (visibleCount <= 1) return p.series[0];
    return p.series[index % p.series.length];
  }

  function perBarColors(ds) {
    if (Array.isArray(ds.colors)) return ds.colors;
    if (Array.isArray(ds.color)) return ds.color;
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Chart.js availability, defaults, marker plugin                      */
  /* ------------------------------------------------------------------ */

  /** @returns {boolean} true when Chart.js loaded and the CDN did not fail. */
  function available() {
    return typeof window !== 'undefined' && !window.VOC_CHARTS_FAILED && typeof window.Chart === 'function';
  }

  function reducedMotion() {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }

  /**
   * Inline plugin: vertical/horizontal markers and quadrant corner labels drawn in afterDraw.
   * Enabled per chart through options.plugins.vocMarkers = { items, corners, color, textColor, font }.
   */
  function pixelFor(scale, labels, v) {
    var idx = labels.indexOf(v);
    if (idx >= 0) return scale.getPixelForValue(idx);
    return isNum(v) ? scale.getPixelForValue(v) : NaN;
  }
  function isRangeItem(item) { return !!item && item.x == null && item.y == null && (item.from != null || item.to != null); }

  var markerPlugin = {
    id: 'vocMarkers',
    /** Shaded x-range boxes for annotations of the form {from, to, label}, drawn behind the data. */
    beforeDatasetsDraw: function (chart, args, opts) {
      if (!opts || !opts.items || !opts.items.length) return;
      var ranges = opts.items.filter(isRangeItem);
      if (!ranges.length) return;
      var ctx = chart.ctx, area = chart.chartArea, xs = chart.scales && chart.scales.x;
      if (!ctx || !area || !xs) return;
      var labels = (chart.data && chart.data.labels) || [];
      ctx.save();
      ranges.forEach(function (item) {
        var x0 = item.from != null ? pixelFor(xs, labels, item.from) : area.left;
        var x1 = item.to != null ? pixelFor(xs, labels, item.to) : area.right;
        if (!isNum(x0) || !isNum(x1)) return;
        // on a category axis extend half a step each side so the box covers the whole from/to buckets
        var onCategory = labels.indexOf(item.from) >= 0 || labels.indexOf(item.to) >= 0;
        var half = onCategory && labels.length > 1 ? Math.abs(xs.getPixelForValue(1) - xs.getPixelForValue(0)) / 2 : 0;
        var left = clamp(Math.min(x0, x1) - half, area.left, area.right);
        var right = clamp(Math.max(x0, x1) + half, area.left, area.right);
        if (right <= left) return;
        ctx.fillStyle = item.color ? withAlpha(item.color, 0.14) : opts.fill;
        ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
        if (item.label) {
          ctx.fillStyle = opts.textColor;
          ctx.font = '11px ' + opts.font;
          ctx.textBaseline = 'top';
          ctx.textAlign = 'left';
          ctx.fillText(String(item.label), left + 4, area.top + 2);
        }
      });
      ctx.restore();
    },
    afterDraw: function (chart, args, opts) {
      if (!opts || ((!opts.items || !opts.items.length) && !opts.corners)) return;
      var ctx = chart.ctx, area = chart.chartArea, xs = chart.scales.x, ys = chart.scales.y;
      if (!ctx || !area) return;
      var labels = chart.data.labels || [];
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = opts.color;
      ctx.fillStyle = opts.textColor;
      ctx.font = '11px ' + opts.font;
      ctx.textBaseline = 'top';
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash(opts.dash || [3, 3]);
      (opts.items || []).forEach(function (item) {
        if (!item || isRangeItem(item)) return;
        if (item.x != null && xs) {
          var px = pixelFor(xs, labels, item.x);
          if (isNum(px) && px >= area.left - 1 && px <= area.right + 1) {
            ctx.beginPath(); ctx.moveTo(px, area.top); ctx.lineTo(px, area.bottom); ctx.stroke();
            if (item.label) {
              var rightSide = px > (area.left + area.right) / 2;
              ctx.textAlign = rightSide ? 'right' : 'left';
              ctx.fillText(String(item.label), px + (rightSide ? -4 : 4), area.top + 2);
            }
          }
        }
        if (item.y != null && ys && isNum(item.y)) {
          var py = ys.getPixelForValue(item.y);
          if (isNum(py) && py >= area.top - 1 && py <= area.bottom + 1) {
            ctx.beginPath(); ctx.moveTo(area.left, py); ctx.lineTo(area.right, py); ctx.stroke();
            if (item.label) {
              ctx.textAlign = 'right';
              ctx.fillText(String(item.label), area.right - 4, py - 13);
            }
          }
        }
      });
      if (opts.corners) {
        var c = opts.corners, pad = 6;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        if (c[0]) ctx.fillText(String(c[0]), area.left + pad, area.top + pad);
        ctx.textAlign = 'right';
        if (c[1]) ctx.fillText(String(c[1]), area.right - pad, area.top + pad);
        ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
        if (c[2]) ctx.fillText(String(c[2]), area.left + pad, area.bottom - pad);
        ctx.textAlign = 'right';
        if (c[3]) ctx.fillText(String(c[3]), area.right - pad, area.bottom - pad);
      }
      ctx.restore();
    }
  };

  /* Chart.js's Animations.configure copies only Object.keys(Chart.defaults.animation) out of each animation config, so
     replacing the defaults object with {duration} drops `type: 'color'` from the colors group and the first color change
     throws "this._fn is not a function" (no interpolator for typeof 'string'). Keep every key; only change the duration. */
  var ANIMATION_KEYS = { delay: undefined, duration: 1000, easing: 'easeOutQuart', fn: undefined, from: undefined, loop: undefined, to: undefined, type: undefined };
  function setAnimationDefaults(d) {
    if (!d.animation || typeof d.animation !== 'object') d.animation = {};
    Object.keys(ANIMATION_KEYS).forEach(function (k) { if (!(k in d.animation)) d.animation[k] = ANIMATION_KEYS[k]; });
    d.animation.duration = reducedMotion() ? 0 : 150;
    return d.animation;
  }
  /** Applies token-driven Chart.defaults (idempotent; re-run by rethemeAll). */
  function applyDefaults(p) {
    var C = window.Chart;
    var d = C.defaults;
    d.font.family = p.font;
    d.font.size = 12;
    d.color = p.text2;
    d.borderColor = p.grid;
    d.responsive = true;
    d.maintainAspectRatio = false;
    setAnimationDefaults(d);
    if (d.scale) {
      if (d.scale.grid) { d.scale.grid.color = p.grid; d.scale.grid.lineWidth = 1; d.scale.grid.drawTicks = false; }
      if (d.scale.border) { d.scale.border.color = p.axis; d.scale.border.dash = []; d.scale.border.width = 1; }
      if (d.scale.ticks) { d.scale.ticks.color = p.muted; }
    }
    if (d.plugins && d.plugins.tooltip) {
      var tt = d.plugins.tooltip;
      tt.enabled = true;
      tt.backgroundColor = p.text;
      tt.titleColor = p.surface;
      tt.bodyColor = p.surface;
      tt.padding = 8;
      tt.cornerRadius = 6;
      tt.boxPadding = 4;
      tt.boxWidth = 8;
      tt.boxHeight = 8;
      tt.usePointStyle = true;
      tt.titleFont = { size: 12, weight: '600' };
      tt.bodyFont = { size: 12 };
    }
    if (d.plugins && d.plugins.legend && d.plugins.legend.labels) {
      d.plugins.legend.labels.boxWidth = 10;
      d.plugins.legend.labels.boxHeight = 10;
      d.plugins.legend.labels.usePointStyle = true;
      d.plugins.legend.labels.padding = 12;
    }
    if (!pluginRegistered && typeof C.register === 'function') {
      C.register(markerPlugin);
      pluginRegistered = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Shared option builders                                              */
  /* ------------------------------------------------------------------ */

  function legendFilter(item, data) {
    var ds = data && data.datasets && data.datasets[item.datasetIndex];
    return !(ds && ds.vocHidden);
  }

  function tooltipFilter(item) {
    return !(item.dataset && item.dataset.vocHidden);
  }

  function valueFormatter(spec) {
    return spec.percent ? fmtPct : fmtNum;
  }

  function axisTitle(text, p) {
    return { display: !!text, text: text || '', color: p.muted, font: { size: 11 } };
  }

  function visibleCount(datasets) {
    return datasets.filter(function (d) { return !d.vocHidden; }).length;
  }

  function interactionHandlers(spec) {
    var out = {};
    if (typeof spec.onClick === 'function') {
      out.onClick = function (evt, elements, chart) {
        if (!elements || !elements.length) return;
        var pick = null;
        for (var i = 0; i < elements.length; i++) {
          var ds = chart.data.datasets[elements[i].datasetIndex];
          if (!ds || !ds.vocHidden) { pick = elements[i]; break; }
        }
        pick = pick || elements[0];
        spec.onClick(pick.index, pick.datasetIndex);
      };
      out.onHover = function (evt, elements) {
        var target = evt && evt.native && evt.native.target;
        if (target && target.style) target.style.cursor = elements && elements.length ? 'pointer' : '';
      };
    }
    return out;
  }

  function markerOptions(spec, p, corners) {
    var items = Array.isArray(spec.annotations) ? spec.annotations : [];
    if (spec.quadrants) {
      items = items.concat([{ x: spec.quadrants.x }, { y: spec.quadrants.y }]);
    }
    if (!items.length && !corners) return false;
    return { items: items, corners: corners || null, color: p.muted, textColor: p.muted, font: p.font, dash: [3, 3], fill: withAlpha(p.muted, 0.14) };
  }

  function baseOptions(spec, p, datasets, tooltip, extra) {
    var handlers = interactionHandlers(spec);
    var opts = {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion() ? false : { duration: 150 },
      layout: { padding: { top: 6, right: 8, bottom: 0, left: 0 } },
      plugins: {
        legend: {
          display: spec.legend === false ? false : visibleCount(datasets) >= 2,
          position: 'bottom',
          labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 12, color: p.text2, filter: legendFilter }
        },
        tooltip: tooltip,
        vocMarkers: markerOptions(spec, p, extra && extra.corners)
      }
    };
    if (handlers.onClick) { opts.onClick = handlers.onClick; opts.onHover = handlers.onHover; }
    return opts;
  }

  function tooltipBase(p, mode, intersect) {
    return {
      enabled: true,
      mode: mode,
      intersect: intersect,
      backgroundColor: p.text,
      titleColor: p.surface,
      bodyColor: p.surface,
      padding: 8,
      cornerRadius: 6,
      boxPadding: 4,
      boxWidth: 8,
      boxHeight: 8,
      usePointStyle: true,
      titleFont: { size: 12, weight: '600' },
      bodyFont: { size: 12 },
      filter: tooltipFilter,
      callbacks: {}
    };
  }

  /* ------------------------------------------------------------------ */
  /* Builders: each returns { type, data, options }                      */
  /* ------------------------------------------------------------------ */

  function buildLine(spec, p) {
    var src = spec.datasets || [];
    var drawn = src.filter(function (ds) { return !isBandOnly(ds); });
    var visible = drawn.length;
    var datasets = [];
    var fmt = valueFormatter(spec);
    src.forEach(function (ds, i) {
      var color = datasetColor(ds, drawn.indexOf(ds) >= 0 ? drawn.indexOf(ds) : i, visible, p);
      var data = Array.isArray(ds.data) ? ds.data : [];
      var bandOnly = isBandOnly(ds);
      if (hasBand(ds) && ds.fill !== false) {
        var bandAlpha = isNum(ds.bandAlpha) ? ds.bandAlpha : 0.14;
        datasets.push({
          label: (ds.label || '') + ' low', data: ds.band.lo, vocHidden: true, vocBandOf: ds.label || '', vocBandOnly: bandOnly,
          borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, fill: '+1',
          backgroundColor: withAlpha(color, bandAlpha), borderColor: 'transparent', tension: 0.25, spanGaps: false
        });
        datasets.push({
          label: (ds.label || '') + ' high', data: ds.band.hi, vocHidden: true, vocBandOf: ds.label || '', vocBandOnly: bandOnly,
          borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, fill: false,
          backgroundColor: 'transparent', borderColor: 'transparent', tension: 0.25, spanGaps: false
        });
      }
      if (bandOnly) return; // band without a drawn line: no legend or tooltip placeholder
      var radius = ds.pointRadius != null ? ds.pointRadius : (data.length > 40 ? 0 : 2);
      var hoverRadius = Array.isArray(radius)
        ? radius.map(function (r) { return isNum(r) && r > 0 ? r + 2 : 0; })
        : (isNum(radius) ? radius + 2 : 2);
      var pointColors = Array.isArray(ds.pointColors) ? ds.pointColors : (Array.isArray(ds.pointColor) ? ds.pointColor : null);
      var pointBg = pointColors ? pointColors.map(function (c) { return c || color; }) : color;
      datasets.push({
        label: ds.label || '',
        data: data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: isNum(ds.borderWidth) ? ds.borderWidth : 2,
        borderDash: dashFor(ds),
        pointRadius: radius,
        pointHoverRadius: hoverRadius,
        pointBackgroundColor: pointBg,
        pointBorderColor: pointBg,
        fill: false,
        tension: 0.25,
        spanGaps: false
      });
    });
    var tooltip = tooltipBase(p, 'index', false);
    tooltip.callbacks.label = function (item) {
      return ' ' + item.dataset.label + ': ' + fmt(item.parsed.y);
    };
    var options = baseOptions(spec, p, datasets, tooltip);
    options.interaction = { mode: 'index', intersect: false };
    options.scales = {
      x: {
        grid: { display: false },
        border: { color: p.axis, width: 1 },
        ticks: { color: p.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, padding: 6 },
        title: axisTitle(spec.xLabel, p)
      },
      y: {
        beginAtZero: spec.yMin == null,
        grid: { color: p.grid, lineWidth: 1, drawTicks: false },
        border: { display: false },
        ticks: { color: p.muted, maxTicksLimit: 6, padding: 6, callback: function (v) { return fmt(v); } },
        title: axisTitle(spec.yLabel, p)
      }
    };
    if (spec.yMin != null) options.scales.y.min = spec.yMin;
    if (spec.yMax != null) options.scales.y.max = spec.yMax;
    return { type: 'line', data: { labels: spec.labels || [], datasets: datasets }, options: options };
  }

  /**
   * Shared bar builder. mode ∈ 'bar'|'stacked100'|'paired'|'diverging'|'histogram'|'waterfall'.
   */
  function buildBars(spec, p, mode) {
    var horizontal = mode === 'histogram' ? !!spec.horizontal : spec.vertical !== true;
    var indexAxis = horizontal ? 'y' : 'x';
    var stacked = mode === 'stacked100' || !!spec.stacked;
    var diverging = mode === 'diverging' || !!spec.diverging;
    var fmt = mode === 'stacked100' ? fmtPct : valueFormatter(spec);
    var src = spec.datasets || [];
    var datasets = [];
    var labels = spec.labels || [];
    var totals = null;
    var wfRows = null;

    if (mode === 'stacked100') {
      totals = labels.map(function (_, i) {
        return src.reduce(function (s, ds) { var v = ds.data && ds.data[i]; return s + (isNum(v) ? v : 0); }, 0);
      });
    }
    if (mode === 'waterfall') {
      wfRows = waterfallRows(spec);
      labels = wfRows.map(function (r) { return r.label; });
    }

    var barStyle = function () {
      var s = {
        barPercentage: mode === 'histogram' ? 0.98 : 0.7,
        categoryPercentage: mode === 'histogram' ? 1 : (mode === 'paired' ? 0.7 : 0.8)
      };
      // A one- or two-category chart (e.g. after a drill) keeps readable bars instead of one slab filling the card.
      if (mode !== 'histogram') s.maxBarThickness = 36;
      if (stacked) {
        s.borderColor = p.surface; s.borderWidth = 1; s.borderSkipped = false; s.borderRadius = 2;
      } else if (mode === 'histogram') {
        s.borderColor = p.surface; s.borderWidth = 1; s.borderSkipped = 'start'; s.borderRadius = 2;
      } else {
        s.borderWidth = 0; s.borderSkipped = 'start'; s.borderRadius = 4;
      }
      return s;
    };

    if (mode === 'waterfall') {
      var upColor = spec.upColor || p.pos, downColor = spec.downColor || p.neg;
      datasets.push(Object.assign({
        label: (src[0] && src[0].label) || 'Change',
        data: wfRows.map(function (r) { return [r.low, r.high]; }),
        vocRows: wfRows,
        backgroundColor: wfRows.map(function (r) {
          if (r.kind === 'total') return p.brand;
          if (r.kind === 'other') return p.other;
          return r.value < 0 ? downColor : upColor;
        })
      }, barStyle()));
    } else {
      var visible = src.length;
      src.forEach(function (ds, i) {
        var base = datasetColor(ds, i, visible, p);
        var data = (ds.data || []).map(function (v) { return isNum(v) ? v : (v == null ? null : +v); });
        var raw = data;
        if (mode === 'stacked100') {
          data = data.map(function (v, k) { return totals[k] > 0 && isNum(v) ? v / totals[k] * 100 : 0; });
        }
        var colors = perBarColors(ds);
        var bg;
        if (colors) bg = colors;
        else if (diverging) bg = data.map(function (v) { return isNum(v) && v < 0 ? p.neg : p.pos; });
        else bg = base;
        datasets.push(Object.assign({
          label: ds.label || '',
          data: data,
          vocRaw: raw,
          backgroundColor: bg,
          hoverBackgroundColor: Array.isArray(bg) ? bg.map(function (c) { return withAlpha(c, 0.85); }) : withAlpha(bg, 0.85)
        }, barStyle()));
      });
    }

    var tooltip = tooltipBase(p, 'nearest', mode !== 'stacked100');
    if (mode === 'stacked100') {
      tooltip.mode = 'index'; tooltip.intersect = false;
      tooltip.callbacks.title = function (items) {
        if (!items.length) return '';
        var i = items[0].dataIndex;
        return String(labels[i]) + ' · n = ' + fmtInt(totals[i]);
      };
      tooltip.callbacks.label = function (item) {
        var raw = item.dataset.vocRaw ? item.dataset.vocRaw[item.dataIndex] : null;
        var v = horizontal ? item.parsed.x : item.parsed.y;
        return ' ' + item.dataset.label + ': ' + fmtPct(v) + (isNum(raw) ? ' (n = ' + fmtInt(raw) + ')' : '');
      };
    } else if (mode === 'waterfall') {
      tooltip.callbacks.label = function (item) {
        var r = item.dataset.vocRows[item.dataIndex];
        if (!r) return '';
        return r.kind === 'total' ? ' Total: ' + fmtNum(r.value) : ' Change: ' + fmtSigned(r.value) + ' → ' + fmtNum(r.high);
      };
    } else {
      tooltip.callbacks.label = function (item) {
        var v = horizontal ? item.parsed.x : item.parsed.y;
        return ' ' + item.dataset.label + ': ' + fmt(v);
      };
    }

    var options = baseOptions(spec, p, datasets, tooltip);
    options.indexAxis = indexAxis;
    if (mode === 'histogram') options.plugins.legend.display = false;

    var valueScale = {
      beginAtZero: spec.yMin == null,
      stacked: stacked,
      grid: { color: p.grid, lineWidth: 1, drawTicks: false },
      border: { display: false },
      ticks: { color: p.muted, maxTicksLimit: 6, padding: 6, callback: function (v) { return fmt(v); } }
    };
    var categoryScale = {
      stacked: stacked,
      grid: { display: false },
      border: { color: p.axis, width: 1 },
      // Horizontal bars name every category on the y axis; vertical bars (months, buckets) skip labels that would overlap.
      ticks: { color: p.text2, autoSkip: mode === 'histogram' || !horizontal, maxRotation: horizontal || mode === 'histogram' ? 0 : 45, padding: 6 }
    };
    if (spec.yMin != null) valueScale.min = spec.yMin;
    if (spec.yMax != null) valueScale.max = spec.yMax;
    if (mode === 'stacked100') { valueScale.min = 0; valueScale.max = 100; }
    if (diverging) {
      var maxAbs = 0;
      datasets.forEach(function (d) { d.data.forEach(function (v) { if (isNum(v)) maxAbs = Math.max(maxAbs, Math.abs(v)); }); });
      valueScale.suggestedMin = -maxAbs || -1;
      valueScale.suggestedMax = maxAbs || 1;
      valueScale.beginAtZero = false;
    }
    if (horizontal) {
      valueScale.title = axisTitle(spec.xLabel, p);
      categoryScale.title = axisTitle(spec.yLabel, p);
      options.scales = { x: valueScale, y: categoryScale };
    } else {
      valueScale.title = axisTitle(spec.yLabel, p);
      categoryScale.title = axisTitle(spec.xLabel, p);
      options.scales = { x: categoryScale, y: valueScale };
    }
    return { type: 'bar', data: { labels: labels, datasets: datasets }, options: options };
  }

  /** Waterfall rows: running totals from signed deltas, with optional start/end totals. */
  function waterfallRows(spec) {
    var labels = spec.labels || [];
    var deltas = (spec.datasets && spec.datasets[0] && spec.datasets[0].data) || [];
    var kinds = Array.isArray(spec.kinds) ? spec.kinds : [];
    var rows = [];
    var running = 0;
    if (spec.totals && spec.totals.start && isNum(spec.totals.start.value)) {
      running = spec.totals.start.value;
      rows.push({ label: spec.totals.start.label || 'Start', low: 0, high: running, value: running, kind: 'total' });
    }
    labels.forEach(function (label, i) {
      var d = isNum(deltas[i]) ? deltas[i] : 0;
      var kind = kinds[i] || (/^other$/i.test(String(label)) ? 'other' : 'delta');
      if (kind === 'total') {
        rows.push({ label: label, low: 0, high: d, value: d, kind: 'total' });
        running = d;
      } else {
        rows.push({ label: label, low: running, high: running + d, value: d, kind: kind });
        running += d;
      }
    });
    if (spec.totals && spec.totals.end) {
      var endVal = isNum(spec.totals.end.value) ? spec.totals.end.value : running;
      rows.push({ label: spec.totals.end.label || 'End', low: 0, high: endVal, value: endVal, kind: 'total' });
    }
    return rows;
  }

  function buildBubble(spec, p) {
    var src = spec.datasets || [];
    var visible = src.length;
    var rMax = isNum(spec.rMax) ? spec.rMax : 22, rMin = 4;
    var maxR = 0;
    src.forEach(function (ds) { (ds.data || []).forEach(function (pt) { if (pt && isNum(pt.r)) maxR = Math.max(maxR, Math.abs(pt.r)); }); });
    var datasets = src.map(function (ds, i) {
      var color = datasetColor(ds, i, visible, p);
      var colors = perBarColors(ds);
      var data = (ds.data || []).map(function (pt) {
        pt = pt || {};
        var rr = isNum(pt.r) ? Math.abs(pt.r) : 0;
        return { x: pt.x, y: pt.y, r: maxR > 0 ? rMin + rr / maxR * (rMax - rMin) : rMin, label: pt.label, rawR: pt.r, id: pt.id };
      });
      return {
        label: ds.label || '',
        data: data,
        backgroundColor: colors ? colors.map(function (c) { return withAlpha(c, 0.55); }) : withAlpha(color, 0.55),
        borderColor: colors || color,
        borderWidth: 1.5,
        hoverBorderWidth: 2
      };
    });
    var tooltip = tooltipBase(p, 'nearest', true);
    tooltip.callbacks.title = function (items) {
      if (!items.length) return '';
      var raw = items[0].raw || {};
      return raw.label || items[0].dataset.label || '';
    };
    tooltip.callbacks.label = function (item) {
      var raw = item.raw || {};
      var parts = [(spec.xLabel || 'x') + ' ' + fmtNum(raw.x), (spec.yLabel || 'y') + ' ' + fmtNum(raw.y)];
      if (isNum(raw.rawR)) parts.push((spec.rLabel || 'size') + ' ' + fmtNum(raw.rawR));
      return ' ' + parts.join(' · ');
    };
    var corners = spec.quadrants && Array.isArray(spec.quadrants.labels) ? spec.quadrants.labels : null;
    var options = baseOptions(spec, p, datasets, tooltip, { corners: corners });
    options.scales = {
      x: {
        type: 'linear',
        grid: { color: p.grid, lineWidth: 1, drawTicks: false },
        border: { color: p.axis, width: 1 },
        ticks: { color: p.muted, maxTicksLimit: 7, padding: 6, callback: function (v) { return fmtNum(v); } },
        title: axisTitle(spec.xLabel, p)
      },
      y: {
        type: 'linear',
        grid: { color: p.grid, lineWidth: 1, drawTicks: false },
        border: { display: false },
        ticks: { color: p.muted, maxTicksLimit: 6, padding: 6, callback: function (v) { return fmtNum(v); } },
        title: axisTitle(spec.yLabel, p)
      }
    };
    if (spec.yMin != null) options.scales.y.min = spec.yMin;
    if (spec.yMax != null) options.scales.y.max = spec.yMax;
    if (spec.xMin != null) options.scales.x.min = spec.xMin;
    if (spec.xMax != null) options.scales.x.max = spec.xMax;
    return { type: 'bubble', data: { datasets: datasets }, options: options };
  }

  var BUILDERS = {
    line: function (s, p) { return buildLine(s, p); },
    bar: function (s, p) { return buildBars(s, p, 'bar'); },
    stacked100: function (s, p) { return buildBars(s, p, 'stacked100'); },
    paired: function (s, p) { return buildBars(s, p, 'paired'); },
    diverging: function (s, p) { return buildBars(s, p, 'diverging'); },
    histogram: function (s, p) { return buildBars(s, p, 'histogram'); },
    waterfall: function (s, p) { return buildBars(s, p, 'waterfall'); },
    bubble: function (s, p) { return buildBubble(s, p); }
  };

  /**
   * Builds the Chart.js config {type, data, options} for a spec without mounting it (pure; no Chart.js needed).
   * @param {object} spec
   * @param {'line'|'bar'|'stacked100'|'paired'|'diverging'|'histogram'|'waterfall'|'bubble'} [kind='line']
   * @returns {{type:string, data:object, options:object}|null}
   */
  function buildConfig(spec, kind) {
    kind = kind || 'line';
    if (!BUILDERS[kind]) return null;
    return BUILDERS[kind](normalizeSpec(spec), palette());
  }

  /* ------------------------------------------------------------------ */
  /* Table twin data (pure)                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Converts a chart spec into table-twin data.
   * @param {object} spec chart spec (§4.9)
   * @param {'line'|'bar'|'stacked100'|'paired'|'diverging'|'histogram'|'waterfall'|'bubble'} [kind='line']
   * @returns {{columns:{key:string,label:string}[], rows:object[]}}
   */
  function toTable(spec, kind) {
    spec = spec || {};
    kind = kind || 'line';
    var src = spec.datasets || [];
    var labelHeader = (kind === 'bar' || kind === 'stacked100' || kind === 'paired' || kind === 'diverging' || kind === 'waterfall')
      ? (spec.yLabel || 'Label') : (spec.xLabel || 'Label');
    var columns, rows;

    if (kind === 'bubble') {
      columns = [
        { key: 'label', label: 'Label' },
        { key: 'x', label: spec.xLabel || 'x' },
        { key: 'y', label: spec.yLabel || 'y' },
        { key: 'r', label: spec.rLabel || 'size' }
      ];
      rows = [];
      src.forEach(function (ds) {
        (ds.data || []).forEach(function (pt) {
          pt = pt || {};
          rows.push({ label: pt.label || ds.label || '', x: numOrNull(pt.x), y: numOrNull(pt.y), r: numOrNull(pt.r) });
        });
      });
      return { columns: columns, rows: rows };
    }

    if (kind === 'waterfall') {
      columns = [{ key: 'label', label: labelHeader }, { key: 'change', label: 'Change' }, { key: 'total', label: 'Running total' }];
      rows = waterfallRows(spec).map(function (r) {
        return { label: r.label, change: r.kind === 'total' ? null : round(r.value, 2), total: round(r.high, 2) };
      });
      return { columns: columns, rows: rows };
    }

    var labels = spec.labels || [];
    columns = [{ key: 'label', label: labelHeader }];
    var totals = null;
    if (kind === 'stacked100') {
      totals = labels.map(function (_, i) {
        return src.reduce(function (s, ds) { var v = ds.data && ds.data[i]; return s + (isNum(v) ? v : 0); }, 0);
      });
    }
    src.forEach(function (ds, i) {
      var name = ds.label || ('Series ' + (i + 1));
      var bandOnly = kind === 'line' && isBandOnly(ds);
      if (!bandOnly) columns.push({ key: 's' + i, label: kind === 'stacked100' ? name + ' %' : name });
      if (kind === 'line' && hasBand(ds)) {
        columns.push({ key: 's' + i + '_lo', label: name + ' low' });
        columns.push({ key: 's' + i + '_hi', label: name + ' high' });
      }
    });
    if (kind === 'stacked100') columns.push({ key: 'n', label: 'n' });

    rows = labels.map(function (label, k) {
      var row = { label: label };
      src.forEach(function (ds, i) {
        var v = ds.data && ds.data[k];
        if (kind === 'stacked100') {
          row['s' + i] = totals[k] > 0 && isNum(v) ? round(v / totals[k] * 100, 1) : 0;
        } else if (!(kind === 'line' && isBandOnly(ds))) {
          row['s' + i] = numOrNull(v);
        }
        if (kind === 'line' && hasBand(ds)) {
          row['s' + i + '_lo'] = numOrNull(ds.band.lo[k]);
          row['s' + i + '_hi'] = numOrNull(ds.band.hi[k]);
        }
      });
      if (kind === 'stacked100') row.n = totals[k];
      return row;
    });
    return { columns: columns, rows: rows };
  }

  function numOrNull(v) { return isNum(v) ? round(v, 2) : null; }

  /* ------------------------------------------------------------------ */
  /* Mounting                                                            */
  /* ------------------------------------------------------------------ */

  function resolveCanvas(el) {
    if (!el) return null;
    if (el.tagName && String(el.tagName).toUpperCase() === 'CANVAS') return el;
    if (typeof el.querySelector === 'function') {
      var existing = el.querySelector('canvas');
      if (existing) return existing;
    }
    if (typeof document !== 'undefined' && document.createElement && typeof el.appendChild === 'function') {
      var canvas = document.createElement('canvas');
      el.appendChild(canvas);
      return canvas;
    }
    return null;
  }

  function normalizeSpec(spec) {
    spec = spec || {};
    return Object.assign({}, spec, { datasets: Array.isArray(spec.datasets) ? spec.datasets : [], labels: Array.isArray(spec.labels) ? spec.labels : [] });
  }

  function applyAria(canvas, spec) {
    if (!canvas || typeof canvas.setAttribute !== 'function') return;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', spec.ariaLabel || '');
  }

  /**
   * Creates a chart of the given kind and returns its Handle, or null when Chart.js is
   * unavailable or the spec carries no datasets (chartCard renders its empty state).
   */
  function mount(el, spec, kind) {
    if (!available()) return null;
    spec = normalizeSpec(spec);
    if (!spec.datasets.length) return null;
    var canvas = resolveCanvas(el);
    if (!canvas) return null;
    var C = window.Chart;
    var p = palette();
    applyDefaults(p);
    if (typeof C.getChart === 'function') {
      var prior = C.getChart(canvas);
      if (prior) prior.destroy();
    }
    for (var i = live.length - 1; i >= 0; i--) if (live[i].el === canvas) live.splice(i, 1);

    applyAria(canvas, spec);
    var cfg = BUILDERS[kind](spec, p);
    var handle = {
      kind: kind,
      spec: spec,
      el: canvas,
      chart: new C(canvas, cfg),
      /**
       * Re-renders with a new (or partially patched) spec.
       * @param {object} patch full spec or the fields to replace
       */
      update: function (patch) {
        handle.spec = normalizeSpec(Object.assign({}, handle.spec, patch || {}));
        applyAria(canvas, handle.spec);
        var next = BUILDERS[kind](handle.spec, palette());
        handle.chart.data = next.data;
        handle.chart.options = next.options;
        handle.chart.update();
        return handle;
      },
      /** Destroys the Chart.js instance and forgets the handle. */
      destroy: function () {
        var idx = live.indexOf(handle);
        if (idx >= 0) live.splice(idx, 1);
        if (handle.chart) { handle.chart.destroy(); handle.chart = null; }
      },
      /** @returns {{columns, rows}} table twin for the current spec */
      toTable: function () { return toTable(handle.spec, kind); }
    };
    live.push(handle);
    return handle;
  }

  /** Line chart (time series, forecasts with dashed lines and lo/hi bands, vertical markers). */
  function line(el, spec) { return mount(el, spec, 'line'); }
  /** Horizontal bars by default (spec.vertical = true flips); per-bar colors, stacked, diverging. */
  function bar(el, spec) { return mount(el, spec, 'bar'); }
  /** Stacked horizontal percent bars; datasets carry counts, the chart shows shares with n in tooltips. */
  function stacked100(el, spec) { return mount(el, spec, 'stacked100'); }
  /** Two (or more) datasets side by side per category. */
  function paired(el, spec) { return mount(el, spec, 'paired'); }
  /** Signed horizontal bars colored by sign (--div-neg / --div-pos) on a symmetric axis. */
  function diverging(el, spec) { return mount(el, spec, 'diverging'); }
  /** x/y/r bubbles; spec.quadrants = {x, y, labels:[topLeft, topRight, bottomLeft, bottomRight]}. */
  function bubble(el, spec) { return mount(el, spec, 'bubble'); }
  /** Vertical bucket bars. */
  function histogram(el, spec) { return mount(el, spec, 'histogram'); }
  /** Floating bars from signed deltas; spec.totals {start:{label,value}, end:{label,value?}}, spec.kinds[]. */
  function waterfall(el, spec) { return mount(el, spec, 'waterfall'); }

  /** Re-reads the palette and re-themes every live chart. */
  function rethemeAll() {
    paletteCache = null;
    var p = palette();
    if (!available()) return;
    applyDefaults(p);
    live.slice().forEach(function (h) {
      if (!h.chart) return;
      var next = BUILDERS[h.kind](h.spec, p);
      h.chart.data = next.data;
      h.chart.options = next.options;
      h.chart.update('none');
    });
  }

  /** Destroys every live chart. */
  function destroyAll() {
    live.slice().forEach(function (h) { h.destroy(); });
    live.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Sparkline (inline SVG)                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Builds the sparkline SVG markup (pure).
   * @param {number[]} values
   * @param {{color?:string, width?:number, height?:number, ariaLabel?:string}} [opts]
   * @returns {string}
   */
  function sparklineSvg(values, opts) {
    opts = opts || {};
    var w = isNum(opts.width) ? opts.width : 96;
    var h = isNum(opts.height) ? opts.height : 28;
    var color = opts.color || 'var(--s1)';
    var pts = (values || []).map(Number).filter(isNum);
    var n = pts.length;
    var aria = opts.ariaLabel ? ' role="img" aria-label="' + escapeHtml(opts.ariaLabel) + '"' : ' aria-hidden="true"';
    var open = '<svg class="voc-spark' + (n ? '' : ' voc-spark--empty') + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"' + aria + '>';
    if (!n) return open + '</svg>';
    var pad = 3;
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    var span = max - min;
    var x = function (i) { return n === 1 ? w / 2 : pad + i * (w - 2 * pad) / (n - 1); };
    var y = function (v) { return span === 0 ? h / 2 : pad + (1 - (v - min) / span) * (h - 2 * pad); };
    var coords = pts.map(function (v, i) { return round(x(i), 1) + ',' + round(y(v), 1); });
    var body = '';
    if (n > 1) {
      var poly = coords.join(' ') + ' ' + round(x(n - 1), 1) + ',' + (h - pad) + ' ' + round(x(0), 1) + ',' + (h - pad);
      body += '<polygon points="' + poly + '" style="fill:' + color + ';fill-opacity:.15;stroke:none"/>';
      body += '<polyline points="' + coords.join(' ') + '" style="fill:none;stroke:' + color + ';stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round"/>';
    }
    body += '<circle cx="' + round(x(n - 1), 1) + '" cy="' + round(y(pts[n - 1]), 1) + '" r="2.5" style="fill:' + color + '"/>';
    return open + body + '</svg>';
  }

  /**
   * Renders an inline SVG sparkline into el (no Chart.js).
   * @param {Element} el
   * @param {number[]} values
   * @param {{color?:string, width?:number, height?:number, ariaLabel?:string}} [opts]
   */
  function sparkline(el, values, opts) {
    if (!el) return;
    el.innerHTML = sparklineSvg(values, opts);
  }

  /* ------------------------------------------------------------------ */
  /* Heatmap (CSS grid)                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Picks the ramp step (1..steps) for a value as a fraction of the max; 0 means empty.
   * @param {number} value
   * @param {number} max
   * @param {number} [steps=8]
   * @returns {number}
   */
  function rampStep(value, max, steps) {
    steps = steps || 8;
    if (!isNum(value) || !isNum(max) || value <= 0 || max <= 0) return 0;
    return clamp(Math.ceil(value / max * steps), 1, steps);
  }

  /**
   * Text color that clears WCAG AA (4.5:1) on ramp step `step` (1..8). One threshold for every ramp-shaded cell.
   * Light: --text through step 6 (5.5:1 on --seq-6), --surface (white) from step 7 (4.9:1 on --seq-7).
   * Dark: the ramp is translucent green over --surface, so white clears through step 5 (4.7:1) and the near-black
   * --bg from step 6 (4.8:1).
   * @param {number} step 0 (empty) .. 8
   * @param {boolean} [dark] theme; defaults to the document's current theme (light when there is no DOM)
   * @returns {string} a CSS color (token reference or hex)
   */
  function rampTextColor(step, dark) {
    var s = isNum(step) ? Math.round(step) : 0;
    var isDark = typeof dark === 'boolean' ? dark : themeIsDark();
    if (isDark) return s >= 6 ? 'var(--bg)' : '#FFFFFF';
    return s >= 7 ? 'var(--surface)' : 'var(--text)';
  }

  /** Class name for a ramp-shaded cell; css/components.css maps .ramp-step-N to the AA-safe text color in both themes. */
  function rampCellClass(step) {
    var s = isNum(step) ? Math.round(step) : 0;
    if (s < 1) return '';
    return 'ramp-step-' + Math.min(8, s);
  }

  function themeIsDark() {
    if (typeof document === 'undefined' || !document || !document.documentElement || typeof document.documentElement.getAttribute !== 'function') return false;
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  function defaultCountFormat(v) {
    return v === 1 ? '1 message' : fmtInt(v) + ' messages';
  }

  /**
   * Builds heatmap markup (pure).
   * @param {number[][]} matrix rows × cols
   * @param {{rowLabels?:string[], colLabels?:string[], format?:function(number,number,number):string, onClick?:function,
   *   colLabelEvery?:number, showValues?:boolean, smallN?:number, ariaLabel?:string}} [opts]
   * @returns {string}
   */
  function heatmapHtml(matrix, opts) {
    opts = opts || {};
    matrix = Array.isArray(matrix) ? matrix : [];
    var rowsN = matrix.length;
    var colsN = matrix.reduce(function (m, r) { return Math.max(m, Array.isArray(r) ? r.length : 0); }, 0);
    var rowLabels = opts.rowLabels || [], colLabels = opts.colLabels || [];
    var fmt = typeof opts.format === 'function' ? opts.format : defaultCountFormat;
    var clickable = typeof opts.onClick === 'function';
    var every = opts.colLabelEvery || (colsN > 12 ? 3 : 1);
    var max = 0;
    matrix.forEach(function (r) { (r || []).forEach(function (v) { if (isNum(v) && v > max) max = v; }); });

    var html = '<div class="voc-heatmap" role="group"' + (opts.ariaLabel ? ' aria-label="' + escapeHtml(opts.ariaLabel) + '"' : '') +
      ' style="display:grid;grid-template-columns:auto repeat(' + colsN + ',minmax(0,1fr));gap:2px">';
    html += '<div class="voc-heatmap__corner"></div>';
    for (var c = 0; c < colsN; c++) {
      var cl = colLabels[c] != null ? colLabels[c] : String(c);
      html += '<div class="voc-heatmap__col">' + (c % every === 0 ? escapeHtml(cl) : '') + '</div>';
    }
    for (var r = 0; r < rowsN; r++) {
      var rl = rowLabels[r] != null ? rowLabels[r] : String(r);
      html += '<div class="voc-heatmap__row">' + escapeHtml(rl) + '</div>';
      for (var k = 0; k < colsN; k++) {
        var raw = matrix[r] ? matrix[r][k] : 0;
        var v = isNum(raw) ? raw : 0;
        var step = rampStep(v, max);
        var cl2 = colLabels[k] != null ? colLabels[k] : String(k);
        var title = escapeHtml(rl + ' ' + cl2 + ' · ' + fmt(v, r, k));
        var style = 'background:' + (step ? 'var(--seq-' + step + ')' : 'var(--surface-2)') + ';';
        var cls = 'voc-heatmap__cell' + (step ? ' ' + rampCellClass(step) : '');
        if (isNum(opts.smallN) && v > 0 && v < opts.smallN) {
          cls += ' voc-heatmap__cell--small';
          style += 'background-image:repeating-linear-gradient(135deg,transparent 0 3px,var(--surface) 3px 4px);';
        }
        var text = opts.showValues && v > 0 ? escapeHtml(fmtInt(v)) : '';
        html += clickable
          ? '<button type="button" class="' + cls + '" data-row="' + r + '" data-col="' + k + '" title="' + title + '" aria-label="' + title + '" style="' + style + '">' + text + '</button>'
          : '<div class="' + cls + '" data-row="' + r + '" data-col="' + k + '" title="' + title + '" aria-label="' + title + '" style="' + style + '">' + text + '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  /**
   * Renders a weekday × hour (or any) heatmap into el as a CSS grid with an 8-step token ramp.
   * @param {Element} el
   * @param {number[][]} matrix
   * @param {{rowLabels?:string[], colLabels?:string[], format?:function, onClick?:function(number,number,number), seq?:string,
   *   showValues?:boolean, smallN?:number, ariaLabel?:string}} [opts]
   */
  function heatmap(el, matrix, opts) {
    if (!el) return;
    opts = opts || {};
    injectStyle();
    el.innerHTML = heatmapHtml(matrix, opts);
    if (typeof el.addEventListener === 'function') {
      if (el._vocHeatClick) el.removeEventListener('click', el._vocHeatClick);
      el._vocHeatClick = null;
      if (typeof opts.onClick === 'function') {
        el._vocHeatClick = function (evt) {
          var t = evt && evt.target;
          var cell = t && typeof t.closest === 'function' ? t.closest('.voc-heatmap__cell') : null;
          if (!cell) return;
          var r = +cell.getAttribute('data-row'), c = +cell.getAttribute('data-col');
          var v = matrix[r] && isNum(matrix[r][c]) ? matrix[r][c] : 0;
          opts.onClick(r, c, v);
        };
        el.addEventListener('click', el._vocHeatClick);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Table twin                                                          */
  /* ------------------------------------------------------------------ */

  function formatCell(v, col) {
    if (col && typeof col.format === 'function') return escapeHtml(col.format(v));
    if (v == null || v === '') return '—';
    if (isNum(v)) return escapeHtml(fmtNum(v));
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return escapeHtml(String(v));
  }

  /**
   * Builds accessible table markup (pure).
   * @param {{columns:{key:string,label:string,format?:function}[], rows:object[], caption?:string}} data
   * @returns {string}
   */
  function tableHtml(data) {
    data = data || {};
    var columns = Array.isArray(data.columns) ? data.columns : [];
    var rows = Array.isArray(data.rows) ? data.rows : [];
    var numeric = columns.map(function (col) {
      return rows.some(function (row) { return isNum(row[col.key]); });
    });
    var html = '<table class="voc-table-twin">';
    if (data.caption) html += '<caption>' + escapeHtml(data.caption) + '</caption>';
    html += '<thead><tr>';
    columns.forEach(function (col, i) {
      html += '<th scope="col"' + (numeric[i] ? ' class="num"' : '') + '>' + escapeHtml(col.label != null ? col.label : col.key) + '</th>';
    });
    html += '</tr></thead><tbody>';
    if (!rows.length) {
      html += '<tr><td colspan="' + Math.max(1, columns.length) + '" class="voc-table-twin__empty">No data (n = 0)</td></tr>';
    }
    rows.forEach(function (row) {
      html += '<tr>';
      columns.forEach(function (col, i) {
        html += '<td' + (numeric[i] ? ' class="num"' : '') + '>' + formatCell(row[col.key], col) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  /**
   * Renders an accessible table twin into el.
   * @param {Element} el
   * @param {{columns:{key:string,label:string,format?:function}[], rows:object[], caption?:string}} data
   */
  function tableTwin(el, data) {
    if (!el) return;
    injectStyle();
    el.innerHTML = tableHtml(data);
  }

  /** Injects the minimal layout rules the heatmap/table/sparkline need, once. */
  function injectStyle() {
    if (styleInjected) return;
    if (typeof document === 'undefined' || !document || !document.head || typeof document.createElement !== 'function') return;
    styleInjected = true;
    if (document.getElementById && document.getElementById('voc-charts-style')) return;
    var style = document.createElement('style');
    style.id = 'voc-charts-style';
    style.textContent = [
      '.voc-heatmap__col,.voc-heatmap__row{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}',
      '.voc-heatmap__col{text-align:center;padding-bottom:2px}',
      '.voc-heatmap__row{padding-right:6px;display:flex;align-items:center}',
      '.voc-heatmap__cell{border:0;border-radius:3px;min-height:18px;padding:0;font:inherit;font-size:11px;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      'button.voc-heatmap__cell{cursor:pointer}',
      'button.voc-heatmap__cell:focus-visible{outline:2px solid var(--focus);outline-offset:1px}',
      '.voc-table-twin{width:100%;border-collapse:collapse;font-size:13px}',
      '.voc-table-twin caption{text-align:left;color:var(--muted);font-size:12px;padding:0 0 6px}',
      '.voc-table-twin th,.voc-table-twin td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;font-variant-numeric:tabular-nums}',
      '.voc-table-twin th{color:var(--text-2);font-weight:600;font-size:12px}',
      '.voc-table-twin td.num,.voc-table-twin th.num{text-align:right}',
      '.voc-table-twin__empty{color:var(--muted)}',
      '.voc-spark{display:inline-block;vertical-align:middle;overflow:visible}'
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* OS theme changes re-theme automatically (app also calls rethemeAll) */
  /* ------------------------------------------------------------------ */

  if (typeof matchMedia === 'function') {
    try {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { rethemeAll(); };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    } catch (e) { /* no media query support: app.js calls rethemeAll on theme change */ }
  }

  /* ------------------------------------------------------------------ */

  window.VOC.charts = {
    SLOTS: SLOTS,
    available: available,
    palette: palette,
    slotColor: slotColor,
    statusColor: statusColor,
    sentimentColor: sentimentColor,
    divergingColor: divergingColor,
    withAlpha: withAlpha,
    dashFor: dashFor,
    isBandOnly: isBandOnly,
    buildConfig: buildConfig,
    applyDefaults: applyDefaults,
    plugins: { markers: markerPlugin },
    line: line,
    bar: bar,
    stacked100: stacked100,
    paired: paired,
    diverging: diverging,
    bubble: bubble,
    histogram: histogram,
    waterfall: waterfall,
    toTable: toTable,
    sparkline: sparkline,
    sparklineSvg: sparklineSvg,
    heatmap: heatmap,
    heatmapHtml: heatmapHtml,
    rampStep: rampStep,
    rampTextColor: rampTextColor,
    rampCellClass: rampCellClass,
    tableTwin: tableTwin,
    tableHtml: tableHtml,
    rethemeAll: rethemeAll,
    destroyAll: destroyAll
  };
})();
