#!/usr/bin/env python3
"""L-Nutra Voice of the Customer sidecar (SPEC section 9).

Python 3.9 standard library only. The sidecar:

* serves the static site directory on http://127.0.0.1:8765/ (same origin, no CORS);
* polls an IMAP mailbox read-only (BODY.PEEK, never sets \\Seen), normalizes every
  message into the RawEmail shape of SPEC section 2, drops auto-replies, bounces and
  newsletters, dedupes by Message-ID and redacts restricted (PHI-adjacent) mail;
* stores records as JSON under the data directory (outside iCloud Drive by default)
  and rewrites <site>/js/live-data.js atomically: an empty set by default (the served page
  pulls records through /api/records), the full record list when ``live_data_plaintext``
  is true so the site also works from file://;
* exposes the /api/* endpoints of SPEC section 9 behind a per-run token.

Run ``python3 server/voc_server.py --help`` for flags. Logs go to stderr; the token,
URL, mode and data directory print to stdout at startup.
"""

import argparse
import base64
import email
import email.header
import email.policy
import hashlib
import hmac
import html as html_lib
import imaplib
import json
import logging
import os
import posixpath
import re
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from email.utils import getaddresses, parseaddr, parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

VERSION = '1.0.0'
SCHEMA_VERSION = 1
DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 8765
DEFAULT_DATA_DIR = os.path.expanduser('~/Library/Application Support/voc')
KEYCHAIN_SERVICE = 'voc-mail'
TEXT_LIMIT = 200_000            # characters kept per body
MAX_BODY_BYTES = 25 * 1024 * 1024
MAX_BACKOFF_S = 1800
FETCH_BATCH = 40
REDACTED_TEXT = '[restricted \u2014 redacted on server]'
REDACTED_SUBJECT = '[restricted \u2014 subject redacted on server]'
REDACTED_DOMAIN = 'redacted.invalid'   # pseudonymized to/cc addresses end in this reserved TLD
SALT_FILENAME = 'salt'                 # per-install pseudonym key, written 0600 under data_dir
INGEST_MAX_BYTES = 2 * 1024 * 1024     # /api/ingest carries one message; reports may be larger
LIVE_JS_EMPTY = 'window.VOC_LIVE = window.VOC_LIVE || [];\n'
CONTROL_CHAR_RE = re.compile(r'[\x00-\x1f\x7f]')
SECRET_KEY_RE = re.compile(r'password|secret|token|passwd', re.I)

log = logging.getLogger('voc')

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROVIDER_PRESETS = {
    'gmail': {'host': 'imap.gmail.com', 'port': 993, 'folder': 'INBOX', 'sent_folder': '[Gmail]/Sent Mail'},
    'google_workspace': {'host': 'imap.gmail.com', 'port': 993, 'folder': 'INBOX', 'sent_folder': '[Gmail]/Sent Mail'},
    'yahoo': {'host': 'imap.mail.yahoo.com', 'port': 993, 'folder': 'INBOX', 'sent_folder': 'Sent'},
    'icloud': {'host': 'imap.mail.me.com', 'port': 993, 'folder': 'INBOX', 'sent_folder': 'Sent Messages'},
    'generic_imap': {'host': '', 'port': 993, 'folder': 'INBOX', 'sent_folder': 'Sent'},
    'microsoft365': {'host': 'outlook.office365.com', 'port': 993, 'folder': 'INBOX', 'sent_folder': 'Sent Items'},
}

DEFAULT_CONFIG = {
    'provider_preset': 'gmail',
    'host': 'imap.gmail.com',
    'port': 993,
    'username': '',
    'auth': 'password',
    'folder': 'INBOX',
    'sent_folder': '[Gmail]/Sent Mail',
    'agent_addresses': [],
    'poll_interval_s': 120,
    'since': '',
    'max_per_poll': 200,
    'sender_allow': [],
    'sender_deny': [],
    'subject_include': '',
    'subject_exclude': '',
    'skip_autoreplies': True,
    'order_prefix': '#',
    'restricted_recipients': ['Med.Ed@l-nutra.com'],
    'restricted_domains': [],
    'redact_restricted_on_server': True,
    'live_data_plaintext': False,
    'data_dir': DEFAULT_DATA_DIR,
}

_LIST_KEYS = ('agent_addresses', 'sender_allow', 'sender_deny', 'restricted_recipients', 'restricted_domains')
_STR_KEYS = ('provider_preset', 'host', 'username', 'auth', 'folder', 'sent_folder', 'since',
             'subject_include', 'subject_exclude', 'order_prefix', 'data_dir')
_BOOL_KEYS = ('skip_autoreplies', 'redact_restricted_on_server', 'live_data_plaintext')


class ConfigError(ValueError):
    """Raised when a configuration document fails validation."""


def _as_int(value, name, lo, hi):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ConfigError('%s must be an integer' % name)
    if n < lo or n > hi:
        raise ConfigError('%s must be between %d and %d' % (name, lo, hi))
    return n


def validate_config(raw):
    """Merge ``raw`` over the defaults, coerce types and validate every field.

    Keys starting with ``_`` (comments) are ignored. Keys that look like secrets are
    rejected so a password never lands in config.json. Returns the clean config dict
    and raises ``ConfigError`` on the first problem.
    """
    if not isinstance(raw, dict):
        raise ConfigError('config must be a JSON object')
    for key in raw:
        if SECRET_KEY_RE.search(str(key)):
            raise ConfigError('config must not contain secrets (key %r); use VOC_MAIL_SECRET or the Keychain' % key)
    cfg = dict(DEFAULT_CONFIG)
    for key, value in raw.items():
        if str(key).startswith('_') or key not in DEFAULT_CONFIG:
            continue
        cfg[key] = value
    for key in _STR_KEYS:
        if cfg[key] is None:
            cfg[key] = ''
        if not isinstance(cfg[key], str):
            raise ConfigError('%s must be a string' % key)
        cfg[key] = cfg[key].strip()
        if CONTROL_CHAR_RE.search(cfg[key]):
            # CR/LF inside a folder name would be spliced verbatim into the IMAP command stream.
            raise ConfigError('%s must not contain control characters' % key)
    for key in _LIST_KEYS:
        value = cfg[key]
        if isinstance(value, str):
            value = [v for v in re.split(r'[,\s;]+', value) if v]
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ConfigError('%s must be a list of strings' % key)
        cfg[key] = [v.strip() for v in value if v.strip()]
        if any(CONTROL_CHAR_RE.search(v) for v in cfg[key]):
            raise ConfigError('%s must not contain control characters' % key)
    for key in _BOOL_KEYS:
        value = cfg[key]
        if isinstance(value, str):
            value = value.lower() in ('1', 'true', 'yes', 'on')
        cfg[key] = bool(value)
    if cfg['provider_preset'] not in PROVIDER_PRESETS:
        raise ConfigError('provider_preset must be one of %s' % ', '.join(sorted(PROVIDER_PRESETS)))
    if cfg['auth'] not in ('password', 'xoauth2'):
        raise ConfigError("auth must be 'password' (xoauth2 is a roadmap item)")
    cfg['port'] = _as_int(cfg['port'], 'port', 1, 65535)
    cfg['poll_interval_s'] = _as_int(cfg['poll_interval_s'], 'poll_interval_s', 60, 900)
    cfg['max_per_poll'] = _as_int(cfg['max_per_poll'], 'max_per_poll', 1, 5000)
    if cfg['since'] and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', cfg['since']):
        raise ConfigError('since must be YYYY-MM-DD or empty')
    if cfg['since']:
        try:
            datetime.strptime(cfg['since'], '%Y-%m-%d')
        except ValueError:
            raise ConfigError('since is not a valid calendar date')
    for key in ('subject_include', 'subject_exclude'):
        if cfg[key]:
            try:
                re.compile(cfg[key], re.I)
            except re.error as exc:
                raise ConfigError('%s is not a valid regular expression: %s' % (key, exc))
    if not cfg['data_dir']:
        cfg['data_dir'] = DEFAULT_DATA_DIR
    cfg['data_dir'] = os.path.expanduser(cfg['data_dir'])
    return cfg


def load_config(path):
    """Read ``path`` (JSON) and return a validated config; defaults when the file is absent."""
    if not path or not os.path.exists(path):
        log.info('no config at %s; using defaults (idle until a mailbox is configured)', path)
        return validate_config({})
    with open(path, 'r', encoding='utf-8') as fh:
        raw = json.load(fh)
    return validate_config(raw)


def save_config(path, cfg):
    """Write ``cfg`` to ``path`` atomically (0600)."""
    _atomic_write(path, json.dumps(cfg, indent=2, ensure_ascii=False) + '\n', mode=0o600)


