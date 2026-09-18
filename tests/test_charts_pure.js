/*
 * tests/test_charts_pure.js — pure helpers of VOC.charts under jsc (no Chart.js, fake DOM tokens).
 * Run: jsc tests/_jsc_shim.js js/util.js js/charts.js tests/test_charts_pure.js
 */
(function () {
  // tests/run.sh loads only the PURE modules; charts.js is not among them, so load it here when it is missing (jsc has load()).
  if (!(window.VOC && window.VOC.charts) && typeof load === 'function') {
    try { load('js/charts.js'); } catch (e1) { try { load('../js/charts.js'); } catch (e2) { /* reported by the first assertion */ } }
  }
  var failed = 0, passed = 0;
  function assert(cond, msg) {
    if (cond) { passed++; console.log('PASS ' + msg); }
    else { failed++; console.log('FAIL ' + msg); }
  }

  var TOKENS = {
    '--s1': '#56A511', '--s2': '#E87BA4', '--s3': '#2A78D6', '--s4': '#EB6834',
    '--s5': '#1BAF7A', '--s6': '#EDA100', '--s7': '#4A3AA7', '--s8': '#E34948',
    '--s-other': '#9AA39E',
    '--seq-1': '#EAF4DF', '--seq-2': '#CFE6B8', '--seq-3': '#B0D68F', '--seq-4': '#8FC466',
    '--seq-5': '#6DB13D', '--seq-6': '#56A511', '--seq-7': '#3F7F0D', '--seq-8': '#2C5A0B',
    '--div-neg': '#E34948', '--div-mid': '#ECE7E1', '--div-pos': '#2A78D6',
    '--good': '#0CA30C', '--warning': '#FAB219', '--serious': '#EC835A', '--critical': '#D03B3B',
    '--text': '#1C1D1D', '--text-2': '#3F4A46', '--muted': '#5F6A66', '--grid': '#ECE6E0', '--axis': '#C9C0B8',
    '--surface': '#FFFFFF', '--font-ui': "'Hanken Grotesk', system-ui"
  };

  // Fake DOM: charts.js reads tokens with getComputedStyle(document.documentElement) at call time.
  window.document = { documentElement: {} };
  window.getComputedStyle = function () {
    return { getPropertyValue: function (name) { return TOKENS[name] || ''; } };
  };

  var C = VOC.charts;
  assert(!!C, 'VOC.charts is attached');
  assert(C.available() === false, 'available() is false without window.Chart');

  // --- palette / slots -------------------------------------------------
  var p = C.palette();
  assert(p.series.length === 8 && p.series[0] === '#56A511' && p.series[7] === '#E34948', 'palette reads --s1..--s8 in order');
  assert(p.other === '#9AA39E', 'palette reads --s-other');
  assert(p.seq.length === 8 && p.seq[7] === '#2C5A0B', 'palette reads --seq-1..8');
  assert(p.pos === '#2A78D6' && p.neg === '#E34948' && p.mid === '#ECE7E1', 'palette reads diverging tokens');
  assert(p.status.critical === '#D03B3B' && p.status.good === '#0CA30C', 'palette reads status tokens');
  assert(p.font.indexOf('Hanken Grotesk') >= 0, 'palette reads --font-ui');
  assert(p.grid === '#ECE6E0' && p.axis === '#C9C0B8' && p.surface === '#FFFFFF', 'palette reads grid/axis/surface');
  assert(p.surface2 === '#F2EAE5', 'missing token (--surface-2) falls back to the light default');

  assert(C.SLOTS.prolon_5day === 1 && C.SLOTS.subscription_account === 8, 'SLOTS mapping matches spec');
  assert(C.slotColor('prolon_5day') === '#56A511', 'slotColor prolon_5day → s1');
  assert(C.slotColor('fast_bar') === '#EB6834', 'slotColor fast_bar → s4');
  assert(C.slotColor('l_pill') === '#4A3AA7', 'slotColor l_pill → s7');
  assert(C.slotColor('general') === '#9AA39E', 'slotColor unknown entity → other');
  assert(C.slotColor('starter_pack') === '#9AA39E', 'slotColor starter_pack → other');

  assert(C.statusColor('critical') === '#D03B3B', 'statusColor critical');
  assert(C.statusColor('warning') === '#FAB219', 'statusColor warning');
  assert(C.statusColor('nonsense') === '#5F6A66', 'statusColor unknown → muted');
  assert(C.sentimentColor('positive') === '#2A78D6', 'sentimentColor positive → div-pos');
  assert(C.sentimentColor('negative') === '#E34948', 'sentimentColor negative → div-neg');
  assert(C.sentimentColor('neutral') === '#5F6A66', 'sentimentColor neutral → muted');
  assert(/^#[0-9a-f]{6}$/i.test(C.sentimentColor(-1)) && C.sentimentColor(-1).toUpperCase() === '#E34948', 'sentimentColor(-1) is the neg end');
  assert(C.sentimentColor(1).toUpperCase() === '#2A78D6', 'sentimentColor(1) is the pos end');
  assert(C.sentimentColor(0).toUpperCase() === '#5F6A66', 'sentimentColor(0) is the muted neutral grey, not --div-mid');
  assert(C.sentimentColor(0.14).toUpperCase() === '#5F6A66' && C.sentimentColor(-0.149).toUpperCase() === '#5F6A66', 'sentimentColor: |v| < 0.15 stays in the neutral band');
  var midNeg = C.sentimentColor(-0.575), midPos = C.sentimentColor(0.575);
  assert(/^#[0-9a-f]{6}$/i.test(midNeg) && midNeg.toUpperCase() !== '#5F6A66' && midNeg.toUpperCase() !== '#E34948', 'sentimentColor(-0.575) blends between muted and the neg pole');
  assert(/^#[0-9a-f]{6}$/i.test(midPos) && midPos.toUpperCase() !== '#5F6A66' && midPos.toUpperCase() !== '#2A78D6', 'sentimentColor(0.575) blends between muted and the pos pole');
  assert(C.sentimentColor(-5).toUpperCase() === '#E34948' && C.sentimentColor(NaN) === '#5F6A66', 'sentimentColor clamps to the poles and treats NaN as muted');
  assert(C.divergingColor(0).toUpperCase() === '#ECE7E1', 'divergingColor(0) still returns --div-mid (unchanged scale)');
  assert(C.withAlpha('#56A511', 0.14) === 'rgba(86,165,17,0.14)', 'withAlpha converts hex to rgba');
  assert(C.withAlpha('rgba(124,194,66,.12)', 0.5) === 'rgba(124,194,66,0.5)', 'withAlpha handles rgba input');

  // cache invalidation
  TOKENS['--s1'] = '#000000';
  assert(C.palette().series[0] === '#56A511', 'palette is cached between calls');
  C.rethemeAll();
  assert(C.palette().series[0] === '#000000', 'rethemeAll re-reads tokens (no Chart.js present, no throw)');
  TOKENS['--s1'] = '#56A511';
  C.rethemeAll();
  C.destroyAll();

  // --- chart builders return null without Chart.js --------------------
  assert(C.line({}, { labels: ['a'], datasets: [{ data: [1] }], ariaLabel: 'x' }) === null, 'line() returns null when Chart.js is missing');
  assert(C.bar(null, { labels: [], datasets: [] }) === null, 'bar() returns null on empty spec');

  // --- buildConfig: dash, per-point radius/colors, band-only, range annotations ---
  assert(C.dashFor({ dashed: true }).join() === '6,4' && C.dashFor({}).join() === '' && C.dashFor({ dash: 'dotted' }).join() === '2,3', 'dashFor: boolean dashed → [6,4], none → [], dotted → [2,3]');
  assert(C.dashFor({ dash: 'dashed' }).join() === '6,4' && C.dashFor({ dash: [1, 5] }).join() === '1,5' && C.dashFor({ borderDash: [4, 2] }).join() === '4,2' && C.dashFor({ dash: 'solid', dashed: true }).join() === '', 'dashFor: dashed/number[]/borderDash/solid override');
  var cfg = C.buildConfig({
    labels: ['a', 'b', 'c', 'd', 'e'],
    datasets: [
      { label: 'Actual', data: [1, 2, 3, 4, 5], slot: 1 },
      { label: 'Fitted', data: [1, 2, 3, 4, 5], dash: 'dotted', pointRadius: [0, 0, 7, 0, 5], pointColors: [null, null, '#D03B3B', null, '#FAB219'] },
      { label: 'Forecast', data: [null, null, null, 4, 5], dashed: true, band: { lo: [null, null, null, 3, 3], hi: [null, null, null, 5, 7] } },
      { label: '95% band', band: { lo: [null, null, null, 2, 2], hi: [null, null, null, 6, 8] } },
      { label: 'null band', data: [null, null, null, null, null], band: { lo: [0, 0, 0, 0, 0], hi: [1, 1, 1, 1, 1] } }
    ],
    annotations: [{ from: 'b', to: 'd', label: 'fold 1' }, { x: 'c', label: 'as of' }, { y: 3, label: 'avg' }],
    ariaLabel: 'test'
  }, 'line');
  assert(cfg && cfg.type === 'line' && cfg.data.datasets.length === 1 + 1 + 3 + 2 + 2, 'buildConfig(line): band datasets added, band-only datasets contribute no line (9 datasets)');
  var byLabel = function (l) { return cfg.data.datasets.filter(function (d) { return d.label === l; })[0]; };
  assert(byLabel('Fitted').borderDash.join() === '2,3' && byLabel('Forecast').borderDash.join() === '6,4' && byLabel('Actual').borderDash.join() === '', 'buildConfig: dash "dotted" → [2,3], boolean dashed → [6,4], default solid');
  assert(byLabel('Fitted').pointRadius.join() === '0,0,7,0,5' && byLabel('Fitted').pointHoverRadius.join() === '0,0,9,0,7', 'buildConfig: per-point pointRadius array kept, hover radius +2 where drawn');
  assert(Array.isArray(byLabel('Fitted').pointBackgroundColor) && byLabel('Fitted').pointBackgroundColor[2] === '#D03B3B' && byLabel('Fitted').pointBackgroundColor[0] === byLabel('Fitted').borderColor, 'buildConfig: pointColors array applied, gaps fall back to the line color');
  assert(!byLabel('95% band') && !byLabel('null band'), 'buildConfig: band-only datasets (data omitted or all null) draw no line');
  var hidden = cfg.data.datasets.filter(function (d) { return d.vocHidden; });
  assert(hidden.length === 6 && hidden.every(function (d) { return d.pointRadius === 0; }) && hidden.filter(function (d) { return d.vocBandOnly; }).length === 4, 'buildConfig: 3 bands → 6 hidden datasets, 4 of them band-only');
  assert(byLabel('Actual').borderColor === '#56A511', 'buildConfig: slot 1 keeps s1 with band-only datasets present');
  var single = C.buildConfig({ labels: ['a'], datasets: [{ label: 'Only', data: [1] }, { label: 'band', band: { lo: [0], hi: [2] } }] }, 'line');
  assert(single.data.datasets.filter(function (d) { return !d.vocHidden; })[0].borderColor === '#56A511' && single.options.plugins.legend.display === false, 'buildConfig: a single drawn line + band-only dataset is still a single-series chart (s1, no legend)');
  var mk = cfg.options.plugins.vocMarkers;
  assert(mk && mk.items.length === 3 && mk.items[0].from === 'b' && mk.items[0].to === 'd' && /^rgba\(/.test(mk.fill), 'buildConfig: range annotation passes through to the marker plugin with a fill color');
  assert(C.buildConfig({ labels: [], datasets: [] }, 'nope') === null && C.buildConfig(null, 'bar').type === 'bar', 'buildConfig: unknown kind → null, null spec tolerated');

  // marker plugin with a fake chart: range boxes behind the data, lines/labels on top
  var calls = [];
  var fakeCtx = { save: function () { calls.push(['save']); }, restore: function () { calls.push(['restore']); }, beginPath: function () {}, stroke: function () { calls.push(['stroke']); },
    moveTo: function (x, y) { calls.push(['moveTo', x, y]); }, lineTo: function (x, y) { calls.push(['lineTo', x, y]); },
    fillRect: function (x, y, w, h) { calls.push(['fillRect', x, y, w, h]); }, fillText: function (t, x, y) { calls.push(['fillText', t, x, y]); }, setLineDash: function () {} };
  var fakeChart = { ctx: fakeCtx, chartArea: { left: 100, right: 300, top: 20, bottom: 220 },
    scales: { x: { getPixelForValue: function (i) { return 100 + i * 50; } }, y: { getPixelForValue: function (v) { return 220 - v * 40; } } }, data: { labels: ['a', 'b', 'c', 'd', 'e'] } };
  C.plugins.markers.beforeDatasetsDraw(fakeChart, {}, mk);
  var rects = calls.filter(function (c) { return c[0] === 'fillRect'; });
  assert(rects.length === 1 && rects[0][1] === 125 && rects[0][3] === 150 && rects[0][2] === 20 && rects[0][4] === 200, 'plugin: {from:b,to:d} shades one box from b−½step to d+½step over the full plot height (got ' + JSON.stringify(rects) + ')');
  assert(calls.some(function (c) { return c[0] === 'fillText' && c[1] === 'fold 1'; }), 'plugin: range label drawn');
  calls.length = 0;
  C.plugins.markers.afterDraw(fakeChart, {}, mk);
  assert(calls.filter(function (c) { return c[0] === 'fillRect'; }).length === 0, 'plugin: afterDraw draws no boxes');
  assert(calls.some(function (c) { return c[0] === 'moveTo' && c[1] === 200 && c[2] === 20; }) && calls.some(function (c) { return c[0] === 'moveTo' && c[1] === 100 && c[2] === 100; }), 'plugin: {x:c} vertical line at 200 and {y:3} horizontal line at 100');
  assert(calls.filter(function (c) { return c[0] === 'fillText'; }).length === 2, 'plugin: x and y labels drawn, range label not repeated');
  calls.length = 0;
  C.plugins.markers.beforeDatasetsDraw(fakeChart, {}, { items: [{ from: 'zzz', to: 'd' }], fill: 'rgba(0,0,0,.1)' });
  assert(calls.filter(function (c) { return c[0] === 'fillRect'; }).length === 0, 'plugin: unknown from label draws nothing');
  calls.length = 0;
  C.plugins.markers.beforeDatasetsDraw(fakeChart, {}, { items: [{ to: 'b' }], fill: 'rgba(0,0,0,.1)' });
  var open = calls.filter(function (c) { return c[0] === 'fillRect'; });
  assert(open.length === 1 && open[0][1] === 100 && open[0][3] === 75, 'plugin: open-ended {to} shades from the left edge');

  // --- toTable ---------------------------------------------------------
  var lineSpec = {
    labels: ['2026-W35', '2026-W36', '2026-W37'],
    datasets: [
      { label: 'Actual', data: [10, 12, null] },
      { label: 'Forecast', data: [null, 12, 14.456], dashed: true, band: { lo: [null, 12, 9], hi: [null, 12, 19] } }
    ],
    xLabel: 'Week'
  };
  var t = C.toTable(lineSpec, 'line');
  assert(t.columns.length === 5, 'line toTable: label + 2 series + band lo/hi = 5 columns');
  assert(t.columns[0].label === 'Week' && t.columns[0].key === 'label', 'line toTable: first column uses xLabel');
  assert(t.columns.map(function (c) { return c.label; }).join('|') === 'Week|Actual|Forecast|Forecast low|Forecast high', 'line toTable: column labels');
  assert(t.rows.length === 3, 'line toTable: one row per label');
  assert(t.rows[0].label === '2026-W35' && t.rows[0].s0 === 10 && t.rows[0].s1 === null, 'line toTable: nulls preserved, values copied');
  assert(t.rows[2].s1 === 14.46 && t.rows[2].s1_lo === 9 && t.rows[2].s1_hi === 19, 'line toTable: rounding to 2 dp and band columns');
  var hasNaN = t.rows.some(function (r) { return Object.keys(r).some(function (k) { return typeof r[k] === 'number' && isNaN(r[k]); }); });
  assert(!hasNaN, 'line toTable: no NaN in output');

  var s100 = C.toTable({ labels: ['Email', 'Survey'], datasets: [{ label: 'Positive', data: [3, 0] }, { label: 'Negative', data: [1, 0] }] }, 'stacked100');
  assert(s100.columns.length === 4 && s100.columns[3].key === 'n', 'stacked100 toTable: label + 2 share columns + n');
  assert(s100.rows[0].s0 === 75 && s100.rows[0].s1 === 25 && s100.rows[0].n === 4, 'stacked100 toTable: shares sum to 100 with n');
  assert(s100.rows[1].s0 === 0 && s100.rows[1].n === 0, 'stacked100 toTable: zero total row yields 0 shares, not NaN');

  var bub = C.toTable({ xLabel: 'Volume', yLabel: 'Sentiment', datasets: [{ label: 'Themes', data: [{ x: 40, y: -0.2, r: 12, label: 'Billing' }, { x: 5, y: 0.6, r: 2 }] }] }, 'bubble');
  assert(bub.columns.length === 4 && bub.columns[1].label === 'Volume', 'bubble toTable: label/x/y/r columns');
  assert(bub.rows.length === 2 && bub.rows[0].label === 'Billing' && bub.rows[1].label === 'Themes', 'bubble toTable: point label falls back to dataset label');

  var wf = C.toTable({ labels: ['Shipping', 'Billing', 'Other'], datasets: [{ data: [5, -2, 1] }], totals: { start: { label: 'Prior', value: 20 }, end: { label: 'Now' } } }, 'waterfall');
  assert(wf.rows.length === 5, 'waterfall toTable: start + 3 deltas + end');
  assert(wf.rows[0].total === 20 && wf.rows[1].change === 5 && wf.rows[1].total === 25 && wf.rows[2].total === 23, 'waterfall toTable: running totals');
  assert(wf.rows[4].label === 'Now' && wf.rows[4].total === 24 && wf.rows[4].change === null, 'waterfall toTable: end total computed from deltas');

  var bandOnlyTable = C.toTable({ labels: ['w1', 'w2'], datasets: [{ label: 'Actual', data: [3, 4] }, { label: '95% band', band: { lo: [1, 2], hi: [5, 6] } }] }, 'line');
  assert(bandOnlyTable.columns.map(function (c) { return c.label; }).join('|') === 'Label|Actual|95% band low|95% band high', 'line toTable: band-only dataset yields lo/hi columns without a placeholder value column');
  assert(bandOnlyTable.rows[1].s1 === undefined && bandOnlyTable.rows[1].s1_lo === 2 && bandOnlyTable.rows[1].s1_hi === 6, 'line toTable: band-only rows carry only lo/hi');
  assert(C.isBandOnly({ band: { lo: [1], hi: [2] } }) && C.isBandOnly({ data: [null], band: { lo: [1], hi: [2] } }) && !C.isBandOnly({ data: [1], band: { lo: [1], hi: [2] } }) && !C.isBandOnly({ data: [] }), 'isBandOnly: band without data or with all-null data; not with values or without a band');

  var empty = C.toTable({ labels: [], datasets: [] }, 'bar');
  assert(empty.columns.length === 1 && empty.rows.length === 0, 'toTable on empty spec: label column only, no rows');

  // --- sparkline SVG ---------------------------------------------------
  var svg = C.sparklineSvg([1, 3, 2, 5], { color: '#56A511' });
  assert(svg.indexOf('<svg') === 0 && /width="96" height="28"/.test(svg), 'sparkline: default 96×28 svg');
  assert(svg.indexOf('<polyline') > 0 && svg.indexOf('<polygon') > 0 && svg.indexOf('<circle') > 0, 'sparkline: polyline, area polygon and last-point circle');
  assert(/fill-opacity:\.15/.test(svg), 'sparkline: area fill uses low alpha');
  assert(/stroke:#56A511/.test(svg) && /aria-hidden="true"/.test(svg), 'sparkline: explicit color applied, decorative by default');
  var m = /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(svg);
  assert(m && Math.abs(+m[1] - 93) < 0.01 && Math.abs(+m[2] - 3) < 0.01, 'sparkline: last point sits at the right edge and top (max value)');
  var svgDefault = C.sparklineSvg([2, 2, 2], { width: 60, height: 20, ariaLabel: 'Flat trend, n = 3' });
  assert(/stroke:var\(--s1\)/.test(svgDefault) && /role="img" aria-label="Flat trend, n = 3"/.test(svgDefault), 'sparkline: defaults to var(--s1) and honors ariaLabel');
  assert(/cy="10"/.test(svgDefault), 'sparkline: flat series draws at mid height');
  var svgEmpty = C.sparklineSvg([]);
  assert(/voc-spark--empty/.test(svgEmpty) && svgEmpty.indexOf('<polyline') < 0 && /<\/svg>$/.test(svgEmpty), 'sparkline: empty values → empty svg, no NaN');
  var svgOne = C.sparklineSvg([NaN, 7]);
  assert(svgOne.indexOf('<polyline') < 0 && svgOne.indexOf('<circle') > 0 && svgOne.indexOf('NaN') < 0, 'sparkline: non-finite filtered, single value → dot only');

  // --- heatmap ramp ----------------------------------------------------
  assert(C.rampStep(0, 16) === 0, 'rampStep: zero → 0 (empty)');
  assert(C.rampStep(16, 16) === 8, 'rampStep: max → 8');
  assert(C.rampStep(1, 16) === 1, 'rampStep: smallest positive → 1');
  assert(C.rampStep(8, 16) === 4, 'rampStep: half of max → 4');
  assert(C.rampStep(9, 16) === 5, 'rampStep: just over half → 5');
  assert(C.rampStep(5, 5) === 8, 'rampStep: value equal to max → 8');
  assert(C.rampStep(3, 0) === 0 && C.rampStep(NaN, 10) === 0, 'rampStep: degenerate max or NaN → 0');
  assert(C.rampStep(40, 16) === 8, 'rampStep: clamps above max');

  // --- ramp text color: one AA-safe threshold per theme (light 4.5:1 flips at step 7, dark at step 6) -------------
  assert(C.rampTextColor(6, false) === 'var(--text)' && C.rampTextColor(7, false) === 'var(--surface)', 'rampTextColor light: dark text through step 6, white from step 7');
  assert(C.rampTextColor(5, true) === '#FFFFFF' && C.rampTextColor(6, true) === 'var(--bg)', 'rampTextColor dark: white through step 5, --bg from step 6');
  assert(C.rampTextColor(0, false) === 'var(--text)' && C.rampTextColor(NaN, true) === '#FFFFFF', 'rampTextColor: empty/NaN steps take the low-step color');
  assert(C.rampCellClass(0) === '' && C.rampCellClass(3) === 'ramp-step-3' && C.rampCellClass(11) === 'ramp-step-8', 'rampCellClass: empty → "", clamps to 8');
  var hmSteps = C.heatmapHtml([[16, 8]], { showValues: true });
  assert(hmSteps.indexOf('ramp-step-8') > 0 && hmSteps.indexOf('ramp-step-4') > 0 && hmSteps.indexOf('color:var(') < 0, 'heatmap cells carry .ramp-step-N and no inline text color');

  var matrix = [[0, 3], [14, 1]];
  var hm = C.heatmapHtml(matrix, { rowLabels: ['Mon', 'Tue'], colLabels: ['08:00', '09:00'] });
  assert(hm.indexOf('title="Tue 08:00 · 14 messages"') > 0, 'heatmap: tooltip "Tue 08:00 · 14 messages"');
  assert(hm.indexOf('title="Tue 09:00 · 1 message"') > 0, 'heatmap: singular tooltip');
  assert(hm.indexOf('var(--seq-8)') > 0 && hm.indexOf('var(--surface-2)') > 0, 'heatmap: max cell uses --seq-8, zero cell uses --surface-2');
  assert((hm.match(/voc-heatmap__cell/g) || []).length === 4, 'heatmap: one cell per matrix entry');
  assert(hm.indexOf('<button') < 0, 'heatmap: cells are divs without onClick');
  var hmClick = C.heatmapHtml(matrix, { rowLabels: ['Mon', 'Tue'], colLabels: ['08:00', '09:00'], onClick: function () {} });
  assert((hmClick.match(/<button type="button"/g) || []).length === 4, 'heatmap: cells are buttons with onClick');
  var hmFmt = C.heatmapHtml([[2]], { rowLabels: ['A'], colLabels: ['B'], format: function (v) { return v + ' items'; } });
  assert(hmFmt.indexOf('title="A B · 2 items"') > 0, 'heatmap: custom format');
  var fakeEl = { innerHTML: '' };
  C.heatmap(fakeEl, matrix, { rowLabels: ['Mon', 'Tue'], colLabels: ['08:00', '09:00'] });
  assert(fakeEl.innerHTML.indexOf('voc-heatmap') > 0, 'heatmap(el) renders into innerHTML without a real DOM');
  assert(C.heatmapHtml([], {}).indexOf('voc-heatmap') > 0, 'heatmap: empty matrix still renders a container');

  // --- table twin ------------------------------------------------------
  var tbl = C.tableHtml({ caption: 'Volume by week (n = 22)', columns: [{ key: 'label', label: 'Week' }, { key: 's0', label: 'Count' }], rows: [{ label: '2026-W36', s0: 1204 }, { label: '2026-W37', s0: null }] });
  assert(tbl.indexOf('<caption>Volume by week (n = 22)</caption>') > 0, 'tableTwin: caption rendered');
  assert((tbl.match(/<th scope="col"/g) || []).length === 2, 'tableTwin: header cells with scope');
  assert(tbl.indexOf('<td class="num">1,204</td>') > 0, 'tableTwin: numeric cells grouped and right-aligned');
  assert(tbl.indexOf('<td class="num">—</td>') > 0, 'tableTwin: null renders as em dash');
  var tblEmpty = C.tableHtml({ columns: [{ key: 'a', label: '<b>' }], rows: [] });
  assert(tblEmpty.indexOf('&lt;b&gt;') > 0 && tblEmpty.indexOf('No data (n = 0)') > 0, 'tableTwin: escapes labels and shows empty row');
  var twinEl = { innerHTML: '' };
  C.tableTwin(twinEl, { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x' }] });
  assert(twinEl.innerHTML.indexOf('<table class="voc-table-twin">') === 0, 'tableTwin(el) renders into innerHTML');

  // --- applyDefaults keeps Chart.defaults.animation's key set (Chart.js copies only those keys per animation group) ---
  window.Chart = { defaults: { font: {}, animation: { delay: undefined, duration: 1000, easing: 'easeOutQuart', fn: undefined, from: undefined, loop: undefined, to: undefined, type: undefined }, plugins: {} } };
  C.applyDefaults(C.palette());
  var animKeys = Object.keys(window.Chart.defaults.animation);
  assert(animKeys.indexOf('type') >= 0 && animKeys.indexOf('fn') >= 0 && animKeys.indexOf('easing') >= 0 && animKeys.indexOf('from') >= 0 && animKeys.indexOf('to') >= 0 && window.Chart.defaults.animation.duration === 150, 'applyDefaults keeps every animation option key (type/fn/easing/from/to) and shortens the duration');
  window.Chart.defaults.animation = false;
  C.applyDefaults(C.palette());
  assert(typeof window.Chart.defaults.animation === 'object' && Object.keys(window.Chart.defaults.animation).indexOf('type') >= 0, 'applyDefaults restores the animation option keys when defaults.animation was replaced');
  delete window.Chart;

  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) throw new Error(failed + ' chart tests failed');
})();
