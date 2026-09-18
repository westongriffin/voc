"""Unit tests for the L-Nutra VoC sidecar.

Run from the project root:
    python3 -m unittest server/test_voc_server.py
"""

import email
import email.policy
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import voc_server as vs  # noqa: E402

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(PROJECT_ROOT, 'samples')

INLINE_MULTIPART = (
    'Message-ID: <abc123@mail.example.com>\r\n'
    'Date: Mon, 14 Sep 2026 10:22:00 -0500\r\n'
    'From: =?utf-8?Q?Ren=C3=A9e_Dubois?= <Renee.Dubois@Example.net>\r\n'
    'To: L-Nutra Support <support@l-nutra.com>\r\n'
    'Cc: <orders@l-nutra.com>\r\n'
    'Subject: =?utf-8?B?UmU6IE9yZGVyICMxNDY4MDIg4oCUIA==?=\r\n'
    ' =?utf-8?B?RmFzdCBCYXIgY2Fmw6kgbW9jaGEgdGFzdGVzIHN0YWxl?=\r\n'
    'MIME-Version: 1.0\r\n'
    'Content-Type: multipart/mixed; boundary="mixed-1"\r\n'
    '\r\n'
    '--mixed-1\r\n'
    'Content-Type: multipart/alternative; boundary="alt-1"\r\n'
    '\r\n'
    '--alt-1\r\n'
    'Content-Type: text/plain; charset="utf-8"\r\n'
    'Content-Transfer-Encoding: quoted-printable\r\n'
    '\r\n'
    'Hi team,\r\n'
    '\r\n'
    'The second box of Fast Bar caf=C3=A9 mocha tastes stale and I=E2=80=99m not h=\r\n'
    'appy. Order #146802.\r\n'
    '\r\n'
    'Ren=C3=A9e\r\n'
    '\r\n'
    'On Tue, 8 Sep 2026 at 09:41, L-Nutra Support <support@l-nutra.com> wrote:\r\n'
    '> Hi Ren=C3=A9e, could you send the lot number?\r\n'
    '> Maya R.\r\n'
    '\r\n'
    '--alt-1\r\n'
    'Content-Type: text/html; charset="utf-8"\r\n'
    'Content-Transfer-Encoding: quoted-printable\r\n'
    '\r\n'
    '<html><body><p>Hi team,</p><p>HTML version</p></body></html>\r\n'
    '--alt-1--\r\n'
    '--mixed-1\r\n'
    'Content-Type: image/jpeg; name="IMG_1.jpg"\r\n'
    'Content-Disposition: attachment; filename="IMG_1.jpg"\r\n'
    'Content-Transfer-Encoding: base64\r\n'
    '\r\n'
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a\r\n'
    '--mixed-1--\r\n'
)


def parse(text):
    return email.message_from_bytes(text.encode('utf-8'), policy=email.policy.default)


def base_cfg(**overrides):
    cfg = vs.validate_config({})
    cfg.update(overrides)
    return cfg


class StripQuotesTests(unittest.TestCase):
    def test_on_wrote_shape(self):
        text = ('Thanks for the reply.\n\nThe bars taste stale.\n\n'
                'On Tue, 8 Sep 2026 at 09:41, L-Nutra Support <support@l-nutra.com>\nwrote:\n'
                '> Hi, could you send the lot number?\n> Maya R.\n')
        out = vs.strip_quotes(text)
        self.assertEqual(out, 'Thanks for the reply.\n\nThe bars taste stale.')

    def test_original_message_shape(self):
        text = ('Still not arrived.\r\n\r\n-----Original Message-----\r\nFrom: support@l-nutra.com\r\n'
                'Sent: Monday\r\nTo: me\r\nSubject: Re: order\r\n\r\nWe shipped it.\r\n')
        self.assertEqual(vs.strip_quotes(text), 'Still not arrived.')

    def test_from_sent_shape_and_underscores(self):
        text = ('Please cancel my subscription.\n\n'
                'From: Devon K.\nSent: Tuesday, September 8, 2026 9:41 AM\nTo: Customer\nSubject: RE: charged twice\n\n'
                'Hi, we see the charge.\n')
        self.assertEqual(vs.strip_quotes(text), 'Please cancel my subscription.')
        text2 = 'Charged twice this month.\n________________________________\nFrom: agent\nSent: x\n'
        self.assertEqual(vs.strip_quotes(text2), 'Charged twice this month.')

    def test_quoted_lines_and_signature(self):
        text = 'Top line\n> quoted one\n>quoted two\nBottom line\n-- \nSig Name\nSent from my iPhone\n'
        self.assertEqual(vs.strip_quotes(text), 'Top line\n\nBottom line')
        self.assertEqual(vs.strip_quotes(''), '')
        self.assertEqual(vs.strip_quotes(None), '')


