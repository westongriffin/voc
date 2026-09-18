/* L-Nutra VoC — js/classify.js (PURE)
 * Text pipeline: preprocess → isNoise → detectLanguage → scoreSentiment → scoreCategories → detectProduct →
 * assessSafety → assignUrgency → extractEntities → flags → identity → defaults (SPEC §4.4, §7).
 * Depends on VOC.lexicon and VOC.rules at call time; uses VOC.util when present with private fallbacks.
 * No DOM access; runs under jsc.
 */
window.VOC = window.VOC || {};
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* util access with fallbacks                                          */
  /* ------------------------------------------------------------------ */

  function util() { return (window.VOC && VOC.util) || null; }

  var FNV_OFFSET = BigInt('0xcbf29ce484222325');
  var FNV_PRIME = BigInt('0x100000001b3');
  var MASK64 = (BigInt(1) << BigInt(64)) - BigInt(1);
  function localFnv64(str) {
    var s = str == null ? '' : String(str);
    var h = FNV_OFFSET;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var bytes = c < 0x80 ? [c] : c < 0x800 ? [0xc0 | (c >> 6), 0x80 | (c & 63)] : [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
      for (var j = 0; j < bytes.length; j++) {
        h ^= BigInt(bytes[j]);
        h = (h * FNV_PRIME) & MASK64;
      }
    }
    return h.toString(16).padStart(16, '0');
  }
  function fnv64(str) { var u = util(); return u && u.fnv64 ? u.fnv64(str) : localFnv64(str); }

  function localNormalizeEmail(e) {
    if (!e || typeof e !== 'string') return null;
    var s = e.trim().toLowerCase();
    var angle = /<([^>]+)>/.exec(s);
    if (angle) s = angle[1].trim();
    var at = s.lastIndexOf('@');
    if (at < 0) return s || null;
    var local = s.slice(0, at), domain = s.slice(at + 1);
    var plus = local.indexOf('+');
    if (plus > 0) local = local.slice(0, plus);
    if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
    return local + '@' + domain;
  }
  function normalizeEmail(e) { var u = util(); return u && u.normalizeEmail ? u.normalizeEmail(e) : localNormalizeEmail(e); }

  function localTokenize(text) {
    if (!text) return [];
    var m = String(text).toLowerCase().match(/[a-z0-9À-ɏ']+/g) || [];
    var out = [];
    for (var i = 0; i < m.length; i++) { var t = m[i].replace(/^'+|'+$/g, ''); if (t.length >= 2) out.push(t); }
    return out;
  }
  function tokenize(text) { var u = util(); return u && u.tokenize ? u.tokenize(text) : localTokenize(text); }

  function localSentences(text) {
    if (!text) return [];
    var m = String(text).match(/[^.!?\n]+(?:[.!?]+|(?=\n)|$)/g) || [];
    return m.map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  }
  function sentences(text) { var u = util(); return u && u.sentences ? u.sentences(text) : localSentences(text); }

  var LOCAL_PRODUCT_CLASS = {
    prolon_5day: 'conventional_food', prolon_nextgen: 'conventional_food', prolon_reset: 'conventional_food', prolon_52: 'conventional_food',
    fast_bar: 'conventional_food', fasting_shake: 'conventional_food', l_protein: 'conventional_food', starter_pack: 'conventional_food',
    l_pill: 'supplement', guided_health: 'program', lnutra_health: 'program', subscription_account: 'none', general: 'none'
  };
  function productClass(productId) {
    var en = window.VOC && VOC.enums;
    if (en && typeof en.productClass === 'function') return en.productClass(productId);
    return LOCAL_PRODUCT_CLASS[productId] || 'none';
  }

  var CATEGORY_IDS = ['subscription_billing', 'checkout_website', 'shipping_fulfillment', 'missing_damaged', 'taste_quality', 'foreign_material_allergen',
    'side_effects', 'adverse_event', 'efficacy_results', 'price_value', 'customer_service', 'hcp_practitioner', 'marketing_email', 'usage_guidance',
    'product_request', 'praise', 'other_noise'];
  var PRODUCT_IDS = ['prolon_5day', 'prolon_nextgen', 'prolon_reset', 'prolon_52', 'fast_bar', 'fasting_shake', 'l_protein', 'l_pill', 'starter_pack',
    'guided_health', 'lnutra_health', 'subscription_account', 'general'];

  /* ------------------------------------------------------------------ */
  /* Precompiled lexicon structures (built lazily once)                  */
  /* ------------------------------------------------------------------ */

  var LEX = null;
  function lex() {
    if (LEX) return LEX;
    var L = VOC.lexicon;
    var single = {}, phrases = {};
    function add(key, val) {
      var k = String(key).toLowerCase().replace(/’/g, "'");
      if (k.indexOf(' ') < 0) { single[k] = val; return; }
      var parts = k.split(/\s+/);
      var first = parts[0];
      (phrases[first] = phrases[first] || []).push({ parts: parts, valence: val, key: k });
    }
    Object.keys(L.BASE).forEach(function (k) { add(k, L.BASE[k]); });
    Object.keys(L.DOMAIN).forEach(function (k) { add(k, L.DOMAIN[k]); });   // domain overrides base
    Object.keys(phrases).forEach(function (k) { phrases[k].sort(function (a, b) { return b.parts.length - a.parts.length; }); });
    var brand = {}; L.BRAND_STOPLIST.forEach(function (b) { brand[b] = true; });
    var neg = {}; L.NEGATORS.forEach(function (n) { neg[n.replace(/’/g, "'")] = true; });
    var stop = {}; L.STOPWORDS.forEach(function (s) { stop[s] = true; });
    LEX = { single: single, phrases: phrases, brand: brand, neg: neg, stop: stop, boosters: L.BOOSTERS, dampeners: L.DAMPENERS };
    return LEX;
  }

  /** Foreign function words used by the language gate to separate 'other' from 'unknown'. */
  var FOREIGN_MARKERS = {};
  ['der', 'die', 'das', 'und', 'ich', 'nicht', 'ist', 'mit', 'für', 'fur', 'auf', 'dem', 'den', 'ein', 'eine', 'sie', 'wir', 'habe', 'haben', 'sehr', 'aber',
    'noch', 'auch', 'bitte', 'danke', 'meine', 'mein', 'wurde', 'bin', 'bestellung', 'il', 'la', 'le', 'di', 'che', 'non', 'per', 'una', 'uno', 'con', 'sono',
    'ho', 'grazie', 'ma', 'mio', 'mia', 'ordine', 'el', 'los', 'las', 'que', 'es', 'para', 'por', 'gracias', 'pedido', 'les', 'des', 'est', 'pas', 'je',
    'vous', 'nous', 'merci', 'commande', 'het', 'een', 'niet', 'van', 'och', 'att', 'inte', 'jag'].forEach(function (w) { FOREIGN_MARKERS[w] = true; });

  /* ------------------------------------------------------------------ */
  /* preprocess                                                           */
  /* ------------------------------------------------------------------ */

  var RE_QUOTE_CUTS = [
    /^On [^\n]{0,200}?wrote:\s*$/m,
    /^On [^\n]{0,160}\n[^\n]{0,160}wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}/mi,
    /^_{6,}\s*\n\s*From: /m,
    /^From: [^\n]+\n(Sent|Date): /m,
    /^Le [^\n]{0,200}a écrit\s*:/m,
    /^Am [^\n]{0,200}schrieb[^\n]{0,40}:\s*$/m,
    /^Il giorno [^\n]{0,200}ha scritto:\s*$/m
  ];
  var RE_SIG_CUTS = [
    /^-- ?$/m,
    /^Sent from my /m,
    /^Sent from (Mail|Outlook|Yahoo Mail) for /m,
    /^Get Outlook for /m,
    /^Sent via /m,
    /^Von meinem iPhone gesendet/m,
    /^Inviato da (iPhone|iPad)/m
  ];

  function htmlToText(html) {
    var s = String(html);
    s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table)>/gi, '\n').replace(/<(p|div|tr|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
    return s;
  }

  function earliestCut(text, res) {
    var best = -1;
    for (var i = 0; i < res.length; i++) {
      var m = res[i].exec(text);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    return best;
  }

  /**
   * Clean an email body: html→text, cut quoted replies, drop quoted lines, cut signatures, collapse whitespace.
   * Case and punctuation (! ?) are preserved for the sentiment scorer.
   * @param {string} text
   * @param {string|null} [html]
   * @returns {string}
   */
  function preprocess(text, html) {
    var s = text == null ? '' : String(text);
    if (!s.trim() && html) s = htmlToText(html);
    s = s.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
    var cut = earliestCut(s, RE_QUOTE_CUTS);
    if (cut > 0) s = s.slice(0, cut);
    else if (cut === 0) s = '';
    s = s.split('\n').filter(function (line) { return !/^\s*>/.test(line); }).join('\n');
    cut = earliestCut(s, RE_SIG_CUTS);
    if (cut > 0) s = s.slice(0, cut);
    else if (cut === 0) s = '';
    s = s.split('\n').map(function (line) { return line.replace(/[ \t]+/g, ' ').trim(); }).join('\n');
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* noise                                                                */
  /* ------------------------------------------------------------------ */

  var RE_SUBJECT_BOUNCE = /undeliver|delivery (status|fail|has failed|incomplete)|failure notice|mail delivery|returned mail|non[- ]?delivery|not delivered/i;
  var RE_SUBJECT_NEWS = /newsletter|digest|roundup|unsubscribe|weekly update|monthly update|daily update/i;
  var RE_BODY_AUTO = /^(?:[^\n]*\n){0,3}?[^\n]*\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|this is an automated (reply|response|message)|i am currently (out|away|traveling)|i will be out of)\b/i;
  var RE_BODY_BOUNCE = /^(?:[^\n]*\n){0,4}?[^\n]*\b(delivery (has )?failed|could not be delivered|was not delivered|undeliverable|mailer-daemon|mail delivery (subsystem|system)|delivery status notification|the following address(es)? (had|has) permanent)\b/i;

  /**
   * Machine-generated mail detection from headers, then subject, then the first lines of the body.
   * @param {object} [headers]
   * @param {string} [subject]
   * @param {string} [text]
   * @returns {{is_noise: boolean, reason: ('auto_reply'|'bounce'|'newsletter'|null)}}
   */
  function isNoise(headers, subject, text) {
    var R = VOC.rules;
    var reason = R.noise.headerChecks(headers || {});
    if (!reason) {
      var subj = subject == null ? '' : String(subject);
      if (R.noise.subject.test(subj)) {
        reason = RE_SUBJECT_BOUNCE.test(subj) ? 'bounce' : RE_SUBJECT_NEWS.test(subj) ? 'newsletter' : 'auto_reply';
      }
    }
    if (!reason && text) {
      var t = String(text);
      if (RE_BODY_BOUNCE.test(t)) reason = 'bounce';
      else if (RE_BODY_AUTO.test(t)) reason = 'auto_reply';
    }
    return { is_noise: !!reason, reason: reason || null };
  }

  /* ------------------------------------------------------------------ */
  /* language                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * English gate by stopword share: ≥0.18 → 'en'; <0.08 with ≥20 tokens → 'other'; foreign function words tip 'other'.
   * @param {string} text
   * @returns {'en'|'other'|'unknown'}
   */
  function detectLanguage(text) {
    var s = text == null ? '' : String(text);
    if (!s.trim()) return 'unknown';
    var L = lex();
    var toks = tokenize(s);
    var n = toks.length;
    var letters = (s.match(/[A-Za-zÀ-ɏ]/g) || []).length;
    var nonLatin = (s.match(/[Ѐ-ӿ؀-ۿऀ-ॿ぀-ヿ一-鿿가-힯]/g) || []).length;
    if (nonLatin >= 10 && nonLatin > letters) return 'other';
    if (n === 0) return 'unknown';
    var stop = 0, foreign = 0;
    for (var i = 0; i < n; i++) {
      if (L.stop[toks[i]]) stop++;
      if (FOREIGN_MARKERS[toks[i]]) foreign++;
    }
    var share = stop / n, fshare = foreign / n;
    if (n >= 8 && fshare >= 0.1 && fshare > share) return 'other';
    if (share >= 0.18) return 'en';
    if (n >= 20 && share < 0.08) return 'other';
    if (n < 8 && share > 0) return 'en';
    return 'unknown';
  }

  /* ------------------------------------------------------------------ */
  /* sentiment                                                            */
  /* ------------------------------------------------------------------ */

  var CAPS_BOOST = 0.733, NEG_SCALAR = -0.74, EXCL_BOOST = 0.292, MAX_EXCL = 4, NORM_ALPHA = 15;
  /** Service nouns whose absence is itself the complaint: "no refund", "without a cancellation" keep their sign. */
  var ABSENCE_KEEP = { cancel: 1, cancellation: 1, refund: 1, refunded: 1, tracking: 1, confirmation: 1 };
  var ABSENCE_NEGATORS = { no: 1, without: 1, none: 1, zero: 1, lack: 1, lacking: 1, lacks: 1 };
  /** Wish/demand markers before a positive term describe a desired state, not a fact ("needs to be resolved"). */
  var DEMAND_MARKERS = { needs: 1, need: 1, should: 1, must: 1, want: 1, wants: 1, expect: 1, expected: 1, hope: 1, hoping: 1, hopefully: 1, please: 1, wish: 1 };

  function sentTokens(sentence) {
    var out = [];
    var re = /[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*|\d+(?:\.\d+)?/g, m;
    while ((m = re.exec(sentence)) !== null) {
      var raw = m[0].replace(/’/g, "'").replace(/^'+|'+$/g, '');
      if (!raw) continue;
      out.push({ raw: raw, low: raw.toLowerCase(), caps: raw.length > 1 && /^[A-Z][A-Z'-]*$/.test(raw) });
    }
    return out;
  }

  function phraseMatchAt(L, toks, i) {
    var cands = L.phrases[toks[i].low];
    if (!cands) return null;
    for (var c = 0; c < cands.length; c++) {
      var parts = cands[c].parts;
      if (i + parts.length > toks.length) continue;
      var ok = true;
      for (var p = 1; p < parts.length; p++) {
        var want = parts[p], have = toks[i + p].low;
        if (want === '\\d+') { if (!/^\d/.test(have)) { ok = false; break; } }
        else if (want !== have) { ok = false; break; }
      }
      if (ok) return { len: parts.length, valence: cands[c].valence, key: cands[c].key };
    }
    return null;
  }

  function scoreSentence(sentence, mixedCase) {
    var L = lex();
    var toks = sentTokens(sentence);
    var n = toks.length;
    var items = [];   // {idx, term, valence}
    var i = 0;
    while (i < n) {
      var ph = phraseMatchAt(L, toks, i);
      if (ph) { items.push({ idx: i, end: i + ph.len - 1, term: ph.key, valence: ph.valence, caps: toks[i].caps }); i += ph.len; continue; }
      var t = toks[i].low;
      if (!L.brand[t] && Object.prototype.hasOwnProperty.call(L.single, t)) {
        items.push({ idx: i, end: i, term: t, valence: L.single[t], caps: toks[i].caps });
      } else if (t.indexOf('-') > 0) {
        var spaced = t.replace(/-/g, ' ');
        var firstPart = spaced.split(' ')[0];
        var cands = L.phrases[firstPart] || [];
        for (var c = 0; c < cands.length; c++) { if (cands[c].key === spaced) { items.push({ idx: i, end: i, term: cands[c].key, valence: cands[c].valence, caps: toks[i].caps }); break; } }
      }
      i++;
    }
    var butIdx = -1;
    for (var b = 0; b < n; b++) if (toks[b].low === 'but') butIdx = b;
    var hits = [], sum = 0, usedNeg = {};
    for (var k = 0; k < items.length; k++) {
      var it = items[k], v = it.valence;
      if (v === 0) continue;
      if (mixedCase && it.caps) v += v > 0 ? CAPS_BOOST : -CAPS_BOOST;
      var negated = false, demanded = false;
      for (var d = 1; d <= 3 && it.idx - d >= 0; d++) {
        var prev = toks[it.idx - d].low;
        var consumed = false;
        for (var q = 0; q < k; q++) if (items[q].idx <= it.idx - d && items[q].end >= it.idx - d && items[q].end > items[q].idx) consumed = true;
        if (consumed) continue;
        var scalar = Object.prototype.hasOwnProperty.call(L.boosters, prev) ? L.boosters[prev] : Object.prototype.hasOwnProperty.call(L.dampeners, prev) ? L.dampeners[prev] : 0;
        if (scalar) {
          if (v < 0) scalar = -scalar;
          if (d === 2) scalar *= 0.95; else if (d === 3) scalar *= 0.9;
          v += scalar;
        }
        if (L.neg[prev] && !usedNeg[it.idx - d] && !negated && !(ABSENCE_NEGATORS[prev] && ABSENCE_KEEP[it.term])) { negated = true; usedNeg[it.idx - d] = true; }
        if (DEMAND_MARKERS[prev] && it.valence > 0) demanded = true;
      }
      if (negated) v *= NEG_SCALAR;
      else if (demanded) v *= 0.3;
      if (butIdx >= 0) v *= it.idx < butIdx ? 0.5 : 1.5;
      hits.push({ term: it.term, valence: Math.round(v * 1000) / 1000 });
      sum += v;
    }
    if (hits.length) {
      var ex = Math.min((sentence.match(/!/g) || []).length, MAX_EXCL) * EXCL_BOOST;
      if (sum > 0) sum += ex; else if (sum < 0) sum -= ex;
    }
    var compound = hits.length ? sum / Math.sqrt(sum * sum + NORM_ALPHA) : 0;
    return { compound: Math.max(-1, Math.min(1, compound)), hits: hits };
  }

  /**
   * VADER-style compound sentiment. `compound` is the mean of sentence compounds over sentences with at least one
   * lexicon hit (0 when none); `min` is the worst sentence.
   * @param {string} text
   * @returns {{compound: number, min: number, sentences: {text: string, compound: number}[], hits: {term: string, valence: number}[]}}
   */
  function scoreSentiment(text) {
    var s = text == null ? '' : String(text);
    var sents = sentences(s);
    var hasLower = /[a-z]/.test(s), hasUpper = /[A-Z]/.test(s);
    var mixedCase = hasLower && hasUpper;
    var outS = [], hits = [], sum = 0, scored = 0, min = 0;
    for (var i = 0; i < sents.length; i++) {
      var r = scoreSentence(sents[i], mixedCase);
      var c = Math.round(r.compound * 1000) / 1000;
      outS.push({ text: sents[i], compound: c });
      if (r.hits.length) { scored++; sum += c; hits = hits.concat(r.hits); if (c < min) min = c; }
    }
    var compound = scored ? Math.round((sum / scored) * 1000) / 1000 : 0;
    if (compound < min) min = compound;
    return { compound: compound, min: min, sentences: outS, hits: hits };
  }

  function sentimentLabel(compound, language) {
    if (language === 'other') return 'unscored';
    if (compound >= 0.15) return 'positive';
    if (compound <= -0.15) return 'negative';
    return 'neutral';
  }

  /* ------------------------------------------------------------------ */
  /* categories                                                           */
  /* ------------------------------------------------------------------ */

  var PRIORITY = null;
  function priorityOf(cat) {
    if (!PRIORITY) { PRIORITY = {}; VOC.rules.categories.forEach(function (c) { PRIORITY[c.id] = c.priority; }); }
    return PRIORITY[cat] || 99;
  }

  function subScores(text, subject) {
    var out = {};   // cat -> { subs: {sub: score}, score }
    var cats = VOC.rules.categories;
    var hasSubj = !!subject;
    for (var c = 0; c < cats.length; c++) {
      var cat = cats[c], subs = {}, max = 0, sum = 0;
      for (var s = 0; s < cat.subcategories.length; s++) {
        var sub = cat.subcategories[s], sc = 0;
        for (var p = 0; p < sub.patterns.length; p++) {
          var pat = sub.patterns[p];
          if (pat.re.test(text)) sc += pat.w;
          if (hasSubj && pat.re.test(subject)) sc += 1.5 * pat.w;
        }
        subs[sub.id] = sc;
        if (sc > max) max = sc;
        sum += sc;
      }
      out[cat.id] = { subs: subs, score: max + 0.5 * (sum - max) };
    }
    return out;
  }

  function bestSub(subs, fallback) {
    var best = fallback, bv = -1;
    Object.keys(subs).forEach(function (k) { if (subs[k] > bv) { bv = subs[k]; best = k; } });
    return bv > 0 ? best : fallback;
  }

  /**
   * Rule-based category scoring. Category score = max subcategory + 0.5 × others; subject hits ×1.5; serious-safety
   * regex hits add +3 to adverse_event. Ties within 20% resolve by SPEC §4.3 priority.
   * @param {string} text
   * @param {string} [subject]
   * @returns {{scores: Object<string, number>, category: string, subcategory: string, secondary: string[], confidence: number}}
   */
  function scoreCategories(text, subject) {
    var t = text == null ? '' : String(text), subj = subject == null ? '' : String(subject);
    var all = subScores(t, subj);
    var R = VOC.rules;
    var seriousHit = false;
    for (var i = 0; i < R.safety.serious.length; i++) if (R.safety.serious[i].test(t) && !negatedAt(t, R.safety.serious[i])) { seriousHit = true; break; }
    if (seriousHit) all.adverse_event.score += 3;
    if (all.praise.score > 0) {
      var praiseComp = scoreSentiment(t).compound;
      if (praiseComp <= -0.15) all.praise.score = 0;
    }
    var scores = {}, ranked = [];
    Object.keys(all).forEach(function (k) { scores[k] = Math.round(all[k].score * 100) / 100; if (all[k].score > 0) ranked.push({ id: k, score: all[k].score }); });
    ranked.sort(function (a, b) { return b.score - a.score || priorityOf(a.id) - priorityOf(b.id); });
    if (!ranked.length) {
      var comp = scoreSentiment(t).compound;
      var praise = comp > 0.3;
      return { scores: scores, category: praise ? 'praise' : 'usage_guidance', subcategory: praise ? 'general_praise' : 'general_question', secondary: [], confidence: 0.2 };
    }
    var top = ranked[0].score;
    var winner = ranked[0];
    for (var r = 1; r < ranked.length; r++) {
      if (ranked[r].score >= 0.8 * top && priorityOf(ranked[r].id) < priorityOf(winner.id)) winner = ranked[r];
    }
    var secondary = [];
    for (var q = 0; q < ranked.length; q++) if (ranked[q].id !== winner.id && ranked[q].score >= 2) secondary.push(ranked[q].id);
    var subFallback = R.categories.filter(function (c) { return c.id === winner.id; })[0].subcategories[0].id;
    var sub = bestSub(all[winner.id].subs, subFallback);
    if (winner.id === 'adverse_event' && seriousHit && all.adverse_event.subs[sub] === 0) sub = seriousSub(t);
    return { scores: scores, category: winner.id, subcategory: sub, secondary: secondary, confidence: Math.round((winner.score / (winner.score + 2)) * 1000) / 1000 };
  }

  function seriousSub(t) {
    if (/faint|passed out|lost consciousness/i.test(t)) return 'fainting';
    if (/anaphyla|epi ?pen|allergic reaction|throat/i.test(t)) return 'allergic_reaction';
    if (/hypoglyc|blood sugar|glucose/i.test(t)) return 'hypoglycemia_medication';
    if (/chest pain|seizure|heart attack|stroke|breathe/i.test(t)) return 'chest_pain';
    return 'er_hospital';
  }

  /* ------------------------------------------------------------------ */
  /* product                                                              */
  /* ------------------------------------------------------------------ */

  var RE_NOT_PRODUCT = /\b(password|pass ?code|pin|link|email|account|timer|tracker|app|progress|streak|counter|browser|cache|phone|device|router|settings?) reset\b|\breset (my |the |your )?(password|pass ?code|pin|link|email|account|timer|tracker|app|progress|streak|counter|browser|cache|phone|device|router|settings?)\b|\bgold[- ]?bar\b|\bsalad bar\b|\bstatus bar\b|\bprogress bar\b|\bcandy bars?\b|\bprotein shake\b/gi;
  var KIT_PRODUCTS = { prolon_5day: 1, prolon_nextgen: 1, prolon_reset: 1, prolon_52: 1, starter_pack: 1, general: 1, subscription_account: 1 };

  /**
   * Product from alias table (subject ×1.5); kit component by name; product class from enums.
   * @param {string} text
   * @param {string} [subject]
   * @returns {{product: string, product_variant: string|null, kit_component: string|null, product_class: string, score: number}}
   */
  function detectProduct(text, subject) {
    var t = (text == null ? '' : String(text)).replace(RE_NOT_PRODUCT, ' '), subj = (subject == null ? '' : String(subject)).replace(RE_NOT_PRODUCT, ' ');
    var R = VOC.rules, scores = {}, variants = {};
    for (var i = 0; i < R.productAliases.length; i++) {
      var a = R.productAliases[i], sc = 0;
      if (a.re.test(t)) sc += a.w;
      if (subj && a.re.test(subj)) sc += 1.5 * a.w;
      if (sc > 0) {
        scores[a.product] = (scores[a.product] || 0) + sc;
        if (a.variant && !variants[a.product]) variants[a.product] = a.variant;
      }
    }
    var best = 'general', bv = 0;
    PRODUCT_IDS.forEach(function (p) {
      if (p === 'subscription_account' || p === 'general') return;
      var v = scores[p] || 0;
      if (v > bv) { bv = v; best = p; }
    });
    if (bv < 2 && scores.subscription_account) { best = 'subscription_account'; bv = scores.subscription_account; }
    var component = null;
    if (KIT_PRODUCTS[best]) {
      for (var c = 0; c < R.components.length; c++) if (R.components[c].re.test(t) || (subj && R.components[c].re.test(subj))) { component = R.components[c].id; break; }
      if (component && best === 'general') { best = 'prolon_5day'; bv = 1; }
    }
    return { product: best, product_variant: variants[best] || null, kit_component: component, product_class: productClass(best), score: Math.round(bv * 100) / 100 };
  }

  /* ------------------------------------------------------------------ */
  /* safety                                                               */
  /* ------------------------------------------------------------------ */

  var RE_NEG_BEFORE = /\b(no|not|never|without|didn'?t|did not|don'?t|zero|none|free of|haven'?t had|hasn'?t|wasn'?t|any|avoid(ed|ing)?|prevent(s|ed)?|instead of|rather than)\b\W*(?:\w+\W+){0,2}$/i;
  var RE_HYPOTHETICAL_BEFORE = /\b(if|in case|should|worried about|afraid of|risk of|history of|prone to|what if|would|could|might)\b\W*(?:\w+\W+){0,3}$/i;
  var RE_MATERIAL_CONTEXT = /\b(piece|pieces|bit|bits|shard|shards|chunk|chunks|sliver|fragment|found|inside|in (my|the) (soup|bar|food|pouch|shake|drink|olives|crackers|mouth)|bit into|chewed|swallowed)\b/i;
  var RE_MATERIAL = /^\\b(glass|plastic|metal)\\b$/;   // tested against a safety regex's .source

  /** True when the first match of re in text is preceded by a negation or hypothetical marker. */
  function negatedAt(text, re) {
    var m = re.exec(text);
    if (!m) return false;
    var before = text.slice(Math.max(0, m.index - 40), m.index);
    return RE_NEG_BEFORE.test(before) || RE_HYPOTHETICAL_BEFORE.test(before);
  }

  function anyHit(text, res, needContext) {
    for (var i = 0; i < res.length; i++) {
      var re = res[i];
      if (!re.test(text) || negatedAt(text, re)) continue;
      if (needContext && RE_MATERIAL.test(re.source)) {
        var m = re.exec(text);
        var around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
        if (!RE_MATERIAL_CONTEXT.test(around)) continue;
      }
      return true;
    }
    return false;
  }

  function aeCriteria(t) {
    var out = [];
    if (/\b(died|death|passed away|fatal)\b/i.test(t)) out.push('death');
    var er = /\bER\b/.test(t);
    if (/anaphyla|could ?n[o']?t breathe|throat (swelled|closed|closing)|chest pain|seizure|heart attack|stroke|blood sugar (crashed|dropped|tanked|plummeted)|hypoglyc|lost consciousness/i.test(t)) out.push('life_threatening');
    if (er || /hospitali[sz]|(went|taken|rushed|admitted|ended up|landed|drove|sent|kept|stayed|overnight|night|trip|visit) (me |her |him |my \w+ )?(to |in |at |into )?(the |a )?hospital\b|(to|in|at) the hospital\b|hospital (visit|stay|trip|admission)|emergency room|ambulance|\bicu\b|admitted/i.test(t)) out.push('hospitalization');
    if (/permanent (damage|injury)|disabled|disability|can ?n[o']?t walk|lost (vision|hearing)/i.test(t)) out.push('disability');
    if (/birth defect|miscarriage|stillbirth/i.test(t)) out.push('birth_defect');
    if (/epi ?pen|intubat|iv fluids|glucose (tablets|shot|injection)|resuscitat|stitches|treated (at|in|by)|needed (treatment|medication|an? (injection|shot|iv))|paramedics?|first responders|\bemts?\b|call(ed)? 911/i.test(t)) out.push('intervention');
    return out;
  }

  /**
   * Adverse-event, contraindication and food-safety assessment (SPEC §7). Negated or hypothetical mentions are skipped.
   * @param {string} text
   * @returns {{is_adverse_event: boolean, serious_ae: boolean, ae_criteria: string[], contraindication_flags: string[], food_safety: boolean}}
   */
  function assessSafety(text) {
    var t = text == null ? '' : String(text);
    var S = VOC.rules.safety;
    var serious = anyHit(t, S.serious, false);
    var nonSerious = anyHit(t, S.nonSerious, false);
    var flags = [];
    ['pregnancy', 'minor', 'glucose_meds', 'nut_soy_allergy', 'bmi_low', 'serious_disease'].forEach(function (k) {
      var re = S.contra[k];
      if (re && re.test(t) && !negatedAt(t, re)) flags.push(k);
    });
    var food = anyHit(t, S.food, true);
    return { is_adverse_event: serious || nonSerious, serious_ae: serious, ae_criteria: serious ? aeCriteria(t) : [], contraindication_flags: flags, food_safety: food };
  }

  /* ------------------------------------------------------------------ */
  /* urgency                                                              */
  /* ------------------------------------------------------------------ */

  var P1_SUBS = { duplicate_charge: 1, unauthorized_signup: 1, post_cancel_shipment: 1, lost: 1, leaking: 1 };
  var P3_CATS = { praise: 1, product_request: 1, marketing_email: 1, other_noise: 1 };
  var RE_P0_LEGAL = /lawyer|attorney|legal action|lawsuit|sue\b|class action|small claims/i;
  var RE_P0_FINANCE = /chargeback|disput/i;
  var RE_P0_PRESS = /\bpress\b|reporter|journalist|news/i;

  function p0Hit(text) {
    var P = VOC.rules.p0;
    for (var i = 0; i < P.length; i++) if (P[i].test(text)) return P[i];
    return null;
  }

  /**
   * Urgency rubric (SPEC §7). `partial` needs category, subcategory, sentiment, sentiment_label, nps, segment, safety
   * fields (serious_ae, is_adverse_event, food_safety, contraindication_flags), claim_related and text.
   * @param {object} partial
   * @returns {{urgency: string, escalated_to: string, reasons: string[]}}
   */
  function assignUrgency(partial) {
    var p = partial || {};
    var reasons = [], urgency = null, target = 'none';
    var contra = Array.isArray(p.contraindication_flags) ? p.contraindication_flags : [];
    var text = p.text == null ? '' : String(p.text);
    var p0re = p0Hit(text);
    var safetyP0 = false;
    if (p.serious_ae) { reasons.push('serious adverse event'); safetyP0 = true; }
    if (p.food_safety) { reasons.push('food safety report'); safetyP0 = true; }
    if (contra.indexOf('pregnancy') >= 0) { reasons.push('pregnancy contraindication'); safetyP0 = true; }
    if (contra.indexOf('minor') >= 0) { reasons.push('minor (under 18) contraindication'); safetyP0 = true; }
    if (safetyP0 || p0re) {
      urgency = 'P0';
      if (p0re) reasons.push('legal, regulator, chargeback or press mention');
      if (p.serious_ae || p.is_adverse_event || contra.length) target = 'medical';
      else if (p.food_safety) target = 'quality_regulatory';
      else if (RE_P0_LEGAL.test(text) || p.claim_related) target = 'legal';
      else if (RE_P0_FINANCE.test(text)) target = 'finance';
      else if (RE_P0_PRESS.test(text)) target = 'cs_lead';
      else target = 'quality_regulatory';
    }
    if (!urgency) {
      var neg = p.sentiment_label === 'negative';
      if (p.is_adverse_event) reasons.push('non-serious adverse event');
      if (P1_SUBS[p.subcategory]) reasons.push(String(p.subcategory).replace(/_/g, ' '));
      if (p.nps != null && p.nps <= 6 && typeof p.sentiment === 'number' && p.sentiment <= -0.5) reasons.push('detractor with strongly negative sentiment');
      if ((p.segment === 'hcp' || p.segment === 'wholesale') && neg) reasons.push('negative practitioner or wholesale account');
      if (reasons.length) {
        urgency = 'P1';
        if (p.claim_related) target = 'legal';
        else if (p.category === 'subscription_billing') target = 'finance';
      }
    }
    if (!urgency) {
      if (P3_CATS[p.category]) { urgency = 'P3'; reasons.push('praise, request or marketing feedback'); }
      else { urgency = 'P2'; reasons.push('standard service request'); }
      if (p.claim_related) target = 'legal';
    }
    return { urgency: urgency, escalated_to: target, reasons: reasons };
  }

  /* ------------------------------------------------------------------ */
  /* entities and flags                                                   */
  /* ------------------------------------------------------------------ */

  function firstGroup(m) {
    for (var g = 1; g < m.length; g++) if (m[g]) return m[g];
    return m[0];
  }

  /**
   * Order id (Shopify #1xxxxx, Amazon 113-…, practitioner order PP-xxxxx), lot number and practitioner code (HCP-XXXXX) from subject + text.
   * @param {string} text
   * @param {string} [subject]
   * @returns {{order_id: string|null, lot_number: string|null, hcp_code: string|null}}
   */
  function extractEntities(text, subject) {
    var E = VOC.rules.entities;
    var s = (subject == null ? '' : String(subject)) + '\n' + (text == null ? '' : String(text));
    var order = null, m;
    for (var i = 0; i < E.order.length && !order; i++) {
      m = E.order[i].exec(s);
      if (m) {
        var val = firstGroup(m).toUpperCase();
        order = i === 1 ? '#' + val : val;
      }
    }
    var hm = E.hcp.exec(s);
    var hcp = hm ? firstGroup(hm).toUpperCase() : null;
    if (order && hcp && order === hcp) {
      var other = null;
      for (var j = 0; j < E.order.length && !other; j++) {
        if (E.order[j] === E.hcp || /PP-/.test(E.order[j].source)) continue;
        var mm = E.order[j].exec(s);
        if (mm) other = j === 1 ? '#' + firstGroup(mm).toUpperCase() : firstGroup(mm).toUpperCase();
      }
      if (other) order = other;
    }
    var lm = E.lot.exec(s);
    var lot = lm ? (lm[1] || lm[2] || '').toUpperCase() : null;
    if (lot && /^\d+$/.test(lot)) lot = null;
    return { order_id: order || null, lot_number: lot || null, hcp_code: hcp };
  }

  /**
   * claim_related / cancel_intent / restricted flags (SPEC §7). `partial` may carry segment and to[] recipients.
   * @param {string} text
   * @param {object} [partial]
   * @returns {{claim_related: boolean, cancel_intent: boolean, restricted: boolean}}
   */
  function flags(text, partial) {
    var t = text == null ? '' : String(text);
    var R = VOC.rules, p = partial || {};
    var claim = R.claim.some(function (re) { return re.test(t); });
    var cancel = R.cancel.some(function (re) { return re.test(t); });
    var restricted = p.segment === 'lnh_patient' || p.segment === 'hcp_patient' || R.restricted.some(function (re) { return re.test(t); });
    if (!restricted) {
      var to = [].concat(p.to || [], p.cc || []);
      restricted = to.some(function (a) { return /med\.?ed@/i.test(String(a)); });
    }
    return { claim_related: claim, cancel_intent: cancel, restricted: restricted };
  }

  /* ------------------------------------------------------------------ */
  /* identity                                                             */
  /* ------------------------------------------------------------------ */

  function normSubject(subj) {
    return String(subj || '').toLowerCase().replace(/^(\s*(re|fw|fwd|aw|wg|tr|sv)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Stable hex16 fingerprint of a RawEmail or record: message-id when present, else sender + date + subject + body head.
   * @param {object} raw
   * @returns {string}
   */
  function fingerprint(raw) {
    var r = raw || {};
    if (r.message_id) return fnv64('mid:' + String(r.message_id).trim().toLowerCase());
    var email = normalizeEmail(r.from_email) || '';
    var date = r.date || r.received_at || '';
    var body = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return fnv64(email + '|' + date + '|' + normSubject(r.subject) + '|' + body);
  }

  function isoOr(value, fallback) {
    if (value) {
      var d = new Date(value);
      if (!isNaN(d.getTime())) return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    return fallback;
  }

  var REGION_TLD = { de: 'DE', it: 'IT', uk: 'UK', ca: 'CA', au: 'AU', ae: 'AE', fr: 'EU', es: 'EU', nl: 'EU', be: 'EU', at: 'EU', ie: 'EU', pt: 'EU', se: 'EU', dk: 'EU', fi: 'EU', pl: 'EU', eu: 'EU', ch: 'EU' };
  function regionFromEmail(email) {
    if (!email) return 'US';
    var m = /\.([a-z]{2})$/i.exec(String(email).trim());
    if (!m) return 'US';
    var tld = m[1].toLowerCase();
    if (tld === 'us' || tld === 'com' || tld === 'net' || tld === 'org') return 'US';
    return REGION_TLD[tld] || 'OTHER';
  }

  function threadIdFor(raw, email) {
    var r = raw || {};
    if (r.thread_id) return String(r.thread_id);
    var root = null;
    if (Array.isArray(r.references) && r.references.length) root = r.references[0];
    else if (r.in_reply_to) root = r.in_reply_to;
    if (root) return 'th_' + fnv64(String(root).trim().toLowerCase());
    if (r.message_id) return 'th_' + fnv64(String(r.message_id).trim().toLowerCase());
    return 'th_' + fnv64(normSubject(r.subject) + '|' + (email || ''));
  }

  function numOrNull(v, lo, hi) {
    if (v == null || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return n >= lo && n <= hi ? n : null;
  }

  var VALID_URGENCY = { P0: 1, P1: 1, P2: 1, P3: 1 };
  var VALID_STATUS = { new: 1, open: 1, pending: 1, resolved: 1, reopened: 1, escalated: 1, closed_noise: 1 };

  /* ------------------------------------------------------------------ */
  /* pipeline                                                             */
  /* ------------------------------------------------------------------ */

  function analyze(text, subject, extra) {
    var e = extra || {};
    var language = detectLanguage(text);
    var sent = language === 'other' ? { compound: 0, min: 0, sentences: [], hits: [] } : scoreSentiment(text);
    var cats = scoreCategories(text, subject);
    var prod = detectProduct(text, subject);
    var safety = assessSafety(text);
    var ents = extractEntities(text, subject);
    var fl = flags(text, { segment: e.segment, to: e.to, cc: e.cc });
    var label = sentimentLabel(sent.compound, language);
    var urg = assignUrgency({
      category: cats.category, subcategory: cats.subcategory, sentiment: sent.compound, sentiment_label: label, nps: e.nps, segment: e.segment,
      serious_ae: safety.serious_ae, is_adverse_event: safety.is_adverse_event, food_safety: safety.food_safety,
      contraindication_flags: safety.contraindication_flags, claim_related: fl.claim_related, text: text
    });
    return { language: language, sentiment: sent, label: label, categories: cats, product: prod, safety: safety, entities: ents, flags: fl, urgency: urg };
  }

  /**
   * Full pipeline: RawEmail (or partial Record) → complete Record with every SPEC §2 field present.
   * @param {object} raw RawEmail | Partial<Record>
   * @param {{now?: Date|string, settings?: object, source?: string}} [ctx]
   * @returns {object} Record
   */
  function classifyRecord(raw, ctx) {
    var r = raw || {}, c = ctx || {};
    var nowIso = isoOr(c.now instanceof Date ? c.now.toISOString() : c.now, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
    var source = c.source || r.source || 'manual';
    var subject = r.subject == null ? '' : String(r.subject);
    var text = preprocess(r.text, r.html);
    var headers = r.headers || {};
    var noise = isNoise(headers, subject, text);
    if (!noise.is_noise && r.is_noise === true) noise = { is_noise: true, reason: r.noise_reason || 'auto_reply' };
    var email = normalizeEmail(r.from_email);
    var fp = fingerprint(r);
    var providedSegment = r.segment || null;
    var a = analyze(text, subject, { segment: providedSegment, to: r.to, cc: r.cc, nps: numOrNull(r.nps, 0, 10) });

    var segment = providedSegment;
    if (!segment) {
      if (a.categories.category === 'hcp_practitioner') segment = 'hcp';
      else if (a.product.product === 'lnutra_health') segment = 'lnh_patient';
      else if (a.entities.hcp_code) segment = 'hcp_patient';
      else if (a.product.product === 'subscription_account' || a.categories.category === 'subscription_billing') segment = 'subscriber';
      else segment = 'first_time';
    }
    var restricted = a.flags.restricted || segment === 'lnh_patient' || segment === 'hcp_patient';
    var salesChannel = r.sales_channel || (a.entities.order_id && /^\d{3}-\d{7}-\d{7}$/.test(a.entities.order_id) ? 'amazon' : segment === 'hcp' || segment === 'hcp_patient' ? 'hcp' : segment === 'lnh_patient' ? 'lnutra_health' : 'dtc_web');
    var providedCategory = r.category && CATEGORY_IDS.indexOf(r.category) >= 0 ? r.category : null;
    var category = providedCategory || a.categories.category;
    var subcategory = providedCategory ? (r.subcategory || a.categories.subcategory) : a.categories.subcategory;
    var product = r.product && PRODUCT_IDS.indexOf(r.product) >= 0 ? r.product : a.product.product;
    var urgency = r.urgency && VALID_URGENCY[r.urgency] ? r.urgency : a.urgency.urgency;
    var confidence = a.categories.confidence;
    var idPrefix = source === 'imap' ? 'em_' : 'im_';
    var id = typeof r.id === 'string' && /^(r_|em_|im_)/.test(r.id) ? r.id : idPrefix + fp;
    var status = r.status && VALID_STATUS[r.status] ? r.status : (noise.is_noise ? 'closed_noise' : 'new');
    var attachments = Array.isArray(r.attachments) ? r.attachments : [];

    return {
      id: id,
      schema_version: 1,
      received_at: isoOr(r.received_at || r.date, nowIso),
      channel: r.channel || 'email',
      sales_channel: salesChannel,
      from_name: r.from_name == null ? null : String(r.from_name),
      from_email: r.from_email == null ? null : String(r.from_email),
      subject: subject,
      text: text,
      language: a.language,
      has_attachment: !!(r.has_attachment || attachments.length),
      product: product,
      product_variant: r.product_variant != null ? r.product_variant : (product === a.product.product ? a.product.product_variant : null),
      kit_component: r.kit_component != null ? r.kit_component : a.product.kit_component,
      product_class: productClass(product),
      category: category,
      subcategory: subcategory,
      secondary_categories: Array.isArray(r.secondary_categories) ? r.secondary_categories.slice() : a.categories.secondary.filter(function (x) { return x !== category; }),
      sentiment: a.sentiment.compound,
      sentiment_min: a.sentiment.min,
      sentiment_label: a.label,
      nps: numOrNull(r.nps, 0, 10),
      rating: numOrNull(r.rating, 1, 5),
      csat: numOrNull(r.csat, 1, 5),
      urgency: urgency,
      status: status,
      first_response_at: isoOr(r.first_response_at, null),
      resolved_at: isoOr(r.resolved_at, null),
      reopen_count: Number.isInteger(r.reopen_count) ? r.reopen_count : 0,
      service_fields_source: r.service_fields_source || (r.first_response_at || r.resolved_at ? 'helpdesk_import' : 'unavailable'),
      escalated_to: r.escalated_to || a.urgency.escalated_to,
      is_adverse_event: a.safety.is_adverse_event,
      serious_ae: a.safety.serious_ae,
      ae_criteria: a.safety.ae_criteria,
      contraindication_flags: a.safety.contraindication_flags,
      food_safety: a.safety.food_safety,
      lot_number: r.lot_number || a.entities.lot_number,
      order_id: r.order_id || a.entities.order_id,
      hcp_code: r.hcp_code || a.entities.hcp_code,
      claim_related: a.flags.claim_related,
      cancel_intent: a.flags.cancel_intent,
      restricted: restricted,
      customer_id: r.customer_id || (email ? 'c_' + fnv64(email) : 'c_unknown_' + fp),
      segment: segment,
      region: r.region || regionFromEmail(email),
      thread_id: threadIdFor(r, email),
      is_first_contact: typeof r.is_first_contact === 'boolean' ? r.is_first_contact : !(r.in_reply_to || (Array.isArray(r.references) && r.references.length)),
      message_id: r.message_id == null ? null : String(r.message_id),
      source: source,
      is_noise: noise.is_noise,
      noise_reason: noise.reason,
      assignee: r.assignee == null ? null : r.assignee,
      tags: Array.isArray(r.tags) ? r.tags.slice() : [],
      notes: Array.isArray(r.notes) ? r.notes.slice() : [],
      classifier: {
        confidence: confidence,
        rule_category: a.categories.category,
        rule_subcategory: a.categories.subcategory,
        rule_product: a.product.product,
        manual_override: false,
        needs_review: !noise.is_noise && (a.categories.category !== category || confidence < 0.5 || a.language !== 'en')
      }
    };
  }

  var KEEP_ON_RECLASSIFY = ['id', 'schema_version', 'received_at', 'channel', 'sales_channel', 'from_name', 'from_email', 'subject', 'text', 'has_attachment',
    'nps', 'rating', 'csat', 'status', 'first_response_at', 'resolved_at', 'reopen_count', 'service_fields_source', 'customer_id', 'segment', 'region',
    'thread_id', 'is_first_contact', 'message_id', 'source', 'is_noise', 'noise_reason', 'assignee', 'tags', 'notes'];

  /**
   * Re-run sentiment, categories, product, safety, urgency, entities and flags on an existing record. Keeps identity,
   * customer, status and service fields and overlay-owned fields. Seed records keep their category/product labels
   * (ground truth) and safety/urgency, but receive lexicon sentiment and classifier.rule_* for agreement measurement.
   * @param {object} rec
   * @returns {object} Record
   */
  function reclassify(rec) {
    var r = rec || {};
    var out = {};
    Object.keys(r).forEach(function (k) { out[k] = r[k]; });
    var text = r.text == null ? '' : String(r.text);
    var subject = r.subject == null ? '' : String(r.subject);
    var a = analyze(text, subject, { segment: r.segment, nps: r.nps });
    var prev = r.classifier || {};
    var manual = !!prev.manual_override;
    var seed = r.source === 'seed';

    out.language = r.language && r.language !== 'unknown' ? r.language : a.language;
    if (out.language === 'other') { out.sentiment = 0; out.sentiment_min = 0; out.sentiment_label = 'unscored'; }
    else { out.sentiment = a.sentiment.compound; out.sentiment_min = a.sentiment.min; out.sentiment_label = sentimentLabel(a.sentiment.compound, out.language); }

    if (!seed && !manual) {
      out.category = a.categories.category;
      out.subcategory = a.categories.subcategory;
      out.secondary_categories = a.categories.secondary.filter(function (x) { return x !== out.category; });
      out.product = a.product.product;
      out.product_variant = a.product.product_variant;
      out.kit_component = a.product.kit_component;
      out.product_class = productClass(out.product);
      out.is_adverse_event = a.safety.is_adverse_event;
      out.serious_ae = a.safety.serious_ae;
      out.ae_criteria = a.safety.ae_criteria;
      out.contraindication_flags = a.safety.contraindication_flags;
      out.food_safety = a.safety.food_safety;
      out.urgency = a.urgency.urgency;
      out.escalated_to = a.urgency.escalated_to;
    } else {
      out.category = CATEGORY_IDS.indexOf(r.category) >= 0 ? r.category : a.categories.category;
      out.subcategory = r.subcategory || a.categories.subcategory;
      out.secondary_categories = Array.isArray(r.secondary_categories) ? r.secondary_categories : a.categories.secondary.filter(function (x) { return x !== out.category; });
      out.product = PRODUCT_IDS.indexOf(r.product) >= 0 ? r.product : a.product.product;
      out.product_variant = r.product_variant === undefined ? a.product.product_variant : r.product_variant;
      out.kit_component = r.kit_component === undefined ? a.product.kit_component : r.kit_component;
      out.product_class = r.product_class || productClass(out.product);
      out.is_adverse_event = typeof r.is_adverse_event === 'boolean' ? r.is_adverse_event : a.safety.is_adverse_event;
      out.serious_ae = typeof r.serious_ae === 'boolean' ? r.serious_ae : a.safety.serious_ae;
      out.ae_criteria = Array.isArray(r.ae_criteria) ? r.ae_criteria : a.safety.ae_criteria;
      out.contraindication_flags = Array.isArray(r.contraindication_flags) ? r.contraindication_flags : a.safety.contraindication_flags;
      out.food_safety = typeof r.food_safety === 'boolean' ? r.food_safety : a.safety.food_safety;
      out.urgency = VALID_URGENCY[r.urgency] ? r.urgency : a.urgency.urgency;
      out.escalated_to = r.escalated_to || a.urgency.escalated_to;
    }
    out.lot_number = r.lot_number || a.entities.lot_number;
    out.order_id = r.order_id || a.entities.order_id;
    out.hcp_code = r.hcp_code || a.entities.hcp_code;
    out.claim_related = seed && typeof r.claim_related === 'boolean' ? r.claim_related || a.flags.claim_related : a.flags.claim_related;
    out.cancel_intent = seed && typeof r.cancel_intent === 'boolean' ? r.cancel_intent || a.flags.cancel_intent : a.flags.cancel_intent;
    out.restricted = !!(r.restricted || a.flags.restricted || r.segment === 'lnh_patient' || r.segment === 'hcp_patient');
    KEEP_ON_RECLASSIFY.forEach(function (k) { if (r[k] !== undefined) out[k] = r[k]; });
    if (!Array.isArray(out.tags)) out.tags = [];
    if (!Array.isArray(out.notes)) out.notes = [];
    if (out.status === undefined) out.status = 'new';
    if (out.reopen_count === undefined) out.reopen_count = 0;
    if (out.schema_version === undefined) out.schema_version = 1;
    out.classifier = {
      confidence: a.categories.confidence,
      rule_category: a.categories.category,
      rule_subcategory: a.categories.subcategory,
      rule_product: a.product.product,
      manual_override: manual,
      needs_review: a.categories.category !== out.category || a.categories.confidence < 0.5 || (seed && prev.needs_review === true)
    };
    return out;
  }

  /**
   * Stage-by-stage output for the Settings classifier tester.
   * @param {string} text
   * @param {string} [subject]
   * @returns {{stages: {name: string, output: any}[]}}
   */
  function explain(text, subject) {
    var clean = preprocess(text);
    var subj = subject == null ? '' : String(subject);
    var a = analyze(clean, subj, {});
    return { stages: [
      { name: 'preprocess', output: clean },
      { name: 'noise', output: isNoise({}, subj, clean) },
      { name: 'language', output: a.language },
      { name: 'sentiment', output: { compound: a.sentiment.compound, min: a.sentiment.min, label: a.label, hits: a.sentiment.hits, sentences: a.sentiment.sentences } },
      { name: 'categories', output: a.categories },
      { name: 'product', output: a.product },
      { name: 'safety', output: a.safety },
      { name: 'urgency', output: a.urgency },
      { name: 'entities', output: a.entities },
      { name: 'flags', output: a.flags }
    ] };
  }

  VOC.classify = {
    version: '1.0.0',
    preprocess: preprocess,
    isNoise: isNoise,
    detectLanguage: detectLanguage,
    scoreSentiment: scoreSentiment,
    scoreCategories: scoreCategories,
    detectProduct: detectProduct,
    assessSafety: assessSafety,
    assignUrgency: assignUrgency,
    extractEntities: extractEntities,
    flags: flags,
    fingerprint: fingerprint,
    classifyRecord: classifyRecord,
    reclassify: reclassify,
    explain: explain
  };
})();
