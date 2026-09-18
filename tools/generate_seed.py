#!/usr/bin/env python3
"""Deterministic seed generator for the L-Nutra Voice of the Customer site.

Implements docs/SPEC.md section 6. Python 3.9, stdlib only.
Writes js/data.js as `window.VOC_SEED = <compact json>;`.

Run:  python3 tools/generate_seed.py            (writes js/data.js, prints sanity stats)
      python3 tools/generate_seed.py --dry-run  (stats only)
"""
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

SEED = 20260917
SCHEMA_VERSION = 1
GENERATED = '2026-09-17'
AS_OF_UTC = datetime(2026, 9, 16, 23, 59, 0)
RANGE_FROM = date(2025, 9, 15)
RANGE_TO = date(2026, 9, 16)
TIMEZONE = 'America/Chicago'
AGENTS = ['Maya R.', 'Devon K.', 'Priya S.', 'Jordan T.']
TARGET_RECORDS = (1000, 1060)
TARGET_MID = 1032
N_CUSTOMERS = 640
N_PRACTICES = 18
LOT_E6 = 'NG-0426-B'
LOT_RFR = 'NG-0826-C'   # one fresh foreign-material report inside the 24h Reportable Food Registry window
REG_OPEN_DAYS = 14      # open serious-AE / food-safety records exist only inside this window before as_of
# Backlog realism (SPEC section 6): open-state records live inside OPEN_MAX_DAYS of as_of, concentrated in the last 21 days;
# everything older is resolved, except at most AGING_MAX deliberately aging tickets inside AGING_WINDOW_DAYS so the
# "Aging > 48h" tile and the SLA alert carry a small, believable tail. validate() holds the seed to these targets.
OPEN_MAX_DAYS = 45
AGING_MAX = 3
AGING_WINDOW_DAYS = (45, 60)
BACKLOG_TARGET = (40, 70)       # open-state records (new/open/pending/reopened/escalated), noise excluded
SLA_BREACH_TARGET = (8, 25)     # open-state, no first response, age > SLA_HOURS[urgency]
SLA_HOURS = {'P0': 1, 'P1': 4, 'P2': 24, 'P3': 72}   # mirrors Settings.sla defaults (SPEC section 4.5)
BAND_MIX_TARGET = {'positive': (0.54, 0.66), 'negative': (0.22, 0.34)}   # English live records, SPEC section 6 (60/12/28)
NPS_TARGET = (25, 55)                                                    # 12-month NPS over every scored record

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_PATH = os.path.join(ROOT, 'js', 'data.js')

# ---------------------------------------------------------------------------
# Enums (mirror SPEC section 3 exactly)
# ---------------------------------------------------------------------------
PRODUCTS = ['prolon_5day', 'prolon_nextgen', 'prolon_reset', 'prolon_52', 'fast_bar', 'fasting_shake', 'l_protein',
            'l_pill', 'starter_pack', 'guided_health', 'lnutra_health', 'subscription_account', 'general']
PRODUCT_LABEL = {
    'prolon_5day': 'ProLon 5-Day', 'prolon_nextgen': 'ProLon Next Gen', 'prolon_reset': 'ProLon 1-Day Reset',
    'prolon_52': 'ProLon 5:2', 'fast_bar': 'Fast Bar', 'fasting_shake': 'Fasting Shake', 'l_protein': 'L-Protein',
    'l_pill': 'L-Pill', 'starter_pack': 'Longevity Starter Pack', 'guided_health': 'Guided Health Program',
    'lnutra_health': 'L-Nutra Health', 'subscription_account': 'Subscription & Account', 'general': 'General'}
PRODUCT_CLASS = {
    'prolon_5day': 'conventional_food', 'prolon_nextgen': 'conventional_food', 'prolon_reset': 'conventional_food',
    'prolon_52': 'conventional_food', 'fast_bar': 'conventional_food', 'fasting_shake': 'conventional_food',
    'l_protein': 'conventional_food', 'starter_pack': 'conventional_food', 'l_pill': 'supplement',
    'guided_health': 'program', 'lnutra_health': 'program', 'subscription_account': 'none', 'general': 'none'}
KIT_COMPONENTS = ['soup_tomato', 'soup_vegetable', 'soup_minestrone', 'soup_minestrone_quinoa', 'soup_artichoke',
                  'soup_broccoli_quinoa', 'soup_mushroom', 'l_bar', 'choco_crisp', 'olives', 'kale_crackers',
                  'l_drink', 'nr1', 'algal_oil', 'tea']
COMPONENT_LABEL = {
    'soup_tomato': 'tomato soup', 'soup_vegetable': 'vegetable soup', 'soup_minestrone': 'minestrone soup',
    'soup_minestrone_quinoa': 'minestrone quinoa soup', 'soup_artichoke': 'artichoke soup',
    'soup_broccoli_quinoa': 'broccoli quinoa soup', 'soup_mushroom': 'mushroom soup', 'l_bar': 'L-Bar',
    'choco_crisp': 'choco crisp bar', 'olives': 'olives', 'kale_crackers': 'kale crackers', 'l_drink': 'L-Drink',
    'nr1': 'NR-1', 'algal_oil': 'algal oil', 'tea': 'herbal tea'}
SOUPS = ['soup_tomato', 'soup_vegetable', 'soup_minestrone', 'soup_minestrone_quinoa', 'soup_artichoke',
         'soup_broccoli_quinoa', 'soup_mushroom']
CATEGORIES = ['subscription_billing', 'checkout_website', 'shipping_fulfillment', 'missing_damaged', 'taste_quality',
              'foreign_material_allergen', 'side_effects', 'adverse_event', 'efficacy_results', 'price_value',
              'customer_service', 'hcp_practitioner', 'marketing_email', 'usage_guidance', 'product_request',
              'praise', 'other_noise']
SUBCATEGORIES = {
    'subscription_billing': ['unauthorized_signup', 'auto_renew_surprise', 'cancel_friction', 'post_cancel_shipment',
                             'duplicate_charge', 'refund_status', 'promo_not_applied', 'discount_math', 'pause_skip'],
    'checkout_website': ['checkout_error', 'mobile_checkout', 'unwanted_addon', 'promo_code', 'hcp_code_entry',
                         'login_account', 'app_bug'],
    'shipping_fulfillment': ['late', 'lost', 'tracking', 'porch_drop', 'heat_damage', 'international_customs'],
    'missing_damaged': ['missing_item', 'welcome_kit_missing', 'leaking', 'crushed_melted', 'damaged_seal'],
    'taste_quality': ['soup_taste', 'texture', 'l_drink_taste', 'olives', 'bar_taste', 'portion', 'expiry_short_dated'],
    'foreign_material_allergen': ['hard_bits', 'shell_fragment', 'allergen_exposure', 'mold_spoilage',
                                  'undeclared_allergen'],
    'side_effects': ['hunger', 'headache', 'fatigue', 'dizziness', 'brain_fog', 'nausea_gi', 'cold', 'sleep',
                     'inulin_ibs'],
    'adverse_event': ['fainting', 'er_hospital', 'allergic_reaction', 'hypoglycemia_medication', 'pregnancy_minor',
                      'chest_pain'],
    'efficacy_results': ['weight_loss', 'no_results', 'regain', 'energy_clarity', 'labs_biomarkers'],
    'price_value': ['too_expensive', 'per_day_cost', 'hsa_fsa', 'bundle_value', 'price_increase'],
    'customer_service': ['no_response', 'slow_response', 'wrong_item_sent', 'great_agent', 'chatbot_loop'],
    'hcp_practitioner': ['account_setup', 'bulk_order', 'patient_protocol', 'evidence_request'],
    'marketing_email': ['too_many_emails', 'influencer_skepticism', 'misleading_claim'],
    'usage_guidance': ['coffee_exercise', 'medications', 'refeed_transition', 'cycle_frequency', 'general_question'],
    'product_request': ['new_flavor', 'allergen_free', 'sample_pack', 'longer_program'],
    'praise': ['results_praise', 'convenience', 'cs_praise', 'nextgen_taste', 'general_praise'],
    'other_noise': ['auto_reply', 'bounce', 'newsletter', 'duplicate'],
}
CHANNELS = ['email', 'amazon_review', 'trustpilot_review', 'survey', 'chat', 'social', 'phone_note', 'hcp_portal']
SALES_CHANNELS = ['dtc_web', 'amazon', 'hcp', 'lnutra_health', 'employer', 'social_affiliate', 'international']
SEGMENTS = ['first_time', 'repeat', 'subscriber', 'hcp', 'hcp_patient', 'lnh_patient', 'employer', 'wholesale']
REGIONS = ['US', 'CA', 'UK', 'EU', 'DE', 'IT', 'AU', 'AE', 'OTHER']
STATUSES = ['new', 'open', 'pending', 'resolved', 'reopened', 'escalated', 'closed_noise']
URGENCIES = ['P0', 'P1', 'P2', 'P3']
ESCALATION_TARGETS = ['none', 'quality_regulatory', 'finance', 'cs_lead', 'legal', 'medical']
AE_CRITERIA = ['death', 'life_threatening', 'hospitalization', 'disability', 'birth_defect', 'intervention']
CONTRA_FLAGS = ['pregnancy', 'minor', 'glucose_meds', 'nut_soy_allergy', 'bmi_low', 'serious_disease']
LANGUAGES = ['en', 'other', 'unknown']
SENTIMENT_LABELS = ['positive', 'neutral', 'negative', 'unscored']
NOISE_REASONS = ['auto_reply', 'bounce', 'newsletter', 'duplicate']
PRACTICE_TYPES = ['physician', 'np', 'chiropractor', 'rd', 'health_coach', 'weight_loss_center', 'fitness_studio']
SUB_STATUSES = ['none', 'active', 'paused', 'cancelled']

KIT = {'prolon_5day', 'prolon_nextgen', 'prolon_reset', 'prolon_52'}
# Generic item word used in the {component} slot when a product has no kit component.
ITEM_WORD = {'fast_bar': 'bar', 'fasting_shake': 'shake', 'l_protein': 'protein powder', 'l_pill': 'capsule', 'starter_pack': 'sample',
             'guided_health': 'program', 'lnutra_health': 'program', 'subscription_account': 'shipment', 'general': 'kit'}
REGION_NAMES = {'US': ['Texas', 'Ohio', 'Arizona', 'Florida', 'Oregon', 'Colorado', 'Georgia', 'Michigan', 'Virginia', 'Minnesota'],
                'CA': ['Ontario', 'Alberta', 'BC'], 'UK': ['Leeds', 'Bristol', 'Manchester'], 'EU': ['Amsterdam', 'Lyon', 'Madrid'],
                'DE': ['Hamburg', 'Munich'], 'IT': ['Milan', 'Turin'], 'AU': ['Perth', 'Brisbane'], 'AE': ['Dubai'], 'OTHER': ['abroad']}
START_DAYS = ['Monday', 'Sunday', 'next Monday', 'the 1st', 'this weekend']
# Inbound customer mail carries the sender provider's Message-ID host; only bounces come from L-Nutra's own server.
MSGID_HOSTS = {'gmail.com': 'mail.gmail.com', 'yahoo.com': 'sonic301.consmr.mail.ne1.yahoo.com', 'outlook.com': 'outlook.com',
               'hotmail.com': 'outlook.com', 'live.com': 'outlook.com', 'msn.com': 'outlook.com', 'icloud.com': 'p00-icloudmta.icloud.com',
               'me.com': 'p00-icloudmta.icloud.com', 'aol.com': 'sonic.aol.com', 'comcast.net': 'resomta.comcast.net',
               'protonmail.com': 'protonmail.com'}

# Natural product names used in the {product} slot (PRODUCT_LABEL is the display label; these read like a customer wrote them).
PRODUCT_SLOT = dict(PRODUCT_LABEL)
PRODUCT_SLOT['subscription_account'] = 'subscription box'
PRODUCT_SLOT['general'] = 'ProLon'
# Short alias appended to a subject when the body alone does not settle the product (rules.js weighs subject hits x1.5).
PRODUCT_SHORT = {
    'prolon_5day': 'ProLon 5-Day', 'prolon_nextgen': 'Next Gen', 'prolon_reset': '1-Day Reset', 'prolon_52': 'ProLon 5:2',
    'fast_bar': 'Fast Bar', 'fasting_shake': 'Fasting Shake', 'l_protein': 'L-Protein', 'l_pill': 'L-Pill',
    'starter_pack': 'Starter Pack', 'guided_health': 'Guided Health', 'lnutra_health': 'L-Nutra Health',
    'subscription_account': 'Subscription'}
# One-sentence product mentions prepended to the customer's first sentence (SPEC section 6: customers name what they bought).
# Words here carry no lexicon valence and hit no category pattern in rules.js.
MENTION_P = 0.45
MENTIONS = {
    'prolon_5day': ["This is about my ProLon 5-Day kit.", "I ordered the ProLon 5-Day.", "This was the 5-Day ProLon kit.",
                    "I did the ProLon 5-Day fasting mimicking kit.", "It was the classic 5-Day kit.", "My kit was the ProLon 5-Day, Original.",
                    "The 5-day box arrived last week.", "I am on my ProLon 5-Day.", "This is the 5-Day kit I got from Amazon.",
                    "We bought two ProLon 5-Day kits, one for each of us.", "For context, this is the 5-Day kit, not the Next Gen.",
                    "The kit in question is the ProLon 5-Day.", "I have done the 5-Day twice now.", "The original 5-Day ProLon is what I have."],
    'prolon_nextgen': ["This is about the Next Gen soups kit.", "I bought the ProLon Next Gen, the ready-to-eat version.",
                       "This was the Next Gen kit.", "My kit was the Next Gen.", "I went with the Next Gen this time.",
                       "It is the Next Gen box, the one with the ready-to-eat soups.", "I switched to Next Gen after the old kit.",
                       "The Next Gen kit arrived on Tuesday.", "This is my first Next Gen kit.", "Next Gen kit, Variety.",
                       "I am on the Next Gen version.", "We ordered the Next Gen for my husband and me.", "The ready-to-eat Next Gen is what I have."],
    'prolon_reset': ["This is about the 1-Day Reset.", "I ordered the ProLon 1-Day Reset.", "This was the one-day Reset.",
                     "I did the 1-Day Reset on Sunday.", "My order was the Reset, the one-day version.", "It is the 1-Day Reset box.",
                     "I use the Reset between full kits.", "I picked up the 1-Day Reset to try it out.", "The Reset is what I have."],
    'prolon_52': ["This is about the ProLon 5:2 plan.", "I am on the 5:2 program.", "I ordered the ProLon 5:2.",
                  "It is the 5:2 kit, the two-day one.", "I do the 5:2 every week now.", "The 5:2 plan is what I bought."],
    'fast_bar': ["This is about the Fast Bar box.", "I ordered a box of Fast Bars.", "The Fast Bars, {flavor}.",
                 "I keep Fast Bars in my desk.", "It is the Fast Bar, the intermittent fasting bar.", "My order was two boxes of Fast Bars.",
                 "I buy the Fast Bars on Amazon.", "Fast Bar box, Nut-Based.", "I eat a Fast Bar most mornings."],
    'fasting_shake': ["This is about the Fasting Shake.", "I ordered the Fasting Shake, {flavor}.", "The shake is what I bought.",
                      "It is the Fasting Shake, {flavor} flavor.", "I have the Fasting Shake on subscription.", "My order was the Fasting Shake.",
                      "The shake, {flavor}, from your site."],
    'l_protein': ["This is about the L-Protein powder.", "I ordered L-Protein, {flavor}.", "The L-Protein, {flavor}, is what I have.",
                  "It is the plant protein powder.", "L-Protein tub, {flavor}.", "I use the L-Protein after workouts."],
    'l_pill': ["This is about the L-Pill.", "I ordered the L-Pill.", "It is the L-Pill supplement.", "My order was a bottle of L-Pill.",
               "I take the L-Pill daily.", "The L-Pill bottle came Tuesday.", "This is the L-Pill, the NR-1 capsule."],
    'starter_pack': ["This is about the Longevity Starter Pack.", "I ordered the Starter Pack.", "It is the Longevity Starter Pack.",
                     "I bought the Starter Pack to try things out.", "The Starter Pack is what I have.", "Starter Pack, first order."],
    'guided_health': ["This is about the Guided Health program.", "I am enrolled in the Guided Health program.", "I am in Guided Health.",
                      "This is for the Guided Health program with the coach.", "The Guided Health program is what I signed up for.",
                      "I started Guided Health in the spring."],
    'lnutra_health': ["This is through the L-Nutra Health program.", "I am in the L-Nutra Health program.", "This is about L-Nutra Health.",
                      "I am an L-Nutra Health patient.", "This is for the L-Nutra Health program my doctor set up.", "My care team is L-Nutra Health."],
    'subscription_account': ["This is about my subscription.", "Regarding my subscription:", "This is about my subscription account.",
                             "It is about my Loop subscription.", "This concerns my monthly subscription.", "My subscription, not a single order."],
}
MENTIONS_NON_EN = {'de': "Produkt: {alias}.", 'it': "Prodotto: {alias}."}
SUBJECT_ALIAS_P = 0.7   # chance a record whose body does not settle the product names it in the subject
EMAIL_NPS_P = 0.08      # share of emails that carry an NPS score (survey follow-ups)

# Python port of rules.js productAliases / components and classify.detectProduct, used only to verify that the
# rendered text names the labelled product. Keep in step with js/rules.js when aliases change.
_ALIASES = [
    (re.compile(r"\bnext ?gen\b|\bready[- .]?to[- .]?eat\b|\bnextgen\b", re.I), 'prolon_nextgen', 3),
    (re.compile(r"\b5[- .]?day\b|\bfive[- ]day\b|\bfmd\b|\bfasting[- .]?mimicking\b|\bkit\b|\bprolon\b|\bpro ?lon\b", re.I), 'prolon_5day', 2),
    (re.compile(r"\breset\b|\b1[- .]?day\b|\bone[- .]day\b", re.I), 'prolon_reset', 3),
    (re.compile(r"\b5:2\b|\bfive[- .]two\b|\b5[- ]2 (plan|program|kit|prolon)\b", re.I), 'prolon_52', 3),
    (re.compile(r"\bfast(ing)?[- ]?bars?\b|\bintermittent fasting bars?\b", re.I), 'fast_bar', 3),
    (re.compile(r"\bshakes?\b|\bfasting shake\b", re.I), 'fasting_shake', 3),
    (re.compile(r"\bl[- .]?protein\b|\bprotein powder\b|\bplant protein\b", re.I), 'l_protein', 3),
    (re.compile(r"\bl[- .]?pills?\b|\bnr[- ]?1 (pill|supplement|capsule)s?\b", re.I), 'l_pill', 3),
    (re.compile(r"\bstarter[- ]pack\b|\blongevity starter\b", re.I), 'starter_pack', 3),
    (re.compile(r"\bguided( health)?\b|\bcoach(ing|es)?\b|\bdietitian\b|\bnutritionist\b", re.I), 'guided_health', 2),
    (re.compile(r"\bdiabetes remission\b|\ba1c\b|\bhba1c\b|\bmetabolic health program\b|\bmetformin\b|\bl[- ]?nutra health\b", re.I), 'lnutra_health', 2),
    (re.compile(r"\bsubscription\b|\bsubscribe[ds]?\b|\bauto[- .]?renew(al|ed)?\b|\bautoship\b|\bloop\b|\bmembership\b|\brecurring\b", re.I), 'subscription_account', 2),
]
_COMPONENT_RES = [re.compile(p, re.I) for p in (
    r"\bminestrone[- ]?(and |&|with |\+ )?quinoa\b|\bquinoa minestrone\b", r"\bbroccoli[- ]?(and |&|with |\+ )?quinoa\b|\bquinoa broccoli\b",
    r"\bminestrone\b", r"\btomato (soup|bisque)?\b", r"\bvegetable (soup|quinoa)?\b|\bveggie soup\b", r"\bartichoke\b", r"\bbroccoli\b",
    r"\bmushroom\b", r"\bl[- ]?drink\b|\bglycerol\b|\bglycerin\b", r"\bchoco[- ]?crisp\b|\bchocolate crisp\b|\bcrisp bar\b",
    r"\bl[- ]?bars?\b|\bnut[- ]based bars?\b|\bnut bars?\b", r"\bolives?\b", r"\bkale crackers?\b|\bcrackers?\b", r"\bnr[- ]?1\b",
    r"\balgal oil\b|\bomega[- ]3 (capsule|softgel|supplement)s?\b|\bdha\b", r"\b(herbal|spearmint|hibiscus|lemon spearmint) tea\b|\btea bags?\b|\bteas?\b")]
_NOT_PRODUCT = re.compile(
    r"\b(password|pass ?code|pin|link|email|account|timer|tracker|app|progress|streak|counter|browser|cache|phone|device|router|settings?) reset\b"
    r"|\breset (my |the |your )?(password|pass ?code|pin|link|email|account|timer|tracker|app|progress|streak|counter|browser|cache|phone|device|router|settings?)\b"
    r"|\bgold[- ]?bar\b|\bsalad bar\b|\bstatus bar\b|\bprogress bar\b|\bcandy bars?\b|\bprotein shake\b", re.I)
_KIT_LIKE = {'prolon_5day', 'prolon_nextgen', 'prolon_reset', 'prolon_52', 'starter_pack', 'general', 'subscription_account'}


def detect_product(text, subject):
    """Mirror of classify.detectProduct: alias weights, subject x1.5, subscription fallback, kit-component fallback."""
    t = _NOT_PRODUCT.sub(' ', text or '')
    subj = _NOT_PRODUCT.sub(' ', subject or '')
    scores = {}
    for rx, prod, w in _ALIASES:
        sc = 0.0
        if rx.search(t):
            sc += w
        if subj and rx.search(subj):
            sc += 1.5 * w
        if sc > 0:
            scores[prod] = scores.get(prod, 0.0) + sc
    best, bv = 'general', 0.0
    for p in PRODUCTS:
        if p in ('subscription_account', 'general'):
            continue
        v = scores.get(p, 0.0)
        if v > bv:
            best, bv = p, v
    if bv < 2 and scores.get('subscription_account'):
        best = 'subscription_account'
    if best in _KIT_LIKE and best == 'general':
        for rx in _COMPONENT_RES:
            if rx.search(t) or (subj and rx.search(subj)):
                best = 'prolon_5day'
                break
    return best
FOOD = KIT | {'fast_bar', 'fasting_shake', 'l_protein', 'starter_pack'}
ANY = set(PRODUCTS)
CONSUMER = {'prolon_5day', 'prolon_nextgen', 'prolon_reset', 'prolon_52', 'fast_bar', 'fasting_shake', 'l_protein',
            'l_pill', 'starter_pack'}
PRICE = {'prolon_5day': 199, 'prolon_nextgen': 210, 'prolon_reset': 45, 'prolon_52': 149, 'fast_bar': 40,
         'fasting_shake': 45, 'l_protein': 50, 'l_pill': 35, 'starter_pack': 89, 'guided_health': 149,
         'lnutra_health': 299, 'subscription_account': 199, 'general': 199}
VARIANTS = {
    'prolon_5day': ['Original', 'Soup Variety', 'Original'],
    'prolon_nextgen': ['Ready-to-eat', 'Ready-to-eat', 'Variety'],
    'fast_bar': ['Nut-Based', 'Choco Crisp', 'Nut-Based'],
    'fasting_shake': ['Vanilla', 'Chocolate'],
    'l_protein': ['Vanilla', 'Chocolate'],
}