class NormalizeTests(unittest.TestCase):
    def test_inline_multipart_message(self):
        msg = parse(INLINE_MULTIPART)
        rec = vs.normalize(msg, base_cfg(), 'inbound', uid=42, folder='INBOX')
        self.assertEqual(rec['subject'], 'Re: Order #146802 — Fast Bar café mocha tastes stale')
        self.assertEqual(rec['from_name'], 'Renée Dubois')
        self.assertEqual(rec['from_email'], 'renee.dubois@example.net')
        self.assertEqual(rec['to'], ['support@l-nutra.com'])
        self.assertEqual(rec['cc'], ['orders@l-nutra.com'])
        self.assertEqual(rec['date'], '2026-09-14T15:22:00Z')
        self.assertEqual(rec['message_id'], 'abc123@mail.example.com')
        self.assertEqual(rec['thread_id'], 'abc123@mail.example.com')
        self.assertTrue(rec['id'].startswith('em_') and len(rec['id']) == 19)
        self.assertIn('café mocha tastes stale and I’m not happy', rec['text'])
        self.assertNotIn('=E2=80=99', rec['text'])
        self.assertNotIn('wrote:', rec['text'])
        self.assertNotIn('Maya R.', rec['text'])
        self.assertNotIn('HTML version', rec['text'])
        self.assertEqual(len(rec['attachments']), 1)
        self.assertEqual(rec['attachments'][0]['name'], 'IMG_1.jpg')
        self.assertEqual(rec['attachments'][0]['type'], 'image/jpeg')
        self.assertGreater(rec['attachments'][0]['size'], 0)
        self.assertEqual(rec['headers']['content_type'], 'multipart/mixed')
        self.assertIsNone(rec['headers']['auto_submitted'])
        self.assertEqual(rec['direction'], 'inbound')
        self.assertEqual(rec['source'], 'imap')
        self.assertFalse(rec['is_noise'])
        self.assertFalse(rec['restricted'])
        self.assertEqual(rec['uid'], 42)
        for key in ('message_id', 'thread_id', 'in_reply_to', 'references', 'date', 'from_name', 'from_email', 'to',
                    'cc', 'subject', 'text', 'html', 'direction', 'attachments', 'headers', 'source'):
            self.assertIn(key, rec)

    def test_html_only_and_agent_outbound(self):
        raw = ('Message-ID: <h1@x>\r\nDate: Tue, 8 Sep 2026 16:12:30 +0200\r\nFrom: Maya <support@l-nutra.com>\r\n'
               'To: a@b.c\r\nSubject: Re: hi\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'
               '<html><head><style>p{}</style></head><body><p>We shipped a <b>replacement</b>.</p>'
               '<div class="gmail_quote">On Mon, 7 Sep 2026 at 10:00, a@b.c wrote:<br>&gt; leaking</div></body></html>')
        rec = vs.normalize(parse(raw), base_cfg(agent_addresses=['Support@L-Nutra.com']), 'inbound')
        self.assertEqual(rec['text'], 'We shipped a replacement.')
        self.assertEqual(rec['direction'], 'outbound')
        self.assertEqual(rec['date'], '2026-09-08T14:12:30Z')

    def test_sample_files_when_present(self):
        path = os.path.join(SAMPLES, 'sample.eml')
        if not os.path.exists(path):
            self.skipTest('samples/sample.eml not present')
        with open(path, 'rb') as fh:
            msg = email.message_from_bytes(fh.read(), policy=email.policy.default)
        rec = vs.normalize(msg, base_cfg(), 'inbound')
        self.assertIn('L-Drink', rec['subject'])
        self.assertIn('leaked all over the box', rec['text'])
        self.assertEqual(len(rec['attachments']), 1)
        path2 = os.path.join(SAMPLES, 'sample-quoted-rfc2047.eml')
        if os.path.exists(path2):
            with open(path2, 'rb') as fh:
                rec2 = vs.normalize(email.message_from_bytes(fh.read(), policy=email.policy.default), base_cfg(), 'inbound')
            self.assertEqual(rec2['from_name'], 'Renée Dubois')
            self.assertIn('café mocha', rec2['subject'])
            self.assertNotIn('wrote:', rec2['text'])
            self.assertEqual(rec2['thread_id'], 'support-88213@l-nutra.com')


