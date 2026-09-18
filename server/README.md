# L-Nutra VoC sidecar (`server/voc_server.py`)

A zero-dependency Python 3.9 process that does two things:

1. **Serves the site** at `http://127.0.0.1:8765/` so the browser and the API share one origin.
2. **Polls an IMAP mailbox read-only**, turns each message into a clean `RawEmail`, drops auto-replies, bounces and newsletters, dedupes by `Message-ID`, redacts restricted (PHI-adjacent) mail on the server, and stores everything as JSON under a data directory. The served page pulls records through `/api/records` with the token; set `live_data_plaintext` to true and the sidecar also writes them into `js/live-data.js` so the site works from `file://`.

It never marks a message read, never moves or deletes mail, and never stores a password.

Contents: [Quick start](#quick-start) · [Gmail](#gmail-and-google-workspace) · [Yahoo / iCloud](#yahoo-and-icloud) · [Microsoft 365 / Outlook.com](#microsoft-365-and-outlookcom-roadmap) · [Storing the secret](#storing-the-mailbox-secret) · [Running](#running-the-server) · [Connecting the site](#connecting-the-site) · [file:// fallback](#file-fallback-live-datajs) · [iCloud Drive hazard](#the-icloud-drive-hazard) · [Security posture](#security-posture) · [API](#api) · [Troubleshooting](#troubleshooting) · [Tests](#tests)

## Quick start

```bash
cd "/path/to/VoC"
cp server/config.example.json server/config.json      # edit username, folder, since
security add-generic-password -s voc-mail -a support@l-nutra.com -w   # paste the app password when prompted
python3 server/voc_server.py
```

The server prints something like:

```
L-Nutra VoC sidecar 1.0.0
TOKEN    = 3kQ9…
URL      = http://127.0.0.1:8765/
MODE     = imap
SITE     = /path/to/VoC
DATA_DIR = /Users/you/Library/Application Support/voc
Paste the token into Settings > Connector. Ctrl-C stops the server.
```

Open the URL, go to **Settings › Connector**, paste the token, click **Save config** (or **Sync now**). The status panel shows the mailbox, last sync, UID position and counts. Once the token is in place the browser pulls new records from `/api/records` on its own, every `poll_interval_s` seconds (the sidecar reports the interval on `/api/health`); Settings shows it as *Browser polling: on*.

To serve the site without touching any mailbox: `python3 server/voc_server.py --no-poll`. In that mode **Sync now** answers `{ok:false, reason:"no mailbox configured"}` and nothing opens an IMAP connection.

To open the site from disk (`file://`) with live mail, set `"live_data_plaintext": true` in `server/config.json` (see [file:// fallback](#file-fallback-live-datajs)); by default records never leave the data directory.

## Gmail and Google Workspace

Gmail accepts IMAP logins only with an **App Password**, and App Passwords exist only when **2-Step Verification** is on.

1. Turn on 2-Step Verification: <https://myaccount.google.com/security>.
2. Create an App Password: <https://myaccount.google.com/apppasswords> (name it `VoC sidecar`). Google shows a 16-character password once; copy it without spaces.
3. Make sure IMAP is enabled: Gmail › Settings › *See all settings* › *Forwarding and POP/IMAP* › *Enable IMAP*. Google Workspace admins may need to allow IMAP for the organizational unit.
4. Config values:

| Field | Value |
|---|---|
| `provider_preset` | `gmail` (or `google_workspace`) |
| `host` / `port` | `imap.gmail.com` / `993` |
| `username` | the full address, e.g. `support@l-nutra.com` |
| `folder` | `INBOX`, or a **label** name such as `VoC` or `Support/Reviews` (labels appear as folders over IMAP) |
| `sent_folder` | `[Gmail]/Sent Mail` (leave empty to skip outbound mail) |

Tips:

- A Gmail filter that applies a label like `VoC` to customer mail, plus `folder: "VoC"`, keeps newsletters and internal mail out of the dataset entirely.
- Gmail's IMAP `SINCE` uses the server's date; set `since` a day earlier than you need.
- Google shows `[ALERT] Application-specific password required` when 2-Step Verification is on but you used the account password, and `[AUTHENTICATIONFAILED] Invalid credentials` when the App Password has spaces or was revoked.

## Yahoo and iCloud

Both require an app-specific password; the account password never works over IMAP.

**Yahoo Mail**: Account Security › *Generate app password* (<https://login.yahoo.com/account/security>). Host `imap.mail.yahoo.com`, port `993`, `sent_folder` is `Sent`. Preset `yahoo`.

**iCloud Mail**: <https://appleid.apple.com> › Sign-In and Security › *App-Specific Passwords*. Host `imap.mail.me.com`, port `993`, `username` is the full iCloud address (or a custom-domain alias), `sent_folder` is `Sent Messages`. Preset `icloud`. Two-factor authentication must be on for the Apple ID.

Store the generated password exactly as shown (Yahoo's has no spaces; Apple's is four groups of four with hyphens and the hyphens are part of it).

## Microsoft 365 and Outlook.com (roadmap)

Microsoft disabled basic (username + password) authentication for IMAP on Exchange Online in 2022–2023 and is removing it for consumer Outlook.com as well. An app password does not help: Exchange Online rejects the IMAP `LOGIN` command outright. The `microsoft365` preset therefore exists only so Settings can show the right host (`outlook.office365.com:993`, `sent_folder` `Sent Items`); `connect()` raises `NotImplementedError` when `auth` is `xoauth2`.

What a working connector needs, in order:

1. **An app registration** in Entra ID (Azure AD) with the delegated permission `IMAP.AccessAsUser.All` (or `https://outlook.office365.com/IMAP.AccessAsUser.All`) plus `offline_access`, and an admin who grants consent. For a shared mailbox such as `support@`, the signed-in user needs *Full Access* to it.
2. **A device-code flow**: the sidecar calls `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/devicecode`, prints a URL and a short code, the operator signs in once in a browser, and the sidecar polls the token endpoint until it receives an **access token** (about an hour) and a **refresh token** (up to 90 days of inactivity). Both belong in the Keychain, not in `config.json`.
3. **Token refresh** before every poll (`grant_type=refresh_token`), and re-running the device-code flow when the refresh token expires or the tenant's conditional-access policy revokes it.
4. **SASL XOAUTH2** on the IMAP connection:

   ```python
   conn.authenticate('XOAUTH2', lambda _: 'user=%s\x01auth=Bearer %s\x01\x01' % (user, access_token))
   ```

   `imaplib` sends the string base64-encoded; Exchange returns `AUTHENTICATE failed` when the scope or the mailbox permission is wrong.
5. **Alternative**: skip IMAP and read mail through **Microsoft Graph** (`GET /users/{mailbox}/mailFolders/{id}/messages?$select=...`) with the application permission `Mail.Read` restricted by an *application access policy* to the support mailbox. Graph returns JSON, so the `normalize()` step would consume `body.content` and `internetMessageHeaders` instead of RFC 822 bytes; everything downstream (noise, filters, redaction, store) stays the same.

Until then, the practical path for Microsoft-hosted support mail is a **forwarding rule or Power Automate flow** that posts each message to `POST /api/ingest` (see API), or a periodic `.eml`/`.mbox` export dropped onto the site's import zone.

## Storing the mailbox secret

The server reads the secret from, in order:

1. the environment variable `VOC_MAIL_SECRET`;
2. the macOS Keychain item with service **`voc-mail`**: it tries `security find-generic-password -s voc-mail -a <username> -w` first, then the same without `-a`.

**Keychain (recommended)**

```bash
security add-generic-password -s voc-mail -a support@l-nutra.com -w        # prompts for the password, hides input
security find-generic-password -s voc-mail -a support@l-nutra.com -w        # verify (prints it)
security delete-generic-password -s voc-mail -a support@l-nutra.com         # rotate: delete, then add again
```

The first lookup from a new terminal may show a Keychain prompt; click **Always Allow** for `security`.

**`.env` file (alternative)**

```bash
umask 077
printf 'VOC_MAIL_SECRET=%s\n' 'abcd efgh ijkl mnop' > ~/.voc.env     # Gmail: paste without spaces
chmod 600 ~/.voc.env
set -a; source ~/.voc.env; set +a
python3 server/voc_server.py
```

Keep the `.env` outside the project folder (the project may live in iCloud Drive and may end up in a zip you send to someone). Never put the password in `config.json`; the server rejects any config key whose name contains `password`, `secret` or `token`.

## Running the server

```
python3 server/voc_server.py [--site-dir DIR] [--port 8765] [--data-dir DIR] [--config server/config.json]
                             [--once] [--no-poll] [--token TOKEN] [--verbose]
```

| Flag | Meaning |
|---|---|
| `--site-dir` | folder with `index.html` (default: the parent of `server/`) |
| `--port` | port on `127.0.0.1` (default `8765`); the server never binds another interface |
| `--data-dir` | where `records.json`, `state.json` and `reports/` live (default: `data_dir` from config, else `~/Library/Application Support/voc`) |
| `--config` | connector config JSON (default `server/config.json`; defaults apply when absent) |
| `--once` | poll once, save, rewrite `js/live-data.js` (records only with `live_data_plaintext`), print a JSON summary and exit — good for `cron`/`launchd` |
| `--no-poll` | serve the site and API only; the mailbox is never opened, and `POST /api/sync` answers `200 {ok:false, reason}` instead of connecting |
| `--token` | fixed API token (else `$VOC_API_TOKEN`, else a fresh random token each start) |
| `--verbose` | debug logging with one line per HTTP request |

Logs go to **stderr** with timestamps; the token, URL, mode and data directory go to **stdout**.

**Modes.** `imap` = a poller thread is running. `idle` = serving only, because of `--no-poll`, an empty `username`, a missing secret, or `auth` not being `password`. `/api/status.last_error` explains which.

**Polling.** Every `poll_interval_s` (60–900 s) the poller logs in, `SELECT`s the folder read-only, runs `UID SEARCH UID <last+1>:*` (first pass: `SINCE <since>` or `ALL`), fetches at most `max_per_poll` messages with `UID FETCH (UID INTERNALDATE BODY.PEEK[])`, then the optional `sent_folder` with `direction: "outbound"`. UID positions and `UIDVALIDITY` persist in `state.json`; when a server changes `UIDVALIDITY` the folder is re-scanned from `since`. Errors back off exponentially (doubling from the interval, capped at 30 minutes) and surface as `last_error`.

**Run it in the background** with a `launchd` agent (`~/Library/LaunchAgents/com.l-nutra.voc.plist`) that runs `python3 …/voc_server.py --token "$(cat ~/.voc-token)"`, or with `--once` on a schedule when you only need `live-data.js` refreshed.

## Connecting the site

1. Open `http://127.0.0.1:8765/` (not the `file://` copy). The header dot turns from **File mode** to **Sidecar** once `/api/health` answers.
2. **Settings › Connector**: paste the printed **token**. The page stores it in the browser only and sends it as the `X-VoC-Token` header. From then on the connector polls `/api/records` on its own (pages of 500, following `has_more` for up to 10 pages per poll) and merges new mail into the browser store; a failed health check pauses the polling, the next healthy one resumes it.
3. Fill the connector form (provider preset, host, port, username, folder, sent folder, poll interval, since, filters, restricted recipients) and **Save config**. The server writes `server/config.json` and restarts the poller with the new values.
4. **Sync now** runs one poll immediately and shows fetched / added / duplicates / noise counts.

The page never asks for the mailbox password; that lives only in the Keychain or the environment of the server process.

## file:// fallback (`live-data.js`)

After every successful poll (and every `/api/ingest`) the server rewrites `<site>/js/live-data.js` atomically. What it holds depends on `live_data_plaintext` in the config:

| `live_data_plaintext` | Content of `js/live-data.js` | Use |
|---|---|---|
| `false` (default) | `window.VOC_LIVE = window.VOC_LIVE || [];` — no records | The served page pulls records through `/api/records` with the token. Nothing customer-identifying is written into the project folder (which usually sits in iCloud Drive). |
| `true` | `window.VOC_LIVE = [ /* every stored RawEmail */ ];` | Opening `index.html` from disk (`file://`) shows live mail as of the last poll; a laptop that runs `--once` from `cron` can feed a site opened from a shared folder. |

Flipping the flag through **Save config** rewrites the file at once, so turning it off scrubs the records from the project folder without waiting for the next poll.

`index.html` loads the file with `onerror` tolerated. Before the first poll the file does not exist; when the site is served by the sidecar, `GET /js/live-data.js` then answers `200` with the empty set (`text/javascript`) so served mode starts with a clean console instead of a 404. Press **Reload live data** in Settings to re-insert the script with a cache-busting query and merge anything new without reloading the page (with the default setting it reports that the file holds no messages; the records are already arriving through the API).

**Who may read `js/live-data.js` from the sidecar.** With the flag on, the file is the whole mailbox export, so the server treats it as data rather than site code: `GET`/`HEAD /js/live-data.js` is served only to the page itself (the browser's `Sec-Fetch-Site: same-origin` or `none` header, or a `Referer`/`Origin` naming this host) or to a request carrying the API token; any other request — in particular another web page's `<script src="http://127.0.0.1:8765/js/live-data.js">` — gets `403`. The rest of the site stays public on loopback because it holds no customer data. The token is never put into a URL.

## The iCloud Drive hazard

This project folder is typically inside `~/Library/Mobile Documents/com~apple~CloudDocs/…`, that is, **iCloud Drive**. Do not put `records.json` there:

- iCloud can **evict** files to free space and replace them with placeholders; a poll would then read an empty store and re-fetch or, worse, write over a half-downloaded file.
- Two Macs syncing the same folder produce **conflicted copies** of a file that changes every two minutes.
- Mail bodies are customer data; iCloud Drive replicates them to every signed-in device.

That is why `data_dir` defaults to `~/Library/Application Support/voc/` (outside iCloud Drive) and why the server warns when the chosen `data_dir` contains `Mobile Documents` or `iCloud`. `js/live-data.js` is the one file written inside the project; it is regenerated on every poll, safe to lose, and holds records only when you opt in with `live_data_plaintext` (so by default no mail body syncs through iCloud). The per-install pseudonym key (`<data_dir>/salt`, `0600`) also stays outside the project folder.

## Security posture

- **Loopback only.** The server binds `127.0.0.1`; there is no flag to bind elsewhere. Put it behind an SSH tunnel if another machine needs it.
- **Token on every API call** except `GET /api/health`. Compared in constant time; a new random token per start unless you pass one. `401` for missing or wrong tokens.
- **No secrets in config.** `config.json` is validated on load and on `POST /api/config`; any key named like a secret is rejected with `400`. String fields (folder names, host, username, regexes, list entries) must not contain control characters (`0x00–0x1f`, `0x7f`): a CR/LF inside a folder name would otherwise be spliced into the IMAP command stream and could turn the read-only session into `STORE`/`EXPUNGE` commands. Non-ASCII folder names are sent as RFC 3501 modified UTF-7. The file is written `0600`.
- **Read-only mailbox access.** `SELECT … readonly`, `BODY.PEEK[]`; the server never sets `\Seen`, never moves, flags or deletes. Under `--no-poll` no code path opens IMAP: `POST /api/sync` answers `200 {ok:false, reason:"no mailbox configured", detail:"--no-poll …"}`.
- **Server-side redaction.** Mail to `restricted_recipients` (default `Med.Ed@l-nutra.com`) or matching `restricted_domains` is stored, when `redact_restricted_on_server` is true (default), with: body and subject replaced by markers; sender name `Redacted`, address removed, a 16-hex `from_hash` kept for grouping; every `to`/`cc` address that is not company-owned (the mailbox, `agent_addresses`, `restricted_recipients`) replaced by `<hash>@redacted.invalid`; `message_id`, `in_reply_to`, `references` and `thread_id` replaced by keyed hashes so threads still link; attachment names and MIME types blanked (sizes kept). All hashes are HMAC-SHA256 under a per-install random key stored `0600` at `<data_dir>/salt`, so a known address cannot be confirmed from a stored hash without that file. Client-side redaction in the browser is a display convenience, not access control; keep L-Nutra Health / Med.Ed mail in a separate mailbox or leave server-side redaction on. HIPAA likely applies to L-Nutra Health patient mail; EU/UK senders imply GDPR handling.
- **Same origin, no CORS.** The site is served by the same process, so no `Access-Control-Allow-*` headers exist; `OPTIONS` answers `204` harmlessly. Static responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **Static files.** The request path is percent-decoded and normalized before the deny rules run, so `/./server/config.json`, `/%73erver/config.json` and `/js/../server/config.json` all answer `404` like `/server/config.json`; every dot-file and dot-folder (`.claude/`, `.git`, `.DS_Store`) is `404` too, and no directory is listable (`/js/` answers `404`, `/` still serves `index.html`). `js/live-data.js` is gated as described above.
- **Bounded, typed input.** Request bodies over 25 MB (2 MB for `/api/ingest`) are rejected; JSON nested too deeply, wrongly typed fields (a numeric `from_email`, a list where a header string belongs, an infinite attachment size) and non-object bodies answer `400` with a JSON error instead of dropping the connection, so a misconfigured webhook sees the problem rather than retrying forever. Report filenames are reduced to `[A-Za-z0-9._-]` and always land under `data_dir/reports/`.
- Records files are written `0600` via temp file + `os.replace`, so a crash never leaves a truncated JSON.

## API

All endpoints return JSON. Everything except `/api/health` needs the header `X-VoC-Token: <token>` (or `Authorization: Bearer <token>`).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ok, version, mode:'imap'\|'idle', last_sync_at, uptime_s, records, poll_interval_s, live_data_plaintext}` — no token. The browser paces its own `/api/records` polling with `poll_interval_s`. |
| GET | `/api/status` | `{connected, provider, mailbox, host, folder, sent_folder, last_sync_at, uidvalidity, last_uid, counts:{fetched, deduped, noise, filtered}, last_error, next_poll_in_s, polling, mode, total_records, data_dir, live_data_plaintext, server_time}` |
| GET | `/api/records?since=ISO&limit=500` | `{records: RawEmail[], next_since, total, has_more, server_time}` oldest first. Pass `next_since` back as `since` to page; it has the form `<iso>\|<id>` so records sharing a timestamp are never skipped or repeated. A plain ISO `since` returns records with `date >= since`. |
| GET | `/api/config` | the validated config (never secrets) |
| POST | `/api/config` | body = partial or full config; merged over the current one, validated, saved to `--config`, poller restarted, `js/live-data.js` rewritten → `{ok, config, mode, status}`; `400` with a message on validation errors (secret-like keys, control characters, bad ranges) |
| POST | `/api/sync` | one poll now → `{ok:true, fetched, added, duplicates, noise, filtered, duration_ms}`; `200 {ok:false, reason:'no mailbox configured', detail, mode}` under `--no-poll` or without a `username`/`host`; `409` for other config problems (for example no secret), `501` for `xoauth2`, `502` with the IMAP error text |
| POST | `/api/ingest` | one RawEmail-like object (`message_id, date, from_email, from_name, to[], cc[], subject, text` or `html`, `headers{}`, `attachments[]`, `direction`) → `{ok, id, duplicate}`; noise and filtered mail answer `{ok, skipped: reason}`; a body that is not an object, a non-string `text`/`html`/`date` or an unparsable date answers `400`. Built for Zapier / Make / Power Automate webhooks. |
| POST | `/api/report` | `{filename, html}` → `{ok, path}` saved under `data_dir/reports/` |

Unknown `/api/*` paths answer `404`; wrong verbs answer `405`.

`curl` examples:

```bash
curl -s http://127.0.0.1:8765/api/health
curl -s -H "X-VoC-Token: $TOKEN" http://127.0.0.1:8765/api/status
curl -s -H "X-VoC-Token: $TOKEN" "http://127.0.0.1:8765/api/records?since=2026-09-01T00:00:00Z&limit=200"
curl -s -X POST -H "X-VoC-Token: $TOKEN" http://127.0.0.1:8765/api/sync
curl -s -X POST -H "X-VoC-Token: $TOKEN" -H 'Content-Type: application/json' \
     -d '{"message_id":"<x1@zap>","from_email":"jo@example.com","subject":"Charged twice","text":"I was charged twice.","date":"2026-09-10T12:00:00Z"}' \
     http://127.0.0.1:8765/api/ingest
```

### Record shape

Each stored record is the SPEC §2 `RawEmail` (`message_id, thread_id, in_reply_to, references[], date, from_name, from_email, to[], cc[], subject, text, html (always null; text is already derived), direction, attachments[{name,type,size}], headers{auto_submitted, precedence, list_id, list_unsubscribe, content_type, x_autoreply}, source`) plus: `id` (`em_<hex16>` from the Message-ID), `schema_version`, `is_noise`, `noise_reason`, `restricted`, `redacted`, `from_hash` (redacted records only), `uid`, `folder`, `ingested_at`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `MODE = idle` right after start | No `username` in config, no secret found, or `--no-poll`. `GET /api/status` → `last_error` says which. |
| `IMAP login failed … [ALERT] Application-specific password required` | Gmail: you used the account password. Create an App Password (needs 2-Step Verification). |
| `[AUTHENTICATIONFAILED] Invalid credentials` | Wrong or revoked app password, spaces pasted into a Gmail App Password, or IMAP disabled in Gmail settings. Re-add the Keychain item. |
| `LOGIN failed` on `outlook.office365.com` | Basic auth is disabled by Microsoft. See the Microsoft 365 section; use `/api/ingest` or `.eml` export meanwhile. |
| `cannot select folder '…'` | Folder or label name mismatch. Gmail system folders are `[Gmail]/Sent Mail`, `[Gmail]/All Mail`; nested labels use `/`. Non-ASCII folder names are not supported; rename the label to ASCII. |
| `ssl.SSLCertVerificationError` | Corporate proxy or wrong host. Use the provider's real IMAP host; the server uses the system trust store. |
| `socket.timeout` / `Connection refused` | Port 993 blocked by the network or a VPN. Test with `openssl s_client -connect imap.gmail.com:993`. |
| Nothing new arrives although mail exists | `since` is later than the mail; `max_per_poll` is small (the backlog drains one batch per poll); the mail hit `sender_allow`/`sender_deny`/`subject_*` filters (`counts.filtered`); or it was classed as noise (`counts.noise`). Set `skip_autoreplies` to false temporarily to see noise records. |
| The same messages appear twice | Different `Message-ID`s (some forwarders rewrite them). The browser also dedupes by content fingerprint. |
| `UIDVALIDITY changed … re-scanning` in the log | The mail server rebuilt the folder; the poller re-reads from `since` and dedupes by Message-ID, so nothing duplicates. |
| `401 missing or invalid X-VoC-Token` in the browser | The token changed at restart. Copy the new one from the terminal into Settings, or start with `--token`/`VOC_API_TOKEN` to keep it stable. |
| `Address already in use` | Another sidecar is running. `lsof -i :8765`, stop it, or pass `--port 8766`. |
| `data_dir is inside iCloud Drive` warning | Pass `--data-dir` or fix `data_dir` in config. See the hazard section. |
| The Keychain prompt appears every poll | Click **Always Allow** on the prompt, or use `VOC_MAIL_SECRET`. |
| `live-data.js` is stale or empty when opening from `file://` | With the default `live_data_plaintext: false` the file holds no records; set it to `true` and **Save config** (or restart). The server then rewrites it after every successful poll; run `--once` or **Sync now**, then **Reload live data**. |
| `403 live-data.js is served only to the site itself or with the API token` | Something other than the served page requested `js/live-data.js` (a `curl` without the token, another page's script tag, or a browser that sends neither `Sec-Fetch-Site` nor `Referer`). Use the page, or pass `X-VoC-Token`. |
| Records arrive on the server (`/api/status` counts grow) but not in the browser | The token is missing in Settings (browser polling starts only with a token), or the sidecar's `/api/health` is failing (the header dot is red; polling pauses until it answers). |

Run with `--verbose` for one log line per HTTP request and IMAP step.

## Tests

```bash
cd "/path/to/VoC"
python3 -m py_compile server/voc_server.py
python3 -m unittest server/test_voc_server.py
```

The suite covers `strip_quotes` on the three quote shapes plus `>` lines and signatures, `normalize` on an inline multipart message with quoted-printable, an RFC 2047 subject and an attachment (and the files in `samples/` when present), `is_noise` on auto-reply / bounce / newsletter / normal, sender and subject filters, restricted-mail redaction (subject, to/cc pseudonyms, message ids, attachments, salted hashes), config validation (secrets and control characters rejected, modified UTF-7 folder names), `Store.upsert` dedupe and `since` pagination, `live-data.js` output under both `live_data_plaintext` settings, and the HTTP API on an in-process `ThreadingHTTPServer` bound to an ephemeral port: health without a token, 401 on the rest, ingest with a duplicate and with malformed payloads (400, never a dropped connection), config round trip, `/api/sync` under `--no-poll` never opening IMAP, report saving with filename sanitizing, static MIME types, encoded and dot-segment paths to `server/` and dot-files (404), no directory listings, the `js/live-data.js` gate (403 cross-origin, 200 same-origin or with the token), 404 / 405 / OPTIONS.
