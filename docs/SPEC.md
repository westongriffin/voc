# L-Nutra Voice of the Customer — Build Specification (v1.0, 2026-09-17)

This is the single source of truth for every module. If code and this document disagree, fix the code (or edit this document deliberately and tell the integrator). Research briefs that informed it live in the session scratchpad; the synthesized long-form spec was trimmed to this buildable scope.

## 0. Purpose, constraints, conventions

**Product.** A Voice of the Customer (VoC) reporting site for L-Nutra (ProLon fasting-mimicking diet, Fast Bar, Fasting Shake, L-Protein, L-Pill, Guided Health, L-Nutra Health). It opens as an executive briefing, works as a triage inbox, and exposes an analytics workstation with forecasting, anomaly and emerging-issue detection, churn and escalation risk, driver analysis and regulatory clocks. It ships with a realistic 12-month seeded dataset and imports real mail in the browser (.eml/.mbox/.csv/.json) or through a zero-dependency Python sidecar that polls an IMAP mailbox.

**Hard constraints.**
- Static multi-file site: `index.html` + `css/` + `js/`. Plain `<script>` tags, **no ES modules, no bundler, no fetch() of local files** — it must work from `file://` on macOS (Chrome, Safari, Firefox) and when served by `python3 server/voc_server.py`.
- Only external resources: Chart.js **4.5.1** from cdnjs (`https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js`) and Google Fonts. Everything else inline/local.
- Node is NOT installed. Python 3.9 stdlib only for tooling and the sidecar (`imaplib, email, ssl, http.server, json, re, threading, secrets, smtplib, unittest`).
- Headless JS testing uses macOS JavaScriptCore: `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc`. `tests/_jsc_shim.js` defines `console`, `window`, `self`. Any module listed as **pure** in §1 must load and run under jsc: no DOM/localStorage/indexedDB/Chart access at load time, and every such access inside functions is guarded (`typeof document !== 'undefined'`).
- Vanilla JS (ES2020 is fine: optional chaining, `??`, classes, `Intl`). No TypeScript.
- Namespace: every module does `window.VOC = window.VOC || {}; VOC.<module> = {...}` (in jsc, `window === this` via the shim). Modules never depend on load order at parse time except that `util.js` is loaded first (they may call `VOC.util` inside functions).
- Dates: records store ISO-8601 UTC strings. Bucketing/display use **America/Chicago** via `Intl.DateTimeFormat` (`VOC.util.parts`). Week keys are ISO weeks starting Monday, `'2026-W37'`; day keys `'2026-09-14'`; month keys `'2026-09'`.
- All user-facing copy: active voice, ranges not point claims for forecasts ("about 23, likely 15–31"), never the word "will" in generated narrative, every statistic carries its n.

**Demo clock.** `VOC_SEED.meta.as_of = '2026-09-16T23:59:00Z'`. `VOC.store.now()` returns `as_of` while `settings.clock === 'demo'` (default) and returns the wall clock when `settings.clock === 'real'` or when imported/live records newer than `as_of` exist. Every age, SLA, deadline, range preset and detection window uses `store.now()`. The header shows a "Demo clock · Sep 16, 2026" badge in demo mode.

## 1. Files and ownership

```
index.html                      shell (A2)
css/tokens.css                  design tokens light/dark (A2)
css/base.css                    reset, type, layout grid, rail/tabbar, filter bar (A2)
css/components.css              cards, tiles, pills, tables, drawer, toast, popover, dropzone (A2)
css/views.css                   per-view layout rules (A2; view agents may append)
css/print.css                   report/print stylesheet (A2)
js/util.js          PURE        enums+labels, fmt, dates/tz/holidays, stats, PRNG, misc (A1)
js/db.js                        IndexedDB wrapper with memory fallback (A1)
js/store.js         PURE*       records, filters, overlays, derived state, events (A1)  *guards browser APIs
js/alerts.js        PURE        alert rules + evaluate(derived) (A1)
js/router.js                    hash router (A2)
js/app.js                       boot, theme, nav, filter bar, keyboard, view mounting (A2)
js/components.js                UI kit: kpiTile, chartCard, table, drawer, pills, toast, popover, dropZone, emptyState, confirm (A2)
js/charts.js                    Chart.js wrappers, palette/slots, sparkline, heatmap, table twin (A3)
js/lexicon.js       PURE        sentiment lexicon + domain layer + stopwords (B)
js/rules.js         PURE        category/subcategory regex rules, product aliases, safety, urgency, noise (B)
js/classify.js      PURE        pipeline: preprocess → noise → language → sentiment → category → product → safety → urgency → entities → flags (B)
js/analytics.js     PURE        metrics registry, bucketing, share of voice, theme impact, segments, text mining (C)
js/predict.js       PURE        forecasting, anomalies, emerging, churn, escalation, CSAT/NPS regression, drivers, what-changed, SLA breach, backtests (D)
js/narrate.js       PURE        headline, insight cards, sentences, lint (H)
js/report.js        PURE        weekly/monthly report HTML strings (H)
js/mime.js          PURE        RFC 5322/2045/2047 parsing of .eml text (F)
js/importers.js     PURE*       .eml/.mbox/.csv/.json → RawEmail/Record; CSV mapping templates (F) *File reading guarded
js/exporter.js      PURE*       CSV/JSON building; downloadBlob guarded (F)
js/connector.js                 sidecar client: health/status/records polling, config save, live-data.js reload (F)
js/data.js                      window.VOC_SEED — GENERATED by tools/generate_seed.py, never hand-edited (E)
js/live-data.js                 OPTIONAL window.VOC_LIVE written by the sidecar; index.html loads it with onerror tolerated (G writes it at runtime)
js/views/briefing.js, trends.js, themes.js, products.js, customers.js, inbox.js, regulatory.js, predict.js, alerts.js, reports.js, methods.js, settings.js   (phase 2)
tools/generate_seed.py          deterministic seed generator (E)
tests/_jsc_shim.js              console/window shim for jsc (exists)
tests/run.sh                    runs every tests/test_*.js under jsc, exits non-zero on failure (T)
tests/test_*.js                 per-module assertions (each module owner writes their own)
samples/sample.eml, sample-quoted-rfc2047.eml, sample.mbox, sample-helpdesk.csv, sample-orders.csv  (F)
server/voc_server.py, server/config.example.json, server/test_voc_server.py, server/README.md (G)
README.md                       top-level: what it is, how to open, how to connect a mailbox (integrator)
docs/SPEC.md                    this file
```

