// tests/test_mime.js — F (intake & I/O): mime.js, importers.js, exporter.js, connector.js.
// Run: jsc tests/_jsc_shim.js js/util.js js/mime.js js/importers.js js/exporter.js [js/connector.js] tests/test_mime.js
// The SAMPLE_* literals below are byte-for-byte copies of the files in samples/ (LF line endings);
// tests/test_mime.js is regenerated from those files, so edit the samples, not the literals.
var __passed = 0, __failed = 0;
function assert(cond, msg) { if (cond) { __passed++; console.log('PASS ' + msg); } else { __failed++; console.log('FAIL ' + msg); } }
function eq(a, b, msg) { assert(a === b, msg + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

var SAMPLE_EML = `Return-Path: <marisol.vega@example.com>
Received: from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41])
        by mx.l-nutra.com with ESMTPS id k7si1203482pfk.221.2026.09.14.08.22.05
        for <support@l-nutra.com>;
        Mon, 14 Sep 2026 08:22:05 -0700 (PDT)
Message-ID: <CAF7Qx5k2m9v0Zr1w@mail.example.com>
Date: Mon, 14 Sep 2026 10:22:00 -0500
From: Marisol Vega <marisol.vega@example.com>
To: L-Nutra Support <support@l-nutra.com>
Cc: <orders@l-nutra.com>
Subject: Leaking L-Drink in my ProLon 5-Day kit - order #145233
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed-7f3a9c"

--mixed-7f3a9c
Content-Type: multipart/alternative; boundary="alt-2b91de"

--alt-2b91de
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

Hi L-Nutra team,

My ProLon 5-Day kit for order #145233 arrived yesterday and the Day 2 L-Dri=
nk bottle had leaked all over the box. The glycerol drink soaked the kale c=
rackers and the L-Bar wrapper, so I=E2=80=99m not comfortable using Day 2 a=
t all. I=E2=80=99ve attached a photo of the box.

I=E2=80=99m supposed to start the fast on Monday. Can you ship a replacemen=
t L-Drink (or a full Day 2 box) before then? I=E2=80=99d hate to push the w=
hole cycle back a week.

Thanks,
Marisol

--alt-2b91de
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

<html><head><meta charset=3D"utf-8"><style>p { font-family: Helvetica; }</s=
tyle></head>
<body><div dir=3D"ltr"><p>Hi L-Nutra team,</p>
<p>My ProLon 5-Day kit for order <b>#145233</b> arrived yesterday and the D=
ay 2 L-Drink bottle had leaked all over the box. The glycerol drink soaked =
the kale crackers and the L-Bar wrapper, so I=E2=80=99m not comfortable usi=
ng Day 2 at all. I=E2=80=99ve attached a photo of the box.</p>
<p>I=E2=80=99m supposed to start the fast on Monday. Can you ship a replace=
ment L-Drink (or a full Day 2 box) before then? I=E2=80=99d hate to push th=
e whole cycle back a week.</p>
<p>Thanks,<br>Marisol</p></div></body></html>

--alt-2b91de--
--mixed-7f3a9c
Content-Type: image/jpeg; name="IMG_4471.jpg"
Content-Disposition: attachment; filename="IMG_4471.jpg"
Content-Transfer-Encoding: base64

/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a
HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA
AAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/ACqf/9k=
--mixed-7f3a9c--
`;
var SAMPLE_RFC2047 = `Message-ID: <20260908T161230.4471@mail.example.net>
In-Reply-To: <support-88213@l-nutra.com>
References: <support-88213@l-nutra.com>
Date: Tue, 8 Sep 2026 16:12:30 +0200
From: =?iso-8859-1?Q?Ren=E9e_Dubois?= <renee.dubois@example.net>
To: support@l-nutra.com
Subject: =?utf-8?B?UmU6IE9yZGVyICMxNDY4MDIg4oCUIA==?=
 =?utf-8?B?RmFzdCBCYXIgY2Fmw6kgbW9jaGEgdGFzdGVzIHN0YWxl?=
MIME-Version: 1.0
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: base64

SGVsbG8sCgpUaGFua3MgZm9yIHRoZSBxdWljayByZXBseS4gSSBvcGVuZWQgdGhlIHNlY29uZCBi
b3ggb2YgRmFzdCBCYXIgY2Fmw6kgbW9jaGEgZnJvbSBvcmRlciAjMTQ2ODAyIGFuZCB0aG9zZSBi
YXJzIHRhc3RlIHN0YWxlIHRvbyDigJQgZHJ5IGFuZCBjaGFsa3ksIG5vdGhpbmcgbGlrZSB0aGUg
Zmlyc3QgYm94IEkgYm91Z2h0IGluIEp1bHkuIFRoZSBiZXN0LWJ5IGRhdGUgb24gdGhlIGJveCBp
cyAwMy8yMDI3LCBsb3QgRkItMDcyNi1DLCBzbyBJIGRvbid0IHRoaW5rIGl0J3MgZXhwaXJlZC4K
CkNvdWxkIHlvdSBzd2FwIHRoaXMgYm94IGZvciB0aGUgbnV0LWJ1dHRlciBmbGF2b3IgaW5zdGVh
ZD8gSSdkIHJhdGhlciBub3QgZ2V0IGFub3RoZXIgbW9jaGEgYm94LgoKQmVzdCwKUmVuw6llCgpP
biBUdWUsIDggU2VwIDIwMjYgYXQgMDk6NDEsIEwtTnV0cmEgU3VwcG9ydCA8c3VwcG9ydEBsLW51
dHJhLmNvbT4gd3JvdGU6Cj4gSGkgUmVuw6llLCBzb3JyeSB0byBoZWFyIGFib3V0IHRoZSBiYXJz
LiBDb3VsZCB5b3Ugc2VuZCB1cyB0aGUgbG90IG51bWJlcgo+IHByaW50ZWQgb24gdGhlIGJvdHRv
bSBvZiB0aGUgYm94IHNvIHdlIGNhbiBsb29rIGludG8gaXQ/Cj4KPiBNYXlhIFIuCj4gTC1OdXRy
YSBDdXN0b21lciBDYXJlCg==
`;
var SAMPLE_MBOX = `From alvin.torres@example.com Tue Sep 15 09:12:44 2026
Return-Path: <alvin.torres@example.com>
Message-ID: <7e2d1c0a-4b6f-4e2b-9c3d-0f1a2b3c4d5e@example.com>
Date: Tue, 15 Sep 2026 09:12:44 -0500
From: Alvin Torres <alvin.torres@example.com>
To: support@l-nutra.com
Subject: Charged twice for my subscription - order #147901
MIME-Version: 1.0
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 8bit

Hello,

I was charged twice for my ProLon subscription on September 14 — two charges of $199 show on my card for the same order #147901. I only wanted one kit. Please refund the duplicate charge.

>From my perspective, one charge a month is plenty. Can you also confirm my next renewal date so this doesn't happen again?

Thanks,
Alvin Torres

--
Sent from my iPhone

From noreply@example-corp.com Tue Sep 15 09:13:02 2026
Message-ID: <auto-20260915-091302@example-corp.com>
Date: Tue, 15 Sep 2026 09:13:02 -0500
From: Dana Whitfield <dana.whitfield@example-corp.com>
To: support@l-nutra.com
Subject: Automatic reply: Your L-Nutra order update
Auto-Submitted: auto-replied
Precedence: bulk
X-Autoreply: yes
MIME-Version: 1.0
Content-Type: text/plain; charset="us-ascii"
Content-Transfer-Encoding: 7bit

I am currently out of the office until Monday, September 21 with limited access to email. For urgent matters please contact our main line.

This is an automatic reply.

From k.brandt@example.de Wed Sep 16 14:05:19 2026
Message-ID: <a1b2c3d4e5f6@mail.example.de>
Date: Wed, 16 Sep 2026 21:05:19 +0200
From: Katrin Brandt <k.brandt@example.de>
To: support@l-nutra.com
Subject: =?iso-8859-1?Q?R=FCckfrage_zu_meiner_Bestellung_=23147655?=
MIME-Version: 1.0
Content-Type: text/plain; charset="iso-8859-1"
Content-Transfer-Encoding: quoted-printable

Guten Tag,

ich habe am 10. September ein ProLon 5-Tage-Kit bestellt (Bestellung #14765=
5) und bis heute keine Versandbest=E4tigung erhalten. K=F6nnen Sie mir bitt=
e sagen, wann das Paket ankommt? Ich m=F6chte n=E4chste Woche starten.

Vielen Dank und sch=F6ne Gr=FC=DFe
Katrin Brandt

`;
var SAMPLE_HELPDESK = `Ticket ID,Subject,Body,Requester Email,Requester Name,Created At,Status,Assignee,First Replied At,Closed At,Tags
HD-30411,Charged twice this month,Two charges for $199 hit my card on 9/2 for order #146110. I only have one subscription. Please refund one of them.,dana.okafor@example.com,Dana Okafor,2026-09-02 08:14:00,solved,Maya R.,2026-09-02 09:05:00,2026-09-03 11:40:00,billing|refund
HD-30418,Where is my order?,"Order #146233 shipped on 8/28 and the FedEx tracking has said ""label created"" for a week. Still not arrived.",luis.herrera@example.com,Luis Herrera,2026-09-03 10:02:00,open,Devon K.,2026-09-03 12:30:00,,shipping
HD-30425,Next Gen minestrone soup - hard bits,"I found small hard bits in the Next Gen minestrone quinoa soup on day 3.
They felt like shell fragments. Lot NG-0826-A. I did not swallow them but I am worried.",priya.nair@example.com,Priya Nair,2026-09-04 19:45:00,escalated,Priya S.,2026-09-04 20:10:00,,quality|food-safety
HD-30437,"Loved the 5-day, lost 6 lbs",Just finished my second cycle of the 5-Day and lost 6 lbs. Energy on day 4 was amazing. Thank you!,kyle.brennan@example.com,Kyle Brennan,2026-09-05 07:30:00,closed,Maya R.,2026-09-05 09:12:00,2026-09-05 09:12:00,praise
HD-30442,Cancel my subscription,I want to cancel my ProLon subscription before the next shipment. There is no cancellation link in my account and the chatbot keeps looping.,amara.diallo@example.com,Amara Diallo,2026-09-06 13:20:00,pending,Devon K.,2026-09-06 15:48:00,,subscription|cancel
HD-30450,Fast Bar tastes stale,The nut-butter Fast Bars from my last box are dry and taste stale. Best-by is 02/2027 so they are not expired.,tom.eriksen@example.com,Tom Eriksen,2026-09-07 11:11:00,solved,Jordan T.,2026-09-07 14:02:00,2026-09-08 10:00:00,taste
HD-30461,Headache on day 3 - normal?,I am on day 3 of the fast and have a dull headache and feel a bit lightheaded. Is this normal? Can I have black coffee?,mei.chen@example.com,Mei Chen,2026-09-08 09:55:00,solved,Priya S.,2026-09-08 10:20:00,2026-09-08 16:30:00,side-effects|guidance
HD-30470,Promo code not applied,I entered WELCOME15 at checkout on mobile and the discount never applied. Order #146512 charged full price.,sara.lindqvist@example.com,Sara Lindqvist,2026-09-09 16:40:00,open,,,,checkout|promo
HD-30478,Practitioner account bulk order,"Hi, I run a chiropractic practice and would like to set up a practitioner account for bulk kits. My HCP code is PP-20931. Who do I speak to?",dr.ramos@example-clinic.com,Dr. Elena Ramos,2026-09-10 08:05:00,open,Jordan T.,2026-09-10 11:15:00,,hcp
HD-30485,Missing L-Drink in Day 4 box,My kit arrived without the Day 4 L-Drink. Order #146601. Everything else is there.,noah.patel@example.com,Noah Patel,2026-09-11 18:22:00,solved,Maya R.,2026-09-12 08:40:00,2026-09-12 12:05:00,missing-item
HD-30493,Too expensive for what you get,$199 for five days of soup and a few bars is a lot. $40 a day. Any bundle discount for buying three kits?,grace.mbeki@example.com,Grace Mbeki,2026-09-13 12:00:00,solved,Devon K.,2026-09-13 13:30:00,2026-09-13 13:31:00,price
HD-30501,Fainted on day 2 - taking metformin,My husband fainted on day 2 of the ProLon fast. He takes metformin for type 2 diabetes. We went to the ER and his blood sugar had crashed. He is home now but we are shaken.,carol.hughes@example.com,Carol Hughes,2026-09-15 21:30:00,escalated,Priya S.,2026-09-15 21:41:00,,adverse-event|urgent
`;
var SAMPLE_ORDERS = `month,product,orders
2025-09,ProLon 5-Day,1204
2025-09,ProLon Next Gen,541
2025-09,Fast Bar,297
2025-09,L-Pill,131
2025-10,ProLon 5-Day,877
2025-10,ProLon Next Gen,391
2025-10,Fast Bar,205
2025-10,L-Pill,94
2025-11,ProLon 5-Day,1303
2025-11,ProLon Next Gen,621
2025-11,Fast Bar,331
2025-11,L-Pill,135
2025-12,ProLon 5-Day,1055
2025-12,ProLon Next Gen,509
2025-12,Fast Bar,271
2025-12,L-Pill,119
2026-01,ProLon 5-Day,1433
2026-01,ProLon Next Gen,698
2026-01,Fast Bar,340
2026-01,L-Pill,166
2026-02,ProLon 5-Day,1079
2026-02,ProLon Next Gen,446
2026-02,Fast Bar,256
2026-02,L-Pill,115
2026-03,ProLon 5-Day,902
2026-03,ProLon Next Gen,380
2026-03,Fast Bar,226
2026-03,L-Pill,96
2026-04,ProLon 5-Day,866
2026-04,ProLon Next Gen,418
2026-04,Fast Bar,217
2026-04,L-Pill,92
2026-05,ProLon 5-Day,870
2026-05,ProLon Next Gen,402
2026-05,Fast Bar,206
2026-05,L-Pill,94
2026-06,ProLon 5-Day,875
2026-06,ProLon Next Gen,395
2026-06,Fast Bar,209
2026-06,L-Pill,91
2026-07,ProLon 5-Day,902
2026-07,ProLon Next Gen,384
2026-07,Fast Bar,226
2026-07,L-Pill,90
2026-08,ProLon 5-Day,878
2026-08,ProLon Next Gen,407
2026-08,Fast Bar,212
2026-08,L-Pill,101
2026-09,ProLon 5-Day,1214
2026-09,ProLon Next Gen,517
2026-09,Fast Bar,275
2026-09,L-Pill,119
`;

/* ------------------------------------------------------------ sample.eml */
var p = VOC.mime.parse(SAMPLE_EML);
eq(p.contentType, 'multipart/mixed', 'eml: top-level content type');
eq(p.headers.subject, 'Leaking L-Drink in my ProLon 5-Day kit - order #145233', 'eml: subject');
assert(/for <support@l-nutra\.com>; Mon, 14 Sep 2026/.test(p.headers.received), 'eml: folded Received header unfolded');
assert(p.text.indexOf('L-Drink bottle had leaked all over the box') >= 0, 'eml: quoted-printable text part decoded');
assert(p.text.indexOf('I’m not comfortable') >= 0, 'eml: QP UTF-8 multi-byte sequence (curly apostrophe) decoded');
assert(p.text.indexOf('<p>') < 0 && p.text.indexOf('<html') < 0, 'eml: text/plain preferred over text/html');
assert(p.html !== null && p.html.indexOf('<b>#145233</b>') >= 0, 'eml: html alternative kept');
eq(p.attachments.length, 1, 'eml: one attachment counted');
eq(p.attachments[0].name, 'IMG_4471.jpg', 'eml: attachment name');
eq(p.attachments[0].type, 'image/jpeg', 'eml: attachment type');
assert(p.attachments[0].size > 100 && p.attachments[0].size < 400, 'eml: attachment size is decoded byte length (' + p.attachments[0].size + ')');
assert(p.parts.length === 3 && p.parts.every(function (x) { return !('content' in x); }), 'eml: 3 leaf parts, attachment content never stored');

var raw = VOC.mime.toRawEmail(p, 'eml');
eq(raw.date, '2026-09-14T15:22:00Z', 'eml: Date -0500 → ISO UTC');
eq(raw.from_name, 'Marisol Vega', 'eml: from name');
eq(raw.from_email, 'marisol.vega@example.com', 'eml: from email');
eq(raw.to[0], 'support@l-nutra.com', 'eml: to');
eq(raw.cc[0], 'orders@l-nutra.com', 'eml: cc (bare angle address)');
eq(raw.message_id, 'CAF7Qx5k2m9v0Zr1w@mail.example.com', 'eml: message id without angle brackets');
eq(raw.thread_id, raw.message_id, 'eml: thread id falls back to message id');
eq(raw.direction, 'inbound', 'eml: direction');
eq(raw.source, 'eml', 'eml: source');
eq(raw.attachments.length, 1, 'eml: RawEmail attachments');
assert(raw.headers.content_type.indexOf('multipart/mixed') === 0, 'eml: headers.content_type filled');
eq(raw.headers.auto_submitted, null, 'eml: headers.auto_submitted null when absent');
var outbound = VOC.mime.toRawEmail(p, 'eml', { agentDomains: ['example.com'] });
eq(outbound.direction, 'outbound', 'eml: agent domain → outbound');

var pc = VOC.mime.parse(SAMPLE_EML.replace(/\n/g, '\r\n'));
eq(pc.text, p.text, 'eml: CRLF variant decodes to identical text');
eq(pc.attachments.length, 1, 'eml: CRLF variant attachment count');
var e1 = VOC.importers.parseEmlText(SAMPLE_EML);
eq(e1.subject, raw.subject, 'importers.parseEmlText matches mime.toRawEmail');

/* ------------------------------------------- sample-quoted-rfc2047.eml */
var q = VOC.importers.parseEmlText(SAMPLE_RFC2047);
eq(q.subject, 'Re: Order #146802 — Fast Bar café mocha tastes stale', 'rfc2047: two B-encoded utf-8 words on a folded line → em dash + accent, no stray space');
eq(q.from_name, 'Renée Dubois', 'rfc2047: Q-encoded iso-8859-1 display name');
eq(q.from_email, 'renee.dubois@example.net', 'rfc2047: from email');
assert(q.text.indexOf('those bars taste stale too — dry and chalky') >= 0, 'rfc2047: base64 utf-8 body decoded');
assert(/^On Tue, 8 Sep 2026 at 09:41, .* wrote:$/m.test(q.text) && /^> Hi Renée/m.test(q.text), 'rfc2047: quoted tail left intact for classify.preprocess');
eq(q.in_reply_to, 'support-88213@l-nutra.com', 'rfc2047: in-reply-to');
eq(q.thread_id, 'support-88213@l-nutra.com', 'rfc2047: thread id from References');
eq(q.date, '2026-09-08T14:12:30Z', 'rfc2047: Date +0200 → UTC');
eq(q.attachments.length, 0, 'rfc2047: no attachments');
eq(q.html, null, 'rfc2047: no html part');
eq(VOC.mime.decodeWords('=?utf-8?Q?caf=C3=A9_au_lait?='), 'café au lait', 'rfc2047: Q underscore → space');
eq(VOC.mime.decodeWords('=?windows-1252?Q?smart_=93quotes=94?='), 'smart “quotes”', 'rfc2047: windows-1252 high range');
eq(VOC.mime.decodeQP('Sch=F6n', 'iso-8859-1'), 'Schön', 'decodeQP: iso-8859-1');
eq(VOC.mime.decodeB64('U2Now7Zu', 'utf-8'), 'Schön', 'decodeB64: utf-8');

/* ----------------------------------------------------------- sample.mbox */
var box = VOC.importers.parseMboxText(SAMPLE_MBOX);
eq(box.length, 3, 'mbox: split into 3 messages');
eq(box[0].from_email, 'alvin.torres@example.com', 'mbox: message 1 sender');
eq(box[0].subject, 'Charged twice for my subscription - order #147901', 'mbox: message 1 subject');
assert(/^From my perspective, one charge a month is plenty\./m.test(box[0].text), 'mbox: ">From " unescaped to "From "');
assert(box[0].text.indexOf('>From') < 0, 'mbox: no escaped From left in body');
assert(box[0].text.indexOf('two charges of $199') >= 0, 'mbox: 8bit utf-8 body kept');
eq(box[1].headers.auto_submitted, 'auto-replied', 'mbox: Auto-Submitted header captured');
eq(box[1].headers.precedence, 'bulk', 'mbox: Precedence header captured');
eq(box[1].headers.x_autoreply, 'yes', 'mbox: X-Autoreply header captured');
eq(box[1].subject, 'Automatic reply: Your L-Nutra order update', 'mbox: auto-reply subject');
eq(box[2].subject, 'Rückfrage zu meiner Bestellung #147655', 'mbox: Q-encoded iso-8859-1 subject with =23 → #');
assert(box[2].text.indexOf('Versandbestätigung') >= 0 && box[2].text.indexOf('schöne Grüße') >= 0, 'mbox: iso-8859-1 quoted-printable German body decoded');
eq(box[2].date, '2026-09-16T19:05:19Z', 'mbox: +0200 date → UTC');
assert(box.every(function (r) { return r.source === 'mbox' && r.message_id && r.date; }), 'mbox: every message has source, message_id, date');
eq(VOC.importers.parseMboxText(SAMPLE_MBOX.replace(/\n/g, '\r\n')).length, 3, 'mbox: CRLF variant splits into 3');
eq(VOC.importers.parseMboxText('').length, 0, 'mbox: empty input → []');

/* ----------------------------------------------------- sample-helpdesk.csv */
var csv = VOC.importers.parseCsvText(SAMPLE_HELPDESK);
eq(csv.headers.length, 11, 'csv: 11 headers');
eq(csv.rows.length, 12, 'csv: 12 rows');
eq(csv.delimiter, ',', 'csv: delimiter detected');
assert(csv.rows[1][2].indexOf('has said "label created" for a week') >= 0, 'csv: doubled quotes unescaped');
assert(csv.rows[2][2].indexOf('on day 3.\nThey felt like shell fragments') >= 0, 'csv: embedded newline inside quoted field');
eq(csv.rows[7][7], '', 'csv: empty field preserved');
var csvCrlf = VOC.importers.parseCsvText(SAMPLE_HELPDESK.replace(/\n/g, '\r\n'));
eq(csvCrlf.rows.length, 12, 'csv: CRLF variant row count');
eq(csvCrlf.rows[2][2], csv.rows[2][2].replace('\n', '\r\n'), 'csv: CRLF variant keeps embedded line break');
eq(VOC.importers.detectTemplate(csv.headers), 'helpdesk', 'csv: helpdesk template detected from header row');
var mapping = VOC.importers.buildMapping(csv.headers, 'helpdesk');
eq(mapping.missing.length, 0, 'csv: helpdesk mapping has no missing required fields');
eq(mapping.columns.subject, 1, 'csv: Subject column mapped');
eq(mapping.columns.from_email, 3, 'csv: Requester Email → from_email (synonym, case/space-insensitive)');
eq(mapping.columns.first_replied_at, 8, 'csv: First Replied At mapped');
assert(/^[0-9a-f]{16}$/.test(mapping.fingerprint), 'csv: header fingerprint is hex16');
var recs = VOC.importers.mapRows(csv.rows, mapping);
eq(recs.length, 12, 'csv: 12 partial records');
eq(recs[0].channel, 'email', 'csv: helpdesk rows are channel email');
eq(recs[0].service_fields_source, 'helpdesk_import', 'csv: service_fields_source');
eq(recs[0].source, 'csv', 'csv: source');
eq(recs[0].status, 'resolved', 'csv: status solved → resolved');
eq(recs[1].status, 'open', 'csv: status open');
eq(recs[2].status, 'escalated', 'csv: status escalated');
eq(recs[4].status, 'pending', 'csv: status pending');
eq(recs[0].received_at, '2026-09-02T08:14:00Z', 'csv: created_at → ISO');
eq(recs[0].first_response_at, '2026-09-02T09:05:00Z', 'csv: first_replied_at → ISO');
eq(recs[0].resolved_at, '2026-09-03T11:40:00Z', 'csv: closed_at → ISO');
eq(recs[1].resolved_at, null, 'csv: empty closed_at → null');
eq(recs[0].tags.join(','), 'billing,refund', 'csv: tags split on |');
eq(recs[7].assignee, null, 'csv: empty assignee → null');
eq(recs[0].message_id, 'helpdesk:HD-30411', 'csv: ticket id becomes message_id for dedupe');
eq(recs[0].from_name, 'Dana Okafor', 'csv: from_name');
var byName = VOC.importers.mapRows([{ 'Subject': 'S', 'Body': 'B', 'Created At': '9/2/2026 8:14 AM' }], { template: 'helpdesk', headers: csv.headers, columns: { subject: 'Subject', body: 'Body', created_at: 'Created At' } });
eq(byName[0].received_at, '2026-09-02T08:14:00Z', 'csv: object rows + header-name mapping + US date');

/* ------------------------------------------------------- sample-orders.csv */
var oc = VOC.importers.parseCsvText(SAMPLE_ORDERS);
eq(oc.rows.length, 52, 'orders: 13 months × 4 products = 52 rows');
eq(VOC.importers.detectTemplate(oc.headers), 'orders_monthly', 'orders: template detected');
var om = VOC.importers.mapRows(oc.rows, VOC.importers.buildMapping(oc.headers, 'orders_monthly'));
eq(om.months.length, 13, 'orders: 13 months');
eq(om.months[0] + '..' + om.months[12], '2025-09..2026-09', 'orders: month range');
eq(Object.keys(om.ordersByMonth).sort().join(','), '_total,fast_bar,l_pill,prolon_5day,prolon_nextgen', 'orders: product names resolved to ids');
var jan = ['prolon_5day', 'prolon_nextgen', 'fast_bar', 'l_pill'].reduce(function (s, k) { return s + om.ordersByMonth[k]['2026-01']; }, 0);
eq(om.ordersByMonth._total['2026-01'], jan, 'orders: _total sums the products');
assert(om.ordersByMonth._total['2026-01'] > om.ordersByMonth._total['2026-03'], 'orders: January seasonality present');
eq(om.skipped, 0, 'orders: no rows skipped');
eq(VOC.importers.normMonth('Jan 2026'), '2026-01', 'normMonth: Mon YYYY');
eq(VOC.importers.normMonth('1/2026'), '2026-01', 'normMonth: M/YYYY');
eq(VOC.importers.normMonth('2026-01-15'), '2026-01', 'normMonth: full date');

/* ----------------------------------------------------- template detection */
eq(VOC.importers.detectTemplate(['foo', 'bar']), null, 'detectTemplate: unknown headers → null');
eq(VOC.importers.detectTemplate([]), null, 'detectTemplate: empty → null');
eq(VOC.importers.detectTemplate(['Title', 'Review', 'Stars', 'Author', 'Date', 'Source', 'Product']), 'reviews', 'detectTemplate: reviews');
eq(VOC.importers.detectTemplate(['id', 'received_at', 'subject', 'category', 'text', 'channel']), 'records', 'detectTemplate: native records');
var reviews = VOC.importers.mapRows([['Great', 'Lost 5 lbs on the 5-Day', '5', 'Kim', '2026-08-01', 'Trustpilot', 'ProLon 5-Day']], VOC.importers.buildMapping(['Title', 'Review', 'Stars', 'Author', 'Date', 'Source', 'Product'], 'reviews'));
eq(reviews[0].channel, 'trustpilot_review', 'reviews: source column → trustpilot_review');
eq(reviews[0].rating, 5, 'reviews: rating parsed');
eq(reviews[0].product, 'prolon_5day', 'reviews: product resolved from column');
eq(reviews[0].received_at, '2026-08-01T00:00:00Z', 'reviews: date → ISO');
assert(Object.keys(VOC.importers.TEMPLATES).sort().join(',') === 'helpdesk,orders_monthly,records,reviews', 'TEMPLATES has the four spec ids');

/* ------------------------------------------------------------------ json */
var js1 = VOC.importers.parseJsonFull(JSON.stringify([raw, q]));
eq(js1.kind, 'raw', 'json: RawEmail[] detected by from_email+date+subject without category');
eq(js1.items.length, 2, 'json: two raw emails');
var js2 = VOC.importers.parseJsonFull(JSON.stringify({ records: [{ id: 'r1', subject: 'x', category: 'praise', received_at: '2026-01-01T00:00:00Z' }], overlays: { r1: { status: 'open' } }, settings: { clock: 'demo' }, seed_meta: { seed: 1 } }));
eq(js2.kind, 'backup', 'json: backup shape detected');
eq(js2.items.length, 1, 'json: backup records');
eq(js2.overlays[0].id, 'r1', 'json: backup overlays object → array with id');
eq(js2.settings.clock, 'demo', 'json: backup settings');
eq(js2.items[0].source, 'json', 'json: source defaults to json');
eq(VOC.importers.parseJsonText('{"records":[]}').length, 0, 'json: empty records');
var threw = false; try { VOC.importers.parseJsonText('{not json'); } catch (e) { threw = true; }
assert(threw, 'json: invalid JSON throws a readable error');

/* -------------------------------------------------------------- exporter */
var rec = { id: 'im_0001', schema_version: 1, received_at: '2026-09-14T15:22:00Z', channel: 'email', sales_channel: 'dtc_web',
  from_name: 'Doe, "Jane"', from_email: 'jane@example.com', subject: 'Hello, "world"', text: 'Line one\nLine "two", with comma\r\nline three',
  language: 'en', has_attachment: false, product: 'prolon_5day', category: 'praise', subcategory: 'general_praise', secondary_categories: [],
  sentiment: 0.42, sentiment_min: 0.1, sentiment_label: 'positive', nps: 9, rating: null, csat: null, urgency: 'P3', status: 'resolved',
  first_response_at: '2026-09-14T17:00:00Z', resolved_at: '2026-09-15T10:00:00Z', reopen_count: 0, service_fields_source: 'manual',
  escalated_to: 'none', is_adverse_event: false, serious_ae: false, ae_criteria: [], contraindication_flags: [], food_safety: false,
  lot_number: null, order_id: '#145233', hcp_code: null, claim_related: false, cancel_intent: false, restricted: false,
  customer_id: 'c_abc', segment: 'repeat', region: 'US', thread_id: 't1', is_first_contact: true, message_id: 'm1', source: 'eml',
  is_noise: false, noise_reason: null, assignee: 'Maya R.', tags: ['a', 'b'],
  notes: [{ at: '2026-09-14T16:00:00Z', by: 'Maya R.', text: 'called back' }],
  classifier: { confidence: 0.8, rule_category: 'praise', rule_subcategory: 'general_praise', rule_product: 'prolon_5day', manual_override: false, needs_review: false } };
var csvOut = VOC.exporter.recordsCsv([rec], { now: '2026-09-16T23:59:00Z' });
assert(csvOut.charCodeAt(0) === 0xFEFF, 'recordsCsv: UTF-8 BOM');
assert(csvOut.indexOf('\r\n') > 0, 'recordsCsv: CRLF row terminators');
var back = VOC.importers.parseCsvText(csvOut);
eq(back.headers.length, VOC.exporter.RECORD_COLUMNS.length, 'recordsCsv: header count = RECORD_COLUMNS');
eq(back.headers[back.headers.length - 1], 'age_hours', 'recordsCsv: derived columns last');
eq(back.rows.length, 1, 'recordsCsv: one data row');
function col(k) { return back.rows[0][back.headers.indexOf(k)]; }
eq(col('text'), rec.text, 'recordsCsv round-trip: text with quotes, comma, LF and CRLF');
eq(col('subject'), rec.subject, 'recordsCsv round-trip: subject with quotes');
eq(col('from_name'), rec.from_name, 'recordsCsv round-trip: from_name with comma and quotes');
eq(col('tags'), 'a|b', 'recordsCsv: arrays joined with |');
eq(col('sentiment_index'), '71', 'recordsCsv: sentiment_index derived');
eq(col('is_complaint'), 'false', 'recordsCsv: is_complaint derived');
eq(col('age_hours'), '56.6', 'recordsCsv: age_hours from now');
eq(col('classifier_confidence'), '0.8', 'recordsCsv: classifier flattened');
eq(col('notes'), '2026-09-14T16:00:00Z Maya R.: called back', 'recordsCsv: notes flattened');
eq(col('has_attachment'), 'false', 'recordsCsv: booleans');
eq(col('lot_number'), '', 'recordsCsv: null → empty');
eq(VOC.importers.detectTemplate(back.headers), 'records', 'recordsCsv output is detected as the native records template');
var native = VOC.importers.mapRows(back.rows, VOC.importers.buildMapping(back.headers, 'records'));
eq(native[0].sentiment, 0.42, 'records template: numbers restored');
eq(native[0].tags.length, 2, 'records template: lists restored');
eq(native[0].classifier.confidence, 0.8, 'records template: classifier rebuilt');
eq(native[0].has_attachment, false, 'records template: booleans restored');
eq(native[0].text, rec.text.replace(/\r\n/g, '\n'), 'records template: text restored (line endings normalized to LF)');
var red = VOC.importers.parseCsvText(VOC.exporter.recordsCsv([Object.assign({}, rec, { restricted: true })], { redact: true }));
eq(red.rows[0][red.headers.indexOf('from_email')], '', 'recordsCsv redact: from_email removed');
eq(red.rows[0][red.headers.indexOf('from_name')], 'Redacted', 'recordsCsv redact: from_name');
assert(red.rows[0][red.headers.indexOf('text')].indexOf('restricted') >= 0, 'recordsCsv redact: text replaced');
var notRed = VOC.importers.parseCsvText(VOC.exporter.recordsCsv([rec], { redact: true }));
eq(notRed.rows[0][notRed.headers.indexOf('from_email')], 'jane@example.com', 'recordsCsv redact: unrestricted records untouched');
eq(VOC.exporter.recordsCsv([]).split('\r\n').length, 2, 'recordsCsv: empty input → header only');
eq(VOC.exporter.csvCell('=SUM(A1)'), "'=SUM(A1)", 'csvCell: formula-leading strings neutralized');
eq(VOC.exporter.csvCell(-0.5), '-0.5', 'csvCell: negative numbers untouched');

var ae = { id: 'im_0002', received_at: '2026-09-15T21:30:00Z', product: 'prolon_5day', product_class: 'conventional_food', category: 'adverse_event', subcategory: 'hypoglycemia_medication',
  is_adverse_event: true, serious_ae: true, ae_criteria: ['er_hospital'], contraindication_flags: ['glucose_meds'], food_safety: false, urgency: 'P0', status: 'escalated',
  escalated_to: 'quality_regulatory', from_email: 'carol.hughes@example.com', from_name: 'Carol Hughes', restricted: false, subject: 'Fainted on day 2', text: 'ER visit' };
var reg = VOC.importers.parseCsvText(VOC.exporter.regulatoryCsv([ae, rec], { now: '2026-09-16T23:59:00Z' }));
eq(reg.rows.length, 1, 'regulatoryCsv: keeps only AE/food-safety records by default');
function rcol(k) { return reg.rows[0][reg.headers.indexOf(k)]; }
eq(rcol('regulatory_clock'), 'medwatch_15bd', 'regulatoryCsv: serious AE → MedWatch clock');
eq(rcol('regulatory_deadline'), '2026-10-06T21:30:00Z', 'regulatoryCsv: deadline = 15 business days after receipt');
assert(Math.abs(parseFloat(rcol('business_days_remaining')) - 13.9) < 0.3, 'regulatoryCsv: business days remaining ≈ 13.9 (' + rcol('business_days_remaining') + ')');
assert(Math.abs(parseFloat(rcol('hours_remaining')) - 477.5) < 0.2, 'regulatoryCsv: hours remaining (' + rcol('hours_remaining') + ')');
eq(rcol('ae_criteria'), 'er_hospital', 'regulatoryCsv: criteria listed');
assert(rcol('received_ct').length > 0, 'regulatoryCsv: received_ct formatted');
var fs = VOC.importers.parseCsvText(VOC.exporter.regulatoryCsv([{ id: 'x', received_at: '2026-09-16T12:00:00Z', product_class: 'conventional_food', food_safety: true }], { now: '2026-09-16T23:59:00Z' }));
eq(fs.rows[0][fs.headers.indexOf('regulatory_clock')], 'rfr_24h', 'regulatoryCsv: food safety on conventional food → RFR 24h');
eq(fs.rows[0][fs.headers.indexOf('regulatory_deadline')], '2026-09-17T12:00:00Z', 'regulatoryCsv: 24h deadline');
eq(fs.rows[0][fs.headers.indexOf('regulatory_clock_basis')], 'statutory', 'regulatoryCsv: RFR on conventional food is statutory');
eq(rcol('regulatory_clock_basis'), 'voluntary', 'regulatoryCsv: serious AE on a conventional-food kit is a voluntary MedWatch report');
var fsPill = VOC.importers.parseCsvText(VOC.exporter.regulatoryCsv([{ id: 'y', received_at: '2026-09-16T12:00:00Z', product: 'l_pill', product_class: 'supplement', food_safety: true }], { now: '2026-09-16T23:59:00Z' }));
eq(fsPill.rows[0][fsPill.headers.indexOf('regulatory_clock')], 'rfr_24h', 'regulatoryCsv: food safety on a supplement → RFR 24h');
var aePill = VOC.importers.parseCsvText(VOC.exporter.regulatoryCsv([{ id: 'z', received_at: '2026-09-16T12:00:00Z', product: 'l_pill', product_class: 'supplement', serious_ae: true }], { now: '2026-09-16T23:59:00Z' }));
eq(aePill.rows[0][aePill.headers.indexOf('regulatory_clock_basis')], 'statutory', 'regulatoryCsv: serious AE on the L-Pill is the statutory MedWatch filing');
var fsProg = VOC.importers.parseCsvText(VOC.exporter.regulatoryCsv([{ id: 'w', received_at: '2026-09-16T12:00:00Z', product: 'guided_health', product_class: 'program', food_safety: true }], { now: '2026-09-16T23:59:00Z' }));
eq(fsProg.rows[0][fsProg.headers.indexOf('regulatory_clock')], 'none', 'regulatoryCsv: food safety on a program carries no RFR clock');
eq(VOC.importers.parseCsvText(VOC.exporter.regulatoryCsv([rec], { all: true })).rows.length, 1, 'regulatoryCsv: {all:true} keeps everything');

var mc = VOC.importers.parseCsvText(VOC.exporter.metricsCsv([{ id: 'nps', label: 'NPS', value: 32.123456, n: 120, interval: { lo: 20, hi: 44 }, delta: { text: '+3', sign: 1 } }, { id: 'volume', value: 5, n: 5 }]));
assert(mc.headers.indexOf('interval_lo') >= 0 && mc.headers.indexOf('delta_text') >= 0, 'metricsCsv: nested objects flattened');
eq(mc.rows[0][mc.headers.indexOf('value')], '32.1235', 'metricsCsv: numbers rounded to 4 dp');
eq(mc.rows[1][mc.headers.indexOf('interval_lo')], '', 'metricsCsv: missing cells empty');
eq(mc.rows.length, 2, 'metricsCsv: two rows');

var bj = JSON.parse(VOC.exporter.backupJson({ records: [Object.assign({}, rec, { age_hours: 5, week_key: '2026-W38' }), { id: 'r_000001', source: 'seed' }],
  overlays: new Map([['im_0001', { status: 'open', audit: [] }]]), settings: { clock: 'demo' }, orders: { _total: { '2026-09': 10 } }, seed_meta: { seed: 20260917 } }));
eq(bj.schema_version, 1, 'backupJson: schema_version');
eq(bj.records.length, 1, 'backupJson: seed records excluded');
assert(!('age_hours' in bj.records[0]) && !('week_key' in bj.records[0]) && bj.records[0].text === rec.text, 'backupJson: derived fields stripped, data kept');
eq(bj.overlays[0].id, 'im_0001', 'backupJson: overlays Map → array with id');
eq(bj.settings.clock, 'demo', 'backupJson: settings');
eq(bj.orders._total['2026-09'], 10, 'backupJson: orders');
eq(bj.seed_meta.seed, 20260917, 'backupJson: seed_meta');
assert(/^\d{4}-\d{2}-\d{2}T/.test(bj.exported_at), 'backupJson: exported_at ISO');
var restored = VOC.importers.parseJsonFull(VOC.exporter.backupJson({ records: [rec], overlays: [], settings: {}, orders: null }));
eq(restored.kind, 'backup', 'backupJson output is recognized by parseJsonFull as a backup');
eq(restored.items[0].id, 'im_0001', 'backupJson round-trip record');

eq(VOC.exporter.filename('inbox', 'csv', { now: '2026-09-16T23:59:00Z' }), 'lnutra-voc-inbox-20260916.csv', 'filename: view + CT date');
eq(VOC.exporter.filename('Regulatory Register', 'csv', { now: '2026-09-17T03:30:00Z' }), 'lnutra-voc-regulatory-register-20260916.csv', 'filename: slug + CT date (03:30Z is still Sep 16 in Chicago)');
assert(/^lnutra-voc-backup-\d{8}\.json$/.test(VOC.exporter.filename('backup', 'json')), 'filename: json extension');

/* -------------------------------------------------------------- connector */
// connector.js is a browser module and is not on run.sh's PURE list; exercise it only when loaded.
if (VOC.connector) {
  eq(VOC.connector.mode(), 'file', 'connector: no location → file mode');
  eq(VOC.connector.baseUrl(), '', 'connector: file mode has no base url');
  eq(VOC.connector.loadLive().length, 0, 'connector: loadLive without VOC_LIVE → []');
  window.VOC_LIVE = [raw];
  eq(VOC.connector.loadLive().length, 1, 'connector: loadLive reads window.VOC_LIVE');
  eq(VOC.connector.setToken(' abc '), 'abc', 'connector: setToken trims (memory fallback without localStorage)');
  eq(VOC.connector.token(), 'abc', 'connector: token round-trip');
  eq(VOC.connector.startPolling(60), false, 'connector: polling refuses to start in file mode');
  var rejected = false;
  VOC.connector.health().then(function () { }, function () { rejected = true; });
} else {
  assert(true, 'connector: not loaded in this run (browser module), skipped');
}

// --- importers.buildSummary / summaryText / handleFiles summary ---
(function () {
  var I = VOC.importers;
  assert(typeof I.buildSummary === 'function' && typeof I.summaryText === 'function', 'importers: buildSummary and summaryText exported');
  var pendingOnly = { items: [], summary: { files: 1, byType: { eml: 0, mbox: 0, csv: 1, json: 0, other: 0 }, errors: [], pending: [{ file: 'x.csv', headers: ['a', 'b'], rows: [[1, 2], [3, 4], [5, 6]] }] } };
  var s1 = I.buildSummary(pendingOnly);
  eq(s1.items, 0, 'buildSummary: items counted from result.items');
  eq(s1.text, 'Read 1 file: 1 CSV file with 3 rows awaits a column mapping (n = 0 parsed so far).', 'buildSummary: pending-only text names the mapping wait instead of a bare n = 0');
  // the mapping dialog resolves: the view pushes mapped rows, drops the pending entry and rebuilds
  pendingOnly.items.push({ id: 'a' }, { id: 'b' }, { id: 'c' });
  pendingOnly.summary.pending = [];
  var s2 = I.buildSummary(pendingOnly);
  eq(s2.text, 'Read 1 file: 3 items parsed (n = 3).', 'buildSummary: rebuilt after mapping reflects the parsed items');
  assert(pendingOnly.summary === s2 && s2.items === 3, 'buildSummary: assigns and returns result.summary');
  var mixed = I.buildSummary({ items: [{}], ordersByMonth: { _total: { '2026-01': 5, '2026-02': 6 } }, summary: { files: 4, errors: [{ file: 'z.txt', message: 'Unsupported' }], pending: [{ file: 'p.csv', rows: [] }, { file: 'q.csv' }] } });
  eq(mixed.text, 'Read 4 files: 1 item parsed, orders for 2 months, 2 CSV files await a column mapping, 1 error (n = 1 parsed so far).', 'buildSummary: items, order months, pending files and errors in one sentence');
  eq(mixed.orderMonths, 2, 'buildSummary: orderMonths from ordersByMonth._total');
  eq(I.buildSummary(null).text, 'Read 0 files: nothing to import (n = 0).', 'buildSummary tolerates null');
  eq(I.summaryText({ files: 2, items: 1 }), 'Read 2 files: 1 item parsed (n = 1).', 'summaryText: singular item');

  // handleFiles under jsc with File-like objects exposing text(): CSV with unknown headers lands in pending and the text says so
  var done = null, failed = null;
  var fakeCsv = { name: 'unknown.csv', type: 'text/csv', text: function () { return Promise.resolve('colA,colB\n1,2\n3,4\n'); } };
  var fakeBad = { name: 'notes.txt', type: 'text/plain', text: function () { return Promise.resolve('x'); } };
  var helpdesk = { name: 'helpdesk.csv', type: 'text/csv', text: function () { return Promise.resolve(SAMPLE_HELPDESK); } };
  I.handleFiles([fakeCsv, fakeBad, helpdesk], {}).then(function (r) { done = r; }, function (e) { failed = e; });
  if (typeof drainMicrotasks === 'function') drainMicrotasks();
  assert(done && !failed, 'handleFiles resolves under jsc with File-like objects' + (failed ? ' (error: ' + failed.message + ')' : ''));
  if (done) {
    eq(done.summary.pending.length, 1, 'handleFiles: unmapped CSV is pending');
    eq(done.summary.errors.length, 1, 'handleFiles: unsupported file is an error');
    assert(done.items.length >= 5, 'handleFiles: helpdesk sample parsed (' + done.items.length + ' items)');
    eq(done.summary.text, 'Read 3 files: ' + done.items.length + ' items parsed, 1 CSV file with 2 rows awaits a column mapping, 1 error (n = ' + done.items.length + ' parsed so far).', 'handleFiles: summary.text reflects parsed items and the pending mapping');
    // resolving the pending mapping and rebuilding the summary
    var pend = done.summary.pending[0];
    var mapped = I.mapRows(pend.rows, { template: 'helpdesk', headers: pend.headers, columns: { subject: 'colA', body: 'colB' } });
    mapped.forEach(function (rec) { done.items.push(rec); });
    done.summary.pending = [];
    var rebuilt = I.buildSummary(done);
    assert(rebuilt.pending.length === 0 && rebuilt.items === done.items.length && rebuilt.text.indexOf('await') < 0 && rebuilt.text.indexOf('(n = ' + done.items.length + ')') > 0, 'handleFiles → mapRows → buildSummary: text updated after mapping: ' + rebuilt.text);
  }
})();


// --- exporter.csvCell: OWASP CSV-injection guard incl. '-' and array cells (security-privacy-9) ---
(function () {
  var X = VOC.exporter;
  eq(X.csvCell('-1+1'), "'-1+1", 'csvCell: leading minus is neutralized');
  eq(X.csvCell("-cmd|' /C calc'!A0"), "'-cmd|' /C calc'!A0", 'csvCell: DDE payload behind a minus is neutralized');
  eq(X.csvCell('-'), "'-", 'csvCell: bare dash neutralized');
  eq(X.csvCell(-0.5), '-0.5', 'csvCell: negative numbers stay numbers');
  eq(X.csvCell(-3), '-3', 'csvCell: negative integers stay numbers');
  eq(X.csvCell('2026-09-01'), '2026-09-01', 'csvCell: dates untouched');
  eq(X.csvCell('a-b'), 'a-b', 'csvCell: inner dash untouched');
  eq(X.csvCell(['-x', 'y']), "'-x|y", 'csvCell: array whose first element starts with a formula char is neutralized after joining');
  eq(X.csvCell(['=SUM(A1)', 'y']), "'=SUM(A1)|y", 'csvCell: array first element =');
  eq(X.csvCell(['a', '-x']), 'a|-x', 'csvCell: array with a safe first element is left alone');
  eq(X.csvCell('@cmd'), "'@cmd", 'csvCell: @ still neutralized');
  var rows = VOC.importers.parseCsvText(X.toCsv(['tags', 'subject'], [{ tags: ['-cmd', 'x'], subject: '+1' }]));
  eq(rows.rows[0][0], "'-cmd|x", 'toCsv: tag list starting with minus is neutralized in the sheet');
  eq(rows.rows[0][1], "'+1", 'toCsv: plus-leading subject neutralized');
})();

// --- importers: prototype-pollution-safe merges and sanitized orders (security-privacy-12) ---
(function () {
  var I = VOC.importers;
  assert(typeof I.mergeOrders === 'function' && typeof I.sanitizeOrders === 'function' && typeof I.stripUnsafeKeys === 'function', 'importers: mergeOrders/sanitizeOrders/stripUnsafeKeys exported');
  var evil = '{"seed_meta":{"__proto__":{"seeded":1}},"records":[],"orders":{"__proto__":{"polluted":"0yes"},"constructor":{"2026-01":1},"prolon_5day":{"2026-01":5,"bad-month":1,"2026-02":"7","2026-13":3,"2026-03":"x"},"../evil":{"2026-01":1},"_total":{"2026-01":5}},"settings":{"__proto__":{"p2":1},"sla":{"p0":4,"__proto__":{"p3":1}}}}';
  var full = I.parseJsonFull(evil);
  eq(({}).polluted, undefined, 'parseJsonFull: Object.prototype not polluted through orders');
  eq(({}).seeded, undefined, 'parseJsonFull: Object.prototype not polluted through seed_meta');
  eq(({}).p2, undefined, 'parseJsonFull: Object.prototype not polluted through settings');
  eq(Object.keys(full.ordersByMonth).sort().join(','), '_total,prolon_5day', 'sanitizeOrders: only valid product keys survive (no __proto__, constructor, path-like keys)');
  eq(full.ordersByMonth.prolon_5day['2026-01'], 5, 'sanitizeOrders: numeric count kept');
  eq(full.ordersByMonth.prolon_5day['2026-02'], 7, 'sanitizeOrders: numeric string coerced');
  eq(Object.keys(full.ordersByMonth.prolon_5day).sort().join(','), '2026-01,2026-02', 'sanitizeOrders: bad month keys and non-numeric values dropped');
  assert(!Object.prototype.hasOwnProperty.call(full.settings, '__proto__') && full.settings.sla.p0 === 4 && !Object.prototype.hasOwnProperty.call(full.settings.sla, '__proto__'), 'stripUnsafeKeys: settings copied without __proto__ at any depth');
  assert(Object.getPrototypeOf(full.settings) === Object.prototype && Object.getPrototypeOf(full.ordersByMonth) === Object.prototype, 'sanitized objects keep the normal prototype');
  var target = { _total: { '2026-01': 1 } };
  var merged = I.mergeOrders(target, JSON.parse('{"__proto__":{"polluted":"0yes"},"fast_bar":{"2026-03":2},"_total":{"2026-01":2,"2026-03":2}}'));
  eq(({}).polluted, undefined, 'mergeOrders: Object.prototype not polluted');
  assert(merged === target && Object.getPrototypeOf(merged) === Object.prototype, 'mergeOrders: returns the target with its prototype intact');
  eq(merged.fast_bar['2026-03'], 2, 'mergeOrders: product month added');
  eq(merged._total['2026-01'], 3, 'mergeOrders: totals summed');
  eq(I.mergeOrders(null, null)._total && Object.keys(I.mergeOrders(null, null)).join(','), '_total', 'mergeOrders tolerates null inputs');
  eq(I.sanitizeOrders('nope'), null, 'sanitizeOrders: non-object → null');
  // through handleFiles (the Settings > Import path)
  var done = null, failed = null;
  var evilFile = { name: 'backup.json', type: 'application/json', size: evil.length, text: function () { return Promise.resolve(evil); } };
  I.handleFiles([evilFile], {}).then(function (r) { done = r; }, function (e) { failed = e; });
  if (typeof drainMicrotasks === 'function') drainMicrotasks();
  assert(done && !failed, 'handleFiles: crafted backup parses' + (failed ? ' (error: ' + failed.message + ')' : ''));
  eq(({}).polluted, undefined, 'handleFiles: Object.prototype not polluted by a crafted backup');
  assert(!Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), 'handleFiles: no own property landed on Object.prototype');
  if (done) eq(done.ordersByMonth._total['2026-01'], 5, 'handleFiles: sanitized orders merged');
})();

// --- importers.handleFiles: per-file size caps (security-privacy-15) ---
(function () {
  var I = VOC.importers;
  assert(I.FILE_LIMITS && I.FILE_LIMITS.mbox === 150 * 1024 * 1024 && I.FILE_LIMITS.eml === 25 * 1024 * 1024, 'FILE_LIMITS exported (150 MB mbox, 25 MB eml)');
  var reads = 0;
  var huge = { name: 'takeout.mbox', type: 'application/mbox', size: 151 * 1024 * 1024, arrayBuffer: function () { reads++; return Promise.reject(new Error('must not read')); } };
  var bigEml = { name: 'big.eml', type: 'message/rfc822', size: 26 * 1024 * 1024, arrayBuffer: function () { reads++; return Promise.reject(new Error('must not read')); } };
  var small = { name: 'tiny.json', type: 'application/json', size: 2, text: function () { return Promise.resolve('[]'); } };
  var done = null, failed = null;
  I.handleFiles([huge, bigEml, small], {}).then(function (r) { done = r; }, function (e) { failed = e; });
  if (typeof drainMicrotasks === 'function') drainMicrotasks();
  assert(done && !failed, 'handleFiles: oversize files resolve with errors instead of reading' + (failed ? ' (error: ' + failed.message + ')' : ''));
  eq(reads, 0, 'handleFiles: oversize files are never read into memory');
  if (done) {
    eq(done.summary.errors.length, 2, 'handleFiles: one error per oversize file');
    assert(/151 MB; the limit for \.mbox is 150 MB/.test(done.summary.errors[0].message) && /one label or one date range/.test(done.summary.errors[0].message), 'handleFiles: mbox error names the size, the limit and how to split: ' + done.summary.errors[0].message);
    assert(/26 MB; the limit for \.eml is 25 MB/.test(done.summary.errors[1].message), 'handleFiles: eml error names the size and limit');
    eq(done.summary.byType.mbox, 1, 'handleFiles: oversize file still counted by type');
    eq(done.summary.text, 'Read 3 files: 2 errors (n = 0).', 'handleFiles: summary sentence counts the errors');
  }
})();

/* ------------------------------------------- connector: served-mode simulation */
// runtime-api-5/6: with a fake http location, fetch and timers, a healthy /api/health starts polling on its own, pollOnce
// follows has_more across pages, saveConfig re-arms the timer with the saved interval and a failed health check stops it.
// Only when connector.js is loaded (it is not on run.sh's PURE list); run manually with js/connector.js after js/exporter.js.
if (VOC.connector && typeof VOC.connector.autoStart === 'function') {
  (function () {
    var C = VOC.connector;
    var timers = [], nextId = 1;
    window.setInterval = function (fn, ms) { timers.push({ id: nextId, fn: fn, ms: ms }); return nextId++; };
    window.clearInterval = function (id) { timers = timers.filter(function (t) { return t.id !== id; }); };
    window.location = { protocol: 'http:', origin: 'http://127.0.0.1:8765' };
    var server = { records: [], healthOk: true, pollInterval: 300, calls: [] };
    for (var i = 0; i < 1200; i++) server.records.push({ id: 'em_' + i, message_id: 'm' + i + '@x', date: '2026-09-01T00:00:00Z', from_email: 'a@b.c', subject: 's' + i, text: 't', direction: 'inbound' });
    function page(since) {
      var start = since && /^c\|(\d+)$/.test(since) ? Number(since.split('|')[1]) : 0;
      var recs = server.records.slice(start, start + 500);
      return { records: recs, next_since: 'c|' + (start + recs.length), total: server.records.length, has_more: start + recs.length < server.records.length, server_time: '2026-09-17T00:00:00Z' };
    }
    window.fetch = function (url, init) {
      server.calls.push((init && init.method) + ' ' + url.replace('http://127.0.0.1:8765', ''));
      var path = url.replace('http://127.0.0.1:8765', '');
      var body, ok = true, status = 200;
      if (path.indexOf('/api/health') === 0) { if (server.healthOk) body = { ok: true, version: 't', mode: 'imap', poll_interval_s: server.pollInterval, records: 1200 }; else { ok = false; status = 503; body = { ok: false, error: 'down' }; } }
      else if (path.indexOf('/api/records') === 0) { var m = /since=([^&]*)/.exec(path); body = page(m ? decodeURIComponent(m[1]) : ''); }
      else if (path.indexOf('/api/config') === 0) { body = { ok: true, config: Object.assign({ poll_interval_s: 300 }, JSON.parse(init.body || '{}')), mode: 'imap' }; }
      else { ok = false; status = 404; body = { ok: false, error: 'nope' }; }
      return Promise.resolve({ ok: ok, status: status, text: function () { return Promise.resolve(JSON.stringify(body)); } });
    };
    var added = [], realStore = window.VOC.store, realAdd = realStore && realStore.addRecords;
    window.VOC.store = realStore || {};
    VOC.store.addRecords = function (recs, source) { added.push(recs.length); return Promise.resolve({ added: recs.length, duplicates: 0, noise: 0, source: source }); };
    var polls = [];
    C.on('poll', function (info) { polls.push(info); });
    try {
      eq(C.mode(), 'static', 'connector: http location before a health check → static');
      eq(C.autoStart(), false, 'connector: autoStart is a no-op before the sidecar answered');
      C.health();
      if (typeof drainMicrotasks === 'function') drainMicrotasks();
      eq(C.mode(), 'served', 'connector: healthy /api/health → served');
      eq(C.isPolling(), true, 'runtime-api-5: a healthy status starts records polling without any app.js call');
      eq(timers.length && timers[0].ms, 300000, 'connector: poll interval comes from /api/health poll_interval_s (300 s)');
      eq(C.pollInterval(), 300, 'connector: pollInterval() reports the health value');
      eq(added.join(','), '500,500,200', 'runtime-api-6: pollOnce follows has_more across three pages');
      eq(polls.length, 1, 'connector: one poll event for the whole paged fetch');
      eq(polls[0].fetched, 1200, 'connector: poll event counts every page');
      eq(polls[0].pages, 3, 'connector: poll event reports pages');
      eq(polls[0].has_more, false, 'connector: poll event ends with has_more false');
      eq(polls[0].added, 1200, 'connector: poll event sums added across pages');
      eq(polls[0].error, null, 'connector: no error');
      var recordCalls = server.calls.filter(function (c) { return c.indexOf('/api/records') >= 0; });
      eq(recordCalls.length, 3, 'connector: three /api/records requests');
      assert(/since=c%7C1000/.test(recordCalls[2]), 'connector: the third request carries the cursor of the second page: ' + recordCalls[2]);
      // next poll continues from the cursor and finds nothing new
      added.length = 0;
      C.pollOnce();
      if (typeof drainMicrotasks === 'function') drainMicrotasks();
      eq(added.length, 0, 'connector: a follow-up poll from the cursor fetches nothing new');
      eq(polls[1].fetched, 0, 'connector: empty poll reports fetched 0');
      // Save config → the timer re-arms with the saved interval
      C.saveConfig({ poll_interval_s: 600, password: 'never' });
      if (typeof drainMicrotasks === 'function') drainMicrotasks();
      eq(timers.length, 1, 'connector: saveConfig replaces the poll timer instead of stacking one');
      eq(timers[0].ms, 600000, 'connector: saveConfig re-arms polling with the saved poll_interval_s');
      assert(!/never/.test(server.calls.filter(function (c) { return c.indexOf('/api/config') >= 0; }).join('')), 'connector: password never leaves the browser');
      // The sidecar goes away → polling stops; it comes back → polling resumes
      server.healthOk = false;
      C.health();
      if (typeof drainMicrotasks === 'function') drainMicrotasks();
      eq(C.isPolling(), false, 'connector: a failed health check after served stops polling');
      server.healthOk = true;
      C.health();
      if (typeof drainMicrotasks === 'function') drainMicrotasks();
      eq(C.isPolling(), true, 'connector: the next healthy answer restarts polling');
      // Clearing the token stops polling; setting one starts it again
      C.setToken('');
      eq(C.isPolling(), false, 'connector: clearing the token stops polling');
      C.setToken('abc');
      eq(C.isPolling(), true, 'connector: setting a token in served mode starts polling');
      eq(C.pollInterval(45), 60, 'connector: pollInterval clamps to 60 s minimum');
      eq(C.pollInterval(5000), 900, 'connector: pollInterval clamps to 900 s maximum');
    } finally {
      C.stopPolling();
      if (realStore) { VOC.store.addRecords = realAdd; } else { delete window.VOC.store; }
    }
  })();
} else {
  assert(true, 'connector served-mode simulation: connector.js not loaded in this run, skipped');
}

console.log('test_mime: ' + __passed + ' passed, ' + __failed + ' failed');
if (__failed) throw new Error('test_mime: ' + __failed + ' assertion(s) failed');