class NoiseTests(unittest.TestCase):
    def test_auto_reply(self):
        msg = parse('From: a@b.c\r\nSubject: Automatic reply: order\r\nAuto-Submitted: auto-replied\r\n\r\nI am away.')
        self.assertEqual(vs.is_noise(msg), 'auto_reply')
        msg = parse('From: a@b.c\r\nSubject: Out of Office\r\n\r\nback Monday')
        self.assertEqual(vs.is_noise(msg), 'auto_reply')
        msg = parse('From: a@b.c\r\nSubject: hi\r\nX-Auto-Response-Suppress: All\r\n\r\nx')
        self.assertEqual(vs.is_noise(msg), 'auto_reply')

    def test_bounce(self):
        msg = parse('From: Mail Delivery Subsystem <MAILER-DAEMON@mx.example.com>\r\nSubject: Undelivered Mail\r\n'
                    'Content-Type: multipart/report; report-type=delivery-status; boundary="r"\r\n\r\n--r\r\n--r--\r\n')
        self.assertEqual(vs.is_noise(msg), 'bounce')
        msg = parse('From: postmaster@example.com\r\nSubject: anything\r\n\r\nx')
        self.assertEqual(vs.is_noise(msg), 'bounce')

    def test_newsletter(self):
        msg = parse('From: news@brand.com\r\nSubject: September deals\r\nList-Unsubscribe: <mailto:u@brand.com>\r\n'
                    'Precedence: bulk\r\n\r\nBuy now')
        self.assertEqual(vs.is_noise(msg), 'newsletter')
        msg = parse('From: news@brand.com\r\nSubject: digest\r\nList-Id: <list.brand.com>\r\n\r\nx')
        self.assertEqual(vs.is_noise(msg), 'newsletter')

    def test_normal(self):
        msg = parse('From: Marisol <m@example.com>\r\nSubject: Re: Leaking L-Drink\r\nAuto-Submitted: no\r\n\r\nStill leaking.')
        self.assertIsNone(vs.is_noise(msg))
        self.assertIsNone(vs.noise_reason({}, 'Order #145233 still not arrived', 'c@d.e', 'text/plain'))


class FilterAndRedactTests(unittest.TestCase):
    def test_sender_and_subject_filters(self):
        rec = {'from_email': 'noreply@shopify.com', 'subject': 'Your order shipped', 'direction': 'inbound'}
        cfg = base_cfg(sender_deny=['@shopify.com'])
        self.assertEqual(vs.passes_filters(rec, cfg), (False, 'sender_deny'))
        cfg = base_cfg(sender_allow=['example.com'])
        self.assertEqual(vs.passes_filters(rec, cfg), (False, 'sender_allow'))
        rec2 = {'from_email': 'jo@mail.example.com', 'subject': 'Charged twice', 'direction': 'inbound'}
        self.assertEqual(vs.passes_filters(rec2, cfg), (True, None))
        cfg = base_cfg(subject_exclude='^your order')
        self.assertEqual(vs.passes_filters(rec, cfg), (False, 'subject_exclude'))
        cfg = base_cfg(subject_include='order')
        self.assertEqual(vs.passes_filters(rec2, cfg), (False, 'subject_include'))

    def test_restricted_redaction(self):
        raw = ('Message-ID: <r1@x>\r\nIn-Reply-To: <r0@x>\r\nReferences: <r0@x>\r\n'
               'Date: Tue, 8 Sep 2026 16:12:30 +0000\r\nFrom: Pat <pat@example.org>\r\n'
               'To: med.ed@l-nutra.com, jane.doe@gmail.com\r\nCc: dr.smith@clinic.org\r\n'
               'Subject: My A1c after ProLon, metformin question\r\n'
               'Content-Type: multipart/mixed; boundary="m"\r\n\r\n'
               '--m\r\nContent-Type: text/plain\r\n\r\nMy A1c dropped to 6.1 on metformin.\r\n'
               '--m\r\nContent-Type: application/pdf; name="labs-jane.pdf"\r\n'
               'Content-Disposition: attachment; filename="labs-jane.pdf"\r\n\r\n%PDF-1.4 x\r\n--m--\r\n')
        cfg = base_cfg()
        rec = vs.normalize(parse(raw), cfg, 'inbound')
        self.assertTrue(rec['restricted'])
        stored = vs.finalize(rec, cfg)
        self.assertTrue(stored['redacted'])
        self.assertEqual(stored['text'], vs.REDACTED_TEXT)
        self.assertEqual(stored['subject'], vs.REDACTED_SUBJECT)
        self.assertIsNone(stored['from_email'])
        self.assertEqual(stored['from_name'], 'Redacted')
        self.assertEqual(stored['from_hash'], vs.hash_email('pat@example.org'))
        self.assertEqual(len(stored['from_hash']), 16)
        # Company-owned addresses stay readable; every other party becomes <hash>@redacted.invalid.
        self.assertEqual(stored['to'][0], 'med.ed@l-nutra.com')
        self.assertEqual(stored['to'][1], vs.hash_email('jane.doe@gmail.com') + '@' + vs.REDACTED_DOMAIN)
        self.assertEqual(stored['cc'], [vs.hash_email('dr.smith@clinic.org') + '@' + vs.REDACTED_DOMAIN])
        self.assertEqual(stored['attachments'], [{'name': '', 'type': '', 'size': rec['attachments'][0]['size']}])
        for key in ('message_id', 'in_reply_to', 'thread_id'):
            self.assertTrue(stored[key].startswith('redacted-'), key)
        self.assertEqual(stored['references'], ['redacted-' + vs.hash_msgid('r0@x')])
        self.assertEqual(stored['thread_id'], stored['references'][0])   # threading survives redaction
        dumped = json.dumps(stored).lower()
        for leak in ('pat@example.org', 'jane.doe', 'clinic.org', 'a1c', 'metformin', 'labs-jane', 'pdf', 'r1@x', 'r0@x'):
            self.assertNotIn(leak, dumped, leak)
        # Hashes are keyed by the per-install salt: the same address hashes differently under another salt.
        previous = vs._SALT['value']
        try:
            vs.set_salt('a' * 64)
            one = vs.hash_email('pat@example.org')
            vs.set_salt('b' * 64)
            self.assertNotEqual(one, vs.hash_email('pat@example.org'))
            vs.set_salt('a' * 64)
            self.assertEqual(one, vs.hash_email('pat@example.org'))   # stable under the same salt
        finally:
            vs.set_salt(previous)
        cfg_off = base_cfg(redact_restricted_on_server=False)
        kept = vs.finalize(rec, cfg_off)
        self.assertIn('metformin', kept['text'])
        self.assertTrue(kept['restricted'])
        cfg_dom = base_cfg(restricted_recipients=[], restricted_domains=['clinic.example'])
        rec_dom = vs.normalize(parse(raw.replace('pat@example.org', 'pat@clinic.example')), cfg_dom, 'inbound')
        self.assertTrue(rec_dom['restricted'])