`index.html` script order (all classic scripts, none `defer`): Chart.js CDN (with `onerror="window.VOC_CHARTS_FAILED=true"`) → util → db → lexicon → rules → classify → data → live-data (onerror tolerated) → store → analytics → predict → alerts → narrate → charts → components → mime → importers → exporter → connector → report → router → views/* → app. `app.js` ends with `document.addEventListener('DOMContentLoaded', () => VOC.app.boot())`.

Test harness (`tests/run.sh`):
```
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
PURE="js/util.js js/lexicon.js js/rules.js js/classify.js js/data.js js/store.js js/analytics.js js/predict.js js/alerts.js js/narrate.js js/report.js js/mime.js js/importers.js js/exporter.js"
for t in tests/test_*.js; do "$JSC" tests/_jsc_shim.js $PURE "$t" || fail; done
```
A test file uses a tiny inline `assert(cond, msg)` that prints `PASS`/`FAIL` lines and calls `throw` at the end if any failed (jsc exits non-zero on uncaught throw). jsc has no `console` (the shim provides it) and no `load()`; everything is passed on the command line.

## 2. Data model

```js
Record = {
  id: 'r_000001' | 'em_<hex16>' | 'im_<hex16>',      // seed | sidecar mail | browser import (fnv64 of fingerprint)
  schema_version: 1,
  received_at: '2026-09-14T15:22:00Z',               // ISO UTC
  channel: ChannelId, sales_channel: SalesChannelId,
  from_name: string|null, from_email: string|null,   // seed uses synthetic names/emails
  subject: string, text: string,                     // text = cleaned plain text (quotes/signatures stripped)
  language: 'en'|'other'|'unknown',
  has_attachment: boolean,
  product: ProductId, product_variant: string|null, kit_component: KitComponentId|null,
  product_class: 'supplement'|'conventional_food'|'program'|'none',
  category: CategoryId, subcategory: SubcategoryId, secondary_categories: CategoryId[],
  sentiment: number,               // -1..1 compound from the lexicon (mean of sentence compounds)
  sentiment_min: number,           // worst sentence
  sentiment_label: 'positive'|'neutral'|'negative'|'unscored',   // ±0.15 thresholds; 'unscored' when language !== 'en'
  nps: 0..10|null, rating: 1..5|null, csat: 1..5|null,   // rating is never converted to nps
  urgency: 'P0'|'P1'|'P2'|'P3',
  status: 'new'|'open'|'pending'|'resolved'|'reopened'|'escalated'|'closed_noise',
  first_response_at: ISO|null, resolved_at: ISO|null, reopen_count: int,
  service_fields_source: 'seed'|'helpdesk_import'|'sent_folder'|'manual'|'unavailable',
  escalated_to: 'none'|'quality_regulatory'|'finance'|'cs_lead'|'legal'|'medical',
  is_adverse_event: boolean, serious_ae: boolean,
  ae_criteria: ('death'|'life_threatening'|'hospitalization'|'disability'|'birth_defect'|'intervention')[],
  contraindication_flags: ('pregnancy'|'minor'|'glucose_meds'|'nut_soy_allergy'|'bmi_low'|'serious_disease')[],
  food_safety: boolean,
  lot_number: string|null, order_id: string|null, hcp_code: string|null,
  claim_related: boolean, cancel_intent: boolean, restricted: boolean,   // restricted = HCP-patient / L-Nutra Health patient mail (PHI-adjacent)
  customer_id: 'c_<hex16>', segment: SegmentId, region: RegionId,
  thread_id: string, is_first_contact: boolean, message_id: string|null,
  source: 'seed'|'imap'|'eml'|'mbox'|'csv'|'json'|'manual',
  is_noise: boolean, noise_reason: 'auto_reply'|'bounce'|'newsletter'|'duplicate'|null,
  assignee: string|null, tags: string[], notes: Note[],                       // overlay-owned
  classifier: { confidence: 0..1, rule_category: CategoryId, rule_subcategory: SubcategoryId,
                rule_product: ProductId, manual_override: boolean, needs_review: boolean }
}
Note = { at: ISO, by: string, text: string }
AuditEntry = { at: ISO, by: string, field: string, from: any, to: any }
Overlay = { id, status?, assignee?, tags?, notes?, category?, subcategory?, product?, urgency?, recovered?: boolean|null,
            is_adverse_event?, serious_ae?, audit: AuditEntry[], updated_at: ISO }      // stored separately; applied over base records
Customer = { customer_id, display_name, email, segment: SegmentId, sales_channel: SalesChannelId, region: RegionId,
             first_seen: ISO, orders_12m: int, ltv_usd: number, subscriber: boolean,
             subscription_status: 'none'|'active'|'paused'|'cancelled', subscription_cadence_months: 1|2|3|4|null,
             subscription_value_12m_usd: number|null, cancelled_at: ISO|null, cancel_reason: string|null,
             hcp_code: string|null, practice_id: string|null, restricted: boolean }
Practice = { practice_id, name, type: 'physician'|'np'|'chiropractor'|'rd'|'health_coach'|'weight_loss_center'|'fitness_studio', region }
OrdersByMonth = { _total: {'YYYY-MM': int}, [ProductId]: {'YYYY-MM': int} }
Seed = { meta: { schema_version: 1, seed: 20260917, generated: '2026-09-17', as_of: '2026-09-16T23:59:00Z',
                 range: ['2025-09-15','2026-09-16'], timezone: 'America/Chicago', agents: ['Maya R.','Devon K.','Priya S.','Jordan T.'],
                 planted_events: [{id, from, to, title, detector, expected}] },
         records: Record[], customers: Customer[], practices: Practice[], orders_by_month: OrdersByMonth }
RawEmail = { message_id, thread_id, in_reply_to, references: string[], date: ISO, from_name, from_email, to: string[], cc: string[],
             subject, text, html: string|null, direction: 'inbound'|'outbound', attachments: [{name, type, size}],
             headers: { auto_submitted, precedence, list_id, list_unsubscribe, content_type, x_autoreply } , source }
```

**Derived fields** (computed by `store.derive(record, now)`, attached to the record objects returned by `store.all()`, never persisted): `sentiment_index = (sentiment+1)/2*100` (0–100 "points"), `is_complaint` (`sentiment < -0.1 || category ∈ COMPLAINT_CATEGORIES`), `is_detractor (nps<=6)`, `is_promoter (nps>=9)`, `age_hours`, `frt_hours|null`, `resolution_hours|null`, `sla_frt_hours` (P0 1, P1 4, P2 24, P3 72 — editable in settings), `sla_frt_breached`, `is_open` (status ∈ new/open/pending/reopened/escalated), `day_key`, `week_key`, `month_key`, `dow` (0=Mon..6=Sun), `hour` (0–23 CT), `regulatory_clock: 'medwatch_15bd'|'rfr_24h'|'none'`, `regulatory_deadline: ISO|null`, `business_days_remaining|null`, `hours_remaining|null`, `churn_score|null` (per customer), `escalation_score|null` (open records), `pred_csat|null` (open records).

`COMPLAINT_CATEGORIES = ['subscription_billing','checkout_website','shipping_fulfillment','missing_damaged','taste_quality','foreign_material_allergen','side_effects','adverse_event','customer_service','price_value']`.

## 3. Enums and display labels (`VOC.enums` in util.js — the only place labels live)

```js
PRODUCTS: prolon_5day 'ProLon 5-Day', prolon_nextgen 'ProLon Next Gen', prolon_reset 'ProLon 1-Day Reset', prolon_52 'ProLon 5:2',
          fast_bar 'Fast Bar', fasting_shake 'Fasting Shake', l_protein 'L-Protein', l_pill 'L-Pill', starter_pack 'Longevity Starter Pack',
          guided_health 'Guided Health Program', lnutra_health 'L-Nutra Health', subscription_account 'Subscription & Account', general 'General'
PRODUCT_CLASS: prolon_* / fast_bar / fasting_shake / l_protein / starter_pack → conventional_food; l_pill → supplement;
               guided_health / lnutra_health → program; subscription_account / general → none
KIT_COMPONENTS: soup_tomato, soup_vegetable, soup_minestrone, soup_minestrone_quinoa, soup_artichoke, soup_broccoli_quinoa, soup_mushroom,
                l_bar, choco_crisp, olives, kale_crackers, l_drink, nr1, algal_oil, tea   (labels: 'Tomato soup', … 'L-Drink', 'NR-1', 'Algal oil', 'Herbal tea')
CATEGORIES (order = display order):
  subscription_billing 'Subscription & Billing', checkout_website 'Checkout & Website', shipping_fulfillment 'Shipping & Delivery',
  missing_damaged 'Missing or Damaged Items', taste_quality 'Taste & Food Quality', foreign_material_allergen 'Foreign Material & Allergen',
  side_effects 'Side Effects', adverse_event 'Adverse Event (serious)', efficacy_results 'Results & Efficacy', price_value 'Price & Value',
  customer_service 'Customer Service', hcp_practitioner 'Practitioner & HCP', marketing_email 'Marketing & Email', usage_guidance 'Usage Guidance',
  product_request 'Product Requests', praise 'Praise', other_noise 'Noise'
SUBCATEGORIES (per category, closed):
  subscription_billing: unauthorized_signup, auto_renew_surprise, cancel_friction, post_cancel_shipment, duplicate_charge, refund_status, promo_not_applied, discount_math, pause_skip
  checkout_website: checkout_error, mobile_checkout, unwanted_addon, promo_code, hcp_code_entry, login_account, app_bug
  shipping_fulfillment: late, lost, tracking, porch_drop, heat_damage, international_customs
  missing_damaged: missing_item, welcome_kit_missing, leaking, crushed_melted, damaged_seal
  taste_quality: soup_taste, texture, l_drink_taste, olives, bar_taste, portion, expiry_short_dated
  foreign_material_allergen: hard_bits, shell_fragment, allergen_exposure, mold_spoilage, undeclared_allergen
  side_effects: hunger, headache, fatigue, dizziness, brain_fog, nausea_gi, cold, sleep, inulin_ibs
  adverse_event: fainting, er_hospital, allergic_reaction, hypoglycemia_medication, pregnancy_minor, chest_pain
  efficacy_results: weight_loss, no_results, regain, energy_clarity, labs_biomarkers
  price_value: too_expensive, per_day_cost, hsa_fsa, bundle_value, price_increase
  customer_service: no_response, slow_response, wrong_item_sent, great_agent, chatbot_loop
  hcp_practitioner: account_setup, bulk_order, patient_protocol, evidence_request
  marketing_email: too_many_emails, influencer_skepticism, misleading_claim
  usage_guidance: coffee_exercise, medications, refeed_transition, cycle_frequency, general_question
  product_request: new_flavor, allergen_free, sample_pack, longer_program
  praise: results_praise, convenience, cs_praise, nextgen_taste, general_praise
  other_noise: auto_reply, bounce, newsletter, duplicate
CHANNELS: email 'Email', amazon_review 'Amazon review', trustpilot_review 'Trustpilot review', survey 'Survey', chat 'Chat', social 'Social', phone_note 'Phone note', hcp_portal 'HCP portal'
SALES_CHANNELS: dtc_web 'prolonlife.com', amazon 'Amazon', hcp 'Practitioner', lnutra_health 'L-Nutra Health', employer 'Employer program', social_affiliate 'Social / affiliate', international 'International store'
SEGMENTS: first_time 'First-time', repeat 'Repeat', subscriber 'Subscriber', hcp 'Practitioner', hcp_patient 'Practitioner patient', lnh_patient 'L-Nutra Health patient', employer 'Employer member', wholesale 'Wholesale'
REGIONS: US, CA, UK, EU, DE, IT, AU, AE, OTHER
STATUSES: new 'New', open 'Open', pending 'Pending', resolved 'Resolved', reopened 'Reopened', escalated 'Escalated', closed_noise 'Closed (noise)'
URGENCY: P0 'P0 · Critical', P1 'P1 · High', P2 'P2 · Normal', P3 'P3 · Low';  SLA_FRT_HOURS = {P0:1, P1:4, P2:24, P3:72}
ESCALATION_TARGETS: none, quality_regulatory 'Quality & Regulatory', finance 'Finance', cs_lead 'CS lead', legal 'Legal', medical 'Medical'
```
Helper: `VOC.enums.label(kind, id) → string` (falls back to the id), `VOC.enums.list(kind) → [{id,label}]`, `VOC.enums.subcategories(categoryId) → [{id,label}]` (labels = Title Case of id with underscores → spaces, with overrides for a few: `l_drink_taste 'L-Drink taste'`, `hcp_code_entry 'HCP code entry'`, `er_hospital 'ER / hospital'`, `hsa_fsa 'HSA / FSA'`, `inulin_ibs 'Inulin / IBS'`, `nextgen_taste 'Next Gen taste'`).

## 4. Module contracts

All functions synchronous unless marked `→ Promise`. Arrays of records are plain arrays of `Record` (with derived fields when they came from the store).

### 4.1 `VOC.util`
```js
enums (see §3)
fmt: { num(n, digits=0), pct(p01, digits=0) /* 0.234→'23%' */, pts(n) /* '61 pts' */, hours(h) /* '5.2h', '2.1d' */, delta(cur, prev, {unit}) → {text:'+18%', sign:1|0|-1, abs},
       date(iso, gran='day'|'week'|'month'|'datetime'), range(fromIso, toIso), int(n) /* '1,204' */, usd(n) }
tz: 'America/Chicago'; parts(iso) → {y,m,d,dow /*0=Mon*/,hour,minute}; dayKey(iso); weekKey(iso) → '2026-W37'; monthKey(iso); weekStart(weekKey) → ISO date of Monday;
    addDays(isoDate, n) → isoDate; daysBetween(a, b); isoDate(date) → 'YYYY-MM-DD' in CT; startOfDayCT(isoDate) → ISO UTC
US_HOLIDAYS: {2025:[...],2026:[...],2027:[...]} (federal, observed dates); isBusinessDay(isoDate); addBusinessDays(iso, n) → ISO; businessDaysBetween(aIso, bIso) → number (fractional ok)
stats: mean(a), median(a), std(a) /* n-1 */, percentile(a, p01), sum(a), wilson(k, n, z=1.96) → {lo, hi}, poissonExact(k, z=1.96) → {lo, hi} /* Garwood via chi-square approx or Byar */, quantiles
rng(seed) → () => [0,1) mulberry32; randNormal(r, mu, sd); poisson(r, lambda); weightedChoice(r, items, weights)
fnv64(str) → hex16; normalizeEmail(e) → lower, trim, strip +tag, gmail dots removed
maskPii(text) → text with emails/phones/order numbers masked; redactRecord(rec) → copy with from_name 'Redacted', from_email null, subject '[restricted]', text '[restricted — open the queue to view]', order_id null, hcp_code null, redacted true (lot_number, category, subcategory and product stay)
tokenize(text) → string[] (lowercase, letters/digits/apostrophes, drop <2 chars); sentences(text) → string[]
debounce(fn, ms); escapeHtml(s); el(tag, attrs, children) /* guarded: only usable in browser */; uid(prefix)
clamp(x, lo, hi); round(x, d); groupBy(arr, keyFn) → Map; countBy(arr, keyFn) → Map; sortBy(arr, keyFn, dir)
```

### 4.2 `VOC.db`
```js
open() → Promise<'idb'|'memory'>        // database 'voc' v1, stores: records, overlays, meta (keyPath 'id')
getAll(store) → Promise<any[]>; get(store, id); put(store, obj); bulkPut(store, arr); remove(store, id); clear(store)
persistence() → 'idb'|'memory'|'unknown'
```
Falls back to an in-memory Map when `indexedDB` is undefined or `open` rejects/times out (2 s).

### 4.3 `VOC.lexicon`, `VOC.rules`
```js
VOC.lexicon = { version:'1.0.0', BASE:{term: valence(-4..4)} /* ~450 general terms */, DOMAIN:{...} /* ~120 L-Nutra terms, phrases allowed with spaces */,
  BOOSTERS:{very:0.293,...}, DAMPENERS:{slightly:-0.293,...}, NEGATORS:[...], BRAND_STOPLIST:['prolon','fast','bar','reset','next','gen','longevity','l-drink','l-nutra','nutra','fasting'],
  STOPWORDS:[...~170 en + domain fillers], valence(term) → number|undefined }
