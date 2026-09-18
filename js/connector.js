/**
 * VOC.connector — client for the Python sidecar (server/voc_server.py) and
 * the file:// fallback via js/live-data.js (SPEC §4.11, §9).
 *
 * Browser module. It loads without a DOM (jsc) but every function that
 * touches location/fetch/document is guarded.
 *
 * Public surface:
 *   mode() → 'file'|'static'|'served'  'file' on file://; 'static' on http(s) until /api/health has answered {ok:true}
 *                                      at least once; 'served' after that (cached for the page's lifetime)
 *   isServed() → boolean               true once health() has succeeded (same cache as mode())
 *   baseUrl() → string                 location.origin on http(s), '' on file://
 *   setToken(t), token()               X-VoC-Token, kept in localStorage['voc.api.token'] (guarded)
 *   health(), status(), fetchRecords(sinceIso, limit), getConfig(), saveConfig(cfg), triggerSync(), ingest(raw), saveReport(filename, html)
 *   startPolling(intervalS), stopPolling(), isPolling(), lastPoll(), pollOnce()
 *   autoStart(intervalS) → boolean     starts /api/records polling when mode() is 'served' and a token is set; a no-op otherwise.
 *                                      The connector calls it itself on every healthy 'status', on setToken() and after saveConfig(),
 *                                      so served mode keeps pulling records without any call from app.js. Stops on a failed health check.
 *   pollInterval(override) → seconds   the interval autoStart uses: override → /api/health poll_interval_s → store settings → 120, clamped 60–900
 *   loadLive() → RawEmail[]            window.VOC_LIVE || []
 *   reloadLiveScript() → Promise<RawEmail[]>   re-inserts <script src="js/live-data.js?ts=…">, rejects after 5 s
 *   on(evt, fn), off(evt, fn)          events: 'poll' ({at, fetched, added, pages, has_more, error, summary}), 'status' (health result)
 *
 * Pagination: pollOnce() follows the server's has_more/next_since through up to MAX_PAGES pages of PAGE_SIZE records per
 * poll, so a first sync of a large mailbox lands in one go instead of 500 records per manual Sync.
 */