# Which products may carry a given subcategory (None = any product).
SUB_PRODUCTS = {
    'soup_taste': KIT, 'texture': KIT | {'fast_bar', 'fasting_shake', 'l_protein'}, 'l_drink_taste': KIT,
    'olives': KIT, 'bar_taste': KIT | {'fast_bar'}, 'portion': KIT | {'fast_bar'}, 'expiry_short_dated': FOOD,
    'hard_bits': KIT | {'fast_bar'}, 'shell_fragment': KIT | {'fast_bar'}, 'allergen_exposure': FOOD,
    'mold_spoilage': KIT | {'fast_bar'}, 'undeclared_allergen': FOOD,
    'missing_item': FOOD, 'welcome_kit_missing': KIT, 'leaking': KIT, 'crushed_melted': KIT | {'fast_bar'},
    'damaged_seal': FOOD | {'l_pill'},
    'hunger': KIT, 'headache': KIT | {'l_pill'}, 'fatigue': KIT, 'dizziness': KIT, 'brain_fog': KIT,
    'nausea_gi': KIT | {'l_pill', 'fasting_shake'}, 'cold': KIT, 'sleep': KIT | {'l_pill'},
    'inulin_ibs': KIT | {'fast_bar', 'fasting_shake', 'l_protein'},
    'heat_damage': KIT | {'fast_bar'},
    'weight_loss': KIT | {'guided_health', 'lnutra_health'}, 'no_results': KIT | {'l_pill', 'guided_health'},
    'regain': KIT | {'guided_health'}, 'energy_clarity': KIT | {'fast_bar', 'l_pill'},
    'labs_biomarkers': KIT | {'lnutra_health', 'guided_health'},
    'nextgen_taste': {'prolon_nextgen'}, 'convenience': {'prolon_nextgen', 'fast_bar', 'fasting_shake', 'prolon_reset'},
    'results_praise': KIT | {'guided_health', 'lnutra_health'},
    'coffee_exercise': KIT, 'refeed_transition': KIT, 'cycle_frequency': KIT | {'guided_health'},
    'medications': KIT | {'l_pill', 'lnutra_health'}, 'general_question': KIT | {'fast_bar', 'l_pill', 'guided_health'},
    'new_flavor': FOOD, 'allergen_free': FOOD, 'sample_pack': KIT | {'starter_pack'},
    'unwanted_addon': CONSUMER, 'promo_code': CONSUMER | {'starter_pack'},
    'app_bug': KIT | {'guided_health', 'general', 'subscription_account'}, 'longer_program': {'prolon_5day', 'prolon_nextgen'},
    'fainting': {'prolon_5day', 'prolon_nextgen'}, 'er_hospital': {'prolon_5day', 'prolon_nextgen'}, 'chest_pain': {'prolon_5day', 'prolon_nextgen'},
    'hypoglycemia_medication': {'prolon_5day', 'prolon_nextgen'}, 'allergic_reaction': {'prolon_5day', 'prolon_nextgen', 'fast_bar'},
    'wrong_item_sent': FOOD,
    'per_day_cost': KIT, 'bundle_value': KIT | {'starter_pack', 'fast_bar'},
}

# ---------------------------------------------------------------------------
# Time helpers (America/Chicago without tzdata)
# ---------------------------------------------------------------------------
def _dst_bounds(year):
    d = date(year, 3, 1)
    second_sun_mar = d + timedelta((6 - d.weekday()) % 7) + timedelta(7)
    n = date(year, 11, 1)
    first_sun_nov = n + timedelta((6 - n.weekday()) % 7)
    return second_sun_mar, first_sun_nov


def ct_to_utc(local_dt):
    start, end = _dst_bounds(local_dt.year)
    in_dst = datetime(start.year, start.month, start.day, 2) <= local_dt < datetime(end.year, end.month, end.day, 2)
    return local_dt + timedelta(hours=5 if in_dst else 6)


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def week_key(d):
    y, w, _ = d.isocalendar()
    return '%d-W%02d' % (y, w)


US_HOLIDAYS = {
    date(2025, 9, 1), date(2025, 10, 13), date(2025, 11, 11), date(2025, 11, 27), date(2025, 12, 25),
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 5, 25), date(2026, 6, 19), date(2026, 7, 3),
    date(2026, 9, 7),
}


def is_business_day(d):
    return d.weekday() < 5 and d not in US_HOLIDAYS


def daterange(a, b):
    d = a
    while d <= b:
        yield d
        d += timedelta(1)


# ---------------------------------------------------------------------------
# RNG helpers
# ---------------------------------------------------------------------------
class R:
    def __init__(self, seed):
        self.r = random.Random(seed)

    def u(self, a=0.0, b=1.0):
        return self.r.uniform(a, b)

    def i(self, a, b):
        return self.r.randint(a, b)

    def p(self, prob):
        return self.r.random() < prob

    def pick(self, seq):
        return self.r.choice(seq)

    def w(self, table):
        """Weighted pick from a dict {item: weight} or list of (item, weight)."""
        items = list(table.items()) if isinstance(table, dict) else list(table)
        total = sum(w for _, w in items)
        x = self.r.random() * total
        acc = 0.0
        for item, w in items:
            acc += w
            if x < acc:
                return item
        return items[-1][0]

    def hexs(self, n):
        return ''.join(self.r.choice('0123456789abcdef') for _ in range(n))

    def poisson(self, lam):
        if lam <= 0:
            return 0
        if lam > 30:
            return max(0, int(round(self.r.gauss(lam, lam ** 0.5))))
        L = 2.718281828459045 ** (-lam)
        k, p = 0, 1.0
        while True:
            p *= self.r.random()
            if p <= L:
                return k
            k += 1

    def lognormal_hours(self, median, sigma):
        return median * 2.718281828459045 ** self.r.gauss(0, sigma)

    def shuffle(self, seq):
        self.r.shuffle(seq)
        return seq


# ---------------------------------------------------------------------------
# Name pools
# ---------------------------------------------------------------------------
FIRST_EN = ['Sarah', 'Michael', 'Jennifer', 'David', 'Lisa', 'Karen', 'James', 'Emily', 'Robert', 'Amanda', 'Jessica',
            'Daniel', 'Michelle', 'Brian', 'Laura', 'Kevin', 'Stephanie', 'Mark', 'Nicole', 'Ryan', 'Rachel', 'Jason',
            'Heather', 'Andrew', 'Melissa', 'Chris', 'Angela', 'Matthew', 'Rebecca', 'Joshua', 'Kimberly', 'Eric',
            'Christina', 'Patricia', 'Tom', 'Deborah', 'Susan', 'Greg', 'Tina', 'Paul', 'Diane', 'Steven', 'Linda',
            'Nancy', 'Carol', 'Aisha', 'Priyanka', 'Wei', 'Carlos', 'Maria', 'Elena', 'Olivia', 'Sophie', 'Liam',
            'Noah', 'Grace', 'Hannah', 'Ethan', 'Zoe', 'Ben', 'Megan', 'Dana', 'Leslie', 'Renee', 'Tanya']
LAST_EN = ['Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Garcia', 'Rodriguez', 'Wilson', 'Martinez',
           'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris',
           'Clark', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Green', 'Baker',
           'Adams', 'Nelson', 'Hill', 'Campbell', 'Mitchell', 'Roberts', 'Carter', 'Phillips', 'Evans', 'Turner',
           'Parker', 'Collins', 'Edwards', 'Stewart', 'Morris', 'Nguyen', 'Patel', 'Kim', 'Chen', 'Singh', 'Cohen',
           'O\'Brien', 'Murphy', 'Reyes', 'Foster', 'Hughes', 'Ross', 'Bennett', 'Cole']
FIRST_DE = ['Anna', 'Lukas', 'Katharina', 'Jonas', 'Julia', 'Felix', 'Sabine', 'Markus', 'Petra', 'Stefan']
LAST_DE = ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Hoffmann', 'Koch']
FIRST_IT = ['Giulia', 'Marco', 'Francesca', 'Luca', 'Chiara', 'Alessandro', 'Sara', 'Matteo', 'Elisa', 'Davide']
LAST_IT = ['Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco']
FIRST_AE = ['Fatima', 'Omar', 'Layla', 'Khalid', 'Noor', 'Yusuf', 'Hana', 'Tariq']
LAST_AE = ['Al Mansoori', 'Haddad', 'Khan', 'Rahman', 'Al Suwaidi', 'Nasser', 'Farouk', 'Saleh']
DOMAINS = [('gmail.com', 46), ('yahoo.com', 14), ('outlook.com', 10), ('icloud.com', 10), ('hotmail.com', 6),
           ('aol.com', 3), ('comcast.net', 3), ('me.com', 2), ('protonmail.com', 2), ('live.com', 2), ('msn.com', 2)]
PRACTICE_NAMES = [
    ('Lakeside Family Medicine', 'physician', 'US'), ('Dr. Patel Internal Medicine', 'physician', 'US'),
    ('Summit Metabolic Health', 'physician', 'US'), ('Riverbend Wellness NP', 'np', 'US'),
    ('Clearview Nurse Practitioners', 'np', 'US'), ('Align Chiropractic & Wellness', 'chiropractor', 'US'),
    ('Spine & Vitality Chiropractic', 'chiropractor', 'US'), ('Nourish Nutrition Group', 'rd', 'US'),
    ('Balanced Plate Dietitians', 'rd', 'CA'), ('Thrive Health Coaching', 'health_coach', 'US'),
    ('Momentum Coaching Collective', 'health_coach', 'UK'), ('Slim & Strong Weight Loss Center', 'weight_loss_center', 'US'),
    ('Metro Medical Weight Loss', 'weight_loss_center', 'US'), ('Ironworks Fitness Studio', 'fitness_studio', 'US'),
    ('Pulse Performance Studio', 'fitness_studio', 'AU'), ('Harborview Longevity Clinic', 'physician', 'US'),
    ('Northgate Functional Medicine', 'physician', 'CA'), ('Greenway Integrative Health', 'np', 'US'),
]
CANCEL_REASONS = ['too expensive', 'billing dispute', 'did not see results', 'too many boxes on hand',
                  'side effects', 'switched to practitioner', 'moving abroad', 'taste']

# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------
P, N, G = 'positive', 'neutral', 'negative'

OPENERS = {
    P: ["Hi team,", "Hello,", "Hi there,", "Good morning,", "Just wanted to say thank you.",
        "I rarely write reviews but I had to share this.", "Quick note from a happy customer.",
        "Hi ProLon team,", "Hello from a {cycle_n}-time customer.", "I finished my kit yesterday and wanted to write in.",
        "Hi all,", "Good afternoon,", "Hey there,", "Hello ProLon,", "Morning!", "Hi, quick note.",
        "I do not usually write to companies, but here goes.", "Sharing some feedback while it is fresh.",
        "Hi, longtime customer here.", "Hello, I wanted to pass this along.", "Writing in with a bit of good news.",
        "Hi, just back from a trip and catching up on email.", "Hi, my wife suggested I write this.", "Hi, one happy customer checking in.",
        "Hi, following up after my last order.", "Hello, a note for whoever reads these.", "Hi, no complaints, just feedback.",
        "Hi ProLon, my second note this year.", "Hello, feedback from {first_name} in {region_name}.", "Hi, this is going to be a nice email for once."],
    N: ["Hi,", "Hello,", "Quick question.", "Hi there,", "Afternoon,", "Hi team, I have a question.",
        "Hello ProLon,", "Hi, first time doing this.", "Hi, I am on day {day} and had a question.",
        "Hello, I ordered {product} last week.", "Hi, hoping you can clarify something.", "Hello, small question before I start.",
        "Hi, a quick one.", "Good morning, question for the team.", "Hi, not sure who to ask.", "Hello, checking on something.",
        "Hi, I looked through the FAQ and could not find this.", "Hi, planning my next round and wondering about a detail.",
        "Hello, my box arrived today and I have a question.", "Hi, question from a first-timer.", "Hi, two quick things.",
        "Hey, hope this is the right address.", "Hello, before I place another order:", "Hi, could use some guidance.",
        "Good afternoon, quick check.", "Hi, I could not reach anyone on chat, so email it is.", "Hello, a practical question.",
        "Hi, starting {start_day} and want to get this right.", "Hello from {region_name}, quick question."],
    G: ["Hi, I am disappointed.", "Hello, this is frustrating.", "I am writing about order {order_id} and I am upset.",
        "This is the second time I am reaching out and I am annoyed.", "I am extremely disappointed.",
        "I have a problem and it is frustrating.", "To whom it may concern, this is unacceptable.",
        "I am frustrated and I want this fixed.", "Hello, I have a serious problem with my order.",
        "I have been a customer for a while and this is not okay.", "Hi, not a happy email.", "Hello, I need this sorted out.",
        "Hi, I have been patient but this is getting ridiculous.", "Writing again because nothing has changed.",
        "Hi, I did not expect to have to write this.", "Hello, order {order_id} has been a mess.", "Hi, this has been a poor experience.",
        "I am really annoyed and I want someone to look at this.", "Hello, I am upset about how this was handled.",
        "Hi, I have given this a fair chance and I am done being patient.", "Hello ProLon, this one is a complaint.",
        "Hi, this is disappointing for a product at this price.", "I am writing because chat could not help.",
        "Hello, this needs attention today.", "Hi, I am angry about this and I want it on record.", "Hi, not what I expected from you.",
        "Hi, I have tried to be understanding but this is too much.", "Hello, this is the third problem in a row.", "Hi, I would like an explanation."],
}
CLOSERS = {
    P: ["Thank you again!", "Keep doing what you are doing.", "Highly recommend.", "Grateful for this product.",
        "Thanks for reading!", "You have a customer for life.", "Already recommended it to my sister.",
        "Thank you, {agent}, and the whole team.", "Five stars from me.", "Looking forward to my next cycle.",
        "Thanks for making something that works.", "Keep it up.", "Pass this along to the team, please.", "Really pleased overall.",
        "That is all, just wanted you to know.", "Thanks again from {region_name}.", "Will be back for more.",
        "Genuinely grateful.", "No notes, just thanks.", "Happy customer here.", "Telling my coworkers about it.",
        "Cheers to the team.", "So glad I tried it.", "Thank you for the good work.", "Big thumbs up.",
        "Sending this to my brother next.", "Thanks, {agent}, if you are reading this.", "Two thumbs up.", "A very satisfied customer."],
    N: ["Let me know.", "Waiting for your reply.", "My order number is {order_id} if that matters.",
        "Reply by email is fine.", "I am on day {day} now.", "Let me know what you need from me.",
        "Just checking before my next cycle.", "Curious what the guidance is.", "That is my only question.",
        "Details above.", "Any pointers welcome.", "No rush, whenever you get to it.",
        "I can send more details.", "Let me know either way.", "A quick reply would help.",
        "That is it from me.", "Sorry if this is in the FAQ.", "Feel free to call if easier: {phone}.",
        "Let me know what you find.", "Order {order_id} for reference.", "Over to you."],
    G: ["Fix this, it is unacceptable.", "I expect a reply within 48 hours. Very frustrating.", "This needs to be resolved today.",
        "Very disappointed.", "I would like someone to actually read this and respond. Frustrating.",
        "Make this right, I am upset.", "I am not happy with how this has gone.", "Someone needs to look into this mess.",
        "I have screenshots and photos of this disaster if you need them.", "Terrible experience. Waiting to hear back before I decide what to do next.",
        "Please sort this out.", "I want a real answer, not a template.", "Order {order_id}, please look it up.",
        "Disappointing, honestly.", "I expected better.", "Let me know how you plan to fix it.", "Not impressed.",
        "Waiting on you.", "I have photos if that helps.", "This has soured me on the whole thing.",
        "Call me if that is faster: {phone}.", "Please escalate this.", "I need this resolved before my next charge.",
        "Frankly, I am annoyed.", "Do better.", "I hope this reaches a human.", "A refund or a replacement, your choice, but soon.",
        "Not okay.", "Let me know today, please."],
}
# Email framing is optional: real mail often starts with the problem and ends with a signoff.
OPENER_P = 0.65
CLOSER_P = 0.55
SIGNOFFS = ["Thanks,\n{first_name}", "Best,\n{first_name}", "Regards,\n{first_name} {last_name}", "{first_name}",
            "Sincerely,\n{first_name} {last_name}", "Thank you,\n{first_name}", "Cheers,\n{first_name}", "- {first_name}",
            "Kind regards,\n{first_name} {last_name}", "{first_name} {last_name}"]