VOC.rules = { version:'1.0.0',
  categories: [{ id, priority /* 1 = highest */, subcategories: [{ id, patterns: [{ re: RegExp, w: number }] }] }],
  productAliases: [{ re, product, variant?, w }], components: [{ re, id }],
  safety: { serious: RegExp[], nonSerious: RegExp[], contra: { pregnancy: RegExp, minor, glucose_meds, nut_soy_allergy, bmi_low, serious_disease }, food: RegExp[] },
  p0: RegExp[] /* legal/BBB/chargeback/press */, claim: RegExp[], cancel: RegExp[], restricted: RegExp[],
  noise: { subject: RegExp, headerChecks(headers) → reason|null },
  entities: { order: RegExp[], lot: RegExp, hcp: RegExp } }
```
Priority order for ties (top two within 20%): adverse_event > foreign_material_allergen > subscription_billing > shipping_fulfillment > missing_damaged > taste_quality > side_effects > customer_service > checkout_website > price_value > efficacy_results > hcp_practitioner > usage_guidance > product_request > marketing_email > praise.

### 4.4 `VOC.classify`
```js
preprocess(text, html=null) → string           // html→text; cut quoted replies (^On .+ wrote:|-----Original Message-----|^From: .+\nSent:); drop ^> lines; cut signature (^-- $|^Sent from my); collapse whitespace; keep case and !?
isNoise(headers={}, subject='', text='') → { is_noise, reason|null }
detectLanguage(text) → 'en'|'other'|'unknown'  // stopword share ≥0.18 → en; <0.08 with ≥20 tokens → other
scoreSentiment(text) → { compound, min, sentences:[{text, compound}], hits:[{term, valence}] }   // VADER-style (see §7)
scoreCategories(text, subject='') → { scores:{[cat]:number}, category, subcategory, secondary: CategoryId[], confidence }
detectProduct(text, subject='') → { product, product_variant, kit_component, product_class, score }
assessSafety(text) → { is_adverse_event, serious_ae, ae_criteria, contraindication_flags, food_safety }
assignUrgency(partial) → { urgency, escalated_to, reasons: string[] }        // needs category/subcategory/sentiment/nps/segment/safety on partial
extractEntities(text, subject='') → { order_id, lot_number, hcp_code }
flags(text, partial) → { claim_related, cancel_intent, restricted }
fingerprint(raw) → hex16
classifyRecord(raw: RawEmail|Partial<Record>, ctx={now, settings, source}) → Record    // full pipeline, fills every field with defaults
reclassify(rec) → Record                       // re-runs sentiment/category/product/safety/urgency/flags on an existing record; keeps id/customer/status;
                                               //   sets classifier.rule_* and needs_review = rule_category !== category || confidence < 0.5
explain(text, subject='') → { stages: [{name, output}] }   // for the Settings tester
```

### 4.5 `VOC.store` (the integration hub)
```js
init({ seed, live=[], settings }) → Promise<void>   // seed = window.VOC_SEED; applies reclassify() to every seed record (sentiment from lexicon, rule_* for agreement);
                                                    // loads overlays + imported records from VOC.db; merges live RawEmail[] via addRecords; emits 'ready'
ready() → boolean; now() → Date; clockMode() → 'demo'|'real'
all() → Record[]                 // non-noise, overlays applied, derived fields, sorted received_at desc
allWithNoise() → Record[]
filtered() → Record[]            // all() ∩ current filters (range uses received_at in CT dates inclusive)
compareSet() → Record[]          // same filters shifted to the prior period of equal length (or prior year); [] when compare='none'
filters() → FilterState; setFilters(patch); resetFilters(); toQuery() → 'range=30d&product=a,b'; fromQuery(str)
FilterState = { range:{preset:'7d'|'30d'|'90d'|'12m'|'custom', from, to}, compare:'prior_period'|'prior_year'|'none', product:[], category:[], subcategory:[], channel:[], sales_channel:[], segment:[], region:[], urgency:[], status:[], sentiment:[], assignee:[], search:'', restrictedQueue:false, customer:null }
                 // customer: one customer_id ('c_' + 16 hex) or null; serialized as customer=c_… so a Customers drill never puts a name or address in the hash.
                 // The filter bar shows it as a "Customer: <display name>" chip resolved locally (a restricted customer reads "Restricted customer" while redacted).
derived() → DerivedState         // memoized until filters/records change
DerivedState = { now, clockMode: 'demo'|'real' /* the effective clock, so narrate labels match the header badge */, filters, records, compare, n, kpis: {[metricId]: {value, n, prev, delta, interval}}, byDay: [{key, count, neg, pos, meanSentiment}],
                 byWeek: [...same...], byCategory: [{id, count, share, meanSentiment, negShare}], byProduct: [...], bySubcategory, byChannel, bySegment,
                 regulatory: { openSerious: Record[], openFoodSafety: Record[], deadlines: [{rec, clock, deadline, remaining}] }, alerts: Alert[],
                 dq: { n, needsReviewPct, nonEnglishPct, noiseDropped, duplicatesRemoved, agreementCategory, agreementCategoryN, agreementSentiment, agreementSentimentN, ordersCoverageMonths, reclassifyFailures,
                       openOlderThan45d, openTotal, staleOpenDays },   // open-state backlog over the WHOLE store (not the range): open records older than staleOpenDays (45) and the open total
                 compareRange, compareMeta: { n, from, to, thin, reason, earliest }, allRecords, churnMethod: 'fitted'|'heuristic' }
                 // compareMeta.thin is true when the comparison window holds fewer than 20 records or starts before the earliest record; then every
                 // kpis[id].delta is null and kpis[id].deltaNote says why ('prior period has too few records (n=5)'); kpis[id].prev and kpis[id].prevN stay so
                 // narration can still say "vs X" without a percentage. kpis[id].prevN = n of the prior-period computation.
                 // derived.dq percentages (needsReviewPct, nonEnglishPct, agreementCategory, agreementSentiment) are 0–1 FRACTIONS; registry 'pct' metric values are 0–100 percent points (§4.6)
invalidate(reason?) → void       // drops every memo (filtered, compare, derived, per-record prediction caches), bumps version() and emits 'filtered' with `reason`; use after VOC.alerts.setRule or any change derived() cannot see
applyDimensionFilters(records, filters=current) → Record[]   // the non-range part of the matcher (chips, restricted queue, search) on any record subset, so a view can honor the filter bar on a full-history series
customers() → Map<id, Customer>; customer(id); recordsFor(customerId) → Record[]; practices() → Map
cleanText(rec) → void            // strips the quoted-reply tail and signature from rec.text in place (VOC.classify.preprocess); applied to every seed and imported record before classification
churnModel() → bundle|null       // the one churn model every score in the store uses: VOC.predict.churnModel(all(), customers, {now}) fitted once per data version and cached
churnMethod() → 'fitted'|'heuristic'   // what churnModel() settled on; also passed as ctx.churnMethod so kpis.revenue_at_risk.extra = {method, customers}
orders() → OrdersByMonth; ordersInRange(fromIso, toIso, productId=null) → number|null (null when any month missing); setOrders(obj)   // runs VOC.importers.sanitizeOrders when loaded (key shapes, finite counts, no prototype keys)
addRecords(items: (RawEmail|Record)[], source) → Promise<{added, duplicates, noise, needsReview, nonEnglish}>   // classifies RawEmail; dedupes by id/fingerprint; persists to db
update(id, patch, actor='You') → Record; bulkUpdate(ids, patch, actor) → batchId; undo(batchId) → boolean; addNote(id, text, actor)
overlays() → Map<id, Overlay>
importOverlays(list, {actor='Restore', emit}) → {applied, skipped, invalidFields, ids, unknownIds}   // reinstates Overlay[] (for example a backup's `overlays`) with their audit trail; ids missing from the store are skipped; status/urgency/category/subcategory/product values unknown to VOC.enums (and non-boolean flags) are dropped and counted in invalidFields
settings() → Settings; setSettings(patch)
Settings = { clock:'demo'|'real', theme:'system'|'light'|'dark', sla: {P0:1,P1:4,P2:24,P3:72}, agents: string[], me: 'You', connector: {...see §9}, redactRestricted: true }
savedViews() → View[]; saveView({id, name, filters}); deleteView(id)
drill({ view, filters, id }) → void   // sets filters then navigates (uses VOC.router when present)
resetDemo() → Promise<void>          // clears imported records + overlays + settings back to seed
on(evt, fn); off(evt, fn)            // events: 'ready','filtered','records:changed','settings:changed','theme:changed','clock:changed'
```
Range presets: `7d` = last 7 CT days ending `now`; `30d`, `90d`, `12m` = 365 days; `custom` uses from/to. Sentiment filter uses labels. `search` matches subject/text/from_name/order_id case-insensitively.

### 4.6 `VOC.metrics` and `VOC.analytics` (analytics.js)
```js
VOC.metrics.registry = { [id]: { id, label, unit:'count'|'pct'|'pts'|'hours'|'per_1k'|'per_10k'|'score'|'usd', direction:'up_good'|'down_good'|'neutral', formula: string, compute(records, ctx) → { value:number|null, n:number, interval?:{lo,hi}, extra? } } }
Unit contract: a `pct` metric's `value` is in 0–100 percent points (frt_sla_pct 87.5 means 87.5%, never 0.875); `VOC.ui.formatValue('pct', v)` renders percent points directly (0.234 → '0.2%'). Only `derived.dq` reports fractions (§4.5).
ids: volume, contact_rate, complaints_per_1k, sentiment_index, net_sentiment, nps, csat, rating_mean, frt_median, frt_sla_pct, resolution_median, resolution_p90,
     reopen_rate, escalation_rate, repeat_contact_rate, detractor_recovery, ae_rate, backlog_48h, open_p0_p1, sla_breached, unassigned, needs_review_pct, revenue_at_risk
ctx = { now, from, to, orders: OrdersByMonth, ordersInRange(from,to,product), customers, allRecords, sla }
VOC.metrics.compute(id, records, ctx) → same shape; series(id, records, ctx, {granularity:'day'|'week'|'month', rolling:0|7|28}) → [{key, value, n}]
VOC.analytics = {
  bucket(records, gran) → [{key, count, neg, pos, neu, meanSentiment, records}] (complete calendar range, zero-filled),
  heatmap(records) → { matrix: number[7][24] counts, sentiment: number[7][24] mean }, 
  shareOfVoice(records, orders, from, to) → [{product, mentions, mentionShare, orders, orderShare, index}],
  themeImpact(records) → [{category, impact, npsAll, npsExcl, n}]   // Impact = NPS(all) − NPS(excluding category); requires nps
  segmentCompare(records, customers) → [{segment, n, nps, netSentiment, repeatRate}],
  componentMentions(records) → [{component, count, meanSentiment, negShare}],
  lotMatrix(records) → [{lot, weeks:{[weekKey]:count}, total, foodSafety}],
  hcpRollup(records, customers, practices) → [{practice_id, name, records, negatives, nps, evidenceRequests}],
  cohorts(records) → { cohorts:[{month, size, retention:number[6]}] },
  resolutionDistribution(records) → { buckets:[{label, count}], p50, p75, p90 },
  ngrams(records, {n:[1,2,3], minDf:3, top:30}) → [{gram, df, meanSentiment, negShare, sampleIds:string[]}],
  kwic(records, term, {width:60, max:20}) → [{id, before, match, after}],
  distinctiveTerms(recordsA, recordsB, {top:15, alpha0:10}) → { rising:[{term, z, a, b}], falling:[...] },
  stem(token) → string, cosine(textA, textB) → number }
