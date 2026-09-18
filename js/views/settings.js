/* L-Nutra · Voice of the Customer — Settings view (SPEC §5 item 12, §9 connector UI)
 * Clock, theme, SLA hours, agents, mailbox connector (config + token + status), import with CSV mapping dialog,
 * orders-by-month grid, classifier tester and the danger zone. Touches the DOM only inside mount/update/unmount.
 */
(function () {
  'use strict';
  window.VOC = window.VOC || {};
  VOC.views = VOC.views || {};

  var NAME = 'settings';
  var TITLE = 'Settings';
  var STATUS_POLL_MS = 30000;
  var ORDER_MONTHS = 13;

  var PRESETS = {
    gmail: { label: 'Gmail (App Password)', host: 'imap.gmail.com', port: 993, folder: 'INBOX', sent_folder: '[Gmail]/Sent Mail' },
    google_workspace: { label: 'Google Workspace (App Password)', host: 'imap.gmail.com', port: 993, folder: 'INBOX', sent_folder: '[Gmail]/Sent Mail' },
    yahoo: { label: 'Yahoo Mail (App Password)', host: 'imap.mail.yahoo.com', port: 993, folder: 'INBOX', sent_folder: 'Sent' },
    icloud: { label: 'iCloud Mail (App-specific password)', host: 'imap.mail.me.com', port: 993, folder: 'INBOX', sent_folder: 'Sent Messages' },
    generic_imap: { label: 'Generic IMAP over TLS', host: '', port: 993, folder: 'INBOX', sent_folder: 'Sent' },
    microsoft365: { label: 'Microsoft 365 / Outlook (roadmap)', host: 'outlook.office365.com', port: 993, folder: 'INBOX', sent_folder: 'Sent Items', roadmap: true }
  };
  var PRESET_ORDER = ['gmail', 'google_workspace', 'yahoo', 'icloud', 'generic_imap', 'microsoft365'];
  var URGENCIES = ['P0', 'P1', 'P2', 'P3'];
  var PHI_NOTICE = 'Client-side redaction is a display convenience, not access control: anyone with this browser profile can read the underlying records. Keep L-Nutra Health and Med.Ed mail in a separate mailbox or turn on server-side redaction so the body is replaced before it reaches the browser. HIPAA likely applies to L-Nutra Health patient mail; EU and UK senders imply GDPR handling (lawful basis, retention, erasure on request).';

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function U() { return VOC.util || null; }
  function ui() { return VOC.ui || null; }
  function store() { return VOC.store || null; }
  function conn() { return VOC.connector || null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }

  function esc(s) {
    if (ui() && ui().esc) return ui().esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function h(tag, attrs, children) {
    if (ui() && typeof ui().h === 'function') return ui().h(tag, attrs, children);
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'class') el.className = v;
      else if (typeof v === 'function' && /^on/.test(k)) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function toast(msg, kind, opts) { if (ui() && ui().toast) ui().toast(msg, kind || 'info', opts); }
  function fmtInt(n) { var u = U(); return u ? u.fmt.int(n) : (isNum(n) ? String(Math.round(n)) : '—'); }
  function fmtDate(iso, gran) { var u = U(); return u ? u.fmt.date(iso, gran || 'day') : String(iso || '—'); }
  function label(kind, id) { var e = VOC.enums; return e && typeof e.label === 'function' ? e.label(kind, id) : String(id); }
  function subtitle(derived) {
    if (VOC.app && typeof VOC.app.rangeLabel === 'function') return VOC.app.rangeLabel(derived);
    return derived && typeof derived.n === 'number' ? 'n = ' + derived.n + ' records' : '';
  }
  /** One bold sentence for the header: clock mode, theme and connector mode in plain words (no enum ids), with n. */
  function leadText(derived) {
    var sset = settingsOf();
    var s = store();
    var eff = s && typeof s.clockMode === 'function' ? s.clockMode() : (sset.clock || 'demo');
    var clockWord = (sset.clock || 'demo') === 'demo' ? 'Demo clock' : 'Real clock';
    if ((sset.clock || 'demo') === 'demo' && eff === 'real') clockWord = 'Demo clock set but running real (newer mail exists)';
    var themeWord = { system: 'system theme', light: 'light theme', dark: 'dark theme' }[sset.theme || 'system'] || 'system theme';
    var c = conn();
    var mode = c && typeof c.mode === 'function' ? c.mode() : 'file';
    var connWord = mode === 'served' ? 'mailbox sidecar connected' : mode === 'static' ? 'static site, no sidecar' : 'opened from a file, no server';
    var n = derived && typeof derived.n === 'number' ? derived.n : null;
    return clockWord + '; ' + themeWord + '; ' + connWord + (n === null ? '.' : ' (n = ' + fmtInt(n) + ' records in range).');
  }
  function setHeader(derived) {
    var hd = st.els && st.els.header;
    if (!hd) return;
    if (hd.setMeta) hd.setMeta(subtitle(derived)); else { var sub = hd.querySelector('[data-role="subtitle"]'); if (sub) sub.textContent = subtitle(derived); }
    if (hd.setLead) hd.setLead(leadText(derived));
  }
  function settingsOf() {
    var s = store();
    if (s && typeof s.settings === 'function') { try { return s.settings() || {}; } catch (e) { return {}; } }
    return {};
  }
  function setSettings(patch) { var s = store(); if (s && typeof s.setSettings === 'function') s.setSettings(patch); }
  function nowDate() {
    var s = store();
    if (s && typeof s.now === 'function') { try { var d = s.now(); if (d instanceof Date && !isNaN(d.getTime())) return d; } catch (e) { /* fall through */ } }
    return new Date();
  }
  function monthKeyNow() { var u = U(); return u ? u.monthKey(nowDate().toISOString()) : nowDate().toISOString().slice(0, 7); }
  function addMonths(key, n) {
    var u = U();
    if (u && typeof u.addMonths === 'function') return u.addMonths(key, n);
    var y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + (m + 1 < 10 ? '0' : '') + (m + 1);
  }
  function agoLabel(iso) {
    if (!iso) return 'never';
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return String(iso);
    if (ms < 0) return 'just now';
    var m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var hrs = Math.round(m / 60);
    return hrs < 48 ? hrs + ' h ago' : Math.round(hrs / 24) + ' d ago';
  }
  function splitList(v) { return String(v || '').split(/[\n,;]+/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function joinList(a) { return arr(a).join('\n'); }
  function isFocusedWithin(el) { return !!(el && typeof document !== 'undefined' && document.activeElement && el.contains(document.activeElement)); }

  /** Labelled form field. */
  function field(opts) {
    var wrap = h('div', { class: 'field' + (opts.inline ? ' field--inline' : '') });
    if (opts.label) wrap.appendChild(h('label', { class: 'label', for: opts.input.id, text: opts.label }));
    wrap.appendChild(opts.input);
    if (opts.hint) wrap.appendChild(h('span', { class: 'field__hint', text: opts.hint }));
    return wrap;
  }
  function checkbox(id, text, checked, onChange) {
    var box = h('input', { type: 'checkbox', id: id });
    box.checked = !!checked;
    box.addEventListener('change', function () { onChange(box.checked); });
    return h('label', { class: 'checkbox-row', for: id }, [box, h('span', { text: text })]);
  }
  function section(id, title, sub) {
    var sec = h('section', { class: 'card settings-section', id: 'settings-' + id, 'aria-labelledby': 'settings-' + id + '-title' });
    sec.appendChild(h('div', { class: 'card__header' }, h('div', {}, [
      h('h2', { class: 'card__title', id: 'settings-' + id + '-title', text: title }),
      sub ? h('p', { class: 'card__subtitle', text: sub }) : null
    ])));
    return sec;
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  var st = {
    root: null, derived: null, els: {}, cfg: null, statusTimer: null, pollHandler: null, storeHandlers: [], mappingOpen: false
  };

  /* ------------------------------------------------------------------ */
  /* Clock and theme                                                     */
  /* ------------------------------------------------------------------ */

  function clockExplanation() {
    var s = store();
    var meta = s && typeof s.meta === 'function' ? s.meta() : {};
    var asOf = meta && meta.as_of ? fmtDate(meta.as_of, 'datetime') : 'the seed as-of date';
    var eff = s && typeof s.clockMode === 'function' ? s.clockMode() : 'demo';
    var setting = settingsOf().clock || 'demo';
    var text = 'Demo clock treats ' + asOf + ' as “now”, so the seeded 12 months, SLA ages, regulatory countdowns and range presets line up with the sample data. Real clock uses this computer’s time.';
    if (setting === 'demo' && eff === 'real') text += ' The clock is currently real anyway because imported or live mail newer than the as-of date exists.';
    else text += ' Effective clock now: ' + eff + '.';
    return text;
  }

  function renderClock() {
    var sec = section('clock', 'Clock', 'Which “now” every age, SLA, deadline and range preset uses.');
    var setting = settingsOf().clock || 'demo';
    var group = h('div', { class: 'radio-group', role: 'radiogroup', 'aria-label': 'Clock mode' });
    [['demo', 'Demo clock', 'Freeze time at the seed as-of date'], ['real', 'Real clock', 'Use this computer’s current time']].forEach(function (o) {
      var r = h('input', { type: 'radio', name: 'clock', id: 'clock-' + o[0], value: o[0] });
      r.checked = setting === o[0];
      r.addEventListener('change', function () { if (r.checked) { setSettings({ clock: o[0] }); toast('Clock set to ' + o[1].toLowerCase() + '.', 'good', { ms: 2500 }); } });
      group.appendChild(h('label', { class: 'radio-card', for: r.id }, [r, h('span', {}, [h('span', { class: 'radio-card__title', text: o[1] }), h('span', { class: 'radio-card__hint', text: o[2] })])]));
    });
    sec.appendChild(group);
    var expl = h('p', { class: 'settings-help', id: 'clock-explanation', text: clockExplanation() });
    sec.appendChild(expl);
    st.els.clockGroup = group; st.els.clockExpl = expl;
    return sec;
  }

  function renderTheme() {
    var sec = section('theme', 'Theme', 'System follows your OS preference; charts re-theme immediately.');
    var cur = settingsOf().theme || 'system';
    var group = h('div', { class: 'radio-group', role: 'radiogroup', 'aria-label': 'Theme' });
    [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].forEach(function (o) {
      var r = h('input', { type: 'radio', name: 'theme', id: 'theme-' + o[0], value: o[0] });
      r.checked = cur === o[0];
      r.addEventListener('change', function () {
        if (!r.checked) return;
        if (VOC.app && typeof VOC.app.setTheme === 'function') VOC.app.setTheme(o[0]); else setSettings({ theme: o[0] });
      });
      group.appendChild(h('label', { class: 'radio-card radio-card--compact', for: r.id }, [r, h('span', { class: 'radio-card__title', text: o[1] })]));
    });
    sec.appendChild(group);
    st.els.themeGroup = group;
    return sec;
  }

  /* ------------------------------------------------------------------ */
  /* SLA and agents                                                      */
  /* ------------------------------------------------------------------ */

  function renderSla() {
    var sec = section('sla', 'First-response SLA hours', 'Per urgency. Drives frt_sla_pct, SLA-breached counts and the inbox breach flags.');
    var sla = settingsOf().sla || {};
    var grid = h('div', { class: 'sla-grid' });
    URGENCIES.forEach(function (u) {
      var input = h('input', { type: 'number', id: 'sla-' + u, min: '0.25', max: '720', step: '0.25', value: isNum(sla[u]) ? sla[u] : '', inputmode: 'decimal' });
      input.addEventListener('change', function () {
        var v = Number(input.value);
        if (!isFinite(v) || v <= 0) { input.value = isNum(sla[u]) ? sla[u] : ''; toast('SLA hours must be a positive number.', 'warning'); return; }
        var patch = {}; patch[u] = v;
        setSettings({ sla: patch });
        toast(label('urgency', u) + ' SLA set to ' + v + ' h.', 'good', { ms: 2500 });
      });
      grid.appendChild(field({ label: label('urgency', u), input: input, hint: 'hours' }));
    });
    sec.appendChild(grid);
    st.els.slaGrid = grid;
    return sec;
  }

  function renderAgents() {
    var sec = section('agents', 'Agents', 'Names offered in the assignee menus and the audit log.');
    var s = settingsOf();
    var me = h('input', { type: 'text', id: 'me-name', value: s.me || 'You', maxlength: '60', autocomplete: 'off' });
    me.addEventListener('change', function () { var v = me.value.trim() || 'You'; me.value = v; setSettings({ me: v }); });
    sec.appendChild(field({ label: 'Your name (used as the actor in the audit log and the “Mine” view)', input: me }));
    var list = h('ul', { class: 'chip-list', id: 'agents-list', 'aria-label': 'Agents' });
    sec.appendChild(list);
    var form = h('form', { class: 'row', id: 'agents-form' });
    var input = h('input', { type: 'text', id: 'agent-new', class: 'input input--sm', placeholder: 'Add an agent, e.g. Maya R.', 'aria-label': 'New agent name', maxlength: '60', autocomplete: 'off' });
    form.appendChild(input);
    form.appendChild(h('button', { type: 'submit', class: 'btn btn--sm', id: 'agent-add' }, 'Add agent'));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      var agents = arr(settingsOf().agents).slice();
      if (agents.indexOf(v) >= 0) { toast(v + ' is already listed.', 'warning'); return; }
      agents.push(v);
      setSettings({ agents: agents });
      input.value = '';
      renderAgentList();
    });
    sec.appendChild(form);
    st.els.agentList = list; st.els.meInput = me;
    renderAgentList();
    return sec;
  }

  function renderAgentList() {
    var list = st.els.agentList;
    if (!list) return;
    list.innerHTML = '';
    var agents = arr(settingsOf().agents);
    if (!agents.length) { list.appendChild(h('li', { class: 'muted', text: 'No agents yet.' })); return; }
    agents.forEach(function (a, i) {
      list.appendChild(h('li', { class: 'chip chip--value' }, [
        h('span', { text: a }),
        h('button', { type: 'button', class: 'chip__x', 'aria-label': 'Remove ' + a, id: 'agent-remove-' + i, onclick: function () {
          var next = arr(settingsOf().agents).filter(function (x) { return x !== a; });
          setSettings({ agents: next });
          renderAgentList();
          toast('Removed ' + a + '.', 'info', { undo: function () { var cur = arr(settingsOf().agents).slice(); cur.splice(Math.min(i, cur.length), 0, a); setSettings({ agents: cur }); renderAgentList(); } });
        } }, '×')
      ]));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Connector                                                           */
  /* ------------------------------------------------------------------ */

  function served() { var c = conn(); return !!(c && typeof c.mode === 'function' && c.mode() === 'served'); }

  function defaultCfg() {
    return {
      provider_preset: 'gmail', host: 'imap.gmail.com', port: 993, username: '', auth: 'password', folder: 'INBOX', sent_folder: '[Gmail]/Sent Mail',
      agent_addresses: [], poll_interval_s: 300, since: '', max_per_poll: 200, sender_allow: [], sender_deny: [], subject_include: '', subject_exclude: '',
      skip_autoreplies: true, order_prefix: '#', restricted_recipients: ['Med.Ed@l-nutra.com'], restricted_domains: [], redact_restricted_on_server: true, data_dir: ''
    };
  }
  function loadCfg() { return Object.assign(defaultCfg(), settingsOf().connector || {}); }

  function applyPreset(id) {
    var p = PRESETS[id];
    if (!p) return;
    st.cfg.provider_preset = id;
    if (p.host) st.cfg.host = p.host;
    st.cfg.port = p.port;
    st.cfg.folder = st.cfg.folder || p.folder;
    st.cfg.sent_folder = p.sent_folder;
    if (id === 'generic_imap') st.cfg.host = '';
    syncConnectorForm();
  }

  function syncConnectorForm() {
    var f = st.els.connFields;
    if (!f) return;
    var c = st.cfg;
    f.provider.value = c.provider_preset || 'gmail';
    f.host.value = c.host || ''; f.port.value = c.port || 993; f.username.value = c.username || '';
    f.folder.value = c.folder || 'INBOX'; f.sent_folder.value = c.sent_folder || '';
    f.agent_addresses.value = joinList(c.agent_addresses); f.poll_interval_s.value = c.poll_interval_s || 300; f.since.value = c.since || '';
    f.max_per_poll.value = c.max_per_poll || 200; f.sender_allow.value = joinList(c.sender_allow); f.sender_deny.value = joinList(c.sender_deny);
    f.subject_include.value = c.subject_include || ''; f.subject_exclude.value = c.subject_exclude || '';
    f.skip_autoreplies.checked = c.skip_autoreplies !== false; f.order_prefix.value = c.order_prefix || '';
    f.restricted_recipients.value = joinList(c.restricted_recipients); f.restricted_domains.value = joinList(c.restricted_domains);
    f.redact_restricted_on_server.checked = c.redact_restricted_on_server !== false; f.data_dir.value = c.data_dir || '';
    if (st.els.roadmap) st.els.roadmap.hidden = !(PRESETS[c.provider_preset] && PRESETS[c.provider_preset].roadmap);
  }

  function readConnectorForm() {
    var f = st.els.connFields, c = st.cfg;
    c.provider_preset = f.provider.value; c.host = f.host.value.trim(); c.port = Math.max(1, Math.min(65535, Number(f.port.value) || 993));
    c.username = f.username.value.trim(); c.auth = 'password'; c.folder = f.folder.value.trim() || 'INBOX'; c.sent_folder = f.sent_folder.value.trim();
    c.agent_addresses = splitList(f.agent_addresses.value); c.poll_interval_s = Math.max(60, Math.min(900, Number(f.poll_interval_s.value) || 300));
    c.since = /^\d{4}-\d{2}-\d{2}$/.test(f.since.value) ? f.since.value : ''; c.max_per_poll = Math.max(1, Math.min(5000, Number(f.max_per_poll.value) || 200));
    c.sender_allow = splitList(f.sender_allow.value); c.sender_deny = splitList(f.sender_deny.value);
    c.subject_include = f.subject_include.value.trim(); c.subject_exclude = f.subject_exclude.value.trim();
    c.skip_autoreplies = !!f.skip_autoreplies.checked; c.order_prefix = f.order_prefix.value; c.restricted_recipients = splitList(f.restricted_recipients.value);
    c.restricted_domains = splitList(f.restricted_domains.value); c.redact_restricted_on_server = !!f.redact_restricted_on_server.checked; c.data_dir = f.data_dir.value.trim();
    ['password', 'secret', 'token', 'app_password', 'mail_secret'].forEach(function (k) { delete c[k]; });
    f.poll_interval_s.value = c.poll_interval_s; f.port.value = c.port; f.max_per_poll.value = c.max_per_poll;
    return c;
  }

  function renderConnector() {
    var isServed = served();
    var sec = section('connector', 'Mailbox connector', isServed ? 'Served by the Python sidecar: configuration and status come from the server.' : 'File mode: the settings are kept in this browser until the sidecar runs.');
    var c = st.cfg = loadCfg();
    var f = st.els.connFields = {};

    var modeBox = h('div', { class: 'notice notice--' + (isServed ? 'good' : 'info'), id: 'conn-mode' });
    if (isServed) modeBox.appendChild(h('p', { text: 'The page is served over HTTP. Health and status below come from /api/health and /api/status; Save config posts to /api/config and restarts the poller.' }));
    else {
      modeBox.appendChild(h('p', { text: 'To connect a mailbox, run the zero-dependency sidecar from the project folder and open the site through it:' }));
      modeBox.appendChild(h('pre', { class: 'code-block', text: 'cd server && cp config.example.json config.json   # first time only\nexport VOC_MAIL_SECRET=\'<app password>\'          # or store it in the macOS Keychain (service voc-mail)\npython3 server/voc_server.py                       # prints TOKEN = … and serves http://127.0.0.1:8765' }));
      modeBox.appendChild(h('p', { text: 'Paste the printed TOKEN below once the site opens from http://127.0.0.1:8765. Until then, “Reload live data” re-reads js/live-data.js written by the sidecar, and everything else here is saved locally.' }));
    }
    sec.appendChild(modeBox);

    /* Provider + credentials */
    f.provider = h('select', { id: 'conn-provider' });
    PRESET_ORDER.forEach(function (id) { f.provider.appendChild(h('option', { value: id }, PRESETS[id].label)); });
    f.provider.addEventListener('change', function () { readConnectorForm(); applyPreset(f.provider.value); });
    st.els.roadmap = h('div', { class: 'notice notice--warning', id: 'conn-roadmap', hidden: true }, h('p', { text: 'Microsoft 365 disabled basic IMAP authentication; app passwords no longer work. XOAUTH2 / Graph with the device-code flow is on the roadmap (see server/README.md). Until then, forward or export the mailbox and import the files below.' }));

    f.host = h('input', { type: 'text', id: 'conn-host', autocomplete: 'off', spellcheck: 'false', placeholder: 'imap.example.com' });
    f.port = h('input', { type: 'number', id: 'conn-port', min: '1', max: '65535', step: '1' });
    f.username = h('input', { type: 'email', id: 'conn-username', autocomplete: 'off', spellcheck: 'false', placeholder: 'support@l-nutra.com' });
    f.folder = h('input', { type: 'text', id: 'conn-folder', autocomplete: 'off', spellcheck: 'false' });
    f.sent_folder = h('input', { type: 'text', id: 'conn-sent-folder', autocomplete: 'off', spellcheck: 'false' });
    f.agent_addresses = h('textarea', { id: 'conn-agent-addresses', rows: '2', spellcheck: 'false', placeholder: 'one address per line' });
    f.poll_interval_s = h('input', { type: 'number', id: 'conn-poll-interval', min: '60', max: '900', step: '30' });
    f.since = h('input', { type: 'date', id: 'conn-since' });
    f.max_per_poll = h('input', { type: 'number', id: 'conn-max-per-poll', min: '1', max: '5000', step: '1' });
    f.sender_allow = h('textarea', { id: 'conn-sender-allow', rows: '2', spellcheck: 'false', placeholder: 'addresses or domains, one per line' });
    f.sender_deny = h('textarea', { id: 'conn-sender-deny', rows: '2', spellcheck: 'false', placeholder: 'noreply@shopify.com\n@mailchimp.com' });
    f.subject_include = h('input', { type: 'text', id: 'conn-subject-include', autocomplete: 'off', spellcheck: 'false', placeholder: 'regular expression, empty = all' });
    f.subject_exclude = h('input', { type: 'text', id: 'conn-subject-exclude', autocomplete: 'off', spellcheck: 'false', placeholder: '^(?:Your order|Shipping confirmation)' });
    f.skip_autoreplies = h('input', { type: 'checkbox', id: 'conn-skip-autoreplies' });
    f.order_prefix = h('input', { type: 'text', id: 'conn-order-prefix', maxlength: '8', autocomplete: 'off' });
    f.restricted_recipients = h('textarea', { id: 'conn-restricted-recipients', rows: '2', spellcheck: 'false' });
    f.restricted_domains = h('textarea', { id: 'conn-restricted-domains', rows: '2', spellcheck: 'false', placeholder: 'lnutrahealth.example' });
    f.redact_restricted_on_server = h('input', { type: 'checkbox', id: 'conn-redact-server' });
    f.data_dir = h('input', { type: 'text', id: 'conn-data-dir', autocomplete: 'off', spellcheck: 'false', placeholder: '~/Library/Application Support/voc' });

    var grid = h('div', { class: 'form-grid conn-grid' }, [
      field({ label: 'Provider preset', input: f.provider, hint: 'Fills host, port and Sent folder with sensible defaults.' }),
      field({ label: 'Username (mailbox address)', input: f.username }),
      field({ label: 'IMAP host', input: f.host }),
      field({ label: 'Port', input: f.port, hint: 'TLS, usually 993' }),
      field({ label: 'Folder to poll', input: f.folder, hint: 'Gmail labels appear as folders, e.g. Support/Reviews' }),
      field({ label: 'Sent folder (optional)', input: f.sent_folder, hint: 'Polled as outbound so first-response times can be computed. Empty disables it.' }),
      field({ label: 'Agent addresses', input: f.agent_addresses, hint: 'Mail from these is outbound even in the inbox.' }),
      field({ label: 'Poll interval (seconds)', input: f.poll_interval_s, hint: '60–900' }),
      field({ label: 'Fetch mail since', input: f.since, hint: 'First scan only; empty means the whole folder in pages.' }),
      field({ label: 'Max messages per poll', input: f.max_per_poll }),
      field({ label: 'Sender allow list', input: f.sender_allow, hint: 'Inbound only; empty allows everyone.' }),
      field({ label: 'Sender deny list', input: f.sender_deny, hint: 'Deny always wins.' }),
      field({ label: 'Subject include', input: f.subject_include }),
      field({ label: 'Subject exclude', input: f.subject_exclude }),
      field({ label: 'Order number prefix', input: f.order_prefix, hint: 'Shopify uses #' }),
      field({ label: 'Data directory', input: f.data_dir, hint: 'Keep it outside iCloud Drive; applies at the next server start.' }),
      field({ label: 'Restricted recipients', input: f.restricted_recipients, hint: 'Mail to these addresses is PHI-adjacent and flagged restricted.' }),
      field({ label: 'Restricted domains', input: f.restricted_domains })
    ]);
    sec.appendChild(st.els.roadmap);
    sec.appendChild(grid);
    var toggles = h('div', { class: 'stack stack--tight' }, [
      h('label', { class: 'checkbox-row', for: 'conn-skip-autoreplies' }, [f.skip_autoreplies, h('span', { text: 'Skip auto-replies, bounces and newsletters detected from headers' })]),
      h('label', { class: 'checkbox-row', for: 'conn-redact-server' }, [f.redact_restricted_on_server, h('span', { text: 'Redact restricted mail on the server before it reaches the browser (recommended)' })])
    ]);
    sec.appendChild(toggles);

    /* Client-side redaction (store setting) */
    var s0 = settingsOf();
    sec.appendChild(checkbox('redact-restricted-client', 'Redact restricted records in this browser (sender and body hidden outside the restricted queue)', s0.redactRestricted !== false, function (v) { setSettings({ redactRestricted: v }); }));

    sec.appendChild(h('div', { class: 'notice notice--serious phi-notice', id: 'phi-notice' }, [h('strong', { text: 'PHI notice. ' }), h('span', { text: PHI_NOTICE })]));

    /* Token */
    var cc = conn();
    var tokenInput = h('input', { type: 'password', id: 'conn-token', autocomplete: 'off', spellcheck: 'false', placeholder: 'TOKEN printed by voc_server.py', value: cc && typeof cc.token === 'function' ? (cc.token() || '') : '' });
    var tokenSave = h('button', { type: 'button', class: 'btn btn--sm', id: 'conn-token-save', onclick: function () {
      if (!cc || typeof cc.setToken !== 'function') { toast('Connector module unavailable.', 'critical'); return; }
      var t = cc.setToken(tokenInput.value);
      toast(t ? 'API token saved in this browser (never in the config file).' : 'API token cleared.', 'good', { ms: 3000 });
      if (isServed) refreshStatus();
    } }, 'Save token');
    var tokenShow = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'conn-token-show', 'aria-pressed': 'false', onclick: function () {
      var show = tokenInput.type === 'password'; tokenInput.type = show ? 'text' : 'password'; tokenShow.setAttribute('aria-pressed', String(show)); tokenShow.textContent = show ? 'Hide' : 'Show';
    } }, 'Show');
    sec.appendChild(h('div', { class: 'field' }, [
      h('label', { class: 'label', for: 'conn-token', text: 'API token (X-VoC-Token)' }),
      h('div', { class: 'row token-row' }, [tokenInput, tokenSave, tokenShow]),
      h('span', { class: 'field__hint', text: 'Stored only in this browser. The mailbox password is never entered here; the sidecar reads it from VOC_MAIL_SECRET or the Keychain.' })
    ]));

    /* Actions */
    var actions = h('div', { class: 'row conn-actions' });
    actions.appendChild(h('button', { type: 'button', class: 'btn btn--primary', id: 'conn-save-config', onclick: saveConfig }, isServed ? 'Save config' : 'Save locally'));
    if (isServed) {
      actions.appendChild(h('button', { type: 'button', class: 'btn', id: 'conn-sync-now', onclick: syncNow }, 'Sync now'));
      actions.appendChild(h('button', { type: 'button', class: 'btn btn--ghost', id: 'conn-refresh-status', onclick: refreshStatus }, 'Refresh status'));
    }
    actions.appendChild(h('button', { type: 'button', class: 'btn btn--ghost', id: 'conn-reload-live', onclick: reloadLive }, 'Reload live data'));
    sec.appendChild(actions);

    /* Status panel */
    var status = h('div', { class: 'conn-status', id: 'conn-status', 'aria-live': 'polite' });
    sec.appendChild(status);
    st.els.connStatus = status;

    syncConnectorForm();
    if (isServed) {
      refreshStatus();
      if (cc && typeof cc.getConfig === 'function' && cc.token && cc.token()) {
        cc.getConfig().then(function (remote) {
          if (!remote || typeof remote !== 'object') return;
          var clean = {};
          Object.keys(defaultCfg()).forEach(function (k) { if (remote[k] !== undefined) clean[k] = remote[k]; });
          if (!isFocusedWithin(grid)) { st.cfg = Object.assign(st.cfg, clean); syncConnectorForm(); }
        }).catch(function () { /* status panel reports the error */ });
      }
    } else renderFileStatus();
    return sec;
  }

  function renderFileStatus() {
    var box = st.els.connStatus;
    if (!box) return;
    var c = conn();
    var live = c && typeof c.loadLive === 'function' ? c.loadLive() : [];
    box.innerHTML = '';
    box.appendChild(h('dl', { class: 'kv' }, [
      h('dt', { text: 'Mode' }), h('dd', { text: 'File (no API)' }),
      h('dt', { text: 'Live data file' }), h('dd', { text: live.length ? fmtInt(live.length) + ' messages in js/live-data.js' : 'js/live-data.js not present or empty' })
    ]));
  }

  function kvRows(pairs) {
    var dl = h('dl', { class: 'kv' });
    pairs.forEach(function (p) { dl.appendChild(h('dt', { text: p[0] })); dl.appendChild(h('dd', { text: p[1] === null || p[1] === undefined || p[1] === '' ? '—' : String(p[1]) })); });
    return dl;
  }

  function refreshStatus() {
    var c = conn(), box = st.els.connStatus;
    if (!box || !c || typeof c.health !== 'function') return;
    box.innerHTML = '';
    box.appendChild(h('p', { class: 'muted', text: 'Checking the sidecar…' }));
    c.health().then(function (hl) {
      var rows = [['Sidecar', hl && hl.ok ? 'online · v' + (hl.version || '?') + ' · ' + (hl.mode || 'idle') : 'answered with a problem'], ['Uptime', isNum(hl && hl.uptime_s) ? Math.round(hl.uptime_s / 60) + ' min' : null], ['Last sync', hl && hl.last_sync_at ? agoLabel(hl.last_sync_at) + ' (' + fmtDate(hl.last_sync_at, 'datetime') + ')' : 'never']];
      if (!c.token || !c.token()) {
        box.innerHTML = '';
        box.appendChild(kvRows(rows));
        box.appendChild(h('p', { class: 'field__hint', text: 'Paste the API token to see mailbox status, counts and errors.' }));
        return null;
      }
      return c.status().then(function (stt) {
        stt = stt || {};
        var counts = stt.counts || {};
        var lastPoll = typeof c.lastPoll === 'function' ? c.lastPoll() : null;
        rows = rows.concat([
          ['Connected', stt.connected === true ? 'yes' : stt.connected === false ? 'no' : null],
          ['Provider', stt.provider], ['Mailbox', stt.mailbox], ['Folder', stt.folder + (stt.sent_folder ? ' · sent: ' + stt.sent_folder : '')],
          ['Counts', 'fetched ' + fmtInt(counts.fetched || 0) + ' · deduped ' + fmtInt(counts.deduped || 0) + ' · noise ' + fmtInt(counts.noise || 0)],
          ['UID state', (stt.uidvalidity ? 'validity ' + stt.uidvalidity : '') + (stt.last_uid ? ' · last uid ' + stt.last_uid : '')],
          ['Next poll', isNum(stt.next_poll_in_s) ? 'in ' + Math.max(0, Math.round(stt.next_poll_in_s)) + ' s' : null],
          ['Browser polling', c.isPolling && c.isPolling() ? 'on' + (lastPoll && lastPoll.at ? ' · last ' + agoLabel(lastPoll.at) + ', +' + fmtInt(lastPoll.added || 0) : '') : 'off'],
          ['Last error', stt.last_error || 'none']
        ]);
        box.innerHTML = '';
        box.appendChild(kvRows(rows));
        if (stt.last_error) box.classList.add('has-error'); else box.classList.remove('has-error');
      });
    }).catch(function (err) {
      box.innerHTML = '';
      box.classList.add('has-error');
      box.appendChild(h('p', { class: 'conn-status__error', text: 'Sidecar unavailable: ' + (err && err.message ? err.message : String(err)) }));
      box.appendChild(h('p', { class: 'field__hint', text: 'Start it with python3 server/voc_server.py and reload, or check the token when the error is 401/403.' }));
    });
  }

  function saveConfig() {
    var cfg = readConnectorForm();
    setSettings({ connector: Object.assign({}, cfg) });
    var c = conn();
    if (!served() || !c || typeof c.saveConfig !== 'function') { toast('Connector settings saved in this browser. They are posted to the sidecar once the site is served by it.', 'good', { ms: 5000 }); return; }
    var btn = st.root && st.root.querySelector('#conn-save-config');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    c.saveConfig(cfg).then(function (res) {
      toast('Config saved on the server' + (res && res.restarted ? '; the poller restarted' : '') + '.', 'good', { ms: 5000 });
      refreshStatus();
    }).catch(function (err) {
      toast('Save failed: ' + (err && err.message ? err.message : String(err)), 'critical', { ms: 8000 });
    }).then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save config'; } });
  }

  function syncNow() {
    var c = conn();
    if (!c || typeof c.triggerSync !== 'function') return;
    var btn = st.root && st.root.querySelector('#conn-sync-now');
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
    c.triggerSync().then(function (res) {
      toast('Sync finished: ' + fmtInt(res && res.fetched || 0) + ' messages fetched in ' + fmtInt(res && res.duration_ms ? res.duration_ms / 1000 : 0) + ' s. Pulling them into the browser…', 'good', { ms: 5000 });
      return typeof c.pollOnce === 'function' ? c.pollOnce() : null;
    }).then(function (info) {
      if (info && !info.error) toast(fmtInt(info.added || 0) + ' new record' + (info.added === 1 ? '' : 's') + ' added from the sidecar.', 'good', { ms: 4000 });
      else if (info && info.error) toast('Fetch after sync failed: ' + info.error, 'warning');
      refreshStatus();
    }).catch(function (err) {
      toast('Sync failed: ' + (err && err.message ? err.message : String(err)), 'critical', { ms: 8000 });
    }).then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Sync now'; } });
  }

  function reloadLive() {
    var c = conn(), s = store();
    if (!c || typeof c.reloadLiveScript !== 'function') { toast('Connector module unavailable.', 'critical'); return; }
    var btn = st.root && st.root.querySelector('#conn-reload-live');
    if (btn) { btn.disabled = true; btn.textContent = 'Reloading…'; }
    c.reloadLiveScript().then(function (raw) {
      if (!raw.length) { toast('js/live-data.js loaded but holds no messages yet.', 'info'); return null; }
      return s && typeof s.addRecords === 'function' ? s.addRecords(raw, 'imap') : null;
    }).then(function (sum) {
      if (sum) toast('Live data: ' + fmtInt(sum.added) + ' added, ' + fmtInt(sum.duplicates) + ' duplicates, ' + fmtInt(sum.noise) + ' noise, ' + fmtInt(sum.needsReview) + ' need review.', 'good', { ms: 6000 });
      if (!served()) renderFileStatus();
    }).catch(function (err) {
      toast((err && err.message) || 'Could not reload live data.', 'warning', { ms: 6000 });
    }).then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Reload live data'; } });
  }

  /* ------------------------------------------------------------------ */
  /* Import + CSV mapping dialog                                          */
  /* ------------------------------------------------------------------ */

  function renderImport() {
    var sec = section('import', 'Import', 'Drop .eml, .mbox, .csv or .json files. Everything is parsed in this browser; nothing is uploaded.');
    var zone = h('div', { id: 'import-dropzone' });
    if (ui() && typeof ui().dropZone === 'function' && VOC.importers) ui().dropZone(zone, onImportFiles, { accept: '.eml,.mbox,.csv,.json', hint: 'Drop mail exports, help-desk CSVs, review CSVs, order CSVs or a VoC backup here — or click to choose files.' });
    else if (ui() && ui().emptyState) ui().emptyState(zone, { title: 'Import unavailable', text: 'The importer module did not load in this build.', icon: 'upload' });
    sec.appendChild(zone);
    sec.appendChild(h('p', { class: 'field__hint', text: 'CSV templates recognized automatically: help-desk exports (Zendesk, Freshdesk, Gorgias, HubSpot), Amazon / Trustpilot reviews, orders by month, and this site’s own records CSV. Anything else opens a column-mapping dialog.' }));
    var log = h('div', { class: 'import-log', id: 'import-log', 'aria-live': 'polite' });
    sec.appendChild(log);
    st.els.importLog = log;
    return sec;
  }

  function logImport(text, kind) {
    var log = st.els.importLog;
    if (!log) return;
    var line = h('div', { class: 'import-log__line' + (kind ? ' is-' + kind : ''), text: fmtDate(new Date().toISOString(), 'datetime') + ' — ' + text });
    log.insertBefore(line, log.firstChild);
    while (log.children.length > 8) log.removeChild(log.lastChild);
  }

  function onImportFiles(files) {
    var imp = VOC.importers, s = store();
    if (!imp || typeof imp.handleFiles !== 'function' || !s) { toast('Importer unavailable.', 'critical'); return; }
    var cfg = st.cfg || loadCfg();
    toast('Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…', 'info', { ms: 2500 });
    imp.handleFiles(files, { agentAddresses: arr(cfg.agent_addresses) }).then(function (result) {
      var items = arr(result.items).slice();
      var orders = result.ordersByMonth || null;
      var pending = arr(result.summary && result.summary.pending);
      var chain = Promise.resolve();
      pending.forEach(function (p) {
        chain = chain.then(function () {
          return openMappingDialog(p).then(function (mapping) {
            if (!mapping) { logImport(p.file + ': skipped (no mapping chosen).', 'warn'); return; }
            var mapped = imp.mapRows(p.rows, mapping);
            if (mapped && mapped.ordersByMonth) { orders = mergeOrders(orders || { _total: {} }, mapped.ordersByMonth); logImport(p.file + ': orders for ' + fmtInt(Object.keys(mapped.ordersByMonth._total || {}).length) + ' months mapped.', 'good'); return; }
            arr(mapped).forEach(function (r) { items.push(r); });
            logImport(p.file + ': ' + fmtInt(arr(mapped).length) + ' rows mapped with the ' + mapping.template + ' template.', 'good');
          });
        });
      });
      return chain.then(function () { return finishImport(items, orders, result); });
    }).catch(function (err) {
      toast('Import failed: ' + (err && err.message ? err.message : String(err)), 'critical', { ms: 8000 });
      logImport('Import failed: ' + (err && err.message ? err.message : String(err)), 'error');
    });
  }

  /**
   * Copy `base` and add `add` onto it through VOC.importers.mergeOrders (sanitized keys, finite counts, sums per month).
   * The local fallback only runs when importers.js is not loaded.
   */
  function mergeOrders(base, add) {
    var out = JSON.parse(JSON.stringify(base || { _total: {} }));
    if (VOC.importers && typeof VOC.importers.mergeOrders === 'function') return VOC.importers.mergeOrders(out, add || {});
    Object.keys(add || {}).forEach(function (pid) {
      out[pid] = out[pid] || {};
      Object.keys(add[pid] || {}).forEach(function (mo) { if (isNum(add[pid][mo])) out[pid][mo] = add[pid][mo]; });
    });
    return out;
  }
  /** Settings keys a backup may restore; redactRestricted, connector, theme and clock stay as this browser has them.
   *  Saved views live in their own localStorage key (store.savedViews), not in settings, so they are not listed here. */
  var RESTORABLE_SETTINGS = ['sla', 'agents', 'me', 'predictParams', 'reportActions'];
  function restorableSettings(src) {
    var out = {};
    var dropped = [];
    Object.keys(src || {}).forEach(function (k) {
      if (RESTORABLE_SETTINGS.indexOf(k) >= 0) out[k] = src[k]; else dropped.push(k);
    });
    return { patch: out, dropped: dropped };
  }

  function dominantSource(summary) {
    var by = (summary && summary.byType) || {};
    var best = 'json', n = -1;
    ['eml', 'mbox', 'csv', 'json'].forEach(function (k) { if ((by[k] || 0) > n) { n = by[k] || 0; best = k; } });
    return best;
  }

  function finishImport(items, orders, result) {
    var s = store();
    var summary = result.summary || {};
    var addP = items.length && typeof s.addRecords === 'function' ? s.addRecords(items, dominantSource(summary)) : Promise.resolve({ added: 0, duplicates: 0, noise: 0, needsReview: 0, nonEnglish: 0 });
    return Promise.resolve(addP).then(function (sum) {
      sum = sum || {};
      var bits = [];
      if (items.length) bits.push(fmtInt(sum.added || 0) + ' added, ' + fmtInt(sum.duplicates || 0) + ' duplicates, ' + fmtInt(sum.noise || 0) + ' noise, ' + fmtInt(sum.needsReview || 0) + ' need review, ' + fmtInt(sum.nonEnglish || 0) + ' non-English');
      if (orders && typeof s.setOrders === 'function') { s.setOrders(mergeOrders(s.orders(), orders)); bits.push('orders merged for ' + fmtInt(Object.keys(orders._total || {}).length) + ' months'); renderOrdersGrid(); }
      if (arr(result.overlays).length && typeof s.importOverlays === 'function') {
        // Restores overlays verbatim (fields, notes and their audit trail) in one pass; unknown ids are skipped.
        var res = s.importOverlays(result.overlays, { actor: 'Restore' }) || {};
        bits.push(fmtInt(res.applied || 0) + ' overlays applied' + (res.skipped ? ', ' + fmtInt(res.skipped) + ' skipped (record not in this dataset)' : '') + (res.invalidFields ? ', ' + fmtInt(res.invalidFields) + ' invalid field' + (res.invalidFields === 1 ? '' : 's') + ' dropped' : ''));
      } else if (arr(result.overlays).length && typeof s.update === 'function') {
        var applied = 0;
        result.overlays.forEach(function (ov) {
          if (!ov || !ov.id || !s.record(ov.id)) return;
          var patch = {};
          ['status', 'assignee', 'tags', 'category', 'subcategory', 'product', 'urgency', 'recovered', 'is_adverse_event', 'serious_ae'].forEach(function (k) { if (ov[k] !== undefined) patch[k] = ov[k]; });
          if (Object.keys(patch).length) { s.update(ov.id, patch, 'Restore'); applied += 1; }
          arr(ov.notes).forEach(function (n) { if (n && n.text && typeof s.addNote === 'function') s.addNote(ov.id, n.text, n.by || 'Restore'); });
        });
        bits.push(fmtInt(applied) + ' overlays applied');
      }
      if (result.settings && typeof s.setSettings === 'function') {
        var allowed = restorableSettings(result.settings);
        if (Object.keys(allowed.patch).length) s.setSettings(allowed.patch);
        bits.push('settings restored (' + (Object.keys(allowed.patch).join(', ') || 'none') + '); redaction and connector settings never come from a file' + (allowed.dropped.length ? ' — skipped ' + allowed.dropped.join(', ') : ''));
        st.cfg = loadCfg(); syncConnectorForm(); syncSimpleFields();
      }
      arr(summary.errors).forEach(function (e) { logImport(e.file + ': ' + e.message, 'error'); });
      var msg = (summary.text || 'Import finished.') + (bits.length ? ' ' + bits.join('; ') + '.' : '');
      toast(msg, summary.errors && summary.errors.length ? 'warning' : 'good', { ms: 9000 });
      logImport(msg, summary.errors && summary.errors.length ? 'warn' : 'good');
    });
  }

  /**
   * Small modal: choose a template and map CSV headers to its fields. Resolves a Mapping or null when cancelled.
   * @param {{file:string, headers:string[], rows:any[], sample:any[], fingerprint:string, suggestions:Object[]}} pending
   */
  function openMappingDialog(pending) {
    var imp = VOC.importers;
    var templates = imp && imp.TEMPLATES ? imp.TEMPLATES : {};
    var order = ['helpdesk', 'reviews', 'orders_monthly', 'records'].filter(function (t) { return templates[t]; });
    if (!order.length || typeof document === 'undefined') return Promise.resolve(null);
    return new Promise(function (resolve) {
      var root = document.getElementById('modal-root') || document.body;
      var done = false;
      function finish(v) {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        st.mappingOpen = false;
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } }

      var suggestions = {};
      arr(pending.suggestions).forEach(function (m) { if (m && m.template) suggestions[m.template] = m; });
      var best = order.slice().sort(function (a, b) { return (suggestions[b] ? -suggestions[b].missing.length : -99) - (suggestions[a] ? -suggestions[a].missing.length : -99); })[0];
      var current = best;

      var tplSel = h('select', { id: 'map-template' });
      order.forEach(function (t) { tplSel.appendChild(h('option', { value: t }, templates[t].label || t)); });
      tplSel.value = current;
      var desc = h('p', { class: 'field__hint', id: 'map-template-desc' });
      var fieldsBox = h('div', { class: 'map-fields', id: 'map-fields' });
      var remember = h('input', { type: 'checkbox', id: 'map-remember' }); remember.checked = true;
      var err = h('p', { class: 'field__error', id: 'map-error', hidden: true });
      var sample = arr(pending.sample)[0];

      function buildFields() {
        fieldsBox.innerHTML = '';
        var tpl = templates[current];
        desc.textContent = tpl.description || '';
        var sug = suggestions[current] || (imp.buildMapping ? imp.buildMapping(pending.headers, current) : null);
        Object.keys(tpl.fields).forEach(function (fname) {
          var def = tpl.fields[fname];
          var sel = h('select', { id: 'map-field-' + fname, 'data-field': fname, 'aria-label': 'Column for ' + fname });
          sel.appendChild(h('option', { value: '' }, def.required ? '— choose a column —' : '— skip —'));
          pending.headers.forEach(function (hd, i) {
            var ex = sample ? (Array.isArray(sample) ? sample[i] : sample[hd]) : '';
            var extra = ex ? ' · e.g. ' + String(ex).slice(0, 32) : '';
            sel.appendChild(h('option', { value: String(i) }, hd + extra));
          });
          var idx = sug && sug.columns ? sug.columns[fname] : null;
          if (idx !== null && idx !== undefined) sel.value = String(idx);
          fieldsBox.appendChild(h('div', { class: 'field map-field' + (def.required ? ' is-required' : '') }, [
            h('label', { class: 'label', for: sel.id, text: fname.replace(/_/g, ' ') + (def.required ? ' *' : '') }), sel
          ]));
        });
      }
      tplSel.addEventListener('change', function () { current = tplSel.value; buildFields(); err.hidden = true; });
      buildFields();

      var apply = h('button', { type: 'button', class: 'btn btn--primary', id: 'map-apply', onclick: function () {
        var tpl = templates[current], columns = {}, missing = [], used = {};
        Array.prototype.forEach.call(fieldsBox.querySelectorAll('select[data-field]'), function (sel) {
          var f = sel.getAttribute('data-field');
          var v = sel.value === '' ? null : Number(sel.value);
          if (v !== null && used[v] !== undefined) { missing.push('the same column is mapped to ' + used[v] + ' and ' + f); }
          if (v !== null) used[v] = f;
          columns[f] = v;
          if (tpl.fields[f].required && v === null) missing.push(f + ' is required');
        });
        if (missing.length) { err.textContent = 'Fix before applying: ' + missing.join('; ') + '.'; err.hidden = false; return; }
        var mapping = { template: current, headers: pending.headers.slice(), fingerprint: pending.fingerprint, columns: columns, missing: [] };
        if (remember.checked && typeof imp.rememberMapping === 'function') { try { imp.rememberMapping(pending.headers, mapping); } catch (e) { /* storage blocked */ } }
        finish(mapping);
      } }, 'Apply mapping');
      var cancel = h('button', { type: 'button', class: 'btn', id: 'map-cancel', onclick: function () { finish(null); } }, 'Skip this file');

      var modal = h('div', { class: 'modal modal--wide mapping-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'map-title', tabindex: '-1' }, [
        h('h2', { class: 'modal__title', id: 'map-title', text: 'Map the columns of ' + pending.file }),
        h('p', { class: 'modal__text', text: fmtInt(pending.headers.length) + ' columns, ' + fmtInt(arr(pending.rows).length) + ' rows. No template matched these headers, so choose one and point each field at a column.' }),
        field({ label: 'Template', input: tplSel }), desc, fieldsBox, err,
        h('label', { class: 'checkbox-row', for: 'map-remember' }, [remember, h('span', { text: 'Remember this mapping for files with the same headers' })]),
        h('div', { class: 'modal__actions' }, [cancel, apply])
      ]);
      var backdrop = h('div', { class: 'modal-backdrop', onclick: function (e) { if (e.target === backdrop) finish(null); } }, modal);
      document.addEventListener('keydown', onKey, true);
      root.appendChild(backdrop);
      st.mappingOpen = true;
      tplSel.focus();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Orders by month                                                     */
  /* ------------------------------------------------------------------ */

  function renderOrders() {
    var sec = section('orders', 'Orders by month', 'Denominator for contact rate, complaints per 1k orders, AE rate and share of voice. Edit a cell and tab away to save.');
    var tools = h('div', { class: 'row row--between' });
    var addSel = h('select', { id: 'orders-add-product', 'aria-label': 'Add a product row' });
    var addBtn = h('button', { type: 'button', class: 'btn btn--sm', id: 'orders-add-row', onclick: function () {
      var pid = addSel.value; if (!pid) return;
      var s = store(); var o = s.orders(); if (o[pid]) return;
      var next = mergeOrders(o, {}); next[pid] = {}; s.setOrders(next); renderOrdersGrid();
    } }, 'Add product row');
    var fileInput = h('input', { type: 'file', id: 'orders-import-file', accept: '.csv,text/csv', class: 'sr-only', 'aria-label': 'Import an orders CSV (month, product, orders)' });
    fileInput.addEventListener('change', function () { if (fileInput.files && fileInput.files.length) onImportFiles(fileInput.files); fileInput.value = ''; });
    tools.appendChild(h('div', { class: 'row' }, [addSel, addBtn]));
    tools.appendChild(h('div', { class: 'row' }, [h('button', { type: 'button', class: 'btn btn--sm btn--ghost', id: 'orders-import', onclick: function () { fileInput.click(); } }, 'Import orders CSV'), fileInput]));
    sec.appendChild(tools);
    var grid = h('div', { class: 'orders-grid', id: 'orders-grid' });
    sec.appendChild(grid);
    sec.appendChild(h('p', { class: 'field__hint', id: 'orders-hint', text: 'The Total row is the company-wide denominator and is edited independently of the product rows. Months without a total make every per-order metric read “—” for ranges that touch them.' }));
    st.els.ordersGrid = grid; st.els.ordersAddSel = addSel;
    renderOrdersGrid();
    return sec;
  }

  function renderOrdersGrid() {
    var grid = st.els.ordersGrid, s = store();
    if (!grid || !s || typeof s.orders !== 'function') return;
    if (isFocusedWithin(grid)) return; // never yank focus from an edit in progress
    var orders = s.orders() || { _total: {} };
    var months = [];
    var cur = monthKeyNow();
    for (var i = ORDER_MONTHS - 1; i >= 0; i--) months.push(addMonths(cur, -i));
    var productIds = Object.keys(orders).filter(function (k) { return k !== '_total'; });
    var e = VOC.enums;
    var known = e && e.PRODUCTS ? Object.keys(e.PRODUCTS) : [];
    productIds.sort(function (a, b) { var ia = known.indexOf(a), ib = known.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    var rows = ['_total'].concat(productIds);

    var table = h('table', { class: 'table orders-table' });
    var thead = h('thead'), tr = h('tr');
    tr.appendChild(h('th', { scope: 'col', text: 'Product' }));
    months.forEach(function (m) { tr.appendChild(h('th', { scope: 'col', class: 'num', text: fmtDate(m, 'month').replace(/^(\w{3})\w* (\d{4})$/, '$1 $2') })); });
    thead.appendChild(tr); table.appendChild(thead);
    var tbody = h('tbody');
    rows.forEach(function (pid) {
      var r = h('tr', { class: pid === '_total' ? 'is-total' : null });
      r.appendChild(h('th', { scope: 'row', text: pid === '_total' ? 'Total (all products)' : label('product', pid) }));
      months.forEach(function (m) {
        var v = orders[pid] && isNum(orders[pid][m]) ? orders[pid][m] : '';
        var input = h('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', id: 'orders-' + pid + '-' + m, value: v, 'aria-label': (pid === '_total' ? 'Total' : label('product', pid)) + ' orders in ' + fmtDate(m, 'month') });
        input.addEventListener('change', function () {
          var raw = input.value.trim();
          var num = raw === '' ? null : Math.max(0, Math.round(Number(raw)));
          if (raw !== '' && !isFinite(num)) { input.value = v; return; }
          var next = mergeOrders(s.orders(), {});
          next[pid] = next[pid] || {};
          if (num === null) delete next[pid][m]; else next[pid][m] = num;
          s.setOrders(next);
          input.classList.add('is-saved');
          setTimeout(function () { input.classList.remove('is-saved'); }, 900);
        });
        r.appendChild(h('td', { class: 'num' }, input));
      });
      tbody.appendChild(r);
    });
    table.appendChild(tbody);
    grid.innerHTML = '';
    grid.appendChild(h('div', { class: 'table-wrap table-wrap--flat' }, table));

    var sel = st.els.ordersAddSel;
    if (sel) {
      sel.innerHTML = '';
      sel.appendChild(h('option', { value: '' }, 'Product…'));
      known.filter(function (p) { return productIds.indexOf(p) < 0; }).forEach(function (p) { sel.appendChild(h('option', { value: p }, label('product', p))); });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Classifier tester                                                   */
  /* ------------------------------------------------------------------ */

  function renderTester() {
    var sec = section('tester', 'Classifier tester', 'Paste an email and see every pipeline stage: preprocess, noise, language, sentiment, category, product, safety, urgency, entities, flags.');
    var cls = VOC.classify;
    if (!cls || typeof cls.explain !== 'function') {
      var box = h('div');
      if (ui() && ui().emptyState) ui().emptyState(box, { title: 'Classifier not loaded', text: 'js/classify.js (and js/rules.js) are not part of this build yet, so the tester has nothing to run. Imports still work; records are marked “needs review” until the pipeline arrives.', icon: 'build', kind: 'progress' });
      sec.appendChild(box);
      return sec;
    }
    var subject = h('input', { type: 'text', id: 'tester-subject', placeholder: 'Subject, e.g. Charged twice for my ProLon subscription', autocomplete: 'off' });
    var text = h('textarea', { id: 'tester-text', rows: '6', placeholder: 'Paste the email body here…' });
    var run = h('button', { type: 'button', class: 'btn btn--primary', id: 'tester-run' }, 'Explain');
    var out = h('div', { class: 'tester-output', id: 'tester-output', 'aria-live': 'polite' });
    sec.appendChild(field({ label: 'Subject', input: subject }));
    sec.appendChild(field({ label: 'Body', input: text }));
    sec.appendChild(h('div', { class: 'row' }, run));
    sec.appendChild(out);
    run.addEventListener('click', function () {
      var body = text.value.trim();
      if (!body && !subject.value.trim()) { toast('Paste some text first.', 'warning'); return; }
      var res = null;
      try { res = cls.explain(body, subject.value.trim()); } catch (e) { res = { error: e && e.message ? e.message : String(e) }; }
      out.innerHTML = '';
      if (!res || res.error || !arr(res.stages).length) {
        out.appendChild(h('p', { class: 'field__error', text: 'The classifier returned no stages' + (res && res.error ? ': ' + res.error : '.') }));
        return;
      }
      var table = h('table', { class: 'table tester-table' });
      table.appendChild(h('thead', {}, h('tr', {}, [h('th', { scope: 'col', text: 'Stage' }), h('th', { scope: 'col', text: 'Output' })])));
      var tbody = h('tbody');
      res.stages.forEach(function (stg) {
        var val = stg.output;
        var pretty = typeof val === 'string' ? val : JSON.stringify(val, function (k, v) { return v instanceof RegExp ? String(v) : v; }, 2);
        tbody.appendChild(h('tr', {}, [h('th', { scope: 'row', class: 'tester-stage__name', text: stg.name || '' }), h('td', { class: 'wrap' }, h('pre', { text: pretty == null ? '—' : pretty }))]));
      });
      table.appendChild(tbody);
      out.appendChild(h('div', { class: 'table-wrap table-wrap--flat' }, table));
    });
    return sec;
  }

  /* ------------------------------------------------------------------ */
  /* Danger zone                                                         */
  /* ------------------------------------------------------------------ */

  function renderDanger() {
    var sec = section('danger', 'Danger zone', 'Irreversible actions.');
    sec.classList.add('settings-section--danger');
    var s = store();
    var btn = h('button', { type: 'button', class: 'btn btn--danger', id: 'reset-demo', onclick: function () {
      var p = ui() && typeof ui().confirm === 'function'
        ? ui().confirm({ title: 'Reset to demo data?', text: 'Removes every imported record, all status / assignee / tag / note overlays, saved views, alert acknowledgements and these settings, then reloads the page with the seeded dataset. Export a backup first if you want to keep anything.', confirmLabel: 'Reset everything', danger: true })
        : Promise.resolve(window.confirm('Reset to demo data? This removes imported records, overlays and settings.'));
      p.then(function (ok) {
        if (!ok) return;
        btn.disabled = true; btn.textContent = 'Resetting…';
        var chain = s && typeof s.resetDemo === 'function' ? s.resetDemo() : Promise.resolve();
        return Promise.resolve(chain).then(function () {
          if (VOC.alerts && typeof VOC.alerts.reset === 'function') { try { VOC.alerts.reset(); } catch (e) { /* ignore */ } }
          if (VOC.importers && typeof VOC.importers.forgetMappings === 'function') { try { VOC.importers.forgetMappings(); } catch (e2) { /* ignore */ } }
          toast('Demo data restored. Reloading…', 'good', { ms: 2000 });
          setTimeout(function () { try { window.location.reload(); } catch (e3) { /* ignore */ } }, 400);
        }).catch(function (err) {
          btn.disabled = false; btn.textContent = 'Reset to demo data';
          toast('Reset failed: ' + (err && err.message ? err.message : String(err)), 'critical');
        });
      });
    } }, 'Reset to demo data');
    sec.appendChild(h('div', { class: 'row row--between danger-row' }, [
      h('p', { class: 'text-2', text: 'Return to the seeded 12-month dataset: imported records, overlays, saved views, alert state and settings in this browser are removed.' }), btn
    ]));
    return sec;
  }

  /* ------------------------------------------------------------------ */
  /* Sync helpers for update()                                           */
  /* ------------------------------------------------------------------ */

  function syncSimpleFields() {
    var s = settingsOf();
    if (st.els.clockGroup && !isFocusedWithin(st.els.clockGroup)) { var r = st.els.clockGroup.querySelector('#clock-' + (s.clock || 'demo')); if (r) r.checked = true; }
    if (st.els.themeGroup && !isFocusedWithin(st.els.themeGroup)) { var t = st.els.themeGroup.querySelector('#theme-' + (s.theme || 'system')); if (t) t.checked = true; }
    if (st.els.slaGrid && !isFocusedWithin(st.els.slaGrid)) URGENCIES.forEach(function (u) { var i = st.els.slaGrid.querySelector('#sla-' + u); if (i && s.sla && isNum(s.sla[u])) i.value = s.sla[u]; });
    if (st.els.meInput && document.activeElement !== st.els.meInput) st.els.meInput.value = s.me || 'You';
    if (st.els.clockExpl) st.els.clockExpl.textContent = clockExplanation();
    renderAgentList();
  }

  /* ------------------------------------------------------------------ */
  /* View contract                                                       */
  /* ------------------------------------------------------------------ */

  var NAV = [['clock', 'Clock'], ['theme', 'Theme'], ['sla', 'SLA hours'], ['agents', 'Agents'], ['connector', 'Connector'], ['import', 'Import'], ['orders', 'Orders'], ['tester', 'Classifier'], ['danger', 'Danger zone']];

  VOC.views[NAME] = {
    title: TITLE,
    icon: NAME,
    /**
     * @param {HTMLElement} root
     * @param {Object|null} derived  VOC.store.derived()
     */
    mount: function (root, derived) {
      st.root = root; st.derived = derived || null; st.els = {};
      root.innerHTML = '';
      st.els.header = ui() && typeof ui().viewHeader === 'function'
        ? ui().viewHeader({ title: TITLE, meta: subtitle(derived), lead: leadText(derived) })
        : h('header', { class: 'view-header' }, [h('h1', { class: 'view-title', text: TITLE }), h('p', { class: 'view-meta', 'data-role': 'subtitle', text: subtitle(derived) })]);
      root.appendChild(st.els.header);
      var layout = h('div', { class: 'settings-layout' });
      var nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' });
      NAV.forEach(function (n) {
        nav.appendChild(h('a', { href: '#settings-' + n[0], id: 'settings-nav-' + n[0], onclick: function (e) {
          e.preventDefault();
          var target = document.getElementById('settings-' + n[0]);
          if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.focus({ preventScroll: true }); }
        } }, n[1]));
      });
      var sections = h('div', { class: 'settings-sections' });
      [renderClock, renderTheme, renderSla, renderAgents, renderConnector, renderImport, renderOrders, renderTester, renderDanger].forEach(function (fn) {
        try { var sec = fn(); sec.setAttribute('tabindex', '-1'); sections.appendChild(sec); }
        catch (e) {
          var card = h('section', { class: 'card settings-section' });
          if (ui() && ui().emptyState) ui().emptyState(card, { title: 'This section failed to render', text: e && e.message ? e.message : String(e) });
          sections.appendChild(card);
          if (typeof console !== 'undefined') console.error('Settings section failed:', e);
        }
      });
      layout.appendChild(nav); layout.appendChild(sections);
      root.appendChild(layout);

      /* live status while mounted */
      var c = conn();
      if (served() && c) {
        st.statusTimer = setInterval(refreshStatus, STATUS_POLL_MS);
        if (typeof c.on === 'function') { st.pollHandler = function () { refreshStatus(); }; c.on('poll', st.pollHandler); }
      }
      var s = store();
      if (s && typeof s.on === 'function') {
        var onSettings = function () { if (st.root) { syncSimpleFields(); setHeader(st.derived); } };
        var onClock = function () { if (st.els.clockExpl) st.els.clockExpl.textContent = clockExplanation(); setHeader(st.derived); };
        s.on('settings:changed', onSettings); s.on('clock:changed', onClock);
        st.storeHandlers = [['settings:changed', onSettings], ['clock:changed', onClock]];
      }
    },
    /** @param {Object|null} derived */
    update: function (derived) {
      st.derived = derived || st.derived;
      if (!st.root) return;
      setHeader(derived);
      if (st.els.clockExpl) st.els.clockExpl.textContent = clockExplanation();
      renderOrdersGrid();
      if (!served()) renderFileStatus();
    },
    unmount: function () {
      if (st.statusTimer) { clearInterval(st.statusTimer); st.statusTimer = null; }
      var c = conn();
      if (c && st.pollHandler && typeof c.off === 'function') c.off('poll', st.pollHandler);
      st.pollHandler = null;
      var s = store();
      if (s && typeof s.off === 'function') st.storeHandlers.forEach(function (p) { s.off(p[0], p[1]); });
      st.storeHandlers = [];
      st.root = null; st.els = {}; st.cfg = null;
    }
  };
})();