# CORES[subcategory][band] = list of sentences. A band absent from a subcategory means that band is not drawn.
# render() filters cores by product (core_fits): multi-day and kit-only lines never land on a bar, shake, pill or the
# 1-Day Reset, and "powder" lines never land on the ready-to-eat Next Gen. Every (sub, band, product) allowed by
# SUB_PRODUCTS keeps at least one fitting core; check_templates() asserts it at start-up.
CORES = {
    # subscription_billing
    'unauthorized_signup': {G: [
        "I never agreed to a subscription. I bought one box of {product} and somehow got signed up without permission for monthly shipments.",
        "Somebody signed me up for auto-ship without my consent. I did not check any box for a subscription and now there is a {amount} charge on my card.",
        "This is an unauthorized subscription. I ordered once, I did not sign up for recurring orders, and I want it reversed.",
        "I was signed up without permission. One purchase of {product} turned into a subscription I never asked for.",
        "I made a one-time purchase and you enrolled me in a subscription without my knowledge. Reverse the {amount} charge."]},
    'auto_renew_surprise': {G: [
        "I did not realize this was a subscription. My card was just charged {amount} for a renewal I never asked for and I do not need another {product} right now. Frustrating and sneaky.",
        "Surprise charge this morning: the subscription auto-renewed for order {order_id} with zero warning email. Annoying and unacceptable.",
        "Auto-renew kicked in and charged me {amount} the day before I was going to cancel. Nobody told me it renews automatically. I am upset.",
        "The auto-renewal is sneaky and dishonest. No reminder, no heads up, just a {amount} charge and a box I did not want.",
        "My Subscribe & Save renewed without a reminder and charged {amount}. I still have two unopened boxes. Not okay."],
        N: ["Can you confirm when my subscription renews next and whether I get a reminder email before the charge?",
            "Is there a way to see the renewal date for my {product} subscription in the account page?",
            "Does the Loop subscription send a reminder before it auto-renews, or does it just charge the card?"]},
    'cancel_friction': {G: [
        "There is no cancellation link anywhere in my account. I have clicked every page and there is no way to cancel my subscription.",
        "Trying to cancel my subscription for a week now. The chat bot loops me back to the FAQ and there is no cancel button.",
        "Cancel my subscription immediately. It should not take an email to a human to stop shipments. Frustrating.",
        "Cancelling is deliberately hard. No cancellation link, no button, phone line closed. Cancel my {product} shipments now.",
        "I want to cancel my Subscribe & Save and the manage page only offers pause. Unable to cancel, please do it for me."],
        N: ["How do I cancel my subscription before the next shipment? I could not find the option in the app.",
            "Where is the cancel option in the Loop portal? I only see skip and change date."]},
    'post_cancel_shipment': {G: [
        "I cancelled my subscription on the phone two weeks ago and another box arrived today with a {amount} charge. Order {order_id}.",
        "I cancelled, got the confirmation, and you still shipped and charged me. Why was a box sent after I cancelled?",
        "Another {product} arrived after I cancelled. I have the cancellation email dated three weeks ago.",
        "Cancelled in August, charged in September. The box shipped anyway and I want a return label for it."]},
    'duplicate_charge': {G: [
        "I was charged twice for order {order_id}. Two identical charges of {amount} on the same day for a single {product}.",
        "You double charged my card. Same amount, same order number, two line items on my statement.",
        "My bank shows I got charged twice on the same day. I only placed one order.",
        "Duplicate charge on my card: {amount} twice for the same {product} order {order_id}. Please reverse one."]},
    'refund_status': {G: [
        "It has been {days_waiting} days and my refund for order {order_id} still has not posted. The email said 5-7 business days.",
        "Where is my refund? I returned the unopened {product} and nobody has processed it.",
        "Still waiting on a refund that was promised {days_waiting} days ago. This is unacceptable.",
        "I sent the {product} back with your return label {days_waiting} days ago and the refund has not posted. Where is my money?",
        "The Amazon return was accepted, the box was scanned, and still no refund. Order {order_id}."],
        N: ["Can you tell me the status of my refund for order {order_id}? Just want an ETA.",
            "How do I get a return label for an unopened {product}? The order page has no return option.",
            "Do I return the {product} through Amazon or through you? The Amazon return page sends me here."]},
    'promo_not_applied': {G: [
        "The promo code was accepted at checkout and then the discount was not applied on the receipt. I paid full price for {product}, which is frustrating.",
        "Promo code worked in the cart, then the confirmation email shows no discount. Annoying. Apply it or reverse the difference.",
        "The subscriber discount was not applied to order {order_id}. I was charged full price again."]},
    'discount_math': {G: [
        "The subscribe-and-save math does not add up. 15% off {amount} should not come to what you charged me on order {order_id}.",
        "Your subscription discount is wrong on my invoice. The line items do not match the advertised 20 percent.",
        "Overcharged on order {order_id}: the total is higher than the price shown at checkout."],
        N: ["Can you walk me through how the subscription discount stacks with the promo code? The numbers on my invoice do not look right."]},
    'pause_skip': {N: [
        "I would like to pause my subscription for two months while I travel. How do I skip the next shipment?",
        "Can I skip my next {product} shipment and resume in {cycle_n} weeks?",
        "How do I change the delivery date on my subscription? I want it to land after the holidays."],
        P: ["The pause option was easy to find and worked right away, thanks for making that painless.",
            "Skipped a month in two clicks. Nice that the subscription is this flexible."],
        G: ["I hit skip on my next shipment and it shipped anyway. The skip did not save and now I have two boxes. Annoying.",
            "Paused my subscription in the portal and a shipment still went out. The pause did not stick."]},
    # checkout_website
    'checkout_error': {G: [
        "Checkout keeps failing with an error at the payment step. I have tried three cards and it says something went wrong every time.",
        "Your website threw an error after I hit place order. No confirmation, but a pending charge on my card.",
        "Checkout error again. The page freezes on the payment step and I cannot complete my {product} order.",
        "The site is down or broken: the cart empties itself every time I get to payment."],
        N: ["Is the checkout page down? I get a spinning wheel after entering my address."]},
    'mobile_checkout': {G: [
        "The mobile site does not let me finish checkout. The pay button is hidden behind the cookie banner on my iPhone.",
        "Checkout on my phone is broken. The address form resets every time I pick a state.",
        "Apple Pay on the mobile site fails at the last step and the order never goes through."]},
    'unwanted_addon': {G: [
        "An add-on was added to my cart at checkout that I never selected. I only wanted one {product}. Sneaky and annoying.",
        "Your checkout snuck a {amount} add-on into my order. I did not click anything for it.",
        "A pre-checked box added an item to my cart. I never asked for it and I want it removed from order {order_id}."]},
    'promo_code': {G: ["The promo code from your email says invalid at checkout. Tried it four times. Frustrating.",
                       "The influencer discount code does not work at checkout. It says expired and the video went up yesterday."],
                   N: ["Does the code from the newsletter apply to {product} or only to the 5-Day kit?",
                       "Where do I enter a promo code on the checkout page? I do not see a field.",
                       "Can I stack the referral code with the subscribe discount on the {product}?"]},
    'hcp_code_entry': {N: [
        "My doctor gave me code {hcp_code} and I cannot find where to enter it at checkout. Where does the practitioner code go?",
        "Where do I enter my practitioner code? My dietitian sent me {hcp_code} for the {product}."],
        G: ["The HCP code {hcp_code} my practitioner gave me is rejected at checkout as invalid. I have tried it five times. Annoying.",
            "Practitioner code {hcp_code} keeps saying not valid. My doctor confirmed it is active. Frustrating."]},
    'login_account': {G: [
        "I cannot log in to my account. Password reset emails never arrive and the app says invalid credentials. Frustrating.",
        "Locked out of my account after the update. The reset link never comes and chat cannot help."],
        N: ["How do I merge my two accounts? I checked out as a guest once and now have orders in two places.",
            "How do I change the email address on my account and subscription?"]},
    'app_bug': {G: ["The ProLon app crashes every time I open the day {day} tracker. Reinstalled twice. Broken and frustrating.",
                    "The app keeps logging me out and the timer resets to zero. Buggy."],
                N: ["Is there an Android version of the app? The tracker only shows up on my wife's iPhone.",
                    "Does the app sync with Apple Health? Mine stopped syncing after the update."],
                P: ["The new app update fixed the timer bug, the day tracker works great now.",
                    "The app reminders kept me on schedule. Nice update."]},
    # shipping_fulfillment
    'late': {G: [
        "My order {order_id} is {days_waiting} days late. I planned my fast for this week and the kit is still not here.",
        "Shipping is late again. Tracking has said label created for a week and the box still has not arrived.",
        "Delayed shipment with no update. Order {order_id} was supposed to be here last Friday.",
        "Order {order_id} still has not shipped after {days_waiting} days. No update, no ETA."],
        N: ["Order {order_id} shows in transit for five days. Is that normal for ground shipping?",
            "Order {order_id} is in transit. When should my order arrive? I want to start on {start_day}."],
        P: ["Shipped faster than promised, arrived in two days and everything was packed perfectly.",
            "Ordered Monday, arrived Wednesday. Fast shipping and a cold pack in the box.",
            "Shipped fast, arrived early and well packaged. Smooth delivery."]},
    'lost': {G: [
        "The package never arrived. FedEx says delivered but there is nothing here and nothing with my neighbors. Order {order_id} is lost.",
        "My {product} is lost in transit, tracking has not updated in {days_waiting} days.",
        "Never received my order. Marked delivered, never showed up. Lost package, order {order_id}."]},
    'tracking': {N: ["The tracking link in my email does not work. Can you send the tracking number for order {order_id}?",
                     "Tracking says label created since Monday. Has order {order_id} actually left the warehouse?"],
                 G: ["Tracking has not updated in a week and nobody can tell me where my box is. Frustrating.",
                     "No tracking number at all for order {order_id} and the UPS link goes to an error page."]},
    'porch_drop': {G: [
        "FedEx left the box on my porch in the rain with no signature. The outer box was soaked and ruined when I got home. Terrible.",
        "Driver dropped the package at the wrong porch, the neighbor found it two days later. Careless and frustrating.",
        "Porch drop with no knock, no photo, and the box was sitting in the sun all afternoon. Unacceptable."]},
    'heat_damage': {G: [
        "The box sat on my porch in 100 degree heat and the bars melted into a puddle. Chocolate and nuts everywhere.",
        "Everything arrived warm, the bars are melted and the soup cups are bulging.",
        "Box sat in a hot mailbox all day and every bar melted flat. Heat damage, and no cold pack."]},
    'international_customs': {G: [
        "Customs held my order for {days_waiting} days and then charged me an import fee that was never mentioned at checkout. Frustrating and expensive."],
        N: ["Do you ship to Canada with duties prepaid or do I pay at the door?"]},
    # missing_damaged
    'missing_item': {G: [
        "Day {day} box is missing the {component}. I opened the kit and the {component} is not there.",
        "My order {order_id} arrived missing one item, no {component} at all in the box.",
        "Missing item: the {component} for day {day} was not included.",
        "Order {order_id} was supposed to have two boxes of {product} and only one was in the package. Missing item."]},
    'welcome_kit_missing': {G: [
        "The welcome kit with the instructions and the day-by-day schedule card was missing from my box. First time doing this and I have no guide.",
        "No welcome kit in the box. No booklet, no schedule card, nothing. Disappointing start.",
        "The instructions were not included. How do I know which soup goes with which day?"]},
    'leaking': {G: [
        "The L-Drink bottle leaked all over the day {day} box. Everything is sticky and the crackers are soaked.",
        "One L-Drink was leaking when I opened the kit, half the bottle gone and the box is stained.",
        "The {component} was leaking inside the shipping box. The cardboard was wet through.",
        "Leaked L-Drink again. Second kit in a row where a bottle was leaking on arrival.",
        "The L-Drink cap was loose and the glycerol leaked into the soup pouches. Sticky mess."]},
    'crushed_melted': {G: [
        "The box arrived crushed and the kale crackers are dust. The bars are melted.",
        "Crushed box, dented soup cups, and two bars melted flat.",
        "The box of {product} arrived crushed and half the bars are broken in pieces."]},
    'damaged_seal': {G: [
        "The seal on one of the soup packets was broken when it arrived. I am not comfortable eating it. Worrying.",
        "Two {component} pouches had a damaged seal and one was puffed up.",
        "The seal on the {product} was broken when it arrived. Not comfortable using it."]},
    # taste_quality
    'soup_taste': {G: [
        "The soups taste like astronaut food. Powdered, salty, and the {component} was the worst.",
        "Honestly the {component} tastes like bland wallpaper paste. I gagged on day {day}.",
        "The {component} is awful. Salty, artificial and bland at the same time.",
        "The Next Gen {component} has a metallic aftertaste and the vegetables are mush. Bland and disappointing.",
        "The ready-to-eat soups taste like canned vegetables left open overnight. The {component} was inedible."],
        N: ["Is the {component} supposed to be so thin? Wondering if I am using too much water.",
            "Is the {component} meant to be eaten hot? It tastes different at room temperature."],
        P: ["The {component} is actually delicious, I look forward to it every night.",
            "Soups were tasty, especially the {component}. Not what I expected from a fasting kit.",
            "The {component} tastes like real homemade soup. Pleasantly surprised."]},
    'texture': {G: ["The texture of the soups is gritty and the powder never fully dissolves.",
                    "Chalky texture on the shake, clumps no matter how much I blend it.",
                    "The bar is dry and crumbly, the texture is like sawdust.",
                    "The Next Gen {component} is mushy and the vegetables have gone to paste. Texture is off.",
                    "The protein powder is gritty and leaves clumps at the bottom of the glass.",
                    "Slimy texture on the {component}. Could not finish it."]},
    'l_drink_taste': {G: ["The L-Drink tastes like cough syrup. Awful. I could barely get it down diluted.",
                          "The glycerol L-Drink is sickly sweet and thick. Nasty even with extra water."],
                      N: ["Can I mix the L-Drink with sparkling water or does it need to be flat?",
                          "How much water should I dilute the L-Drink with? The bottle does not say."],
                      P: ["Did not expect to like the L-Drink but the mint flavor grew on me.",
                          "The L-Drink is fine diluted and sipped all day. Kept the hunger down."]},
    'olives': {G: ["The olives are the only thing I could not eat, they taste like brine soaked in plastic. Awful.",
                   "The olives taste off, mushy and too salty."],
               P: ["The olives were the only edible thing on day 3 and I loved them, please sell them separately.",
                   "The olives were my favorite part. Please sell them separately."]},
    'bar_taste': {G: ["The nut bar tastes stale and dry, like cardboard.",
                      "The bar is too sweet and the aftertaste is chalky."],
                  P: ["The bar is tasty, the choco crisp one especially.",
                      "The bars are great, dense and nutty. I would buy them on their own."]},
    'portion': {G: ["The portions are tiny. A 60 calorie soup as dinner is a joke.",
                    "The bars are tiny for the price. Two bites and it is gone. Not enough food."],
                N: ["Are the soup portions meant to be this small on day {day}?",
                    "Is one bar the whole serving size? It looks very small."]},
    'expiry_short_dated': {G: ["My kit arrived with an expiration date two months out. For {amount} I expect fresh stock, not stale inventory. Disappointing.",
                               "The {product} I received expires in six weeks. Short-dated stock for full price is disappointing."]},
    # foreign_material_allergen
    'hard_bits': {G: [
        "I found hard bits in the {component}, like little pieces of shell. Almost broke a tooth.",
        "There were hard bits in the minestrone quinoa on day {day}, gritty crunchy pieces that should not be there. Lot {lot}.",
        "Hard bits in the soup again. Small, sharp, and clearly not quinoa. Lot number {lot}.",
        "Bit down on something hard in the {component}. Small and sharp, definitely a foreign object. Lot {lot}."]},
    'shell_fragment': {G: [
        "Found what looks like a nut shell fragment in the {component}. Sharp, about 3mm. Lot {lot} on the box.",
        "A shell piece was in my soup. I have photos of the shell and the packaging, lot {lot}.",
        "There was a piece of shell in the {component}. Lot {lot}. I stopped eating it."]},
    'allergen_exposure': {G: [
        "I have a nut allergy and the bar sent me into hives. The allergen label was not clear.",
        "I have a soy allergy and reacted to the {product}. Hives and itching. The allergen label was not clear."]},
    'mold_spoilage': {G: ["The {component} was moldy when I opened it, green spots and it smelled off.",
                          "Two bars had white mold under the wrapper. Lot {lot}.",
                          "The {component} smelled rotten and the pouch was puffed up. Spoiled, lot {lot}."]},
    'undeclared_allergen': {G: [
        "There is soy in the shake that is not declared on the front label. I react to soy and I did. Dangerous and unacceptable.",
        "The {product} contains sesame and the label does not say so. Undeclared allergen, I had a reaction."]},
    # side_effects
    'hunger': {G: ["Day 2 hunger is brutal. I am so hungry I cannot concentrate at work.",
                   "Hungry all afternoon, could not concentrate at work. The hunger pangs were rough."],
               N: ["How hungry should I expect to be on day {day}? Is that normal?",
                   "Is it normal to be this hungry in the evening? Any tips for the cravings?"],
               P: ["I was hungry on day 2 but by day 4 the hunger just disappeared and I felt light and energized.",
                   "Hungry the first evening, then the hunger faded and I felt light."]},
    'headache': {G: ["Day 3 headache that would not quit even with the tea. Had to lie down.",
                     "Terrible headache on day {day}, pounding all afternoon.",
                     "Pounding headache all afternoon, had to lie down in a dark room."],
                 N: ["Is a mild headache on day {day} expected? Should I add electrolytes?",
                     "Is a mild headache expected? Should I add electrolytes or is that caffeine withdrawal?"],
                 P: ["Mild headache day 2, but the energy on day 4 was unreal. Worth it.",
                     "Mild headache at first, then the energy was unreal. Worth it."]},
    'fatigue': {G: ["Exhausted and fatigued the whole five days, could barely get off the couch.",
                    "Exhausted and fatigued, could barely get off the couch. No energy at all."]},
    'dizziness': {G: ["Felt dizzy and lightheaded standing up on day 3. It scared me a bit.",
                      "Dizzy and lightheaded every time I stood up. It scared me a bit."],
                  N: ["Slight dizziness on day {day}. Should I stop or push through?",
                      "Slight dizziness in the afternoon. Should I stop or push through?"]},
    'brain_fog': {G: ["Brain fog on day 2 and 3 so bad I could not work.",
                      "Brain fog so bad I could not work. Could not concentrate on anything."],
                  P: ["Foggy on day 2, then the clarity on day 4 and 5 was incredible.",
                      "Foggy at first, then the mental clarity was incredible."]},
    'nausea_gi': {G: ["The {component} gave me nausea and stomach cramps on day {day}.",
                      "Bloated and gassy, cramps all night after the day {day} soup.",
                      "The {product} gave me nausea and stomach cramps within an hour."]},
    'cold': {G: ["I was freezing the whole time, could not get warm even with layers. Miserable."],
             N: ["Is feeling cold all the time a normal part of the fast?"]},
    'sleep': {G: ["Could not sleep on day 3 and 4, woke up at 3am hungry and miserable.",
                  "Could not sleep the nights I took the {product}, woke up at 3am and stayed up. Insomnia."]},
    'inulin_ibs': {G: ["The inulin in the {product} wrecks my IBS. Cramps and bloating for two days."],
                   N: ["I have IBS. Is the inulin in the {product} going to be a problem?"]},
    # adverse_event (serious ones are planted)
    'fainting': {G: [
        "My husband fainted on day 3 of ProLon. He passed out in the kitchen and hit his head, we ended up calling the paramedics.",
        "I fainted at work on day 4 of the fast. Passed out for a few seconds, my coworkers called 911 and paramedics checked me."]},
    'er_hospital': {G: [
        "I ended up in the ER on day 3 with severe dizziness and heart palpitations. They kept me overnight at the hospital.",
        "My mother was taken to the emergency room after day 2 of the kit. Dehydration and low blood pressure, admitted overnight."]},
    'allergic_reaction': {G: [
        "I had an allergic reaction to the bar: throat swelling, hives, used my EpiPen and the paramedics took me to the ER."]},
    'hypoglycemia_medication': {G: [
        "I am on metformin and my blood sugar crashed to 48 on day 2. Hypoglycemia, nearly passed out, my doctor said I should never have done this."]},
    'chest_pain': {G: ["Chest pain and palpitations on day 4, went to the ER, they ran an EKG and kept me for observation."]},
    # efficacy_results
    'weight_loss': {P: [
        "Lost 6 lbs in five days and kept 4 of them off two weeks later. The scale finally moved.",
        "Down {lbs} lbs after my cycle and my jeans fit again. Great results.",
        "Lost {lbs} pounds, waist down an inch, and the results stuck.",
        "Lost {lbs} lbs and the scale is still moving a week later. Pants fit looser."],
        N: ["How much weight loss is typical after one cycle? I lost {lbs} lbs and want to know if that is average."]},
    'no_results': {G: ["Zero results. Five days of misery for one pound that came back the next day. Disappointed.",
                       "Did not lose anything and did not feel different. Not worth it for {amount}.",
                       "Zero results after a month on the {product}. Nothing changed, not the scale, not my energy."]},
    'regain': {G: ["Lost {lbs} lbs during the fast and regained all of it within a week. What was the point? Disappointed.",
                   "Gained it all back within ten days. The weight loss was just water."],
               N: ["Regained a couple of pounds after the refeed. Is that normal water weight?"]},
    'energy_clarity': {P: [
        "The energy on day 4 was the best I have felt in years. Mental clarity, no food noise.",
        "Waking up refreshed, focused, and my food noise is finally quiet. Wonderful.",
        "Steady energy all afternoon with the {product} and no 3pm crash. The mental clarity is real.",
        "More energy, sharper focus, and I sleep better. Did not expect that."]},
    'labs_biomarkers': {P: ["My A1c dropped from 6.4 to 5.9 after three cycles. My doctor is thrilled with the results.",
                            "My cholesterol and fasting glucose both improved on my labs. The doctor was impressed."],
                        N: ["Do you have data on fasting glucose changes after one cycle? My labs are due next month."],
                        G: ["My labs did not budge after 3 cycles, cholesterol actually went up. Disappointing."]},
    # price_value
    'too_expensive': {G: ["Way too expensive for what you get. {amount} for five days of powdered soup.",
                          "The price is outrageous for the amount of food in the box.",
                          "{amount} for a {product} is steep. Way too expensive for what is in the box.",
                          "Too expensive. I cannot justify {amount} again, however good it is."],
                      N: ["Is there ever a sale on the {product}? Hard to justify full price.",
                          "Any discount for buying two {product} at once? The price is a stretch for me."]},
    'per_day_cost': {G: ["$40 a day for a few crackers and soup. I could eat at a nice restaurant for that. Ridiculous."],
                     N: ["What does it work out to per day with the subscription discount?"]},
    'hsa_fsa': {N: ["Can I pay with my HSA or FSA card? Is ProLon eligible?",
                    "Do you provide a letter of medical necessity so I can use my FSA for the {product}?"],
                G: ["My HSA card was declined even though your FAQ says it is eligible. Annoying."]},
    'bundle_value': {P: ["The 3-box bundle brought the cost down enough that I could commit. Good value.",
                         "The bundle price made it worth it. Good value for three boxes."],
                     G: ["The bundle saves almost nothing per box. Not worth locking in. Disappointing deal."]},
    'price_increase': {G: ["The price went up {amount} since my last order without any notice. That is a lot and it is upsetting.",
                           "The {product} used to be cheaper. The price increase since spring is steep."]},
    # customer_service
    'no_response': {G: ["I have emailed three times about order {order_id} and gotten no response in {days_waiting} days.",
                        "Nobody has replied. Not a single response to my emails or my chat.",
                        "Radio silence for {days_waiting} days. Third email, no answer, being ignored."]},
    'slow_response': {G: ["It took {days_waiting} days to get a reply and the reply did not answer my question. Poor service.",
                          "Slow response: a week to hear back and then a template that did not address order {order_id}."],
                      N: ["What is your typical response time? I sent a message yesterday about my order."]},
    'wrong_item_sent': {G: ["You sent the wrong item. I ordered {product} and received a Fast Bar box instead.",
                            "You sent the wrong item. I ordered {product} and received the original 5-Day kit instead.",
                            "Wrong flavor sent. I ordered {flavor} and got the other one. Order {order_id}."]},
    'great_agent': {P: [
        "{agent} was fantastic, sorted out my order in five minutes and followed up the next day. Give that person a raise.",
        "Shout-out to {agent} on chat, patient and kind, fixed my issue right away.",
        "{agent} replaced the box the same day, no questions asked. Excellent service."]},
    'chatbot_loop': {G: ["Your chatbot is useless. It loops me back to the same three FAQ answers and never hands off to a human.",
                         "Stuck in a loop with the bot. Same canned response three times and no way to reach a real person."]},
    # hcp_practitioner
    'account_setup': {N: ["I am an NP opening a practice and need to set up a practitioner account. What documents do you need?",
                          "We order through Fullscript for our clinic. Can we set up a practitioner account with you directly or stay on the dispensary?"],
                      G: ["My practitioner account has been pending approval for {days_waiting} days. Patients are waiting and it is frustrating."],
                      P: ["Practitioner account approved in a day, the onboarding call was excellent."]},
    'bulk_order': {N: ["Our clinic needs 20 kits for a group fast in {cycle_n} weeks. What is the bulk pricing?",
                       "What is the minimum order for wholesale pricing? We stock the kits for our patients."],
                   G: ["The bulk order {order_id} arrived short by four kits and the invoice is wrong."],
                   P: ["Bulk order arrived complete and early, patients are thrilled. Great service."]},
    'patient_protocol': {N: [
        "What protocol do you recommend for a patient on a GLP-1 who wants to do 3 consecutive monthly cycles?",
        "Can a patient with type 2 diabetes on metformin do the 5-Day under supervision? What glucose monitoring do you suggest?",
        "What refeed guidance do you give patients with a history of reflux? Our protocol sheet is thin on this."],
        P: ["Our patients love the program and the practitioner portal makes reordering easy."]},
    'evidence_request': {N: ["Send the peer-reviewed studies on the FMD and metabolic markers for our review board.",
                             "Do you have the clinical evidence deck for the Next Gen kit? Our medical director is asking.",
                             "Is there published data on the 5-Day and blood pressure? Our cardiologist wants the citations."],
                         P: ["The peer-reviewed studies you sent were excellent and our medical director approved the protocol. Thank you."]},
    # marketing_email
    'too_many_emails': {G: ["I get three marketing emails a day from you. Annoying. Unsubscribe me from everything.",
                            "Unsubscribed twice and the promotional emails keep coming. Stop sending them."],
                        N: ["How do I reduce email frequency without unsubscribing entirely?"]},
    'influencer_skepticism': {G: ["Saw the influencer ad claiming this reverses aging. Feels like a scam, be honest."],
                              N: ["Is the influencer discount code legit or just a tracking link?"]},
    'misleading_claim': {G: [
        "Your ad says clinically proven to reduce biological age by 2.5 years. That is misleading and I want to see the study.",
        "The autophagy in 5 days claim on Instagram is misleading."]},
    # usage_guidance
    'coffee_exercise': {N: ["Can I have black coffee during the 5 days? And is a light workout allowed on day {day}?",
                            "Is it okay to run 5k on day 3 or should I keep it to walking?",
                            "Can I have black coffee during the fast? And is a light workout allowed?"],
                        P: ["Followed the light-exercise advice and it made day 3 much easier, thanks.",
                            "Followed the light-exercise advice and it made the fast much easier, thanks."]},
    'medications': {N: ["I take a low dose of levothyroxine. Should I take it with the L-Drink or separately?",
                        "I am on blood pressure medication. Anything I need to adjust during the fast?",
                        "I take a blood thinner. Any interaction with the {product}?"]},
    'refeed_transition': {N: ["What should the refeed day look like? Can I eat a regular dinner on day 6?",
                              "What should the transition day look like? Can I eat a regular dinner the day after?"],
                          P: ["The transition day guide was perfect, eased back into food with no issues.",
                              "The refeed instructions were clear and I had no stomach trouble coming off the fast."]},
    'cycle_frequency': {N: ["How many cycles a year does the protocol call for? Once a month for three months, then quarterly?",
                            "How long should I wait between cycles? I want to do another one next month."],
                        P: ["Three monthly cycles done and I feel great. Is quarterly a good maintenance rhythm? Loving this."]},
    'general_question': {N: ["Do I need to eat the day {day} items in order or can I move the bar to the evening?",
                             "Can I swap the tea for herbal tea I already have?",
                             "Is there a printed guide for the {product} or only the app? I want to get the order of things right.",
                             "Quick question about the {product}: does timing matter, morning or evening?"],
                         P: ["The day-by-day guide is excellent and easy to follow. One question: can I move the bar to the evening on day {day}?",
                             "The guide for the {product} is clear and easy to follow. One question: does timing matter, morning or evening?"]},
    # product_request
    'new_flavor': {N: ["Make a savory bar. Sweet bars every day gets old.",
                       "Would love a coffee flavor of the {product}. Any new flavors coming?"],
                   P: ["Love the kit, would buy a spicy tomato soup in a heartbeat.",
                       "Love the {product}. A mocha flavor would be perfect, please consider it."]},
    'allergen_free': {N: ["Any plans for a nut-free version of the kit? My son has a tree nut allergy.",
                          "Any plans for a soy-free {product}? I react to soy and cannot use this one."],
                      P: ["Love the kit so much I want my son to try it, any plans for a nut-free version?",
                          "Love the {product}. Any chance of a nut-free version for my husband?"]},
    'sample_pack': {N: ["Do you sell a sample pack so I can try the soups before buying a full kit? Which items are in it?",
                        "Is the Longevity Starter Pack a sample of everything? The listing says final sale, does that mean no returns?"],
                    G: ["Bought the Starter Pack as a sample and it says final sale, no returns. That was not clear at all."]},
    'longer_program': {N: ["Would love a 7-day option. Five days felt too short."],
                       P: ["Loved every day of it and honestly wanted more. Please make a 7-day option."]},
    # praise
    'results_praise': {P: [
        "Finished my cycle and I feel amazing. Thank you for making this. Lost {lbs} lbs and my energy is back.",
        "Best thing I have done for my health this year. Highly recommend to anyone on the fence.",
        "Feel lighter, sharper and genuinely better. The results were real and I am thrilled.",
        "Down {lbs} lbs, cravings gone, and my doctor was impressed with my numbers. Wonderful.",
        "Life-changing. My sugar cravings vanished and I feel like a new person."]},
    'convenience': {P: ["Everything is in the box, no thinking, no shopping. So convenient.",
                        "The ready-to-eat soups mean I can do this at work. Love it.",
                        "Grab a {product} on the way out the door, no prep. So convenient.",
                        "Everything is portioned and labeled. Took the guesswork out. So easy."]},
    'cs_praise': {P: ["Your customer care team is wonderful. Quick, kind, and they actually fixed it.",
                      "Support was excellent: quick reply, kind tone, problem solved the same day."]},
    'nextgen_taste': {P: [
        "The Next Gen soups are so much better than the old powder. The ready-to-eat minestrone is delicious.",
        "Next Gen taste is a huge upgrade. Real vegetables, real flavor, genuinely enjoyable.",
        "The ready-to-eat {component} is delicious, like real soup. Next Gen is a big improvement."]},
    'general_praise': {P: ["Five stars. Love ProLon, love the mission, love the results.",
                           "Thank you for a great product. Recommending it to my whole family.",
                           "Great product, great company. No complaints at all.",
                           "Loved it. Easy to follow, felt great, would do it again.",
                           "Wonderful experience from order to finish. Thank you."]},
}