```
Formulas (put verbatim in `formula`): volume `count(records)`; contact_rate `records / orders × 100`; complaints_per_1k `complaints / orders × 1000`; sentiment_index `mean((s+1)/2×100)`; net_sentiment `%pos(s≥0.05) − %neg(s≤−0.05)`; nps `%9–10 − %0–6` with interval `±1.96·√((p+d−(p−d)²)/n)·100`; csat `% of csat ∈ {4,5}`; frt_median `median(first_response_at − received_at)` hours; frt_sla_pct `% with frt ≤ SLA[urgency]`; resolution_median/p90 hours; reopen_rate `reopened / resolved`; escalation_rate `escalated / total`; repeat_contact_rate `customers with ≥2 threads in range / customers with ≥1`; detractor_recovery `detractors with recovered=true / detractors with recovered ≠ null`; ae_rate `AE records / orders × 10,000` (Poisson interval); backlog_48h `open with age > 48h`; open_p0_p1; sla_breached `open ∧ no first response ∧ age > SLA`; unassigned `open ∧ assignee null`; needs_review_pct; revenue_at_risk `Σ churn_score/100 × subscription_value_12m` over subscribers.

### 4.7 `VOC.predict`
Every function returns `AnalyticResult = { method, params, n, series?|rows?, band?, backtest?, explanation: string, confidence: 'high'|'medium'|'low', caveats: string[], asOf }`.
```js
forecastVolume(dailySeries /*[{key,value}]*/, { horizon:28, z:[1.28,1.96], autoTune:false, params? }) → { ..., history:[{key,value,fitted}], forecast:[{key, value, lo80, hi80, lo95, hi95}], weekly:[{weekKey, value, lo80, hi80}], backtest:{folds, mae, mape, mase, coverage80, weeklyMape} }   // confidence rule in §8
   // Holt-Winters additive m=7 (α .3 β .05 γ .2 φ .9, init per research), fallback Holt linear (<8 weeks) → OLS (<28 days) → flat mean (<7 days); method names 'holt_winters'|'holt_linear'|'ols'|'mean'
forecastSentiment(dailySeries /*[{key, value(index 0-100), n}]*/, { horizon:14, lambda:.15 }) → { history:[{key, value, smoothed, lo, hi}], forecast:[...] }
detectAnomalies(series, { mode:'count'|'share', window:28, dowAdjust:true, warn:2, critical:3 }) → { events:[{start, end, metric, value, expected, z, severity:'warning'|'critical'}], points:[{key, value, expected, lo, hi, z}] }
detectEmerging(records, { recentDays:7, baseDays:28, asOf, negativeOnly:false, units:['category','subcategory','product','kit_component','lot','bigram'], minRecent:3 }) → { rows:[{unit, type, label, cR, cB, expected, lift, z, status:'new'|'emerging'|'fading'|'stable', sampleIds}], nRecent, nBase, params:{expectedRule} }
   // expected E = cB·NR/NB (the unit's baseline count scaled by the recent/baseline record ratio; the day ratio only when NB = 0), so a pure volume surge leaves every lift unchanged and a flat unit during a surge reads as 'fading' (share of voice); params.expectedRule documents it
churnModel(records, customers, {now}) → { model|null, method:'fitted'|'heuristic', auc, aucInSample, reliability, reliabilitySlope, nLabelled, nPositive, reason, gate }
churnRisk(customerId, records, customers, {now, model}) → { score:0..100, tier:'low'|'watch'|'high'|'critical', reasons:string[], features, method:'heuristic'|'fitted' }   // deterministic: uses only opts.model (a bundle or bare model); never fits implicitly
churnTable(records, customers, {now, top:50, model}) → { rows:[{customer, score, tier, reasons, revenueAtRisk}], method, model, nLabelled, auc?, aucInSample?, reliability?:[{decile, predicted, observed, n}], reliabilitySlope?, rejectedFit?:{auc, aucInSample, nLabelled, reason} }
   // heuristic weights per research; a logistic regression (GD) is fitted when ≥40 customers have subscription_status ∈ {cancelled, active/paused} and is ACCEPTED only when its
   // stratified 5-fold cross-validated AUC ≥ 0.65 (LOGISTIC_DEFAULTS.minAuc, folds); reliability deciles come from the held-out predictions and a calibration slope outside [0.7, 1.3] adds a
   // caveat. A rejected fit falls back to the heuristic with a caveat naming the CV AUC (rejectedFit); auc/reliability/coefficients are exposed only when the fitted model is in use.
escalationRisk(rec, records, {now}) → { score, tier, reasons }
predictCsat(records, {now}) → { model:{beta, r2, sigma, n, features}|null, predictions:[{id, pred, lo, hi}], method:'ridge'|'fallback' }
projectedNps(records, {now}) → { current, projected, lo, hi, nOpen }
driverAnalysis(records, dimension:'category'|'subcategory'|'product'|'channel'|'segment') → { rows:[{value, n, negatives, rate, baseRate, lift, excess, chi2, p, q, significant}] }
whatChanged(recordsNow, recordsPrior, dimension) → { total:{now, prior, delta}, rows:[{value, delta, volumeEffect, rateEffect}] }
slaBreachProb(rec, records, {slaHours}) → { p, basis:'category'|'global', n }
seasonalityIndex(records, categoryId|null) → { rows:[{month, index, n}] }
sentimentDrift(weeklyIndexSeries, {weeks:12}) → { slope, slopeSe, sigma, projected12w, projected12wLo, projected12wHi, band:0.8, change12w, r2, alert:boolean }
   // OLS on the weekly index; sigma = residual sigma, slopeSe = sigma/√Sxx; projected12wLo/Hi = projected ± t(0.9, n−2)·sigma·√(1 + 1/n + (x*−x̄)²/Sxx), an 80% prediction interval the drift alert prints as "likely lo–hi"; alert when change12w < −5
backtest(fitFn, series, {folds:4, horizon:7}) → { folds:[{trainEnd, mae, mape, coverage80}], mae, mape, mase, coverage80 }
detectorBacktest(records, plantedEvents) → { rows:[{id, title, detected, leadDays, detail}], recall }
rateInterval(k, n, kind:'wilson'|'poisson') → {lo, hi}
```

### 4.8 `VOC.narrate`, `VOC.report`, `VOC.alerts`
```js
VOC.narrate = { headline(derived) → string, headlineParts(derived) → string[3–4] /* ≤ 90 chars each, lint-clean, each carries n: volume+delta, sentiment index+NPS, driver of change (or largest theme), regulatory state or outlook */, deadlineRemaining(deadlineEntry) → string, insights(derived) → InsightCard[5] /* kinds: change, driver, emerging, regulatory, outlook */,
  // headline and the change card honor derived.compareMeta.thin: a thin comparison window (fewer than 20 prior records, or one that starts before the data) drops the
  // "vs prior" clauses and the change card says why deltas are withheld. The headline's lead-change clause states both counts and both n ("15 → 3 negatives, −12; n=4 now vs 17 prior").
  explainMetric(id, derived) → string, forecastSentence(result) → string, whatChangedSentence(result) → string,
  verbatims(records, {praise:1, complaint:2}) → Record[], recommendations(derived) → string[3], lint(text) → {ok, violations:string[]} /* flags 'will', missing n */ }
InsightCard = { kind, title, text, evidence: string, drill: {view, filters?, id?} | null, severity: 'info'|'warning'|'critical'|'good' }
VOC.report = { weekly(derived, ctx) → string /* self-contained HTML fragment using .report classes */, monthly(derived, ctx) → string, wrapPrintable(fragmentHtml, {title, footer}) → full HTML document string }
VOC.alerts = { defaultRules() → Rule[], rules(), setRule(id, patch), evaluate(derived, {predict}) → Alert[], active(), history(), ack(id), snooze(id, hours) }
// Anomaly rules (volume_zscore, neg_share_zscore) describe whole-store facts: their daily series come from derived.allRecords over a fixed 112-day window ending derived.now (28-day baseline + 84 days of weekday history), so the alert set is identical at every range preset; derived.byDay is only the fallback without records. neg_share points with no scored records are masked (value null), never zero-filled.
// sentiment_drift reads derived.allRecords over the last 12 ISO weeks ending now and scores the index overall AND per category (top 5 by change) through predict.sentimentDrift; one alert per unit, id 'sentiment_drift:<unit>:<week>' (unit 'all' or a category id), title names the category, drill {range: 90d, category:[c]}, extra {unit, change12w, projected, projectedLo, projectedHi}; the detail prints the 80% band ("likely lo–hi").
// emerging_unit and sla_breach also read every record (unfiltered); the Briefing's SLA recommendation says so when it quotes the in-range count.
// narrate.lint also flags British spellings (prioritise/analyse/optimise/organise/recognise/summarise/categorise/normalise/standardise/minimise/maximise/realise/utilise/emphasise families, colour/behaviour/favourite/centre/programme); the site writes American English. narrate.emergingCard leads with negative-leaning units (detectEmerging negativeOnly:true) and reports a rising praise unit as an 'info' card, never critical.
Rule = { id, type:'volume_zscore'|'neg_share_zscore'|'emerging_unit'|'sentiment_drift'|'p1_cluster'|'ae_received'|'food_safety_received'|'sla_breach', threshold, enabled, label }
Alert = { id, ruleId, severity:'info'|'warning'|'critical', title, detail, at: ISO, drill, acked: boolean, snoozedUntil: ISO|null }
```

### 4.9 `VOC.charts` (charts.js)
```js
available() → boolean            // false when window.Chart missing or VOC_CHARTS_FAILED
SLOTS = { prolon_5day:1, prolon_nextgen:2, prolon_reset:3, fast_bar:4, fasting_shake:5, l_protein:6, l_pill:7, subscription_account:8 }   // everything else → 'other'
palette() → { series:[8 hex for current theme], other, text, muted, grid, axis, surface, pos, neg, mid, seq:[8], status:{good,warning,serious,critical} }   // read from CSS tokens at call time
slotColor(entityId) → hex; statusColor(kind); sentimentColor(label)
line(el, spec) → Handle;  bar(el, spec) → Handle /* horizontal by default */;  stacked100(el, spec);  paired(el, spec);  diverging(el, spec);  bubble(el, spec);  histogram(el, spec);  waterfall(el, spec)
spec = { labels: string[], datasets: [{ label, data: number[]|{x,y,r}[], slot?: number|'other', color?: hex, dashed?: boolean, fill?: 'band'|false, band?: {lo:number[], hi:number[]}, pointRadius? }],
         yLabel?, xLabel?, yMin?, yMax?, percent?: boolean, stacked?: boolean, annotations?: [{x?: string, y?: number, label}], onClick?: (index, datasetIndex) => void, ariaLabel: string }