class ConfigTests(unittest.TestCase):
    def test_defaults_and_validation(self):
        cfg = vs.validate_config({'_comment': 'x', 'poll_interval_s': '300', 'port': '993', 'sender_deny': 'a@b.c, @d.e'})
        self.assertEqual(cfg['poll_interval_s'], 300)
        self.assertEqual(cfg['port'], 993)
        self.assertEqual(cfg['sender_deny'], ['a@b.c', '@d.e'])
        self.assertEqual(cfg['restricted_recipients'], ['Med.Ed@l-nutra.com'])
        with self.assertRaises(vs.ConfigError):
            vs.validate_config({'password': 'hunter2'})
        with self.assertRaises(vs.ConfigError):
            vs.validate_config({'poll_interval_s': 5})
        with self.assertRaises(vs.ConfigError):
            vs.validate_config({'since': '2026-13-40'})
        with self.assertRaises(vs.ConfigError):
            vs.validate_config({'subject_include': '('})
        with self.assertRaises(vs.ConfigError):
            vs.validate_config({'provider_preset': 'aol'})
        self.assertFalse(cfg['live_data_plaintext'])
        self.assertTrue(vs.validate_config({'live_data_plaintext': 'true'})['live_data_plaintext'])

    def test_control_characters_are_rejected(self):
        injected = 'INBOX"\r\nA1 SELECT INBOX\r\nA2 STORE 1:* +FLAGS (\\Seen)\r\nA3 SELECT "INBOX'
        for key in ('folder', 'sent_folder', 'username', 'host', 'subject_include'):
            with self.assertRaises(vs.ConfigError, msg=key):
                vs.validate_config({key: injected})
        with self.assertRaises(vs.ConfigError):
            vs.validate_config({'folder': 'INBOX\x00'})
        with self.assertRaises(vs.ConfigError):
            vs.validate_config({'agent_addresses': ['a@b\r\n.c']})
        self.assertEqual(vs.validate_config({'agent_addresses': ['a@b.c\n']})['agent_addresses'], ['a@b.c'])   # trailing newline is trimmed, not injected
        with self.assertRaises(vs.ConfigError):
            vs._imap_quote(injected)
        self.assertEqual(vs.validate_config({'folder': ' VoC/Reviews '})['folder'], 'VoC/Reviews')
        self.assertEqual(vs._imap_quote('Réclamations'), '"R&AOk-clamations"')

    def test_example_config_loads(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.example.json')
        cfg = vs.load_config(path)
        self.assertEqual(cfg['host'], 'imap.gmail.com')
        self.assertEqual(cfg['sent_folder'], '[Gmail]/Sent Mail')
        self.assertNotIn('_comment', cfg)
        for key in vs.DEFAULT_CONFIG:
            self.assertIn(key, cfg)

    def test_imap_date_and_quote(self):
        self.assertEqual(vs.imap_date('2026-08-01'), '01-Aug-2026')
        self.assertEqual(vs.imap_date('2025-12-31'), '31-Dec-2025')
        self.assertEqual(vs._imap_quote('[Gmail]/Sent Mail'), '"[Gmail]/Sent Mail"')

    def test_xoauth2_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            vs.connect(base_cfg(username='u@example.com', auth='xoauth2'), 'x')


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='voc-store-')
        self.store = vs.Store(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make(self, i, mid=None):
        return {'id': 'em_%016x' % i, 'message_id': mid or 'm%d@x' % i, 'date': '2026-09-%02dT10:00:00Z' % (1 + i),
                'subject': 's%d' % i, 'text': 't%d' % i}

    def test_upsert_dedupes_by_message_id(self):
        rec = self.make(1)
        self.assertEqual(self.store.upsert(rec), ('em_0000000000000001', False))
        again = dict(rec, id='em_other', text='changed')
        self.assertEqual(self.store.upsert(again), ('em_0000000000000001', True))
        self.assertEqual(self.store.count(), 1)
        self.assertEqual(self.store.upsert_many([self.make(2), self.make(2), self.make(3)]), {'added': 2, 'duplicates': 1})
        angle = self.make(4, mid='<M4@X>')
        self.store.upsert(angle)
        self.assertEqual(self.store.upsert(self.make(5, mid='m4@x')), ('em_0000000000000004', True))

    def test_since_pagination_walks_everything_once(self):
        for i in range(5):
            self.store.upsert(self.make(i))
        seen = []
        cursor = ''
        for _ in range(10):
            page = self.store.since(cursor, limit=2)
            seen.extend(r['id'] for r in page['records'])
            if not page['has_more']:
                break
            cursor = page['next_since']
        self.assertEqual(seen, ['em_%016x' % i for i in range(5)])
        self.assertEqual(page['total'], 5)
        page = self.store.since('2026-09-04T00:00:00Z', limit=500)
        self.assertEqual([r['id'] for r in page['records']], ['em_0000000000000003', 'em_0000000000000004'])
        self.assertIn('|', page['next_since'])
        empty = self.store.since(page['next_since'], limit=500)
        self.assertEqual(empty['records'], [])
        self.assertFalse(empty['has_more'])

    def test_save_load_and_live_js(self):
        self.store.upsert(dict(self.make(1), text='café </script>   ok'))
        self.assertTrue(self.store.save())
        self.assertFalse(self.store.save())
        other = vs.Store(self.tmp)
        self.assertEqual(other.load(), 1)
        self.assertEqual(other.all()[0]['text'], 'café </script>   ok')
        site = os.path.join(self.tmp, 'site')
        path = self.store.write_live_js(site, plaintext=True)
        with open(path, 'r', encoding='utf-8') as fh:
            text = fh.read()
        self.assertTrue(text.splitlines()[1].startswith('window.VOC_LIVE = ['))
        self.assertTrue(text.rstrip().endswith('];'))
        self.assertNotIn('</script>', text)
        self.assertNotIn(' ', text)
        body = text.split('window.VOC_LIVE = ', 1)[1].rstrip().rstrip(';')
        self.assertEqual(json.loads(body)[0]['text'], 'café </script>   ok')
        # The default (live_data_plaintext false) writes the empty set: no record text reaches the project folder.
        path = self.store.write_live_js(site)
        with open(path, 'r', encoding='utf-8') as fh:
            text = fh.read()
        self.assertTrue(text.rstrip().endswith(vs.LIVE_JS_EMPTY.strip()))
        self.assertNotIn('café', text)
        self.assertIn('live_data_plaintext', text)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='voc-server-')
        cls.site = os.path.join(cls.tmp, 'site')
        os.makedirs(os.path.join(cls.site, 'js'))
        with open(os.path.join(cls.site, 'index.html'), 'w', encoding='utf-8') as fh:
            fh.write('<!doctype html><title>t</title>')
        with open(os.path.join(cls.site, 'js', 'app.js'), 'w', encoding='utf-8') as fh:
            fh.write('window.x = 1;')
        cls.data = os.path.join(cls.tmp, 'data')
        cls.token = 'test-token-123'
        cls.app = vs.App(cls.site, cls.data, os.path.join(cls.tmp, 'config.json'), cls.token, no_poll=True)
        cls.server = vs.make_server(cls.app, '127.0.0.1', 0)
        cls.base = 'http://127.0.0.1:%d' % cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={'poll_interval': 0.1}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, method, path, body=None, token=None, raw_headers=None):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if body is not None:
            req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('X-VoC-Token', token)
        for key, value in (raw_headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                payload = resp.read()
                ctype = resp.headers.get('Content-Type', '')
                return resp.status, (json.loads(payload) if ctype.startswith('application/json') else payload), ctype
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            ctype = exc.headers.get('Content-Type', '')
            return exc.code, (json.loads(payload) if ctype.startswith('application/json') else payload), ctype

    def test_health_needs_no_token(self):
        status, body, _ = self.call('GET', '/api/health')
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])
        self.assertEqual(body['version'], vs.VERSION)
        self.assertEqual(body['mode'], 'idle')
        self.assertIn('uptime_s', body)
        self.assertIn('last_sync_at', body)

    def test_token_rejection(self):
        for path in ('/api/status', '/api/records', '/api/config'):
            status, body, _ = self.call('GET', path)
            self.assertEqual(status, 401, path)
            self.assertFalse(body['ok'])
        status, _b, _ = self.call('GET', '/api/status', token='wrong')
        self.assertEqual(status, 401)
        status, _b, _ = self.call('POST', '/api/sync', body={}, token='')
        self.assertEqual(status, 401)
        status, body, _ = self.call('GET', '/api/status', token=self.token)
        self.assertEqual(status, 200)
        self.assertFalse(body['connected'])
        self.assertEqual(body['mode'], 'idle')
        status, body, _ = self.call('GET', '/api/status', raw_headers={'Authorization': 'Bearer ' + self.token})
        self.assertEqual(status, 200)

    def test_ingest_records_and_report(self):
        payload = {'message_id': '<ingest-1@zapier>', 'from_email': 'Jo@Example.com', 'from_name': 'Jo',
                   'to': ['support@l-nutra.com'], 'subject': 'Charged twice', 'date': '2026-09-10T12:00:00Z',
                   'text': 'I was charged twice.\n\nOn Mon, someone wrote:\n> old'}
        status, body, _ = self.call('POST', '/api/ingest', body=payload, token=self.token)
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])
        self.assertFalse(body['duplicate'])
        first_id = body['id']
        status, body, _ = self.call('POST', '/api/ingest', body=payload, token=self.token)
        self.assertEqual(status, 200)
        self.assertTrue(body['duplicate'])
        self.assertEqual(body['id'], first_id)
        status, body, _ = self.call('GET', '/api/records?since=2026-09-01T00:00:00Z&limit=10', token=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(body['total'], 1)
        self.assertIn('server_time', body)
        rec = body['records'][0]
        self.assertEqual(rec['text'], 'I was charged twice.')
        self.assertEqual(rec['from_email'], 'jo@example.com')
        self.assertEqual(rec['direction'], 'inbound')
        self.assertTrue(os.path.exists(os.path.join(self.site, 'js', 'live-data.js')))
        status, body, _ = self.call('POST', '/api/ingest', body={'text': ''}, token=self.token)
        self.assertEqual(status, 400)
        status, body, _ = self.call('POST', '/api/report', body={'filename': '../../evil name?.html', 'html': '<h1>Weekly</h1>'},
                                    token=self.token)
        self.assertEqual(status, 200)
        self.assertTrue(body['path'].startswith(os.path.join(self.app.data_dir, 'reports')))
        self.assertEqual(os.path.basename(body['path']), 'evil-name-.html')
        self.assertTrue(os.path.exists(body['path']))

    def test_config_roundtrip_rejects_secrets(self):
        status, body, _ = self.call('GET', '/api/config', token=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(body['provider_preset'], 'gmail')
        status, body, _ = self.call('POST', '/api/config', body={'password': 'x'}, token=self.token)
        self.assertEqual(status, 400)
        status, body, _ = self.call('POST', '/api/config', body={'folder': 'VoC', 'poll_interval_s': 300}, token=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(body['config']['folder'], 'VoC')
        self.assertEqual(body['mode'], 'idle')
        self.assertTrue(os.path.exists(self.app.config_path))
        with open(self.app.config_path, 'r', encoding='utf-8') as fh:
            saved = json.load(fh)
        self.assertEqual(saved['poll_interval_s'], 300)
        self.assertNotIn('password', saved)
        status, body, _ = self.call('GET', '/api/health')
        self.assertEqual(body['poll_interval_s'], 300)
        self.assertFalse(body['live_data_plaintext'])

    def test_no_poll_sync_never_touches_the_mailbox(self):
        # --no-poll promises never to open the mailbox, even when a username and secret exist.
        original_connect, original_secret = vs.connect, vs.secret
        touched = []
        vs.connect = lambda *a, **k: touched.append('connect') or (_ for _ in ()).throw(AssertionError('IMAP opened'))
        vs.secret = lambda *a, **k: 'app-password'
        saved_cfg = dict(self.app.cfg)
        try:
            self.app.cfg.update({'username': 'support@example.com', 'host': 'imap.example.com'})
            status, body, _ = self.call('POST', '/api/sync', body={}, token=self.token)
            self.assertEqual(status, 200)
            self.assertFalse(body['ok'])
            self.assertEqual(body['reason'], 'no mailbox configured')
            self.assertIn('--no-poll', body['detail'])
            self.assertEqual(body['mode'], 'idle')
            self.assertEqual(touched, [])
            self.assertIsNone(self.app.poller)
        finally:
            vs.connect, vs.secret = original_connect, original_secret
            self.app.cfg = saved_cfg
        # Without --no-poll and without a mailbox the same shape comes back instead of a 409/traceback.
        app2 = vs.App(self.site, os.path.join(self.tmp, 'data2'), os.path.join(self.tmp, 'config2.json'), 't', no_poll=False)
        out = app2.sync_now()
        self.assertFalse(out['ok'])
        self.assertEqual(out['reason'], 'no mailbox configured')

    def test_ingest_rejects_malformed_payloads_with_400(self):
        # Wrong types must answer JSON (200 after coercion or 400), never drop the connection.
        coerced = [
            {'subject': 'typed', 'from_email': 123},
            {'subject': 'typed', 'headers': {'precedence': ['bulk']}},
            {'subject': 'typed', 'attachments': [{'size': 1e999, 'name': ['x']}]},
            {'subject': 'typed', 'to': {'a': 1}, 'cc': 'a@b.c;c@d.e', 'references': 5, 'message_id': {'x': 1}},
            {'subject': 'typed', 'direction': ['outbound'], 'restricted': {'x': 1}},
        ]
        for payload in coerced:
            status, body, ctype = self.call('POST', '/api/ingest', body=payload, token=self.token)
            self.assertIn(status, (200, 400), payload)
            self.assertTrue(ctype.startswith('application/json'), payload)
            self.assertIn('ok', body)
        rejected = [
            {'subject': 'typed', 'text': ['a']},
            {'subject': 'typed', 'date': 5},
            {'subject': 'typed', 'date': 'not a date'},
            [],
            'just a string',
        ]
        for payload in rejected:
            status, body, _ = self.call('POST', '/api/ingest', body=payload, token=self.token)
            self.assertEqual(status, 400, payload)
            self.assertFalse(body['ok'])
        req = urllib.request.Request(self.base + '/api/ingest', data=('[' * 100000).encode('utf-8'), method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('X-VoC-Token', self.token)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                status = resp.status
        except urllib.error.HTTPError as exc:
            status = exc.code
        self.assertEqual(status, 400)
        status, body, _ = self.call('POST', '/api/config', body={'folder': 'INBOX\r\nA1 STORE 1:* +FLAGS (\\Seen)'}, token=self.token)
        self.assertEqual(status, 400)
        self.assertIn('control characters', body['error'])

    def test_live_data_plaintext_flag(self):
        live = os.path.join(self.site, 'js', 'live-data.js')
        payload = {'message_id': '<plain-1@zapier>', 'from_email': 'ines.plain@example.com', 'subject': 'Plaintext probe',
                   'date': '2026-09-11T12:00:00Z', 'text': 'Where is my order?'}
        status, body, _ = self.call('POST', '/api/ingest', body=payload, token=self.token)
        self.assertEqual(status, 200)
        with open(live, 'r', encoding='utf-8') as fh:
            text = fh.read()
        self.assertNotIn('ines.plain', text)                     # default: the empty set
        self.assertTrue(text.rstrip().endswith(vs.LIVE_JS_EMPTY.strip()))
        status, body, _ = self.call('POST', '/api/config', body={'live_data_plaintext': True}, token=self.token)
        self.assertEqual(status, 200)
        self.assertTrue(body['config']['live_data_plaintext'])
        self.assertTrue(body['status']['live_data_plaintext'])
        with open(live, 'r', encoding='utf-8') as fh:
            text = fh.read()
        self.assertIn('ines.plain@example.com', text)             # opted in: full records for file://
        status, body, _ = self.call('POST', '/api/config', body={'live_data_plaintext': False}, token=self.token)
        self.assertEqual(status, 200)
        with open(live, 'r', encoding='utf-8') as fh:
            text = fh.read()
        self.assertNotIn('ines.plain', text)                     # turning it off scrubs the file at once
        status, body, _ = self.call('GET', '/api/records?since=2026-09-11T00:00:00Z', token=self.token)
        self.assertTrue(any(r['from_email'] == 'ines.plain@example.com' for r in body['records']))

    def test_live_data_js_gate(self):
        live = os.path.join(self.site, 'js', 'live-data.js')
        with open(live, 'w', encoding='utf-8') as fh:
            fh.write('window.VOC_LIVE = [{"id":"gate"}];')
        try:
            host = self.base.split('//', 1)[1]
            # Another origin's <script src>: refused whether or not the browser sends Sec-Fetch-Site.
            for headers in ({}, {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'script'},
                            {'Referer': 'https://evil.example/page.html'}, {'Origin': 'https://evil.example'},
                            {'Sec-Fetch-Site': 'same-site'}):
                status, body, _ = self.call('GET', '/js/live-data.js', raw_headers=headers)
                self.assertEqual(status, 403, headers)
                self.assertNotIn(b'gate', body if isinstance(body, bytes) else json.dumps(body).encode())
            # The page's own script tag (same origin), a typed URL, or the token: served.
            for headers in ({'Sec-Fetch-Site': 'same-origin'}, {'Sec-Fetch-Site': 'none'},
                            {'Referer': 'http://%s/' % host}, {'Referer': 'http://%s/index.html' % host},
                            {'Origin': 'http://%s' % host}, {'X-VoC-Token': self.token},
                            {'Authorization': 'Bearer ' + self.token}):
                status, body, ctype = self.call('GET', '/js/live-data.js', raw_headers=headers)
                self.assertEqual(status, 200, headers)
                self.assertIn(b'"id":"gate"', body)
                self.assertTrue(ctype.startswith('text/javascript'), ctype)
            req = urllib.request.Request(self.base + '/js/live-data.js', method='HEAD')
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    status = resp.status
            except urllib.error.HTTPError as exc:
                status = exc.code
            self.assertEqual(status, 403)
        finally:
            os.remove(live)

    def test_static_paths_are_normalized_and_folders_not_listed(self):
        os.makedirs(os.path.join(self.site, 'server'), exist_ok=True)
        with open(os.path.join(self.site, 'server', 'config.json'), 'w', encoding='utf-8') as fh:
            fh.write('{"username": "leak@example.com"}')
        os.makedirs(os.path.join(self.site, '.claude'), exist_ok=True)
        with open(os.path.join(self.site, '.claude', 'launch.json'), 'w', encoding='utf-8') as fh:
            fh.write('{}')
        for path in ('/server/config.json', '/./server/config.json', '/%73erver/config.json', '/js/./../server/config.json',
                     '/js/%2e%2e/server/config.json', '/server', '/server/', '/SERVER/../server/config.json?x=1',
                     '/.claude/launch.json', '/.claude/', '/js/.hidden', '/.DS_Store'):
            status, body, _ = self.call('GET', path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(b'leak@example.com', body if isinstance(body, bytes) else json.dumps(body).encode(), path)
        for path in ('/js/', '/js', '/server/../js/'):
            status, body, _ = self.call('GET', path)
            self.assertEqual(status, 404, path)
        status, body, _ = self.call('GET', '/')
        self.assertEqual(status, 200)
        status, body, _ = self.call('GET', '/js/../js/app.js')
        self.assertEqual(status, 200)

    def test_static_files_404_405_options(self):
        status, body, ctype = self.call('GET', '/')
        self.assertEqual(status, 200)
        self.assertIn(b'<title>t</title>', body)
        status, body, ctype = self.call('GET', '/js/app.js')
        self.assertEqual(status, 200)
        self.assertTrue(ctype.startswith('text/javascript'))
        status, _b, _ = self.call('GET', '/nope.html')
        self.assertEqual(status, 404)
        os.makedirs(os.path.join(self.site, 'server'), exist_ok=True)
        with open(os.path.join(self.site, 'server', 'config.json'), 'w', encoding='utf-8') as fh:
            fh.write('{}')
        status, _b, _ = self.call('GET', '/server/config.json')
        self.assertEqual(status, 404)
        status, body, _ = self.call('GET', '/api/nothing', token=self.token)
        self.assertEqual(status, 404)
        status, body, _ = self.call('GET', '/api/sync', token=self.token)
        self.assertEqual(status, 405)
        status, body, _ = self.call('POST', '/api/status', body={}, token=self.token)
        self.assertEqual(status, 405)
        status, _b, _ = self.call('OPTIONS', '/api/status')
        self.assertEqual(status, 204)

    def test_missing_live_data_js_serves_empty_stub(self):
        live = os.path.join(self.site, 'js', 'live-data.js')
        if os.path.exists(live):
            os.remove(live)
        status, body, ctype = self.call('GET', '/js/live-data.js')
        self.assertEqual(status, 200)
        self.assertTrue(ctype.startswith('application/javascript'), ctype)
        self.assertEqual(body.decode('utf-8').strip(), 'window.VOC_LIVE = window.VOC_LIVE || [];')
        # Once the poller has written the file, the real content wins for the page itself (same origin) or a
        # token holder; a request from nowhere (no Sec-Fetch-Site, Origin or Referer) is refused.
        with open(live, 'w', encoding='utf-8') as fh:
            fh.write('window.VOC_LIVE = [{"id":"x"}];')
        try:
            status, body, _ctype = self.call('GET', '/js/live-data.js', raw_headers={'Sec-Fetch-Site': 'same-origin'})
            self.assertEqual(status, 200)
            self.assertIn(b'"id":"x"', body)
            status, body, _ctype = self.call('GET', '/js/live-data.js', token=self.token)
            self.assertEqual(status, 200)
            self.assertIn(b'"id":"x"', body)
            status, body, _ctype = self.call('GET', '/js/live-data.js')
            self.assertEqual(status, 403)
        finally:
            os.remove(live)


if __name__ == '__main__':
    unittest.main()