# Subjects keyed by category and band; SUB_SUBJECTS below narrows by subcategory (also by band). render() never crosses bands.
SUBJECTS = {
    'subscription_billing': {
        G: ["Unauthorized subscription charge", "Charged twice for order {order_id}", "Cancel my subscription NOW",
            "Where is my refund?", "Auto-renewed without warning", "Box shipped after I cancelled",
            "Double charge on my card", "No way to cancel", "Discount not applied", "Billing problem with {product}"],
        N: ["Question about my subscription renewal", "How do I pause my shipments?", "Refund status for {order_id}",
            "Subscription discount question", "Skip next shipment", "Renewal date?"],
        P: ["Pause worked perfectly", "Thanks for the quick refund", "Easy subscription change"]},
    'checkout_website': {
        G: ["Checkout error", "Cannot complete my order", "Website broken on mobile", "Add-on I never selected",
            "Promo code invalid", "HCP code rejected", "Can't log in", "App keeps crashing"],
        N: ["Checkout question", "Where do I enter my practitioner code?", "Promo code question", "Account merge",
            "Android app?", "Is the site down?"],
        P: ["App update fixed it", "Smooth checkout"]},
    'shipping_fulfillment': {
        G: ["Order {order_id} still not arrived", "Package lost", "FedEx left my box in the rain", "Late delivery",
            "Melted bars", "Customs fee surprise", "Tracking not updating", "Where is my order?"],
        N: ["Tracking for order {order_id}", "Shipping time question", "Do you ship to Canada?", "In transit?"],
        P: ["Fast shipping!", "Arrived early"]},
    'missing_damaged': {
        G: ["Missing {component}", "L-Drink leaked everywhere", "Welcome kit missing", "Box arrived crushed",
            "Broken seal on soup", "Item missing from order {order_id}", "Leaking bottle in my kit",
            "Damaged kit"]},
    'taste_quality': {
        G: ["Soups taste like astronaut food", "Terrible taste", "Gritty texture", "L-Drink is undrinkable",
            "The olives", "Tiny portions", "Short expiration date", "Disappointed with the {component}"],
        N: ["Soup consistency question", "Mixing the L-Drink", "Portion size?"],
        P: ["Soups are better than expected", "Loved the {component}", "Next Gen soups are delicious",
            "Actually tasty", "Olives are the best part"]},
    'foreign_material_allergen': {
        G: ["Hard bits in the soup", "Shell fragment in my soup", "Foreign object in {component}", "Moldy product",
            "Allergic reaction to the bar", "Undeclared soy", "Something hard in the minestrone quinoa",
            "Lot {lot} quality issue"]},
    'side_effects': {
        G: ["Day 3 headache", "Terrible hunger", "Dizzy and lightheaded", "Exhausted the whole time", "Brain fog",
            "Nausea and cramps", "Freezing cold", "Can't sleep", "IBS flare"],
        N: ["Is this normal on day {day}?", "Headache question", "Hunger question", "Feeling cold?",
            "Dizziness on day {day}"],
        P: ["Rough day 2, amazing day 4", "Energy on day 4", "Hunger disappeared"]},
    'adverse_event': {
        G: ["Fainted on day 3", "ER visit during ProLon", "Serious allergic reaction", "Blood sugar crash on metformin",
            "Chest pain, went to ER", "Passed out during the fast", "Hospital visit after day 2"]},
    'efficacy_results': {
        P: ["Lost 6 lbs!", "Results after 3 cycles", "A1c dropped", "Energy on day 4", "Down {lbs} lbs",
            "Real results"],
        N: ["Typical weight loss?", "Regain after refeed?", "Glucose data?"],
        G: ["No results", "Gained it all back", "Labs did not change", "Waste of money"]},
    'price_value': {
        G: ["Too expensive", "$40 a day", "Price increase", "Bundle is not a deal", "HSA declined",
            "Not worth the price"],
        N: ["Any sales coming?", "HSA/FSA eligible?", "Per day cost?"],
        P: ["Bundle pricing is fair", "Good value"]},
    'customer_service': {
        G: ["No response in {days_waiting} days", "Still waiting for a reply", "Wrong item sent", "Chatbot is useless",
            "Slow response", "Third email, no answer"],
        N: ["Response time?"],
        P: ["{agent} was amazing", "Great support experience", "Thank you {agent}"]},
    'hcp_practitioner': {
        N: ["Practitioner account setup", "Bulk order pricing", "Protocol question for a patient on GLP-1",
            "Evidence request", "Patient on metformin", "Clinical deck for Next Gen"],
        G: ["Practitioner account still pending", "Bulk order short"],
        P: ["Practitioner onboarding was great", "Patients love it"]},
    'marketing_email': {
        G: ["Too many emails", "Unsubscribe me", "Misleading ad", "Is this a scam?", "Biological age claim"],
        N: ["Email frequency", "Influencer code legit?"]},
    'usage_guidance': {
        N: ["Coffee during the fast?", "Exercise on day {day}?", "Medication timing", "Refeed day question",
            "How often to do cycles?", "Order of items on day {day}", "Tea swap?", "Question about {product}"],
        P: ["Transition guide was perfect", "Exercise advice helped"]},
    'product_request': {
        N: ["Savory bar please", "Nut-free version?", "Sample pack?", "7-day option?", "Starter Pack final sale?"],
        P: ["Flavor idea", "Feature request from a fan"],
        G: ["Final sale was not clear"]},
    'praise': {
        P: ["Thank you!", "Feel amazing", "Love the Next Gen soups", "Best decision this year", "Five stars",
            "So convenient", "Your team is wonderful", "Recommending to everyone", "Great product", "Cycle {cycle_n} done"]},
}
# Last-resort subjects per band when neither the subcategory nor the category has one for the drawn band.
GENERIC_SUBJECTS = {G: ["Problem with my {product} order", "Issue with order {order_id}", "Not happy with my {product}"],
                    N: ["Question about {product}", "Quick question", "Question about order {order_id}"],
                    P: ["Happy with my {product}", "Good experience", "Feedback on {product}"]}

SUB_SUBJECTS = {
    'unauthorized_signup': {G: ["Signed up without permission", "Unauthorized subscription", "I never agreed to a subscription"]},
    'auto_renew_surprise': {G: ["Auto-renewed without warning", "Surprise renewal charge", "Renewal I did not ask for"],
                            N: ["Subscription renewal question", "Renewal date?", "Reminder before renewal?"]},
    'cancel_friction': {G: ["Cancel my subscription", "No cancellation link", "Unable to cancel"],
                        N: ["How do I cancel?", "Cancel before next shipment", "Where is the cancel option?"]},
    'post_cancel_shipment': {G: ["Box shipped after I cancelled", "Charged after cancellation", "Cancelled but still shipped"]},
    'duplicate_charge': {G: ["Charged twice for order {order_id}", "Double charge on my card", "Duplicate charge"]},
    'refund_status': {G: ["Where is my refund?", "Refund still not posted", "Return sent, no refund"],
                      N: ["Refund status for {order_id}", "Return label?", "How do I return an unopened {product}?"]},
    'promo_not_applied': {G: ["Discount not applied", "Promo code did not apply", "Paid full price despite promo"]},
    'discount_math': {G: ["Subscription discount is wrong", "Invoice math does not add up", "Overcharged on {order_id}"],
                      N: ["Discount question", "How does the discount stack?"]},
    'pause_skip': {N: ["Pause my subscription", "Skip next shipment", "Change delivery date"],
                   P: ["Pause worked perfectly", "Easy to skip a month"],
                   G: ["Skip did not save", "Paused but a box still came"]},
    'checkout_error': {G: ["Checkout error", "Cannot complete my order", "Payment step fails"],
                       N: ["Is the site down?", "Checkout question"]},
    'mobile_checkout': {G: ["Website broken on mobile", "Mobile checkout problem", "Cannot pay on my phone"]},
    'unwanted_addon': {G: ["Add-on I never selected", "Unwanted item added at checkout", "Remove the add-on from {order_id}"]},
    'promo_code': {G: ["Promo code invalid", "Code says expired", "Influencer code not working"],
                   N: ["Promo code question", "Where do I enter a code?", "Can I stack codes?"]},
    'hcp_code_entry': {N: ["Where do I enter my practitioner code?", "Practitioner code {hcp_code}", "HCP code question"],
                       G: ["HCP code rejected", "Practitioner code {hcp_code} invalid", "Code from my doctor not accepted"]},
    'login_account': {G: ["Can't log in", "Password reset not arriving", "Locked out of my account"],
                      N: ["Account merge", "Change my account email", "Account question"]},
    'app_bug': {G: ["App keeps crashing", "App logs me out", "Tracker bug"],
                N: ["Android app?", "Apple Health sync?", "App question"],
                P: ["App update fixed it", "New app update works"]},
    'late': {G: ["Order {order_id} still not arrived", "Late delivery", "Delayed shipment, no update"],
             N: ["Shipping time question", "When does order {order_id} arrive?", "In transit for five days?"],
             P: ["Fast shipping!", "Arrived early", "Quick delivery, thank you"]},
    'lost': {G: ["Package lost", "Never received my order", "Order {order_id} marked delivered, not here"]},
    'tracking': {N: ["Tracking for order {order_id}", "Tracking link broken", "Has {order_id} shipped?"],
                 G: ["Tracking not updating", "No tracking number", "Tracking stuck for a week"]},
    'porch_drop': {G: ["FedEx left my box in the rain", "Porch drop, wrong house", "Left on porch with no signature"]},
    'heat_damage': {G: ["Melted bars", "Box sat in the heat", "Everything arrived warm"]},
    'international_customs': {G: ["Customs fee surprise", "Held at customs", "Import fee not mentioned"],
                              N: ["Do you ship to Canada?", "Duties prepaid?"]},
    'missing_item': {G: ["Missing {component}", "Item missing from order {order_id}", "Missing item in day {day} box", "Order {order_id} short one box"]},
    'welcome_kit_missing': {G: ["Welcome kit missing", "No instructions in the box", "Missing welcome kit"]},
    'leaking': {G: ["L-Drink leaked everywhere", "Leaking bottle in my kit", "Leaked L-Drink, order {order_id}"]},
    'crushed_melted': {G: ["Box arrived crushed", "Crushed box, melted bars", "Damaged kit", "Crushed box, broken bars"]},
    'damaged_seal': {G: ["Broken seal on soup", "Damaged seal on {component}", "Puffed pouch, seal broken", "Seal broken on arrival"]},
    'soup_taste': {G: ["Soups taste like astronaut food", "Disappointed with the {component}", "Soup taste", "Next Gen soups taste off"],
                   N: ["Soup consistency question", "Hot or cold?", "Question about the {component}"],
                   P: ["Soups are better than expected", "Loved the {component}", "Actually tasty"]},
    'texture': {G: ["Gritty texture", "Chalky and clumpy", "Texture problem", "Mushy texture"]},
    'l_drink_taste': {G: ["L-Drink is undrinkable", "L-Drink tastes like cough syrup"],
                      N: ["Mixing the L-Drink", "How much water for the L-Drink?"],
                      P: ["L-Drink grew on me", "L-Drink is fine diluted"]},
    'olives': {G: ["The olives", "Olives taste off"],
               P: ["Olives are the best part", "Sell the olives separately"]},
    'bar_taste': {G: ["Stale bar", "Bar taste", "Bar is too sweet"],
                  P: ["Bars are great", "Love the bars"]},
    'portion': {G: ["Tiny portions", "Not enough food"],
                N: ["Portion size?", "Is one bar a serving?"]},
    'expiry_short_dated': {G: ["Short expiration date", "Kit expires in two months", "Short-dated {product}"]},
    'hard_bits': {G: ["Hard bits in the soup", "Something hard in the minestrone quinoa", "Lot {lot} quality issue", "Hard bits, lot {lot}"]},
    'shell_fragment': {G: ["Shell fragment in my soup", "Foreign object in {component}", "Nut shell in soup, lot {lot}"]},
    'allergen_exposure': {G: ["Allergic reaction to the bar", "Nut allergy, hives after the bar", "Allergen label unclear, reaction to {product}"]},
    'mold_spoilage': {G: ["Moldy product", "Mold on the {component}", "Spoiled, lot {lot}"]},
    'undeclared_allergen': {G: ["Undeclared soy", "Allergen not on label", "Undeclared allergen in {product}"]},
    'hunger': {G: ["Terrible hunger", "So hungry", "Hunger is brutal"],
               N: ["Hunger question", "Is this much hunger normal?"],
               P: ["Hunger disappeared", "Hunger faded"]},
    'headache': {G: ["Day 3 headache", "Pounding headache", "Headache would not quit"],
                 N: ["Headache question", "Mild headache, electrolytes?"],
                 P: ["Rough day 2, amazing day 4", "Headache passed, energy up"]},
    'fatigue': {G: ["Exhausted the whole time", "Fatigue on the fast", "No energy at all"]},
    'dizziness': {G: ["Dizzy and lightheaded", "Dizzy standing up"],
                  N: ["Dizziness on day {day}", "Slight dizziness, stop or continue?"]},
    'brain_fog': {G: ["Brain fog", "Could not think straight"],
                  P: ["Foggy then clear", "Clarity after the fog"]},
    'nausea_gi': {G: ["Nausea and cramps", "Stomach issues on day {day}", "Nausea after the {component}"]},
    'cold': {G: ["Freezing cold", "Could not get warm"],
             N: ["Feeling cold?", "Is feeling cold normal?"]},
    'sleep': {G: ["Can't sleep", "Insomnia on day 3", "Waking at 3am"]},
    'inulin_ibs': {G: ["IBS flare", "Inulin and my IBS"],
                   N: ["Inulin and IBS", "IBS question"]},
    'weight_loss': {P: ["Lost 6 lbs!", "Down {lbs} lbs", "Real results", "The scale moved"],
                    N: ["Typical weight loss?", "Is {lbs} lbs average?"]},
    'no_results': {G: ["No results", "Waste of money", "Nothing changed"]},
    'regain': {G: ["Gained it all back", "Regained everything"],
               N: ["Regain after refeed?", "Water weight?"]},
    'energy_clarity': {P: ["Energy on day 4", "Clarity and focus", "Food noise gone", "Steady energy"]},
    'labs_biomarkers': {P: ["A1c dropped", "Labs improved"],
                        G: ["Labs did not change", "Cholesterol went up"],
                        N: ["Glucose data?", "Any data on labs?"]},
    'too_expensive': {G: ["Too expensive", "Not worth the price", "Price is steep"],
                      N: ["Any sales coming?", "Any discount for two?"]},
    'per_day_cost': {G: ["$40 a day", "Cost per day is absurd"],
                     N: ["Per day cost?"]},
    'hsa_fsa': {N: ["HSA/FSA eligible?", "Letter of medical necessity?"],
                G: ["HSA declined", "FSA card rejected"]},
    'bundle_value': {G: ["Bundle is not a deal", "Bundle saves nothing"],
                     P: ["Bundle pricing is fair", "Good value bundle"]},
    'price_increase': {G: ["Price increase", "Price went up", "Why did the price go up?"]},
    'no_response': {G: ["No response in {days_waiting} days", "Third email, no answer", "Still waiting for a reply"]},
    'slow_response': {G: ["Slow response", "A week to hear back"],
                      N: ["Response time?"]},
    'wrong_item_sent': {G: ["Wrong item sent", "Received the wrong product", "Wrong flavor, order {order_id}"]},
    'great_agent': {P: ["{agent} was amazing", "Thank you {agent}", "Great support experience"]},
    'chatbot_loop': {G: ["Chatbot is useless", "Stuck in the chatbot", "Bot loop, no human"]},
    'account_setup': {N: ["Practitioner account setup", "Setting up a practitioner account", "Fullscript or direct account?"],
                      G: ["Practitioner account still pending", "Account approval delayed"],
                      P: ["Practitioner onboarding was great", "Account approved fast"]},
    'bulk_order': {N: ["Bulk order pricing", "Wholesale minimum?", "20 kits for a group fast"],
                   G: ["Bulk order short", "Bulk order {order_id} incomplete"],
                   P: ["Bulk order arrived early", "Great service on our bulk order"]},
    'patient_protocol': {N: ["Protocol question for a patient on GLP-1", "Patient on metformin", "Refeed protocol question"],
                         P: ["Patients love it", "Portal makes reordering easy"]},
    'evidence_request': {N: ["Evidence request", "Clinical deck for Next Gen", "Citations for our cardiologist"],
                         P: ["Evidence packet was excellent", "Medical director approved"]},
    'too_many_emails': {G: ["Too many emails", "Unsubscribe me", "Stop the marketing emails"],
                        N: ["Email frequency"]},
    'influencer_skepticism': {G: ["Is this a scam?", "Influencer ad"],
                              N: ["Influencer code legit?"]},
    'misleading_claim': {G: ["Misleading ad", "Biological age claim", "Autophagy claim"]},
    'coffee_exercise': {N: ["Coffee during the fast?", "Exercise on day {day}?", "Running during the fast?"],
                        P: ["Exercise advice helped", "Light exercise tip worked"]},
    'medications': {N: ["Medication timing", "Blood pressure meds and the fast", "Interaction question"]},
    'refeed_transition': {N: ["Refeed day question", "Transition day question"],
                          P: ["Transition guide was perfect", "Refeed went smoothly"]},
    'cycle_frequency': {N: ["How often to do cycles?", "Time between cycles?"],
                        P: ["Three cycles done", "Maintenance rhythm?"]},
    'general_question': {N: ["Order of items on day {day}", "Tea swap?", "Question about {product}", "Quick question about {product}"],
                         P: ["Great guide, one question", "Easy to follow, one question"]},
    'new_flavor': {N: ["Savory bar please", "New flavor idea"],
                   P: ["Flavor idea", "Please make a mocha {product}"]},
    'allergen_free': {N: ["Nut-free version?", "Soy-free {product}?"],
                      P: ["Nut-free version for my son?", "Love it, any nut-free version?"]},
    'sample_pack': {N: ["Sample pack?", "Starter Pack final sale?"],
                    G: ["Final sale was not clear", "Starter Pack no returns?"]},
    'longer_program': {N: ["7-day option?"],
                       P: ["Wanted more, 7-day option?"]},
    'results_praise': {P: ["Feel amazing", "Best decision this year", "Cycle {cycle_n} done", "Thank you!"]},
    'convenience': {P: ["So convenient", "No thinking required", "Easy to do at work"]},
    'cs_praise': {P: ["Your team is wonderful", "Great support", "Thank you, support team"]},
    'nextgen_taste': {P: ["Love the Next Gen soups", "Next Gen is a big upgrade", "Ready-to-eat soups are delicious"]},
    'general_praise': {P: ["Five stars", "Great product", "Recommending to everyone", "Thank you!"]},
    'fainting': {G: ["Fainted on day 3", "Passed out during the fast", "My husband fainted"]},
    'er_hospital': {G: ["ER visit during ProLon", "Hospital visit after day 2", "Kept overnight at the hospital"]},
    'allergic_reaction': {G: ["Serious allergic reaction", "Allergic reaction, used EpiPen"]},
    'hypoglycemia_medication': {G: ["Blood sugar crash on metformin", "Hypoglycemia on day 2"]},
    'chest_pain': {G: ["Chest pain, went to ER", "Chest pain and palpitations"]},
}

AFFECT_G = ["Really frustrating.", "Very disappointed.", "This is unacceptable.", "Not okay.", "Awful experience.",
            "So annoying.", "Terrible.", "I am upset about this.", "Disappointing.", "Poor experience.", "Not good enough.",
            "Very unhappy.", "Ridiculous.", "This is a mess.", "Not impressed."]
AFFECT_P = ["Love it.", "So happy with this.", "Excellent.", "Really pleased.", "Great experience.", "Thrilled.",
            "Wonderful.", "Could not be happier.", "Very satisfied.", "Highly recommend.", "Delighted."]

# Product-fit rules for cores, openers and closers (PR: no soup on an L-Pill, no day 4 on a 1-Day Reset, no powder on Next Gen).
MULTIDAY_KITS = {'prolon_5day', 'prolon_nextgen'}
NON_KIT_CONSUMER = {'fast_bar', 'fasting_shake', 'l_protein', 'l_pill'}
PROGRAMS = {'guided_health', 'lnutra_health', 'subscription_account'}
RE_MULTIDAY = re.compile(r"\{day\}|\bday[- ][2-6]\b|\bday 3 and 4\b|\bday 2 and 3\b|\bfive days\b|\bwhole five\b|\bday-by-day\b|\b7-day option\b|\bfelt too short\b", re.I)
RE_KIT_FOOD = re.compile(r"\bsoups?\b|\bl-drink\b|\bolives?\b|\bcrackers?\b|\btea\b|\bkit\b|\bminestrone\b|\bastronaut\b|\bsoup cups?\b|\bglycerol\b|\bwelcome kit\b|\bthe fast\b|\bfasting kit\b|\bpouch(es)?\b", re.I)
RE_CYCLE = re.compile(r"\bcycles?\b|\brefeed\b|\btransition day\b|\bthe fast\b|\bfasting\b|\bthe 5 days\b|\bmy fast\b", re.I)
RE_POWDER = re.compile(r"\bpowder(ed)?\b|\bdissolve\b|\bastronaut\b|\bsoup packets?\b", re.I)
RE_BAR_ONLY = re.compile(r"\bbars?\b|\bnutty\b|\bchoco crisp\b", re.I)
RE_SHAKE_ONLY = re.compile(r"\bshake\b|\bblend\b|\bglass\b", re.I)
RE_PILL_BAD = re.compile(r"\bbars?\b|\bshake\b|\bflavor\b|\bfood\b|\beat(ing)?\b|\btast(e|es|y)\b|\bsawdust\b|\bcrumbly\b|\bmelted?\b|\bfrozen\b|\bcold pack\b|\bhot\b", re.I)
RE_PROGRAM_BAD = re.compile(r"\bbars?\b|\bshake\b|\bbox(es)?\b|\bmelted?\b|\bpowder\b|\bflavor\b|\bday [2-6]\b|\bfive days\b", re.I)
RE_SHAKE_BAD = re.compile(r"\bbars?\b|\bsawdust\b|\bcrumbly\b|\bcapsule\b|\bnutty\b", re.I)
RE_BAR_BAD = re.compile(r"\bshake\b|\bblend\b|\bglass\b|\bprotein powder\b|\bcapsule\b|\bdiluted?\b", re.I)
RE_PROTEIN_BAD = re.compile(r"\bbars?\b|\bsawdust\b|\bcrumbly\b|\bcapsule\b|\bnutty\b|\bmelted?\b")
RE_PLACEHOLDER_ONLY = re.compile(r"Fast Bar box instead|original 5-Day kit instead", re.I)


def core_fits(text, prod):
    """True when a template line can plausibly describe the labelled product."""
    t = text
    if 'Next Gen' in t or 'ready-to-eat' in t or 'Ready-to-eat' in t:
        if prod != 'prolon_nextgen':
            return False
    if prod == 'prolon_nextgen' and RE_POWDER.search(t):
        return False
    if prod == 'fast_bar' and 'Fast Bar box instead' in t:
        return False
    if prod == 'prolon_5day' and 'original 5-Day kit instead' in t:
        return False
    if prod in MULTIDAY_KITS or prod == 'general':
        return True
    if prod in ('prolon_reset', 'prolon_52', 'starter_pack'):
        # one or two fasting days: soups and the L-Drink exist, day 3-6 and "five days" do not
        return not RE_MULTIDAY.search(t)
    if prod in NON_KIT_CONSUMER:
        if RE_MULTIDAY.search(t) or RE_KIT_FOOD.search(t) or RE_CYCLE.search(t):
            return False
        if prod == 'l_pill' and RE_PILL_BAD.search(t):
            return False
        if prod == 'fasting_shake' and RE_SHAKE_BAD.search(t):
            return False
        if prod == 'l_protein' and RE_PROTEIN_BAD.search(t):
            return False
        if prod == 'fast_bar' and RE_BAR_BAD.search(t):
            return False
        return True
    if prod in PROGRAMS:
        return not (RE_KIT_FOOD.search(t) or RE_PROGRAM_BAD.search(t))
    return True