Handle = { chart, update(spec), destroy(), toTable() → {columns, rows} }
sparkline(el, values: number[], {color?, width:96, height:28}) → void   // inline SVG, no Chart.js
heatmap(el, matrix: number[][], {rowLabels, colLabels, format, onClick, seq:'green'}) → void   // CSS grid, 8-step ramp from tokens, cells have title tooltips
tableTwin(el, {columns, rows, caption})  // renders an accessible table
rethemeAll(); destroyAll()
applyDefaults(palette)   // token-driven Chart.defaults; keeps every key of Chart.defaults.animation (Chart.js copies only those keys per animation group, so replacing the object drops the color interpolator)
```
Rules: colors always read from tokens at render (so dark mode re-themes); `Chart.defaults.font.family` = UI font; `animation:false` when `prefers-reduced-motion`; gridlines solid hairline `grid` color, no dashed grids; forecast lines dashed; bands as two datasets with `fill:'+1'`; tooltips on every chart; canvas gets `role="img"` and `aria-label`; charts never use dual axes; single-series charts use slot 1; never color a bar by its rank.

### 4.10 `VOC.ui` (components.js)
```js
kpiTile({ id, label, value, unit, delta, direction, n, interval, spark: number[], formula, onClick }) → HTMLElement
chartCard({ id, title, question, formula?, n?, render: (canvasEl) => Handle, table: () => {columns, rows}, csvName?, footnote?, height? }) → HTMLElement   // Chart|Table toggle, CSV button, ƒ popover, empty state when render returns null
insightCard(card: InsightCard) → HTMLElement
pill(kind: 'urgency'|'status'|'sentiment'|'tier'|'severity'|'confidence', value) → HTMLElement
table({ columns: [{key, label, render?, sort?, width?, align?}], rows, pageSize: 50, sortKey?, onRowClick?, rowClass?, emptyText }) → { el, update(rows) }
drawer: { open(contentEl, {title, onClose}), close(), isOpen() }      // right-side panel desktop, full-screen sheet on phone, focus trap, Esc closes
toast(message, kind='info'|'good'|'warning'|'critical', { undo?: () => void, ms: 6000 })
popover(anchorEl, html); emptyState(el, { title, text, action? }); confirm({ title, text, confirmLabel }) → Promise<boolean>
viewHeader({ title, meta, lead?, actions? }) → HTMLElement   // <header class="view-header">: .view-title (Lora 700, 28px / 22px phone, --brand), .view-meta (Hanken 13px --muted, one line: range · n · qualifier), .view-actions (wraps under the title when narrow), .view-lead (one bold sentence, Hanken 600 17px / 16px phone, ≤ 72ch); exposes setMeta(t), setLead(t), setActions(nodes); meta keeps data-role="subtitle"
howDetails({ summary = 'How this works', body|html, open? }) → HTMLElement   // <details class="how"> collapsed explainer placed directly under a view header; the top of a view is never a paragraph
dropZone(el, onFiles: (FileList) => void, { accept: '.eml,.mbox,.csv,.json', hint })
formatValue(metricId|unit, value) → string
```

### 4.11 `VOC.mime`, `VOC.importers`, `VOC.exporter`, `VOC.connector`
```js
VOC.mime = { parse(rawText) → { headers: {[lower]: string}, contentType, parts: [...], text, html, attachments:[{name,type,size}] }, decodeWords(h), decodeQP(s, cs), decodeB64(s, cs), toRawEmail(parsed, source) → RawEmail }
VOC.importers = { parseEmlText(text) → RawEmail, parseMboxText(text) → RawEmail[], parseCsvText(text) → { headers, rows },
  detectTemplate(headers) → 'helpdesk'|'reviews'|'orders_monthly'|'records'|null, mapRows(rows, mapping) → Record[]|RawEmail[], parseJsonText(text) → Record[]|RawEmail[],
  handleFiles(files) → Promise<{ items, summary, ordersByMonth? }> /* browser only */ , TEMPLATES }
VOC.exporter = { recordsCsv(records, {redact}) → string (UTF-8 BOM + RFC 4180), metricsCsv(rows) → string, regulatoryCsv(records) → string, backupJson(store) → string,
  downloadText(filename, text, mime) /* browser only; falls back to clipboard + toast on failure */, filename(view) → 'lnutra-voc-{view}-{YYYYMMDD}.csv' }
VOC.connector = { mode() → 'file'|'static'|'served', baseUrl(), setToken(t), token(), health() → Promise, status() → Promise, fetchRecords(sinceIso) → Promise<{records, next_since}>,
  saveConfig(cfg) → Promise, triggerSync() → Promise, startPolling(intervalS), stopPolling(), loadLive() → RawEmail[] /* window.VOC_LIVE */, reloadLiveScript() → Promise<RawEmail[]> }
```
`mode()` is `'file'` on `file://`; `'static'` on http(s) until `/api/health` has answered `{ok:true}` once (a plain `python3 -m http.server` stays `'static'` and views keep their file-mode behaviour); `'served'` from the first healthy answer on, cached for the page's lifetime. In file mode the connector only offers `reloadLiveScript()` (re-inserts `js/live-data.js?ts=`).

### 4.12 `VOC.router`, `VOC.app`, views
```js
VOC.router = { start(routes: {[name]: View}, defaultRoute='briefing'), navigate(name, {id?, query?}), current() → {name, id, query}, on(fn) }   // hash form: #/inbox/r_000123?range=30d&product=fast_bar
VOC.app = { boot() → Promise, setTheme('system'|'light'|'dark'), renderFilterBar(), currentView() }
VOC.views[name] = { title, icon, mount(rootEl, derived), update(derived), unmount() }
```
Views re-render from `store.derived()` on the `filtered` and `records:changed` events (the app calls `update`). Filters serialize into the hash query; the drawer record id lives in the path.

## 5. Views

