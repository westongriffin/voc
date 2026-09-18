/* L-Nutra · Voice of the Customer — hash router (SPEC §4.12)
   Hash form: #/inbox/r_000123?range=30d&product=fast_bar
   Works without a DOM (jsc): falls back to an in-memory hash and dispatches synchronously. */
(function () {
  'use strict';
  window.VOC = window.VOC || {};

  var listeners = [];
  var routes = {};
  var defaultRoute = 'briefing';
  var started = false;
  var current = null;
  var memHash = '';

  function hasLocation() {
    return typeof window !== 'undefined' && window.location && typeof window.location.hash === 'string' &&
      typeof window.addEventListener === 'function';
  }

  function readHash() {
    return hasLocation() ? window.location.hash : memHash;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /**
   * Parse a hash string into its route parts.
   * @param {string} hash  e.g. '#/inbox/r_1?range=30d'
   * @returns {{name:string, id:(string|null), query:string}}
   */
  function parse(hash) {
    var h = String(hash == null ? '' : hash);
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.charAt(0) === '/') h = h.slice(1);
    var qi = h.indexOf('?');
    var query = qi >= 0 ? h.slice(qi + 1) : '';
    var path = qi >= 0 ? h.slice(0, qi) : h;
    var segs = path.split('/').filter(Boolean).map(safeDecode);
    return { name: segs[0] || '', id: segs[1] || null, query: query };
  }

  /**
   * Serialize a plain object into a query string. Arrays join with commas; empty values are dropped.
   * @param {Object} obj
   * @returns {string}
   */
  function serializeQuery(obj) {
    if (!obj || typeof obj !== 'object') return '';
    return Object.keys(obj).map(function (k) {
      var v = obj[k];
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return null;
      var s = Array.isArray(v) ? v.map(function (x) { return encodeURIComponent(String(x)); }).join(',') : encodeURIComponent(String(v));
      return encodeURIComponent(k) + '=' + s;
    }).filter(Boolean).join('&');
  }

  /**
   * Parse a query string into a plain object (values stay strings; repeated keys keep the last).
   * @param {string} str
   * @returns {Object}
   */
  function parseQuery(str) {
    var out = {};
    String(str || '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = safeDecode(i >= 0 ? pair.slice(0, i) : pair);
      var v = i >= 0 ? safeDecode(pair.slice(i + 1)) : '';
      if (k) out[k] = v;
    });
    return out;
  }

  /**
   * Build a hash string from route parts.
   * @param {string} name
   * @param {{id?:string, query?:(string|Object)}} [opts]
   * @returns {string} e.g. '#/inbox/r_1?range=30d'
   */
  function build(name, opts) {
    opts = opts || {};
    var h = '#/' + encodeURIComponent(String(name || defaultRoute));
    if (opts.id) h += '/' + encodeURIComponent(String(opts.id));
    var q = opts.query;
    if (q && typeof q === 'object') q = serializeQuery(q);
    if (q) h += '?' + q;
    return h;
  }

  function resolve(parsed) {
    var known = Object.keys(routes).length > 0;
    if (!parsed.name || (started && known && !routes[parsed.name])) {
      return { name: defaultRoute, id: null, query: parsed.query, redirected: true };
    }
    return parsed;
  }

  function sameRoute(a, b) {
    return a.name === b.name && (a.id || null) === (b.id || null) && (a.query || '') === (b.query || '');
  }

  function dispatch() {
    var p = resolve(parse(readHash()));
    if (p.redirected && hasLocation()) {
      var target = build(p.name, { query: p.query });
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', target);
      }
    }
    current = { name: p.name, id: p.id, query: p.query };
    listeners.slice().forEach(function (fn) { fn(current); });
  }

  function onHashChange() { dispatch(); }

  /**
   * Start routing. Registers the hashchange listener, normalizes an empty/unknown hash to the default
   * route, and dispatches once.
   * @param {Object.<string, Object>} r  view registry (route name → View)
   * @param {string} [def='briefing']
   */
  function start(r, def) {
    routes = r || {};
    defaultRoute = def || 'briefing';
    if (!started && hasLocation()) window.addEventListener('hashchange', onHashChange);
    started = true;
    dispatch();
  }

  /**
   * Navigate to a route. Updates the hash and lets the hashchange event dispatch, so listeners fire once.
   * With `replace: true`, the hash is rewritten in place with no history entry and no dispatch (used for
   * filter ↔ hash sync). With `force: true` on an unchanged hash, listeners are re-dispatched.
   * @param {string} name
   * @param {{id?:string, query?:(string|Object), replace?:boolean, force?:boolean}} [opts]
   */
  function navigate(name, opts) {
    opts = opts || {};
    var target = build(name, opts);
    var next = parse(target);
    var cur = parse(readHash());
    if (sameRoute(next, cur)) {
      if (opts.force) dispatch();
      return;
    }
    if (opts.replace) {
      if (hasLocation() && window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', target);
      } else {
        memHash = target;
      }
      current = { name: next.name, id: next.id, query: next.query };
      return;
    }
    if (hasLocation()) {
      window.location.hash = target;
    } else {
      memHash = target;
      dispatch();
    }
  }

  /**
   * @returns {{name:string, id:(string|null), query:string}|null} the current route (null before start()).
   */
  function getCurrent() {
    if (current) return current;
    var p = parse(readHash());
    return p.name ? p : null;
  }

  /**
   * Subscribe to route changes.
   * @param {function({name:string,id:string|null,query:string})} fn
   * @returns {function} unsubscribe
   */
  function on(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return function () { off(fn); };
  }

  function off(fn) {
    listeners = listeners.filter(function (f) { return f !== fn; });
  }

  VOC.router = {
    start: start,
    navigate: navigate,
    current: getCurrent,
    on: on,
    off: off,
    parse: parse,
    build: build,
    parseQuery: parseQuery,
    serializeQuery: serializeQuery,
    defaultRoute: function () { return defaultRoute; }
  };
})();
