/* L-Nutra · Voice of the Customer — Products view (SPEC §5 item 4)
   Segmented product switcher (local state; the global filter bar owns store filters), per-product tiles computed
   through the metrics registry with product-scoped orders, topic mix vs company, sentiment small multiples,
   kit-component bars, lot × week heat-table and top praise / complaint lists.
   Classic script; touches the DOM only inside mount/update/unmount. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'products';
  var TITLE = 'Products';
  var MIN_PRODUCT_RECORDS = 5;      // below this a product gets an empty state instead of tiles/charts
  var MIN_MULTIPLE_RECORDS = 15;    // a product needs this many records for its own sentiment line
  var LOT_ROWS_COLLAPSED = 12;
  var SNIPPET_LEN = 150;

  /* ------------------------------------------------------------------ helpers (module lookups at call time) */

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
  function fmtDate(iso, gran) { var u = util(); return u && u.fmt ? u.fmt.date(iso, gran) : String(iso); }
  function fmtValue(unit, v) { return ui() && ui().formatValue ? ui().formatValue(unit, v) : (isNum(v) ? fmtNum(v, 1) : '—'); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && isNum(derived.n) ? 'n = ' + fmtInt(derived.n) + ' records' : '';
  }
  /**
   * One bold sentence for the header: the product drawing the most feedback, its share of volume and sentiment index.
   * @param {Object|null} derived
   */
  function leadText(derived) {
    if (!derived || !isNum(derived.n)) return 'Data is loading.';
    var rows = (derived.byProduct || []).filter(function (r) { return r.count > 0; }).slice().sort(function (a, b) { return b.count - a.count; });
    if (!derived.n || !rows.length) return 'No product feedback matches the current filters (n=' + fmtInt(derived.n || 0) + ').';
    var top = rows[0];
    var name = top.label || label('product', top.id);
    var idx = isNum(top.meanSentiment) ? '; sentiment index ' + fmtNum((top.meanSentiment + 1) / 2 * 100) : '';
    return name + ' draws the most feedback: ' + fmtInt(top.count) + (top.count === 1 ? ' record' : ' records') + ', ' + fmtNum(top.share * 100) + '% of volume' + idx + ' (n=' + fmtInt(derived.n) + ').';
  }
  function buildHeader(derived) {
    if (ui() && typeof ui().viewHeader === 'function') return ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived) });
    return h('header', { class: 'view-header' }, [h('h1', { class: 'view-title', text: TITLE }), h('p', { class: 'view-meta', 'data-role': 'subtitle', text: subtitle(derived) })]);
  }
  function setHeader(derived) {
    var hd = state.header;
    if (!hd) return;
    if (hd.setMeta) hd.setMeta(subtitle(derived)); else { var sub = hd.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(derived); }
    if (hd.setLead) hd.setLead(leadText(derived));
  }
  function sentimentIndex(r) {
    if (isNum(r.sentiment_index)) return r.sentiment_index;
    return isNum(r.sentiment) ? (r.sentiment + 1) / 2 * 100 : null;
  }
  function scored(r) { return r.language !== 'other' && r.sentiment_label !== 'unscored' && isNum(r.sentiment); }
  function drill(target) {
    var s = store();
    if (s && typeof s.drill === 'function') { s.drill(target); return; }
    if (VOC.router && typeof VOC.router.navigate === 'function') VOC.router.navigate(target.view || 'inbox', { id: target.id });
  }
  function snippet(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > SNIPPET_LEN ? t.slice(0, SNIPPET_LEN - 1).replace(/\s+\S*$/, '') + '…' : t;
  }

  /* ------------------------------------------------------------------ view state */

  var state = { root: null, body: null, switcher: null, derived: null, product: 'all', cards: [], gen: 0, lotsExpanded: false };

  function destroyCards() {
    state.cards.forEach(function (c) { if (c && typeof c.vocDestroy === 'function') { try { c.vocDestroy(); } catch (e) { /* already gone */ } } });
    state.cards = [];
  }
  /** Wrap a chart render so a stale card (replaced before its rAF fired) draws nothing. */
  function guarded(gen, fn) {
    return function (canvas) { if (gen !== state.gen) return null; return fn(canvas); };
  }
  function card(opts) {
    var el = ui().chartCard(opts);
    state.cards.push(el);
    return el;
  }

  /* ------------------------------------------------------------------ record scoping and metric contexts */

  function productsInRange(derived) {
    var order = VOC.enums ? Object.keys(VOC.enums.PRODUCTS) : [];
    var counts = new Map();
    derived.records.forEach(function (r) { var p = r.product || 'general'; counts.set(p, (counts.get(p) || 0) + 1); });
    var ids = Array.from(counts.keys()).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    return ids.map(function (id) { return { id: id, count: counts.get(id) }; });
  }
  function scopeRecords(records, product) {
    if (product === 'all') return records;
    return records.filter(function (r) { return (r.product || 'general') === product; });
  }
  /**
   * Metric context for a record set. For a single product the per-order denominators come from that product's
   * orders (VOC.metrics.perOrders reads ctx.ordersInRange(from, to) without a product argument, so we bind it here).
   */
  function metricCtx(derived, range, product) {
    var s = store();
    var from = range ? range.from : null, to = range ? range.to : null;
    var orders = s && typeof s.orders === 'function' ? s.orders() : null;
    var ordersFn = null;
    if (s && typeof s.ordersInRange === 'function') {
      ordersFn = product === 'all'
        ? function (f, t, p) { return s.ordersInRange(f, t, p || null); }
        : function (f, t) { return s.ordersInRange(f, t, product); };
    }
    return {
      now: derived.now, from: from, to: to, orders: orders, ordersInRange: ordersFn,
      customers: s && typeof s.customers === 'function' ? s.customers() : null,
      allRecords: derived.allRecords || derived.records, sla: derived.settings && derived.settings.sla, product: product === 'all' ? null : product
    };
  }
  function compute(id, records, ctx) {
    var m = VOC.metrics;
    if (!m || typeof m.compute !== 'function') return { value: null, n: 0 };
    try { return m.compute(id, records, ctx) || { value: null, n: 0 }; } catch (e) { return { value: null, n: 0 }; }
  }
  function registryDef(id) { var m = VOC.metrics; return (m && m.registry && m.registry[id]) || { label: id, unit: 'count', formula: '' }; }

  /* ------------------------------------------------------------------ switcher */

  function renderSwitcher(derived) {
    var wrap = state.switcher;
    wrap.innerHTML = '';
    // A segmented control (role=group + aria-pressed) like the other switchers: there is no tabpanel to pair tabs with.
    var seg = h('div', { class: 'segmented segmented--lg product-switcher__seg', role: 'group', 'aria-label': 'Product' });
    var items = [{ id: 'all', count: derived.n, text: 'All products' }].concat(productsInRange(derived).map(function (p) { return { id: p.id, count: p.count, text: label('product', p.id) }; }));
    items.forEach(function (it) {
      var btn = h('button', {
        type: 'button', 'aria-pressed': String(it.id === state.product),
        dataset: { product: it.id }, title: it.text + ' · n = ' + fmtInt(it.count),
        onclick: function () { if (state.product === it.id) return; state.product = it.id; state.lotsExpanded = false; renderSwitcher(state.derived); renderBody(state.derived); }
      }, [it.text, h('span', { class: 'product-switcher__n', text: fmtInt(it.count) })]);
      if (it.id !== 'all' && charts()) btn.insertBefore(h('span', { class: 'product-switcher__dot', 'aria-hidden': 'true', style: { background: charts().slotColor(it.id) } }), btn.firstChild);
      seg.appendChild(btn);
    });
    wrap.appendChild(seg);
  }

  /* ------------------------------------------------------------------ tiles */

  function tileNote(tile, text) {
    if (!text) return tile;
    tile.appendChild(h('div', { class: 'kpi-tile__note', text: text }));
    return tile;
  }
  function renderTiles(derived, recs, prev, ctx, ctxPrev) {
    var strip = h('div', { class: 'kpi-strip products-tiles' });
    var product = state.product;
    var productLabel = product === 'all' ? 'all products' : label('product', product);

    function tile(id, extra) {
      var def = registryDef(id);
      var cur = compute(id, recs, ctx);
      var pv = prev && ctxPrev ? compute(id, prev, ctxPrev) : null;
      var opts = {
        id: id, label: def.label, unit: def.unit, direction: def.direction, formula: def.formula,
        value: cur.value, n: cur.n, prev: pv && isNum(pv.value) ? pv.value : undefined,
        interval: extra && extra.hideInterval ? null : cur.interval,
        onClick: extra && extra.onClick
      };
      var el = ui().kpiTile(opts);
      return { el: el, res: cur };
    }

    // volume
    var vol = tile('volume', { onClick: function () { drill({ view: 'inbox', filters: product === 'all' ? {} : { product: [product] } }); } });
    strip.appendChild(vol.el);

    // complaints per 1k orders (Wilson)
    var cp = tile('complaints_per_1k', { hideInterval: true });
    if (!isNum(cp.res.value)) tileNote(cp.el, 'Per-order rates unavailable: no orders for ' + productLabel + ' in this range.');
    else {
      var iv = cp.res.interval, ex = cp.res.extra || {};
      tileNote(cp.el, (isNum(ex.count) ? fmtInt(ex.count) + ' complaints' : '') + (iv ? ' · Wilson 95%: ' + fmtNum(iv.lo, 1) + '–' + fmtNum(iv.hi, 1) + ' per 1k orders' : ''));
    }
    strip.appendChild(cp.el);

    // net sentiment, NPS
    strip.appendChild(tile('net_sentiment').el);
    var nps = tile('nps');
    if (nps.res.n < 30 && isNum(nps.res.value)) tileNote(nps.el, 'Small n: read the interval, not the point.');
    strip.appendChild(nps.el);

    // adverse-event rate (Poisson)
    var ae = tile('ae_rate', { hideInterval: true });
    if (!isNum(ae.res.value)) {
      var k = ae.res.extra && isNum(ae.res.extra.count) ? ae.res.extra.count : recs.filter(function (r) { return r.is_adverse_event; }).length;
      tileNote(ae.el, k ? fmtInt(k) + ' AE ' + (k === 1 ? 'record' : 'records') + ' · per-order rates unavailable' : 'No adverse events · per-order rates unavailable');
    } else {
      var aiv = ae.res.interval, aex = ae.res.extra || {};
      tileNote(ae.el, 'n=' + fmtInt(aex.count || 0) + ' events' + (aiv ? ', ' + fmtNum(aiv.lo, 1) + '–' + fmtNum(aiv.hi, 1) + ' per 10k orders (Poisson 95%)' : ''));
    }
    strip.appendChild(ae.el);

    // share-of-voice index
    strip.appendChild(sovTile(derived, ctx));
    return strip;
  }

  function sovRows(derived, ctx) {
    var A = VOC.analytics;
    if (!A || typeof A.shareOfVoice !== 'function') return [];
    try { return A.shareOfVoice(derived.records, ctx.orders, ctx.from, ctx.to) || []; } catch (e) { return []; }
  }
  function sovTile(derived, ctx) {
    var rows = sovRows(derived, ctx);
    var product = state.product;
    var value = null, n = derived.n, note = '';
    if (product === 'all') {
      value = rows.length && rows.some(function (r) { return isNum(r.index); }) ? 1 : null;
      var top = rows.filter(function (r) { return isNum(r.index) && r.mentions >= MIN_PRODUCT_RECORDS; }).sort(function (a, b) { return b.index - a.index; })[0];
      note = value === null ? 'Per-order shares unavailable: no orders table for this range.'
        : 'All products index 1.00 by definition' + (top ? ' · highest: ' + label('product', top.product) + ' ' + fmtNum(top.index, 2) : '');
    } else {
      var row = rows.find(function (r) { return r.product === product; });
      value = row && isNum(row.index) ? row.index : null;
      n = row ? row.mentions : 0;
      note = row && isNum(row.index)
        ? fmtNum(row.mentionShare * 100, 1) + '% of mentions vs ' + fmtNum(row.orderShare * 100, 1) + '% of orders' + (row.index > 1.25 ? ' · over-indexed' : row.index < 0.8 ? ' · under-indexed' : '')
        : 'Per-order shares unavailable for ' + label('product', product) + ' in this range.';
    }
    var el = ui().kpiTile({
      id: 'sov_index', label: 'Share-of-voice index', unit: 'score', direction: 'neutral', value: value, n: n,
      formula: 'mention share ÷ order share (1.00 = mentions proportional to orders)'
    });
    // 'score' formatting rounds 1.66 → '1.7'; show two decimals for an index.
    var v = el.querySelector('.kpi-tile__value');
    if (v && isNum(value)) v.textContent = fmtNum(value, 2);
    return tileNote(el, note);
  }

  /* ------------------------------------------------------------------ topic mix (paired bars) */

  function categoryShares(records) {
    var order = VOC.enums ? Object.keys(VOC.enums.CATEGORIES) : [];
    var counts = new Map();
    records.forEach(function (r) { var c = r.category || 'other'; counts.set(c, (counts.get(c) || 0) + 1); });
    return { counts: counts, n: records.length, order: order };
  }
  function topicMixCard(derived, recs, prev, gen) {
    var product = state.product;
    var C = charts();
    var p = C ? C.palette() : null;
    var isAll = product === 'all';
    var a = categoryShares(recs);
    var bRecords = isAll ? (prev || []) : derived.records;
    var b = categoryShares(bRecords);
    var aName = isAll ? 'This period' : label('product', product);
    var bName = isAll ? 'Prior period' : 'All products';
    var cats = a.order.filter(function (c) { return c !== 'other_noise' && ((a.counts.get(c) || 0) > 0 || (b.counts.get(c) || 0) > 0); });
    // categories the enums do not list (imported data) still show
    a.counts.forEach(function (_, c) { if (cats.indexOf(c) < 0 && c !== 'other_noise') cats.push(c); });
    var rows = cats.map(function (c) {
      var ca = a.counts.get(c) || 0, cb = b.counts.get(c) || 0;
      var sa = a.n ? ca / a.n * 100 : null, sb = b.n ? cb / b.n * 100 : null;
      return { id: c, label: label('category', c), a: sa, b: sb, na: ca, nb: cb, index: isNum(sa) && isNum(sb) && sb > 0 ? sa / sb : null };
    }).sort(function (x, y) { return (y.a || 0) - (x.a || 0); });
    var hasB = b.n > 0;
    // Series colors come from the slots (SPEC §10): slot 1 for the company-wide series, the product's own slot otherwise; --s-other for the comparison.
    var datasets = [{ label: aName, data: rows.map(function (r) { return r.a; }), color: isAll ? (p && p.series ? p.series[0] : undefined) : (C ? C.slotColor(product) : undefined) }];
    if (hasB) datasets.push({ label: bName, data: rows.map(function (r) { return r.b; }), color: p ? p.other : undefined });
    var spec = {
      labels: rows.map(function (r) { return r.label; }), datasets: datasets, percent: true, xLabel: '% of records',
      ariaLabel: 'Topic mix: share of records per category for ' + aName + (hasB ? ' compared with ' + bName : ''),
      onClick: function (index) { var r = rows[index]; if (!r) return; drill({ view: 'inbox', filters: Object.assign({ category: [r.id] }, isAll ? {} : { product: [product] }) }); }
    };
    return card({
      id: 'products-topic-mix', title: 'Topic mix vs company', n: recs.length,
      question: isAll ? (hasB ? 'How does this period’s topic mix compare with the prior period?' : 'What do customers write about?') : 'Where does ' + aName + ' differ from the company mix?',
      formula: 'share = records in category ÷ records in scope × 100 · index = product share ÷ company share',
      footnote: isAll && !hasB ? 'Choose a comparison period in the filter bar to see a second series.' : 'Click a bar to open those records in the Inbox.',
      height: Math.max(260, 30 + rows.length * 26),
      render: guarded(gen, function (canvas) { return C && rows.length ? C.paired(canvas, spec) : null; }),
      table: function () {
        var cols = [{ key: 'label', label: 'Category' }, { key: 'a', label: aName + ' %' }, { key: 'na', label: aName + ' n' }];
        if (hasB) cols.push({ key: 'b', label: bName + ' %' }, { key: 'nb', label: bName + ' n' }, { key: 'index', label: 'Index' });
        return { columns: cols, rows: rows.map(function (r) { return { label: r.label, a: isNum(r.a) ? Math.round(r.a * 10) / 10 : null, na: r.na, b: isNum(r.b) ? Math.round(r.b * 10) / 10 : null, nb: r.nb, index: isNum(r.index) ? Math.round(r.index * 100) / 100 : null }; }) };
      },
      csvName: 'lnutra-voc-products-topic-mix.csv'
    });
  }

  /* ------------------------------------------------------------------ sentiment small multiples */

  function weeklyIndex(records, weekKeys) {
    var sums = {}, counts = {};
    records.forEach(function (r) {
      if (!scored(r) || !r.week_key) return;
      var v = sentimentIndex(r); if (!isNum(v)) return;
      sums[r.week_key] = (sums[r.week_key] || 0) + v; counts[r.week_key] = (counts[r.week_key] || 0) + 1;
    });
    return weekKeys.map(function (k) { return counts[k] ? sums[k] / counts[k] : null; });
  }
  function weekLabel(key) {
    var u = util();
    if (u && typeof u.weekStart === 'function') { var d = u.weekStart(key); return fmtDate(d, 'day').replace(/, \d{4}$/, ''); }
    return key;
  }
  function multiplesSection(derived, gen) {
    var C = charts();
    var weeks = (derived.byWeek || []).map(function (b) { return b.key; });
    var products = productsInRange(derived).filter(function (p) { return p.count >= MIN_MULTIPLE_RECORDS; });
    if (state.product !== 'all') products = products.filter(function (p) { return p.id === state.product; });
    var section = h('section', { class: 'view-section' });
    section.appendChild(h('h2', { class: 'section-title', text: 'Sentiment over time' + (state.product === 'all' ? ' · products with ≥ ' + MIN_MULTIPLE_RECORDS + ' records' : '') }));
    if (!products.length || weeks.length < 2) {
      var empty = h('div', { class: 'card' });
      ui().emptyState(empty, { title: 'Not enough records for a sentiment line', text: state.product === 'all' ? 'No product has ' + MIN_MULTIPLE_RECORDS + ' or more records in this range. Widen the range to see weekly sentiment per product.' : label('product', state.product) + ' has fewer than ' + MIN_MULTIPLE_RECORDS + ' records in this range (n = ' + fmtInt(scopeRecords(derived.records, state.product).length) + ').' });
      section.appendChild(empty);
      return section;
    }
    var grid = h('div', { class: 'products-multiples' });
    var labels = weeks.map(weekLabel);
    products.forEach(function (p) {
      var recs = scopeRecords(derived.records, p.id);
      var data = weeklyIndex(recs, weeks);
      var scoredN = recs.filter(scored).length;
      var slot = C && C.SLOTS && C.SLOTS[p.id] ? C.SLOTS[p.id] : 'other';
      var spec = {
        labels: labels, yMin: 0, yMax: 100, yLabel: 'Sentiment index',
        datasets: [{ label: label('product', p.id), data: data, slot: slot, pointRadius: weeks.length > 20 ? 0 : 2 }],
        annotations: [{ y: 50, label: 'neutral' }],
        ariaLabel: 'Weekly mean sentiment index for ' + label('product', p.id) + ', 0 to 100, n = ' + fmtInt(scoredN),
        onClick: function (index) { var k = weeks[index]; if (!k) return; drill({ view: 'inbox', filters: { product: [p.id], range: weekRange(k) } }); }
      };
      grid.appendChild(card({
        id: 'products-sentiment-' + p.id, title: label('product', p.id), n: scoredN, height: 170,
        question: 'Weekly mean sentiment index (0–100)', formula: 'mean((sentiment + 1) ÷ 2 × 100) per ISO week; weeks without scored records are gaps',
        render: guarded(gen, function (canvas) { return C ? C.line(canvas, spec) : null; }),
        table: function () { return { columns: [{ key: 'week', label: 'Week' }, { key: 'value', label: 'Sentiment index' }], rows: weeks.map(function (k, i) { return { week: k, value: isNum(data[i]) ? Math.round(data[i] * 10) / 10 : null }; }) }; },
        csvName: 'lnutra-voc-products-sentiment-' + p.id + '.csv'
      }));
    });
    section.appendChild(grid);
    return section;
  }
  function weekRange(weekKey) {
    var u = util();
    if (!u || typeof u.weekStart !== 'function') return undefined;
    var from = u.weekStart(weekKey);
    return { preset: 'custom', from: from, to: u.addDays(from, 6) };
  }

  /* ------------------------------------------------------------------ kit components */

  function componentCard(recs, gen) {
    var C = charts();
    var A = VOC.analytics;
    var rows = [];
    if (A && typeof A.componentMentions === 'function') { try { rows = A.componentMentions(recs) || []; } catch (e) { rows = []; } }
    var labels = rows.map(function (r) { return label('kit_component', r.component); });
    var colors = rows.map(function (r) { return C ? C.sentimentColor(isNum(r.meanSentiment) ? r.meanSentiment : null) : undefined; });
    var spec = {
      labels: labels, xLabel: 'Mentions',
      datasets: [{ label: 'Mentions', data: rows.map(function (r) { return r.count; }), colors: colors }],
      ariaLabel: 'Kit component mentions, bars colored by mean sentiment from negative (red) to positive (blue)',
      onClick: function (index) { var r = rows[index]; if (!r) return; drill({ view: 'inbox', filters: Object.assign({ search: label('kit_component', r.component) }, state.product === 'all' ? {} : { product: [state.product] }) }); }
    };
    var mentioned = rows.reduce(function (s, r) { return s + r.count; }, 0);
    return card({
      id: 'products-components', title: 'Kit components', n: mentioned,
      question: 'Which soups, bars and drinks do customers name, and how do they feel about them?',
      formula: 'count(records naming the component); color = mean sentiment compound on the diverging scale',
      footnote: rows.length ? 'Bar color: mean sentiment (red negative → blue positive). Click a bar to search those mentions in the Inbox.' : undefined,
      height: Math.max(220, 40 + rows.length * 26),
      render: guarded(gen, function (canvas) { return C && rows.length ? C.bar(canvas, spec) : null; }),
      table: function () {
        return { columns: [{ key: 'component', label: 'Component' }, { key: 'count', label: 'Mentions' }, { key: 'index', label: 'Sentiment index' }, { key: 'neg', label: 'Negative %' }],
          rows: rows.map(function (r) { return { component: label('kit_component', r.component), count: r.count, index: isNum(r.meanSentiment) ? Math.round((r.meanSentiment + 1) / 2 * 100) : null, neg: isNum(r.negShare) ? Math.round(r.negShare * 100) : null }; }) };
      },
      csvName: 'lnutra-voc-products-components.csv'
    });
  }

  /* ------------------------------------------------------------------ lot × week heat-table */

  function lotSection(derived, recs) {
    var A = VOC.analytics, C = charts();
    var lots = [];
    if (A && typeof A.lotMatrix === 'function') { try { lots = A.lotMatrix(recs) || []; } catch (e) { lots = []; } }
    var weeks = (derived.byWeek || []).map(function (b) { return b.key; });
    var usedWeeks = {};
    lots.forEach(function (l) { Object.keys(l.weeks || {}).forEach(function (k) { usedWeeks[k] = true; }); });
    if (!weeks.length) weeks = Object.keys(usedWeeks).sort();
    // keep the full calendar between the first and last week that carries a lot mention, so gaps stay visible
    var used = weeks.filter(function (k) { return usedWeeks[k]; });
    if (used.length) { var i0 = weeks.indexOf(used[0]), i1 = weeks.indexOf(used[used.length - 1]); weeks = weeks.slice(i0, i1 + 1); }
    var totalMentions = lots.reduce(function (s, l) { return s + l.total; }, 0);

    var section = h('section', { class: 'card lot-card' });
    var head = h('div', { class: 'card__header' }, [
      h('div', {}, [
        h('h2', { class: 'card__title', text: 'Lot × week' }),
        h('p', { class: 'card__subtitle', html: esc('Which lots keep coming up, and when? Food-safety lots first.') + ' · <span class="chart-card__n">n = ' + esc(fmtInt(totalMentions)) + '</span>' })
      ]),
      h('div', { class: 'chart-card__tools' })
    ]);
    var tools = head.querySelector('.chart-card__tools');
    if (lots.length && ui().toCsv && ui().downloadText) {
      tools.appendChild(h('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': 'Download CSV of lot table',
        onclick: function () {
          var cols = [{ key: 'lot', label: 'Lot' }, { key: 'products', label: 'Products' }, { key: 'foodSafety', label: 'Food safety' }].concat(weeks.map(function (k) { return { key: k, label: k }; }), [{ key: 'total', label: 'Total' }]);
          var rows = lots.map(function (l) { var o = { lot: l.lot, products: productNames(l), foodSafety: l.foodSafety ? 'yes' : 'no', total: l.total }; weeks.forEach(function (k) { o[k] = l.weeks[k] || 0; }); return o; });
          ui().downloadText('lnutra-voc-products-lots.csv', ui().toCsv({ columns: cols, rows: rows }), 'text/csv;charset=utf-8');
        }
      }, 'CSV'));
    }
    tools.appendChild(h('button', {
      class: 'btn btn--f', type: 'button', 'aria-label': 'Formula for lot table', title: 'Formula',
      onclick: function (e) { if (ui().popover) ui().popover(e.currentTarget, '<div class="popover__title">Lot × week</div><code class="formula">count(records with lot_number) per ISO week · shading = count ÷ max count in 8 steps · bold rows carry a food-safety flag</code>'); }
    }, 'ƒ'));
    section.appendChild(head);

    if (!lots.length) {
      var empty = h('div');
      ui().emptyState(empty, { title: 'No lot numbers in this range', text: 'Lot numbers appear when customers quote them (for example NG-0426-B) or when an import carries a lot field.', icon: 'check', kind: 'good' });
      section.appendChild(empty);
      return section;
    }

    var visible = state.lotsExpanded ? lots : lots.slice(0, LOT_ROWS_COLLAPSED);
    var max = 0;
    lots.forEach(function (l) { Object.keys(l.weeks).forEach(function (k) { if (l.weeks[k] > max) max = l.weeks[k]; }); });
    var scroll = h('div', { class: 'lot-scroll' });
    var table = h('table', { class: 'table lot-table', 'aria-label': 'Lot mentions by ISO week' });
    var thead = h('thead'); var trh = h('tr');
    trh.appendChild(h('th', { scope: 'col', class: 'lot-table__lot', text: 'Lot' }));
    trh.appendChild(h('th', { scope: 'col', text: 'Products' }));
    weeks.forEach(function (k) { trh.appendChild(h('th', { scope: 'col', class: 'lot-table__week num', title: fmtDate(k), text: k.replace(/^\d{4}-/, '') })); });
    trh.appendChild(h('th', { scope: 'col', class: 'num', text: 'Total' }));
    thead.appendChild(trh); table.appendChild(thead);
    var tbody = h('tbody');
    visible.forEach(function (l) {
      var tr = h('tr', { class: l.foodSafety ? 'is-food-safety' : null });
      var lotBtn = h('button', { class: 'btn btn--link lot-table__btn', type: 'button', title: 'Search the Inbox for lot ' + l.lot, onclick: function () { drill({ view: 'inbox', filters: { search: l.lot } }); } }, l.lot);
      var lotCell = h('th', { scope: 'row', class: 'lot-table__lot' }, [lotBtn]);
      if (l.foodSafety) lotCell.appendChild(h('span', { class: 'pill pill--severity-critical lot-table__badge', title: 'At least one record with this lot carries a food-safety flag' }, 'Food safety'));
      tr.appendChild(lotCell);
      tr.appendChild(h('td', { class: 'lot-table__products', text: productNames(l) }));
      weeks.forEach(function (k) {
        var v = l.weeks[k] || 0;
        var step = C && typeof C.rampStep === 'function' ? C.rampStep(v, max) : (v ? Math.min(8, Math.ceil(v / max * 8)) : 0);
        var td = h('td', { class: 'num lot-table__cell' + (step && C && typeof C.rampCellClass === 'function' ? ' ' + C.rampCellClass(step) : ''), title: l.lot + ' · ' + fmtDate(k) + ' · ' + fmtInt(v) + (v === 1 ? ' record' : ' records'), text: v ? fmtInt(v) : '' });
        if (step) td.style.background = 'var(--seq-' + step + ')';
        tr.appendChild(td);
      });
      tr.appendChild(h('td', { class: 'num strong', text: fmtInt(l.total) }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    section.appendChild(scroll);
    var foot = h('div', { class: 'card__footer lot-card__foot' });
    foot.appendChild(h('span', { class: 'muted t-12', text: fmtInt(lots.length) + (lots.length === 1 ? ' lot' : ' lots') + ' · ' + fmtInt(lots.filter(function (l) { return l.foodSafety; }).length) + ' with a food-safety flag · click a lot to search the Inbox' }));
    if (lots.length > LOT_ROWS_COLLAPSED) {
      foot.appendChild(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: function () { state.lotsExpanded = !state.lotsExpanded; renderBody(state.derived); } },
        state.lotsExpanded ? 'Show top ' + LOT_ROWS_COLLAPSED : 'Show all ' + fmtInt(lots.length) + ' lots'));
    }
    section.appendChild(foot);
    return section;
  }
  function productNames(lot) {
    var ps = Object.keys(lot.products || {}).sort(function (a, b) { return lot.products[b] - lot.products[a]; });
    return ps.map(function (p) { return label('product', p); }).join(', ') || '—';
  }

  /* ------------------------------------------------------------------ top praise / complaints */

  function confident(r) {
    var c = r.classifier && isNum(r.classifier.confidence) ? r.classifier.confidence : 1;
    return c >= 0.6 && !r.restricted && r.language === 'en' && r.sentiment_label !== 'unscored' && !r.is_noise;
  }
  function topList(recs, kind) {
    var want = kind === 'praise' ? 'positive' : 'negative';
    var pool = recs.filter(function (r) { return confident(r) && r.sentiment_label === want; });
    pool.sort(function (a, b) {
      var d = kind === 'praise' ? (b.sentiment - a.sentiment) : (a.sentiment - b.sentiment);
      return d !== 0 ? d : (a.received_at < b.received_at ? 1 : -1);
    });
    return { items: pool.slice(0, 5), n: pool.length };
  }
  function listCard(recs, kind) {
    var res = topList(recs, kind);
    var isPraise = kind === 'praise';
    var el = h('section', { class: 'card top-list' });
    el.appendChild(h('div', { class: 'card__header' }, [h('div', {}, [
      h('h2', { class: 'card__title', text: isPraise ? 'Top praise' : 'Top complaints' }),
      h('p', { class: 'card__subtitle', html: esc(isPraise ? 'Most positive confident, non-restricted records' : 'Most negative confident, non-restricted records') + ' · <span class="chart-card__n">n = ' + esc(fmtInt(res.n)) + '</span>' })
    ])]));
    if (!res.items.length) {
      var empty = h('div');
      ui().emptyState(empty, { title: isPraise ? 'No confident praise in this range' : 'No confident complaints in this range', text: 'Restricted records and low-confidence classifications are left out of these lists.', icon: isPraise ? 'inbox' : 'check', kind: isPraise ? undefined : 'good' });
      el.appendChild(empty);
      return el;
    }
    var list = h('ol', { class: 'top-list__items' });
    res.items.forEach(function (r) {
      var li = h('li');
      var btn = h('button', {
        class: 'verbatim verbatim--' + (isPraise ? 'positive' : 'negative') + ' top-list__item', type: 'button', title: 'Open this record',
        onclick: function () { drill({ view: 'inbox', id: r.id, filters: {} }); }
      }, [
        h('div', { class: 'top-list__subject', text: r.subject || '(no subject)' }),
        h('div', { class: 'top-list__snippet', text: snippet(r.text) }),
        h('div', { class: 'verbatim__meta' }, [
          h('span', { text: fmtDate(r.received_at) }),
          h('span', { text: label('product', r.product) }),
          h('span', { text: label('category', r.category) }),
          isNum(r.nps) ? h('span', { text: 'NPS ' + r.nps }) : null,
          h('span', { class: 'top-list__score', text: 'sentiment ' + (r.sentiment > 0 ? '+' : '') + fmtNum(r.sentiment, 2) })
        ])
      ]);
      li.appendChild(btn);
      list.appendChild(li);
    });
    el.appendChild(list);
    return el;
  }

  /* ------------------------------------------------------------------ body */

  function renderBody(derived) {
    destroyCards();
    state.gen += 1;
    var gen = state.gen;
    var body = state.body;
    body.innerHTML = '';
    if (!derived || !derived.records) {
      ui().emptyState(body, { title: 'Data is still loading', text: 'The store has not published records yet.' });
      return;
    }
    var product = state.product;
    var recs = scopeRecords(derived.records, product);
    var prev = derived.compare && derived.compare.length ? scopeRecords(derived.compare, product) : null;
    var ctx = metricCtx(derived, derived.filters && derived.filters.range, product);
    var ctxPrev = prev && derived.compareRange ? metricCtx(derived, derived.compareRange, product) : null;

    if (!derived.n) {
      var none = h('div', { class: 'card' });
      ui().emptyState(none, { title: 'No records in this range', text: 'Widen the date range or clear a filter to see product analytics.' });
      body.appendChild(none);
      return;
    }
    if (product !== 'all' && recs.length < MIN_PRODUCT_RECORDS) {
      var few = h('div', { class: 'card' });
      ui().emptyState(few, {
        title: label('product', product) + ' has ' + (recs.length ? 'only ' + fmtInt(recs.length) + (recs.length === 1 ? ' record' : ' records') : 'no records') + ' in this range',
        text: 'Rates and charts need at least ' + MIN_PRODUCT_RECORDS + ' records to say anything reliable. Widen the range, or open the records directly.',
        action: recs.length ? { label: 'Open in Inbox', onClick: function () { drill({ view: 'inbox', filters: { product: [product] } }); } } : { label: 'Show all products', onClick: function () { state.product = 'all'; renderSwitcher(state.derived); renderBody(state.derived); } }
      });
      body.appendChild(few);
      return;
    }

    body.appendChild(renderTiles(derived, recs, prev, ctx, ctxPrev));

    var chartsGrid = h('div', { class: 'products-charts' });
    chartsGrid.appendChild(topicMixCard(derived, recs, prev, gen));
    chartsGrid.appendChild(componentCard(recs, gen));
    body.appendChild(chartsGrid);

    body.appendChild(multiplesSection(derived, gen));

    var lotWrap = h('section', { class: 'view-section' });
    lotWrap.appendChild(lotSection(derived, recs));
    body.appendChild(lotWrap);

    var lists = h('div', { class: 'products-lists' });
    lists.appendChild(listCard(recs, 'praise'));
    lists.appendChild(listCard(recs, 'complaints'));
    body.appendChild(lists);
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
      state.lotsExpanded = false;
      root.innerHTML = '';
      state.header = buildHeader(derived);
      root.appendChild(state.header);
      state.switcher = h('div', { class: 'product-switcher', 'data-role': 'switcher' });
      root.appendChild(state.switcher);
      state.body = h('div', { class: 'products-body', 'data-role': 'body' });
      root.appendChild(state.body);
      if (!ui()) { root.textContent = 'UI kit unavailable.'; return; }
      if (derived && derived.records) renderSwitcher(derived);
      renderBody(derived);
    },
    /** @param {Object|null} derived */
    update: function (derived) {
      if (!state.root || !state.body) return;
      state.derived = derived;
      setHeader(derived);
      if (!derived || !derived.records) { renderBody(derived); return; }
      // a product that vanished from the range falls back to All (the switcher only lists products with records)
      if (state.product !== 'all' && !derived.records.some(function (r) { return (r.product || 'general') === state.product; })) state.product = 'all';
      renderSwitcher(derived);
      renderBody(derived);
    },
    unmount: function () {
      destroyCards();
      state.gen += 1;
      state.root = null; state.body = null; state.switcher = null; state.header = null; state.derived = null;
    }
  };
})();