Common: every view opens with `VOC.ui.viewHeader` — the rail noun as title, a one-line meta (range · n · the view's qualifier), the view's actions in the actions slot, and a data-driven **lead**: one bold sentence stating the single most important fact for the current filters, always carrying n or a count, recomputed in `update()`. Explanations that used to open a view (Alerts rules, Regulatory clocks, Forecast Lab scope) sit in a collapsed `<details class="how">` under the header. The Briefing's lead is `narrate.headlineParts` rendered as `<ul class="briefing-lead">` (3–4 bold Lora statements, ≤ 90 characters each, accent rule on the left, ≤ 4 lines at 1440px). Shell: header (wordmark lockup "L-Nutra · Voice of the Customer", demo-clock badge, theme toggle, connector status dot, search), left rail (desktop ≥1024px) / bottom tab bar (phone: Briefing, Inbox, Themes, Alerts, More), global filter bar (range presets 7d/30d/90d/12m/custom with date inputs, compare select, multi-select chips for product/category/channel/segment/sentiment/status/urgency, live "n = 412 records" and Reset). Every view has a one-line subtitle stating the current range and n.

1. **Briefing** `#/briefing` (default): `narrate.headlineParts` as the bold lead block (`narrate.headline` stays the prose form for reports); 5 insight cards; KPI strip (volume, net_sentiment, nps, csat, frt_median, complaints_per_1k, open_p0_p1, detractor_recovery); charts: weekly volume + 4-week forecast with 80/95% bands and anomalous weeks marked (line), theme impact on NPS (signed horizontal bar), share of voice vs order share (paired horizontal bars per product with index badge), topic share by sentiment (horizontal sorted bars colored by mean sentiment on the diverging scale, footnote "multi-label"), alert feed (top 5), 3 verbatims (1 praise, 2 complaints, keywords marked, redacted when restricted).
2. **Trends** `#/trends`: controls (granularity day/week/month, rolling 0/7/28, compare overlay); small multiples: volume, sentiment_index (with EWMA band + 14-day forecast), nps (with MoE band), frt_median, resolution_median + p90, reopen_rate; arrival heatmap weekday×hour (CT) with click → Inbox filtered; seasonality index bars for selected category (hidden <10 months of data).
3. **Themes** `#/themes`: category bars (sorted, expandable to subcategories, colored by mean sentiment); priority matrix bubble (x volume, y mean sentiment, r |NPS impact|, quadrant labels: Fix now / Monitor / Protect / Low priority); driver analysis (lift bars with χ² significance markers); what-changed waterfall this period vs compare; distinctive terms (rising vs falling, diverging bars); n-gram themes table (gram, df, sentiment, neg share, 5-week sparkline, KWIC snippets on expand); topic × product matrix (heat-table, small-n cells hatched).
4. **Products** `#/products`: product switcher (segmented control, all/each); tiles: volume, complaints_per_1k, net_sentiment, nps, ae_rate (Poisson interval), sov index; charts: topic mix product vs company (paired bars); sentiment over time small multiples per product (slot colors); kit-component bar (Next Gen soups, L-Drink, olives, kale crackers, bars…); lot × week heat-table (food-safety rows bold); top praise / top complaints lists.
5. **Customers** `#/customers`: segment comparison grouped bars (nps, net_sentiment, repeat_contact_rate); cancellation-risk table (customer, score, tier pill, reasons chips, last contact, subscription value, revenue at risk, Open → Inbox filtered to customer); score histogram with reliability twin when fitted; cohort heatmap (first-contact month × months since, "re-contact is a warning signal"); HCP practice rollup table; region bar.
6. **Inbox** `#/inbox` and `#/inbox/:id`: command strip tiles (Open P0, Open P1, SLA breached, Unassigned, Aging >48h, Detractors awaiting follow-up) that set saved views; saved-view chips (all_open, unassigned_p0_p1, sla_breached, aging_48h, detractor_followup, needs_review, ae_register, restricted, mine + custom); table columns: urgency pill, age, AE/food-safety badges, product, category › subcategory, sentiment dot, NPS/rating, status pill, assignee, escalation score, confidence dot; sort urgency then age; bulk select → assign/status/tag/export with toast Undo; drawer: subject, from (redacted if restricted), full text with `<mark>` on lexicon hits and keywords, thread history, editable category/subcategory/product/urgency/status/assignee/tags, notes, customer panel (segment, orders, churn score + reasons, history), predictions (escalation score, SLA breach probability, predicted CSAT), regulatory checklist for AE/food-safety (received, aware date, deadline countdown, lot, reporter contact, seriousness criteria, MedWatch 3500A fields as checkboxes), audit log. Keyboard: j/k, Enter/o, Esc, a assign, s status, r resolve, e escalate, n note, / search, u undo, g then b/i/t/p/c/a/l for navigation. Drop zone for import files.
7. **Regulatory** `#/regulatory` (ignores range; the one-line header meta says so: "All open clocks, regardless of the date range · 12-month tiles count back from <date> · n = 67 register records"): tiles: open serious AE, non-serious AE (12m, per 10k orders), open RFR evaluations (24h clock), foreign-material/allergen open, contraindication matches; deadline table (record, received CT, product class, clock, deadline, remaining business days/hours, checklist %, lot); seriousness breakdown bar; AE by product bar; lot table; export register CSV; green all-clear empty state.
8. **Forecast Lab** `#/predict`: model cards (volume HW, sentiment EWMA, churn, CSAT) with method/params/n/backtest; sliders α β γ φ horizon z with live re-fit; forecast chart with folds shaded; residual bar ±2σ; coverage table; anomaly timeline; emerging table; detector backtest vs planted events; as-of date control (replay).
9. **Alerts** `#/alerts`: active alerts (severity pill, title, detail, sparkline, Ack, Snooze, Show me), rules list with enable/threshold editing, history.
10. **Reports** `#/reports`: generate weekly (week ending picker) / monthly (month picker); preview in a `.report` container; Print (opens printable window via `report.wrapPrintable` + `window.print()`), Export CSV (records / metrics / regulatory), Backup JSON / Restore; data-quality panel (from `derived.dq`).
11. **Methods** `#/methods`: metric registry table (id, label, formula, unit); classification pipeline description with thresholds; lexicon/rules versions and sizes; planted events list with detection status; model parameter defaults; schema version.
12. **Settings** `#/settings`: clock (demo/real), theme, SLA hours per urgency, agents list, connector (provider preset, host, port, username, auth mode, folder, sent folder, poll interval, since date, allow/deny lists, token field, status panel, Save config, Sync now, Reload live data; PHI notice), import drop zone + CSV mapping dialog, orders-by-month grid (editable, import CSV), classifier tester (paste text → `classify.explain`), reset to demo data.

Phone (<768px): rail becomes bottom tab bar; filter bar collapses into a "Filters" sheet; KPI strip 2-up; tables scroll within their card; drawer is full-screen.

## 6. Seed data (tools/generate_seed.py → js/data.js)

Deterministic (`random.Random(20260917)`). Writes `window.VOC_SEED = {...};` as one JSON literal (`json.dumps(..., ensure_ascii=False, separators=(',',':'))`), ~1.5–2.5 MB max. Targets: **1,000–1,060 records** (the shipped seed is **1,023**: 1,012 live + 11 noise), 2025-09-15 → 2026-09-16 (CT), **640 customers**, **18 practices**, `orders_by_month` (~30,000 orders/yr; Jan ×1.6, Nov ×1.4; product shares 5-Day 38%, Next Gen 17%, Reset 15%, Fast Bar 9%, Shake 6%, L-Protein 5%, L-Pill 4%, Starter Pack 2% Aug–Sep only, Guided 1%, 5:2 3%).

Daily intensity `λ = 2.4 × 1.03^months × dow[Mon 1.35, Tue 1.25, Wed 1.05, Thu 1.0, Fri 0.9, Sat 0.55, Sun 0.6] × month[Jan 1.6, Feb 1.1, Sep 1.25, Nov 1.2, Dec 1.15, else 0.95] × event`; Poisson draw; arrival hours bimodal CT (9–11, 19–21). Segment mix: first_time 34%, repeat 22%, subscriber 25%, hcp 6%, hcp_patient 4%, lnh_patient 3%, employer 4%, wholesale 2%. Regions US 74%, CA 5%, UK 6%, EU 4%, DE 3%, IT 3%, AU 2%, AE 2%, OTHER 1%; ~40% of DE/IT records are short German/Italian bodies (language 'other'). Sentiment band mix about 60/12/28 pos/neu/neg over English live records (shipped seed ≈ 55/12/32; `validate()` and `tests/test_seed_agreement.js` hold positive to 54–66% and negative to 22–34%; varies by category: praise all positive; billing mostly negative). 12-month NPS 25–55 (shipped ≈ 32, n=176): a brand with 4+ star public reviews, not a company in crisis. Channel by sales channel and category by product per research (taste/foreign-material/leaking only for kit products; L-Pill side effects allowed; hcp_practitioner only for hcp; lnh_patient always restricted). 28% of customers have ≥2 records, 8% ≥3. Subscription status ≈ 32% active, 4% paused, 6% cancelled; cancellations follow what the churn features can see at `as_of`: a subscriber with a negative, billing, cancel-intent, detractor or still-open record inside the last 30 days cancels with p ≈ .55 (.38 inside 90 days, ×1.4 with a billing complaint or cancel intent), otherwise p ≈ .035, and `cancelled_at` sits 0–10 days after the last such record, so the fitted logistic churn model clears its cross-validated AUC gate on the seed (≈ 0.72; `tests/test_seed_agreement.js` asserts method 'fitted', AUC ≥ 0.65). NPS on 100% of surveys and ~8% of emails (survey follow-ups; neutral-band respondents score 7–9, negative-band mostly 0–6 with a few passives); rating on reviews; CSAT on 45% of resolved. FRT lognormal median 5h (P0 0.7h, P1 2h), ~12% null on resolved records; resolution median 30h. **Backlog realism:** the status table depends on age at `as_of` — ≤48h: new 38 / open 22 / pending 14 / escalated 3 / reopened 3 / resolved 20; 2–21 days: open 18 / pending 17 / reopened 5 / escalated 3 / resolved 57; 21–45 days: open 5 / pending 6 / reopened 3 / escalated 1 / resolved 85; older than 45 days: resolved, with `received_at ≤ first_response_at ≤ resolved_at ≤ as_of`. A post-pass (`mark_aging`, own RNG stream) keeps at most 3 background tickets aged 45–60 days open (one `open` with no first response, the rest `pending`) so the Aging > 48h tile has a tail. Resulting targets, held by `validate()` and `tests/test_seed_agreement.js`: 40–70 open-state records (new/open/pending/reopened/escalated) with at least half inside the last 21 days, 8–25 open records past their first-response SLA (no `first_response_at` and age > SLA[urgency] of 1/4/24/72h), oldest open ≤ 60 days, resolved share 85–97% of live records (≈95% in the shipped seed), 11 closed_noise. `new`/`open` never carry a first response; `pending`/`reopened`/`escalated` always do. 10% of bodies carry a quoted tail + signature (to exercise preprocess). 4% `has_attachment`.

**Planted events** (all listed in `meta.planted_events` with `{id, from, to, title, detector, expected}`):
E1 Guided Health launch 2025-10-23→11-15 (guided_health usage/price ×3, emerging 'new' on product); E2 BFCM 2025-11-27→12-01 (volume ×1.6, checkout share .25); E3 holiday carrier incident 2025-12-15→12-19 (volume ×2.8, shipping neg share .7, "FedEx", "porch", "still not arrived"; weekly anomaly z≥3); E4 New Year reset 2026-01-02→01-24 (volume ×1.8, side_effects share .22, weight-loss praise); E5 double-charge bug 2026-02-24→02-26 (14 duplicate_charge P1 in 72h; emerging 'new' bigram "charged twice"); E6 foreign-material ramp lot NG-0426-B, Next Gen Minestrone Quinoa, 2026-05-11→05-31 (weekly 1→6→11 hard_bits/shell_fragment, P0, food_safety; emerging z≥3 at as-of 2026-05-31); E7 Next Gen taste drift 2026-06-01→07-31 (taste_quality sentiment index slides −12 pts; drift alert); E8 L-Drink leak ramp 2026-07-06→07-26 (weekly 2→6→11 leaking; emerging lift≥3); E9 Starter Pack launch 2026-08-06→08-31 (product_request + "final sale" confusion); E10 six serious AEs across the year (fainting ×2, ER ×2, allergic reaction, hypoglycemia on metformin), two received within the last 10 business days before as_of and kept `escalated` (live MedWatch clocks) while the four older ones are resolved; ~40 non-serious side-effect records; E11 restricted queue (all lnh_patient/hcp_patient records restricted, A1c/medication mentions); E12 noise (6 auto-replies, 3 bounces, 2 newsletters → closed_noise); E13 back-to-routine 2026-09-01→09-16 (+15% volume, praise share up). Outside the numbered list, one fresh foreign-material report on Next Gen Minestrone lot **NG-0826-C** arrives the morning of as_of (status `new`, P0, food_safety, `lot-hold` tag) so the 24-hour RFR clock is live; every other serious-AE / food-safety record older than 14 days is resolved. The E6 lot is **NG-0426-B** (18 records).

Templates: per (category × sentiment band) 6–12 subjects and 8–15 bodies from opener/core/closer pools with slots `{first_name} {product} {component} {day} {lbs} {order_id} {days_waiting} {agent} {flavor} {amount} {lot} {hcp_code} {cycle_n} {region_name} {start_day}`; real idioms from public reviews ("signed up without permission", "no cancellation link", "astronaut food", "only edible thing", "$40 a day", "hard bits", "nut shell", "charged twice", "still not arrived", "day 3 headache", "energy on day 4", "lost 6 lbs"). **Realism rules** (held by `check_templates()` at start-up and `realism_check()` on every record): subjects are keyed by subcategory AND band and never cross the body's band (no "Actually tasty" on a complaint); every core, opener, closer and subject must fit the labelled product (`core_fits`: no soups, L-Drink, olives, crackers, "day 2–6" or "five days" on a bar, shake, L-Protein or L-Pill; no "day 3–6" on the 1-Day Reset or 5:2; no powder/dissolve on the ready-to-eat Next Gen; programs never talk about boxes or bars; no ProLon kit ships a shaker); openers (~30 per band) and closers (~25 per band) are optional on email (p .65/.55) so mail often opens with the problem; a product is named in so many words in under half of bodies (`MENTION_P` .45, 6–14 natural phrasings per product, before or after the first sentence) and otherwise in the subject line when the body alone does not settle it (`SUBJECT_ALIAS_P` .7), the way real subjects read ("Next Gen: hard bits in the soup"); phone notes read "Call summary by Maya R. Caller …" (no double period). Order ids: Shopify `#1xxxxx`, Amazon `113-xxxxxxx-xxxxxxx`, practitioner orders `PP-xxxxx`; practitioner codes `HCP-XXXXX` (five upper-case letters/digits; each hcp customer has one, hcp_patient customers carry their practice's code). Inbound email `message_id` hosts come from the sender's provider (`<hex12.n@mail.gmail.com>`, `@outlook.com`, …); only bounces are minted at `mail.prolonlife.com`; the quoted Customer Care tail cites an "Order reference" only for Shopify ids. Bodies must contain the vocabulary that `rules.js` keys on so that the classifier agrees with the intended category ≥85% and the lexicon agrees with the drawn sentiment band ≥85% (measured by `tests/test_seed_agreement.js`; shipped seed ≈ 0.91 / 0.88, product ≈ 0.87, planted-event recall 0.92). `VOC_SEED_DIAG=<path> python3 tools/generate_seed.py` also writes id → {cores, band, category, subcategory, product, channel} so agreement can be measured per template.

## 7. Classification pipeline details

Order inside `classifyRecord`: preprocess → isNoise → detectLanguage → scoreSentiment (skipped → `unscored` when language 'other') → scoreCategories → detectProduct → assessSafety → assignUrgency → extractEntities → flags → identity (customer_id from `normalizeEmail`, thread_id from message headers or normalized subject + counterpart within 30 days) → defaults for every field in §2.

