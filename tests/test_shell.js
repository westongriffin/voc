/* Shell (A2) checks under jsc: router parsing/building, VOC.ui surface + formatValue, VOC.app surface, view stubs.
   Run with the shell files on the command line:
     jsc tests/_jsc_shim.js js/util.js js/router.js js/components.js js/views/*.js js/app.js tests/test_shell.js
   Under tests/run.sh (PURE modules only) the shell is absent, so this file prints SKIP lines and exits 0. */
var failures = 0;
function assert(cond, msg) { if (cond) { console.log('PASS ' + msg); } else { failures++; console.log('FAIL ' + msg); } }

if (typeof VOC === 'undefined' || !VOC.router) {
  console.log('SKIP test_shell: VOC.router not loaded (shell files are not part of the PURE list)');
} else {
  var R = VOC.router;

  /* parse */
  var p = R.parse('#/inbox/r_000123?range=30d&product=fast_bar');
  assert(p.name === 'inbox' && p.id === 'r_000123' && p.query === 'range=30d&product=fast_bar', 'router.parse splits name/id/query');
  var p2 = R.parse('');
  assert(p2.name === '' && p2.id === null && p2.query === '', 'router.parse handles an empty hash');
  var p3 = R.parse('#/briefing?x=1');
  assert(p3.name === 'briefing' && p3.id === null && p3.query === 'x=1', 'router.parse handles no id');
  var p4 = R.parse('#/inbox/a%20b');
  assert(p4.id === 'a b', 'router.parse decodes ids');

  /* build + query helpers */
  assert(R.build('inbox', { id: 'r_1', query: 'range=7d' }) === '#/inbox/r_1?range=7d', 'router.build with string query');
  assert(R.build('themes', { query: { range: '30d', product: ['a', 'b'], empty: [], nothing: null } }) === '#/themes?range=30d&product=a,b', 'router.build serializes object queries and drops empties');
  var q = R.parseQuery('range=30d&product=a,b&search=hello%20world');
  assert(q.range === '30d' && q.product === 'a,b' && q.search === 'hello world', 'router.parseQuery decodes values');
  assert(R.build(R.parse(R.build('inbox', { id: 'x', query: 'a=1' })).name, { id: 'x', query: 'a=1' }) === '#/inbox/x?a=1', 'router build/parse round trip');

  /* start / navigate / listeners (in-memory hash under jsc) */
  var fired = [];
  var off = R.on(function (route) { fired.push(route.name + '|' + (route.id || '') + '|' + route.query); });
  R.start({ briefing: {}, inbox: {}, themes: {} }, 'briefing');
  assert(fired.length === 1 && fired[0] === 'briefing||', 'router.start dispatches the default route once');
  R.navigate('inbox', { id: 'r_9', query: 'range=7d' });
  assert(fired.length === 2 && fired[1] === 'inbox|r_9|range=7d', 'router.navigate dispatches exactly once');
  R.navigate('inbox', { id: 'r_9', query: 'range=7d' });
  assert(fired.length === 2, 'router.navigate to the same route does not re-fire');
  R.navigate('inbox', { id: 'r_9', query: 'range=30d', replace: true });
  assert(fired.length === 2 && R.current().query === 'range=30d', 'router.navigate replace updates current() silently');
  R.navigate('nowhere');
  assert(fired.length === 3 && fired[2].indexOf('briefing|') === 0, 'unknown routes fall back to the default');
  off();
  R.navigate('themes');
  assert(fired.length === 3, 'router.on returns a working unsubscribe');
  assert(R.current().name === 'themes', 'router.current reflects the last navigation');

  /* VOC.ui surface */
  var UI = VOC.ui || {};
  ['kpiTile', 'chartCard', 'insightCard', 'pill', 'table', 'toast', 'popover', 'emptyState', 'confirm', 'dropZone', 'formatValue'].forEach(function (k) {
    assert(typeof UI[k] === 'function', 'VOC.ui.' + k + ' is a function');
  });
  assert(UI.drawer && typeof UI.drawer.open === 'function' && typeof UI.drawer.close === 'function' && typeof UI.drawer.isOpen === 'function', 'VOC.ui.drawer has open/close/isOpen');
  assert(UI.drawer.isOpen() === false, 'drawer starts closed');

  /* formatValue never yields NaN/undefined */
  assert(UI.formatValue('count', null) === '—', 'formatValue(null) → em dash');
  assert(UI.formatValue('count', NaN) === '—', 'formatValue(NaN) → em dash');
  assert(UI.formatValue('count', 1204) === '1,204', 'formatValue count uses thousands separators');
  /* 'pct' values are 0–100 percent points (registry contract, SPEC §4.6): 0.234 is a quarter of a point, not 23% */
  assert(UI.formatValue('pct', 0.234) === '0.2%', 'formatValue pct takes percent points (0.234 → 0.2%)');
  assert(UI.formatValue('pct', 23.4) === '23%', 'formatValue pct percent-points (23.4 → 23%)');
  assert(UI.formatValue('pct', 87.5) === '88%' || UI.formatValue('pct', 87.5) === '87%', 'formatValue pct rounds whole points ≥ 10');
  assert(/pts$/.test(UI.formatValue('pts', 61.2)), 'formatValue pts');
  assert(UI.formatValue('hours', 5.2) === '5.2h', 'formatValue hours');
  assert(UI.formatValue('hours', 0.5) === '30m', 'formatValue minutes under 1h');
  assert(UI.formatValue('per_1k', 3.456) === '3.5 /1k', 'formatValue per_1k');
  assert(UI.formatValue('per_10k', 12.3) === '12 /10k', 'formatValue per_10k');
  assert(UI.formatValue('usd', 12345).indexOf('$') === 0, 'formatValue usd');
  assert(UI.formatValue('score', -12) === '-12', 'formatValue negative score');
  assert(UI.formatValue('unknown_metric_id', 7) === '7', 'formatValue falls back to count for unknown ids');
  assert(UI.esc('<a href="x">&\'</a>') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', 'esc escapes HTML');
  assert(UI.toCsv({ columns: ['a', 'b'], rows: [['x,y', 'q"r'], [1, null]] }) === '﻿a,b\r\n"x,y","q""r"\r\n1,', 'toCsv is RFC 4180 with BOM');

  /* VOC.app surface */
  var A = VOC.app || {};
  ['boot', 'setTheme', 'renderFilterBar', 'currentView', 'rangeLabel'].forEach(function (k) {
    assert(typeof A[k] === 'function', 'VOC.app.' + k + ' is a function');
  });
  var rl = A.rangeLabel({ filters: { range: { preset: 'custom', from: '2026-08-18', to: '2026-09-16' } }, n: 412 });
  assert(/Aug 18/.test(rl) && /Sep 16, 2026/.test(rl) && /n = 412 records/.test(rl), 'rangeLabel formats range and n: ' + rl);
  assert(A.rangeLabel({ filters: { range: { preset: '30d' } }, n: 1 }) === 'Last 30 days · n = 1 record', 'rangeLabel preset + singular n');

  /* views */
  var names = ['briefing', 'trends', 'themes', 'products', 'customers', 'inbox', 'regulatory', 'predict', 'alerts', 'reports', 'methods', 'settings'];
  names.forEach(function (n) {
    var v = VOC.views && VOC.views[n];
    assert(!!v && typeof v.title === 'string' && v.title.length > 0 && typeof v.mount === 'function' && typeof v.update === 'function' && typeof v.unmount === 'function',
      'VOC.views.' + n + ' has title/mount/update/unmount');
  });
}

if (failures) { throw new Error(failures + ' shell assertion(s) failed'); }
console.log('test_shell: done');
