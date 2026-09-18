/* L-Nutra Voice of the Customer — util.js (A1)
 * Enums + display labels (SPEC §3), formatting, America/Chicago dates, US federal holidays,
 * statistics, PRNG, hashing and small helpers (SPEC §4.1). PURE: runs under jsc with no DOM.
 */
window.VOC = window.VOC || {};
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* §3 Enums and labels                                                 */
  /* ------------------------------------------------------------------ */

  const PRODUCTS = {
    prolon_5day: 'ProLon 5-Day', prolon_nextgen: 'ProLon Next Gen', prolon_reset: 'ProLon 1-Day Reset', prolon_52: 'ProLon 5:2',
    fast_bar: 'Fast Bar', fasting_shake: 'Fasting Shake', l_protein: 'L-Protein', l_pill: 'L-Pill', starter_pack: 'Longevity Starter Pack',
    guided_health: 'Guided Health Program', lnutra_health: 'L-Nutra Health', subscription_account: 'Subscription & Account', general: 'General'
  };
  const PRODUCT_CLASS = {
    prolon_5day: 'conventional_food', prolon_nextgen: 'conventional_food', prolon_reset: 'conventional_food', prolon_52: 'conventional_food',
    fast_bar: 'conventional_food', fasting_shake: 'conventional_food', l_protein: 'conventional_food', starter_pack: 'conventional_food',
    l_pill: 'supplement', guided_health: 'program', lnutra_health: 'program', subscription_account: 'none', general: 'none'
  };
  const PRODUCT_CLASSES = { supplement: 'Supplement', conventional_food: 'Conventional food', program: 'Program', none: 'None' };
  const KIT_COMPONENTS = {
    soup_tomato: 'Tomato soup', soup_vegetable: 'Vegetable soup', soup_minestrone: 'Minestrone soup', soup_minestrone_quinoa: 'Minestrone quinoa soup',
    soup_artichoke: 'Artichoke soup', soup_broccoli_quinoa: 'Broccoli quinoa soup', soup_mushroom: 'Mushroom soup', l_bar: 'L-Bar', choco_crisp: 'Choco Crisp',
    olives: 'Olives', kale_crackers: 'Kale crackers', l_drink: 'L-Drink', nr1: 'NR-1', algal_oil: 'Algal oil', tea: 'Herbal tea'
  };
  const CATEGORIES = {
    subscription_billing: 'Subscription & Billing', checkout_website: 'Checkout & Website', shipping_fulfillment: 'Shipping & Delivery',
    missing_damaged: 'Missing or Damaged Items', taste_quality: 'Taste & Food Quality', foreign_material_allergen: 'Foreign Material & Allergen',
    side_effects: 'Side Effects', adverse_event: 'Adverse Event (serious)', efficacy_results: 'Results & Efficacy', price_value: 'Price & Value',
    customer_service: 'Customer Service', hcp_practitioner: 'Practitioner & HCP', marketing_email: 'Marketing & Email', usage_guidance: 'Usage Guidance',
    product_request: 'Product Requests', praise: 'Praise', other_noise: 'Noise'
  };
  const SUBCATEGORY_IDS = {
    subscription_billing: ['unauthorized_signup', 'auto_renew_surprise', 'cancel_friction', 'post_cancel_shipment', 'duplicate_charge', 'refund_status', 'promo_not_applied', 'discount_math', 'pause_skip'],
    checkout_website: ['checkout_error', 'mobile_checkout', 'unwanted_addon', 'promo_code', 'hcp_code_entry', 'login_account', 'app_bug'],
    shipping_fulfillment: ['late', 'lost', 'tracking', 'porch_drop', 'heat_damage', 'international_customs'],
    missing_damaged: ['missing_item', 'welcome_kit_missing', 'leaking', 'crushed_melted', 'damaged_seal'],
    taste_quality: ['soup_taste', 'texture', 'l_drink_taste', 'olives', 'bar_taste', 'portion', 'expiry_short_dated'],
    foreign_material_allergen: ['hard_bits', 'shell_fragment', 'allergen_exposure', 'mold_spoilage', 'undeclared_allergen'],
    side_effects: ['hunger', 'headache', 'fatigue', 'dizziness', 'brain_fog', 'nausea_gi', 'cold', 'sleep', 'inulin_ibs'],
    adverse_event: ['fainting', 'er_hospital', 'allergic_reaction', 'hypoglycemia_medication', 'pregnancy_minor', 'chest_pain'],
    efficacy_results: ['weight_loss', 'no_results', 'regain', 'energy_clarity', 'labs_biomarkers'],
    price_value: ['too_expensive', 'per_day_cost', 'hsa_fsa', 'bundle_value', 'price_increase'],
    customer_service: ['no_response', 'slow_response', 'wrong_item_sent', 'great_agent', 'chatbot_loop'],
    hcp_practitioner: ['account_setup', 'bulk_order', 'patient_protocol', 'evidence_request'],
    marketing_email: ['too_many_emails', 'influencer_skepticism', 'misleading_claim'],
    usage_guidance: ['coffee_exercise', 'medications', 'refeed_transition', 'cycle_frequency', 'general_question'],
    product_request: ['new_flavor', 'allergen_free', 'sample_pack', 'longer_program'],
    praise: ['results_praise', 'convenience', 'cs_praise', 'nextgen_taste', 'general_praise'],
    other_noise: ['auto_reply', 'bounce', 'newsletter', 'duplicate']
  };
  const SUBCATEGORY_LABEL_OVERRIDES = {
    l_drink_taste: 'L-Drink taste', hcp_code_entry: 'HCP code entry', er_hospital: 'ER / hospital', hsa_fsa: 'HSA / FSA',
    inulin_ibs: 'Inulin / IBS', nextgen_taste: 'Next Gen taste', nausea_gi: 'Nausea / GI', app_bug: 'App bug'
  };
  const CHANNELS = {
    email: 'Email', amazon_review: 'Amazon review', trustpilot_review: 'Trustpilot review', survey: 'Survey', chat: 'Chat',
    social: 'Social', phone_note: 'Phone note', hcp_portal: 'HCP portal'
  };
  const SALES_CHANNELS = {
    dtc_web: 'prolonlife.com', amazon: 'Amazon', hcp: 'Practitioner', lnutra_health: 'L-Nutra Health', employer: 'Employer program',
    social_affiliate: 'Social / affiliate', international: 'International store'
  };
  const SEGMENTS = {
    first_time: 'First-time', repeat: 'Repeat', subscriber: 'Subscriber', hcp: 'Practitioner', hcp_patient: 'Practitioner patient',
    lnh_patient: 'L-Nutra Health patient', employer: 'Employer member', wholesale: 'Wholesale'
  };
  const REGIONS = { US: 'United States', CA: 'Canada', UK: 'United Kingdom', EU: 'EU (other)', DE: 'Germany', IT: 'Italy', AU: 'Australia', AE: 'UAE', OTHER: 'Other' };
  const STATUSES = { new: 'New', open: 'Open', pending: 'Pending', resolved: 'Resolved', reopened: 'Reopened', escalated: 'Escalated', closed_noise: 'Closed (noise)' };
  const URGENCY = { P0: 'P0 · Critical', P1: 'P1 · High', P2: 'P2 · Normal', P3: 'P3 · Low' };
  const SLA_FRT_HOURS = { P0: 1, P1: 4, P2: 24, P3: 72 };
  const ESCALATION_TARGETS = { none: 'None', quality_regulatory: 'Quality & Regulatory', finance: 'Finance', cs_lead: 'CS lead', legal: 'Legal', medical: 'Medical' };
  const SENTIMENT_LABELS = { positive: 'Positive', neutral: 'Neutral', negative: 'Negative', unscored: 'Unscored' };
  const AE_CRITERIA = { death: 'Death', life_threatening: 'Life-threatening', hospitalization: 'Hospitalization', disability: 'Disability', birth_defect: 'Birth defect', intervention: 'Intervention required' };
  const CONTRAINDICATIONS = { pregnancy: 'Pregnancy or nursing', minor: 'Under 18', glucose_meds: 'Glucose-lowering medication', nut_soy_allergy: 'Nut or soy allergy', bmi_low: 'Low BMI', serious_disease: 'Serious disease' };
  const OPEN_STATUSES = ['new', 'open', 'pending', 'reopened', 'escalated'];
  const COMPLAINT_CATEGORIES = ['subscription_billing', 'checkout_website', 'shipping_fulfillment', 'missing_damaged', 'taste_quality',
    'foreign_material_allergen', 'side_effects', 'adverse_event', 'customer_service', 'price_value'];

  function sentenceCase(id) {
    const s = String(id).replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const SUBCATEGORIES = {};
  const SUBCATEGORY_FLAT = {};
  const SUBCATEGORY_PARENT = {};
  Object.keys(SUBCATEGORY_IDS).forEach((cat) => {
    SUBCATEGORIES[cat] = {};
    SUBCATEGORY_IDS[cat].forEach((id) => {
      const label = SUBCATEGORY_LABEL_OVERRIDES[id] || sentenceCase(id);
      SUBCATEGORIES[cat][id] = label;
      SUBCATEGORY_FLAT[id] = label;
      SUBCATEGORY_PARENT[id] = cat;
    });
  });

  const KIND_TABLES = {
    product: PRODUCTS, products: PRODUCTS,
    product_class: PRODUCT_CLASSES, product_classes: PRODUCT_CLASSES,
    kit_component: KIT_COMPONENTS, kit_components: KIT_COMPONENTS, component: KIT_COMPONENTS,
    category: CATEGORIES, categories: CATEGORIES,
    subcategory: SUBCATEGORY_FLAT, subcategories: SUBCATEGORY_FLAT,
    channel: CHANNELS, channels: CHANNELS,
    sales_channel: SALES_CHANNELS, sales_channels: SALES_CHANNELS,
    segment: SEGMENTS, segments: SEGMENTS,
    region: REGIONS, regions: REGIONS,
    status: STATUSES, statuses: STATUSES,
    urgency: URGENCY,
    escalation_target: ESCALATION_TARGETS, escalation_targets: ESCALATION_TARGETS, escalated_to: ESCALATION_TARGETS,
    sentiment: SENTIMENT_LABELS, sentiment_label: SENTIMENT_LABELS, sentiment_labels: SENTIMENT_LABELS,
    ae_criteria: AE_CRITERIA, ae_criterion: AE_CRITERIA,
    contraindication: CONTRAINDICATIONS, contraindications: CONTRAINDICATIONS, contraindication_flags: CONTRAINDICATIONS
  };
  function tableFor(kind) {
    return KIND_TABLES[String(kind || '').toLowerCase()] || null;
  }

  const enums = {
    PRODUCTS, PRODUCT_CLASS, PRODUCT_CLASSES, KIT_COMPONENTS, CATEGORIES, SUBCATEGORIES, SUBCATEGORY_PARENT, CHANNELS, SALES_CHANNELS,
    SEGMENTS, REGIONS, STATUSES, URGENCY, SLA_FRT_HOURS, ESCALATION_TARGETS, SENTIMENT_LABELS, AE_CRITERIA, CONTRAINDICATIONS,
    OPEN_STATUSES, COMPLAINT_CATEGORIES,
    /**
     * Display label for an enum id. Falls back to the id itself.
     * @param {string} kind e.g. 'product' | 'category' | 'subcategory' | 'channel' | 'segment' | 'status' | 'urgency' (plural/uppercase accepted)
     * @param {string} id
     * @returns {string}
     */
    label(kind, id) {
      if (id === null || id === undefined) return '—';
      const t = tableFor(kind);
      return (t && t[id]) || String(id);
    },
    /**
     * Ordered list of {id, label} for a kind.
     * @param {string} kind
     * @returns {{id:string,label:string}[]}
     */
    list(kind) {
      const t = tableFor(kind);
      return t ? Object.keys(t).map((id) => ({ id, label: t[id] })) : [];
    },
    /**
     * Subcategories of a category as {id, label} in display order.
     * @param {string} categoryId
     * @returns {{id:string,label:string}[]}
     */
    subcategories(categoryId) {
      const t = SUBCATEGORIES[categoryId];
      return t ? Object.keys(t).map((id) => ({ id, label: t[id] })) : [];
    },
    /**
     * Parent category of a subcategory id, or null.
     * @param {string} subcategoryId
     * @returns {string|null}
     */
    categoryOf(subcategoryId) {
      return SUBCATEGORY_PARENT[subcategoryId] || null;
    },
    /**
     * Regulatory product class for a product id ('supplement'|'conventional_food'|'program'|'none').
     * @param {string} productId
     * @returns {string}
     */
    productClass(productId) {
      return PRODUCT_CLASS[productId] || 'none';
    }
  };

  /* ------------------------------------------------------------------ */
  /* Dates — America/Chicago via Intl                                    */
  /* ------------------------------------------------------------------ */

  const TZ = 'America/Chicago';
  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;
  const DOW_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let partsFormatter = null;
  function getPartsFormatter() {
    if (!partsFormatter) {
      partsFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    return partsFormatter;
  }

  function isDateOnly(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  /** Coerce ISO string | Date | ms number into a Date, or null when invalid. */
  function toDate(x) {
    if (x instanceof Date) return isNaN(x.getTime()) ? null : x;
    if (typeof x === 'number') return isNaN(x) ? null : new Date(x);
    if (typeof x === 'string') {
      if (isDateOnly(x)) return new Date(startOfDayCT(x));
      const d = new Date(x);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  /**
   * Calendar parts of an instant in America/Chicago.
   * @param {string|Date|number} iso
   * @returns {{y:number,m:number,d:number,dow:number,hour:number,minute:number,second:number}|null} dow 0=Mon..6=Sun
   */
  function parts(iso) {
    const date = toDate(iso);
    if (!date) return null;
    const out = { y: 0, m: 0, d: 0, dow: 0, hour: 0, minute: 0, second: 0 };
    getPartsFormatter().formatToParts(date).forEach((p) => {
      switch (p.type) {
        case 'year': out.y = +p.value; break;
        case 'month': out.m = +p.value; break;
        case 'day': out.d = +p.value; break;
        case 'hour': out.hour = +p.value % 24; break;
        case 'minute': out.minute = +p.value; break;
        case 'second': out.second = +p.value; break;
        case 'weekday': out.dow = DOW_INDEX[p.value] ?? 0; break;
        default: break;
      }
    });
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

  /** Offset of America/Chicago from UTC, in minutes, at a given instant (ms). */
  function offsetMinutesAt(ms) {
    const p = parts(new Date(ms));
    const wall = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second);
    return Math.round((wall - ms) / 60000);
  }

  /**
   * ISO UTC instant of 00:00 in America/Chicago on a calendar date.
   * @param {string} isoDate 'YYYY-MM-DD' (a full ISO timestamp is reduced to its CT date first)
   * @returns {string} ISO UTC
   */
  function startOfDayCT(isoDate) {
    const key = isDateOnly(isoDate) ? isoDate : dayKey(isoDate);
    if (!key) return null;
    const [y, m, d] = key.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    let t = guess - offsetMinutesAt(guess) * 60000;
    t = guess - offsetMinutesAt(t) * 60000;
    return new Date(t).toISOString();
  }

  /**
   * ISO UTC instant of the last millisecond of a CT calendar date.
   * @param {string} isoDate
   * @returns {string}
   */
  function endOfDayCT(isoDate) {
    const key = isDateOnly(isoDate) ? isoDate : dayKey(isoDate);
    if (!key) return null;
    return new Date(new Date(startOfDayCT(addDays(key, 1))).getTime() - 1).toISOString();
  }

  /** 'YYYY-MM-DD' in CT for an instant. */
  function dayKey(iso) {
    if (isDateOnly(iso)) return iso;
    const p = parts(iso);
    return p ? ymd(p.y, p.m, p.d) : null;
  }
  /** 'YYYY-MM-DD' in CT for a Date (alias of dayKey accepting Date). */
  function isoDate(date) { return dayKey(date); }
  /** 'YYYY-MM' in CT. */
  function monthKey(iso) {
    const key = dayKey(iso);
    return key ? key.slice(0, 7) : null;
  }

  /** ISO week (Monday start) of a calendar date given as y, m, d. */
  function isoWeekOf(y, m, d) {
    const date = new Date(Date.UTC(y, m - 1, d));
    const dayNum = (date.getUTCDay() + 6) % 7; // 0=Mon
    date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
    const isoYear = date.getUTCFullYear();
    const firstThu = new Date(Date.UTC(isoYear, 0, 4));
    const week = 1 + Math.round(((date - firstThu) / DAY_MS - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return { isoYear, week };
  }
  /** '2026-W37' ISO week key (Monday start) of an instant in CT. */
  function weekKey(iso) {
    const key = dayKey(iso);
    if (!key) return null;
    const [y, m, d] = key.split('-').map(Number);
    const w = isoWeekOf(y, m, d);
    return w.isoYear + '-W' + pad2(w.week);
  }
  /**
   * Monday of an ISO week key as 'YYYY-MM-DD'.
   * @param {string} wk e.g. '2026-W37'
   * @returns {string|null}
   */
  function weekStart(wk) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(wk || ''));
    if (!m) return null;
    const y = +m[1], w = +m[2];
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const jan4Dow = (jan4.getUTCDay() + 6) % 7;
    const monday = new Date(jan4.getTime() - jan4Dow * DAY_MS + (w - 1) * 7 * DAY_MS);
    return ymd(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
  }
  /**
   * Add calendar days to a 'YYYY-MM-DD' date.
   * @param {string} isoDateStr
   * @param {number} n
   * @returns {string}
   */
  function addDays(isoDateStr, n) {
    const key = dayKey(isoDateStr);
    if (!key) return null;
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d) + Math.round(n) * DAY_MS);
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  /**
   * Whole calendar days from a to b (b − a) using CT dates.
   * @param {string} a
   * @param {string} b
   * @returns {number|null}
   */
  function daysBetween(a, b) {
    const ka = dayKey(a), kb = dayKey(b);
    if (!ka || !kb) return null;
    const [ya, ma, da] = ka.split('-').map(Number);
    const [yb, mb, db] = kb.split('-').map(Number);
    return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / DAY_MS);
  }
  /** Number of days in the month of a 'YYYY-MM' or 'YYYY-MM-DD' key. */
  function daysInMonth(key) {
    const [y, m] = String(key).split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  /** Add n months to a 'YYYY-MM' key. */
  function addMonths(key, n) {
    const [y, m] = String(key).split('-').map(Number);
    const total = y * 12 + (m - 1) + n;
    return Math.floor(total / 12) + '-' + pad2((total % 12 + 12) % 12 + 1);
  }

  /* US federal holidays, observed dates (OPM). 2027-12-31 observes New Year's Day 2028. */
  const US_HOLIDAYS = {
    2025: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25'],
    2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-31']
  };
  const HOLIDAY_SET = new Set([].concat(US_HOLIDAYS[2025], US_HOLIDAYS[2026], US_HOLIDAYS[2027]));

  /**
   * Monday–Friday and not a US federal holiday.
   * @param {string} isoDateStr 'YYYY-MM-DD' (or ISO instant, reduced to its CT date)
   * @returns {boolean}
   */
  function isBusinessDay(isoDateStr) {
    const key = dayKey(isoDateStr);
    if (!key) return false;
    const [y, m, d] = key.split('-').map(Number);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    return dow < 5 && !HOLIDAY_SET.has(key);
  }

  /**
   * Add n business days. A date-only input returns a date-only result; an ISO instant keeps its CT wall-clock time.
   * @param {string} iso
   * @param {number} n
   * @returns {string|null}
   */
  function addBusinessDays(iso, n) {
    const key = dayKey(iso);
    if (!key) return null;
    let date = key;
    let remaining = Math.round(n);
    const step = remaining < 0 ? -1 : 1;
    while (remaining !== 0) {
      date = addDays(date, step);
      if (isBusinessDay(date)) remaining -= step;
    }
    if (isDateOnly(iso)) return date;
    const p = parts(iso);
    const base = new Date(startOfDayCT(date)).getTime();
    return new Date(base + ((p.hour * 60 + p.minute) * 60 + p.second) * 1000).toISOString();
  }

  /** Fraction of the CT day elapsed at an instant (0..1). */
  function dayFraction(iso) {
    const p = parts(iso);
    return ((p.hour * 60 + p.minute) * 60 + p.second) / 86400;
  }

  /**
   * Business days between two instants, fractional. Negative when b precedes a.
   * Date-only inputs count from 00:00 CT.
   * @param {string} aIso
   * @param {string} bIso
   * @returns {number|null}
   */
  function businessDaysBetween(aIso, bIso) {
    const a = toDate(aIso), b = toDate(bIso);
    if (!a || !b) return null;
    if (b < a) return -businessDaysBetween(bIso, aIso);
    const ka = dayKey(a), kb = dayKey(b);
    const fa = dayFraction(a), fb = dayFraction(b);
    if (ka === kb) return isBusinessDay(ka) ? fb - fa : 0;
    let total = isBusinessDay(ka) ? 1 - fa : 0;
    let day = addDays(ka, 1);
    while (day < kb) {
      if (isBusinessDay(day)) total += 1;
      day = addDays(day, 1);
    }
    if (isBusinessDay(kb)) total += fb;
    return total;
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */

  const nfCache = {};
  function numberFormat(min, max) {
    const k = min + ':' + max;
    if (!nfCache[k]) nfCache[k] = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
    return nfCache[k];
  }
  let usdFormat = null;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  const fmt = {
    /** '1,204' or '0.23'. Null/NaN → '—'. */
    num(n, digits = 0) {
      if (!isNum(n)) return '—';
      return numberFormat(digits, digits).format(n);
    },
    /** 0.234 → '23%'. Null/NaN → '—'. */
    pct(p01, digits = 0) {
      if (!isNum(p01)) return '—';
      return numberFormat(digits, digits).format(p01 * 100) + '%';
    },
    /** 61.3 → '61 pts'. */
    pts(n, digits = 0) {
      if (!isNum(n)) return '—';
      return numberFormat(digits, digits).format(n) + ' pts';
    },
    /** Hours → '35m' | '5.2h' | '2.1d'. */
    hours(h) {
      if (!isNum(h)) return '—';
      const a = Math.abs(h);
      const sign = h < 0 ? '−' : '';
      if (a < 1) return sign + Math.round(a * 60) + 'm';
      if (a < 48) return sign + numberFormat(0, 1).format(a) + 'h';
      return sign + numberFormat(0, 1).format(a / 24) + 'd';
    },
    /**
     * Change of cur vs prev. Relative percent by default; absolute for unit 'pts'|'pct'|'score' (' pts') and 'hours'.
     * @returns {{text:string, sign:1|0|-1, abs:number|null, rel:number|null}}
     */
    delta(cur, prev, opts = {}) {
      if (!isNum(cur) || !isNum(prev)) return { text: '—', sign: 0, abs: null, rel: null };
      const abs = cur - prev;
      const rel = prev !== 0 ? abs / Math.abs(prev) : null;
      const sign = abs > 0 ? 1 : abs < 0 ? -1 : 0;
      const pre = sign > 0 ? '+' : sign < 0 ? '−' : '';
      const unit = opts.unit || 'relative';
      let text;
      if (unit === 'pts' || unit === 'pct' || unit === 'score') {
        text = pre + numberFormat(0, opts.digits ?? 0).format(Math.abs(abs)) + ' pts';
      } else if (unit === 'hours') {
        text = pre + fmt.hours(Math.abs(abs));
      } else if (rel === null) {
        text = pre + numberFormat(0, opts.digits ?? 0).format(Math.abs(abs));
      } else {
        text = pre + numberFormat(0, opts.digits ?? 0).format(Math.abs(rel) * 100) + '%';
      }
      return { text, sign, abs, rel };
    },
    /**
     * Human date. Accepts ISO instants and day/week/month keys.
     * @param {string} iso
     * @param {'day'|'week'|'month'|'datetime'} gran
     */
    date(iso, gran = 'day') {
      if (!iso) return '—';
      const s = String(iso);
      if (/^\d{4}-W\d{2}$/.test(s)) {
        const start = weekStart(s);
        return 'Week of ' + fmt.date(start, 'day');
      }
      if (/^\d{4}-\d{2}$/.test(s)) {
        const [y, m] = s.split('-').map(Number);
        return MONTH_LONG[m - 1] + ' ' + y;
      }
      const p = parts(s);
      if (!p) return '—';
      if (gran === 'month') return MONTH_LONG[p.m - 1] + ' ' + p.y;
      if (gran === 'week') return 'Week of ' + fmt.date(weekStart(weekKey(s)), 'day');
      const day = MONTH_SHORT[p.m - 1] + ' ' + p.d + ', ' + p.y;
      if (gran === 'datetime') return day + ', ' + pad2(p.hour) + ':' + pad2(p.minute) + ' CT';
      return day;
    },
    /** 'Aug 18 – Sep 16, 2026' or 'Sep 15, 2025 – Sep 16, 2026'. */
    range(fromIso, toIso) {
      const a = parts(fromIso), b = parts(toIso);
      if (!a || !b) return '—';
      const left = MONTH_SHORT[a.m - 1] + ' ' + a.d + (a.y === b.y ? '' : ', ' + a.y);
      const right = MONTH_SHORT[b.m - 1] + ' ' + b.d + ', ' + b.y;
      return left + ' – ' + right;
    },
    /** Integer with thousands separators. */
    int(n) {
      if (!isNum(n)) return '—';
      return numberFormat(0, 0).format(Math.round(n));
    },
    /** '$1,235'. */
    usd(n) {
      if (!isNum(n)) return '—';
      if (!usdFormat) usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
      return usdFormat.format(n);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Statistics                                                          */
  /* ------------------------------------------------------------------ */

  function nums(a) { return (a || []).filter(isNum); }

  const stats = {
    sum(a) { return nums(a).reduce((s, x) => s + x, 0); },
    mean(a) { const v = nums(a); return v.length ? stats.sum(v) / v.length : null; },
    median(a) { return stats.percentile(a, 0.5); },
    /** Sample standard deviation (n − 1). Null when fewer than 2 values. */
    std(a) {
      const v = nums(a);
      if (v.length < 2) return null;
      const m = stats.mean(v);
      return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1));
    },
    /** Linear-interpolated percentile, p01 in [0,1]. Null when empty. */
    percentile(a, p01) {
      const v = nums(a).slice().sort((x, y) => x - y);
      if (!v.length) return null;
      const p = Math.min(1, Math.max(0, p01));
      const idx = (v.length - 1) * p;
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
    },
    quantiles(a, ps = [0.25, 0.5, 0.75]) { return ps.map((p) => stats.percentile(a, p)); },
    /**
     * Wilson score interval for a proportion k/n.
     * @returns {{lo:number|null, hi:number|null}}
     */
    wilson(k, n, z = 1.96) {
      if (!isNum(k) || !isNum(n) || n <= 0) return { lo: null, hi: null };
      const p = k / n, z2 = z * z;
      const denom = 1 + z2 / n;
      const centre = (p + z2 / (2 * n)) / denom;
      const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
      return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
    },
    /**
     * Exact-style Poisson interval for a count k (Byar's approximation to Garwood).
     * @returns {{lo:number, hi:number}}
     */
    poissonExact(k, z = 1.96) {
      if (!isNum(k) || k < 0) return { lo: null, hi: null };
      const lo = k === 0 ? 0 : k * Math.pow(1 - 1 / (9 * k) - z / (3 * Math.sqrt(k)), 3);
      const k1 = k + 1;
      const hi = k1 * Math.pow(1 - 1 / (9 * k1) + z / (3 * Math.sqrt(k1)), 3);
      return { lo: Math.max(0, lo), hi };
    }
  };

  /* ------------------------------------------------------------------ */
  /* PRNG                                                                */
  /* ------------------------------------------------------------------ */

  /** mulberry32: seed → () => [0,1). */
  function rng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randNormal(r, mu = 0, sd = 1) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function poisson(r, lambda) {
    if (!isNum(lambda) || lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(randNormal(r, lambda, Math.sqrt(lambda))));
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k += 1; p *= r(); } while (p > L);
    return k - 1;
  }
  function weightedChoice(r, items, weights) {
    if (!items || !items.length) return undefined;
    const w = weights && weights.length === items.length ? weights : items.map(() => 1);
    const total = w.reduce((s, x) => s + Math.max(0, x), 0);
    if (total <= 0) return items[Math.floor(r() * items.length)];
    let x = r() * total;
    for (let i = 0; i < items.length; i++) {
      x -= Math.max(0, w[i]);
      if (x < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /* ------------------------------------------------------------------ */
  /* Hashing and identity                                                */
  /* ------------------------------------------------------------------ */

  function utf8Bytes(str) {
    const s = String(str);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i += 1; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  const FNV_OFFSET = BigInt('0xcbf29ce484222325');
  const FNV_PRIME = BigInt('0x100000001b3');
  const MASK64 = (BigInt(1) << BigInt(64)) - BigInt(1);
  /**
   * FNV-1a 64-bit hash of a UTF-8 string → 16 lowercase hex chars.
   * @param {string} str
   * @returns {string}
   */
  function fnv64(str) {
    let h = FNV_OFFSET;
    const bytes = utf8Bytes(str == null ? '' : str);
    for (let i = 0; i < bytes.length; i++) {
      h ^= BigInt(bytes[i]);
      h = (h * FNV_PRIME) & MASK64;
    }
    return h.toString(16).padStart(16, '0');
  }

  /** Lowercase, trim, strip +tag, remove dots in gmail local parts. Null/empty → null. */
  function normalizeEmail(e) {
    if (!e || typeof e !== 'string') return null;
    let s = e.trim().toLowerCase();
    const angle = /<([^>]+)>/.exec(s);
    if (angle) s = angle[1].trim();
    const at = s.lastIndexOf('@');
    if (at < 0) return s || null;
    let local = s.slice(0, at);
    const domain = s.slice(at + 1);
    const plus = local.indexOf('+');
    if (plus > 0) local = local.slice(0, plus);
    if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
    return local + '@' + domain;
  }

  const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const RE_PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
  const RE_ORDER = /(#\s?\d{5,7}\b|\b\d{3}-\d{7}-\d{7}\b|\bPP-\d{4,6}\b)/g;
  /** Mask emails, phone numbers and order numbers in free text. */
  function maskPii(text) {
    if (!text) return '';
    return String(text).replace(RE_EMAIL, '[email]').replace(RE_ORDER, '[order]').replace(RE_PHONE, '[phone]');
  }
  /**
   * Redacted copy of a record for restricted (PHI-adjacent) mail: sender, subject, body, order id and HCP code are
   * blanked; lot number, category, subcategory and product stay so registers and charts still count the record.
   */
  function redactRecord(rec) {
    if (!rec) return rec;
    const copy = Object.assign({}, rec);
    copy.from_name = 'Redacted';
    copy.from_email = null;
    copy.subject = '[restricted]';
    copy.text = '[restricted — open the queue to view]';
    copy.order_id = null;
    copy.hcp_code = null;
    copy.redacted = true;
    return copy;
  }

  /* ------------------------------------------------------------------ */
  /* Text                                                                */
  /* ------------------------------------------------------------------ */

  const RE_TOKEN = /[a-z0-9À-ɏ']+/g;
  /** Lowercase tokens of letters/digits/apostrophes, dropping tokens shorter than 2 chars. */
  function tokenize(text) {
    if (!text) return [];
    const m = String(text).toLowerCase().match(RE_TOKEN) || [];
    const out = [];
    for (let i = 0; i < m.length; i++) {
      const t = m[i].replace(/^'+|'+$/g, '');
      if (t.length >= 2) out.push(t);
    }
    return out;
  }
  /** Split text into sentences on . ! ? and line breaks. */
  function sentences(text) {
    if (!text) return [];
    const m = String(text).match(/[^.!?\n]+(?:[.!?]+|(?=\n)|$)/g) || [];
    return m.map((s) => s.trim()).filter((s) => s.length > 0);
  }

  /* ------------------------------------------------------------------ */
  /* Misc                                                                */
  /* ------------------------------------------------------------------ */

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, ctx = this;
      if (t !== null && typeof clearTimeout === 'function') clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(ctx, args); }, ms);
    };
  }
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
  }
  /**
   * Create a DOM element. Browser only; returns null under jsc.
   * @param {string} tag
   * @param {object} [attrs] className/class, style (object or string), dataset, on* handlers, other attributes
   * @param {Array|Node|string} [children]
   */
  function el(tag, attrs, children) {
    if (typeof document === 'undefined') return null;
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class' || k === 'className') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset' && typeof v === 'object') Object.keys(v).forEach((d) => { node.dataset[d] = v[d]; });
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      });
    }
    const list = Array.isArray(children) ? children : (children === undefined ? [] : [children]);
    list.forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }
  let uidCounter = 0;
  function uid(prefix = 'id') {
    uidCounter += 1;
    return prefix + '_' + Date.now().toString(36) + '_' + uidCounter.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function round(x, d = 0) {
    if (!isNum(x)) return null;
    const f = Math.pow(10, d);
    return Math.round(x * f) / f;
  }
  function groupBy(arr, keyFn) {
    const m = new Map();
    (arr || []).forEach((x) => {
      const k = typeof keyFn === 'function' ? keyFn(x) : x[keyFn];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    });
    return m;
  }
  function countBy(arr, keyFn) {
    const m = new Map();
    (arr || []).forEach((x) => {
      const k = typeof keyFn === 'function' ? keyFn(x) : x[keyFn];
      m.set(k, (m.get(k) || 0) + 1);
    });
    return m;
  }
  /** Stable sort copy; nulls last; dir 'asc'|'desc'. */
  function sortBy(arr, keyFn, dir = 'asc') {
    const sign = dir === 'desc' ? -1 : 1;
    const get = typeof keyFn === 'function' ? keyFn : (x) => x[keyFn];
    return (arr || []).map((x, i) => ({ x, i, k: get(x) })).sort((a, b) => {
      const an = a.k === null || a.k === undefined, bn = b.k === null || b.k === undefined;
      if (an && bn) return a.i - b.i;
      if (an) return 1;
      if (bn) return -1;
      if (a.k < b.k) return -sign;
      if (a.k > b.k) return sign;
      return a.i - b.i;
    }).map((o) => o.x);
  }
  /** Deep copy of JSON-safe data. */
  function clone(obj) {
    return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
  }

  VOC.enums = enums;
  VOC.util = {
    enums, fmt, stats,
    tz: TZ, HOUR_MS, DAY_MS,
    parts, dayKey, weekKey, monthKey, weekStart, addDays, daysBetween, isoDate, startOfDayCT, endOfDayCT, daysInMonth, addMonths, toDate,
    US_HOLIDAYS, isBusinessDay, addBusinessDays, businessDaysBetween,
    rng, randNormal, poisson, weightedChoice,
    fnv64, normalizeEmail, maskPii, redactRecord,
    tokenize, sentences,
    debounce, escapeHtml, el, uid, clamp, round, groupBy, countBy, sortBy, clone, isNum
  };
})();