def check_templates():
    """Every (subcategory, band) a product may draw keeps at least one fitting core, and every band drawn has a subject."""
    for sub, bands in CORES.items():
        allowed = SUB_PRODUCTS.get(sub)
        prods = allowed if allowed is not None else set(PRODUCTS)
        for band, cores in bands.items():
            for prod in prods:
                if prod == 'general':
                    continue
                if not any(core_fits(c, prod) for c in cores):
                    raise AssertionError('no fitting core for %s/%s on %s' % (sub, band, prod))
    for cat, subs in SUBCATEGORIES.items():
        if cat == 'other_noise':
            continue
        for sub in subs:
            for band in CORES.get(sub, {}):
                if band in SUB_SUBJECTS.get(sub, {}) or band in SUBJECTS.get(cat, {}):
                    continue
                raise AssertionError('no subject for %s/%s band %s' % (cat, sub, band))
    for sub, bands in SUB_SUBJECTS.items():
        assert sub in CORES, sub
        for band in bands:
            assert band in (P, N, G), (sub, band)

FOLLOWUP_CORES = [
    "Following up on my message about order {order_id}. It has been {days_waiting} days and nothing has changed.",
    "Second email about the same problem with order {order_id}. Still no resolution.",
    "I already wrote about this and got no fix. Same issue, same order {order_id}, still waiting.",
    "This is a follow-up. My earlier email about order {order_id} was answered with a template and the problem is still there.",
]
CHAT_AGENT_LINES = {
    P: ["Thanks for reaching out, {first_name}! So glad to hear it.", "That made my day, thank you for sharing, {first_name}."],
    N: ["Let me pull up your account, {first_name}.", "Checking now.", "One moment while I look that up."],
    G: ["I am sorry to hear that. Give me one moment to check order {order_id}.",
        "Thanks for reaching out, {first_name}. Let me pull up your account.",
        "Got it, thanks for the details. Let me look into this for you."],
}
CHAT_AGENT_CLOSE = {
    P: ["That is wonderful to hear, thank you for sharing!", "Thank you so much, I passed this along to the team."],
    N: ["Here is what I found, and I have emailed you the details as well.",
        "I have sent the guide to your email."],
    G: ["I have escalated this and you should hear back within one business day.",
        "I have issued the correction and sent a confirmation to your email.",
        "I understand the frustration. I have flagged this for our team and noted your account."],
}
PHONE_ACTIONS = {
    P: ["No action needed, thanked customer.", "Logged as praise."],
    N: ["Answered question, sent FAQ link by email.", "Emailed guide, customer satisfied."],
    G: ["Opened ticket, promised callback within 24h.", "Escalated to lead, replacement requested.",
        "Apologized, refund request submitted."],
}
REVIEW_VERDICT = {
    P: ["Would buy again.", "Five stars.", "Worth every penny.", "Recommend."],
    N: ["Three stars for now.", "Undecided, may try again.", "Okay overall."],
    G: ["Would not buy again.", "One star.", "Not recommended.", "Save your money."],
}
QUOTED_TAILS = [
    "\n\nOn {qdate}, L-Nutra Customer Care <care@prolonlife.com> wrote:\n> Thank you for contacting ProLon Customer Care. We received your message and\n> a specialist responds within one business day.\n> Order reference: {order_id}\n",
    "\n\nOn {qdate}, L-Nutra Customer Care <care@prolonlife.com> wrote:\n> Hi {first_name}, thanks for reaching out! Could you share a photo of the\n> packaging and the lot number printed on the box?\n> Best, {agent}\n",
]
SIGNATURES = ["\n--\nSent from my iPhone", "\n\nSent from my iPhone", "\n--\n{first_name} {last_name}\n{phone}",
              "\n\nSent from Outlook for Android"]

# Non-English short bodies: (language, category, subcategory, product_set_hint, subject, body)
NON_EN = {
    'de': [
        ('subscription_billing', 'duplicate_charge', "Doppelt abgebucht", "Hallo, ich wurde für Bestellung {order_id} zweimal abgebucht. Bitte erstatten Sie eine der beiden Zahlungen. Danke, {first_name}"),
        ('subscription_billing', 'cancel_friction', "Abo kündigen", "Guten Tag, ich möchte mein Abonnement kündigen und finde keinen Link dafür im Konto. Bitte kündigen Sie es. {first_name}"),
        ('shipping_fulfillment', 'late', "Lieferung verspätet", "Hallo, meine Bestellung {order_id} ist seit {days_waiting} Tagen unterwegs und noch nicht angekommen. Wann kommt das Paket?"),
        ('shipping_fulfillment', 'international_customs', "Zollgebühren", "Der Zoll hat mir {amount} Gebühren berechnet, das stand nirgends beim Checkout. Bitte um Klärung."),
        ('taste_quality', 'soup_taste', "Geschmack der Suppen", "Die Suppen schmecken leider sehr künstlich, vor allem die {component}. Schade für den Preis."),
        ('praise', 'results_praise', "Vielen Dank", "Ich habe gerade meinen Zyklus beendet und fühle mich großartig. {lbs} Kilo weniger und viel mehr Energie. Vielen Dank!"),
        ('usage_guidance', 'coffee_exercise', "Kaffee erlaubt?", "Darf ich während der fünf Tage schwarzen Kaffee trinken? Und ist leichter Sport am Tag {day} in Ordnung?"),
        ('missing_damaged', 'missing_item', "Fehlender Artikel", "In meinem Kit fehlt die {component} für Tag {day}. Bestellung {order_id}. Bitte nachsenden."),
    ],
    'it': [
        ('subscription_billing', 'auto_renew_surprise', "Addebito rinnovo", "Buongiorno, mi è stato addebitato {amount} per un rinnovo automatico che non avevo richiesto. Ordine {order_id}. Vorrei il rimborso."),
        ('subscription_billing', 'refund_status', "Rimborso", "Salve, aspetto il rimborso dell'ordine {order_id} da {days_waiting} giorni. Potete verificare? Grazie, {first_name}"),
        ('shipping_fulfillment', 'lost', "Pacco non arrivato", "Il pacco risulta consegnato ma non è mai arrivato. Ordine {order_id}. Cosa posso fare?"),
        ('taste_quality', 'l_drink_taste', "L-Drink", "L-Drink ha un sapore molto forte, si può diluire con più acqua? Grazie."),
        ('praise', 'general_praise', "Grazie", "Ho finito il mio ciclo di {product} e sono molto soddisfatta. Ottimo prodotto, lo consiglio a tutti!"),
        ('usage_guidance', 'refeed_transition', "Giorno di transizione", "Cosa posso mangiare il sesto giorno? Va bene una cena normale o meglio qualcosa di leggero?"),
        ('side_effects', 'headache', "Mal di testa", "Il terzo giorno ho avuto un forte mal di testa. È normale? Posso prendere qualcosa?"),
        ('missing_damaged', 'leaking', "Bottiglia rotta", "La bottiglia di L-Drink del giorno {day} perdeva (leaking bottle) e la scatola era tutta bagnata. Ordine {order_id}."),
    ],
}
NON_EN_BAND_HINT = {'praise': P, 'usage_guidance': N, 'side_effects': N}

NOISE_TEMPLATES = [
    ('auto_reply', "Automatic reply: {orig}", "I am currently out of the office with limited access to email and return on {ret}. For urgent matters please contact my colleague.\n\n{first_name} {last_name}", 6),
    ('bounce', "Undeliverable: {orig}", "Delivery has failed to these recipients or groups:\n\n{email}\nThe recipient's mailbox is full and can't accept messages now. Please try resending this message later.\n\nDiagnostic information for administrators:\nGenerating server: mail.prolonlife.com\n{email}\nRemote Server returned '550 5.2.2 Mailbox full'", 3),
    ('newsletter', "{nl}", "View this email in your browser.\n\n{nl_body}\n\nYou are receiving this because you subscribed to our list. Unsubscribe | Update preferences", 2),
]
NEWSLETTERS = [("Your weekly wellness digest: 5 fasting myths debunked", "This week: intermittent fasting vs. fasting mimicking, a Q&A with our dietitian, and 10% off shakes through Sunday."),
               ("Longevity Insider - September edition", "New research roundup on metabolic health, plus member stories and the fall recipe guide.")]

# ---------------------------------------------------------------------------
# Distributions
# ---------------------------------------------------------------------------
SEGMENT_MIX = {'first_time': 34, 'repeat': 22, 'subscriber': 25, 'hcp': 6, 'hcp_patient': 4, 'lnh_patient': 3,
               'employer': 4, 'wholesale': 2}
REGION_MIX = {'US': 74, 'CA': 5, 'UK': 6, 'EU': 4, 'DE': 3, 'IT': 3, 'AU': 2, 'AE': 2, 'OTHER': 1}
DOW_F = [1.35, 1.25, 1.05, 1.0, 0.9, 0.55, 0.6]
MONTH_F = {1: 1.6, 2: 1.1, 9: 1.25, 11: 1.2, 12: 1.15}

CHANNEL_BY_SALES = {
    'dtc_web': {'email': 58, 'chat': 12, 'survey': 12, 'trustpilot_review': 6, 'social': 6, 'phone_note': 6},
    'amazon': {'amazon_review': 62, 'email': 26, 'survey': 12},
    'hcp': {'hcp_portal': 38, 'email': 47, 'phone_note': 15},
    'lnutra_health': {'email': 70, 'phone_note': 20, 'survey': 10},
    'employer': {'email': 68, 'survey': 22, 'chat': 10},
    'social_affiliate': {'social': 42, 'email': 38, 'survey': 20},
    'international': {'email': 80, 'chat': 10, 'survey': 10},
}
# hcp_patient buys through the hcp channel but is a consumer: no hcp_portal
CHANNEL_HCP_PATIENT = {'email': 68, 'chat': 12, 'survey': 12, 'phone_note': 8}

CAT_W = {
    'reviews': {'praise': 70, 'efficacy_results': 20, 'taste_quality': 11, 'price_value': 4, 'side_effects': 3,
                'shipping_fulfillment': 3, 'missing_damaged': 2, 'usage_guidance': 3},
    'survey': {'praise': 100, 'efficacy_results': 14, 'taste_quality': 7, 'price_value': 5, 'customer_service': 8,
               'shipping_fulfillment': 5, 'subscription_billing': 5, 'usage_guidance': 4, 'side_effects': 3,
               'product_request': 2},
    'social': {'praise': 44, 'efficacy_results': 16, 'marketing_email': 9, 'taste_quality': 9, 'price_value': 6,
               'side_effects': 8, 'usage_guidance': 8, 'product_request': 4},
    'contact': {'subscription_billing': 16, 'shipping_fulfillment': 10, 'checkout_website': 5, 'missing_damaged': 5,
                'taste_quality': 6, 'side_effects': 5, 'efficacy_results': 12, 'price_value': 4, 'customer_service': 6,
                'marketing_email': 2, 'usage_guidance': 8, 'product_request': 3, 'praise': 125},
    'hcp': {'hcp_practitioner': 46, 'shipping_fulfillment': 10, 'subscription_billing': 6, 'usage_guidance': 8,
            'praise': 12, 'efficacy_results': 8, 'price_value': 4, 'checkout_website': 6},
    'lnh_patient': {'efficacy_results': 30, 'usage_guidance': 28, 'side_effects': 14, 'praise': 12,
                    'shipping_fulfillment': 10, 'price_value': 6},
    'hcp_patient': {'checkout_website': 20, 'usage_guidance': 24, 'efficacy_results': 15, 'shipping_fulfillment': 12,
                    'taste_quality': 9, 'side_effects': 8, 'praise': 12},
    'employer': {'usage_guidance': 24, 'praise': 22, 'efficacy_results': 15, 'shipping_fulfillment': 12,
                 'checkout_website': 9, 'side_effects': 8, 'taste_quality': 10},
    'wholesale': {'shipping_fulfillment': 34, 'price_value': 20, 'customer_service': 14, 'checkout_website': 10,
                  'product_request': 10, 'praise': 12},
}
BAND_W = {
    'subscription_billing': {P: 8, N: 12, G: 80}, 'checkout_website': {P: 18, N: 22, G: 60},
    'shipping_fulfillment': {P: 36, N: 12, G: 52}, 'missing_damaged': {G: 100}, 'taste_quality': {P: 62, N: 8, G: 30},
    'foreign_material_allergen': {G: 100}, 'side_effects': {P: 60, N: 18, G: 22}, 'adverse_event': {G: 100},
    'efficacy_results': {P: 78, N: 8, G: 14}, 'price_value': {P: 38, N: 22, G: 40},
    'customer_service': {P: 64, N: 6, G: 30}, 'hcp_practitioner': {P: 45, N: 40, G: 15},
    'marketing_email': {P: 0, N: 20, G: 80}, 'usage_guidance': {P: 30, N: 70}, 'product_request': {P: 55, N: 35, G: 10},
    'praise': {P: 100},
}
SUB_W = {
    'subscription_billing': {'unauthorized_signup': 10, 'auto_renew_surprise': 20, 'cancel_friction': 20,
                             'post_cancel_shipment': 8, 'duplicate_charge': 4, 'refund_status': 14,
                             'promo_not_applied': 8, 'discount_math': 6, 'pause_skip': 10},
    'checkout_website': {'checkout_error': 24, 'mobile_checkout': 12, 'unwanted_addon': 10, 'promo_code': 20,
                         'hcp_code_entry': 6, 'login_account': 16, 'app_bug': 12},
    'shipping_fulfillment': {'late': 34, 'lost': 16, 'tracking': 22, 'porch_drop': 12, 'heat_damage': 6,
                             'international_customs': 10},
    'missing_damaged': {'missing_item': 40, 'welcome_kit_missing': 18, 'leaking': 14, 'crushed_melted': 18,
                        'damaged_seal': 10},
    'taste_quality': {'soup_taste': 36, 'texture': 12, 'l_drink_taste': 14, 'olives': 12, 'bar_taste': 12,
                      'portion': 10, 'expiry_short_dated': 4},
    'foreign_material_allergen': {'hard_bits': 25, 'shell_fragment': 20, 'allergen_exposure': 20, 'mold_spoilage': 25,
                                  'undeclared_allergen': 10},
    'side_effects': {'hunger': 22, 'headache': 22, 'fatigue': 8, 'dizziness': 12, 'brain_fog': 8, 'nausea_gi': 10,
                     'cold': 8, 'sleep': 5, 'inulin_ibs': 5},
    'efficacy_results': {'weight_loss': 40, 'no_results': 14, 'regain': 12, 'energy_clarity': 24, 'labs_biomarkers': 10},
    'price_value': {'too_expensive': 34, 'per_day_cost': 20, 'hsa_fsa': 18, 'bundle_value': 18, 'price_increase': 10},
    'customer_service': {'no_response': 26, 'slow_response': 18, 'wrong_item_sent': 10, 'great_agent': 34,
                         'chatbot_loop': 12},
    'hcp_practitioner': {'account_setup': 25, 'bulk_order': 25, 'patient_protocol': 30, 'evidence_request': 20},
    'marketing_email': {'too_many_emails': 45, 'influencer_skepticism': 30, 'misleading_claim': 25},
    'usage_guidance': {'coffee_exercise': 28, 'medications': 20, 'refeed_transition': 18, 'cycle_frequency': 14,
                       'general_question': 20},
    'product_request': {'new_flavor': 30, 'allergen_free': 25, 'sample_pack': 25, 'longer_program': 20},
    'praise': {'results_praise': 30, 'convenience': 18, 'cs_praise': 14, 'nextgen_taste': 16, 'general_praise': 22},
}
PRODUCT_W = {
    'first_time': {'prolon_5day': 44, 'prolon_nextgen': 20, 'prolon_reset': 12, 'fast_bar': 7, 'fasting_shake': 4,
                   'l_protein': 3, 'l_pill': 3, 'prolon_52': 2, 'starter_pack': 2, 'general': 3},
    'repeat': {'prolon_5day': 42, 'prolon_nextgen': 22, 'prolon_reset': 10, 'fast_bar': 8, 'fasting_shake': 5,
               'l_protein': 4, 'l_pill': 4, 'prolon_52': 3, 'general': 2},
    'subscriber': {'prolon_5day': 30, 'prolon_nextgen': 14, 'fast_bar': 14, 'fasting_shake': 10, 'l_protein': 8,
                   'l_pill': 8, 'prolon_52': 4, 'subscription_account': 12},
    'hcp': {'prolon_5day': 62, 'prolon_nextgen': 20, 'prolon_reset': 6, 'general': 12},
    'hcp_patient': {'prolon_5day': 60, 'prolon_nextgen': 25, 'prolon_reset': 10, 'general': 5},
    'lnh_patient': {'lnutra_health': 55, 'prolon_5day': 35, 'prolon_nextgen': 10},
    'employer': {'prolon_5day': 55, 'prolon_nextgen': 20, 'guided_health': 15, 'fast_bar': 5, 'general': 5},
    'wholesale': {'prolon_5day': 60, 'prolon_nextgen': 20, 'fast_bar': 10, 'general': 10},
}
SEGMENT_SALES = {
    'first_time': {'dtc_web': 70, 'amazon': 22, 'social_affiliate': 8}, 'repeat': {'dtc_web': 78, 'amazon': 18, 'social_affiliate': 4},
    'subscriber': {'dtc_web': 88, 'amazon': 12}, 'hcp': {'hcp': 100}, 'hcp_patient': {'hcp': 100},
    'lnh_patient': {'lnutra_health': 100}, 'employer': {'employer': 100}, 'wholesale': {'hcp': 60, 'international': 40},
}
# Status mix by age bucket (weights). 'new'/'open' carry no first response, so they are the records that breach the
# first-response SLA once older than SLA_HOURS[urgency]; 'pending'/'reopened'/'escalated' always carry one.
STATUS_FRESH = {'new': 38, 'open': 22, 'pending': 14, 'escalated': 3, 'reopened': 3, 'resolved': 20}      # <= 48h old
STATUS_RECENT = {'open': 18, 'pending': 17, 'reopened': 5, 'escalated': 3, 'resolved': 57}                # 2-21 days
STATUS_SETTLING = {'open': 5, 'pending': 6, 'reopened': 3, 'escalated': 1, 'resolved': 85}                # 21-45 days
STATUS_OLD = {'resolved': 100}                                                                            # > 45 days
OPEN_STATUSES = {'new', 'open', 'pending', 'reopened', 'escalated'}
# Probability that a negative draw on a feedback channel flips to positive (public reviews and post-purchase surveys
# skew positive; the survey skews hardest because it follows a completed program).
FEEDBACK_POS_SKEW = {'amazon_review': 0.72, 'trustpilot_review': 0.72, 'survey': 0.82, 'social': 0.68}


def status_table(age_hours):
    if age_hours <= 48:
        return STATUS_FRESH
    if age_hours <= 21 * 24:
        return STATUS_RECENT
    if age_hours <= OPEN_MAX_DAYS * 24:
        return STATUS_SETTLING
    return STATUS_OLD

# Planted event windows
E = {
    'E1': (date(2025, 10, 23), date(2025, 11, 15)), 'E2': (date(2025, 11, 27), date(2025, 12, 1)),
    'E3': (date(2025, 12, 15), date(2025, 12, 19)), 'E4': (date(2026, 1, 2), date(2026, 1, 24)),
    'E5': (date(2026, 2, 24), date(2026, 2, 26)), 'E6': (date(2026, 5, 11), date(2026, 5, 31)),
    'E7': (date(2026, 6, 1), date(2026, 7, 31)), 'E8': (date(2026, 7, 6), date(2026, 7, 26)),
    'E9': (date(2026, 8, 6), date(2026, 8, 31)), 'E13': (date(2026, 9, 1), date(2026, 9, 16)),
}


def in_win(d, key):
    a, b = E[key]
    return a <= d <= b


def volume_mult(d):
    m = 1.0
    if in_win(d, 'E2'):
        m *= 1.6
    if in_win(d, 'E3'):
        m *= 2.8
    if in_win(d, 'E4'):
        m *= 1.8
    if in_win(d, 'E13'):
        m *= 1.15
    return m


