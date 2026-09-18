// tests/test_seed_shape.js — shape checks for the generated seed (js/data.js).
// Run: jsc tests/_jsc_shim.js js/util.js js/data.js tests/test_seed_shape.js
(function () {
  var failed = 0, passed = 0;
  function assert(cond, msg) {
    if (cond) { passed++; console.log('PASS ' + msg); }
    else { failed++; console.log('FAIL ' + msg); }
  }
  function count(arr, fn) { var n = 0; for (var i = 0; i < arr.length; i++) if (fn(arr[i])) n++; return n; }
  function every(arr, fn) { for (var i = 0; i < arr.length; i++) if (!fn(arr[i])) return false; return true; }
  function inSet(list) { var s = {}; list.forEach(function (x) { s[x] = 1; }); return function (v) { return s[v] === 1; }; }

  var PRODUCTS = ['prolon_5day','prolon_nextgen','prolon_reset','prolon_52','fast_bar','fasting_shake','l_protein','l_pill','starter_pack','guided_health','lnutra_health','subscription_account','general'];
  var CATEGORIES = ['subscription_billing','checkout_website','shipping_fulfillment','missing_damaged','taste_quality','foreign_material_allergen','side_effects','adverse_event','efficacy_results','price_value','customer_service','hcp_practitioner','marketing_email','usage_guidance','product_request','praise','other_noise'];
  var SUBCATEGORIES = {
    subscription_billing: ['unauthorized_signup','auto_renew_surprise','cancel_friction','post_cancel_shipment','duplicate_charge','refund_status','promo_not_applied','discount_math','pause_skip'],
    checkout_website: ['checkout_error','mobile_checkout','unwanted_addon','promo_code','hcp_code_entry','login_account','app_bug'],
    shipping_fulfillment: ['late','lost','tracking','porch_drop','heat_damage','international_customs'],
    missing_damaged: ['missing_item','welcome_kit_missing','leaking','crushed_melted','damaged_seal'],
    taste_quality: ['soup_taste','texture','l_drink_taste','olives','bar_taste','portion','expiry_short_dated'],
    foreign_material_allergen: ['hard_bits','shell_fragment','allergen_exposure','mold_spoilage','undeclared_allergen'],
    side_effects: ['hunger','headache','fatigue','dizziness','brain_fog','nausea_gi','cold','sleep','inulin_ibs'],
    adverse_event: ['fainting','er_hospital','allergic_reaction','hypoglycemia_medication','pregnancy_minor','chest_pain'],
    efficacy_results: ['weight_loss','no_results','regain','energy_clarity','labs_biomarkers'],
    price_value: ['too_expensive','per_day_cost','hsa_fsa','bundle_value','price_increase'],
    customer_service: ['no_response','slow_response','wrong_item_sent','great_agent','chatbot_loop'],
    hcp_practitioner: ['account_setup','bulk_order','patient_protocol','evidence_request'],
    marketing_email: ['too_many_emails','influencer_skepticism','misleading_claim'],
    usage_guidance: ['coffee_exercise','medications','refeed_transition','cycle_frequency','general_question'],
    product_request: ['new_flavor','allergen_free','sample_pack','longer_program'],
    praise: ['results_praise','convenience','cs_praise','nextgen_taste','general_praise'],
    other_noise: ['auto_reply','bounce','newsletter','duplicate']
  };
  var isChannel = inSet(['email','amazon_review','trustpilot_review','survey','chat','social','phone_note','hcp_portal']);
  var isSales = inSet(['dtc_web','amazon','hcp','lnutra_health','employer','social_affiliate','international']);
  var isSegment = inSet(['first_time','repeat','subscriber','hcp','hcp_patient','lnh_patient','employer','wholesale']);
  var isRegion = inSet(['US','CA','UK','EU','DE','IT','AU','AE','OTHER']);
  var isStatus = inSet(['new','open','pending','resolved','reopened','escalated','closed_noise']);
  var isUrgency = inSet(['P0','P1','P2','P3']);
  var isEsc = inSet(['none','quality_regulatory','finance','cs_lead','legal','medical']);
  var isLabel = inSet(['positive','neutral','negative','unscored']);
  var isLang = inSet(['en','other','unknown']);
  var isProduct = inSet(PRODUCTS);
  var isCategory = inSet(CATEGORIES);
  var isComponent = inSet(['soup_tomato','soup_vegetable','soup_minestrone','soup_minestrone_quinoa','soup_artichoke','soup_broccoli_quinoa','soup_mushroom','l_bar','choco_crisp','olives','kale_crackers','l_drink','nr1','algal_oil','tea']);
  var isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  assert(typeof window.VOC_SEED === 'object' && window.VOC_SEED !== null, 'window.VOC_SEED is defined');
  var seed = window.VOC_SEED;
  var meta = seed.meta, recs = seed.records, custs = seed.customers, pracs = seed.practices, orders = seed.orders_by_month;

  // meta
  assert(meta.schema_version === 1 && meta.seed === 20260917 && meta.generated === '2026-09-17', 'meta identity fields');
  assert(meta.as_of === '2026-09-16T23:59:00Z', 'meta.as_of is the demo clock');
  assert(meta.range[0] === '2025-09-15' && meta.range[1] === '2026-09-16', 'meta.range');
  assert(meta.timezone === 'America/Chicago', 'meta.timezone');
  assert(meta.agents.length === 4 && meta.agents[0] === 'Maya R.', 'meta.agents');
  assert(meta.planted_events.length === 13, 'meta.planted_events has 13 events');
  var evIds = meta.planted_events.map(function (e) { return e.id; }).join(',');
  assert(evIds === 'E1,E2,E3,E4,E5,E6,E7,E8,E9,E10,E11,E12,E13', 'planted event ids E1..E13 in order');
  assert(every(meta.planted_events, function (e) { return e.id && e.from && e.to && e.title && e.detector && typeof e.expected === 'object'; }), 'every planted event has id/from/to/title/detector/expected');

  // counts
  assert(recs.length >= 1000 && recs.length <= 1060, 'record count in 1000..1060 (' + recs.length + ')');
  assert(custs.length === 640, '640 customers');
  assert(pracs.length === 18, '18 practices');
  assert(recs[0].received_at.slice(0, 10) === '2025-09-15', 'first record on 2025-09-15');
  assert(recs[recs.length - 1].received_at.slice(0, 10) === '2026-09-16', 'last record on 2026-09-16');
  assert(every(recs, function (r) { return r.received_at <= meta.as_of; }), 'no record newer than as_of');

  // ids and ordering
  var ordered = true, idsOk = true;
  for (var i = 0; i < recs.length; i++) {
    if (recs[i].id !== 'r_' + String(i + 1).padStart(6, '0')) idsOk = false;
    if (i > 0 && recs[i].received_at < recs[i - 1].received_at) ordered = false;
  }
  assert(idsOk, 'ids are r_000001.. sequential');
  assert(ordered, 'records sorted by received_at ascending');

  // field/enum validity on every record
  var custIds = {};
  custs.forEach(function (c) { custIds[c.customer_id] = 1; });
  var FIELDS = ['id','schema_version','received_at','channel','sales_channel','from_name','from_email','subject','text','language','has_attachment','product','product_variant','kit_component','product_class','category','subcategory','secondary_categories','sentiment','sentiment_min','sentiment_label','nps','rating','csat','urgency','status','first_response_at','resolved_at','reopen_count','service_fields_source','escalated_to','is_adverse_event','serious_ae','ae_criteria','contraindication_flags','food_safety','lot_number','order_id','hcp_code','claim_related','cancel_intent','restricted','customer_id','segment','region','thread_id','is_first_contact','message_id','source','is_noise','noise_reason','assignee','tags','notes','classifier'];
  var fieldsOk = every(recs, function (r) { return every(FIELDS, function (f) { return Object.prototype.hasOwnProperty.call(r, f); }); });
  assert(fieldsOk, 'every record has every SPEC section 2 field');
  assert(every(recs, function (r) { return isChannel(r.channel) && isSales(r.sales_channel) && isSegment(r.segment) && isRegion(r.region); }), 'channel/sales_channel/segment/region enums valid');
  assert(every(recs, function (r) { return isProduct(r.product) && isCategory(r.category) && SUBCATEGORIES[r.category].indexOf(r.subcategory) >= 0; }), 'product/category/subcategory enums valid');
  assert(every(recs, function (r) { return r.kit_component === null || isComponent(r.kit_component); }), 'kit_component enum valid');
  assert(every(recs, function (r) { return isStatus(r.status) && isUrgency(r.urgency) && isEsc(r.escalated_to) && isLabel(r.sentiment_label) && isLang(r.language); }), 'status/urgency/escalation/label/language enums valid');
  assert(every(recs, function (r) { return typeof r.sentiment === 'number' && r.sentiment >= -1 && r.sentiment <= 1 && r.sentiment_min <= r.sentiment + 1e-9 && r.sentiment_min >= -1; }), 'sentiment numbers in range, min <= sentiment');
  assert(every(recs, function (r) { return (r.language === 'other') === (r.sentiment_label === 'unscored'); }), 'non-English records are unscored and vice versa');
  assert(every(recs, function (r) { return isoRe.test(r.received_at) && (r.first_response_at === null || isoRe.test(r.first_response_at)) && (r.resolved_at === null || isoRe.test(r.resolved_at)); }), 'timestamps are ISO-8601 UTC');
  assert(every(recs, function (r) {
    if (r.status === 'new' || r.status === 'open') return r.first_response_at === null && r.resolved_at === null;
    if (r.status === 'resolved') return r.resolved_at !== null && r.resolved_at >= (r.first_response_at || r.received_at);
    return r.resolved_at === null && (r.first_response_at === null || r.first_response_at >= r.received_at);
  }), 'first_response_at/resolved_at consistent with status');
  assert(every(recs, function (r) { return r.service_fields_source === 'seed' && r.source === 'seed' && r.schema_version === 1; }), 'source fields are seed');
  assert(every(recs, function (r) { return custIds[r.customer_id] === 1 && /^c_[0-9a-f]{16}$/.test(r.customer_id); }), 'customer_id in pool, c_<hex16>');
  assert(every(recs, function (r) { return /^t_[0-9a-f]{16}$/.test(r.thread_id); }), 'thread_id is t_<hex16>');
  assert(every(recs, function (r) { return r.channel !== 'email' || /^<[0-9a-f]{12}\.\d+@[a-z0-9.-]+>$/.test(r.message_id); }), 'email records carry a Message-ID <hex.n@host>');
  assert(every(recs, function (r) { return r.channel !== 'email' || r.noise_reason === 'bounce' || !r.from_email || !/@mail\.prolonlife\.com>$/.test(r.message_id); }), 'inbound Message-IDs come from the sender provider, not L-Nutra\'s server');
  assert(every(recs, function (r) { return r.noise_reason !== 'bounce' || /@mail\.prolonlife\.com>$/.test(r.message_id); }), 'bounce Message-IDs come from mail.prolonlife.com');
  assert(every(recs, function (r) { return r.channel !== 'phone_note' || r.text.indexOf('.. ') < 0; }), 'phone notes carry no double period after the agent name');
  assert(every(recs, function (r) { return r.is_noise === (r.status === 'closed_noise') && (r.is_noise ? r.noise_reason !== null : r.noise_reason === null); }), 'is_noise / closed_noise / noise_reason agree');
  assert(every(recs, function (r) { var c = r.classifier; return c && c.confidence >= 0.6 && c.confidence <= 0.95 && c.rule_category === r.category && c.rule_subcategory === r.subcategory && c.rule_product === r.product && c.manual_override === false && c.needs_review === false; }), 'classifier block shaped per assignment');
  assert(every(recs, function (r) { return Array.isArray(r.tags) && Array.isArray(r.notes) && Array.isArray(r.secondary_categories) && Array.isArray(r.ae_criteria) && Array.isArray(r.contraindication_flags); }), 'array fields are arrays');
  assert(every(recs, function (r) { return (r.nps === null || (r.nps >= 0 && r.nps <= 10)) && (r.rating === null || (r.rating >= 1 && r.rating <= 5)) && (r.csat === null || (r.csat >= 1 && r.csat <= 5)); }), 'nps/rating/csat ranges');
  assert(every(recs, function (r) { return typeof r.subject === 'string' && r.subject.length > 0 && typeof r.text === 'string' && r.text.length > 10 && r.text.indexOf('{') < 0; }), 'subject/text present with no unfilled slots');
  assert(every(recs, function (r) { return r.segment !== 'lnh_patient' && r.segment !== 'hcp_patient' || r.restricted === true; }), 'E11: LNH / practitioner patient records are restricted');

  // planted events
  var serious = recs.filter(function (r) { return r.serious_ae; });
  assert(serious.length === 6, 'E10: six serious AEs');
  assert(every(serious, function (r) { return r.is_adverse_event && r.urgency === 'P0' && r.category === 'adverse_event' && r.ae_criteria.length > 0; }), 'E10: serious AEs are P0 adverse_event with criteria');
  assert(count(serious, function (r) { return r.received_at >= '2026-09-02'; }) === 2, 'E10: two serious AEs in the last 10 business days');
  var noise = recs.filter(function (r) { return r.is_noise; });
  assert(noise.length === 11 && count(noise, function (r) { return r.noise_reason === 'auto_reply'; }) === 6 && count(noise, function (r) { return r.noise_reason === 'bounce'; }) === 3 && count(noise, function (r) { return r.noise_reason === 'newsletter'; }) === 2, 'E12: 6 auto-replies, 3 bounces, 2 newsletters');
  var e6 = recs.filter(function (r) { return r.lot_number === 'NG-0426-B'; });
  assert(e6.length === 18 && every(e6, function (r) { return r.food_safety && r.urgency === 'P0' && r.product === 'prolon_nextgen' && r.kit_component === 'soup_minestrone_quinoa' && r.category === 'foreign_material_allergen'; }), 'E6: 18 P0 food-safety records on lot NG-0426-B');
  var e5 = recs.filter(function (r) { return r.subcategory === 'duplicate_charge' && r.received_at >= '2026-02-24T06:00:00Z' && r.received_at <= '2026-02-27T06:00:00Z'; });
  assert(e5.length >= 14 && every(e5, function (r) { return r.urgency === 'P1' && /charged twice|double charged|duplicate charge/i.test(r.text); }), 'E5: >=14 P1 duplicate charges in 72h saying charged twice');
  var e8 = recs.filter(function (r) { return r.subcategory === 'leaking' && r.received_at >= '2026-07-06T05:00:00Z' && r.received_at <= '2026-07-27T05:00:00Z'; });
  assert(e8.length >= 19 && every(e8, function (r) { return /leak/i.test(r.text); }), 'E8: >=19 leaking records in the ramp window');
  assert(count(recs, function (r) { return r.product === 'guided_health' && r.received_at < '2025-10-23'; }) === 0 && count(recs, function (r) { return r.product === 'guided_health' && r.received_at >= '2025-10-23' && r.received_at <= '2025-11-16'; }) >= 3, 'E1: guided_health appears only from launch');
  assert(count(recs, function (r) { return r.product === 'starter_pack' && r.received_at < '2026-08-06'; }) === 0 && count(recs, function (r) { return r.product === 'starter_pack'; }) >= 8, 'E9: starter_pack appears only from launch');
  assert(count(recs, function (r) { return r.restricted; }) >= 40, 'E11: restricted queue populated');
  assert(count(recs, function (r) { return r.category === 'side_effects'; }) >= 35, 'about 40 non-serious side-effect records');
  var followups = count(recs, function (r) { return !r.is_first_contact; });
  assert(followups >= 10, 'repeat contacts share threads (' + followups + ')');
  assert(count(recs, function (r) { return r.text.indexOf('Customer Care <care@prolonlife.com> wrote:') >= 0; }) >= 30, 'some email bodies carry a quoted tail');

  // customers, practices, orders
  assert(every(custs, function (c) { return isSegment(c.segment) && isSales(c.sales_channel) && isRegion(c.region) && ['none','active','paused','cancelled'].indexOf(c.subscription_status) >= 0; }), 'customer enums valid');
  assert(every(pracs, function (p) { return ['physician','np','chiropractor','rd','health_coach','weight_loss_center','fitness_studio'].indexOf(p.type) >= 0 && isRegion(p.region); }), 'practice enums valid');
  var months = Object.keys(orders._total);
  assert(months.length === 13 && months[0] === '2025-09' && months[12] === '2026-09', 'orders_by_month covers 2025-09..2026-09');
  assert(every(Object.keys(orders), function (k) { return k === '_total' || isProduct(k); }), 'orders_by_month keys are _total or product ids');
  var totalOk = every(months, function (m) { var s = 0; Object.keys(orders).forEach(function (k) { if (k !== '_total') s += orders[k][m] || 0; }); return s === orders._total[m]; });
  assert(totalOk, 'orders _total equals the sum of products per month');

  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) throw new Error('test_seed_shape: ' + failed + ' failure(s)');
})();