def secret(username=''):
    """Return the mailbox secret from ``VOC_MAIL_SECRET`` or the macOS Keychain, else None.

    Keychain lookup: ``security find-generic-password -s voc-mail [-a <username>] -w``.
    """
    env = os.environ.get('VOC_MAIL_SECRET', '').strip()
    if env:
        return env
    attempts = []
    if username:
        attempts.append(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', username, '-w'])
    attempts.append(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])
    for cmd in attempts:
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=15, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return None
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    return None


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _atomic_write(path, text, mode=None):
    """Write ``text`` to ``path`` via a temp file in the same directory and os.replace."""
    directory = os.path.dirname(os.path.abspath(path)) or '.'
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.voc-', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def utc_now_iso():
    """Current wall clock as ISO-8601 UTC with second precision."""
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def to_iso_utc(dt):
    """Convert a datetime (naive = UTC) to ISO-8601 UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


_MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')


def imap_date(iso_date):
    """'2026-08-01' -> '01-Aug-2026' (RFC 3501 date, English months regardless of locale)."""
    y, m, d = (int(x) for x in iso_date.split('-'))
    return '%02d-%s-%04d' % (d, _MONTHS[m - 1], y)


def _imap_utf7_encode(name):
    """RFC 3501 section 5.1.3 modified UTF-7: non-ASCII runs become ``&<base64 UTF-16BE>-`` and ``&`` becomes ``&-``."""
    out, run = [], []

    def flush():
        if run:
            b64 = base64.b64encode(''.join(run).encode('utf-16-be')).decode('ascii').rstrip('=')
            out.append('&' + b64.replace('/', ',') + '-')
            del run[:]

    for ch in name:
        if 0x20 <= ord(ch) <= 0x7e:
            flush()
            out.append('&-' if ch == '&' else ch)
        else:
            run.append(ch)
    flush()
    return ''.join(out)


def _imap_quote(name):
    """Quote a mailbox name for SELECT (folders such as '[Gmail]/Sent Mail' contain spaces).

    Non-ASCII names are encoded as modified UTF-7 so imaplib's ASCII-only command encoder accepts them.
    Control characters (CR, LF, NUL) are refused outright: they would inject further IMAP commands.
    """
    name = str(name or '')
    if CONTROL_CHAR_RE.search(name):
        raise ConfigError('mailbox name must not contain control characters')
    name = _imap_utf7_encode(name)
    return '"' + name.replace('\\', '\\\\').replace('"', '\\"') + '"'


def norm_email(addr):
    """Lower-case and trim an address; returns '' for None."""
    return (addr or '').strip().lower()


def _domain(addr):
    addr = norm_email(addr)
    return addr.rsplit('@', 1)[1] if '@' in addr else ''


_SALT = {'value': None}


def load_salt(data_dir):
    """Return the per-install pseudonym key stored as ``<data_dir>/salt`` (created 0600 on first use)."""
    path = os.path.join(data_dir, SALT_FILENAME)
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            value = fh.read().strip()
        if len(value) >= 32:
            return value
    except OSError:
        pass
    value = secrets.token_hex(32)
    _atomic_write(path, value + '\n', mode=0o600)
    return value


def set_salt(value):
    """Install the pseudonym key used by ``hash_email``/``hash_msgid`` (``None`` falls back to a per-process key)."""
    _SALT['value'] = str(value) if value else None


def _salt_bytes():
    if _SALT['value'] is None:
        # No data_dir yet (unit tests, library use): a random per-process key. App.__init__ installs the persistent one.
        _SALT['value'] = secrets.token_hex(32)
    return _SALT['value'].encode('utf-8')


def _keyed_hash(namespace, value):
    return hmac.new(_salt_bytes(), ('%s:%s' % (namespace, value)).encode('utf-8'), hashlib.sha256).hexdigest()[:16]


def hash_email(addr):
    """Stable 16-hex pseudonym for an address: HMAC-SHA256 under the per-install salt, so a known address
    cannot be confirmed from the stored hash without the salt file."""
    return _keyed_hash('email', norm_email(addr))


def hash_msgid(value):
    """Stable 16-hex pseudonym for a Message-ID (keeps threading between redacted records)."""
    return _keyed_hash('msgid', _norm_msgid(value) or (value or '').strip().lower())


def record_id(message_id, fallback=''):
    """'em_<hex16>' from a normalized Message-ID (or a fallback fingerprint)."""
    key = _norm_msgid(message_id) or fallback
    return 'em_' + hashlib.sha256(key.encode('utf-8')).hexdigest()[:16]


def _norm_msgid(value):
    value = (value or '').strip()
    if not value:
        return ''
    match = re.search(r'<([^<>]+)>', value)
    return (match.group(1) if match else value).strip().lower()


def _split_msgids(value):
    return [m.lower() for m in re.findall(r'<([^<>]+)>', value or '')]


def _header(msg, name):
    """Decoded header value or ''. Tolerates headers the strict parser rejects."""
    try:
        value = msg.get(name)
        if value is None:
            return ''
        return str(value).strip()
    except Exception:  # noqa: BLE001 - a malformed header must not kill the poll
        try:
            raw = msg.get_all(name)
            if not raw:
                return ''
            parts = email.header.decode_header(str(raw[0]))
            return ''.join(p.decode(c or 'utf-8', 'replace') if isinstance(p, bytes) else p for p, c in parts).strip()
        except Exception:  # noqa: BLE001
            return ''


def _addresses(msg, name):
    values = []
    try:
        for header in msg.get_all(name, []) or []:
            values.append(str(header))
    except Exception:  # noqa: BLE001
        return []
    return [norm_email(addr) for _n, addr in getaddresses(values) if addr]


# ---------------------------------------------------------------------------
# Text cleaning
# ---------------------------------------------------------------------------

_HTML_DROP_RE = re.compile(r'<(script|style|head|title)\b[^>]*>.*?</\1\s*>', re.I | re.S)
_HTML_COMMENT_RE = re.compile(r'<!--.*?-->', re.S)
_HTML_BLOCK_RE = re.compile(r'</?(?:p|div|br|li|tr|h[1-6]|blockquote|table|ul|ol|pre|hr|section|article)\b[^>]*/?>', re.I)
_HTML_TAG_RE = re.compile(r'<[^>]+>')


def html_to_text(markup):
    """Strip HTML to readable plain text, keeping paragraph breaks."""
    if not markup:
        return ''
    text = _HTML_COMMENT_RE.sub('', markup)
    text = _HTML_DROP_RE.sub('', text)
    text = _HTML_BLOCK_RE.sub('\n', text)
    text = _HTML_TAG_RE.sub('', text)
    text = html_lib.unescape(text)
    text = text.replace('\xa0', ' ')
    lines = [re.sub(r'[ \t]+', ' ', line).strip() for line in text.splitlines()]
    text = '\n'.join(lines)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


_QUOTE_CUTS = (
    re.compile(r'^[ \t]*On\b[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:[ \t]*$', re.M),
    re.compile(r'^[ \t]*-{2,}\s*Original Message\s*-{2,}[ \t]*$', re.M | re.I),
    re.compile(r'^[ \t]*-{2,}\s*Forwarded message\s*-{2,}[ \t]*$', re.M | re.I),
    re.compile(r'^[ \t]*From:[^\n]*\n(?:[^\n]*\n){0,2}?[ \t]*Sent:', re.M),
    re.compile(r'^[ \t]*_{8,}[ \t]*$', re.M),
    re.compile(r'^-- $', re.M),
    re.compile(r'^[ \t]*Sent from my [^\n]{0,40}$', re.M),
)
_QUOTED_LINE_RE = re.compile(r'^[ \t]*>.*$', re.M)


def strip_quotes(text):
    """Cut quoted history and signatures from a plain-text body.

    Cuts at the earliest of: an 'On ... wrote:' line (one or two lines), an
    '-----Original Message-----' or forwarded banner, an Outlook 'From: ... Sent:' block,
    a line of underscores, a '-- ' signature marker or a 'Sent from my ...' line. Lines
    starting with '>' are removed wherever they sit. Whitespace is collapsed.
    """
    if not text:
        return ''
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    cut = len(text)
    for pattern in _QUOTE_CUTS:
        match = pattern.search(text)
        if match and match.start() < cut:
            cut = match.start()
    text = text[:cut]
    text = _QUOTED_LINE_RE.sub('', text)
    lines = [line.rstrip() for line in text.split('\n')]
    text = '\n'.join(lines)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


# ---------------------------------------------------------------------------
# Noise detection
# ---------------------------------------------------------------------------

_AUTO_REPLY_SUBJECT_RE = re.compile(
    r'^\s*(?:(?:re|fwd?|aw|wg)\s*:\s*)*(?:auto(?:matic|mated)?[\s-]*(?:reply|response|risposta|antwort)'
    r'|out[\s-]*of[\s-]*(?:the[\s-]*)?office|abwesenheit|vacation (?:reply|notice)|away from (?:my|the) (?:desk|office))',
    re.I)
_BOUNCE_SUBJECT_RE = re.compile(
    r'^\s*(?:(?:re|fwd?)\s*:\s*)*(?:undeliver(?:able|ed)|delivery (?:status notification|failure|has failed|report|notification)'
    r'|mail delivery (?:failed|failure|subsystem)|returned mail|failure notice|message not delivered|non[- ]?delivery)',
    re.I)
_BOUNCE_SENDER_RE = re.compile(r'^(?:mailer-daemon|postmaster|mail-daemon|no-?reply\+bounces?)(?:@|$)', re.I)
_LIST_PRECEDENCE = ('bulk', 'junk', 'list')


def noise_reason(headers, subject='', from_email='', content_type=''):
    """Return 'auto_reply' | 'bounce' | 'newsletter' | None from header values.

    ``headers`` is a dict with lower-case snake_case keys (auto_submitted, precedence,
    list_id, list_unsubscribe, x_autoreply, x_auto_response_suppress, content_type).
    """
    headers = {str(k).lower().replace('-', '_'): (v or '') for k, v in (headers or {}).items()}
    content_type = (content_type or headers.get('content_type') or '').lower()
    auto_submitted = headers.get('auto_submitted', '').lower()
    precedence = headers.get('precedence', '').lower()
    if content_type.startswith('multipart/report') or _BOUNCE_SENDER_RE.match(norm_email(from_email)):
        return 'bounce'
    if _BOUNCE_SUBJECT_RE.search(subject or ''):
        return 'bounce'
    if auto_submitted and auto_submitted != 'no':
        return 'auto_reply'
    if headers.get('x_auto_response_suppress') or headers.get('x_autoreply') or headers.get('x_autorespond'):
        return 'auto_reply'
    if precedence.replace('-', '_') == 'auto_reply':
        return 'auto_reply'
    if _AUTO_REPLY_SUBJECT_RE.search(subject or ''):
        return 'auto_reply'
    if headers.get('list_id') or headers.get('list_unsubscribe'):
        return 'newsletter'
    if any(p in precedence for p in _LIST_PRECEDENCE):
        return 'newsletter'
    return None


def is_noise(msg):
    """Noise reason for an ``email.message.EmailMessage`` or None when it looks like a human message."""
    headers = {
        'auto_submitted': _header(msg, 'Auto-Submitted'),
        'precedence': _header(msg, 'Precedence'),
        'list_id': _header(msg, 'List-Id'),
        'list_unsubscribe': _header(msg, 'List-Unsubscribe'),
        'x_autoreply': _header(msg, 'X-Autoreply') or _header(msg, 'X-Autorespond'),
        'x_auto_response_suppress': _header(msg, 'X-Auto-Response-Suppress'),
    }
    _name, from_email = parseaddr(_header(msg, 'From'))
    content_type = ''
    try:
        content_type = msg.get_content_type()
    except Exception:  # noqa: BLE001
        pass
    return noise_reason(headers, _header(msg, 'Subject'), from_email, content_type)


# ---------------------------------------------------------------------------
# Normalization to RawEmail
# ---------------------------------------------------------------------------

def _part_text(part):
    """Decoded text of a leaf part with charset fallbacks."""
    try:
        content = part.get_content()
        if isinstance(content, bytes):
            content = content.decode(part.get_content_charset() or 'utf-8', 'replace')
        return content
    except Exception:  # noqa: BLE001 - unknown charset or broken transfer encoding
        payload = part.get_payload(decode=True) or b''
        charset = part.get_content_charset() or 'utf-8'
        try:
            return payload.decode(charset, 'replace')
        except LookupError:
            return payload.decode('utf-8', 'replace')


def _body_parts(msg):
    """Return (plain_text, html_text) from the best inline parts of ``msg``."""
    plain, markup = '', ''
    try:
        part = msg.get_body(preferencelist=('plain',))
        if part is not None:
            plain = _part_text(part)
        part = msg.get_body(preferencelist=('html',))
        if part is not None:
            markup = _part_text(part)
    except Exception:  # noqa: BLE001 - fall through to a manual walk
        plain, markup = '', ''
    if not plain and not markup:
        for part in msg.walk():
            if part.is_multipart():
                continue
            disposition = (part.get('Content-Disposition') or '').lower()
            if 'attachment' in disposition:
                continue
            ctype = part.get_content_type()
            if ctype == 'text/plain' and not plain:
                plain = _part_text(part)
            elif ctype == 'text/html' and not markup:
                markup = _part_text(part)
    return plain, markup


def _attachments(msg):
    items = []
    try:
        for part in msg.iter_attachments():
            payload = part.get_payload(decode=True) if not part.is_multipart() else None
            items.append({
                'name': part.get_filename() or '',
                'type': part.get_content_type(),
                'size': len(payload) if payload else 0,
            })
    except Exception:  # noqa: BLE001
        pass
    return items


def _message_date(msg, internaldate=None):
    raw = _header(msg, 'Date')
    if raw:
        try:
            return to_iso_utc(parsedate_to_datetime(raw))
        except (TypeError, ValueError, IndexError):
            pass
    if internaldate:
        try:
            tt = imaplib.Internaldate2tuple(internaldate if isinstance(internaldate, bytes) else internaldate.encode())
            if tt:
                return to_iso_utc(datetime.fromtimestamp(time.mktime(tt), tz=timezone.utc))
        except Exception:  # noqa: BLE001
            pass
    return utc_now_iso()


def normalize(msg, cfg, direction='inbound', internaldate=None, uid=None, folder=None):
    """Turn an ``EmailMessage`` into a RawEmail dict (SPEC section 2).

    Decodes RFC 2047 headers through ``email.policy.default``, prefers text/plain over
    stripped HTML, cuts quoted history with ``strip_quotes``, counts attachments and
    carries the noise-relevant headers. Mail from ``cfg['agent_addresses']`` becomes
    ``direction: 'outbound'`` even when it sits in the inbox.
    """
    from_name, from_email = parseaddr(_header(msg, 'From'))
    from_email = norm_email(from_email)
    from_name = from_name.strip() or None
    message_id = _norm_msgid(_header(msg, 'Message-ID'))
    in_reply_to = _norm_msgid(_header(msg, 'In-Reply-To'))
    references = _split_msgids(_header(msg, 'References'))
    subject = re.sub(r'\s+', ' ', _header(msg, 'Subject')).strip()
    date = _message_date(msg, internaldate)
    plain, markup = _body_parts(msg)
    text = strip_quotes(plain) if plain.strip() else strip_quotes(html_to_text(markup))
    text = text[:TEXT_LIMIT]
    fingerprint = '|'.join((from_email, date, subject, text[:200]))
    agents = {norm_email(a) for a in cfg.get('agent_addresses', [])}
    if from_email and from_email in agents:
        direction = 'outbound'
    rec = {
        'id': record_id(message_id, fingerprint),
        'schema_version': SCHEMA_VERSION,
        'message_id': message_id or None,
        'thread_id': (references[0] if references else None) or in_reply_to or message_id or record_id('', fingerprint),
        'in_reply_to': in_reply_to or None,
        'references': references,
        'date': date,
        'from_name': from_name,
        'from_email': from_email or None,
        'to': _addresses(msg, 'To'),
        'cc': _addresses(msg, 'Cc'),
        'subject': subject,
        'text': text,
        'html': None,
        'direction': direction,
        'attachments': _attachments(msg),
        'headers': {
            'auto_submitted': _header(msg, 'Auto-Submitted') or None,
            'precedence': _header(msg, 'Precedence') or None,
            'list_id': _header(msg, 'List-Id') or None,
            'list_unsubscribe': _header(msg, 'List-Unsubscribe') or None,
            'content_type': _header(msg, 'Content-Type').split(';')[0].strip().lower() or None,
            'x_autoreply': (_header(msg, 'X-Autoreply') or _header(msg, 'X-Autorespond')
                            or _header(msg, 'X-Auto-Response-Suppress')) or None,
        },
        'source': 'imap',
        'noise_reason': is_noise(msg),
        'restricted': False,
        'redacted': False,
        'uid': uid,
        'folder': folder,
    }
    rec['is_noise'] = rec['noise_reason'] is not None
    rec['restricted'] = is_restricted(rec, cfg)
    return rec


def is_restricted(rec, cfg):
    """True when a recipient or domain matches the restricted lists (PHI-adjacent mail)."""
    recipients = {norm_email(r) for r in cfg.get('restricted_recipients', [])}
    domains = {norm_email(d).lstrip('@') for d in cfg.get('restricted_domains', [])}
    parties = list(rec.get('to') or []) + list(rec.get('cc') or [])
    if rec.get('from_email'):
        parties.append(rec['from_email'])
    for addr in parties:
        addr = norm_email(addr)
        if addr in recipients or (_domain(addr) and _domain(addr) in domains):
            return True
    return False


def _company_addresses(cfg):
    """Addresses that stay readable in redacted records: the mailbox itself, agents and the restricted recipients."""
    keep = set()
    cfg = cfg or {}
    for key in ('agent_addresses', 'restricted_recipients'):
        keep.update(norm_email(a) for a in (cfg.get(key) or []))
    if cfg.get('username'):
        keep.add(norm_email(cfg['username']))
    keep.discard('')
    return keep


def redact(rec, cfg=None):
    """Return a copy of ``rec`` with every customer-identifying field removed or pseudonymized.

    Body and subject become markers; the sender keeps only ``from_hash``; each ``to``/``cc`` address that is
    not company-owned (mailbox, agents, restricted recipients from ``cfg``) becomes ``<hash>@redacted.invalid``;
    Message-IDs are replaced by keyed hashes so redacted messages of one thread still link; attachment names
    and MIME types are blanked (sizes and count remain). All hashes use the per-install salt.
    """
    keep = _company_addresses(cfg)

    def party(addr):
        addr = norm_email(addr)
        return addr if addr in keep else '%s@%s' % (hash_email(addr), REDACTED_DOMAIN)

    out = dict(rec)
    out['from_name'] = 'Redacted'
    out['from_hash'] = hash_email(rec.get('from_email')) if rec.get('from_email') else None
    out['from_email'] = None
    out['to'] = [party(a) for a in (rec.get('to') or []) if a]
    out['cc'] = [party(a) for a in (rec.get('cc') or []) if a]
    out['subject'] = REDACTED_SUBJECT if (rec.get('subject') or '').strip() else ''
    out['text'] = REDACTED_TEXT
    out['html'] = None
    for key in ('message_id', 'in_reply_to', 'thread_id'):
        if rec.get(key):
            out[key] = 'redacted-' + hash_msgid(str(rec[key]))
    out['references'] = ['redacted-' + hash_msgid(str(r)) for r in (rec.get('references') or []) if r]
    out['attachments'] = [{'name': '', 'type': '', 'size': (a.get('size', 0) if isinstance(a, dict) else 0)}
                          for a in rec.get('attachments') or []]
    out['restricted'] = True
    out['redacted'] = True
    return out


def _match_sender(addr, entries):
    addr = norm_email(addr)
    domain = _domain(addr)
    for entry in entries:
        entry = norm_email(entry)
        if not entry:
            continue
        if entry.startswith('@') or '@' not in entry:
            if domain and (domain == entry.lstrip('@') or domain.endswith('.' + entry.lstrip('@'))):
                return True
        elif addr == entry:
            return True
    return False


def passes_filters(rec, cfg):
    """Apply sender allow/deny and subject include/exclude. Returns (ok, reason)."""
    sender = rec.get('from_email') or ''
    if cfg.get('sender_deny') and _match_sender(sender, cfg['sender_deny']):
        return False, 'sender_deny'
    if cfg.get('sender_allow') and rec.get('direction') != 'outbound' and not _match_sender(sender, cfg['sender_allow']):
        return False, 'sender_allow'
    subject = rec.get('subject') or ''
    if cfg.get('subject_include') and not re.search(cfg['subject_include'], subject, re.I):
        return False, 'subject_include'
    if cfg.get('subject_exclude') and re.search(cfg['subject_exclude'], subject, re.I):
        return False, 'subject_exclude'
    return True, None


def finalize(rec, cfg):
    """Apply server-side redaction when configured. Returns the record to store."""
    if rec.get('restricted') and cfg.get('redact_restricted_on_server', True):
        return redact(rec, cfg)
    return rec


def _text_field(value, limit=None):
    """A string for str/int/float payload fields, '' for anything else (lists, dicts, bools, None)."""
    if isinstance(value, bool) or value is None:
        return ''
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return ''
    return value if limit is None else value[:limit]


def _int_field(value, lo=0, hi=2 ** 53):
    """An int clamped to [lo, hi] from int/float/numeric-string fields; 0 for anything else (inf, nan, lists)."""
    if isinstance(value, bool) or value is None:
        return 0
    try:
        n = int(float(value)) if isinstance(value, str) else int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(lo, min(hi, n))


def normalize_ingest(payload, cfg):
    """Coerce a RawEmail-like JSON object (Zapier/Make/Power Automate) into a stored record.

    Every field is coerced defensively: wrongly typed values are ignored or raise ``ValueError`` (400), never
    an ``AttributeError``/``OverflowError`` that would drop the connection.
    """
    if not isinstance(payload, dict):
        raise ValueError('body must be a JSON object')
    text = payload.get('text') or ''
    markup = payload.get('html') or ''
    if not isinstance(text, str) or not isinstance(markup, str):
        raise ValueError('text and html must be strings')
    text = strip_quotes(text) if text.strip() else strip_quotes(html_to_text(markup))
    subject = re.sub(r'\s+', ' ', _text_field(payload.get('subject'), 2000)).strip()
    if not text and not subject:
        raise ValueError('a subject or text is required')
    from_email = norm_email(_text_field(payload.get('from_email'), 320))
    date_in = payload.get('date') if payload.get('date') is not None else payload.get('received_at')
    if date_in is not None and not isinstance(date_in, str):
        raise ValueError('date must be an ISO-8601 or RFC 5322 string')
    date = (date_in or '').strip() or utc_now_iso()
    try:
        date = to_iso_utc(datetime.fromisoformat(date.replace('Z', '+00:00')))
    except ValueError:
        try:
            date = to_iso_utc(parsedate_to_datetime(date))
        except (TypeError, ValueError, IndexError, OverflowError):
            raise ValueError('date must be ISO-8601 or RFC 5322')

    def _list(key):
        value = payload.get(key) or []
        if isinstance(value, str):
            value = [v for v in re.split(r'[,;\s]+', value) if v]
        if not isinstance(value, list):
            return []
        return [norm_email(v)[:320] for v in value if isinstance(v, str) and v.strip()][:200]

    headers_in = payload.get('headers') or {}
    if not isinstance(headers_in, dict):
        headers_in = {}
    headers = {k: (_text_field(headers_in.get(k), 2000) or None) for k in
               ('auto_submitted', 'precedence', 'list_id', 'list_unsubscribe', 'content_type', 'x_autoreply')}
    message_id = _norm_msgid(_text_field(payload.get('message_id'), 998))
    fingerprint = '|'.join((from_email, date, subject, text[:200]))
    refs_in = payload.get('references') or []
    if isinstance(refs_in, str):
        references = _split_msgids(refs_in)
    elif isinstance(refs_in, list):
        references = [r.strip() for r in refs_in if isinstance(r, str) and r.strip()][:100]
    else:
        references = []
    in_reply_to = _norm_msgid(_text_field(payload.get('in_reply_to'), 998))
    agents = {norm_email(a) for a in cfg.get('agent_addresses', [])}
    direction = payload.get('direction') if payload.get('direction') in ('inbound', 'outbound') else 'inbound'
    if from_email and from_email in agents:
        direction = 'outbound'
    attachments = []
    atts_in = payload.get('attachments') or []
    for att in (atts_in if isinstance(atts_in, list) else [])[:100]:
        if isinstance(att, dict):
            attachments.append({'name': _text_field(att.get('name'), 255), 'type': _text_field(att.get('type'), 255),
                                'size': _int_field(att.get('size'))})
    rec = {
        'id': record_id(message_id, fingerprint),
        'schema_version': SCHEMA_VERSION,
        'message_id': message_id or None,
        'thread_id': (references[0] if references else None) or in_reply_to or message_id or record_id('', fingerprint),
        'in_reply_to': in_reply_to or None,
        'references': references,
        'date': date,
        'from_name': _text_field(payload.get('from_name'), 320).strip() or None,
        'from_email': from_email or None,
        'to': _list('to'),
        'cc': _list('cc'),
        'subject': subject,
        'text': text[:TEXT_LIMIT],
        'html': None,
        'direction': direction,
        'attachments': attachments,
        'headers': headers,
        'source': 'json',
        'noise_reason': noise_reason(headers, subject, from_email, headers.get('content_type') or ''),
        'restricted': False,
        'redacted': False,
        'uid': None,
        'folder': None,
    }
    rec['is_noise'] = rec['noise_reason'] is not None
    rec['restricted'] = bool(payload.get('restricted')) or is_restricted(rec, cfg)
    return finalize(rec, cfg)


# ---------------------------------------------------------------------------
# IMAP
# ---------------------------------------------------------------------------

def connect(cfg, secret_value):
    """Open an ``IMAP4_SSL`` connection with the default SSL context and log in.

    Only ``auth: 'password'`` is implemented (Gmail/Yahoo/iCloud app passwords, generic
    IMAP). ``auth: 'xoauth2'`` raises ``NotImplementedError`` describing what XOAUTH2 needs.
    """
    if not cfg.get('host'):
        raise ConfigError('host is empty; pick a provider preset or enter the IMAP host')
    if not cfg.get('username'):
        raise ConfigError('username is empty')
    auth = cfg.get('auth', 'password')
    if auth == 'xoauth2':
        # XOAUTH2 (Microsoft 365 / Outlook.com, Gmail without app passwords) needs an OAuth
        # client registration, a device-code or browser consent flow that yields a refresh
        # token, periodic access-token refresh, then
        #   conn.authenticate('XOAUTH2', lambda _: 'user=%s\x01auth=Bearer %s\x01\x01' % (user, access_token))
        # None of that fits a secret-free config file yet; see server/README.md (roadmap).
        raise NotImplementedError('auth "xoauth2" is not implemented; use an app password (auth "password")')
    if auth != 'password':
        raise ConfigError('unknown auth mode %r' % auth)
    if not secret_value:
        raise ConfigError('no mailbox secret: set VOC_MAIL_SECRET or add a Keychain item (service "voc-mail")')
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(cfg['host'], int(cfg.get('port') or 993), ssl_context=ctx, timeout=45)
    try:
        conn.login(cfg['username'], secret_value)
    except imaplib.IMAP4.error as exc:
        try:
            conn.shutdown()
        except Exception:  # noqa: BLE001
            pass
        raise imaplib.IMAP4.error('IMAP login failed for %s@%s: %s' % (cfg['username'], cfg['host'], exc))
    return conn


def _response_int(conn, code):
    typ, data = conn.response(code)
    if typ != code or not data or data[0] is None:
        return None
    try:
        return int(data[0])
    except (TypeError, ValueError):
        return None


def _parse_uid_list(data):
    uids = []
    for chunk in data or []:
        if not chunk:
            continue
        for token in chunk.split():
            try:
                uids.append(int(token))
            except ValueError:
                continue
    return sorted(set(uids))


_FETCH_UID_RE = re.compile(rb'UID (\d+)')
_FETCH_INTERNALDATE_RE = re.compile(rb'INTERNALDATE ("[^"]+")')


def _parse_fetch(data):
    """Yield (uid, internaldate_bytes|None, raw_bytes) from a UID FETCH response."""
    for item in data or []:
        if not isinstance(item, tuple) or len(item) < 2 or not isinstance(item[1], (bytes, bytearray)):
            continue
        meta, raw = item[0], item[1]
        match = _FETCH_UID_RE.search(meta or b'')
        if not match:
            continue
        idate = _FETCH_INTERNALDATE_RE.search(meta or b'')
        yield int(match.group(1)), (idate.group(1) if idate else None), bytes(raw)


def poll(cfg, state, folder, direction='inbound', conn=None, secret_value=None):
    """Fetch new messages from ``folder`` and return normalized records.

    ``state`` is a dict keyed by folder: ``{folder: {'uidvalidity': int|None, 'last_uid': int}}``
    and is updated in place. A UIDVALIDITY change resets ``last_uid`` and re-searches
    from ``cfg['since']``. Uses ``UID SEARCH`` (``UID n:*`` after the first pass, otherwise
    ``SINCE dd-Mon-yyyy`` or ``ALL``) and ``UID FETCH (UID INTERNALDATE BODY.PEEK[])`` so the
    server never sets ``\\Seen``. At most ``cfg['max_per_poll']`` messages are fetched, lowest
    UID first, so a large backlog drains across polls.

    Returns ``{'records': [...], 'fetched': n, 'noise': n, 'filtered': n, 'uidvalidity': v, 'last_uid': u}``.
    Every record is normalized, filtered and redacted; noise records are dropped when
    ``cfg['skip_autoreplies']`` is true, otherwise they carry ``noise_reason``.
    """
    own = conn is None
    if own:
        conn = connect(cfg, secret_value if secret_value is not None else secret(cfg.get('username', '')))
    folder_state = state.setdefault(folder, {'uidvalidity': None, 'last_uid': 0})
    result = {'records': [], 'fetched': 0, 'noise': 0, 'filtered': 0,
              'uidvalidity': folder_state.get('uidvalidity'), 'last_uid': folder_state.get('last_uid', 0)}
    try:
        typ, _data = conn.select(_imap_quote(folder), readonly=True)
        if typ != 'OK':
            raise imaplib.IMAP4.error('cannot select folder %r' % folder)
        uidvalidity = _response_int(conn, 'UIDVALIDITY')
        if uidvalidity is not None and folder_state.get('uidvalidity') not in (None, uidvalidity):
            log.warning('UIDVALIDITY changed for %s (%s -> %s); re-scanning from since date',
                        folder, folder_state.get('uidvalidity'), uidvalidity)
            folder_state['last_uid'] = 0
        folder_state['uidvalidity'] = uidvalidity
        last_uid = int(folder_state.get('last_uid') or 0)
        if last_uid > 0:
            criteria = ('UID', '%d:*' % (last_uid + 1))
        elif cfg.get('since'):
            criteria = ('SINCE', imap_date(cfg['since']))
        else:
            criteria = ('ALL',)
        typ, data = conn.uid('SEARCH', None, *criteria)
        if typ != 'OK':
            raise imaplib.IMAP4.error('UID SEARCH failed in %r: %s' % (folder, data))
        uids = [u for u in _parse_uid_list(data) if u > last_uid]   # 'n:*' echoes the newest UID even below n
        uids = uids[:int(cfg.get('max_per_poll') or 200)]
        for start in range(0, len(uids), FETCH_BATCH):
            batch = uids[start:start + FETCH_BATCH]
            typ, data = conn.uid('FETCH', ','.join(str(u) for u in batch), '(UID INTERNALDATE BODY.PEEK[])')
            if typ != 'OK':
                raise imaplib.IMAP4.error('UID FETCH failed in %r: %s' % (folder, data))
            for uid, internaldate, raw in _parse_fetch(data):
                result['fetched'] += 1
                try:
                    msg = email.message_from_bytes(raw, policy=email.policy.default)
                    rec = normalize(msg, cfg, direction, internaldate=internaldate, uid=uid, folder=folder)
                except Exception as exc:  # noqa: BLE001 - one broken message must not stop the poll
                    log.warning('skipping UID %s in %s: %s', uid, folder, exc)
                    continue
                if rec['is_noise']:
                    result['noise'] += 1
                    if cfg.get('skip_autoreplies', True):
                        continue
                ok, _reason = passes_filters(rec, cfg)
                if not ok:
                    result['filtered'] += 1
                    continue
                result['records'].append(finalize(rec, cfg))
            folder_state['last_uid'] = max(folder_state.get('last_uid') or 0, max(batch))
        result['uidvalidity'] = folder_state['uidvalidity']
        result['last_uid'] = folder_state['last_uid']
        return result
    finally:
        if own:
            try:
                conn.logout()
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

class Store:
    """Thread-safe record store persisted as JSON under ``data_dir/records.json``."""

    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.path = os.path.join(data_dir, 'records.json')
        self._lock = threading.RLock()
        self._by_key = {}
        self._dirty = False

    @staticmethod
    def _key(rec):
        return _norm_msgid(rec.get('message_id')) or rec.get('id') or ''

    def load(self):
        """Load records from disk; a missing or corrupt file yields an empty store."""
        with self._lock:
            self._by_key = {}
            if not os.path.exists(self.path):
                return 0
            try:
                with open(self.path, 'r', encoding='utf-8') as fh:
                    doc = json.load(fh)
            except (OSError, ValueError) as exc:
                log.error('could not read %s (%s); starting empty', self.path, exc)
                return 0
            records = doc.get('records', []) if isinstance(doc, dict) else doc
            for rec in records or []:
                if isinstance(rec, dict) and self._key(rec):
                    self._by_key[self._key(rec)] = rec
            return len(self._by_key)

    def upsert(self, rec):
        """Insert ``rec`` keyed by Message-ID (or id). Returns (id, duplicate)."""
        key = self._key(rec)
        if not key:
            raise ValueError('record has neither message_id nor id')
        with self._lock:
            existing = self._by_key.get(key)
            if existing is not None:
                return existing.get('id'), True
            rec = dict(rec)
            rec.setdefault('ingested_at', utc_now_iso())
            self._by_key[key] = rec
            self._dirty = True
            return rec.get('id'), False

    def upsert_many(self, records):
        """Upsert a batch; returns ``{'added': n, 'duplicates': n}``."""
        added = duplicates = 0
        with self._lock:
            for rec in records:
                _id, dup = self.upsert(rec)
                if dup:
                    duplicates += 1
                else:
                    added += 1
        return {'added': added, 'duplicates': duplicates}

    def count(self):
        with self._lock:
            return len(self._by_key)

    def all(self):
        """All records sorted by (date, id) ascending."""
        with self._lock:
            return sorted(self._by_key.values(), key=lambda r: (r.get('date') or '', r.get('id') or ''))

    def since(self, since_iso='', limit=500):
        """Records newer than a cursor, oldest first.

        ``since_iso`` is an ISO timestamp or a cursor ``'<iso>|<id>'`` returned as
        ``next_since``. Returns ``{records, next_since, total, has_more}``.
        """
        try:
            limit = max(1, min(int(limit or 500), 5000))
        except (TypeError, ValueError):
            limit = 500
        since_iso = (since_iso or '').strip()
        since_id = ''
        if '|' in since_iso:
            since_iso, since_id = since_iso.split('|', 1)
        cursor = (since_iso, since_id)
        records = self.all()
        if since_iso:
            if since_id:
                records = [r for r in records if ((r.get('date') or ''), (r.get('id') or '')) > cursor]
            else:
                records = [r for r in records if (r.get('date') or '') >= since_iso]
        page = records[:limit]
        has_more = len(records) > limit
        if page:
            last = page[-1]
            next_since = '%s|%s' % (last.get('date') or '', last.get('id') or '')
        else:
            next_since = '%s|%s' % cursor if since_id else since_iso
        return {'records': page, 'next_since': next_since, 'total': self.count(), 'has_more': has_more}

    def save(self, force=False):
        """Atomically write ``records.json`` when something changed (or ``force``)."""
        with self._lock:
            if not self._dirty and not force:
                return False
            doc = {'schema_version': SCHEMA_VERSION, 'saved_at': utc_now_iso(), 'records': self.all()}
            _atomic_write(self.path, json.dumps(doc, ensure_ascii=False, separators=(',', ':')), mode=0o600)
            self._dirty = False
            return True

    def write_live_js(self, site_dir, plaintext=False):
        """Atomically write ``<site_dir>/js/live-data.js``.

        With ``plaintext`` true the file holds every stored record (``window.VOC_LIVE = [...]``) so the site
        works from ``file://``. With the default false the file is an empty set: records stay in ``data_dir``
        and reach the page only through ``/api/records`` with the token. Callers pass
        ``cfg['live_data_plaintext']``.
        """
        with self._lock:
            records = self.all() if plaintext else None
        path = os.path.join(site_dir, 'js', 'live-data.js')
        _atomic_write(path, live_js_text(records), mode=0o600)
        return path


def live_js_text(records):
    """Body of ``js/live-data.js``: the records as ``window.VOC_LIVE = [...]`` or, for ``None``, the empty set."""
    stamp = utc_now_iso()
    if records is None:
        return ('// Generated by server/voc_server.py at %s. live_data_plaintext is false: records stay in data_dir and\n'
                '// reach the page through /api/records. Set live_data_plaintext to true in server/config.json for file://.\n'
                '%s' % (stamp, LIVE_JS_EMPTY))
    body = json.dumps(records, ensure_ascii=False, separators=(',', ':'))
    body = body.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029').replace('</', '<\\/')
    return ('// Generated by server/voc_server.py at %s. Do not edit; the sidecar rewrites this file.\n'
            'window.VOC_LIVE = %s;\n' % (stamp, body))


# ---------------------------------------------------------------------------
# Poller thread
# ---------------------------------------------------------------------------

class Poller(threading.Thread):
    """Background IMAP poller with exponential backoff and persisted UID state."""

    def __init__(self, cfg, store, site_dir, data_dir, secret_value=None):
        super().__init__(name='voc-poller', daemon=True)
        self.cfg = cfg
        self.store = store
        self.site_dir = site_dir
        self.data_dir = data_dir
        self._secret = secret_value
        self._stop = threading.Event()
        self._sync_lock = threading.Lock()
        self.state_path = os.path.join(data_dir, 'state.json')
        self.state = self._load_state()
        self.connected = False
        self.last_error = None
        self.last_sync_at = self.state.get('last_sync_at')
        self.counts = dict(self.state.get('counts') or {'fetched': 0, 'deduped': 0, 'noise': 0, 'filtered': 0})
        self.next_poll_at = None
        self._backoff = int(cfg.get('poll_interval_s') or 120)

    def _load_state(self):
        try:
            with open(self.state_path, 'r', encoding='utf-8') as fh:
                doc = json.load(fh)
            if isinstance(doc, dict):
                doc.setdefault('folders', {})
                return doc
        except (OSError, ValueError):
            pass
        return {'folders': {}, 'last_sync_at': None, 'counts': {'fetched': 0, 'deduped': 0, 'noise': 0, 'filtered': 0}}

    def _save_state(self):
        self.state['last_sync_at'] = self.last_sync_at
        self.state['counts'] = self.counts
        self.state['mailbox'] = '%s@%s' % (self.cfg.get('username'), self.cfg.get('host'))
        try:
            _atomic_write(self.state_path, json.dumps(self.state, indent=2), mode=0o600)
        except OSError as exc:
            log.error('could not save poller state: %s', exc)

    def _secret_value(self):
        if self._secret is None:
            self._secret = secret(self.cfg.get('username', ''))
        return self._secret

    def sync_once(self):
        """Poll the inbox (and the sent folder when set), persist and rewrite live-data.js.

        Returns ``{'ok': True, 'fetched': n, 'added': n, 'duplicates': n, 'noise': n, 'duration_ms': ms}``.
        Raises on connection or protocol errors after recording ``last_error``.
        """
        started = time.time()
        with self._sync_lock:
            folders = self.state.setdefault('folders', {})
            if folders.get('_mailbox') not in (None, '%s@%s' % (self.cfg.get('username'), self.cfg.get('host'))):
                log.info('mailbox changed; resetting UID state')
                folders.clear()
            folders['_mailbox'] = '%s@%s' % (self.cfg.get('username'), self.cfg.get('host'))
            fetched = noise = filtered = 0
            records = []
            try:
                conn = connect(self.cfg, self._secret_value())
                self.connected = True
                try:
                    plan = [(self.cfg['folder'], 'inbound')]
                    if self.cfg.get('sent_folder'):
                        plan.append((self.cfg['sent_folder'], 'outbound'))
                    for folder, direction in plan:
                        out = poll(self.cfg, folders, folder, direction, conn=conn)
                        fetched += out['fetched']
                        noise += out['noise']
                        filtered += out['filtered']
                        records.extend(out['records'])
                finally:
                    try:
                        conn.logout()
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as exc:  # noqa: BLE001
                self.connected = False
                self.last_error = '%s: %s' % (type(exc).__name__, str(exc).strip() or 'unknown error')
                self._save_state()
                raise
            summary = self.store.upsert_many(records)
            self.counts['fetched'] = self.counts.get('fetched', 0) + fetched
            self.counts['deduped'] = self.counts.get('deduped', 0) + summary['duplicates']
            self.counts['noise'] = self.counts.get('noise', 0) + noise
            self.counts['filtered'] = self.counts.get('filtered', 0) + filtered
            self.last_error = None
            self.last_sync_at = utc_now_iso()
            try:
                if self.store.save():
                    self.store.write_live_js(self.site_dir, self.cfg.get('live_data_plaintext', False))
            except OSError as exc:
                self.last_error = 'write failed: %s' % exc
                log.error('could not persist records: %s', exc)
            self._save_state()
            duration_ms = int((time.time() - started) * 1000)
            log.info('sync %s: fetched %d, added %d, duplicates %d, noise %d, filtered %d in %d ms',
                     self.cfg.get('folder'), fetched, summary['added'], summary['duplicates'], noise, filtered, duration_ms)
            return {'ok': True, 'fetched': fetched, 'added': summary['added'], 'duplicates': summary['duplicates'],
                    'noise': noise, 'filtered': filtered, 'duration_ms': duration_ms}

    def run(self):
        interval = int(self.cfg.get('poll_interval_s') or 120)
        self._backoff = interval
        while not self._stop.is_set():
            try:
                self.sync_once()
                self._backoff = interval
            except Exception as exc:  # noqa: BLE001 - keep polling; the error is on /api/status
                self._backoff = min(max(60, self._backoff * 2), MAX_BACKOFF_S)
                log.error('poll failed (%s); next attempt in %d s', exc, self._backoff)
            self.next_poll_at = time.time() + self._backoff
            self._stop.wait(self._backoff)

    def stop(self):
        self._stop.set()

    def status(self):
        folders = self.state.get('folders', {})
        inbox = folders.get(self.cfg.get('folder'), {})
        next_in = None
        if self.next_poll_at:
            next_in = max(0, int(self.next_poll_at - time.time()))
        return {
            'connected': self.connected,
            'provider': self.cfg.get('provider_preset'),
            'mailbox': self.cfg.get('username') or None,
            'host': self.cfg.get('host'),
            'folder': self.cfg.get('folder'),
            'sent_folder': self.cfg.get('sent_folder') or None,
            'last_sync_at': self.last_sync_at,
            'uidvalidity': inbox.get('uidvalidity'),
            'last_uid': inbox.get('last_uid', 0),
            'counts': {'fetched': self.counts.get('fetched', 0), 'deduped': self.counts.get('deduped', 0),
                       'noise': self.counts.get('noise', 0), 'filtered': self.counts.get('filtered', 0)},
            'last_error': self.last_error,
            'next_poll_in_s': next_in,
            'polling': self.is_alive(),
        }


# ---------------------------------------------------------------------------
# Application state shared by the HTTP handler
# ---------------------------------------------------------------------------

class App:
    """Holds config, store, poller and token; created once per process."""

    def __init__(self, site_dir, data_dir, config_path, token, no_poll=False, cfg=None):
        self.site_dir = os.path.abspath(site_dir)
        self.data_dir = os.path.abspath(os.path.expanduser(data_dir))
        self.config_path = os.path.abspath(config_path)
        self.token = token
        self.no_poll = no_poll
        self.started = time.time()
        self._lock = threading.Lock()
        os.makedirs(self.data_dir, exist_ok=True)
        self.cfg = cfg if cfg is not None else load_config(self.config_path)
        set_salt(load_salt(self.data_dir))
        self.store = Store(self.data_dir)
        loaded = self.store.load()
        if loaded:
            log.info('loaded %d records from %s', loaded, self.store.path)
        self.poller = None

    def mode(self):
        return 'imap' if self.poller is not None and self.poller.is_alive() else 'idle'

    def write_live_js(self):
        """Rewrite ``<site>/js/live-data.js`` under the current ``live_data_plaintext`` setting."""
        return self.store.write_live_js(self.site_dir, self.cfg.get('live_data_plaintext', False))

    def check_token(self, presented):
        """Constant-time token comparison."""
        if not presented or not self.token:
            return False
        return hmac.compare_digest(presented.encode('utf-8'), self.token.encode('utf-8'))

    def start_poller(self):
        """Start the poller when polling is allowed and a mailbox plus secret exist."""
        with self._lock:
            if self.no_poll:
                log.info('--no-poll: serving only')
                return None
            if not self.cfg.get('username') or not self.cfg.get('host'):
                log.info('no mailbox configured; idle until Settings saves a connector config')
                return None
            if self.cfg.get('auth') != 'password':
                log.warning('auth %r is not implemented; idle', self.cfg.get('auth'))
                return None
            secret_value = secret(self.cfg.get('username', ''))
            if not secret_value:
                log.warning('no mailbox secret (VOC_MAIL_SECRET or Keychain service %r); idle', KEYCHAIN_SERVICE)
                return None
            self.poller = Poller(self.cfg, self.store, self.site_dir, self.data_dir, secret_value)
            self.poller.start()
            log.info('poller started for %s@%s every %ss', self.cfg['username'], self.cfg['host'], self.cfg['poll_interval_s'])
            return self.poller

    def restart_poller(self):
        old = self.poller
        if old is not None:
            old.stop()
        self.poller = None
        return self.start_poller()

    def sync_now(self):
        """Run one poll through the running poller or an ad-hoc one.

        Under ``--no-poll`` or without a configured mailbox nothing touches IMAP: the result is
        ``{'ok': False, 'reason': 'no mailbox configured', 'detail': ...}`` (answered as HTTP 200).
        """
        if self.no_poll:
            return {'ok': False, 'reason': 'no mailbox configured', 'mode': self.mode(),
                    'detail': '--no-poll: this sidecar never touches the mailbox; restart it without --no-poll to sync'}
        poller = self.poller
        if poller is None:
            if not self.cfg.get('username') or not self.cfg.get('host'):
                return {'ok': False, 'reason': 'no mailbox configured', 'mode': self.mode(), 'detail': self._idle_reason()}
            poller = Poller(self.cfg, self.store, self.site_dir, self.data_dir)
        return poller.sync_once()

    def status(self):
        if self.poller is not None:
            status = self.poller.status()
        else:
            status = {
                'connected': False, 'provider': self.cfg.get('provider_preset'), 'mailbox': self.cfg.get('username') or None,
                'host': self.cfg.get('host'), 'folder': self.cfg.get('folder'), 'sent_folder': self.cfg.get('sent_folder') or None,
                'last_sync_at': None, 'uidvalidity': None, 'last_uid': 0,
                'counts': {'fetched': 0, 'deduped': 0, 'noise': 0, 'filtered': 0},
                'last_error': None if self.no_poll else self._idle_reason(), 'next_poll_in_s': None, 'polling': False,
            }
        status['mode'] = self.mode()
        status['total_records'] = self.store.count()
        status['live_data_plaintext'] = bool(self.cfg.get('live_data_plaintext', False))
        status['data_dir'] = self.data_dir
        status['server_time'] = utc_now_iso()
        return status

    def _idle_reason(self):
        if not self.cfg.get('username'):
            return 'No mailbox configured. Save a connector config in Settings.'
        if self.cfg.get('auth') != 'password':
            return 'auth %r is a roadmap item; use an app password.' % self.cfg.get('auth')
        return 'No mailbox secret found. Set VOC_MAIL_SECRET or add a Keychain item for service "voc-mail".'

    def save_report(self, filename, markup):
        """Save report HTML under data_dir/reports/ with a sanitized filename; returns the path."""
        name = re.sub(r'[^A-Za-z0-9._-]+', '-', str(filename or '')).strip('.-')[:120]
        if not name:
            name = 'report-%s' % datetime.now().strftime('%Y%m%d-%H%M%S')
        if not name.lower().endswith(('.html', '.htm')):
            name += '.html'
        reports_dir = os.path.join(self.data_dir, 'reports')
        path = os.path.join(reports_dir, name)
        _atomic_write(path, markup, mode=0o600)
        return path


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

_EXTRA_MIME = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.csv': 'text/csv; charset=utf-8',
    '.eml': 'message/rfc822',
    '.mbox': 'application/mbox',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
}


def make_handler(app):
    """Build a request handler class bound to ``app``."""

    class Handler(SimpleHTTPRequestHandler):
        server_version = 'voc-sidecar/' + VERSION
        sys_version = ''
        extensions_map = dict(SimpleHTTPRequestHandler.extensions_map)
        extensions_map.update(_EXTRA_MIME)
        extensions_map[''] = 'application/octet-stream'

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=app.site_dir, **kwargs)

        # -- plumbing -------------------------------------------------------

        def log_message(self, fmt, *args):
            log.debug('%s %s', self.address_string(), fmt % args)

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            super().end_headers()

        def _json(self, status, obj):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def _error(self, status, message):
            self._json(status, {'ok': False, 'error': message})

        def _read_json(self, max_bytes=MAX_BODY_BYTES):
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                raise ValueError('bad Content-Length')
            if length < 0 or length > max_bytes:
                raise ValueError('body too large (limit %d bytes)' % max_bytes)
            raw = self.rfile.read(length) if length else b''
            if not raw.strip():
                return {}
            try:
                return json.loads(raw.decode('utf-8'))
            except (UnicodeDecodeError, ValueError):
                raise ValueError('body is not valid JSON')
            except RecursionError:
                raise ValueError('body is nested too deeply')

        def _authorized(self):
            token = self.headers.get('X-VoC-Token', '')
            if not token:
                auth = self.headers.get('Authorization', '')
                if auth.lower().startswith('bearer '):
                    token = auth[7:].strip()
            return app.check_token(token)

        def _route(self):
            parts = urlsplit(self.path)
            return parts.path.rstrip('/') or '/', parse_qs(parts.query)

        # -- verbs ----------------------------------------------------------

        def do_OPTIONS(self):
            path, _query = self._route()
            self.send_response(204)
            self.send_header('Allow', 'GET, POST, OPTIONS' if path.startswith('/api/') else 'GET, HEAD, OPTIONS')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def _static_segments(self):
            """Segments of the request path exactly as SimpleHTTPRequestHandler.translate_path resolves them
            (percent-decoded, dot-segments collapsed), so the deny rules see '/./server', '/%73erver' and
            '/js/../server' as '/server'."""
            norm = posixpath.normpath(unquote(urlsplit(self.path).path))
            return [seg for seg in norm.split('/') if seg and seg not in ('.', '..')]

        def _static_forbidden(self, path):
            # The site dir is the project root: never serve the sidecar's own folder (config, state) nor any
            # dot-folder or dot-file (.claude/launch.json, .git, .DS_Store).
            segments = self._static_segments()
            if segments and (segments[0] == 'server' or any(seg.startswith('.') for seg in segments)):
                return True
            return path == '/server' or path.startswith('/server/')

        def list_directory(self, path):
            # No folder is enumerable. '/' still serves index.html because send_head looks for it first.
            self._error(404, 'not found')
            return None

        def _same_origin_request(self):
            """True when the operator's own page (or a direct navigation) made the request.

            Modern browsers send ``Sec-Fetch-Site`` (``same-origin`` for the page's own script tags and fetches,
            ``none`` for a typed URL, ``cross-site`` for another page's ``<script src>``). Without it, the
            ``Origin``/``Referer`` must name this host; a request carrying neither is refused.
            """
            site = self.headers.get('Sec-Fetch-Site')
            if site is not None:
                return site.strip().lower() in ('same-origin', 'none')
            source = self.headers.get('Origin') or self.headers.get('Referer') or ''
            if not source:
                return False
            parts = urlsplit(source)
            host = (self.headers.get('Host') or '').strip().lower()
            return parts.scheme == 'http' and bool(host) and parts.netloc.lower() == host

        def _live_js_forbidden(self, path):
            # js/live-data.js is the whole mailbox export, not site code: only the page itself (same origin)
            # or a token holder may read it, never another origin's <script src>.
            return path == '/js/live-data.js' and not (self._authorized() or self._same_origin_request())

        def do_HEAD(self):
            path, _query = self._route()
            if path.startswith('/api/'):
                return self._error(405, 'method not allowed')
            if self._static_forbidden(path):
                return self._error(404, 'not found')
            if self._live_js_missing(path):
                return self._live_js_stub()
            if self._live_js_forbidden(path):
                return self._error(403, 'live-data.js is served only to the site itself or with the API token')
            return super().do_HEAD()

        def _live_js_stub(self):
            # The browser loads js/live-data.js unconditionally; before the first poll the file does
            # not exist yet. Answer with an empty live set so served mode has no console error.
            body = LIVE_JS_EMPTY.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def _live_js_missing(self, path):
            return path == '/js/live-data.js' and not os.path.isfile(os.path.join(app.site_dir, 'js', 'live-data.js'))

        def do_GET(self):
            path, query = self._route()
            if not path.startswith('/api/'):
                if self._static_forbidden(path):
                    return self._error(404, 'not found')
                if self._live_js_missing(path):
                    return self._live_js_stub()
                if self._live_js_forbidden(path):
                    return self._error(403, 'live-data.js is served only to the site itself or with the API token')
                return super().do_GET()
            if path == '/api/health':
                return self._json(200, {
                    'ok': True, 'version': VERSION, 'mode': app.mode(),
                    'last_sync_at': app.poller.last_sync_at if app.poller else None,
                    'uptime_s': int(time.time() - app.started), 'records': app.store.count(),
                    'poll_interval_s': app.cfg.get('poll_interval_s'),
                    'live_data_plaintext': bool(app.cfg.get('live_data_plaintext', False)),
                })
            if not self._authorized():
                return self._error(401, 'missing or invalid X-VoC-Token')
            if path == '/api/status':
                return self._json(200, app.status())
            if path == '/api/records':
                since = (query.get('since') or [''])[0]
                limit = (query.get('limit') or ['500'])[0]
                page = app.store.since(since, limit)
                page['server_time'] = utc_now_iso()
                return self._json(200, page)
            if path == '/api/config':
                cfg = {k: v for k, v in app.cfg.items() if not SECRET_KEY_RE.search(k)}
                return self._json(200, cfg)
            if path in ('/api/sync', '/api/ingest', '/api/report'):
                return self._error(405, 'use POST')
            return self._error(404, 'unknown endpoint')

        def do_POST(self):
            path, _query = self._route()
            if not path.startswith('/api/'):
                return self._error(405, 'method not allowed')
            if path == '/api/health':
                return self._error(405, 'use GET')
            if not self._authorized():
                return self._error(401, 'missing or invalid X-VoC-Token')
            try:
                body = self._read_json(INGEST_MAX_BYTES if path == '/api/ingest' else MAX_BODY_BYTES)
            except ValueError as exc:
                return self._error(400, str(exc))
            try:
                if path == '/api/config':
                    return self._post_config(body)
                if path == '/api/sync':
                    return self._post_sync()
                if path == '/api/ingest':
                    return self._post_ingest(body)
                if path == '/api/report':
                    return self._post_report(body)
            except (TypeError, AttributeError, KeyError, IndexError, OverflowError, RecursionError) as exc:
                # A wrongly shaped payload must answer 400, not close the socket (webhook senders retry forever).
                log.warning('%s rejected: %s: %s', path, type(exc).__name__, exc)
                return self._error(400, 'malformed request (%s)' % type(exc).__name__)
            except Exception as exc:  # noqa: BLE001 - last resort: a JSON 500 instead of a dropped connection
                log.exception('%s failed', path)
                return self._error(500, 'internal error (%s)' % type(exc).__name__)
            if path in ('/api/status', '/api/records'):
                return self._error(405, 'use GET')
            return self._error(404, 'unknown endpoint')

        # -- POST handlers ---------------------------------------------------

        def _post_config(self, body):
            if not isinstance(body, dict):
                return self._error(400, 'config must be a JSON object')
            merged = dict(app.cfg)
            merged.update(body)
            try:
                cfg = validate_config(merged)
                save_config(app.config_path, cfg)
            except ConfigError as exc:
                return self._error(400, str(exc))
            except OSError as exc:
                return self._error(500, 'could not write config: %s' % exc)
            app.cfg = cfg
            app.restart_poller()
            try:
                app.write_live_js()   # a flipped live_data_plaintext takes effect now, not at the next poll
            except OSError as exc:
                log.error('could not rewrite live-data.js: %s', exc)
            log.info('config saved to %s; mode %s', app.config_path, app.mode())
            return self._json(200, {'ok': True, 'config': cfg, 'mode': app.mode(), 'status': app.status()})

        def _post_sync(self):
            try:
                result = app.sync_now()
            except ConfigError as exc:
                return self._error(409, str(exc))
            except NotImplementedError as exc:
                return self._error(501, str(exc))
            except Exception as exc:  # noqa: BLE001 - surface IMAP/network errors to the UI
                return self._error(502, '%s: %s' % (type(exc).__name__, exc))
            return self._json(200, result)

        def _post_ingest(self, body):
            try:
                rec = normalize_ingest(body, app.cfg)
            except ValueError as exc:
                return self._error(400, str(exc))
            if rec['is_noise'] and app.cfg.get('skip_autoreplies', True):
                return self._json(200, {'ok': True, 'id': rec['id'], 'duplicate': False, 'skipped': rec['noise_reason']})
            ok, reason = passes_filters(rec, app.cfg)
            if not ok:
                return self._json(200, {'ok': True, 'id': rec['id'], 'duplicate': False, 'skipped': reason})
            rec_id, duplicate = app.store.upsert(rec)
            if not duplicate:
                try:
                    app.store.save()
                    app.write_live_js()
                except OSError as exc:
                    log.error('could not persist ingested record: %s', exc)
            return self._json(200, {'ok': True, 'id': rec_id, 'duplicate': duplicate})

        def _post_report(self, body):
            if not isinstance(body, dict) or not isinstance(body.get('html'), str) or not body['html'].strip():
                return self._error(400, 'expected {filename, html}')
            try:
                path = app.save_report(body.get('filename'), body['html'])
            except OSError as exc:
                return self._error(500, 'could not save report: %s' % exc)
            return self._json(200, {'ok': True, 'path': path})

    return Handler


def make_server(app, host=DEFAULT_HOST, port=DEFAULT_PORT):
    """Create the ThreadingHTTPServer bound to ``host:port`` (port 0 = ephemeral)."""
    server = ThreadingHTTPServer((host, port), make_handler(app))
    server.daemon_threads = True
    return server


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _default_site_dir():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build_parser():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(
        prog='voc_server.py',
        description='L-Nutra Voice of the Customer sidecar: serves the site and polls an IMAP mailbox read-only.')
    parser.add_argument('--site-dir', default=_default_site_dir(), help='static site directory (default: parent of server/)')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help='port on 127.0.0.1 (default 8765)')
    parser.add_argument('--data-dir', default=None,
                        help='records, state and reports (default: config data_dir or ~/Library/Application Support/voc)')
    parser.add_argument('--config', default=os.path.join(here, 'config.json'), help='connector config JSON (default server/config.json)')
    parser.add_argument('--once', action='store_true', help='poll once, write records and live-data.js, then exit')
    parser.add_argument('--no-poll', action='store_true', help='serve the site and API only; never touch the mailbox')
    parser.add_argument('--token', default=None, help='API token (default: $VOC_API_TOKEN or a fresh random token)')
    parser.add_argument('--verbose', action='store_true', help='debug logging, including one line per HTTP request')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    logging.basicConfig(stream=sys.stderr, level=logging.DEBUG if args.verbose else logging.INFO,
                        format='%(asctime)s %(levelname)s %(name)s: %(message)s', datefmt='%Y-%m-%dT%H:%M:%S')
    token = args.token or os.environ.get('VOC_API_TOKEN', '').strip() or secrets.token_urlsafe(24)
    try:
        cfg = load_config(args.config)
    except (ConfigError, ValueError) as exc:
        log.error('invalid config %s: %s', args.config, exc)
        return 2
    data_dir = args.data_dir or cfg.get('data_dir') or DEFAULT_DATA_DIR
    try:
        app = App(args.site_dir, data_dir, args.config, token, no_poll=args.no_poll, cfg=cfg)
    except (ConfigError, ValueError, OSError) as exc:
        log.error('startup failed: %s', exc)
        return 2

    if args.once:
        try:
            result = app.sync_now()
        except NotImplementedError as exc:
            log.error('%s', exc)
            return 3
        except Exception as exc:  # noqa: BLE001
            log.error('poll failed: %s', exc)
            return 1
        if not result.get('ok'):
            log.error('%s: %s', result.get('reason'), result.get('detail') or '')
            return 3
        print(json.dumps({'ok': True, 'fetched': result['fetched'], 'added': result['added'],
                          'duplicates': result['duplicates'], 'noise': result['noise'],
                          'records': app.store.count(), 'data_dir': app.data_dir,
                          'live_js': os.path.join(app.site_dir, 'js', 'live-data.js')}, indent=2))
        return 0

    try:
        server = make_server(app, DEFAULT_HOST, args.port)
    except OSError as exc:
        log.error('cannot bind 127.0.0.1:%d: %s', args.port, exc)
        return 2
    app.start_poller()
    try:
        app.write_live_js()   # bring <site>/js/live-data.js in line with live_data_plaintext (scrubs a stale plaintext copy)
    except OSError as exc:
        log.error('could not rewrite live-data.js: %s', exc)
    if '/Mobile Documents/' in app.data_dir or 'iCloud' in app.data_dir:
        log.warning('data_dir is inside iCloud Drive; records.json may sync and evict. Prefer the default data_dir.')
    print('L-Nutra VoC sidecar %s' % VERSION)
    print('TOKEN    = %s' % token)
    print('URL      = http://%s:%d/' % (DEFAULT_HOST, args.port))
    print('MODE     = %s' % app.mode())
    print('SITE     = %s' % app.site_dir)
    print('DATA_DIR = %s' % app.data_dir)
    print('Paste the token into Settings > Connector. Ctrl-C stops the server.')
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        log.info('shutting down')
    finally:
        if app.poller is not None:
            app.poller.stop()
        server.server_close()
        try:
            if app.store.save():
                app.write_live_js()
        except OSError as exc:
            log.error('final save failed: %s', exc)
    return 0


if __name__ == '__main__':
    sys.exit(main())