window.VOC = window.VOC || {};
VOC.connector = (function () {
  'use strict';

  var TOKEN_KEY = 'voc.api.token';
  var SINCE_KEY = 'voc.api.since';
  var REQUEST_TIMEOUT_MS = 8000;
  var LIVE_TIMEOUT_MS = 5000;
  var LIVE_SRC = 'js/live-data.js';
  var PAGE_SIZE = 500;           // records per /api/records page
  var MAX_PAGES = 10;            // pages followed per poll (has_more); the next poll continues from next_since
  var DEFAULT_POLL_S = 120;

  var memToken = null;
  var memSince = null;
  var servedOk = false;          // set once /api/health answers {ok:true}; mode() reports 'served' from then on
  var lastHealth = null;         // most recent health() result ({ok:false, ...} on failure)
  var pollTimer = null;
  var pollBusy = false;
  var lastPollInfo = { at: null, fetched: 0, added: 0, pages: 0, has_more: false, error: null, summary: null };
  var listeners = {};

  /* ------------------------------------------------------------- basics */

  function storage() {
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* blocked */ }
    return null;
  }

  function lsGet(key) { var ls = storage(); if (!ls) return null; try { return ls.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) {
    var ls = storage(); if (!ls) return false;
    try { if (val === null || val === undefined || val === '') ls.removeItem(key); else ls.setItem(key, String(val)); return true; } catch (e) { return false; }
  }

  /** True when the page came over http(s) (the sidecar or any plain web server). */
  function isHttp() {
    if (typeof location === 'undefined' || !location || !location.protocol) return false;
    return /^https?:$/.test(location.protocol);
  }

  /**
   * 'file' on file://, 'static' on http(s) until a health check has succeeded, 'served' once /api/health has
   * answered {ok:true} at least once (SPEC §4.11: served = http(s) AND the sidecar answers). A plain static server
   * (python3 -m http.server) therefore stays 'static' and views keep their file-mode behavior.
   * @returns {'file'|'static'|'served'}
   */
  function mode() {
    if (!isHttp()) return 'file';
    return servedOk ? 'served' : 'static';
  }

  /** True once health() has succeeded in this page (cached). */
  function isServed() { return isHttp() && servedOk; }

  /** Most recent health() result, or null before the first check. */
  function lastStatus() { return lastHealth; }

  /** Origin of the API on http(s), '' in file mode. */
  function baseUrl() {
    return isHttp() && typeof location !== 'undefined' && location.origin ? location.origin : '';
  }

  /** Store the API token (empty/null clears it). A new token starts served-mode polling; clearing it stops polling. */
  function setToken(t) {
    memToken = t ? String(t).trim() : null;
    lsSet(TOKEN_KEY, memToken);
    if (memToken) autoStart(); else stopPolling();
    return memToken;
  }

  /** Current API token or null. */
  function token() {
    if (memToken) return memToken;
    var stored = lsGet(TOKEN_KEY);
    memToken = stored ? String(stored).trim() : null;
    return memToken;
  }

  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function off(evt, fn) { listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; }); }
  function emit(evt, payload) { (listeners[evt] || []).slice().forEach(function (fn) { try { fn(payload); } catch (e) { /* listener error must not break polling */ } }); }

  /* ------------------------------------------------------------ requests */

  function request(method, path, body, opts) {
    opts = opts || {};
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch is not available in this runtime'));
    if (mode() === 'file') return Promise.reject(new Error('The API needs the site served by voc_server.py (file:// mode has no API)'));
    var headers = { 'Accept': 'application/json' };
    if (!opts.noToken) {
      var t = token();
      if (!t) return Promise.reject(Object.assign(new Error('No API token set. Paste the TOKEN printed by voc_server.py into Settings.'), { status: 401 }));
      headers['X-VoC-Token'] = t;
    }
    var init = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined && body !== null) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) init.signal = controller.signal;
    var timer = controller ? setTimeout(function () { controller.abort(); }, opts.timeoutMs || REQUEST_TIMEOUT_MS) : null;
    return fetch(baseUrl() + path, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (txt) {
        var data = null;
        if (txt) { try { data = JSON.parse(txt); } catch (e) { data = { raw: txt }; } }
        if (!res.ok) {
          var msg = (data && (data.error || data.message)) || ('HTTP ' + res.status + (res.status === 401 || res.status === 403 ? ' — check the API token' : ''));
          throw Object.assign(new Error(msg), { status: res.status, data: data });
        }
        return data;
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw Object.assign(new Error('The sidecar did not answer within ' + Math.round((opts.timeoutMs || REQUEST_TIMEOUT_MS) / 1000) + ' s'), { status: 0 });
      throw Object.assign(new Error('Could not reach the sidecar (' + (err && err.message ? err.message : 'network error') + ')'), { status: 0 });
    });
  }

  /**
   * GET /api/health (no token). Resolves {ok:true, version, mode, last_sync_at, uptime_s, records, poll_interval_s} from the
   * sidecar, and never rejects: a static server (404), a network failure or file:// resolve {ok:false, status, error}.
   * The first {ok:true} flips mode() to 'served'. Emits 'status' with the result either way.
   * A healthy answer also calls autoStart() (records polling begins once a token exists); a failed answer after the
   * sidecar had been seen stops polling until the next healthy one.
   * @returns {Promise<Object>}
   */
  function health() {
    var p;
    if (mode() === 'file') p = Promise.resolve({ ok: false, status: 0, error: 'file:// mode has no API' });
    else {
      p = request('GET', '/api/health', null, { noToken: true, timeoutMs: 4000 }).then(function (h) {
        if (!h || typeof h !== 'object') h = { ok: false, status: 200, error: 'Unexpected /api/health payload' };
        if (h.ok) servedOk = true;
        return h;
      }).catch(function (err) {
        return { ok: false, status: err && typeof err.status === 'number' ? err.status : 0, error: err && err.message ? err.message : String(err) };
      });
    }
    return p.then(function (h) {
      lastHealth = h;
      if (h.ok) autoStart(); else if (servedOk) stopPolling();
      emit('status', h);
      return h;
    });
  }

  /** GET /api/status (token). */
  function status() { return request('GET', '/api/status'); }

  /**
   * GET /api/records?since=ISO&limit=n
   * @param {string|null} sinceIso  ISO timestamp or the `<iso>|<id>` cursor from a previous page's next_since
   * @param {number} [limit=500]
   * @returns {Promise<{records: Object[], next_since: string|null, total: number, has_more: boolean, server_time: string}>}
   */
  function fetchRecords(sinceIso, limit) {
    var q = [];
    if (sinceIso) q.push('since=' + encodeURIComponent(sinceIso));
    q.push('limit=' + encodeURIComponent(String(limit || PAGE_SIZE)));
    return request('GET', '/api/records?' + q.join('&')).then(function (data) {
      data = data || {};
      return {
        records: Array.isArray(data.records) ? data.records : [],
        next_since: data.next_since || null,
        total: typeof data.total === 'number' ? data.total : null,
        has_more: data.has_more === true,
        server_time: data.server_time || null
      };
    });
  }

  /** GET /api/config (token). */
  function getConfig() { return request('GET', '/api/config'); }

  /**
   * POST /api/config (token). The page never sends a mailbox password. On success the browser poll timer is
   * (re)started with the saved poll_interval_s, so "Save config" also turns records polling on.
   */
  function saveConfig(cfg) {
    var clean = Object.assign({}, cfg || {});
    ['password', 'secret', 'mail_secret', 'app_password'].forEach(function (k) { delete clean[k]; });
    return request('POST', '/api/config', clean).then(function (res) {
      var saved = res && res.config ? res.config : clean;
      autoStart(saved && saved.poll_interval_s ? Number(saved.poll_interval_s) : undefined, true);
      return res;
    });
  }

  /** POST /api/sync (token) → {ok, fetched, duration_ms}. */
  function triggerSync() { return request('POST', '/api/sync', {}, { timeoutMs: 60000 }); }

  /** POST /api/ingest (token) with one RawEmail-like object → {ok, id, duplicate}. */
  function ingest(raw) { return request('POST', '/api/ingest', raw || {}); }

  /** POST /api/report (token) → {ok, path}. */
  function saveReport(filename, html) { return request('POST', '/api/report', { filename: filename, html: html }); }

  /* ------------------------------------------------------------- polling */

  function since() {
    if (memSince) return memSince;
    memSince = lsGet(SINCE_KEY) || null;
    return memSince;
  }

  function setSince(iso) { memSince = iso || null; lsSet(SINCE_KEY, memSince); }

  /** Sum the numeric fields of two store.addRecords summaries ({added, duplicates, noise, …}). */
  function mergeSummary(acc, res) {
    if (!res || typeof res !== 'object') return acc;
    var out = acc || {};
    Object.keys(res).forEach(function (k) { if (typeof res[k] === 'number') out[k] = (typeof out[k] === 'number' ? out[k] : 0) + res[k]; });
    return out;
  }

  /**
   * One poll: fetch /api/records from the saved cursor, hand each page to VOC.store.addRecords(records, 'imap'),
   * advance the cursor after every page and follow has_more for up to MAX_PAGES pages. Emits 'poll' once with the
   * totals ({at, fetched, added, pages, has_more, error, summary}); a failure mid-way keeps the pages already added.
   * @returns {Promise<Object>} the 'poll' payload
   */
  function pollOnce() {
    if (pollBusy) return Promise.resolve(lastPollInfo);
    pollBusy = true;
    var startedAt = new Date().toISOString();
    var totals = { fetched: 0, added: 0, pages: 0, has_more: false, summary: null };
    function step() {
      return fetchRecords(since(), PAGE_SIZE).then(function (page) {
        totals.pages += 1;
        totals.fetched += page.records.length;
        var store = window.VOC && VOC.store;
        var add = page.records.length && store && typeof store.addRecords === 'function' ? store.addRecords(page.records, 'imap') : Promise.resolve({ added: 0 });
        return Promise.resolve(add).then(function (res) {
          totals.added += res && typeof res.added === 'number' ? res.added : page.records.length;
          totals.summary = mergeSummary(totals.summary, res);
          if (page.next_since) setSince(page.next_since);
          else if (page.server_time) setSince(page.server_time);
          totals.has_more = page.has_more;
          if (page.has_more && page.records.length && totals.pages < MAX_PAGES) return step();
          return null;
        });
      });
    }
    return step().then(function () {
      lastPollInfo = { at: startedAt, fetched: totals.fetched, added: totals.added, pages: totals.pages, has_more: totals.has_more, error: null, summary: totals.summary };
      emit('poll', lastPollInfo);
      return lastPollInfo;
    }).catch(function (err) {
      lastPollInfo = { at: startedAt, fetched: totals.fetched, added: totals.added, pages: totals.pages, has_more: totals.has_more, error: err && err.message ? err.message : String(err), summary: totals.summary };
      emit('poll', lastPollInfo);
      return lastPollInfo;
    }).then(function (info) { pollBusy = false; return info; });
  }

  /**
   * Poll /api/records every `intervalS` seconds (60–900, default 120) and feed
   * new RawEmails to VOC.store.addRecords(records, 'imap'). Polls once immediately.
   * @param {number} [intervalS=120]
   * @returns {boolean} true when polling started
   */
  function startPolling(intervalS) {
    stopPolling();
    if (mode() === 'file' || typeof setInterval !== 'function') return false;
    var secs = Math.min(900, Math.max(15, Number(intervalS) || 120));
    pollTimer = setInterval(pollOnce, secs * 1000);
    pollOnce();
    return true;
  }

  /** Stop polling. */
  function stopPolling() {
    if (pollTimer !== null && typeof clearInterval === 'function') clearInterval(pollTimer);
    pollTimer = null;
  }

  function isPolling() { return pollTimer !== null; }

  /**
   * Seconds between browser polls: `override` when given, else the sidecar's poll_interval_s from the last healthy
   * /api/health, else the connector settings saved in the store, else 120. Clamped to 60–900.
   * @param {number} [override]
   * @returns {number}
   */
  function pollInterval(override) {
    var n = Number(override) || 0;
    if (!n && lastHealth && lastHealth.ok && typeof lastHealth.poll_interval_s === 'number') n = lastHealth.poll_interval_s;
    if (!n) {
      try {
        var st = window.VOC && VOC.store && typeof VOC.store.settings === 'function' ? VOC.store.settings() : null;
        n = st && st.connector ? Number(st.connector.poll_interval_s) || 0 : 0;
      } catch (e) { n = 0; }
    }
    return Math.min(900, Math.max(60, n || DEFAULT_POLL_S));
  }

  /**
   * Start records polling when the page is served by the sidecar and a token is set; otherwise do nothing.
   * Already-running polling is left alone unless `restart` is true (used after saveConfig to apply a new interval).
   * @param {number} [intervalS]
   * @param {boolean} [restart=false]
   * @returns {boolean} true when polling is on after the call
   */
  function autoStart(intervalS, restart) {
    if (mode() !== 'served' || !token()) return false;
    if (isPolling() && !restart) return true;
    return startPolling(pollInterval(intervalS));
  }

  /** Result of the most recent poll: {at, fetched, added, error}. */
  function lastPoll() { return lastPollInfo; }

  /** Forget the pagination cursor so the next poll re-fetches everything. */
  function resetSince() { setSince(null); }

  /* ----------------------------------------------------------- live data */

  /**
   * Records the sidecar wrote into js/live-data.js (window.VOC_LIVE).
   * @returns {Object[]} RawEmail[]
   */
  function loadLive() {
    var live = typeof window !== 'undefined' ? window.VOC_LIVE : null;
    return Array.isArray(live) ? live : [];
  }

  /**
   * Re-insert <script src="js/live-data.js?ts=…"> and resolve with the fresh
   * window.VOC_LIVE. Rejects when the file is missing or after 5 s.
   * @returns {Promise<Object[]>} RawEmail[]
   */
  function reloadLiveScript() {
    return new Promise(function (resolve, reject) {
      if (typeof document === 'undefined' || !document.head) { reject(new Error('No document to load live data into')); return; }
      var previous = document.querySelectorAll('script[data-voc-live]');
      Array.prototype.forEach.call(previous, function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
      var done = false;
      var timer = setTimeout(function () { finish(new Error('live-data.js did not load within 5 s')); }, LIVE_TIMEOUT_MS);
      var script = document.createElement('script');
      function finish(err) {
        if (done) return; done = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (err && script.parentNode) script.parentNode.removeChild(script);
        if (err) reject(err); else resolve(loadLive());
      }
      script.src = LIVE_SRC + '?ts=' + Date.now();
      script.async = true;
      script.setAttribute('data-voc-live', '1');
      script.onload = function () { finish(null); };
      script.onerror = function () { finish(new Error('js/live-data.js is not present yet — run the sidecar once to create it')); };
      document.head.appendChild(script);
    });
  }

  return {
    mode: mode,
    isServed: isServed,
    lastStatus: lastStatus,
    baseUrl: baseUrl,
    setToken: setToken,
    token: token,
    health: health,
    status: status,
    fetchRecords: fetchRecords,
    getConfig: getConfig,
    saveConfig: saveConfig,
    triggerSync: triggerSync,
    ingest: ingest,
    saveReport: saveReport,
    startPolling: startPolling,
    stopPolling: stopPolling,
    isPolling: isPolling,
    autoStart: autoStart,
    pollInterval: pollInterval,
    lastPoll: lastPoll,
    pollOnce: pollOnce,
    resetSince: resetSince,
    loadLive: loadLive,
    reloadLiveScript: reloadLiveScript,
    on: on,
    off: off
  };
})();
