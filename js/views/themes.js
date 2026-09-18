/* L-Nutra · Voice of the Customer — Themes view (SPEC §5 item 3)
   Category bars (expandable to subcategories), priority matrix, driver analysis, what-changed waterfall,
   distinctive terms, n-gram themes table with KWIC, and the topic × product heat-table.
   Loads under jsc: the DOM is touched only inside mount/update/unmount. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'themes';
  var TITLE = 'Themes';
  var SLOT_PRODUCTS = ['prolon_5day', 'prolon_nextgen', 'prolon_reset', 'fast_bar', 'fasting_shake', 'l_protein', 'l_pill', 'subscription_account'];
  var DIMENSIONS = [['category', 'Category'], ['subcategory', 'Subcategory'], ['product', 'Product'], ['channel', 'Channel'], ['segment', 'Segment']];
  var MIN_N = 10;
  var TERMS_TOP = 12;
  var NGRAM_TOP = 30;
  var KWIC_MAX = 5;
  var SPARK_WEEKS = 5;
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var state = { dimension: 'category', expandedCategory: null, expandedGram: null };
  var cur = { root: null, derived: null, cards: {}, els: {}, cache: null, onResize: null };
  var bubbleLabelsRegistered = false;

  /* ------------------------------------------------------------------ helpers */

  function U() { return VOC.util || null; }
  function EN() { return VOC.enums || (VOC.util && VOC.util.enums) || null; }
  function ui() { return VOC.ui || null; }
  function charts() { return VOC.charts || null; }
  function store() { return VOC.store || null; }
  function A() { return VOC.analytics || null; }
  function P() { return VOC.predict || null; }
  /** Agent names from Settings, so ngrams/distinctiveTerms drop staff names (opts.agents beats the seed default). */
  function agentNames() {
    var s = store();
    if (!s || typeof s.settings !== 'function') return null;
    try { var st = s.settings(); return st && Array.isArray(st.agents) ? st.agents : null; } catch (e) { return null; }
  }
  /**
   * Fixed color per category id (never by rank): the first eight categories in the taxonomy take series slots 1–8,
   * every other category is grey, so a filter that removes or reorders categories never recolors a survivor.
   */
  var categorySlotCache = null;
  function categorySlot(id) {
    if (!categorySlotCache) {
      categorySlotCache = {};
      var list = EN() && typeof EN().list === 'function' ? (EN().list('CATEGORIES') || []) : [];
      var i = 0;
      list.forEach(function (o) {
        var cid = o && typeof o === 'object' ? o.id : o;
        if (!cid || cid === 'other_noise') return;
        i += 1;
        categorySlotCache[cid] = i <= 8 ? i : 'other';
      });
    }
    return categorySlotCache[id] || 'other';
  }
  function categoryColor(id, p) {
    var slot = categorySlot(id);
    return slot === 'other' ? p.other : p.series[slot - 1];
  }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function esc(s) {
    if (ui() && ui().esc) return ui().esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function h(tag, attrs, children) {
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
  function fmtInt(n) { var u = U(); return u ? u.fmt.int(n) : String(Math.round(n)); }
  function fmtNum(n, d) { var u = U(); return u ? u.fmt.num(n, d || 0) : (isNum(n) ? n.toFixed(d || 0) : '—'); }
  function fmtPct01(p, d) { var u = U(); return u ? u.fmt.pct(p, d || 0) : (isNum(p) ? (p * 100).toFixed(d || 0) + '%' : '—'); }
  function signed(n, d) { if (!isNum(n)) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + fmtNum(Math.abs(n), d || 0); }
  function label(kind, id) { var e = EN(); return e && typeof e.label === 'function' ? e.label(kind, id) : String(id); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + fmtInt(derived.n) + ' records' : '';
  }
  /**
   * One bold sentence for the header: the top category with its share and mean sentiment, always with n.
   * @param {Object|null} derived
   * @param {Object|null} c  data(derived), when already computed
   */
  function leadText(derived, c) {
    if (!derived || !isNum(derived.n)) return 'Data is loading.';
    var cats = c && c.categories ? c.categories : (derived.byCategory || []).filter(function (r) { return r.count > 0 && r.id !== 'other_noise'; }).slice().sort(function (a, b) { return b.count - a.count; });
    if (!derived.n || !cats.length) return 'No categorized records match the current filters (n=' + fmtInt(derived.n || 0) + ').';
    var top = cats[0];
    var name = top.label || label('category', top.id);
    var sent = isNum(top.meanSentiment) ? '; mean sentiment ' + signed(top.meanSentiment, 2) + ', ' + sentimentLabelOf(top.meanSentiment) : '';
    return name + ' leads with ' + fmtInt(top.count) + (top.count === 1 ? ' record' : ' records') + ', ' + fmtPct01(top.share) + ' of volume' + sent + ' (n=' + fmtInt(derived.n) + ').';
  }
  function buildHeader(derived) {
    if (ui() && typeof ui().viewHeader === 'function') return ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived, null) });
    return h('header', { class: 'view-header' }, [h('h1', { class: 'view-title' }, TITLE), h('p', { class: 'view-meta', 'data-role': 'subtitle' }, subtitle(derived))]);
  }
  function setHeader(derived, c) {
    var hd = cur.els && cur.els.header;
    if (!hd) return;
    if (hd.setMeta) hd.setMeta(subtitle(derived)); else { var sub = hd.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(derived); }
    if (hd.setLead) hd.setLead(leadText(derived, c));
  }
  function sentimentLabelOf(mean) {
    if (!isNum(mean)) return 'unscored';
    return mean > 0.15 ? 'positive' : mean < -0.15 ? 'negative' : 'neutral';
  }
  function median(a) {
    var v = a.filter(isNum).sort(function (x, y) { return x - y; });
    if (!v.length) return null;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function setCardN(card, n) {
    if (!card) return;
    var span = card.querySelector('.chart-card__n');
    if (!span) {
      var q = card.querySelector('.chart-card__question');
      if (!q) return;
      span = h('span', { class: 'chart-card__n' });
      q.appendChild(document.createTextNode(' · '));
      q.appendChild(span);
    }
    span.textContent = 'n = ' + fmtInt(isNum(n) ? n : 0);
  }
  function setCardQuestion(card, text, n) {
    if (!card) return;
    var q = card.querySelector('.chart-card__question');
    if (q) q.innerHTML = esc(text);
    setCardN(card, n);
  }
  function setCardFoot(card, text) {
    if (!card) return;
    var f = card.querySelector('.chart-card__foot');
    if (f) f.textContent = text || '';
  }
  function refreshCard(card) { if (card && typeof card.vocRefresh === 'function') card.vocRefresh(); }
  /** Replace chartCard's generic "widen the range" empty state with copy that names the real reason. */
  function emptyCopy(card, title, text) {
    if (!card || card.vocHandle) return;
    var twin = card.querySelector('.table-twin');
    if (!twin || !twin.querySelector('.empty-state') || !ui() || !ui().emptyState) return;
    ui().emptyState(twin, { title: title, text: text });
  }
  function fixEmptyCopies() {
    var c = cur.derived ? data(cur.derived) : null;
    if (!c) return;
    if (!c.hasCompare) emptyCopy(cur.cards.changed, 'No comparison period', 'Choose “vs prior period” or “vs prior year” in the filter bar to decompose the change in negative records.');
    if (c.records.length < MIN_N) {
      var t = 'Too few records (n = ' + fmtInt(c.records.length) + ')', x = 'Theme analytics need at least ' + MIN_N + ' records. Widen the date range or clear a filter.';
      emptyCopy(cur.cards.drivers, t, x); emptyCopy(cur.cards.terms, t, x); emptyCopy(cur.cards.matrix, t, x); emptyCopy(cur.cards.heat, t, x);
    }
  }
  function scheduleEmptyCopies() {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { requestAnimationFrame(fixEmptyCopies); });
    setTimeout(fixEmptyCopies, 400); /* also covers throttled tabs where rAF is delayed */
  }
  function destroyCard(card) { if (card && typeof card.vocDestroy === 'function') card.vocDestroy(); }
  function drill(target) {
    var s = store();
    if (s && typeof s.drill === 'function') { s.drill(target); return; }
    if (VOC.router) VOC.router.navigate(target.view || 'inbox', { id: target.id });
  }

  /** Private helper: an HTML renderer inside a chartCard (see trends.js; suggested as chartCard `renderHtml`). */
  function htmlHandle(canvas, renderInto, tableFn) {
    var wrap = canvas && canvas.parentNode;
    if (!wrap) return null;
    var host = wrap.querySelector('.html-chart');
    if (!host) { host = h('div', { class: 'html-chart' }); wrap.appendChild(host); }
    canvas.style.display = 'none';
    host.hidden = false;
    renderInto(host);
    return {
      chart: null, el: host,
      update: function () { renderInto(host); return this; },
      destroy: function () { host.innerHTML = ''; host.hidden = true; canvas.style.display = ''; },
      toTable: tableFn
    };
  }

  /**
   * Private Chart.js plugin: draws each bubble's label next to it when the canvas carries data-voc-labels="1".
   * Suggested for charts.js as a bubble spec option (`labels: true`).
   */
  function ensureBubbleLabels() {
    if (bubbleLabelsRegistered || typeof window === 'undefined' || typeof window.Chart !== 'function' || typeof window.Chart.register !== 'function') return;
    bubbleLabelsRegistered = true;
    window.Chart.register({
      id: 'vocBubbleLabels',
      afterDatasetsDraw: function (chart) {
        if (!chart.canvas || chart.canvas.getAttribute('data-voc-labels') !== '1' || chart.config.type !== 'bubble') return;
        var ctx = chart.ctx, area = chart.chartArea;
        var p = charts() ? charts().palette() : null;
        ctx.save();
        ctx.font = '11px ' + ((p && p.font) || 'system-ui, sans-serif');
        ctx.fillStyle = (p && p.text2) || '#3F4A46';
        ctx.textBaseline = 'middle';
        // Collect every candidate, largest bubble first, and skip labels whose box would overlap one already drawn
        // (the tooltip still names every bubble). Small clusters of low-volume topics stay legible this way.
        var candidates = [];
        chart.data.datasets.forEach(function (ds, di) {
          var meta = chart.getDatasetMeta(di);
          if (!meta || meta.hidden) return;
          meta.data.forEach(function (pt, i) {
            var raw = ds.data[i];
            if (!raw || !raw.label || !pt) return;
            var r = isNum(pt.options && pt.options.radius) ? pt.options.radius : 6;
            candidates.push({ label: String(raw.label), x: pt.x, y: pt.y, r: r });
          });
        });
        candidates.sort(function (a, b) { return b.r - a.r; });
        var drawn = [];
        function overlaps(box) {
          return drawn.some(function (b) { return box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0; });
        }
        candidates.forEach(function (c) {
          var w = ctx.measureText(c.label).width, hh = 7;
          var x = c.x + c.r + 4, align = 'left';
          if (x + w > area.right) { align = 'right'; x = c.x - c.r - 4; }
          var box = align === 'left' ? { x0: x, x1: x + w, y0: c.y - hh, y1: c.y + hh } : { x0: x - w, x1: x, y0: c.y - hh, y1: c.y + hh };
          if (box.y0 < area.top || box.y1 > area.bottom || overlaps(box)) return;
          ctx.textAlign = align;
          ctx.fillText(c.label, x, c.y);
          drawn.push(box);
        });
        ctx.restore();
      }
    });
  }

  /* ------------------------------------------------------------------ data (memoized per derived) */

  function data(derived) {
    if (cur.cache && cur.cache.derived === derived) return cur.cache;
    var recs = derived.records || [];
    var cmp = Array.isArray(derived.compare) ? derived.compare : [];
    var hasCompare = cmp.length > 0 && derived.filters && derived.filters.compare !== 'none';
    var c = { derived: derived, records: recs, compare: cmp, hasCompare: hasCompare };
    // Text mining (distinctive terms, phrases, snippets) reads bodies, so restricted (PHI-adjacent) records are left out
    // unless the restricted queue is open or client-side redaction is switched off (SPEC §8).
    c.mineRestricted = !!(derived.filters && derived.filters.restrictedQueue) || !!(derived.settings && derived.settings.redactRestricted === false);
    c.mining = c.mineRestricted ? recs : recs.filter(function (r) { return !r.restricted; });
    c.miningCompare = c.mineRestricted ? cmp : cmp.filter(function (r) { return !r.restricted; });

    c.categories = (derived.byCategory || []).filter(function (r) { return r.count > 0 && r.id !== 'other_noise'; }).slice()
      .sort(function (a, b) { return b.count - a.count; });

    c.impact = {};
    if (A() && typeof A().themeImpact === 'function') {
      try { (A().themeImpact(recs) || []).forEach(function (r) { c.impact[r.category] = r; }); } catch (e) { /* no impact */ }
    }
    c.npsN = recs.filter(function (r) { return isNum(r.nps); }).length;

    c.drivers = null;
    if (P() && typeof P().driverAnalysis === 'function' && recs.length) {
      try { c.drivers = P().driverAnalysis(recs, state.dimension, { now: derived.now }); } catch (e) { c.drivers = null; }
    }
    c.changed = null;
    if (hasCompare && P() && typeof P().whatChanged === 'function') {
      try { c.changed = P().whatChanged(recs, cmp, 'category', { now: derived.now }); } catch (e) { c.changed = null; }
    }
    c.terms = null; c.termsMode = 'compare';
    if (A() && typeof A().distinctiveTerms === 'function' && c.mining.length) {
      try {
        var agents = agentNames();
        var mineOpts = { top: TERMS_TOP, agents: agents, includeRestricted: c.mineRestricted };
        if (hasCompare) c.terms = A().distinctiveTerms(c.mining, c.miningCompare, mineOpts);
        else {
          var neg = c.mining.filter(function (r) { return r.sentiment_label === 'negative'; });
          var rest = c.mining.filter(function (r) { return r.sentiment_label !== 'negative'; });
          c.termsMode = 'sentiment';
          c.terms = neg.length && rest.length ? A().distinctiveTerms(neg, rest, mineOpts) : null;
        }
      } catch (e) { c.terms = null; }
    }
    c.ngrams = [];
    if (A() && typeof A().ngrams === 'function' && c.mining.length) {
      try { c.ngrams = A().ngrams(c.mining, { n: [2, 3], minDf: 3, top: NGRAM_TOP, samples: KWIC_MAX, agents: agentNames(), includeRestricted: c.mineRestricted }) || []; } catch (e) { c.ngrams = []; }
    }
    c.tokens = null; /* lazily built ' tok tok ' strings per record for gram matching */
    c.matrix = buildMatrix(c);
    cur.cache = c;
    return c;
  }

  /** Records whose content-token stream contains the gram as consecutive tokens. */
  function recordsWithGram(c, gram) {
    if (!c.tokens) {
      var toks = A() && typeof A().contentTokens === 'function' ? A().contentTokens : function (t) { return String(t || '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean); };
      c.tokens = c.mining.map(function (r) { return ' ' + toks((r.subject ? r.subject + ' ' : '') + (r.text || '')).join(' ') + ' '; });
    }
    var needle = ' ' + gram + ' ';
    var out = [];
    for (var i = 0; i < c.mining.length; i++) if (c.tokens[i].indexOf(needle) >= 0) out.push(c.mining[i]);
    return out;
  }

  /** Counts per ISO week for the last SPARK_WEEKS weeks of the range. */
  function weeklyCounts(c, list) {
    var u = U(), f = c.derived.filters;
    if (!u || !f || !f.range) return [];
    var weeks = [], wk = u.weekKey(f.range.to + 'T18:00:00Z');
    for (var i = 0; i < SPARK_WEEKS; i++) { weeks.unshift(wk); wk = u.weekKey(u.addDays(u.weekStart(wk), -7) + 'T18:00:00Z'); }
    var counts = {};
    weeks.forEach(function (w) { counts[w] = 0; });
    list.forEach(function (r) { if (counts[r.week_key] !== undefined) counts[r.week_key] += 1; });
    return weeks.map(function (w) { return counts[w]; });
  }

  /** Topic × product matrix with expected counts under independence. */
  function buildMatrix(c) {
    var cols = SLOT_PRODUCTS.concat(['__other__']);
    var colIndex = {};
    cols.forEach(function (p, i) { colIndex[p] = i; });
    var rowsById = {};
    c.categories.forEach(function (cat) { rowsById[cat.id] = { id: cat.id, label: cat.label || label('category', cat.id), cells: cols.map(function () { return 0; }), total: 0 }; });
    var colTotals = cols.map(function () { return 0; });
    var N = 0;
    c.records.forEach(function (r) {
      var row = rowsById[r.category];
      if (!row) return;
      var j = colIndex[r.product] !== undefined ? colIndex[r.product] : colIndex.__other__;
      row.cells[j] += 1; row.total += 1; colTotals[j] += 1; N += 1;
    });
    var rows = c.categories.map(function (cat) { return rowsById[cat.id]; });
    rows.forEach(function (row) {
      row.expected = row.cells.map(function (_, j) { return N ? row.total * colTotals[j] / N : 0; });
    });
    return { cols: cols, colLabels: cols.map(function (p) { return p === '__other__' ? 'Other' : label('product', p); }), rows: rows, colTotals: colTotals, n: N };
  }

  /* ------------------------------------------------------------------ (a) category bars + subcategory panel */

  function categorySpec(c) {
    var C = charts();
    if (!C || !c.categories.length) return null;
    return {
      labels: c.categories.map(function (r) { return r.label || label('category', r.id); }),
      datasets: [{ label: 'Messages', data: c.categories.map(function (r) { return r.count; }), colors: c.categories.map(function (r) { return C.sentimentColor(isNum(r.meanSentiment) ? r.meanSentiment : null); }) }],
      xLabel: 'messages', ariaLabel: 'Messages per category, colored by mean sentiment, ' + c.categories.length + ' categories',
      onClick: function (index) { var row = c.categories[index]; if (row) toggleCategory(row.id); }
    };
  }
  function categoryTable(c) {
    return {
      columns: [{ key: 'label', label: 'Category' }, { key: 'count', label: 'Messages' }, { key: 'share', label: 'Share', format: function (v) { return fmtPct01(v); } },
        { key: 'meanSentiment', label: 'Mean sentiment', format: function (v) { return isNum(v) ? fmtNum(v, 2) : '—'; } }, { key: 'negShare', label: 'Negative share', format: function (v) { return fmtPct01(v); } }],
      rows: c.categories.map(function (r) { return { label: r.label || label('category', r.id), count: r.count, share: r.share, meanSentiment: r.meanSentiment, negShare: r.negShare }; })
    };
  }
  function toggleCategory(id) {
    state.expandedCategory = state.expandedCategory === id ? null : id;
    renderSubPanel();
  }
  function renderSubPanel() {
    var panel = cur.els.subPanel;
    if (!panel || !cur.derived) return;
    var id = state.expandedCategory;
    if (!id) { panel.hidden = true; panel.innerHTML = ''; return; }
    var c = data(cur.derived);
    var cat = c.categories.filter(function (r) { return r.id === id; })[0];
    var rows = (cur.derived.bySubcategory || []).filter(function (r) { return r.category === id && r.count > 0; }).slice().sort(function (a, b) { return b.count - a.count; });
    if (!rows.length && U()) {
      var counts = U().countBy(c.records.filter(function (r) { return r.category === id; }), 'subcategory');
      counts.forEach(function (n, sub) { rows.push({ id: sub, label: label('subcategory', sub), count: n, meanSentiment: null, negShare: null }); });
      rows.sort(function (a, b) { return b.count - a.count; });
    }
    var total = cat ? cat.count : rows.reduce(function (s, r) { return s + r.count; }, 0);
    var max = rows.length ? rows[0].count : 1;
    panel.hidden = false;
    panel.innerHTML = '';
    var head = h('div', { class: 'sub-panel__head' }, [
      h('strong', {}, (cat ? (cat.label || label('category', id)) : label('category', id)) + ' › subcategories'),
      h('span', { class: 'muted t-13' }, ' n = ' + fmtInt(total)),
      h('span', { class: 'flex-1' }),
      h('button', { class: 'btn btn--ghost btn--xs', type: 'button', onclick: function () { drill({ view: 'inbox', filters: { category: [id], subcategory: [] } }); } }, 'Open in Inbox →'),
      h('button', { class: 'btn btn--ghost btn--xs', type: 'button', 'aria-label': 'Collapse subcategories', onclick: function () { toggleCategory(id); } }, 'Close')
    ]);
    panel.appendChild(head);
    if (!rows.length) { panel.appendChild(h('p', { class: 'muted t-13' }, 'No subcategory detail for this range.')); return; }
    var list = h('ul', { class: 'sub-panel__list' });
    rows.forEach(function (r) {
      var color = charts() ? charts().sentimentColor(isNum(r.meanSentiment) ? r.meanSentiment : null) : 'var(--s-other)';
      // A plain <button> inside an <li>: the list keeps its semantics and the row keeps its button semantics.
      var btn = h('button', { class: 'sub-row', type: 'button', title: 'Open ' + (r.label || r.id) + ' in the Inbox',
        onclick: function () { drill({ view: 'inbox', filters: { category: [id], subcategory: [r.id] } }); } }, [
        h('span', { class: 'sub-row__label truncate' }, r.label || label('subcategory', r.id)),
        h('span', { class: 'sub-row__bar' }, h('span', { class: 'sub-row__fill', style: 'width:' + Math.max(2, Math.round(r.count / max * 100)) + '%;background:' + color })),
        h('span', { class: 'sub-row__n num' }, fmtInt(r.count) + (total ? ' · ' + fmtPct01(r.count / total) : '')),
        ui() && ui().pill ? ui().pill('sentiment', sentimentLabelOf(r.meanSentiment)) : null
      ]);
      list.appendChild(h('li', {}, btn));
    });
    panel.appendChild(list);
  }

  /* ------------------------------------------------------------------ (b) priority matrix */

  function matrixPoints(c) {
    return c.categories.map(function (r) {
      var imp = c.impact[r.id];
      var y = isNum(r.meanSentiment) ? (r.meanSentiment + 1) / 2 * 100 : null;
      return { id: r.id, label: r.label || label('category', r.id), x: r.count, y: y, r: imp && isNum(imp.impact) ? Math.abs(imp.impact) : 0, impact: imp && isNum(imp.impact) ? imp.impact : null, n: r.count, npsN: imp ? imp.n : 0 };
    }).filter(function (p) { return isNum(p.y); });
  }
  function bubbleSpec(c) {
    var C = charts();
    var pts = matrixPoints(c);
    if (!C || pts.length < 2) return null;
    var p = C.palette();
    var ds = { label: 'Categories', data: pts, colors: pts.map(function (q) { return categoryColor(q.id, p); }) };
    var medVol = median(pts.map(function (q) { return q.x; }));
    return {
      datasets: [ds], xLabel: 'messages', yLabel: 'mean sentiment index', rLabel: '|NPS impact|', yMin: 0, yMax: 100, xMin: 0, rMax: 24,
      quadrants: { x: medVol, y: 50 },
      ariaLabel: 'Priority matrix: ' + pts.length + ' categories by volume, mean sentiment index and NPS impact'
    };
  }
  function bubbleTable(c) {
    return {
      columns: [{ key: 'label', label: 'Category' }, { key: 'x', label: 'Messages' }, { key: 'y', label: 'Sentiment index', format: function (v) { return isNum(v) ? fmtNum(v, 1) : '—'; } },
        { key: 'impact', label: 'NPS impact', format: function (v) { return isNum(v) ? signed(v, 1) : '—'; } }, { key: 'npsN', label: 'n with NPS' }, { key: 'quadrant', label: 'Quadrant' }],
      rows: (function () {
        var pts = matrixPoints(c), medVol = median(pts.map(function (q) { return q.x; }));
        return pts.map(function (q) { return { label: q.label, x: q.x, y: q.y, impact: q.impact, npsN: q.npsN, quadrant: quadrantOf(q, medVol) }; });
      })()
    };
  }
  function quadrantOf(q, medVol) {
    var hi = isNum(medVol) && q.x >= medVol;
    if (q.y < 50) return hi ? 'Fix now' : 'Monitor';
    return hi ? 'Protect' : 'Low priority';
  }
  function positionQuadrantLabels() {
    var card = cur.cards.matrix, overlay = cur.els.quadrants;
    if (!card || !overlay) return;
    var handle = card.vocHandle, chart = handle && handle.chart;
    var area = chart && chart.chartArea;
    if (!area || !isNum(area.left)) { overlay.style.inset = '10px 14px 32px 48px'; return; }
    var wrap = overlay.parentNode, W = wrap.clientWidth, H = wrap.clientHeight;
    overlay.style.left = area.left + 'px'; overlay.style.top = area.top + 'px';
    overlay.style.right = Math.max(0, W - area.right) + 'px'; overlay.style.bottom = Math.max(0, H - area.bottom) + 'px';
  }
  function renderMatrix(canvas) {
    var c = data(cur.derived);
    var spec = bubbleSpec(c);
    var wrap = canvas.parentNode;
    var overlay = wrap ? wrap.querySelector('.quadrants') : null;
    if (!spec) { if (overlay) overlay.hidden = true; return null; }
    ensureBubbleLabels();
    canvas.setAttribute('data-voc-labels', '1');
    var handle = charts().bubble(canvas, spec);
    if (!handle) { if (overlay) overlay.hidden = true; return null; }
    if (!overlay && wrap) {
      overlay = h('div', { class: 'quadrants', 'aria-hidden': 'true' }, [
        h('span', { class: 'quadrants__label quadrants__label--tl' }, 'Low priority'),
        h('span', { class: 'quadrants__label quadrants__label--tr' }, 'Protect'),
        h('span', { class: 'quadrants__label quadrants__label--bl' }, 'Monitor'),
        h('span', { class: 'quadrants__label quadrants__label--br' }, 'Fix now')
      ]);
      wrap.appendChild(overlay);
    }
    cur.els.quadrants = overlay;
    if (overlay) overlay.hidden = false;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { positionQuadrantLabels(); setTimeout(positionQuadrantLabels, 250); });
    return handle;
  }

  /* ------------------------------------------------------------------ (c) driver analysis */

  function driverRows(c) {
    var rows = c.drivers && Array.isArray(c.drivers.rows) ? c.drivers.rows.filter(function (r) { return isNum(r.lift); }) : [];
    return rows.slice().sort(function (a, b) { return b.lift - a.lift; }).slice(0, 15);
  }
  function driverSpec(c) {
    var C = charts();
    var rows = driverRows(c);
    if (!C || !rows.length) return null;
    return {
      labels: rows.map(function (r) { return (r.significant ? '★ ' : '') + r.label + ' (n=' + fmtInt(r.n) + ')'; }),
      datasets: [{ label: 'Lift vs base rate', data: rows.map(function (r) { return r.lift; }), slot: 1 }],
      xLabel: 'negative-rate lift (1 = base rate)', yMin: 0,
      annotations: [{ x: 1, label: 'base rate' }],
      ariaLabel: 'Negative-rate lift by ' + state.dimension + ', ' + rows.length + ' values; ★ marks q below 0.05',
      onClick: function (index) {
        var r = rows[index]; if (!r) return;
        var f = {};
        if (state.dimension === 'subcategory') { var parts = String(r.value).split('/'); f.category = [parts[0]]; f.subcategory = [parts[1]]; }
        else f[state.dimension] = [r.value];
        f.sentiment = ['negative'];
        drill({ view: 'inbox', filters: f });
      }
    };
  }
  function driverTable(c) {
    var rows = c.drivers && Array.isArray(c.drivers.rows) ? c.drivers.rows : [];
    return {
      columns: [{ key: 'label', label: 'Value' }, { key: 'n', label: 'n' }, { key: 'negatives', label: 'Negatives' },
        { key: 'rate', label: 'Negative rate', format: function (v) { return fmtPct01(v); } }, { key: 'baseRate', label: 'Base rate', format: function (v) { return fmtPct01(v); } },
        { key: 'lift', label: 'Lift', format: function (v) { return isNum(v) ? fmtNum(v, 2) + '×' : '—'; } }, { key: 'excess', label: 'Excess negatives', format: function (v) { return isNum(v) ? signed(v, 1) : '—'; } },
        { key: 'q', label: 'q (BH)', format: function (v) { return isNum(v) ? fmtNum(v, 3) : '—'; } }, { key: 'significant', label: 'q < 0.05' }],
      rows: rows.map(function (r) { return { label: r.label, n: r.n, negatives: r.negatives, rate: r.rate, baseRate: r.baseRate, lift: r.lift, excess: r.excess, q: r.q, significant: r.significant ? '★ yes' : 'no' }; })
    };
  }
  function driverFoot(c) {
    var d = c.drivers;
    if (!d) return 'Driver analysis needs the predict module.';
    var base = isNum(d.baseRate) ? fmtPct01(d.baseRate) : '—';
    return (d.explanation || '') + ' Base negative rate ' + base + '; values with fewer than ' + ((d.params && d.params.minSupport) || MIN_N) + ' records are hidden; ★ = Yates χ² with Benjamini–Hochberg q < 0.05. Click a bar to open those negatives in the Inbox.';
  }

  /* ------------------------------------------------------------------ (d) what-changed waterfall */

  function waterfallSpec(c) {
    var C = charts(), w = c.changed;
    if (!C || !w || !Array.isArray(w.rows) || !w.rows.length || !w.total) return null;
    return {
      labels: w.rows.map(function (r) { return r.label || label('category', r.value); }),
      datasets: [{ label: 'Change in negative records', data: w.rows.map(function (r) { return r.delta; }) }],
      kinds: w.rows.map(function (r) { return r.value === '__other__' ? 'other' : 'delta'; }),
      totals: { start: { label: 'Prior period', value: w.total.prior }, end: { label: 'This period', value: w.total.now } },
      vertical: true, yLabel: 'negative records',
      ariaLabel: 'Waterfall of the change in negative records by category, from ' + w.total.prior + ' to ' + w.total.now
    };
  }
  function waterfallTable(c) {
    var w = c.changed, rows = w && Array.isArray(w.rows) ? w.rows : [];
    return {
      columns: [{ key: 'label', label: 'Category' }, { key: 'nPrior', label: 'n prior' }, { key: 'nNow', label: 'n now' },
        { key: 'ratePrior', label: 'Neg. rate prior', format: function (v) { return fmtPct01(v); } }, { key: 'rateNow', label: 'Neg. rate now', format: function (v) { return fmtPct01(v); } },
        { key: 'volumeEffect', label: 'Volume effect', format: function (v) { return isNum(v) ? signed(v, 1) : '—'; } }, { key: 'rateEffect', label: 'Rate effect', format: function (v) { return isNum(v) ? signed(v, 1) : '—'; } },
        { key: 'delta', label: 'Δ negatives', format: function (v) { return isNum(v) ? signed(v) : '—'; } }],
      rows: rows.map(function (r) { return { label: r.label, nPrior: r.nPrior, nNow: r.nNow, ratePrior: r.ratePrior, rateNow: r.rateNow, volumeEffect: r.volumeEffect, rateEffect: r.rateEffect, delta: r.delta }; })
    };
  }
  function whatChangedText(c) {
    if (!c.hasCompare) return 'Pick a comparison period in the filter bar (vs prior period or vs prior year) to decompose the change in negative records.';
    if (!c.changed) return 'The predict module is unavailable, so the change cannot be decomposed.';
    if (VOC.narrate && typeof VOC.narrate.whatChangedSentence === 'function') {
      try { return VOC.narrate.whatChangedSentence(c.changed); } catch (e) { /* fall back */ }
    }
    return c.changed.explanation || '';
  }

  /* ------------------------------------------------------------------ (e) distinctive terms */

  function termsSpec(c) {
    var C = charts(), t = c.terms;
    if (!C || !t) return null;
    var rising = (t.rising || []).slice(0, TERMS_TOP), falling = (t.falling || []).slice(0, TERMS_TOP);
    if (!rising.length && !falling.length) return null;
    var labels = rising.map(function (r) { return r.term; }).concat(falling.map(function (r) { return r.term; }));
    var data = rising.map(function (r) { return r.z; }).concat(falling.map(function (r) { return r.z; }));
    var ds = { label: c.termsMode === 'compare' ? 'z (this period vs prior)' : 'z (negative vs other mail)', data: data };
    // Sentiment mode: z > 0 marks terms characteristic of NEGATIVE mail, so those bars take the negative (red) pole.
    if (c.termsMode !== 'compare') { var p = C.palette(); ds.colors = data.map(function (z) { return isNum(z) && z > 0 ? p.neg : p.pos; }); }
    return {
      labels: labels, datasets: [ds],
      xLabel: 'weighted log-odds z', ariaLabel: 'Distinctive terms: ' + rising.length + ' rising and ' + falling.length + ' falling',
      onClick: function (index) { var term = labels[index]; if (term) drill({ view: 'inbox', filters: { search: term } }); }
    };
  }
  function termsTable(c) {
    var t = c.terms || { rising: [], falling: [] };
    var rows = [];
    (t.rising || []).slice(0, TERMS_TOP).forEach(function (r) { rows.push({ direction: c.termsMode === 'compare' ? 'Rising' : 'More in negative mail', term: r.term, z: r.z, a: r.a, b: r.b }); });
    (t.falling || []).slice(0, TERMS_TOP).forEach(function (r) { rows.push({ direction: c.termsMode === 'compare' ? 'Falling' : 'More in other mail', term: r.term, z: r.z, a: r.a, b: r.b }); });
    var aLabel = c.termsMode === 'compare' ? 'Count now' : 'Count in negative', bLabel = c.termsMode === 'compare' ? 'Count prior' : 'Count in other';
    return { columns: [{ key: 'direction', label: 'Direction' }, { key: 'term', label: 'Term' }, { key: 'z', label: 'z', format: function (v) { return isNum(v) ? fmtNum(v, 2) : '—'; } }, { key: 'a', label: aLabel }, { key: 'b', label: bLabel }], rows: rows };
  }
  function termsQuestion(c) {
    if (c.termsMode === 'compare') return 'Which words rose or fell versus the comparison period? (top ' + TERMS_TOP + ' each)';
    return 'No comparison period is set, so this contrasts negative mail against the rest of the range instead (top ' + TERMS_TOP + ' each).';
  }
  function termsFoot(c) {
    if (c.termsMode === 'compare') return 'Blue = rising versus the comparison period, red = falling. Click a term to search the Inbox for it.';
    return 'Red = more common in negative mail, blue = more common in the rest of the range. Click a term to search the Inbox for it.';
  }
  function termsN(c) {
    if (!c.terms) return c.records.length;
    return (isNum(c.terms.nA) ? c.terms.nA : 0) + (isNum(c.terms.nB) ? c.terms.nB : 0);
  }

  /* ------------------------------------------------------------------ (f) themes table (n-grams + KWIC) */

  function renderNgramTable() {
    var host = cur.els.ngramBody;
    if (!host || !cur.derived) return;
    var c = data(cur.derived);
    host.innerHTML = '';
    setCardN(cur.els.ngramCard, c.records.length);
    if (c.records.length < MIN_N || !c.ngrams.length) {
      ui().emptyState(host, { title: c.records.length < MIN_N ? 'Too few records for phrase mining (n = ' + fmtInt(c.records.length) + ')' : 'No recurring phrases in this range',
        text: 'Phrases need to appear in at least 3 records. Widen the range or clear a filter.' });
      return;
    }
    var wrap = h('div', { class: 'table-wrap themes-table-wrap' });
    var tbl = h('table', { class: 'table ngram-table' });
    tbl.appendChild(h('thead', {}, h('tr', {}, [
      h('th', { scope: 'col' }, 'Phrase'), h('th', { scope: 'col', class: 'num' }, 'Records'), h('th', { scope: 'col' }, 'Sentiment'),
      h('th', { scope: 'col', class: 'num' }, 'Neg. share'), h('th', { scope: 'col' }, 'Last ' + SPARK_WEEKS + ' weeks')
    ])));
    var tbody = h('tbody');
    c.ngrams.forEach(function (g) {
      var expanded = state.expandedGram === g.gram;
      var matching = recordsWithGram(c, g.gram);
      var spark = weeklyCounts(c, matching);
      var sparkHtml = charts() && typeof charts().sparklineSvg === 'function' ? charts().sparklineSvg(spark, { width: 96, height: 22, ariaLabel: 'Records per week: ' + spark.join(', ') }) : spark.join(' ');
      var tr = h('tr', { class: 'is-clickable ngram-row' + (expanded ? ' is-active' : ''), tabindex: '0', 'aria-expanded': String(expanded), 'data-gram': g.gram });
      var toggle = function () { state.expandedGram = expanded ? null : g.gram; renderNgramTable(); };
      tr.addEventListener('click', function (e) { if (e.target.closest('button, a')) return; toggle(); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      var sentPill = ui().pill('sentiment', sentimentLabelOf(g.meanSentiment));
      tr.appendChild(h('td', { class: 'wrap' }, [h('span', { class: 'ngram-caret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'), ' ', h('strong', {}, g.gram)]));
      tr.appendChild(h('td', { class: 'num' }, fmtInt(g.df)));
      tr.appendChild(h('td', {}, [sentPill, h('span', { class: 'muted t-12' }, isNum(g.meanSentiment) ? ' ' + fmtNum(g.meanSentiment, 2) : '')]));
      tr.appendChild(h('td', { class: 'num' }, fmtPct01(g.negShare)));
      tr.appendChild(h('td', { html: sparkHtml }));
      tbody.appendChild(tr);
      if (expanded) {
        var detail = h('td', { colspan: '5', class: 'wrap ngram-detail' });
        var snippets = kwicFor(c, g.gram, matching);
        if (!snippets.length) detail.appendChild(h('p', { class: 'muted t-13' }, 'No snippet could be cut for this phrase.'));
        else {
          var list = h('div', { class: 'kwic-list' });
          snippets.forEach(function (s) {
            var rec = recordById(c, s.id);
            var restricted = rec && rec.restricted && cur.derived.settings && cur.derived.settings.redactRestricted !== false;
            var b = h('button', { class: 'kwic', type: 'button', title: 'Open this record in the Inbox', onclick: function () { drill({ view: 'inbox', id: s.id }); } });
            if (restricted) b.innerHTML = '<span class="muted">[restricted — open the queue to view]</span>';
            else b.innerHTML = markWords(esc(s.before), g.gram) + '<mark>' + esc(s.match) + '</mark>' + markWords(esc(s.after), g.gram);
            list.appendChild(b);
          });
          detail.appendChild(list);
          detail.appendChild(h('p', { class: 'muted t-12' }, 'Showing ' + snippets.length + ' of ' + fmtInt(matching.length) + ' matching records · click a snippet to open it.'));
        }
        tbody.appendChild(h('tr', { class: 'ngram-detail-row' }, detail));
      }
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    host.appendChild(wrap);
  }
  /** Wrap the other words of the phrase in <mark> (input is already HTML-escaped). */
  function markWords(html, gram) {
    var words = String(gram || '').split(' ').filter(function (w) { return w.length >= 3; });
    if (!words.length) return html;
    var re = new RegExp('(^|[^a-z0-9])(' + words.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')(?![a-z0-9])', 'gi');
    return html.replace(re, function (m, pre, word) { return pre + '<mark>' + word + '</mark>'; });
  }
  function recordById(c, id) {
    for (var i = 0; i < c.records.length; i++) if (c.records[i].id === id) return c.records[i];
    return null;
  }
  function kwicFor(c, gram, matching) {
    var an = A();
    if (!an || typeof an.kwic !== 'function') return [];
    var out = [];
    var kwOpts = { width: 70, max: KWIC_MAX, includeRestricted: !!c.mineRestricted };
    try { out = an.kwic(matching, gram, kwOpts) || []; } catch (e) { out = []; }
    if (out.length < Math.min(KWIC_MAX, matching.length)) {
      var seen = {};
      out.forEach(function (s) { seen[s.id] = true; });
      var words = gram.split(' ');
      var rest = matching.filter(function (r) { return !seen[r.id]; });
      try { out = out.concat(an.kwic(rest, words[words.length - 1], { width: 70, max: KWIC_MAX - out.length, includeRestricted: !!c.mineRestricted }) || []); } catch (e) { /* keep what we have */ }
    }
    return out.slice(0, KWIC_MAX);
  }
  function ngramCsv() {
    var c = data(cur.derived);
    return {
      columns: [{ key: 'gram', label: 'Phrase' }, { key: 'df', label: 'Records' }, { key: 'meanSentiment', label: 'Mean sentiment' }, { key: 'negShare', label: 'Negative share' }, { key: 'weeks', label: 'Last ' + SPARK_WEEKS + ' weeks' }],
      rows: c.ngrams.map(function (g) { return { gram: g.gram, df: g.df, meanSentiment: isNum(g.meanSentiment) ? Math.round(g.meanSentiment * 100) / 100 : null, negShare: isNum(g.negShare) ? Math.round(g.negShare * 1000) / 1000 : null, weeks: weeklyCounts(c, recordsWithGram(c, g.gram)).join(' ') }; })
    };
  }

  /* ------------------------------------------------------------------ (g) topic × product matrix */

  function rampStep(ratio) {
    if (!isNum(ratio)) return 0;
    if (ratio <= 0) return 1;
    var r = Math.max(0.25, Math.min(4, ratio));
    return Math.max(1, Math.min(8, Math.round(1 + (Math.log2(r) + 2) / 4 * 7)));
  }
  function renderMatrixTable(host) {
    var c = data(cur.derived), m = c.matrix;
    host.className = 'html-chart themes-heat';
    var html = '<table class="heat-table"><caption class="sr-only">Messages by category and product with shading by observed ÷ expected</caption><thead><tr><th scope="col">Category</th>';
    m.colLabels.forEach(function (l) { html += '<th scope="col" class="num">' + esc(l) + '</th>'; });
    html += '<th scope="col" class="num">Total</th></tr></thead><tbody>';
    m.rows.forEach(function (row) {
      html += '<tr><th scope="row">' + esc(row.label) + '</th>';
      row.cells.forEach(function (v, j) {
        var exp = row.expected[j];
        var ratio = exp > 0 ? v / exp : null;
        var step = v > 0 ? rampStep(ratio) : 0;
        var small = exp < 5;
        var title = row.label + ' × ' + m.colLabels[j] + ': ' + fmtInt(v) + ' observed, ' + fmtNum(exp, 1) + ' expected' + (isNum(ratio) ? ' (×' + fmtNum(ratio, 2) + ')' : '') + (small ? ' · small expected count, read with care' : '');
        var cls = 'heat-table__cell' + (small ? ' heat-table__cell--small' : '') + (step && charts() && charts().rampCellClass ? ' ' + charts().rampCellClass(step) : '');
        var style = step ? 'background:var(--seq-' + step + ')' : '';
        html += '<td class="num ' + cls + '" style="' + style + '" title="' + esc(title) + '">' + (v ? fmtInt(v) : '<span class="muted">·</span>') + '</td>';
      });
      html += '<td class="num heat-table__total">' + fmtInt(row.total) + '</td></tr>';
    });
    html += '<tr class="heat-table__totals"><th scope="row">Total</th>';
    m.colTotals.forEach(function (t) { html += '<td class="num">' + fmtInt(t) + '</td>'; });
    html += '<td class="num">' + fmtInt(m.n) + '</td></tr></tbody></table>';
    host.innerHTML = html;
  }
  function matrixTable() {
    var m = data(cur.derived).matrix;
    var columns = [{ key: 'label', label: 'Category' }];
    m.cols.forEach(function (p, j) { columns.push({ key: 'c' + j, label: m.colLabels[j] }); });
    columns.push({ key: 'total', label: 'Total' });
    var rows = m.rows.map(function (row) { var o = { label: row.label, total: row.total }; row.cells.forEach(function (v, j) { o['c' + j] = v; }); return o; });
    return { columns: columns, rows: rows };
  }
  function renderHeatTable(canvas) {
    var c = data(cur.derived);
    if (!c.matrix.rows.length || !c.matrix.n) return null;
    return htmlHandle(canvas, renderMatrixTable, matrixTable);
  }

  /* ------------------------------------------------------------------ mount / update / unmount */

  function mount(root, derived) {
    cur.root = root;
    cur.derived = derived;
    cur.cards = {};
    cur.els = {};
    cur.cache = null;

    root.innerHTML = '';
    cur.els.header = buildHeader(derived);
    root.appendChild(cur.els.header);

    if (!derived || !ui() || typeof ui().chartCard !== 'function') {
      var body = h('div', { class: 'card' });
      root.appendChild(body);
      if (ui() && ui().emptyState) ui().emptyState(body, { title: 'Themes needs the data store and UI kit', text: 'The store or components module did not load, so there is nothing to analyze yet.' });
      else body.textContent = 'Themes needs the data store and UI kit to render.';
      return;
    }

    var c = data(derived);

    cur.els.empty = h('div', { class: 'card themes-empty', hidden: derived.n >= MIN_N });
    ui().emptyState(cur.els.empty, { title: 'Too few records for theme analysis (n = ' + fmtInt(derived.n) + ')', text: 'Theme charts need at least ' + MIN_N + ' records. Widen the date range or clear a filter; the category bars still show below.' });
    root.appendChild(cur.els.empty);

    /* Top row: category bars (+ subcategory panel) and the priority matrix */
    var top = h('div', { class: 'themes-top' });
    var left = h('div', { class: 'stack' });
    cur.cards.categories = ui().chartCard({
      id: 'themes-categories', title: 'Categories', question: 'What do customers write about, and how do they feel about each topic? Click a bar for subcategories.',
      formula: 'count(records) per primary category; bar color = mean lexicon sentiment on the diverging scale (red −1 … blue +1)', n: derived.n, height: 380,
      csvName: 'lnutra-voc-themes-categories.csv',
      render: function (canvas) { var spec = categorySpec(data(cur.derived)); return spec ? charts().bar(canvas, spec) : null; },
      table: function () { return categoryTable(data(cur.derived)); },
      footnote: 'Primary category only; secondary categories are not double-counted here. Bar color = mean sentiment: red negative, grey neutral (within ±0.15), blue positive — the same scale as the Briefing.'
    });
    left.appendChild(cur.cards.categories);
    cur.els.subPanel = h('div', { class: 'card sub-panel', hidden: true });
    left.appendChild(cur.els.subPanel);
    top.appendChild(left);

    cur.cards.matrix = ui().chartCard({
      id: 'themes-matrix', title: 'Priority matrix', question: 'Which topics are both loud and unhappy?',
      formula: 'x = messages per category; y = mean sentiment index (s+1)/2×100; bubble size = |NPS(all) − NPS(excluding category)|; quadrant lines at the median volume and index 50', n: derived.n, height: 380,
      csvName: 'lnutra-voc-themes-priority.csv',
      render: renderMatrix, table: function () { return bubbleTable(data(cur.derived)); },
      footnote: matrixFoot(c)
    });
    top.appendChild(cur.cards.matrix);
    root.appendChild(top);

    /* Middle row: drivers and what changed */
    var middle = h('div', { class: 'themes-middle' });
    var driversWrap = h('div', { class: 'stack' });
    var seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Driver dimension' });
    DIMENSIONS.forEach(function (d) {
      var b = h('button', { type: 'button', 'aria-pressed': String(state.dimension === d[0]), 'data-value': d[0] }, d[1]);
      b.addEventListener('click', function () {
        state.dimension = d[0];
        Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        cur.cache = null;
        var cc = data(cur.derived);
        setCardFoot(cur.cards.drivers, driverFoot(cc));
        setCardN(cur.cards.drivers, cc.drivers ? cc.drivers.n : 0);
        refreshCard(cur.cards.drivers);
      });
      seg.appendChild(b);
    });
    driversWrap.appendChild(h('div', { class: 'controls-row themes-controls' }, [h('span', { class: 'label' }, 'Drivers by'), seg]));
    cur.cards.drivers = ui().chartCard({
      id: 'themes-drivers', title: 'Driver analysis', question: 'Which values carry more negative mail than their volume explains?',
      formula: 'lift = negRate(value) ÷ negRate(all); excess = negatives − n × base rate; Yates χ² on the 2×2 table; Benjamini–Hochberg q; min support ' + MIN_N, n: c.drivers ? c.drivers.n : 0, height: 340,
      csvName: 'lnutra-voc-themes-drivers.csv',
      render: function (canvas) { var spec = driverSpec(data(cur.derived)); return spec ? charts().bar(canvas, spec) : null; },
      table: function () { return driverTable(data(cur.derived)); },
      footnote: driverFoot(c)
    });
    driversWrap.appendChild(cur.cards.drivers);
    middle.appendChild(driversWrap);

    var changedWrap = h('div', { class: 'stack' });
    cur.cards.changed = ui().chartCard({
      id: 'themes-changed', title: 'What changed', question: 'Where did the change in negative records come from, this period versus the comparison?',
      formula: 'Δ_v = (nNow_v − nPrior_v)·ratePrior_v + nNow_v·(rateNow_v − ratePrior_v); tail grouped as Other so bars sum to the total change', n: c.changed ? c.changed.n : derived.n, height: 340,
      csvName: 'lnutra-voc-themes-what-changed.csv',
      render: function (canvas) { var spec = waterfallSpec(data(cur.derived)); return spec ? charts().waterfall(canvas, spec) : null; },
      table: function () { return waterfallTable(data(cur.derived)); }
    });
    changedWrap.appendChild(cur.cards.changed);
    cur.els.changedText = h('p', { class: 'notice themes-sentence' }, whatChangedText(c));
    changedWrap.appendChild(cur.els.changedText);
    middle.appendChild(changedWrap);
    root.appendChild(middle);

    /* Terms row: distinctive terms and the n-gram table */
    var terms = h('div', { class: 'themes-terms' });
    cur.cards.terms = ui().chartCard({
      id: 'themes-terms', title: 'Distinctive terms', question: termsQuestion(c),
      formula: 'weighted log-odds with an informative Dirichlet prior (Monroe, Colaresi & Quinn 2008); z = δ ÷ √(1/(y_a+α) + 1/(y_b+α)); stems shown as their most common surface form', n: termsN(c), height: 420,
      csvName: 'lnutra-voc-themes-terms.csv',
      render: function (canvas) { var spec = termsSpec(data(cur.derived)); return spec ? charts().diverging(canvas, spec) : null; },
      table: function () { return termsTable(data(cur.derived)); },
      footnote: termsFoot(c)
    });
    terms.appendChild(cur.cards.terms);

    var ngramCard = h('section', { class: 'chart-card ngram-card', 'aria-labelledby': 'themes-ngrams-title' });
    var csvBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Download CSV', 'aria-label': 'Download CSV of themes table', onclick: function () {
      var d = ngramCsv();
      if (!d.rows.length) { ui().toast('No phrases to export for this range.', 'warning'); return; }
      ui().downloadText('lnutra-voc-themes-phrases.csv', ui().toCsv(d), 'text/csv;charset=utf-8');
    } }, [h('span', { html: ui().icons ? ui().icons.download : '', 'aria-hidden': 'true' }), 'CSV']);
    var fBtn = h('button', { class: 'btn btn--f', type: 'button', 'aria-label': 'Formula for themes table', title: 'Formula', onclick: function (e) {
      ui().popover(e.currentTarget, '<div class="popover__title">Themes table</div><code class="formula">' + esc('2–3 word phrases over stopword-filtered tokens within a sentence, counted once per record (df ≥ 3, top ' + NGRAM_TOP + '); bigrams absorbed into a trigram when df(tri) ≥ 0.8·df(bi); sparkline = records containing the phrase per ISO week') + '</code>');
    } }, 'ƒ');
    ngramCard.appendChild(h('header', { class: 'chart-card__header' }, [
      h('div', { class: 'chart-card__titles' }, [h('h3', { class: 'chart-card__title', id: 'themes-ngrams-title' }, 'Recurring phrases'), h('p', { class: 'chart-card__question' }, [ 'Which 2–3 word phrases recur, how do they feel, and are they growing? Click a row for snippets.', ' · ', h('span', { class: 'chart-card__n' }, 'n = ' + fmtInt(derived.n)) ])]),
      h('div', { class: 'chart-card__tools' }, [csvBtn, fBtn])
    ]));
    cur.els.ngramBody = h('div', { class: 'ngram-body' });
    ngramCard.appendChild(cur.els.ngramBody);
    cur.els.ngramCard = ngramCard;
    terms.appendChild(ngramCard);
    root.appendChild(terms);

    /* Matrix row */
    var matrixRow = h('div', { class: 'themes-matrix' });
    cur.cards.heat = ui().chartCard({
      id: 'themes-heat', title: 'Topic × product', question: 'Which topics cluster on which products, beyond what volume alone predicts?',
      formula: 'cell = count(category, product); expected = rowTotal × colTotal ÷ n; shade = observed ÷ expected on the green ramp (×0.25 … ×4); hatched when expected < 5', n: c.matrix.n, height: 420,
      csvName: 'lnutra-voc-themes-topic-product.csv',
      render: renderHeatTable, table: matrixTable,
      footnote: 'Columns are the eight fixed product slots plus Other. Hatched cells have an expected count below 5, so their ratio is unstable.'
    });
    matrixRow.appendChild(cur.cards.heat);
    root.appendChild(matrixRow);

    renderSubPanel();
    renderNgramTable();
    scheduleEmptyCopies();

    cur.onResize = function () { positionQuadrantLabels(); };
    window.addEventListener('resize', cur.onResize);
  }

  function matrixFoot(c) {
    var pts = matrixPoints(c);
    var withNps = c.npsN;
    return 'Bubble colors are fixed per category, never by rank: the first eight categories in the taxonomy carry the eight series colors and the rest are grey, so a filter never recolors a survivor. ' +
      'Bubble size uses NPS impact from ' + fmtInt(withNps) + ' records that carry an NPS' + (withNps < 30 ? ' — few, so sizes are rough' : '') + '. Bottom-right = high volume, low sentiment. Labels that would overlap stay hidden; hover a bubble for its name.';
  }

  function applyDerived(derived) {
    var c = data(derived);
    setHeader(derived, c);
    if (cur.els.empty) cur.els.empty.hidden = derived.n >= MIN_N;
    setCardN(cur.cards.categories, derived.n);
    setCardN(cur.cards.matrix, derived.n);
    setCardFoot(cur.cards.matrix, matrixFoot(c));
    setCardN(cur.cards.drivers, c.drivers ? c.drivers.n : 0);
    setCardFoot(cur.cards.drivers, driverFoot(c));
    setCardN(cur.cards.changed, c.changed ? c.changed.n : derived.n);
    if (cur.els.changedText) cur.els.changedText.textContent = whatChangedText(c);
    setCardQuestion(cur.cards.terms, termsQuestion(c), termsN(c));
    setCardFoot(cur.cards.terms, termsFoot(c));
    setCardN(cur.cards.heat, c.matrix.n);
    if (state.expandedCategory && !c.categories.some(function (r) { return r.id === state.expandedCategory; })) state.expandedCategory = null;
  }

  function update(derived) {
    if (!cur.root || !derived) return;
    if (!cur.cards || !Object.keys(cur.cards).length) { mount(cur.root, derived); return; }
    cur.derived = derived;
    cur.cache = null;
    applyDerived(derived);
    Object.keys(cur.cards).forEach(function (k) { refreshCard(cur.cards[k]); });
    renderSubPanel();
    renderNgramTable();
    fixEmptyCopies();
  }

  function unmount() {
    Object.keys(cur.cards || {}).forEach(function (k) { destroyCard(cur.cards[k]); });
    if (cur.onResize && typeof window !== 'undefined') window.removeEventListener('resize', cur.onResize);
    cur.onResize = null;
    cur.cards = {};
    cur.els = {};
    cur.cache = null;
    cur.root = null;
    cur.derived = null;
  }

  VOC.views[NAME] = { title: TITLE, icon: NAME, mount: mount, update: update, unmount: unmount };
})();
