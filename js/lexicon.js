/* L-Nutra VoC — js/lexicon.js (PURE)
 * VADER-style sentiment lexicon: general BASE terms (−4..+4), an L-Nutra DOMAIN layer
 * (phrases allowed, `\d+` patterns resolved by classify.js), VADER boosters/dampeners,
 * negators, a brand stoplist (carries no valence) and English + domain-filler stopwords.
 * Loaded before rules.js and classify.js. No DOM access.
 */
window.VOC = window.VOC || {};
(function () {
  'use strict';

  /** General English valence terms, VADER scale −4..+4. */
  var BASE = {
    // strong positive
    love: 3.2, loved: 3.2, loving: 3.0, adore: 3.0, excellent: 3.4, exceptional: 3.2, outstanding: 3.3, superb: 3.2,
    amazing: 3.3, awesome: 3.1, fantastic: 3.2, wonderful: 3.1, incredible: 3.0, phenomenal: 3.1, perfect: 3.2,
    perfectly: 2.7, best: 3.2, brilliant: 3.0, fabulous: 3.0, terrific: 3.0, marvelous: 3.0, magnificent: 3.0,
    spectacular: 3.0, flawless: 3.0, stellar: 2.9, delighted: 2.9, delightful: 2.8, thrilled: 3.0, ecstatic: 3.1,
    overjoyed: 3.0, impressed: 2.4, impressive: 2.5, grateful: 2.5, gratitude: 2.3, blessed: 2.4, lifesaver: 3.0,
    // positive
    great: 3.1, good: 1.9, nice: 1.8, glad: 2.0, happy: 2.7, happier: 2.5, pleased: 2.2, pleasant: 2.0, pleasure: 2.3,
    enjoy: 2.2, enjoyed: 2.2, enjoying: 2.2, enjoyable: 2.2, satisfied: 2.1, satisfying: 2.0, satisfaction: 1.9,
    helpful: 1.8, helped: 1.6, helps: 1.4, help: 0.5, kind: 1.8, kindly: 1.5, friendly: 1.9, courteous: 1.9, polite: 1.7,
    professional: 1.6, prompt: 1.5, promptly: 1.5, quick: 1.3, quickly: 1.2, fast: 1.1, efficient: 1.7, responsive: 1.6,
    easy: 1.5, easier: 1.4, easily: 1.2, smooth: 1.4, smoothly: 1.4, seamless: 1.8, convenient: 1.6, simple: 1.0,
    recommend: 1.8, recommended: 1.8, recommending: 1.8, worth: 1.4, worthwhile: 1.8, value: 1.0, valuable: 1.9,
    appreciate: 2.0, appreciated: 2.0, appreciative: 1.9, thank: 0.5, thankful: 2.0, thanks: 0.5, welcome: 1.3,
    win: 2.0, won: 1.7, winner: 2.1, success: 2.3, successful: 2.3, succeeded: 2.1, improve: 1.4, improved: 1.7,
    improvement: 1.6, better: 1.9, benefit: 1.6, benefits: 1.5, beneficial: 1.9, positive: 1.9, effective: 1.7,
    works: 1.2, worked: 1.2, working: 0.8, favorite: 2.0, favourite: 2.0, fan: 1.3, proud: 2.1, confident: 1.9,
    motivated: 1.9, encouraging: 1.9, encouraged: 1.7, inspiring: 2.1, inspired: 2.0, reassuring: 1.8,
    healthy: 1.7, healthier: 1.9, strong: 1.5, stronger: 1.6, fresh: 1.3, clean: 1.0, comfortable: 1.6, calm: 1.3,
    relief: 1.4, relieved: 1.6, hope: 1.2, hopeful: 1.8, hoping: 0.8, optimistic: 1.6, excited: 2.2, exciting: 2.1,
    fun: 1.9, interesting: 1.4, cool: 1.3, solid: 1.1, reliable: 1.8, trust: 1.6, trusted: 1.7, trustworthy: 2.1,
    honest: 1.9, generous: 1.9, fair: 1.1, reasonable: 1.2, affordable: 1.5, bonus: 1.5, gift: 1.4, free: 1.0,
    resolved: 1.6, fixed: 1.2, sorted: 1.0, refunded: 0.9, accommodating: 1.8, attentive: 1.7, thorough: 1.3,
    okay: 0.5, ok: 0.5, fine: 0.8, decent: 1.0, alright: 0.6, acceptable: 0.9, adequate: 0.6, manageable: 0.8,
    yes: 0.6, yay: 2.0, wow: 1.8, congratulations: 2.3, gorgeous: 2.7, beautiful: 2.7, lovely: 2.5, sweet: 0.5,
    yummy: 2.4, tasty: 2.0, delicious: 2.6, flavorful: 1.9, satisfy: 1.6, filling: 0.9, fresher: 1.2, crisp: 0.8,
    // negative
    bad: -2.5, badly: -2.1, poor: -2.1, poorly: -2.0, terrible: -3.1, terribly: -2.7, awful: -3.0, horrible: -3.1,
    horrendous: -3.1, horrid: -2.9, dreadful: -3.0, atrocious: -3.2, appalling: -3.0, disgusting: -3.0, gross: -2.4,
    nasty: -2.5, vile: -2.9, revolting: -2.9, worst: -3.1, worse: -2.1, worsened: -2.0, worsening: -2.0,
    disappointed: -2.4, disappointing: -2.3, disappointment: -2.3, disappoint: -2.1, letdown: -2.0, underwhelming: -1.8,
    frustrated: -2.2, frustrating: -2.2, frustration: -2.1, annoyed: -1.9, annoying: -1.9, irritated: -1.9,
    irritating: -1.9, angry: -2.7, anger: -2.4, furious: -3.0, livid: -2.9, outraged: -2.9, outrageous: -2.6,
    upset: -2.1, upsetting: -2.1, mad: -2.0, hate: -2.7, hated: -2.7, hateful: -2.6, despise: -2.7, loathe: -2.7,
    sad: -2.1, unhappy: -2.1, miserable: -2.6, depressing: -2.3, awkward: -1.2, uncomfortable: -1.6, unpleasant: -2.0,
    sick: -1.9, ill: -1.8, pain: -2.1, painful: -2.2, hurt: -2.0, hurts: -2.0, suffer: -2.3, suffering: -2.4,
    scam: -3.3, scammed: -3.3, scammer: -3.2, fraud: -3.3, fraudulent: -3.2, cheat: -2.7, cheated: -2.7, rip: -1.6,
    ripoff: -2.9, 'rip-off': -2.9, robbery: -2.8, theft: -2.7, stole: -2.7, stolen: -2.7, steal: -2.5, lie: -2.2,
    lied: -2.4, lies: -2.2, lying: -2.3, liar: -2.6, dishonest: -2.6, deceptive: -2.6, deceive: -2.5, misled: -2.3,
    misleading: -2.4, sketchy: -1.9, shady: -2.1, suspicious: -1.8, untrustworthy: -2.5, unethical: -2.6,
    waste: -2.1, wasted: -2.1, wasting: -1.9, useless: -2.3, worthless: -2.6, pointless: -2.0, garbage: -2.7,
    trash: -2.5, junk: -2.3, crap: -2.4, crappy: -2.5, rubbish: -2.3, sucks: -2.4, suck: -2.2, sucked: -2.3,
    rude: -2.3, rudely: -2.2, unprofessional: -2.4, unhelpful: -2.2, incompetent: -2.6, careless: -2.1, clueless: -2.0,
    ignored: -2.1, ignore: -1.7, ignoring: -1.9, dismissive: -2.1, condescending: -2.3, arrogant: -2.2,
    unacceptable: -2.7, unacceptably: -2.5, ridiculous: -2.1, absurd: -2.0, insane: -1.6, crazy: -1.1, joke: -1.3,
    pathetic: -2.6, shameful: -2.5, disgrace: -2.6, disgraceful: -2.7, embarrassing: -2.0, insulting: -2.4, insult: -2.2,
    problem: -1.7, problems: -1.7, problematic: -1.8, issue: -1.3, issues: -1.4, trouble: -1.7, troubles: -1.6,
    error: -1.6, errors: -1.6, mistake: -1.7, mistakes: -1.7, bug: -1.5, glitch: -1.4, broken: -2.0, broke: -1.8,
    fail: -2.2, failed: -2.2, failure: -2.3, failing: -2.1, fault: -1.7, faulty: -2.1, defective: -2.3, defect: -2.0,
    damaged: -2.0, damage: -1.9, ruined: -2.5, destroyed: -2.4, wrecked: -2.2, mess: -1.7, messy: -1.4, chaos: -1.9,
    wrong: -1.8, incorrect: -1.6, missing: -1.8, lost: -1.7, stuck: -1.5, delay: -1.3, slow: -1.4, slowly: -1.0,
    sluggish: -1.4, unresponsive: -2.1, silence: -1.0, nobody: -0.9,
    expensive: -1.4, overpriced: -2.2, pricey: -1.3, costly: -1.3, unaffordable: -1.9, greedy: -2.3, greed: -2.3,
    hard: -0.8, difficult: -1.4, difficulty: -1.4, complicated: -1.2, confusing: -1.6, confused: -1.4, confusion: -1.5,
    impossible: -1.9, unable: -1.5, unclear: -1.2, vague: -1.1, inconsistent: -1.4, unreliable: -2.1,
    cheap: -1.0, flimsy: -1.7, tacky: -1.6, weak: -1.5, bland: -1.5, boring: -1.5, dull: -1.3, stale: -2.0,
    rotten: -2.7, spoiled: -2.4, rancid: -2.8, sour: -1.2, bitter: -1.3, salty: -0.6, soggy: -1.5, mushy: -1.4,
    inedible: -2.8, unedible: -2.8, unbearable: -2.6, intolerable: -2.6, excruciating: -3.0, agony: -2.8,
    dangerous: -2.4, danger: -2.3, unsafe: -2.5, harmful: -2.4, harm: -2.1, toxic: -2.5, poison: -2.7, poisoning: -2.9,
    scary: -1.9, scared: -2.0, terrified: -2.7, frightening: -2.3, alarming: -2.0, alarmed: -1.8, worried: -1.6,
    worry: -1.5, worrying: -1.7, concerned: -1.3, concern: -1.1, concerning: -1.5, nervous: -1.3, anxious: -1.6,
    stress: -1.7, stressed: -1.8, stressful: -1.9, exhausted: -1.9, exhausting: -1.9, tired: -1.3, drained: -1.7,
    dizzy: -1.5, nauseous: -2.0, nauseated: -2.1, vomited: -2.3, vomiting: -2.3, faint: -1.9, fainted: -2.4,
    starving: -1.7, starved: -1.6, cramps: -1.7, cramping: -1.6, bloating: -1.5, ache: -1.6, aching: -1.6,
    complain: -1.6, complaint: -1.6, complaints: -1.6, complained: -1.6, dispute: -1.6, disputed: -1.5, refuse: -1.5,
    refused: -1.7, refusing: -1.6, denied: -1.7, deny: -1.3, reject: -1.6, rejected: -1.8, blocked: -1.4,
    unauthorized: -2.4, unwanted: -1.8, unexpected: -0.9, surprise: 0.3, surprised: 0.4, shocked: -1.5, shocking: -1.8,
    regret: -2.0, regretted: -2.0, sorry: -0.5, apologize: -0.3, apology: -0.2, unfortunately: -1.1, sadly: -1.5,
    quit: -1.2, quitting: -1.1, abandon: -1.8, gave: -0.2, cancelled: -0.8, canceled: -0.8, cancellation: -0.9,
    forever: 0.2, nope: -1.0, dead: -2.5, die: -2.6, died: -2.7, dying: -2.6,
    kill: -2.5, killing: -2.2, hell: -1.9, damn: -1.5, wtf: -2.2, ugh: -1.5, meh: -0.6, hmm: -0.2, bleh: -1.2,
    // neutral-ish anchors that shift the compound slightly
    curious: 0.5, wondering: 0.1, question: 0.0, questions: 0.0, hopefully: 0.7, understand: 0.6, understanding: 0.9,
    care: 1.0, careful: 0.9, caring: 1.9, support: 1.2, supportive: 1.9, patient: 0.8, patience: 0.7, loyal: 1.7,
    loyalty: 1.5, again: 0.0, agree: 1.0, disagree: -1.2, doubt: -1.1, doubtful: -1.2, skeptical: -1.1, unsure: -0.8,
    lucky: 1.8, luckily: 1.6, safe: 1.6, safely: 1.3, secure: 1.2, gentle: 1.1, mild: 0.3, mildly: 0.1, tolerable: 0.5,
    fabulously: 2.8, gladly: 1.9, joy: 2.6, joyful: 2.6, cheerful: 2.1, radiant: 2.0, glowing: 1.8, vibrant: 1.9,
    accomplished: 2.0, achieve: 1.6, achieved: 1.8, achievement: 2.0, progress: 1.4, milestone: 1.4, goal: 0.6,
    disaster: -2.8, nightmare: -2.9, catastrophe: -2.8, fiasco: -2.5, debacle: -2.4, ordeal: -2.2, hassle: -1.7,
    headache: -1.5, inconvenience: -1.4, inconvenient: -1.5, burden: -1.6, tedious: -1.4, cumbersome: -1.3,
    warning: -1.0, warn: -0.9, beware: -1.5, avoid: -1.3, avoided: -1.0, stop: -0.8, stopped: -0.7, stops: -0.6,
    unsubscribe: -0.9, spam: -1.9, spammed: -2.0, bombarded: -1.8, harass: -2.5, harassment: -2.6, pushy: -1.7,
    pressure: -1.1, pressured: -1.6, manipulative: -2.3, gimmick: -1.7, hype: -1.0, overhyped: -1.6, disillusioned: -2.0,
    happily: 2.2, pleasantly: 1.8, nicely: 1.6, wonderfully: 2.8, beautifully: 2.4, greatly: 1.3, superior: 1.9,
    top: 1.0, topnotch: 2.5, premium: 1.0, quality: 1.1, luxury: 1.2, genuine: 1.4, authentic: 1.5, real: 0.6,
    legit: 1.5, legitimate: 1.2, refreshing: 1.8, soothing: 1.5, nourishing: 1.8, nourished: 1.7, wholesome: 1.8,
    balanced: 1.2, consistent: 1.1, dependable: 1.8, thoughtful: 1.9, generously: 1.7, graciously: 1.9, promptness: 1.4
  };

  /** L-Nutra domain layer. Keys with spaces are phrases; `\d+` is a digit-run wildcard resolved by classify.js. */
  var DOMAIN = {
    delicious: 2.0, tasty: 2.0, energized: 2.2, energizing: 2.0, energy: 1.5, clarity: 1.8, focus: 1.0, focused: 1.2,
    lighter: 1.0, refreshed: 1.5, rejuvenated: 1.9, reset: 0.4, recharged: 1.7, 'lost \\d+ lbs': 2.0, 'lost \\d+ pounds': 2.0,
    'lost \\d+ lb': 2.0, 'down \\d+ lbs': 1.8, 'down \\d+ pounds': 1.8, 'lost weight': 1.6, 'weight loss': 0.8, 'inches off': 1.6,
    'more energy': 2.0, 'mental clarity': 2.0, 'slept better': 1.7, 'sleep better': 1.5, 'feel great': 2.6, 'feel amazing': 3.0,
    'felt great': 2.4, 'life changing': 3.0, 'life-changing': 3.0, 'game changer': 2.6, 'highly recommend': 2.8,
    'would recommend': 2.0, 'love the results': 3.0, 'blood work improved': 2.2, 'labs improved': 2.2, 'a1c dropped': 2.0,
    'cravings gone': 2.0, 'no cravings': 1.6, 'not hungry': 1.2, "wasn't hungry": 1.2, 'only edible thing': -1.2,
    bland: -1.5, stale: -2.0, moldy: -3.0, mold: -2.8, chalky: -1.6, gritty: -1.4, 'astronaut food': -2.0, cardboard: -1.8,
    leaked: -2.0, leaking: -2.0, leak: -1.8, leaks: -1.8, hunger: -1.0, hungry: -1.0, headache: -1.5, headaches: -1.6,
    nausea: -2.0, nauseous: -2.0, bloated: -1.5, lightheaded: -1.8, 'light headed': -1.8, dizzy: -1.5, dizziness: -1.6,
    fatigue: -1.4, fatigued: -1.5, 'brain fog': -1.5, foggy: -1.0, jittery: -1.3, shaky: -1.6, weak: -1.5, cranky: -1.4,
    irritable: -1.5, insomnia: -1.6, 'could not sleep': -1.5, "couldn't sleep": -1.5, constipated: -1.7, constipation: -1.7,
    diarrhea: -2.0, cramps: -1.7, late: -1.5, delayed: -1.0, delay: -1.0, refund: -1.0, cancel: -1.5, cancelled: -1.2,
    canceled: -1.2, 'charged twice': -2.5, 'charged me twice': -2.5, 'double charged': -2.5, 'double charge': -2.4,
    'never received': -2.0, 'never arrived': -2.0, 'not arrived': -1.8, "hasn't arrived": -1.8, 'has not arrived': -1.8, 'not received': -1.6, "haven't received": -1.8, 'have not received': -1.8, 'not shipped': -1.5, 'not worth': -2.0, 'hard bits': -2.5, 'hard bit': -2.3, 'nut shell': -2.5,
    'nut shells': -2.5, 'shell fragment': -2.6, 'no cancellation link': -2.0, 'cancellation link': -0.8, 'food noise': -1.0,
    'still waiting': -1.6, 'still not arrived': -2.0, 'still has not arrived': -2.0, 'no response': -2.0, 'no reply': -1.8,
    'no one responded': -2.0, 'no answer': -1.5, 'signed up without': -2.6, 'without my permission': -2.6, 'without permission': -2.4,
    'without my consent': -2.6, 'auto renewed': -1.5, 'auto-renewed': -1.5, 'auto renew': -0.8, autoship: -0.4,
    'final sale': -0.8, 'no refunds': -1.4, 'too expensive': -1.8, 'a day': 0.0, 'per day': 0.0, 'passed out': -2.8,
    fainted: -2.6, 'emergency room': -2.8, hospital: -2.2, 'chest pain': -2.8, 'allergic reaction': -2.6, hives: -1.9,
    rash: -1.6, 'blood sugar crashed': -2.6, 'blood sugar dropped': -2.2, hypoglycemia: -2.2, hypoglycemic: -2.2,
    wonderful: 3.1, 'kept me full': 1.8, 'surprisingly good': 2.0, 'surprisingly filling': 1.6, 'pleasantly surprised': 2.2,
    'looking forward': 1.2, 'excited to start': 1.9, 'can\'t wait': 1.6, 'cannot wait': 1.6, 'worth every penny': 3.0,
    'worth it': 1.8, 'money back': -1.0, 'want my money back': -2.4, 'never again': -2.6, 'never order again': -2.6,
    'never buying again': -2.6, 'last time': -0.8, 'lesson learned': -1.4, 'buyer beware': -2.4, 'do not buy': -2.4,
    "don't buy": -2.4, 'stay away': -2.4, 'save your money': -2.2, 'wish i could': -0.8, 'melted': -1.5, 'crushed': -1.6,
    'smashed': -1.8, 'expired': -2.0, 'expiration': -0.5, 'short dated': -1.4, 'short-dated': -1.4, 'spoiled': -2.4,
    'smelled off': -2.0, 'smells off': -2.0, 'tastes off': -1.8, 'tasted off': -1.8, 'porch': 0.0, 'no tracking': -1.2,
    'tracking has not updated': -1.4, "tracking hasn't updated": -1.4, 'wrong item': -1.8, 'wrong flavor': -1.4,
    'missing item': -1.8, 'missing items': -1.8, 'was missing': -1.6, 'welcome kit': 0.0, 'broke out': -1.6, 'flare up': -1.8,
    'flare-up': -1.8, 'threw up': -2.4, 'thrown up': -2.4, 'ambulance': -2.8, 'anaphylaxis': -3.2, 'anaphylactic': -3.2,
    epipen: -2.6, 'could not breathe': -3.0, "couldn't breathe": -3.0, seizure: -3.0, 'thank you so much': 2.4,
    'above and beyond': 2.8, 'took care of it': 1.8, 'made it right': 2.0, 'sorted it out': 1.6, 'quick reply': 1.6,
    'fast reply': 1.6, 'fast shipping': 1.8, 'arrived early': 1.6, 'arrived quickly': 1.6, 'easy to follow': 1.6,
    'well organized': 1.6, 'well packaged': 1.4, 'beautifully packaged': 1.9, 'too sweet': -1.5, 'sickly sweet': -1.8, 'cough syrup': -1.8, 'way too': -0.3,
    soaked: -1.5, drenched: -1.5, wet: -1.0, 'in the rain': -1.2, freezing: -1.4, chills: -1.4, shivering: -1.4, crash: -1.8, crashes: -1.8, crashed: -1.8, crashing: -1.8,
    'gained it all back': -2.0, 'gained back': -1.8, 'gained it back': -1.8, regained: -1.8, 'water weight': -1.0, undeclared: -2.0, 'chipped a tooth': -2.5, 'chipped my tooth': -2.5,
    'not applied': -1.5, "wasn't applied": -1.5, 'full price': -0.8, 'held at customs': -1.2, 'import duties': -1.0, 'label created': -1.0, 'not updated': -1.2, "hasn't updated": -1.2, 'has not updated': -1.2,
    'wrong item': -1.8, 'instead of': -0.4, 'canned response': -1.8, 'same response': -1.4, 'real person': 0.0, 'too many emails': -1.8, 'so many emails': -1.6, 'keep coming': -0.8,
    'fit better': 1.6, 'fits better': 1.6, 'fit looser': 1.4, 'pants fit': 1.0, 'no guesswork': 1.4, 'laid out': 0.8, 'easy to follow': 1.6, 'so easy': 1.8, 'super easy': 1.8, 'very easy': 1.6,
    // L-Nutra program and channel vocabulary: neutral anchors so these words never tilt a record on their own
    'transition day': 0.0, 'refeed': 0.0, 'refeed day': 0.0, 'refeeding': 0.0, 'welcome kit': 0.0, 'hcp code': 0.0, 'practitioner code': 0.0, glycerol: 0.0,
    fullscript: 0.0, dispensary: 0.0, 'subscribe and save': 0.0, 'subscribe & save': 0.0, 'return label': -0.8, 'amazon return': -0.6, 'send it back': -1.0,
    'return it': -0.8, 'final sale': -0.8, 'lot hold': -0.6, 'day 6': 0.0
  };

  /** VADER booster/dampener increments (applied to the preceding valence sign). */
  var B = 0.293;
  var BOOSTERS = {
    absolutely: B, amazingly: B, awfully: B, completely: B, considerably: B, decidedly: B, deeply: B, effing: B, enormously: B,
    entirely: B, especially: B, exceptionally: B, extremely: B, fabulously: B, flipping: B, flippin: B, fricking: B,
    frickin: B, frigging: B, friggin: B, fully: B, fucking: B, greatly: B, hella: B, highly: B, hugely: B, incredibly: B,
    intensely: B, majorly: B, more: B, most: B, particularly: B, purely: B, quite: B, really: B, remarkably: B, so: B,
    substantially: B, thoroughly: B, totally: B, tremendously: B, uber: B, unbelievably: B, unusually: B, utterly: B,
    very: B, super: B, seriously: B, insanely: B, ridiculously: B, extra: B, truly: B, genuinely: B, honestly: B,
    definitely: B, beyond: B, way: B, such: B, downright: B
  };
  var DAMPENERS = {
    almost: -B, barely: -B, hardly: -B, 'just enough': -B, 'kind of': -B, kinda: -B, kindof: -B, 'kind-of': -B, less: -B,
    little: -B, marginally: -B, occasionally: -B, partly: -B, scarcely: -B, slightly: -B, somewhat: -B, 'sort of': -B,
    sorta: -B, sortof: -B, 'sort-of': -B, a_bit: -B, bit: -B, fairly: -B, moderately: -B, mildly: -B, relatively: -B
  };

  /** Negation tokens; a hit within 3 tokens before a valence term flips it by ×−0.74. */
  var NEGATORS = [
    'aint', "ain't", 'arent', "aren't", 'cannot', 'cant', "can't", 'couldnt', "couldn't", 'darent', "daren't", 'didnt', "didn't",
    'doesnt', "doesn't", 'dont', "don't", 'hadnt', "hadn't", 'hasnt', "hasn't", 'havent', "haven't", 'isnt', "isn't", 'mightnt',
    "mightn't", 'mustnt', "mustn't", 'neither', 'neednt', "needn't", 'never', 'none', 'nope', 'nor', 'not', 'nothing', 'nowhere',
    'oughtnt', "oughtn't", 'shant', "shan't", 'shouldnt', "shouldn't", 'uhuh', 'uh-uh', 'wasnt', "wasn't", 'werent', "weren't",
    'without', 'wont', "won't", 'wouldnt', "wouldn't", 'rarely', 'seldom', 'despite', 'no', 'zero', 'lack', 'lacking', 'lacks'
  ];

  /** Brand tokens that never carry valence, even when BASE has a homograph (e.g. 'fast', 'reset'). */
  var BRAND_STOPLIST = ['prolon', 'fast', 'bar', 'reset', 'next', 'gen', 'longevity', 'l-drink', 'l-nutra', 'nutra', 'fasting', 'l-bar', 'nr-1', 'l-pill', 'l-protein', 'loop', 'shake', 'starter'];

  /** English function words plus domain fillers that carry no topical signal. */
  var STOPWORDS = [
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been',
    'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each',
    'few', 'for', 'from', 'further', 'get', 'got', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
    'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself',
    'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
    'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
    'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
    'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
    'also', 'am', 'been', 'im', "i'm", 'ive', "i've", 'id', "i'd", 'dont', "don't", 'didnt', "didn't", 'cant', "can't", 'wont',
    "won't", 'isnt', "isn't", 'wasnt', "wasn't", 'its', "it's", 'thats', "that's", 'there', 'theres', "there's", 'still', 'even',
    'ever', 'yet', 'one', 'two', 'first', 'last', 'day', 'days', 'week', 'time', 'like', 'know', 'let', 'make', 'made', 'much',
    'many', 'may', 'might', 'must', 'need', 'really', 'said', 'say', 'see', 'since', 'something', 'take', 'tell', 'them', 'want',
    'way', 'well', 'went', 'back', 'come', 'came', 'going', 'go', 'us', 'ok', 'okay', 'yes', 'yeah', 'thing', 'things', 'lot',
    'lots', 'able', 'around', 'another', 'anyone', 'anything', 'everything', 'someone', 'per', 'via', 'etc', 'regards', 'best',
    'dear', 'sincerely', 'cheers', 'kind', 'hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'email', 'team', 'order', 'kit',
    'prolon', 'lnutra', 'l-nutra', 'nutra', 'support', 'customer', 'service', 'question', 'help', 'info', 'account', 'number',
    'received', 'sent', 'wrote', 'message', 'subject', 'today', 'yesterday', 'tomorrow', 'morning', 'ago', 'hope', 'hoping',
    'wanted', 'wondering', 'anyway', 'however', 'though', 'although', 'unless', 'whether', 'either', 'every', 'within', 'without',
    'already', 'always', 'never', 'often', 'sometimes', 'usually', 'quite', 'rather', 'pretty', 'almost', 'enough', 'less', 'least',
    'new', 'old', 'next', 'previous', 'long', 'ago', 'later', 'soon', 'right', 'left', 'end', 'start', 'started', 'using', 'used',
    'use', 'try', 'tried', 'trying', 'give', 'gave', 'given', 'put', 'keep', 'kept', 'seem', 'seems', 'seemed', 'look', 'looks',
    'looked', 'find', 'found', 'think', 'thought', 'feel', 'feels', 'felt', 'call', 'called', 'name', 'address', 'phone', 'mr',
    'mrs', 'ms', 'inc', 'llc', 'com', 'www', 'http', 'https', 're', 'fw', 'fwd'
  ];

  var STOPSET = {};
  STOPWORDS.forEach(function (w) { STOPSET[w] = true; });
  var BRANDSET = {};
  BRAND_STOPLIST.forEach(function (w) { BRANDSET[w] = true; });

  /**
   * Valence for a single lowercase term or phrase. Domain layer wins over base; brand tokens return undefined.
   * @param {string} term
   * @returns {number|undefined}
   */
  function valence(term) {
    if (typeof term !== 'string') return undefined;
    var t = term.toLowerCase().trim();
    if (!t || BRANDSET[t]) return undefined;
    if (Object.prototype.hasOwnProperty.call(DOMAIN, t)) return DOMAIN[t];
    if (Object.prototype.hasOwnProperty.call(BASE, t)) return BASE[t];
    return undefined;
  }

  /**
   * True when the lowercase token is a stopword (English function word or domain filler).
   * @param {string} token
   * @returns {boolean}
   */
  function isStopword(token) {
    return !!(token && STOPSET[String(token).toLowerCase()]);
  }

  VOC.lexicon = {
    version: '1.0.0',
    BASE: BASE,
    DOMAIN: DOMAIN,
    BOOSTERS: BOOSTERS,
    DAMPENERS: DAMPENERS,
    NEGATORS: NEGATORS,
    BRAND_STOPLIST: BRAND_STOPLIST,
    STOPWORDS: STOPWORDS,
    valence: valence,
    isStopword: isStopword
  };
})();