Sentiment: base valence lexicon (−4..+4) + domain layer; phrases matched before tokens; negation within 3 preceding tokens × −0.74; boosters +0.293 / dampeners −0.293; ALL-CAPS +0.733 when text is mixed case; each `!` +0.292 (max 4); tokens after the last "but" in a sentence ×1.5, before ×0.5; compound `Σv/√(Σv²+15)`; record `sentiment` = mean of sentence compounds, `sentiment_min` = min. Labels ±0.15. Brand stoplist carries no valence. Domain terms include: delicious +2, tasty +2, energized +2.2, energy +1.5, clarity +1.8, focus +1, lighter +1, refreshed +1.5, "lost \d+ (lbs|pounds)" +2, bland −1.5, stale −2, moldy −3, chalky −1.6, "astronaut food" −2, leaked/leaking −2, hunger/hungry −1, headache −1.5, nausea −2, bloated −1.5, lightheaded −1.8, dizzy −1.5, late −1.5, delayed −1, refund −1, cancel −1.5, "charged twice" −2.5, "never received" −2, "not worth" −2, "hard bits" −2.5, "nut shell" −2.5, "no cancellation link" −2, "food noise" −1.

Categories: each subcategory has 3–10 `{re, w}` patterns (word-boundary, stem variants); subject hits ×1.5; L-Nutra / DTC vocabulary the rules must cover: returns (`return label|send it back|RMA|Amazon return|return … unopened`) under subscription_billing.refund_status; `Subscribe & Save` (Amazon's subscription program) under subscription_billing.auto_renew_surprise and the subscription alias, not price_value; `Fullscript|Wellevate|dispensary` under hcp_practitioner.account_setup; `Loop` (the subscription app) is a subscription alias only — customer_service.chatbot_loop keys on `loops me back|stuck in a loop|same loop`, never bare `loop`; `transition day|refeed`, `welcome kit`, `L-Bar`, `NR-1`, `glycerol`, `HCP code` are covered by refeed_transition, welcome_kit_missing, the component table, l_drink_taste and hcp_code_entry; category score = max subcategory score + 0.5 × sum of other subcategory scores in that category; assign all categories with score ≥2 as secondary; primary by argmax with priority tiebreak (§4.3); confidence `top/(top+2)`; zero hits → `praise/general_praise` if compound > 0.3 else `usage_guidance/general_question` with confidence 0.2.

Product aliases (subject ×1.5): `next ?gen|ready.to.eat` → prolon_nextgen 3; `5.?day|fmd|fasting.mimicking|\bkit\b|prolon` → prolon_5day 2; `\breset\b|1.?day|one.day` → prolon_reset 3; `5:2|five.two` → prolon_52 3; `fast(ing)?\s?bar` → fast_bar 3; `\bshake` → fasting_shake 3; `l.?protein|protein powder` → l_protein 3; `l.?pill` → l_pill 3; `starter pack` → starter_pack 3; `guided|coach|dietitian` → guided_health 2; `diabetes remission|a1c|metabolic health program|metformin` → lnutra_health 2; `subscription|auto.?renew|autoship|\bloop\b` with no other product ≥2 → subscription_account; none → general. Components by name (`minestrone quinoa` → soup_minestrone_quinoa before `minestrone`; `l-?drink|glycerol` → l_drink; etc.).

Safety: serious `faint|passed out|hospitali[sz]ed|(went|taken|rushed|admitted|ended up|kept|stayed|overnight|trip|visit) … hospital|(to|in|at) the hospital|\bER\b|emergency room|ambulance|paramedic|first responders|EMT|call(ed) 911|anaphyla|epipen|allergic reaction|chest pain|seizure|couldn'?t breathe|blood sugar (crashed|dropped)|hypoglyc|lost consciousness|heart attack|stroke|icu|intubat|died` (a bare "hospital" — "I work at a hospital", "my hospital dietitian" — is not an event); non-serious `headache|dizz|lighthead|nause|vomit|fatigue|brain fog|rash|hives|palpitation|diarrhea|constipat|urgent care` (a walk-in urgent-care visit is an adverse event but not a seriousness criterion); `ae_criteria`: death; life_threatening (anaphylaxis, could not breathe, chest pain, seizure, heart attack, stroke, hypoglycemia); hospitalization (ER, emergency room, contextual hospital, ambulance, ICU, admitted); disability; birth_defect; intervention (EpiPen, intubation, IV fluids, glucose shot, resuscitation, stitches, treated at/by, paramedics/911/EMTs/first responders). Contraindications per §2 flags; food `shell|hard bit|foreign|glass|plastic|metal|mold|moldy|spoiled|seal (was )?broken|smell(ed|s) off|undeclared`. `regulatory_clock` (store.js `derive`): serious_ae → `medwatch_15bd` for every product (deadline = 15 business days after received_at, US federal holidays excluded) — the statutory 15-business-day serious-AE report (21 USC 379aa-1, Form 3500A) applies to dietary supplements (L-Pill); on a conventional-food kit or a program the same clock tracks a voluntary MedWatch report, and the Regulatory view (deadline-table clock column reads "MedWatch · 15 business days · voluntary"), the register CSV column `regulatory_clock_basis` ('statutory'|'voluntary') and `regulatory_clock_basis` on the derived record say so; food_safety ∧ product_class ∈ {conventional_food, supplement} → `rfr_24h` (received_at + 24h); programs and accounts carry no RFR clock. Known gap for the data-core owner: the Reportable Food Registry (FD&C Act §417) also covers dietary supplements, so a food-safety report on the L-Pill should start the same 24-hour clock (`cls === 'conventional_food' || cls === 'supplement'` in store.js and exporter.js); the classifier already sets `food_safety` for it (test_classify: L-Pill mold).

Urgency: P0 if serious_ae ∨ food_safety ∨ contraindication ∈ {pregnancy, minor} ∨ p0 regex (`lawyer|attorney|legal action|BBB|chargeback|dispute|FDA|regulator|press|reporter`); P1 if is_adverse_event ∨ subcategory ∈ {duplicate_charge, unauthorized_signup, post_cancel_shipment, lost, leaking} ∨ (nps ≤ 6 ∧ sentiment ≤ −0.5) ∨ (segment ∈ {hcp, wholesale} ∧ sentiment_label negative); P2 for taste, shipping ETA, promo, guidance, checkout, price; P3 praise, requests, marketing. Escalation target: P0 → quality_regulatory (+ medical when AE/contraindication); P1 subscription_billing → finance; claim_related → legal.

Flags: `claim_related` `/misleading|false advertis|clinically proven|autophagy|remission|biological age|scam/i`; `cancel_intent` `/cancel|unsubscribe|stop (my|the) (subscription|shipments)|refund/i`; `restricted` if segment ∈ {lnh_patient, hcp_patient} ∨ text matches `/a1c|hba1c|creatinine|my (doctor|physician) prescribed|diagnos/i` ∨ recipient matches `Med.Ed@`.

Entities (`extractEntities`): order_id from Amazon `1xx-xxxxxxx-xxxxxxx`, Shopify `#1xxxxx`, practitioner order `PP-xxxxx`, or "order/invoice/ref <id>"; lot_number `XX-####-X` or "lot/batch <code>"; hcp_code ONLY from a practitioner code `HCP-XXXXX` (upper-cased). A `PP-xxxxx` order id is never an hcp_code, and `classifyRecord` infers segment `hcp_patient` only from an HCP- code (a wholesale invoice quoting PP-12345 stays a practitioner/wholesale record).

## 8. Predictive models — parameters (see §4.7 for signatures)

Holt-Winters init: `L0 = mean(y[0..6])`, `B0 = (mean(y[7..13]) − mean(y[0..6]))/7`, `S_i = ((y[i]−mean(y[0..6])) + (y[i+7]−mean(y[7..13])))/2`; damped trend φ=0.9; residual σ over last 56 days; PI `F ± z·σ·√h`, floor 0; weekly block sums with half-width `z·σ·√(Σh)`. Backtest: rolling origin, 4 folds × 7 days; MAE, MAPE (`|y−F|/max(y,1)`), MASE vs seasonal naive `y_{t−7}`, coverage80. Confidence (implemented rule): **high** when MASE < 0.9 ∧ 80% coverage within 65–95% ∧ weekly-block MAPE < 15%; **medium** when MASE < 1.1 ∨ weekly-block MAPE < 30%; **low** otherwise. Weekly-block MAPE is `|Σy − ΣF| / max(Σy, 1)` per 7-day block of each fold (the error a weekly total carries); daily MAPE is reported in `backtest.mape` but not scored. Anomalies: rolling window 28 excluding day t, floors 1.0 (counts) / 0.03 (shares), DOW factors clamped [0.3, 2.5], Poisson rule `x > μ + 3√μ` when μ<10, weekly series scored too, warning |z|≥2, critical ≥3, consecutive days merged. Emerging: recent 7 vs prior 28 days; `E = cB·NR/NB`; Poisson surprise `z=(cR−E)/√(E+1)` for sparse units, two-proportion z for categories; `new` if cB=0 ∧ cR≥3; `emerging` z≥2 ∧ lift≥1.5; `fading` z≤−2 ∧ cB≥5. Churn heuristic features/weights (cap, w): neg msgs 30d (5, 1.6); billing complaints 90d (3, 1.8); open tickets (3, 1.2); oldest open age days (14, 0.8); days since last positive (180, 0.9); repeat contacts 30d (4, 1.4); max urgency 30d (3, 0.7); cancel intent 30d (1, 2.2); side-effect msgs 90d (3, 0.6); `logit = −3 + Σ w·x`; tiers 0–24 low, 25–49 watch, 50–74 high, 75+ critical; fitted logistic when ≥40 labelled customers (GD lr .1, 400 epochs, L2 .01, standardized) with AUC and reliability deciles. Escalation: `logit = −2.5 + 1.2u + 1.5neg + 2.5severe + 1.2strong + 0.5mild + 1.3age + 1.0repeat + 0.8noResponse + 0.5pub`. CSAT ridge λ=1 on resolved-with-CSAT (n≥50), features sentiment, log1p(frt), log1p(resolution), urgency, repeat, top-8 category one-hots; PI ±1.28σ; fallback `categoryMean + 0.8·sentiment` (low). Drivers: 2×2 lift, excess negatives, Yates χ², BH-adjusted q, min support 10. What-changed: `Δ_v = (nNow_v − nPrior_v)·ratePrior_v + nNow_v·(rateNow_v − ratePrior_v)`, tail grouped as Other so rows sum to Δ. Theme impact: `NPS(all) − NPS(excl T)`. SLA breach: empirical survival per category (n≥30) else global, `S(T)/S(a)`. Drift: OLS slope on 12 weekly index means, alert when `slope×12 < −5`.

## 9. Email intake

**Browser import** (`importers.js`): drop zone accepts `.eml`, `.mbox`, `.csv`, `.json`. `.eml`: fold headers, RFC 2047 words, QP/base64, multipart (prefer text/plain, else stripped html), attachments counted. `.mbox`: split on `/^From \S+ .{24}$/m`-style separators (RFC 4155), unescape `>From `. `.csv`: RFC 4180 parser + templates (`helpdesk`: subject,body,from_email,from_name,created_at,status,assignee,first_replied_at,closed_at,tags; `reviews`: title,body,rating,author,date,product,source; `orders_monthly`: month,product,orders; `records`: native columns) + a mapping dialog when no template matches (mapping remembered in localStorage by header fingerprint). `.json`: native `Record[]`, `{records:[...]}`, backup `{seed_meta, records, overlays, settings}`, or `RawEmail[]`. Result summary: added, duplicates, noise, needs review, non-English.

**Sidecar** (`server/voc_server.py`, Python 3.9 stdlib, binds 127.0.0.1:8765 by default): serves the site directory (same origin, no CORS) and the API. Prints `TOKEN = secrets.token_urlsafe(24)` at startup (or reads `VOC_API_TOKEN`); every `/api/*` except `/api/health` requires header `X-VoC-Token`. Config in `server/config.json` (copy of `config.example.json`; never contains secrets). Mailbox secret from env `VOC_MAIL_SECRET` or macOS Keychain (`security find-generic-password -s voc-mail -w`). Poller thread: `IMAP4_SSL` → `SELECT folder readonly` → `UID SEARCH` (`UID last+1:*` or `SINCE dd-Mon-yyyy`) → `UID FETCH (BODY.PEEK[] INTERNALDATE)` → `email.message_from_bytes(policy=default)` → normalize (decode headers, prefer text/plain, strip html, strip quoted history, count attachments, noise flags from headers) → dedupe by message-id → store (JSON file in `data_dir`, default `~/Library/Application Support/voc/records.json`) → rewrite `<site>/js/live-data.js` (`window.VOC_LIVE = [...]`) atomically. Optional `sent_folder` polled the same way with `direction:'outbound'` so the browser can compute first response times. Never sets `\Seen`.

API (as implemented in `voc_server.py`; `server/README.md` carries the same table): `GET /api/health → {ok, version, mode:'imap'|'idle', last_sync_at, uptime_s, records}` (no token); `GET /api/status → {connected, provider, mailbox, host, folder, sent_folder, last_sync_at, uidvalidity, last_uid, counts:{fetched, deduped, noise, filtered}, last_error, next_poll_in_s, polling, mode, total_records, data_dir, server_time}`; `GET /api/records?since=ISO&limit=500 → {records: RawEmail[], next_since, total, has_more, server_time}` oldest first — pass `next_since` (form `<iso>|<id>`) back as `since` to page; `GET/POST /api/config` (config JSON, no secrets; POST restarts the poller); `POST /api/sync → {ok, fetched, added, duplicates, noise, filtered, duration_ms}` (`409` when no mailbox is configured, `501` for xoauth2, `502` with the IMAP error text); `POST /api/ingest` (single RawEmail-like JSON from Zapier/Make/Power Automate) → `{ok, id, duplicate}` or `{ok, skipped: reason}` for noise/filtered mail; `POST /api/report {filename, html} → {ok, path}` saves a generated report under `data_dir/reports/`. Flags: `--site-dir` (default: parent of server/), `--port`, `--data-dir`, `--config`, `--once` (poll once and exit), `--no-poll` (serve only). `test_voc_server.py` (unittest) covers strip_quotes, normalize on the samples, noise detection, token rejection, since-pagination. `server/README.md` documents Gmail App Password (2-Step Verification required, `imap.gmail.com:993`), Yahoo/iCloud app passwords, Microsoft 365 (basic IMAP auth disabled — XOAUTH2/Graph is roadmap; document the device-code approach), Sent folder names, Keychain storage, the iCloud-Drive project folder hazard (data_dir defaults outside it), and the file:// fallback via live-data.js.

**Connector settings UI fields** (stored via `POST /api/config`): provider_preset (gmail|google_workspace|yahoo|icloud|generic_imap|microsoft365 (roadmap)), host, port, username, auth ('password'), folder, sent_folder, agent_addresses[], poll_interval_s (60–900), since (YYYY-MM-DD), max_per_poll, sender_allow[], sender_deny[], subject_include, subject_exclude, skip_autoreplies, order_prefix, restricted_recipients[] (default `Med.Ed@l-nutra.com`), restricted_domains[], redact_restricted_on_server (true), data_dir. The page never accepts or stores a mailbox password. Settings shows the PHI notice: client-side redaction is a display convenience, not access control; keep L-Nutra Health / Med.Ed mail in a separate mailbox or enable server-side redaction; HIPAA likely applies to L-Nutra Health patient mail; EU/UK senders imply GDPR handling.

## 10. Visual design tokens (`css/tokens.css`)

Type: **Hanken Grotesk** 400/500/600/700 for UI and figures (fallback `system-ui, -apple-system, "Segoe UI", sans-serif`); **Lora** 600/700 for the briefing headline, view titles and report titles only. Google Fonts: `https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=Lora:wght@600;700&display=swap`. Scale 12/13/14/16/20/28/36; `font-variant-numeric: tabular-nums` on table cells and axis ticks, proportional on tile values. Uppercase labels get `letter-spacing: .04em`.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#F8F4F2` | `#0F1A16` |
| `--surface` | `#FFFFFF` | `#16241F` |
| `--surface-2` | `#F2EAE5` | `#1D2E28` |
| `--text` | `#1C1D1D` | `#F2EAE5` |
| `--text-2` | `#3F4A46` | `#D6D0C8` |
| `--muted` | `#5F6A66` | `#9FB3A8` |
| `--border` | `#E6DED8` | `#2A3B33` |
| `--brand` | `#1E4036` | `#CDE3D3` |
| `--accent` | `#56A511` | `#7CC242` |
| `--accent-strong` | `#3B6D11` | `#56A511` |
| `--accent-soft` | `#EAF4DF` | `#1F3A1A` |
| `--focus` | `#7C3AED` | `#A78BFA` |
| `--grid` | `#ECE6E0` | `#24342D` |
| `--axis` | `#C9C0B8` | `#3A4A42` |
| `--s1..--s8` (series, fixed order) | `#56A511 #E87BA4 #2A78D6 #EB6834 #1BAF7A #EDA100 #4A3AA7 #E34948` | `#56A511 #D55181 #3987E5 #D95926 #199E70 #C98500 #9085E9 #E66767` |
| `--s-other` | `#9AA39E` | `#6F7F77` |
| `--seq-1..--seq-8` (green ramp) | `#EAF4DF #CFE6B8 #B0D68F #8FC466 #6DB13D #56A511 #3F7F0D #2C5A0B` | `rgba(124,194,66,.12) .22 .34 .46 .58 .70 .82 .95` |
| `--div-neg / --div-mid / --div-pos` | `#E34948 / #ECE7E1 / #2A78D6` | `#E66767 / #3A4A42 / #3987E5` |
| `--good / --warning / --serious / --critical` (status, never themed) | `#0CA30C / #FAB219 / #EC835A / #D03B3B` | same |
| `--good-text` | `#006300` | `#0CA30C` |
| `--serious-text` (text on `--serious-soft`: P1 pills, reopened, countdown "soon", serious command tiles) | `#9A3E1A` | `#F0A07E` |
| `--info` | `#2E6FB8` | `#7FA6E0` |

Heat-table text (`components.css`): cells carry `.ramp-step-1..8` for the `--seq` step behind them. Light: steps 1–6 use `--text`, steps 7–8 use `--surface`. Dark (both `[data-theme="dark"]` and the system-dark fallback): steps 1–5 use `#FFFFFF`, steps 6–8 use `--bg`. This keeps every ramp step ≥ 4.5:1 without per-cell color math.

Both palettes were validated with the dataviz validator (adjacent CVD ΔE 8.4 light/dark, normal-vision ΔE 19.8; yellow/aqua/magenta are below 3:1 on white so every chart with them carries direct labels or the table twin). Urgency pills: P0 `--critical`, P1 `--serious`, P2 `--info`, P3 `--muted`. Sentiment pills: positive `--good`, negative `--critical`, neutral `--muted` (always with a text label). Status colors are never used as series colors. Series slot mapping is fixed per entity (§4.9); a filter that removes a product never recolors the survivors.

Layout: max width 1440px; rail 220px on ≥1024px; gutters 24px (16px on phone); cards radius 10px, 1px `--border`, no shadows in dark; KPI strip `repeat(auto-fit, minmax(160px, 1fr))`; chart cards 280–340px tall including axis band; operator tables 13px / 36px rows; analytics text 14–16px; motion ≤150ms and disabled under `prefers-reduced-motion`. Dark mode: tokens redefined under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and again under `:root[data-theme="dark"]`; `body { background: var(--bg); color: var(--text) }`. Print: `@page { size: Letter; margin: 14mm }`, hides nav/filters/buttons, forces light tokens, `break-inside: avoid` on cards.

Header lockup: "L-Nutra" in Lora 700 `--brand`, a middle dot, "Voice of the Customer" in Hanken Grotesk 500. No logo recreation.

## 11. Testing and acceptance

`tests/run.sh` must pass: `test_util.js` (dates in CT incl. DST, week keys, business days across Thanksgiving/Christmas, Wilson/Poisson intervals, fnv64 stability), `test_classify.js` (≥40 gold sentences → category/subcategory/product/urgency/safety; sentiment sign on 30 sentences; noise detection; language gate; entity extraction; preprocess strips quotes/signatures), `test_analytics.js` (every registry id computes on seed without NaN; NPS interval; theme impact ordering sanity; ngrams/kwic/distinctive terms non-empty), `test_predict.js` (Holt-Winters recovers a synthetic weekly pattern within tolerance; anomaly detector flags an injected spike; emerging flags an injected ramp; churn tiers monotone in features; ridge solves a known system; backtest coverage on seed 65–95%), `test_seed_agreement.js` (seed size and date range; backlog realism per §6: 40–70 open-state records, 8–25 past first-response SLA, oldest open ≤60 days with ≤3 older than 45 days, resolved timestamps ordered; category agreement ≥85%; sentiment-band agreement ≥85%; product agreement ≥70%; review/survey channels ≥60% positive; band mix positive 54–66% / negative 22–34%; 12-month NPS 25–55; product realism (no kit vocabulary on bars/shakes/pills, no powder on Next Gen, HCP-XXXXX codes, no double periods); churn model fitted with CV AUC ≥0.65; planted events present and detected via `detectorBacktest` with recall ≥0.8; E7 drift alert), `test_seed_shape.js` (field/enum shape, Message-ID hosts per sender provider, bounces from mail.prolonlife.com), `test_mime.js` (samples parse: RFC 2047 subject, QP body, multipart preference, mbox split with `>From `), `test_store.js` (init with seed under jsc, filters/presets, derived KPIs non-NaN, overlays apply, undo works, query round-trip), `test_narrate.js` (headline and 5 insights on seed; lint passes on every generated sentence and on the stripped weekly/monthly report text; the headline's lead-change clause states both negative counts and both n).

Browser acceptance (checked by the integrator in Chrome and Safari): opens from `file://` with zero console errors; every view renders with the seed; filters update every view and the hash; dark/light/system switch re-themes charts; phone width has no horizontal scroll; drawer opens from a table row and from `#/inbox/:id`; imports of every sample succeed and re-import adds 0; Regulatory shows two live MedWatch countdowns; Forecast Lab sliders re-fit; Reports preview + print window work; Settings tester explains a pasted email; `python3 server/voc_server.py --no-poll` serves the site and `/api/health` answers; `python3 -m unittest server/test_voc_server.py` passes.