def base_lambda(d):
    months = (d.year - RANGE_FROM.year) * 12 + d.month - RANGE_FROM.month + (d.day - RANGE_FROM.day) / 30.0
    return 2.4 * (1.03 ** months) * DOW_F[d.weekday()] * MONTH_F.get(d.month, 0.95) * volume_mult(d)


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------
class Generator:
    def __init__(self):
        self.rng = R(SEED)
        self.used_ids = set()
        self.customers = []
        self.practices = []
        self.records = []
        self.msgid_n = 0

    # -- ids -----------------------------------------------------------------
    def hex_id(self, prefix):
        while True:
            h = prefix + self.rng.hexs(16)
            if h not in self.used_ids:
                self.used_ids.add(h)
                return h

    def order_id(self, sales_channel):
        r = self.rng
        if sales_channel == 'amazon':
            return '113-%07d-%07d' % (r.i(0, 9999999), r.i(0, 9999999))
        if sales_channel in ('hcp', 'lnutra_health'):
            return 'PP-%05d' % r.i(10000, 99999)
        return '#1%05d' % r.i(0, 99999)

    def hcp_code(self):
        return 'HCP-' + ''.join(self.rng.pick('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(5))

    def lot(self):
        while True:
            code = '%s-%02d%02d-%s' % (self.rng.pick(['PL', 'NG', 'FB']), self.rng.i(1, 12), self.rng.i(25, 26),
                                       self.rng.pick('ABC'))
            if code not in (LOT_E6, LOT_RFR):   # reserved for the planted ramp and the fresh RFR report
                return code

    # -- practices & customers ----------------------------------------------
    def build_practices(self):
        for i, (name, ptype, region) in enumerate(PRACTICE_NAMES):
            self.practices.append({'practice_id': 'p_%02d' % (i + 1), 'name': name, 'type': ptype, 'region': region,
                                   'hcp_code': self.hcp_code()})

    def build_customers(self):
        r = self.rng
        seg_list = []
        for seg, w in SEGMENT_MIX.items():
            seg_list += [seg] * int(round(N_CUSTOMERS * w / 100.0))
        while len(seg_list) < N_CUSTOMERS:
            seg_list.append('first_time')
        seg_list = seg_list[:N_CUSTOMERS]
        r.shuffle(seg_list)
        reg_list = []
        for reg, w in REGION_MIX.items():
            reg_list += [reg] * int(round(N_CUSTOMERS * w / 100.0))
        while len(reg_list) < N_CUSTOMERS:
            reg_list.append('US')
        reg_list = reg_list[:N_CUSTOMERS]
        r.shuffle(reg_list)
        emails = set()
        for idx in range(N_CUSTOMERS):
            seg = seg_list[idx]
            region = reg_list[idx]
            if seg in ('hcp', 'hcp_patient', 'lnh_patient', 'employer', 'wholesale') and region not in ('US', 'CA', 'UK', 'AU'):
                region = 'US'
            if region == 'DE':
                first, last = r.pick(FIRST_DE), r.pick(LAST_DE)
            elif region == 'IT':
                first, last = r.pick(FIRST_IT), r.pick(LAST_IT)
            elif region == 'AE':
                first, last = r.pick(FIRST_AE), r.pick(LAST_AE)
            else:
                first, last = r.pick(FIRST_EN), r.pick(LAST_EN)
            while True:
                local = (first + '.' + last.replace(' ', '').replace("'", '')).lower()
                local = local.replace('ü', 'ue').replace('ö', 'oe').replace('ä', 'ae')
                email = '%s%d@%s' % (local, r.i(1, 99), r.w(DOMAINS))
                if email not in emails:
                    emails.add(email)
                    break
            sales = r.w(SEGMENT_SALES[seg])
            if seg in ('first_time', 'repeat', 'subscriber') and region not in ('US',) and r.p(0.55):
                sales = 'international'
            practice = None
            hcp_code = None
            if seg == 'hcp':
                practice = r.pick(self.practices)
                hcp_code = self.hcp_code()
            elif seg == 'hcp_patient':
                practice = r.pick(self.practices)
                hcp_code = practice['hcp_code']
            first_seen = ct_to_utc(datetime.combine(RANGE_FROM - timedelta(days=r.i(0, 420)), datetime.min.time())
                                   + timedelta(hours=r.i(8, 20)))
            self.customers.append({
                'customer_id': self.hex_id('c_'), 'display_name': '%s %s' % (first, last), 'email': email,
                'first_name': first, 'last_name': last,
                'segment': seg, 'sales_channel': sales, 'region': region, 'first_seen': iso(first_seen),
                'orders_12m': 0, 'ltv_usd': 0, 'subscriber': False, 'subscription_status': 'none',
                'subscription_cadence_months': None, 'subscription_value_12m_usd': None, 'cancelled_at': None,
                'cancel_reason': None, 'hcp_code': hcp_code,
                'practice_id': practice['practice_id'] if practice else None,
                'restricted': seg in ('lnh_patient', 'hcp_patient'),
                'practice_name': practice['name'] if practice else None,
            })

    # -- orders --------------------------------------------------------------
    def build_orders(self):
        shares = {'prolon_5day': 38, 'prolon_nextgen': 17, 'prolon_reset': 15, 'fast_bar': 9, 'fasting_shake': 6,
                  'l_protein': 5, 'l_pill': 4, 'starter_pack': 2, 'guided_health': 1, 'prolon_52': 3}
        months = []
        y, m = 2025, 9
        while (y, m) <= (2026, 9):
            months.append('%d-%02d' % (y, m))
            m += 1
            if m > 12:
                y, m = y + 1, 1
        out = {'_total': {}}
        for p in shares:
            out[p] = {}
        base = 30000 / 13.0
        for i, key in enumerate(months):
            mm = int(key[5:])
            f = 1.6 if mm == 1 else 1.4 if mm == 11 else 1.0
            total_m = base * f * (1.03 ** (i / 4.0)) * self.rng.u(0.96, 1.04)
            tot = 0
            for p, s in shares.items():
                share = s / 100.0
                if p == 'starter_pack':
                    if key not in ('2026-08', '2026-09'):
                        out[p][key] = 0
                        continue
                    share = 0.02
                if p == 'guided_health' and key < '2025-10':
                    out[p][key] = 0
                    continue
                n = int(round(total_m * share * self.rng.u(0.9, 1.1)))
                out[p][key] = n
                tot += n
            out['_total'][key] = tot
        return out

    # -- record skeletons ----------------------------------------------------
    def arrival(self, d, max_hour=23):
        r = self.rng
        h = r.r.gauss(10, 1.4) if r.p(0.6) else r.r.gauss(20, 1.3)
        h = int(max(6, min(max_hour, round(h))))
        local = datetime(d.year, d.month, d.day, h, r.i(0, 59), r.i(0, 59))
        utc = ct_to_utc(local)
        if utc > AS_OF_UTC:
            utc = AS_OF_UTC - timedelta(minutes=r.i(5, 300))
        return utc

    def planted(self):
        """Explicit records for E1, E5, E6, E8, E9, E10, E11 extras, E12."""
        r = self.rng
        out = []

        def add(d, **kw):
            kw['received'] = self.arrival(d)
            kw.setdefault('planted', True)
            out.append(kw)

        # E1 Guided Health launch: usage/price/praise on guided_health
        for _ in range(13):
            d = E['E1'][0] + timedelta(r.i(0, (E['E1'][1] - E['E1'][0]).days))
            cat = r.w({'usage_guidance': 55, 'price_value': 30, 'praise': 15})
            add(d, category=cat, product='guided_health', event='E1', seg_req=('first_time', 'repeat', 'employer'))
        # E5 double-charge bug: 14 duplicate_charge in 72h
        for k in range(14):
            d = E['E5'][0] + timedelta(k % 3)
            add(d, category='subscription_billing', subcategory='duplicate_charge', band=G, event='E5',
                seg_req=('subscriber', 'repeat', 'first_time'))
        # E6 foreign material ramp: weekly 1 -> 6 -> 11, lot NG-0426-B, Next Gen minestrone quinoa
        for wk_start, n in ((date(2026, 5, 11), 1), (date(2026, 5, 18), 6), (date(2026, 5, 25), 11)):
            for _ in range(n):
                d = wk_start + timedelta(r.i(0, 6))
                add(d, category='foreign_material_allergen', subcategory=r.w({'hard_bits': 60, 'shell_fragment': 40}),
                    band=G, product='prolon_nextgen', component='soup_minestrone_quinoa', lot=LOT_E6, event='E6',
                    seg_req=('first_time', 'repeat', 'subscriber', 'hcp_patient', 'employer'))
        # E8 L-Drink leak ramp: weekly 2 -> 6 -> 11
        for wk_start, n in ((date(2026, 7, 6), 2), (date(2026, 7, 13), 6), (date(2026, 7, 20), 11)):
            for _ in range(n):
                d = wk_start + timedelta(r.i(0, 6))
                add(d, category='missing_damaged', subcategory='leaking', band=G, component='l_drink', event='E8',
                    product=r.w({'prolon_5day': 70, 'prolon_nextgen': 30}),
                    seg_req=('first_time', 'repeat', 'subscriber', 'hcp_patient', 'employer'))
        # E9 Starter Pack launch: product_request + final sale confusion
        for _ in range(11):
            d = E['E9'][0] + timedelta(r.i(0, (E['E9'][1] - E['E9'][0]).days))
            cat, sub, band = r.w({('product_request', 'sample_pack', N): 45, ('product_request', 'sample_pack', G): 25,
                                  ('price_value', 'bundle_value', P): 15, ('checkout_website', 'promo_code', N): 15})
            add(d, category=cat, subcategory=sub, band=band, product='starter_pack', event='E9',
                seg_req=('first_time', 'repeat'))
        # E10 six serious AEs; two within the last 10 business days before as_of
        aes = [
            (date(2025, 11, 4), 'fainting', 'prolon_5day', ['intervention'], []),
            (date(2026, 1, 13), 'er_hospital', 'prolon_5day', ['hospitalization'], []),
            (date(2026, 3, 19), 'allergic_reaction', 'fast_bar', ['life_threatening', 'intervention'], ['nut_soy_allergy']),
            (date(2026, 6, 22), 'chest_pain', 'prolon_nextgen', ['hospitalization'], []),
            (date(2026, 9, 10), 'fainting', 'prolon_5day', ['intervention'], []),
            (date(2026, 9, 15), 'hypoglycemia_medication', 'prolon_5day', ['hospitalization'], ['glucose_meds']),
        ]
        for d, sub, prod, crit, contra in aes:
            add(d, category='adverse_event', subcategory=sub, band=G, product=prod, ae_criteria=crit,
                contra=contra, event='E10', seg_req=('first_time', 'repeat', 'subscriber', 'hcp_patient', 'employer'),
                channel_req='email')
        # Fresh foreign-material report (received the morning of as_of): open, P0, food_safety, new lot -> live 24h RFR clock
        out.append(dict(received=ct_to_utc(datetime(2026, 9, 16, 8, 40, 12)), planted=True, category='foreign_material_allergen',
                        subcategory='hard_bits', band=G, product='prolon_nextgen', component='soup_minestrone', lot=LOT_RFR,
                        event='RFR', status_req='new', channel_req='email', seg_req=('first_time', 'repeat', 'subscriber')))
        # E12 noise
        for reason, subj, body, n in NOISE_TEMPLATES:
            for _ in range(n):
                d = RANGE_FROM + timedelta(r.i(0, (RANGE_TO - RANGE_FROM).days))
                add(d, noise=reason, event='E12')
        return out

    def background(self, n_target):
        r = self.rng
        days = list(daterange(RANGE_FROM, RANGE_TO))
        lam = [base_lambda(d) for d in days]
        k = n_target / sum(lam)
        attempt = 0
        while True:
            attempt += 1
            counts = [r.poisson(k * l) for l in lam]
            tot = sum(counts)
            if abs(tot - n_target) <= 12 or attempt > 60:
                break
        out = []
        for d, c in zip(days, counts):
            for _ in range(c):
                out.append({'received': self.arrival(d), 'planted': False, 'day': d})
        return out

    # -- customer assignment -------------------------------------------------
    def assign_customers(self, skeletons):
        r = self.rng
        n = len(skeletons)
        idx = list(range(N_CUSTOMERS))
        r.shuffle(idx)
        heavy = idx[:int(N_CUSTOMERS * 0.08)]
        double = idx[int(N_CUSTOMERS * 0.08):int(N_CUSTOMERS * 0.28)]
        cap = [1] * N_CUSTOMERS
        for i in double:
            cap[i] = 2
        for i in heavy:
            cap[i] = 3
        extra = n - sum(cap)
        weights = [3.0 if self.customers[i]['segment'] in ('hcp', 'wholesale') else 1.0 for i in heavy]
        while extra > 0:
            i = r.w(list(zip(heavy, weights)))
            cap[i] += 1
            extra -= 1
        by_seg = defaultdict(list)
        for i, c in enumerate(self.customers):
            by_seg[c['segment']].append(i)
        order = [s for s in skeletons if s['planted']] + r.shuffle([s for s in skeletons if not s['planted']])
        for s in order:
            req = s.get('seg_req')
            pool = [i for i in range(N_CUSTOMERS) if cap[i] > 0 and (req is None or self.customers[i]['segment'] in req)]
            if not pool:
                pool = [i for i in range(N_CUSTOMERS) if req is None or self.customers[i]['segment'] in req]
            i = r.w([(i, cap[i]) for i in pool])
            cap[i] -= 1
            s['cust'] = self.customers[i]

    # -- content selection ---------------------------------------------------
    def choose_channel(self, cust, s):
        if s.get('channel_req'):
            return s['channel_req']
        if cust['segment'] == 'hcp_patient':
            return self.rng.w(CHANNEL_HCP_PATIENT)
        return self.rng.w(CHANNEL_BY_SALES[cust['sales_channel']])

    def choose_category(self, cust, channel, d):
        r = self.rng
        seg = cust['segment']
        if channel == 'survey' and seg not in ('hcp', 'wholesale'):
            table = dict(CAT_W['survey'])          # post-purchase survey topics follow the survey, not the segment
        elif seg in ('hcp', 'lnh_patient', 'hcp_patient', 'employer', 'wholesale'):
            table = dict(CAT_W[seg])
        elif channel in ('amazon_review', 'trustpilot_review'):
            table = dict(CAT_W['reviews'])
        elif channel == 'survey':
            table = dict(CAT_W['survey'])
        elif channel == 'social':
            table = dict(CAT_W['social'])
        else:
            table = dict(CAT_W['contact'])
        # event share shifts (incident-driven complaints arrive through contact channels, not reviews or surveys)
        feedback = channel in ('amazon_review', 'trustpilot_review', 'survey')
        if in_win(d, 'E2') and r.p(0.25):
            return 'checkout_website'
        if in_win(d, 'E3') and not feedback and r.p(0.72):
            return 'shipping_fulfillment'
        if in_win(d, 'E4'):
            if r.p(0.22):
                return 'side_effects'
            if r.p(0.14):
                return 'efficacy_results'
        if in_win(d, 'E7') and r.p(0.22 if feedback else 0.30):
            return 'taste_quality'
        if in_win(d, 'E13') and r.p(0.14):
            return 'praise'
        # background foreign material ~1%
        if channel in ('email', 'chat', 'phone_note') and seg not in ('hcp', 'lnh_patient') and r.p(0.012):
            return 'foreign_material_allergen'
        return r.w(table)

    def choose_sub_band_product(self, cust, cat, d, channel, s):
        r = self.rng
        seg = cust['segment']
        sub = s.get('subcategory')
        band = s.get('band')
        prod = s.get('product')
        tries = 0
        while True:
            tries += 1
            sub_c = sub or r.w(SUB_W[cat])
            if sub_c == 'hcp_code_entry' and seg != 'hcp_patient':
                continue
            if sub_c == 'international_customs' and cust['region'] == 'US':
                continue
            if sub_c == 'heat_damage' and d.month not in (6, 7, 8, 9):
                continue
            if sub_c in ('duplicate_charge',) and not s.get('planted') and r.p(0.5):
                continue
            allowed_bands = {b: w for b, w in BAND_W[cat].items() if b in CORES[sub_c] and w > 0}
            if band and band not in CORES[sub_c]:
                if tries < 30:
                    continue
                band_c = r.pick(list(CORES[sub_c].keys()))
            else:
                band_c = band or r.w(allowed_bands)
            # reviews and surveys skew positive (SPEC section 6: review/survey channels >= 60% positive band)
            if not band and channel in FEEDBACK_POS_SKEW and band_c == G and P in allowed_bands and r.p(FEEDBACK_POS_SKEW[channel]):
                band_c = P
            # E7: Next Gen taste drift. Early-June taste feedback on the Next Gen kit is mostly positive and slides to mostly
            # negative by late July (weekly sentiment index falls well past the -5 pt drift alert).
            if cat == 'taste_quality' and in_win(d, 'E7') and not band:
                frac = (d - E['E7'][0]).days / 60.0
                p_neg = 0.1 + 0.8 * frac
                if r.p(p_neg):
                    band_c = G if G in CORES[sub_c] else band_c
                elif P in CORES[sub_c]:
                    band_c = P
                prod = prod or 'prolon_nextgen'
            # product
            allowed_prods = SUB_PRODUCTS.get(sub_c)
            if prod:
                prod_c = prod
            else:
                table = {p: w for p, w in PRODUCT_W[seg].items() if allowed_prods is None or p in allowed_prods}
                if cat == 'subscription_billing' and seg == 'subscriber':
                    table['subscription_account'] = table.get('subscription_account', 0) + 20
                if cat in ('marketing_email',):
                    table = {'general': 60, 'subscription_account': 20, 'prolon_5day': 20}
                if cat == 'hcp_practitioner':
                    table = {'prolon_5day': 60, 'prolon_nextgen': 25, 'general': 15}
                table = {p: w for p, w in table.items()
                         if not (p == 'guided_health' and d < E['E1'][0]) and not (p == 'starter_pack' and d < E['E9'][0])}
                if not table:
                    if tries < 30:
                        continue
                    table = {'prolon_5day': 1}
                prod_c = r.w(table)
            if allowed_prods is not None and prod_c not in allowed_prods and tries < 40:
                continue
            return sub_c, band_c, prod_c

    # -- text rendering ------------------------------------------------------
    def slots(self, cust, prod, sub, s, received):
        r = self.rng
        comp = s.get('component')
        if not comp:
            if sub in ('l_drink_taste', 'leaking'):
                comp = 'l_drink'
            elif sub == 'olives':
                comp = 'olives'
            elif sub == 'bar_taste':
                comp = r.pick(['l_bar', 'choco_crisp'])
            elif sub in ('soup_taste', 'hard_bits', 'shell_fragment', 'missing_item', 'damaged_seal', 'nausea_gi',
                         'mold_spoilage', 'texture'):
                comp = r.pick(SOUPS) if prod in KIT else r.pick(['l_bar', 'choco_crisp'])
            elif sub == 'crushed_melted':
                comp = 'kale_crackers'
        if prod in NON_KIT_CONSUMER or prod in PROGRAMS:
            comp = None   # a bar, shake, capsule or program has no kit component
        agent = r.pick(AGENTS)
        day = 1 if prod == 'prolon_reset' else r.i(1, 2) if prod == 'prolon_52' else r.i(2, 5)
        lbs = r.i(1, 3) if prod in ('prolon_reset', 'prolon_52') else r.i(4, 9)
        return {
            'first_name': cust['first_name'], 'last_name': cust['last_name'], 'product': PRODUCT_SLOT[prod],
            'component': COMPONENT_LABEL.get(comp, ITEM_WORD.get(prod, 'soup')), 'day': day, 'lbs': lbs,
            'region_name': r.pick(REGION_NAMES.get(cust['region'], REGION_NAMES['OTHER'])), 'start_day': r.pick(START_DAYS),
            'order_id': s.get('order_id') or self.order_id(cust['sales_channel']), 'days_waiting': r.i(5, 21),
            'agent': agent, 'flavor': r.pick(['mint', 'chocolate', 'vanilla']), 'amount': '$%d' % PRICE[prod],
            'lot': s.get('lot') or self.lot(), 'hcp_code': cust['hcp_code'] or self.hcp_code(), 'cycle_n': r.i(1, 6),
            'qdate': (received - timedelta(days=r.i(1, 4))).replace(hour=r.i(9, 17), minute=r.i(0, 59)).strftime('%a, %b %-d, %Y at %-I:%M %p'),
            'phone': '(%03d) 555-%04d' % (r.i(200, 989), r.i(0, 9999)), 'email': cust['email'],
            'practice': cust.get('practice_name') or 'our clinic',
        }, comp, agent

    @staticmethod
    def msg_host(email):
        """Message-ID host for mail a customer sent: their own provider mints the id, not L-Nutra's server."""
        domain = (email or 'example.com').split('@')[-1].lower()
        return MSGID_HOSTS.get(domain, domain)

    def fill(self, t, sl):
        return t.format(**sl)

    def render(self, channel, cat, sub, band, sl, followup=False, mention=None, prod=None):
        r = self.rng
        # Product realism: a line must fit the labelled product (no soup on an L-Pill, no day 4 on a 1-Day Reset, no powder on Next Gen).
        def fits(t):
            return core_fits(t, prod)
        cores = [c for c in CORES[sub][band] if fits(c)] or list(CORES[sub][band])
        r.shuffle(cores)
        used = [cores[0]]
        core1 = self.fill(cores[0], sl)
        core2 = None
        # a second core only when it is not a near-duplicate of the first (variants of one line share their opening words)
        if len(cores) > 1 and r.p(0.45) and ' '.join(cores[1].split()[:3]) != ' '.join(cores[0].split()[:3]):
            used.append(cores[1])
            core2 = self.fill(cores[1], sl)
        if followup:
            core1 = self.fill(r.pick(FOLLOWUP_CORES), sl) + ' ' + core1
        if mention:
            core1 = (mention + ' ' + core1) if r.p(0.55) else (core1 + ' ' + mention)
        # Products whose alias weighs 2 in rules.js (subscription, programs) lose a tie against a stray "ProLon"/"kit":
        # keep the framing text brand-neutral for them.
        neutral = prod in ('subscription_account', 'guided_health', 'lnutra_health')
        openers = [o for o in OPENERS[band] if fits(o) and (not neutral or ('ProLon' not in o and 'kit' not in o))] or list(OPENERS[band])
        closers = [c for c in CLOSERS[band] if fits(c) and (not neutral or ('ProLon' not in c and 'kit' not in c))] or list(CLOSERS[band])
        if channel != 'email' and band == G and r.p(0.75):
            core1 += ' ' + r.pick(AFFECT_G)
        elif channel != 'email' and band == P and r.p(0.4):
            core1 += ' ' + r.pick(AFFECT_P)
        # Subjects never cross sentiment bands: subcategory pool for this band, then the category pool, then a generic line.
        subj_band = band
        pools = [SUB_SUBJECTS.get(sub, {}).get(band, []), SUBJECTS[cat].get(band, []), GENERIC_SUBJECTS[band]]
        subj_pool = []
        for pool in pools:
            subj_pool = [t for t in pool if fits(t)]
            if subj_pool:
                break
        subject = self.fill(r.pick(subj_pool), sl)
        if followup:
            subject = 'Re: ' + subject
        opener = self.fill(r.pick(openers), sl)
        closer = self.fill(r.pick(closers), sl)
        if channel == 'email':
            paras = []
            has_opener, has_closer = r.p(OPENER_P), r.p(CLOSER_P)
            if has_opener:
                paras.append(opener)
            if band == G and not has_opener and not has_closer and r.p(0.6):
                core1 += ' ' + r.pick(AFFECT_G)
            paras.append(core1 + (' ' + core2 if core2 else ''))
            if has_closer:
                paras.append(closer)
            body = '\n\n'.join(paras)
            if r.p(0.6):
                body += '\n\n' + self.fill(r.pick(SIGNOFFS), sl)
            if r.p(0.10) and not neutral:
                tails = QUOTED_TAILS if str(sl['order_id']).startswith('#') else QUOTED_TAILS[1:]
                body += self.fill(r.pick(tails), sl) + self.fill(r.pick(SIGNATURES), sl)
            return subject, body, subj_band, used
        if channel == 'chat':
            lines = ['Customer: ' + opener + ' ' + core1, 'Agent (%s): ' % sl['agent'] + self.fill(r.pick(CHAT_AGENT_LINES[band]), sl)]
            lines.append('Customer: ' + (core2 or closer))
            lines.append('Agent (%s): ' % sl['agent'] + self.fill(r.pick(CHAT_AGENT_CLOSE[band]), sl))
            if core2:
                lines.append('Customer: ' + closer)
            return subject, '\n'.join(lines), subj_band, used
        if channel == 'survey':
            return subject, core1 + ((' ' + core2) if core2 and r.p(0.4) else ''), subj_band, used
        if channel in ('amazon_review', 'trustpilot_review'):
            body = core1 + (' ' + core2 if core2 else '') + ' ' + r.pick(REVIEW_VERDICT[band])
            return subject, body, subj_band, used
        if channel == 'social':
            tag = r.pick([' #prolon', ' #fastingmimicking', ' @prolon', '', ' #fmd'])
            if neutral:
                tag = r.pick([' #longevity', '', ' #healthspan'])
            return subject, ('@ProLon ' if not neutral else '') + core1 + tag, subj_band, used
        if channel == 'phone_note':
            agent_name = sl['agent'].rstrip('.') + '.'
            body = 'Call summary by %s Caller %s reports: "%s"' % (agent_name, sl['first_name'], core1)
            if core2:
                body += ' Also: "%s"' % core2
            body += ' Action: ' + r.pick(PHONE_ACTIONS[band])
            return subject, body, subj_band, used
        if channel == 'hcp_portal':
            body = '%s (%s): %s' % (sl['first_name'] + ' ' + sl['last_name'], sl['practice'], core1)
            if core2:
                body += ' ' + core2
            body += ' ' + closer
            return subject, body, subj_band, used
        return subject, opener + ' ' + core1 + ' ' + closer, subj_band, used

    # -- record assembly -----------------------------------------------------
    def urgency_for(self, cat, sub, band, sent, nps, seg, serious, food_safety, contra, text):
        p0_words = ('lawyer', 'attorney', 'legal action', 'BBB', 'chargeback', 'dispute', 'FDA', 'reporter')
        if serious or food_safety or 'pregnancy' in contra or 'minor' in contra or any(w in text for w in p0_words):
            return 'P0'
        if cat == 'adverse_event' or sub in ('duplicate_charge', 'unauthorized_signup', 'post_cancel_shipment', 'lost', 'leaking'):
            return 'P1'
        if cat == 'side_effects' and sub not in ('hunger', 'cold'):
            return 'P1'
        if nps is not None and nps <= 6 and sent <= -0.5:
            return 'P1'
        if seg in ('hcp', 'wholesale') and band == G:
            return 'P1'
        if cat in ('praise', 'product_request', 'marketing_email'):
            return 'P3'
        if cat in ('usage_guidance', 'hcp_practitioner', 'efficacy_results') and band != G:
            return 'P3' if self.rng.p(0.5) else 'P2'
        return 'P2'

    def build_record(self, s):
        r = self.rng
        cust = s['cust']
        received = s['received']
        d_local = (received - timedelta(hours=6)).date()
        seg = cust['segment']
        if s.get('noise'):
            return self.build_noise(s)
        channel = self.choose_channel(cust, s)
        cat = s.get('category') or self.choose_category(cust, channel, d_local)
        sub, band, prod = self.choose_sub_band_product(cust, cat, d_local, channel, s)
        sl, comp, agent = self.slots(cust, prod, sub, s, received)
        language = 'en'
        subj_band, used_cores = None, []
        # Under half of customers name what they bought in so many words (SPEC section 6); the rest are settled by the subject alias below.
        want_mention = prod != 'general' and r.p(MENTION_P)
        mention = self.fill(r.pick(MENTIONS[prod]), sl) if want_mention else None
        # non-English short bodies for DE/IT/AE
        if cust['region'] in ('DE', 'IT', 'AE') and not s.get('planted') and channel in ('email', 'chat') and r.p(0.62):
            lang = 'de' if cust['region'] == 'DE' else 'it' if cust['region'] == 'IT' else r.pick(['de', 'it'])
            cat, sub, subject, body = r.pick(NON_EN[lang])
            band = NON_EN_BAND_HINT.get(cat, G)
            allowed = SUB_PRODUCTS.get(sub)
            if allowed and prod not in allowed:
                prod = 'prolon_5day'
            sl, comp, agent = self.slots(cust, prod, sub, s, received)
            subject, body = self.fill(subject, sl), self.fill(body, sl)
            if want_mention and prod != 'subscription_account':
                body += ' ' + MENTIONS_NON_EN[lang].format(alias=PRODUCT_LABEL[prod])
            language = 'other'
        else:
            subject, body, subj_band, used_cores = self.render(channel, cat, sub, band, sl, followup=s.get('followup', False), mention=mention, prod=prod)
        # restricted extras for LNH / HCP patients
        if seg == 'lnh_patient' and language == 'en' and r.p(0.6):
            body += ' ' + r.pick(["For context, my A1c was 7.1 at my last visit and I take metformin twice a day.",
                                  "My L-Nutra Health dietitian has my latest labs, A1c 6.8.",
                                  "I am in the diabetes remission program and my doctor prescribed the monthly cycles."])
        if s.get('lot') and s['lot'] not in body:
            body += ' Lot number ' + s['lot'] + ' is printed on the box.'
        # When the body alone does not settle the product (a stray "kit" or "ProLon" outweighs it, or nothing names it), most
        # customers name it in the subject line, the way real mail does ("Next Gen: hard bits in the soup"). Never touches rules.js.
        if prod in PRODUCT_SHORT and detect_product(body, subject) != prod and (want_mention or r.p(SUBJECT_ALIAS_P)):
            alias = PRODUCT_SHORT[prod]
            if subject.startswith('Re: '):
                subject = 'Re: ' + alias + ': ' + subject[4:]
            elif r.p(0.5):
                subject = alias + ': ' + subject
            else:
                subject = subject + ' (' + alias + ')'
        # sentiment
        if language == 'other':
            sent, sent_min, label = 0.0, 0.0, 'unscored'
        else:
            if band == P:
                sent = r.u(0.25, 0.85)
            elif band == N:
                sent = r.u(-0.12, 0.12)
            else:
                sent = r.u(-0.85, -0.2)
            if cat == 'taste_quality' and in_win(d_local, 'E7') and prod == 'prolon_nextgen':
                drift = 0.24 * (d_local - E['E7'][0]).days / 60.0
                lo = {P: 0.25, N: -0.12, G: -0.85}[band]
                sent = max(lo, sent - drift)
            sent_min = max(-1.0, sent - r.u(0.0, 0.3))
            label = band
        sent, sent_min = round(sent, 3), round(sent_min, 3)
        # scores
        nps = rating = csat = None
        # NPS comes from the post-purchase survey plus the few emails that answer a survey link (SPEC section 6: ~8% of emails).
        if channel == 'survey' or (channel == 'email' and r.p(EMAIL_NPS_P)):
            nps = {P: r.w({10: 45, 9: 35, 8: 15, 7: 5}), N: r.w({9: 15, 8: 40, 7: 45}),
                   G: r.w({0: 12, 1: 8, 2: 12, 3: 18, 4: 14, 5: 12, 6: 9, 7: 10, 8: 5}), 'unscored': r.i(3, 9)}[band if language == 'en' else 'unscored']
        if channel in ('amazon_review', 'trustpilot_review'):
            rating = {P: r.w({5: 70, 4: 30}), N: 3, G: r.w({1: 55, 2: 45})}[band]
        # safety
        serious = cat == 'adverse_event' and sub in ('fainting', 'er_hospital', 'allergic_reaction', 'hypoglycemia_medication', 'chest_pain')
        is_ae = cat == 'adverse_event' or (cat == 'side_effects' and sub not in ('hunger', 'cold', 'inulin_ibs') and language == 'en')
        food_safety = cat == 'foreign_material_allergen' and sub in ('hard_bits', 'shell_fragment', 'mold_spoilage', 'undeclared_allergen')
        contra = list(s.get('contra', []))
        if sub in ('allergen_exposure', 'allergic_reaction') and 'nut_soy_allergy' not in contra:
            contra.append('nut_soy_allergy')
        if sub == 'hypoglycemia_medication' and 'glucose_meds' not in contra:
            contra.append('glucose_meds')
        if seg == 'lnh_patient' and 'metformin' in body and r.p(0.5):
            contra.append('glucose_meds')
        # occasional P0 wording and contraindication questions in background records
        if not s.get('planted') and language == 'en':
            if cat in ('subscription_billing', 'customer_service') and band == G and r.p(0.03):
                body += ' If this is not fixed this week I am filing a chargeback and a BBB complaint.'
            if cat == 'usage_guidance' and sub == 'medications' and r.p(0.12):
                body += ' Also, I am 14 weeks pregnant, is the program safe for me?'
                contra.append('pregnancy')
            elif cat == 'usage_guidance' and sub == 'general_question' and r.p(0.06):
                body += ' It is for my 16-year-old daughter, is that okay?'
                contra.append('minor')
        claim = any(w in body.lower() for w in ('misleading', 'false advertis', 'clinically proven', 'autophagy', 'remission', 'biological age', 'scam'))
        cancel_intent = any(w in body.lower() for w in ('cancel', 'unsubscribe', 'refund'))
        restricted = seg in ('lnh_patient', 'hcp_patient') or any(w in body.lower() for w in ('a1c', 'hba1c', 'my doctor prescribed', 'diagnos'))
        urgency = self.urgency_for(cat, sub, band, sent, nps, seg, serious, food_safety, contra, body)
        # order id: order-related categories mostly carry one
        has_order = cat in ('subscription_billing', 'shipping_fulfillment', 'missing_damaged', 'checkout_website',
                            'customer_service', 'foreign_material_allergen', 'taste_quality')
        order_id = sl['order_id'] if (('{order_id}' in body or has_order) and r.p(0.85 if has_order else 0.3)) or '#' in body or 'PP-' in body or '113-' in body else None
        if '{' not in body and order_id is None and sl['order_id'] in body:
            order_id = sl['order_id']
        lot = sl['lot'] if (cat == 'foreign_material_allergen' or sl['lot'] in body or r.p(0.02)) else None
        hcp_code = cust['hcp_code'] if seg in ('hcp', 'hcp_patient') else (sl['hcp_code'] if sl['hcp_code'] in body else None)
        # status & timing: the age bucket picks the status table (open work concentrates in the last 21 days and never
        # outlives OPEN_MAX_DAYS here; mark_aging() adds the few deliberately old tickets afterwards).
        age_days = (AS_OF_UTC - received).days
        age_hours = (AS_OF_UTC - received).total_seconds() / 3600.0
        status = r.w(status_table(age_hours))
        # Regulatory realism: a serious AE or food-safety report older than REG_OPEN_DAYS is closed out (resolved_at set);
        # only the two recent serious AEs stay escalated with live MedWatch clocks, and the fresh RFR report stays open.
        regulatory = serious or food_safety
        if regulatory and age_days > REG_OPEN_DAYS:
            status = 'resolved'
        elif serious:
            status = 'escalated'
        if s.get('status_req'):
            status = s['status_req']
        first_resp = resolved = None
        reopen_count = 0
        frt_median = {'P0': 0.7, 'P1': 2.0}.get(urgency, 5.0)
        if status not in ('new', 'open'):
            if not (status == 'resolved' and r.p(0.12)):
                first_resp = received + timedelta(hours=r.lognormal_hours(frt_median, 0.9))
            if status == 'resolved':
                base = first_resp or received
                resolved = base + timedelta(hours=r.lognormal_hours(30, 1.0))
                if r.p(0.03):
                    reopen_count = 1
            if status == 'reopened':
                reopen_count = r.w({1: 80, 2: 20})
        # keep timestamps inside the demo clock (regulatory records are clamped so they stay resolved)
        if regulatory and status == 'resolved':
            if first_resp is None:
                first_resp = received + timedelta(hours=r.lognormal_hours(frt_median, 0.5))
            latest = AS_OF_UTC - timedelta(hours=r.i(6, 72))
            if resolved is None or resolved > latest:
                resolved = max(first_resp + timedelta(hours=r.u(1, 12)), min(latest, first_resp + timedelta(hours=r.lognormal_hours(30, 0.6))))
        if first_resp and first_resp > AS_OF_UTC:
            first_resp = None
            status = 'open' if status != 'new' else 'new'
            resolved = None
        if resolved and resolved > AS_OF_UTC:
            if age_hours > OPEN_MAX_DAYS * 24:
                # an old ticket that took unusually long still closed before the clock: pull it inside the window
                resolved = AS_OF_UTC - timedelta(hours=r.u(24, 24 * 7))
                if first_resp and first_resp > resolved:
                    first_resp = resolved - timedelta(hours=r.u(1, 12))
            else:
                resolved = None
                status = 'pending'
        if status == 'resolved' and r.p(0.45):
            csat = {P: r.w({5: 60, 4: 40}), N: r.w({4: 50, 3: 50}), G: r.w({1: 25, 2: 30, 3: 30, 4: 10, 5: 5})}[band]
            if sub == 'great_agent':
                csat = 5
        escalated_to = 'none'
        if urgency == 'P0':
            escalated_to = 'medical' if (serious or contra) else 'quality_regulatory'
        elif urgency == 'P1' and cat == 'subscription_billing':
            escalated_to = 'finance'
        elif claim and band == G:
            escalated_to = 'legal'
        elif status == 'escalated':
            escalated_to = 'cs_lead'
        assignee = None if status == 'new' else (agent if r.p(0.88) else None)
        tags = []
        if cat == 'foreign_material_allergen' and lot in (LOT_E6, LOT_RFR):
            tags.append('lot-hold')
        if s.get('followup'):
            tags.append('repeat-contact')
        if r.p(0.04):
            tags.append('vip')
        notes = []
        if status in ('escalated', 'pending') and r.p(0.35) and first_resp:
            notes.append({'at': iso(first_resp + timedelta(hours=1)), 'by': agent,
                          'text': r.pick(['Called customer, left voicemail.', 'Replacement kit requested from fulfillment.',
                                          'Sent to Quality with photos and lot number.', 'Awaiting bank confirmation.'])})
        has_att = (cat in ('foreign_material_allergen', 'missing_damaged') and r.p(0.55)) or r.p(0.03)
        secondary = []
        if r.p(0.12):
            pair = {'side_effects': 'efficacy_results', 'subscription_billing': 'customer_service',
                    'shipping_fulfillment': 'customer_service', 'taste_quality': 'price_value',
                    'efficacy_results': 'praise', 'missing_damaged': 'shipping_fulfillment',
                    'checkout_website': 'subscription_billing', 'price_value': 'efficacy_results'}.get(cat)
            if pair:
                secondary.append(pair)
        variant = r.pick(VARIANTS[prod]) if prod in VARIANTS else None
        msgid = None
        if channel == 'email':
            self.msgid_n += 1
            msgid = '<%s.%d@%s>' % (self.rng.hexs(12), self.msgid_n, self.msg_host(cust['email']))
        from_email = cust['email'] if channel in ('email', 'chat', 'survey', 'hcp_portal') else None
        if channel in ('amazon_review', 'trustpilot_review', 'social'):
            from_name = cust['first_name'] + ' ' + cust['last_name'][0] + '.'
        else:
            from_name = cust['display_name']
        rec = {
            'id': None, 'schema_version': SCHEMA_VERSION, 'received_at': iso(received), 'channel': channel,
            'sales_channel': cust['sales_channel'], 'from_name': from_name, 'from_email': from_email,
            'subject': subject, 'text': body, 'language': language, 'has_attachment': has_att,
            'product': prod, 'product_variant': variant, 'kit_component': comp, 'product_class': PRODUCT_CLASS[prod],
            'category': cat, 'subcategory': sub, 'secondary_categories': secondary,
            'sentiment': sent, 'sentiment_min': sent_min, 'sentiment_label': label,
            'nps': nps, 'rating': rating, 'csat': csat, 'urgency': urgency, 'status': status,
            'first_response_at': iso(first_resp) if first_resp else None,
            'resolved_at': iso(resolved) if resolved else None, 'reopen_count': reopen_count,
            'service_fields_source': 'seed', 'escalated_to': escalated_to,
            'is_adverse_event': is_ae, 'serious_ae': serious,
            'ae_criteria': list(s.get('ae_criteria', [])) if serious else [],
            'contraindication_flags': sorted(set(contra)), 'food_safety': food_safety,
            'lot_number': lot, 'order_id': order_id, 'hcp_code': hcp_code,
            'claim_related': claim, 'cancel_intent': cancel_intent, 'restricted': restricted,
            'customer_id': cust['customer_id'], 'segment': seg, 'region': cust['region'],
            'thread_id': s.get('thread_id') or self.hex_id('t_'), 'is_first_contact': not s.get('followup', False),
            'message_id': msgid, 'source': 'seed', 'is_noise': False, 'noise_reason': None,
            'assignee': assignee, 'tags': tags, 'notes': notes,
            'classifier': {'confidence': round(r.u(0.6, 0.95), 2), 'rule_category': cat, 'rule_subcategory': sub,
                           'rule_product': prod, 'manual_override': False, 'needs_review': False},
            '_band': band, '_event': s.get('event'), '_dt': received, '_subj_band': subj_band, '_cores': used_cores,
        }
        return rec

    def build_noise(self, s):
        r = self.rng
        cust = s['cust']
        received = s['received']
        reason = s['noise']
        tpl = next(t for t in NOISE_TEMPLATES if t[0] == reason)
        orig = r.pick(['Your ProLon order has shipped', 'Re: Your recent order', 'How was your ProLon experience?',
                       'Your subscription renews soon'])
        nl = r.pick(NEWSLETTERS)
        sl = {'orig': orig, 'ret': (received + timedelta(days=r.i(3, 10))).strftime('%B %-d'), 'first_name': cust['first_name'],
              'last_name': cust['last_name'], 'email': cust['email'], 'nl': nl[0], 'nl_body': nl[1]}
        subject, body = tpl[1].format(**sl), tpl[2].format(**sl)
        from_email = {'auto_reply': cust['email'], 'bounce': 'mailer-daemon@mail.prolonlife.com',
                      'newsletter': 'hello@' + r.pick(['wellnessweekly.co', 'longevityinsider.com'])}[reason]
        from_name = {'auto_reply': cust['display_name'], 'bounce': 'Mail Delivery System',
                     'newsletter': 'Wellness Weekly'}[reason]
        self.msgid_n += 1
        msg_host = 'mail.prolonlife.com' if reason == 'bounce' else self.msg_host(from_email)
        return {
            'id': None, 'schema_version': SCHEMA_VERSION, 'received_at': iso(received), 'channel': 'email',
            'sales_channel': cust['sales_channel'], 'from_name': from_name, 'from_email': from_email,
            'subject': subject, 'text': body, 'language': 'en', 'has_attachment': False,
            'product': 'general', 'product_variant': None, 'kit_component': None, 'product_class': 'none',
            'category': 'other_noise', 'subcategory': reason, 'secondary_categories': [],
            'sentiment': 0.0, 'sentiment_min': 0.0, 'sentiment_label': 'neutral', 'nps': None, 'rating': None,
            'csat': None, 'urgency': 'P3', 'status': 'closed_noise', 'first_response_at': None, 'resolved_at': None,
            'reopen_count': 0, 'service_fields_source': 'seed', 'escalated_to': 'none', 'is_adverse_event': False,
            'serious_ae': False, 'ae_criteria': [], 'contraindication_flags': [], 'food_safety': False,
            'lot_number': None, 'order_id': None, 'hcp_code': None, 'claim_related': False, 'cancel_intent': False,
            'restricted': False, 'customer_id': cust['customer_id'], 'segment': cust['segment'],
            'region': cust['region'], 'thread_id': self.hex_id('t_'), 'is_first_contact': True,
            'message_id': '<%s.%d@%s>' % (r.hexs(12), self.msgid_n, msg_host), 'source': 'seed',
            'is_noise': True, 'noise_reason': reason, 'assignee': None, 'tags': [], 'notes': [],
            'classifier': {'confidence': 0.95, 'rule_category': 'other_noise', 'rule_subcategory': reason,
                           'rule_product': 'general', 'manual_override': False, 'needs_review': False},
            '_band': N, '_event': 'E12', '_dt': received,
        }

    # -- threads / follow-ups ------------------------------------------------
    def mark_followups(self, skeletons):
        """Second contact within 30 days about a complaint becomes a follow-up on the same thread."""
        r = self.rng
        by_cust = defaultdict(list)
        for s in skeletons:
            if not s.get('noise'):
                by_cust[s['cust']['customer_id']].append(s)
        for cid, items in by_cust.items():
            items.sort(key=lambda s: s['received'])
            for prev, cur in zip(items, items[1:]):
                gap = (cur['received'] - prev['received']).days
                if cur.get('planted') or prev.get('noise') or gap > 30 or gap < 1:
                    continue
                if prev.get('_rec') and prev['_rec']['_band'] == G and prev['_rec']['category'] in (
                        'subscription_billing', 'shipping_fulfillment', 'missing_damaged', 'checkout_website',
                        'customer_service', 'taste_quality', 'price_value') and r.p(0.55):
                    pr = prev['_rec']
                    cur['followup'] = True
                    cur['thread_id'] = pr['thread_id']
                    cur['order_id'] = pr['order_id']
                    cur['product'] = pr['product']
                    if r.p(0.4):
                        cur['category'], cur['subcategory'] = 'customer_service', 'no_response'
                    else:
                        cur['category'], cur['subcategory'] = pr['category'], pr['subcategory']
                    cur['band'] = G
                    cur['channel_req'] = 'email' if pr['channel'] in ('email', 'chat', 'phone_note') else pr['channel']
                    if cur['channel_req'] in ('amazon_review', 'trustpilot_review', 'social', 'survey'):
                        cur['channel_req'] = 'email'

    # -- aging backlog post-pass ------------------------------------------------
    def mark_aging(self, records):
        """Reopen up to AGING_MAX resolved background tickets aged AGING_WINDOW_DAYS: one 'open' ticket that fell through
        the cracks (no first response, so it breaches its SLA) and the rest 'pending' on the customer or the bank.
        Uses its own RNG stream so the main record stream stays byte-identical whichever tickets qualify."""
        r = R(SEED + 7)
        lo, hi = AGING_WINDOW_DAYS
        cands = []
        for rec in records:
            age_h = (AS_OF_UTC - rec['_dt']).total_seconds() / 3600.0
            if not (lo * 24 < age_h <= hi * 24):
                continue
            if rec['status'] != 'resolved' or rec['is_noise'] or rec['serious_ae'] or rec['food_safety'] or rec['_event']:
                continue
            if rec['language'] != 'en' or rec['_band'] != G or rec['urgency'] not in ('P2', 'P3'):
                continue
            if rec['category'] not in ('subscription_billing', 'customer_service', 'shipping_fulfillment', 'missing_damaged',
                                       'checkout_website', 'taste_quality', 'price_value'):
                continue
            cands.append(rec)
        if not cands:
            return
        cands.sort(key=lambda x: x['_dt'])
        n = min(AGING_MAX, len(cands))
        step = len(cands) / float(n)
        picked = [cands[int(i * step)] for i in range(n)]
        for i, rec in enumerate(picked):
            rec['resolved_at'] = None
            rec['csat'] = None
            rec['reopen_count'] = 0
            rec['tags'] = [t for t in rec['tags'] if t != 'vip'] + ['aging']
            if i == 0:
                rec['status'] = 'open'
                rec['first_response_at'] = None
                rec['assignee'] = None
                rec['notes'] = []
                if rec['escalated_to'] == 'cs_lead':
                    rec['escalated_to'] = 'none'
            else:
                rec['status'] = 'pending'
                first_resp = rec['_dt'] + timedelta(hours=r.lognormal_hours(5.0, 0.6))
                rec['first_response_at'] = iso(first_resp)
                agent = rec['assignee'] or r.pick(AGENTS)
                rec['assignee'] = agent
                rec['notes'] = [{'at': iso(first_resp + timedelta(hours=r.u(1, 6))), 'by': agent,
                                 'text': r.pick(['Awaiting bank confirmation on the refund; customer updated.',
                                                 'Waiting on customer photos of the damaged box before replacement.',
                                                 'Carrier claim filed; waiting on FedEx investigation.'])}]

    # -- customers post-pass -------------------------------------------------
    def finish_customers(self, records):
        r = self.rng
        by_cust = defaultdict(list)
        for rec in records:
            by_cust[rec['customer_id']].append(rec)
        for c in self.customers:
            recs = by_cust.get(c['customer_id'], [])
            seg = c['segment']
            first_rec = min((x['_dt'] for x in recs), default=None)
            if first_rec and datetime.strptime(c['first_seen'], '%Y-%m-%dT%H:%M:%SZ') > first_rec:
                c['first_seen'] = iso(first_rec - timedelta(days=r.i(1, 200)))
            base_price = PRICE['prolon_5day']
            c['orders_12m'] = {'first_time': 1, 'repeat': r.i(2, 4), 'subscriber': r.i(3, 8), 'hcp': r.i(4, 20),
                               'hcp_patient': r.i(1, 3), 'lnh_patient': r.i(2, 6), 'employer': r.i(1, 3),
                               'wholesale': r.i(6, 30)}[seg]
            c['ltv_usd'] = int(round(c['orders_12m'] * base_price * r.u(0.7, 1.3)))
            base = {'subscriber': 0.97, 'repeat': 0.48, 'first_time': 0.15, 'hcp_patient': 0.15, 'lnh_patient': 0.6,
                    'employer': 0.1, 'hcp': 0.15, 'wholesale': 0.3}[seg]
            billing = any(x['category'] == 'subscription_billing' and x['_band'] == G for x in recs)
            detractor = any(x['nps'] is not None and x['nps'] <= 6 for x in recs)
            # Cancellations follow what the churn features can see at as_of: negative, billing, cancel-intent or still-open
            # records inside the last 90 days (strongest inside 30). A customer with no recent signal rarely cancels.
            def signal(x):
                return x['_band'] == G or x['category'] == 'subscription_billing' or x['cancel_intent'] or x['status'] in OPEN_STATUSES or (x['nps'] is not None and x['nps'] <= 6)
            recent90 = [x for x in recs if signal(x) and (AS_OF_UTC - x['_dt']).days <= 90]
            recent30 = [x for x in recent90 if (AS_OF_UTC - x['_dt']).days <= 30]
            if r.p(base):
                if recent30:
                    p_cancel = 0.55
                elif recent90:
                    p_cancel = 0.38
                else:
                    p_cancel = 0.035
                if recent90 and (billing or any(x['cancel_intent'] for x in recent90)):
                    p_cancel = min(0.85, p_cancel * 1.4)
                status = 'cancelled' if r.p(p_cancel) else ('paused' if r.p(0.10) else 'active')
                cadence = r.w({1: 55, 2: 25, 3: 15, 4: 5})
                prod = r.w({'prolon_5day': 45, 'prolon_nextgen': 15, 'fast_bar': 15, 'fasting_shake': 10, 'l_protein': 8, 'l_pill': 7})
                c['subscriber'] = True
                c['subscription_status'] = status
                c['subscription_cadence_months'] = cadence
                c['subscription_value_12m_usd'] = int(round(PRICE[prod] * 12 / cadence * 0.85))
                if status == 'cancelled':
                    if recent90:
                        anchor = max(x['_dt'] for x in recent90)
                        cancelled_at = anchor + timedelta(days=r.i(0, 10))
                    else:
                        cancelled_at = ct_to_utc(datetime(2026, r.i(1, 9), r.i(1, 28), 12))
                    if cancelled_at > AS_OF_UTC:
                        cancelled_at = AS_OF_UTC - timedelta(hours=r.i(2, 96))
                    c['cancelled_at'] = iso(cancelled_at)
                    c['cancel_reason'] = 'billing dispute' if billing else r.pick(CANCEL_REASONS)
            c['restricted'] = seg in ('lnh_patient', 'hcp_patient')

    # -- main -----------------------------------------------------------------
    def run(self):
        check_templates()
        self.build_practices()
        self.build_customers()
        orders = self.build_orders()
        planted = self.planted()
        bg = self.background(TARGET_MID - len(planted))
        skeletons = planted + bg
        self.assign_customers(skeletons)
        # first pass: build records in date order so follow-ups can reference the earlier one
        skeletons.sort(key=lambda s: s['received'])
        for s in skeletons:
            s['_rec'] = self.build_record(s)
        self.mark_followups(skeletons)
        for s in skeletons:
            if s.get('followup'):
                s['_rec'] = self.build_record(s)
        records = [s['_rec'] for s in skeletons]
        records.sort(key=lambda x: x['_dt'])
        for i, rec in enumerate(records):
            rec['id'] = 'r_%06d' % (i + 1)
        self.mark_aging(records)
        self.finish_customers(records)
        realism_check(records)
        self.records = records
        return records, orders

    def meta(self):
        def ev(id_, key, title, detector, expected):
            a, b = E.get(key, (None, None))
            return {'id': id_, 'from': a.isoformat() if a else RANGE_FROM.isoformat(),
                    'to': b.isoformat() if b else RANGE_TO.isoformat(), 'title': title, 'detector': detector,
                    'expected': expected}
        return {
            'schema_version': SCHEMA_VERSION, 'seed': SEED, 'generated': GENERATED, 'as_of': iso(AS_OF_UTC),
            'range': [RANGE_FROM.isoformat(), RANGE_TO.isoformat()], 'timezone': TIMEZONE, 'agents': AGENTS,
            'planted_events': [
                ev('E1', 'E1', 'Guided Health launch', 'emerging', {'unit': 'product', 'value': 'guided_health', 'status': 'new', 'min_recent': 3}),
                ev('E2', 'E2', 'Black Friday / Cyber Monday surge', 'anomaly', {'metric': 'volume', 'multiplier': 1.6, 'category_share': {'checkout_website': 0.25}}),
                ev('E3', 'E3', 'Holiday carrier incident', 'anomaly', {'metric': 'volume', 'multiplier': 2.8, 'min_z': 3, 'granularity': 'week', 'category': 'shipping_fulfillment', 'neg_share': 0.7}),
                ev('E4', 'E4', 'New Year reset wave', 'anomaly', {'metric': 'volume', 'multiplier': 1.8, 'category_share': {'side_effects': 0.22}}),
                ev('E5', 'E5', 'Double-charge bug', 'p1_cluster', {'subcategory': 'duplicate_charge', 'count': 14, 'hours': 72, 'urgency': 'P1', 'bigram': 'charged twice', 'status': 'new'}),
                ev('E6', 'E6', 'Foreign material ramp, lot ' + LOT_E6, 'emerging', {'unit': 'lot', 'value': LOT_E6, 'weekly': [1, 6, 11], 'min_z': 3, 'as_of': '2026-05-31', 'urgency': 'P0', 'food_safety': True, 'kit_component': 'soup_minestrone_quinoa', 'product': 'prolon_nextgen'}),
                dict(ev('E7', 'E7', 'Next Gen taste drift', 'sentiment_drift', {'category': 'taste_quality', 'product': 'prolon_nextgen', 'index_delta_pts': -12}),
                     category='taste_quality', product='prolon_nextgen'),
                ev('E8', 'E8', 'L-Drink leak ramp', 'emerging', {'unit': 'subcategory', 'value': 'leaking', 'weekly': [2, 6, 11], 'min_lift': 3, 'kit_component': 'l_drink'}),
                ev('E9', 'E9', 'Longevity Starter Pack launch', 'emerging', {'unit': 'product', 'value': 'starter_pack', 'status': 'new', 'phrase': 'final sale'}),
                ev('E10', None, 'Six serious adverse events', 'ae_received', {'serious_ae_count': 6, 'recent_business_days': 10, 'recent_count': 2, 'subcategories': ['fainting', 'fainting', 'er_hospital', 'chest_pain', 'allergic_reaction', 'hypoglycemia_medication']}),
                ev('E11', None, 'Restricted queue (L-Nutra Health and practitioner patients)', 'restricted', {'segments': ['lnh_patient', 'hcp_patient'], 'all_restricted': True}),
                ev('E12', None, 'Noise: auto-replies, bounces, newsletters', 'noise', {'auto_reply': 6, 'bounce': 3, 'newsletter': 2, 'status': 'closed_noise'}),
                ev('E13', 'E13', 'Back-to-routine September lift', 'anomaly', {'metric': 'volume', 'multiplier': 1.15, 'praise_share_up': True}),
            ],
        }


# ---------------------------------------------------------------------------
# Validation and stats
# ---------------------------------------------------------------------------
RE_KIT_TOKENS = re.compile(r"\bsoups?\b|\bl-drink\b|\bolives?\b|\bkale crackers\b|\bminestrone\b|\bnext cycle\b", re.I)


def realism_check(records):
    """Template realism the classifier cannot see: subjects share the body's sentiment band, non-kit products never talk about
    soups or day 4, Next Gen never talks about powder, no double periods, no shaker (no ProLon kit ships one)."""
    for rec in records:
        if rec['is_noise'] or rec['language'] != 'en':
            continue
        text, subj, prod = rec['text'], rec['subject'], rec['product']
        assert rec['_subj_band'] in (None, rec['_band']), ('subject band', rec['id'], subj, rec['_band'])
        assert '.. ' not in text and 'shaker' not in text.lower(), ('typo', rec['id'], text[:80])
        if prod in NON_KIT_CONSUMER:
            assert not RE_MULTIDAY.search(text) and not RE_KIT_TOKENS.search(text), ('kit token on ' + prod, rec['id'], text[:120])
        if prod == 'prolon_reset':
            assert not RE_MULTIDAY.search(text), ('multi-day on reset', rec['id'], text[:120])
        if prod == 'prolon_nextgen':
            assert not re.search(r'powder|dissolve', text, re.I), ('powder on Next Gen', rec['id'], text[:120])


def validate(seed):
    recs = seed['records']
    n = len(recs)
    assert TARGET_RECORDS[0] <= n <= TARGET_RECORDS[1], 'record count %d' % n
    assert len(seed['customers']) == N_CUSTOMERS
    assert len(seed['practices']) == N_PRACTICES
    cust_ids = {c['customer_id'] for c in seed['customers']}
    assert len(cust_ids) == N_CUSTOMERS
    ids = set()
    prev = ''
    for i, r in enumerate(recs):
        assert r['id'] == 'r_%06d' % (i + 1)
        assert r['received_at'] >= prev, 'not sorted at %s' % r['id']
        prev = r['received_at']
        ids.add(r['id'])
        assert r['channel'] in CHANNELS and r['sales_channel'] in SALES_CHANNELS
        assert r['product'] in PRODUCTS and r['product_class'] == PRODUCT_CLASS[r['product']]
        assert r['kit_component'] is None or r['kit_component'] in KIT_COMPONENTS
        assert r['category'] in CATEGORIES and r['subcategory'] in SUBCATEGORIES[r['category']], (r['category'], r['subcategory'])
        assert all(c in CATEGORIES for c in r['secondary_categories'])
        assert r['language'] in LANGUAGES and r['sentiment_label'] in SENTIMENT_LABELS
        assert -1 <= r['sentiment'] <= 1 and -1 <= r['sentiment_min'] <= r['sentiment'] + 1e-9
        if r['language'] == 'other':
            assert r['sentiment_label'] == 'unscored'
        else:
            band = r['sentiment_label']
            s = r['sentiment']
            if band == 'positive':
                assert 0.25 <= s <= 0.85
            elif band == 'neutral':
                assert -0.12 <= s <= 0.12
            elif band == 'negative':
                assert -0.95 <= s <= -0.2
        assert r['nps'] is None or 0 <= r['nps'] <= 10
        assert r['rating'] is None or 1 <= r['rating'] <= 5
        assert r['csat'] is None or 1 <= r['csat'] <= 5
        assert r['urgency'] in URGENCIES and r['status'] in STATUSES
        assert r['escalated_to'] in ESCALATION_TARGETS
        assert all(c in AE_CRITERIA for c in r['ae_criteria'])
        assert all(c in CONTRA_FLAGS for c in r['contraindication_flags'])
        assert r['segment'] in SEGMENTS and r['region'] in REGIONS
        assert r['service_fields_source'] == 'seed' and r['source'] == 'seed'
        assert r['customer_id'] in cust_ids
        assert r['thread_id'].startswith('t_') and len(r['thread_id']) == 18
        assert r['noise_reason'] is None or r['noise_reason'] in NOISE_REASONS
        assert (r['status'] == 'closed_noise') == r['is_noise']
        if r['status'] in ('new', 'open'):
            assert r['first_response_at'] is None and r['resolved_at'] is None
        if r['first_response_at']:
            assert r['first_response_at'] >= r['received_at'] and r['first_response_at'] <= seed['meta']['as_of']
        if r['resolved_at']:
            assert r['status'] == 'resolved'
            assert r['resolved_at'] >= (r['first_response_at'] or r['received_at'])
            assert r['resolved_at'] <= seed['meta']['as_of']
        if r['status'] == 'resolved':
            assert r['resolved_at'] is not None
        assert r['received_at'] <= seed['meta']['as_of']
        assert r['received_at'] >= '2025-09-15T11:00:00Z'
        if r['channel'] == 'email':
            assert r['message_id'] and re.match(r'^<[0-9a-f]{12}\.\d+@[a-z0-9.-]+>$', r['message_id']), r['message_id']
            if r['noise_reason'] == 'bounce':
                assert r['message_id'].endswith('@mail.prolonlife.com>')
            elif r['from_email']:
                assert r['message_id'].endswith('@' + Generator.msg_host(r['from_email']) + '>'), (r['message_id'], r['from_email'])
        if r['segment'] in ('lnh_patient', 'hcp_patient'):
            assert r['restricted']
        if r['serious_ae']:
            assert r['is_adverse_event'] and r['urgency'] == 'P0' and r['ae_criteria']
        if r['food_safety']:
            assert r['urgency'] == 'P0'
        assert isinstance(r['classifier']['confidence'], float) and 0.6 <= r['classifier']['confidence'] <= 0.95
        assert r['classifier']['rule_category'] == r['category']
        for k in ('tags', 'notes', 'secondary_categories', 'ae_criteria', 'contraindication_flags'):
            assert isinstance(r[k], list)
        for k, v in r.items():
            assert not (isinstance(v, float) and v != v), 'NaN in %s' % k
    assert len(ids) == n
    for c in seed['customers']:
        assert c['segment'] in SEGMENTS and c['sales_channel'] in SALES_CHANNELS and c['region'] in REGIONS
        assert c['subscription_status'] in SUB_STATUSES
        assert c['subscription_cadence_months'] in (None, 1, 2, 3, 4)
    for p in seed['practices']:
        assert p['type'] in PRACTICE_TYPES and p['region'] in REGIONS
    months = list(seed['orders_by_month']['_total'].keys())
    assert months[0] == '2025-09' and months[-1] == '2026-09' and len(months) == 13
    # planted checks
    serious = [r for r in recs if r['serious_ae']]
    assert len(serious) == 6, len(serious)
    recent_serious = [r for r in serious if r['received_at'] >= '2026-09-02']
    assert len(recent_serious) == 2
    noise = [r for r in recs if r['is_noise']]
    assert len(noise) == 11 and Counter(r['noise_reason'] for r in noise) == {'auto_reply': 6, 'bounce': 3, 'newsletter': 2}
    dup = [r for r in recs if r['subcategory'] == 'duplicate_charge' and '2026-02-24T06' <= r['received_at'] <= '2026-02-27T06']
    assert len(dup) >= 14 and all(r['urgency'] == 'P1' for r in dup)
    e6 = [r for r in recs if r['lot_number'] == LOT_E6]
    assert len(e6) == 18 and all(r['food_safety'] and r['urgency'] == 'P0' for r in e6)
    e8 = [r for r in recs if r['subcategory'] == 'leaking' and '2026-07-06T05' <= r['received_at'] <= '2026-07-27T05']
    assert len(e8) >= 19
    assert not any(r['product'] == 'guided_health' and r['received_at'][:10] < '2025-10-23' for r in recs)
    assert not any(r['product'] == 'starter_pack' and r['received_at'][:10] < '2026-08-06' for r in recs)
    assert len(seed['meta']['planted_events']) == 13
    open_reg = [r for r in recs if r['status'] in OPEN_STATUSES and (r['serious_ae'] or r['food_safety'])]
    cutoff = iso(AS_OF_UTC - timedelta(days=REG_OPEN_DAYS))
    assert all(r['received_at'] >= cutoff for r in open_reg), 'open regulatory record older than %d days' % REG_OPEN_DAYS
    rfr = [r for r in recs if r['lot_number'] == LOT_RFR]
    assert len(rfr) == 1 and rfr[0]['food_safety'] and rfr[0]['urgency'] == 'P0' and rfr[0]['status'] in OPEN_STATUSES
    assert rfr[0]['received_at'] >= iso(AS_OF_UTC - timedelta(hours=48))
    # backlog realism (SPEC section 6)
    b = backlog(seed)
    assert BACKLOG_TARGET[0] <= b['open'] <= BACKLOG_TARGET[1], 'open-state records %d outside %s' % (b['open'], BACKLOG_TARGET)
    assert SLA_BREACH_TARGET[0] <= b['breached'] <= SLA_BREACH_TARGET[1], 'SLA-breached records %d outside %s' % (b['breached'], SLA_BREACH_TARGET)
    assert b['oldest_open_days'] <= AGING_WINDOW_DAYS[1], 'oldest open record %.1f days' % b['oldest_open_days']
    assert b['open_over_max'] <= AGING_MAX, '%d open records older than %d days' % (b['open_over_max'], OPEN_MAX_DAYS)
    assert b['open_recent'] >= b['open'] * 0.5, 'open records not concentrated in the last 21 days'
    for r in recs:
        if r['status'] == 'resolved':
            assert r['first_response_at'] is None or r['first_response_at'] <= r['resolved_at']
    for ev in seed['meta']['planted_events']:
        for k in ('id', 'from', 'to', 'title', 'detector', 'expected'):
            assert k in ev
        assert 'will' not in ev['title'].split()
    # sentiment mix and NPS (SPEC section 6): a brand with 4+ star public reviews, not a company in crisis
    en = [r for r in recs if not r['is_noise'] and r['language'] == 'en']
    mix = Counter(r['sentiment_label'] for r in en)
    pos, neg = mix['positive'] / float(len(en)), mix['negative'] / float(len(en))
    assert BAND_MIX_TARGET['positive'][0] <= pos <= BAND_MIX_TARGET['positive'][1], 'positive band share %.3f outside %s' % (pos, BAND_MIX_TARGET['positive'])
    assert BAND_MIX_TARGET['negative'][0] <= neg <= BAND_MIX_TARGET['negative'][1], 'negative band share %.3f outside %s' % (neg, BAND_MIX_TARGET['negative'])
    scores = [r['nps'] for r in recs if r['nps'] is not None]
    nps12 = 100.0 * (sum(1 for x in scores if x >= 9) - sum(1 for x in scores if x <= 6)) / len(scores)
    assert NPS_TARGET[0] <= nps12 <= NPS_TARGET[1], '12-month NPS %.1f outside %s (n=%d)' % (nps12, NPS_TARGET, len(scores))


def backlog(seed):
    """Open-state and first-response-SLA numbers the Briefing and the Inbox tiles show against the demo clock."""
    recs = [r for r in seed['records'] if not r['is_noise']]

    def age_h(r):
        return (AS_OF_UTC - datetime.strptime(r['received_at'], '%Y-%m-%dT%H:%M:%SZ')).total_seconds() / 3600.0
    open_recs = [r for r in recs if r['status'] in OPEN_STATUSES]
    breached = [r for r in open_recs if r['first_response_at'] is None and age_h(r) > SLA_HOURS[r['urgency']]]
    oldest = max((age_h(r) for r in open_recs), default=0.0)
    return {'live': len(recs), 'open': len(open_recs), 'breached': len(breached), 'oldest_open_days': oldest / 24.0,
            'open_over_max': sum(1 for r in open_recs if age_h(r) > OPEN_MAX_DAYS * 24),
            'open_recent': sum(1 for r in open_recs if age_h(r) <= 21 * 24),
            'aging_48h': sum(1 for r in open_recs if age_h(r) > 48),
            'resolved_share': sum(1 for r in recs if r['status'] == 'resolved') / float(max(1, len(recs)))}


def stats(seed):
    recs = seed['records']
    print('records: %d  (%s -> %s)' % (len(recs), recs[0]['received_at'], recs[-1]['received_at']))
    print('customers: %d  practices: %d  data.js bytes: %d' % (len(seed['customers']), len(seed['practices']), seed['_bytes']))

    def show(name, key):
        c = Counter(key(r) for r in recs)
        print('  %-16s %s' % (name, ', '.join('%s=%d' % kv for kv in sorted(c.items(), key=lambda kv: -kv[1]))))
    show('category', lambda r: r['category'])
    show('product', lambda r: r['product'])
    show('channel', lambda r: r['channel'])
    show('sentiment', lambda r: r['sentiment_label'])
    show('status', lambda r: r['status'])
    show('urgency', lambda r: r['urgency'])
    show('segment', lambda r: r['segment'])
    show('region', lambda r: r['region'])
    show('language', lambda r: r['language'])
    show('escalated_to', lambda r: r['escalated_to'])
    print('  serious AE: %d  (recent: %s)' % (sum(r['serious_ae'] for r in recs),
                                             [r['received_at'][:10] for r in recs if r['serious_ae'] and r['received_at'] >= '2026-09-02']))
    print('  adverse events (any): %d  food_safety: %d  noise: %d  restricted: %d  followups: %d' % (
        sum(r['is_adverse_event'] for r in recs), sum(r['food_safety'] for r in recs), sum(r['is_noise'] for r in recs),
        sum(r['restricted'] for r in recs), sum(not r['is_first_contact'] for r in recs)))
    print('  nps: %d  rating: %d  csat: %d  has_attachment: %d  quoted tails: %d  claim: %d  cancel_intent: %d' % (
        sum(r['nps'] is not None for r in recs), sum(r['rating'] is not None for r in recs),
        sum(r['csat'] is not None for r in recs), sum(r['has_attachment'] for r in recs),
        sum('wrote:' in r['text'] for r in recs), sum(r['claim_related'] for r in recs), sum(r['cancel_intent'] for r in recs)))
    subs = Counter(c['subscription_status'] for c in seed['customers'])
    print('  subscription_status: %s' % dict(subs))
    mult = Counter(Counter(r['customer_id'] for r in recs).values())
    n_c = len(seed['customers'])
    ge2 = sum(v for k, v in mult.items() if k >= 2)
    ge3 = sum(v for k, v in mult.items() if k >= 3)
    print('  customers with >=2 records: %.0f%%  >=3: %.0f%%  max: %d' % (100.0 * ge2 / n_c, 100.0 * ge3 / n_c, max(mult)))
    frt = [r for r in recs if r['first_response_at']]
    print('  first_response set: %d  resolved_at set: %d' % (len(frt), sum(r['resolved_at'] is not None for r in recs)))
    b = backlog(seed)
    print('  backlog: open-state=%d (last 21d: %d, >%dd: %d)  past first-response SLA=%d  aging>48h=%d  oldest open=%.1fd  resolved share=%.1f%%' % (
        b['open'], b['open_recent'], OPEN_MAX_DAYS, b['open_over_max'], b['breached'], b['aging_48h'], b['oldest_open_days'], 100 * b['resolved_share']))
    by_week = defaultdict(lambda: Counter())
    for r in recs:
        d = (datetime.strptime(r['received_at'], '%Y-%m-%dT%H:%M:%SZ') - timedelta(hours=6)).date()
        wk = week_key(d)
        by_week[wk]['all'] += 1
        if r['category'] == 'shipping_fulfillment':
            by_week[wk]['shipping'] += 1
        if r['lot_number'] == LOT_E6:
            by_week[wk]['lot'] += 1
        if r['subcategory'] == 'leaking':
            by_week[wk]['leaking'] += 1
        if r['subcategory'] == 'duplicate_charge':
            by_week[wk]['dup'] += 1
    for label, weeks in (('E3', ['2025-W49', '2025-W50', '2025-W51', '2025-W52', '2026-W01']),
                         ('E5', ['2026-W07', '2026-W08', '2026-W09', '2026-W10']),
                         ('E6', ['2026-W18', '2026-W19', '2026-W20', '2026-W21', '2026-W22', '2026-W23']),
                         ('E8', ['2026-W26', '2026-W27', '2026-W28', '2026-W29', '2026-W30', '2026-W31'])):
        print('  %s weekly: %s' % (label, '  '.join('%s all=%d ship=%d lot=%d leak=%d dup=%d' % (
            w, by_week[w]['all'], by_week[w]['shipping'], by_week[w]['lot'], by_week[w]['leaking'], by_week[w]['dup']) for w in weeks)))
    tot = seed['orders_by_month']['_total']
    print('  orders total/yr(13mo): %d  Jan=%d Nov=%d' % (sum(tot.values()), tot['2026-01'], tot['2025-11']))


def main():
    dry = '--dry-run' in sys.argv
    gen = Generator()
    records, orders = gen.run()
    clean_records = []
    for r in records:
        clean_records.append({k: v for k, v in r.items() if not k.startswith('_')})
    customers = []
    for c in gen.customers:
        customers.append({k: v for k, v in c.items() if k not in ('first_name', 'last_name', 'practice_name')})
    practices = [{k: v for k, v in p.items() if k != 'hcp_code'} for p in gen.practices]
    seed = {'meta': gen.meta(), 'records': clean_records, 'customers': customers, 'practices': practices,
            'orders_by_month': orders}
    if os.environ.get('VOC_SEED_DIAG'):
        with open(os.environ['VOC_SEED_DIAG'], 'w', encoding='utf-8') as f:
            json.dump({r['id']: {'cores': r.get('_cores', []), 'band': r['_band'], 'category': r['category'], 'subcategory': r['subcategory'],
                                 'product': r['product'], 'channel': r['channel']} for r in records}, f)
    payload = 'window.VOC_SEED = ' + json.dumps(seed, ensure_ascii=False, separators=(',', ':')) + ';\n'
    seed['_bytes'] = len(payload.encode('utf-8'))
    validate(seed)
    assert seed['_bytes'] < 2.5 * 1024 * 1024
    stats(seed)
    if not dry:
        with open(OUT_PATH, 'w', encoding='utf-8') as f:
            f.write(payload)
        print('wrote %s' % OUT_PATH)


if __name__ == '__main__':
    main()
