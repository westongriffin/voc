/* tests/test_util.js — VOC.util: CT dates incl. DST, ISO week keys, business days across holidays,
 * Wilson/Poisson intervals, fnv64 stability, formatting, enums. Runs under jsc via tests/run.sh. */
(function () {
  'use strict';
  var failures = 0, total = 0;
  function assert(cond, msg) {
    total += 1;
    if (cond) console.log('PASS ' + msg);
    else { failures += 1; console.log('FAIL ' + msg); }
  }
  function near(a, b, tol) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol; }

  var u = VOC.util, en = VOC.enums;
  assert(u && en, 'VOC.util and VOC.enums load');

  /* Enums */
  assert(en.label('category', 'taste_quality') === 'Taste & Food Quality', 'label(category)');
  assert(en.label('product', 'prolon_nextgen') === 'ProLon Next Gen', 'label(product)');
  assert(en.label('subcategory', 'l_drink_taste') === 'L-Drink taste' && en.label('subcategory', 'hsa_fsa') === 'HSA / FSA', 'subcategory label overrides');
  assert(en.label('subcategory', 'unauthorized_signup') === 'Unauthorized signup', 'subcategory default label');
  assert(en.label('status', 'nope') === 'nope', 'label falls back to id');
  assert(en.list('category').length === 17 && en.list('category')[0].id === 'subscription_billing' && en.list('category')[16].id === 'other_noise', 'list(category) order and size');
  assert(en.list('product').length === 13, 'list(product) size');
  assert(en.subcategories('subscription_billing').length === 9 && en.subcategories('praise')[3].label === 'Next Gen taste', 'subcategories()');
  assert(en.categoryOf('hard_bits') === 'foreign_material_allergen', 'categoryOf');
  assert(en.productClass('l_pill') === 'supplement' && en.productClass('fast_bar') === 'conventional_food' && en.productClass('guided_health') === 'program' && en.productClass('general') === 'none', 'PRODUCT_CLASS');
  assert(en.SLA_FRT_HOURS.P0 === 1 && en.SLA_FRT_HOURS.P3 === 72, 'SLA_FRT_HOURS');
  assert(en.COMPLAINT_CATEGORIES.length === 10 && en.COMPLAINT_CATEGORIES.indexOf('praise') < 0, 'COMPLAINT_CATEGORIES');
  assert(Object.keys(en.KIT_COMPONENTS).length === 15 && en.KIT_COMPONENTS.nr1 === 'NR-1', 'KIT_COMPONENTS');

  /* Dates in CT incl. DST */
  var p = u.parts('2026-09-14T15:22:00Z');
  assert(p.y === 2026 && p.m === 9 && p.d === 14 && p.hour === 10 && p.minute === 22 && p.dow === 0, 'parts() CDT Monday 10:22');
  var pStd = u.parts('2026-03-08T07:30:00Z');
  var pDst = u.parts('2026-03-08T08:30:00Z');
  assert(pStd.hour === 1 && pDst.hour === 3 && pStd.dow === 6, 'DST spring-forward: 07:30Z→01:30 CST, 08:30Z→03:30 CDT');
  assert(u.parts('2026-11-01T06:30:00Z').hour === 1 && u.parts('2026-11-01T07:30:00Z').hour === 1, 'DST fall-back: two 01:30 hours');
  assert(u.parts('2026-01-15T05:59:00Z').hour === 23 && u.dayKey('2026-01-15T05:59:00Z') === '2026-01-14', 'CST midnight boundary → prior CT day');
  assert(u.dayKey('2026-09-17T04:59:59Z') === '2026-09-16' && u.dayKey('2026-09-17T05:00:00Z') === '2026-09-17', 'CDT midnight boundary');
  assert(u.parts('2026-09-14T00:00:00Z').hour === 19, 'hourCycle h23 (19, never 24)');
  assert(u.startOfDayCT('2026-03-08') === '2026-03-08T06:00:00.000Z' && u.startOfDayCT('2026-03-09') === '2026-03-09T05:00:00.000Z', 'startOfDayCT across spring DST');
  assert(u.startOfDayCT('2026-11-01') === '2026-11-01T05:00:00.000Z' && u.startOfDayCT('2026-11-02') === '2026-11-02T06:00:00.000Z', 'startOfDayCT across fall DST');
  assert(u.endOfDayCT('2026-09-16') === '2026-09-17T04:59:59.999Z', 'endOfDayCT');
  assert(u.monthKey('2026-09-01T03:00:00Z') === '2026-08', 'monthKey uses CT date');
  assert(u.isoDate(new Date('2026-09-14T15:22:00Z')) === '2026-09-14', 'isoDate(Date)');

  /* Week keys (ISO, Monday start) */
  assert(u.weekKey('2026-09-14T15:22:00Z') === '2026-W38' && u.weekKey('2026-09-16T23:59:00Z') === '2026-W38', 'weekKey mid-September 2026');
  assert(u.weekKey('2026-09-13T23:00:00Z') === '2026-W37', 'Sunday belongs to the prior ISO week');
  assert(u.weekKey('2025-12-31') === '2026-W01' && u.weekKey('2026-01-01') === '2026-W01', 'ISO year boundary: Dec 31 2025 is 2026-W01');
  assert(u.weekKey('2027-01-01') === '2026-W53' && u.weekKey('2027-01-04') === '2027-W01', '2026 has 53 ISO weeks');
  assert(u.weekStart('2026-W38') === '2026-09-14' && u.weekStart('2026-W01') === '2025-12-29' && u.weekStart('2027-W01') === '2027-01-04', 'weekStart');
  assert(u.weekKey(u.weekStart('2026-W53')) === '2026-W53', 'weekStart/weekKey round trip');

  /* Calendar arithmetic */
  assert(u.addDays('2026-02-28', 1) === '2026-03-01' && u.addDays('2026-01-01', -1) === '2025-12-31' && u.addDays('2024-02-28', 1) === '2024-02-29', 'addDays');
  assert(u.daysBetween('2026-08-18', '2026-09-16') === 29 && u.daysBetween('2026-09-16', '2026-08-18') === -29, 'daysBetween');
  assert(u.daysInMonth('2026-02') === 28 && u.daysInMonth('2028-02') === 29 && u.addMonths('2026-01', -1) === '2025-12' && u.addMonths('2026-12', 1) === '2027-01', 'daysInMonth/addMonths');

  /* Holidays and business days */
  assert(u.US_HOLIDAYS[2026].indexOf('2026-11-26') >= 0 && u.US_HOLIDAYS[2026].indexOf('2026-07-03') >= 0 && u.US_HOLIDAYS[2027].indexOf('2027-12-24') >= 0 && u.US_HOLIDAYS[2027].indexOf('2027-12-31') >= 0, 'observed holiday dates');
  assert(!u.isBusinessDay('2026-11-26') && !u.isBusinessDay('2026-09-12') && u.isBusinessDay('2026-09-14') && !u.isBusinessDay('2025-12-25'), 'isBusinessDay');
  assert(u.addBusinessDays('2026-11-20', 5) === '2026-11-30', '5 business days across Thanksgiving');
  assert(u.addBusinessDays('2026-12-23', 3) === '2026-12-29', '3 business days across Christmas');
  assert(u.addBusinessDays('2026-09-04T20:00:00Z', 15) === '2026-09-28T20:00:00.000Z', '15 business days across Labor Day keeps wall-clock time');
  assert(u.addBusinessDays('2026-11-30', -5) === '2026-11-20', 'negative business days');
  assert(u.businessDaysBetween('2026-11-20T12:00:00Z', '2026-11-30T12:00:00Z') === 5, 'businessDaysBetween across Thanksgiving');
  assert(near(u.businessDaysBetween('2026-09-16T23:59:00Z', '2026-09-25T20:00:00Z'), 6.834, 0.01), 'fractional business days');
  assert(u.businessDaysBetween('2026-09-25T20:00:00Z', '2026-09-16T23:59:00Z') < 0, 'businessDaysBetween sign');
  assert(u.businessDaysBetween('2026-09-12T12:00:00Z', '2026-09-13T12:00:00Z') === 0, 'weekend-only span is 0 business days');

  /* Stats */
  var w = u.stats.wilson(5, 10);
  assert(near(w.lo, 0.2366, 0.001) && near(w.hi, 0.7634, 0.001), 'wilson(5,10)');
  var w0 = u.stats.wilson(0, 10);
  assert(w0.lo === 0 && near(w0.hi, 0.2775, 0.001), 'wilson(0,10)');
  assert(u.stats.wilson(0, 0).lo === null, 'wilson n=0 → nulls');
  var pe = u.stats.poissonExact(10);
  assert(near(pe.lo, 4.795, 0.05) && near(pe.hi, 18.39, 0.05), 'poissonExact(10) ≈ Garwood');
  var pe0 = u.stats.poissonExact(0);
  assert(pe0.lo === 0 && near(pe0.hi, 3.69, 0.05), 'poissonExact(0)');
  assert(u.stats.mean([1, 2, 3, 4]) === 2.5 && u.stats.median([5, 1, 3]) === 3 && u.stats.median([1, 2, 3, 4]) === 2.5, 'mean/median');
  assert(near(u.stats.std([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.001), 'std (n-1)');
  assert(u.stats.percentile([1, 2, 3, 4, 5], 0.9) === 4.6 && u.stats.mean([]) === null && u.stats.std([1]) === null, 'percentile / empty inputs');
  assert(u.stats.sum([1, null, 2, NaN, 3]) === 6, 'sum ignores non-numbers');

  /* PRNG */
  var r1 = u.rng(42), r2 = u.rng(42);
  var a = r1(), b = r2();
  assert(a === b && a >= 0 && a < 1, 'mulberry32 deterministic in [0,1)');
  var rn = u.rng(7), acc = 0;
  for (var i = 0; i < 2000; i++) acc += u.randNormal(rn, 10, 2);
  assert(near(acc / 2000, 10, 0.3), 'randNormal mean');
  var rp = u.rng(9), pacc = 0;
  for (var j = 0; j < 2000; j++) pacc += u.poisson(rp, 4);
  assert(near(pacc / 2000, 4, 0.3), 'poisson mean');
  assert(u.weightedChoice(u.rng(3), ['a', 'b'], [1, 0]) === 'a' && u.weightedChoice(u.rng(3), [], []) === undefined, 'weightedChoice');

  /* Hashing and identity */
  assert(u.fnv64('') === 'cbf29ce484222325', 'fnv64 offset basis');
  assert(u.fnv64('a') === 'af63dc4c8601ec8c' && u.fnv64('foobar') === '85944171f73967e8', 'fnv64 known vectors');
  assert(u.fnv64('jane@x.com|2026-09-14T15:22:00Z|order late') === u.fnv64('jane@x.com|2026-09-14T15:22:00Z|order late') && u.fnv64('é').length === 16, 'fnv64 stable, 16 hex chars for UTF-8');
  assert(u.normalizeEmail('  Jane.Doe+promo@Gmail.com ') === 'janedoe@gmail.com' && u.normalizeEmail('Bob+x@Example.org') === 'bob@example.org' && u.normalizeEmail('') === null, 'normalizeEmail');
  var masked = u.maskPii('call 312-555-0199 or jane@x.com about #123456 and 113-1234567-1234567');
  assert(masked.indexOf('312') < 0 && masked.indexOf('jane@') < 0 && masked.indexOf('123456') < 0 && masked.indexOf('[order]') >= 0, 'maskPii');
  var red = u.redactRecord({ from_name: 'Jane', from_email: 'j@x.com', text: 'my a1c', subject: 'hi', order_id: '#123456', hcp_code: 'HCP-9', lot_number: 'NG-1', category: 'usage_guidance', product: 'l_pill' });
  assert(red.from_name === 'Redacted' && red.from_email === null && red.text.indexOf('restricted') >= 0 && red.subject === '[restricted]' && red.order_id === null && red.hcp_code === null && red.redacted === true, 'redactRecord blanks sender, subject, body, order id and HCP code');
  assert(red.lot_number === 'NG-1' && red.category === 'usage_guidance' && red.product === 'l_pill', 'redactRecord keeps lot, category and product');

  /* Text */
  var toks = u.tokenize("Day 3 headache, I'm SO hungry! it's a 'test'");
  assert(toks.join(',') === "day,headache,i'm,so,hungry,it's,test", 'tokenize');
  var sents = u.sentences('Great product. Lost 6 lbs! Would buy again? yes\nnew line');
  assert(sents.length === 5 && sents[1] === 'Lost 6 lbs!' && sents[3] === 'yes', 'sentences');
  assert(u.escapeHtml('<a href="x">&\'</a>') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', 'escapeHtml');
  assert(u.el('div') === null, 'el() guarded under jsc');

  /* Formatting */
  assert(u.fmt.int(1204.4) === '1,204' && u.fmt.num(0.2345, 2) === '0.23' && u.fmt.num(null) === '—', 'fmt.int/num');
  assert(u.fmt.pct(0.234) === '23%' && u.fmt.pct(0.2345, 1) === '23.5%' && u.fmt.pts(61.2) === '61 pts', 'fmt.pct/pts');
  assert(u.fmt.hours(0.5) === '30m' && u.fmt.hours(5.23) === '5.2h' && u.fmt.hours(51) === '2.1d', 'fmt.hours');
  var d1 = u.fmt.delta(118, 100), d2 = u.fmt.delta(61, 64, { unit: 'pts' }), d3 = u.fmt.delta(5, 0), d4 = u.fmt.delta(null, 3);
  assert(d1.text === '+18%' && d1.sign === 1 && d1.abs === 18, 'fmt.delta relative');
  assert(d2.text === '−3 pts' && d2.sign === -1, 'fmt.delta pts');
  assert(d3.rel === null && d3.text === '+5' && d4.text === '—' && d4.sign === 0, 'fmt.delta edge cases');
  assert(u.fmt.date('2026-09-14T15:22:00Z') === 'Sep 14, 2026' && u.fmt.date('2026-09-14T15:22:00Z', 'datetime') === 'Sep 14, 2026, 10:22 CT', 'fmt.date day/datetime');
  assert(u.fmt.date('2026-W38') === 'Week of Sep 14, 2026' && u.fmt.date('2026-09') === 'September 2026' && u.fmt.date('2026-09-14T15:22:00Z', 'month') === 'September 2026', 'fmt.date keys');
  assert(u.fmt.range('2026-08-18', '2026-09-16T23:59:00Z') === 'Aug 18 – Sep 16, 2026' && u.fmt.range('2025-09-15', '2026-09-16') === 'Sep 15, 2025 – Sep 16, 2026', 'fmt.range');
  assert(u.fmt.usd(1234.5) === '$1,235', 'fmt.usd');

  /* Misc */
  var g = u.groupBy([{ k: 'a' }, { k: 'b' }, { k: 'a' }], function (x) { return x.k; });
  assert(g.get('a').length === 2 && u.countBy([1, 1, 2], function (x) { return x; }).get(1) === 2, 'groupBy/countBy');
  var sorted = u.sortBy([{ v: 2 }, { v: null }, { v: 1 }], function (x) { return x.v; }, 'desc');
  assert(sorted[0].v === 2 && sorted[1].v === 1 && sorted[2].v === null, 'sortBy desc with nulls last');
  assert(u.clamp(5, 0, 3) === 3 && u.round(1.2345, 2) === 1.23 && u.round(NaN) === null, 'clamp/round');
  assert(u.uid('x') !== u.uid('x') && u.uid('x').indexOf('x_') === 0, 'uid');

  console.log(total - failures + '/' + total + ' util assertions passed');
  if (failures) throw new Error(failures + ' util assertion(s) failed');
})();
