/**
 * VOC.mime — RFC 5322 / 2045 / 2047 parsing of raw .eml text.
 *
 * PURE module: no DOM, no storage, no network. Runs under JavaScriptCore.
 * Input is "latin1-preserving" text: every char code 0–255 stands for one
 * byte of the original message so that charsets can be decoded here. Text
 * that is already Unicode (any char code > 255) is passed through untouched.
 *
 * Public surface (SPEC §4.11):
 *   parse(rawText)            → { headers, contentType, params, parts, text, html, attachments }
 *   decodeWords(headerValue)  → string           RFC 2047 encoded words (B and Q)
 *   decodeQP(s, charset)      → string           quoted-printable body → text
 *   decodeB64(s, charset)     → string           base64 body → text
 *   toRawEmail(parsed, source, opts) → RawEmail  (SPEC §2)
 * Additions: parseDate, parseAddresses, htmlToText, decodeBytes, parseContentType.
 */
window.VOC = window.VOC || {};
VOC.mime = (function () {
  'use strict';

  /* ------------------------------------------------------------------ bytes */

  var CP1252_HIGH = [
    0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
    0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178
  ];

  function normalizeCharset(cs) {
    var c = String(cs || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '').trim();
    if (!c || c === 'utf8' || c === 'utf-8' || c === 'us-ascii' || c === 'ascii' || c === 'unicode-1-1-utf-8') return 'utf-8';
    if (c === 'iso-8859-1' || c === 'latin1' || c === 'latin-1' || c === 'l1' || c === 'iso8859-1' || c === 'iso_8859-1') return 'iso-8859-1';
    if (c === 'windows-1252' || c === 'cp1252' || c === 'cp-1252' || c === 'ansi_x3.4-1968') return 'windows-1252';
    return c;
  }

  /** Every char code ≤ 255 → the string is a byte string we may decode. */
  function isByteString(s) {
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return false;
    return true;
  }

  function toBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  }

  function decodeUtf8Manual(bytes) {
    var out = [], i = 0, n = bytes.length, chunk = [];
    while (i < n) {
      var b = bytes[i], cp, need = 0;
      if (b < 0x80) { cp = b; i++; }
      else if (b >= 0xC2 && b <= 0xDF) { need = 1; cp = b & 0x1F; }
      else if (b >= 0xE0 && b <= 0xEF) { need = 2; cp = b & 0x0F; }
      else if (b >= 0xF0 && b <= 0xF4) { need = 3; cp = b & 0x07; }
      else { cp = 0xFFFD; i++; }
      if (need) {
        if (i + need > n - 1) { cp = 0xFFFD; i = n; }
        else {
          var ok = true;
          for (var k = 1; k <= need; k++) {
            var c = bytes[i + k];
            if (c === undefined || (c & 0xC0) !== 0x80) { ok = false; break; }
            cp = (cp << 6) | (c & 0x3F);
          }
          if (ok) i += need + 1; else { cp = 0xFFFD; i++; }
        }
      }
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        chunk.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else chunk.push(cp);
      if (chunk.length > 4096) { out.push(String.fromCharCode.apply(null, chunk)); chunk = []; }
    }
    if (chunk.length) out.push(String.fromCharCode.apply(null, chunk));
    return out.join('');
  }

  function decodeSingleByte(bytes, cp1252) {
    var out = [], chunk = [];
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      chunk.push(cp1252 && b >= 0x80 && b <= 0x9F ? CP1252_HIGH[b - 0x80] : b);
      if (chunk.length > 4096) { out.push(String.fromCharCode.apply(null, chunk)); chunk = []; }
    }
    if (chunk.length) out.push(String.fromCharCode.apply(null, chunk));
    return out.join('');
  }

  /**
   * Decode bytes with a charset. Uses TextDecoder when the runtime has it,
   * otherwise a built-in UTF-8 / ISO-8859-1 / Windows-1252 decoder.
   * @param {Uint8Array} bytes
   * @param {string} [charset='utf-8']
   * @returns {string}
   */
  function decodeBytes(bytes, charset) {
    var cs = normalizeCharset(charset);
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder(cs, { fatal: false }).decode(bytes); } catch (e) { /* unknown label → fall through */ }
    }
    if (cs === 'iso-8859-1') return decodeSingleByte(bytes, false);
    if (cs === 'windows-1252') return decodeSingleByte(bytes, true);
    return decodeUtf8Manual(bytes);
  }

  /** Decode a byte string (char codes 0–255) as `charset`; pass Unicode through. */
  function decodeByteString(s, charset) {
    if (!s) return '';
    if (!isByteString(s)) return s;
    return decodeBytes(toBytes(s), charset);
  }

  /* --------------------------------------------------------------- encodings */

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_LOOKUP = (function () {
    var t = new Int16Array(256); for (var i = 0; i < 256; i++) t[i] = -1;
    for (var j = 0; j < 64; j++) t[B64.charCodeAt(j)] = j;
    t['-'.charCodeAt(0)] = 62; t['_'.charCodeAt(0)] = 63; // url-safe tolerated
    return t;
  })();

  function b64ToBytes(s) {
    var clean = String(s || '').replace(/[^A-Za-z0-9+\/=_-]/g, '');
    var len = clean.length;
    while (len > 0 && clean.charCodeAt(len - 1) === 61) len--;
    var out = new Uint8Array(Math.floor(len * 3 / 4));
    var o = 0, acc = 0, bits = 0;
    for (var i = 0; i < len; i++) {
      var v = B64_LOOKUP[clean.charCodeAt(i)];
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; if (o < out.length) out[o++] = (acc >> bits) & 0xFF; }
    }
    return o === out.length ? out : out.subarray(0, o);
  }

  /** Decoded byte length of a base64 body without materialising it. */
  function b64Size(s) {
    var clean = String(s || '').replace(/[^A-Za-z0-9+\/=]/g, '');
    var len = clean.length;
    while (len > 0 && clean.charCodeAt(len - 1) === 61) len--;
    return Math.floor(len * 3 / 4);
  }

  function qpToBytes(s) {
    var src = String(s || '').replace(/=\r?\n/g, '').replace(/[ \t]+(\r?\n)/g, '$1');
    var out = new Uint8Array(src.length), o = 0;
    for (var i = 0; i < src.length; i++) {
      var c = src.charCodeAt(i);
      if (c === 61 && i + 2 < src.length && /^[0-9A-Fa-f]{2}$/.test(src.substr(i + 1, 2))) {
        out[o++] = parseInt(src.substr(i + 1, 2), 16); i += 2;
      } else out[o++] = c & 0xFF;
    }
    return out.subarray(0, o);
  }

  /**
   * Decode a quoted-printable body.
   * @param {string} s encoded text
   * @param {string} [charset='utf-8']
   * @returns {string}
   */
  function decodeQP(s, charset) { return decodeBytes(qpToBytes(s), charset); }

  /**
   * Decode a base64 body.
   * @param {string} s encoded text
   * @param {string} [charset='utf-8']
   * @returns {string}
   */
  function decodeB64(s, charset) { return decodeBytes(b64ToBytes(s), charset); }

  /* ------------------------------------------------------------- RFC 2047 */

  var ENCODED_WORD = /=\?([^?\s]+?)(?:\*[^?]*)?\?([bBqQ])\?([^?\s]*)\?=/g;

  /**
   * Decode RFC 2047 encoded words inside a header value. Whitespace between
   * two adjacent encoded words is dropped (RFC 2047 §6.2).
   * @param {string} h
   * @returns {string}
   */
  function decodeWords(h) {
    if (!h) return '';
    var s = String(h).replace(/\?=\s+=\?/g, '?==?');
    return s.replace(ENCODED_WORD, function (m, cs, enc, txt) {
      try {
        if (enc === 'B' || enc === 'b') return decodeB64(txt, cs);
        return decodeQP(txt.replace(/_/g, '=20'), cs);
      } catch (e) { return m; }
    });
  }

  /* -------------------------------------------------------------- headers */

  function unfold(headerText) {
    return String(headerText || '').replace(/\r\n|\r/g, '\n').replace(/\n[ \t]+/g, ' ');
  }

  /**
   * Parse a header block. Returns lower-cased names; the first occurrence
   * wins except `received`, which is joined with '\n'.
   */
  function parseHeaders(headerText) {
    var map = {}, list = [];
    var lines = unfold(headerText).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = /^([!-9;-~]+):\s*([\s\S]*)$/.exec(line);
      if (!m) continue;
      var name = m[1].toLowerCase(), value = m[2].trim();
      list.push({ name: name, value: value });
      if (name === 'received') map[name] = map[name] ? map[name] + '\n' + value : value;
      else if (!(name in map)) map[name] = value;
    }
    return { map: map, list: list };
  }

  /** Parse `type/subtype; a=b; c="d"` including RFC 2231 continuations. */
  function parseContentType(v) {
    var s = String(v || '').trim();
    var semi = s.indexOf(';');
    var type = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase();
    var params = parseParams(semi < 0 ? '' : s.slice(semi + 1));
    if (!type || type.indexOf('/') < 0) type = type || 'text/plain';
    return { type: type, params: params };
  }

  function parseParams(rest) {
    var params = {}, cont = {};
    var re = /\s*([^=;\s]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]*)\s*(?:;|$)/g, m;
    while ((m = re.exec(rest)) !== null) {
      if (!m[0].trim()) { if (re.lastIndex >= rest.length) break; re.lastIndex++; continue; }
      var key = m[1].toLowerCase();
      var val = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[2].trim();
      var star = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
      if (star) {
        var base = star[1], idx = star[2] === undefined ? 0 : parseInt(star[2], 10), extended = !!star[3] || star[2] === undefined;
        cont[base] = cont[base] || [];
        cont[base][idx] = { val: val, extended: extended };
      } else params[key] = val;
    }
    Object.keys(cont).forEach(function (base) {
      var segs = cont[base], joined = '', charset = 'utf-8';
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i]; if (!seg) continue;
        var v = seg.val;
        if (seg.extended) {
          if (i === 0) { var q = /^([^']*)'[^']*'([\s\S]*)$/.exec(v); if (q) { charset = q[1] || 'utf-8'; v = q[2]; } }
          v = decodeBytes(qpToBytes(v.replace(/%([0-9A-Fa-f]{2})/g, '=$1')), charset);
        }
        joined += v;
      }
      if (!(base in params)) params[base] = joined;
    });
    return params;
  }

  /* ------------------------------------------------------------- dates */

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var ZONES = { ut: 0, utc: 0, gmt: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420,
    cet: 60, cest: 120, bst: 60, ist: 330, jst: 540, aest: 600, aedt: 660 };

  function toIsoNoMs(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * Parse an RFC 5322 date (with tolerant fallbacks) to an ISO-8601 UTC string.
   * @param {string} s
   * @returns {string|null}
   */
  function parseDate(s) {
    if (!s) return null;
    var str = String(s).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    var m = /^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/.exec(str);
    if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
      var year = parseInt(m[3], 10); if (m[3].length === 2) year += year < 50 ? 2000 : 1900;
      var offsetMin = 0, z = m[7];
      if (z) {
        if (/^[+-]\d{4}$/.test(z)) offsetMin = (z[0] === '-' ? -1 : 1) * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10));
        else if (ZONES[z.toLowerCase()] !== undefined) offsetMin = ZONES[z.toLowerCase()];
      }
      var ms = Date.UTC(year, MONTHS[m[2].toLowerCase()], parseInt(m[1], 10), parseInt(m[4], 10), parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0) - offsetMin * 60000;
      return toIsoNoMs(new Date(ms));
    }
    var iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(str);
    if (iso) {
      var off = 0;
      if (iso[7] && iso[7] !== 'Z') off = (iso[7][0] === '-' ? -1 : 1) * (parseInt(iso[7].substr(1, 2), 10) * 60 + parseInt(iso[7].replace(':', '').substr(3, 2), 10));
      var t = Date.UTC(+iso[1], +iso[2] - 1, +iso[3], iso[4] ? +iso[4] : 0, iso[5] ? +iso[5] : 0, iso[6] ? +iso[6] : 0) - off * 60000;
      return toIsoNoMs(new Date(t));
    }
    var fallback = Date.parse(str);
    return isNaN(fallback) ? null : toIsoNoMs(new Date(fallback));
  }

  /* ---------------------------------------------------------- addresses */

  function splitAddressList(s) {
    var out = [], buf = '', depth = 0, quoted = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '"' && s[i - 1] !== '\\') quoted = !quoted;
      else if (!quoted && c === '<') depth++;
      else if (!quoted && c === '>') depth = Math.max(0, depth - 1);
      if (c === ',' && !quoted && depth === 0) { out.push(buf); buf = ''; } else buf += c;
    }
    if (buf.trim()) out.push(buf);
    return out;
  }

  /**
   * Parse an address header into [{name, email}]. Emails are lower-cased;
   * names are RFC 2047 decoded and unquoted.
   * @param {string} s
   * @returns {{name: string|null, email: string|null}[]}
   */
  function parseAddresses(s) {
    if (!s) return [];
    var decoded = decodeWords(String(s)).replace(/\s+/g, ' ').trim();
    var items = splitAddressList(decoded), out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i].trim(); if (!item) continue;
      var name = null, email = null;
      var angle = /^(.*?)<([^<>]*)>\s*$/.exec(item);
      if (angle) {
        email = angle[2].trim();
        name = angle[1].replace(/\([^)]*\)/g, '').trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim() || null;
      } else {
        var stripped = item.replace(/\([^)]*\)/g, '').trim();
        var em = /[^\s"<>,;]+@[^\s"<>,;]+/.exec(stripped);
        if (em) { email = em[0]; var rest = stripped.replace(em[0], '').replace(/^"(.*)"$/, '$1').trim(); name = rest || null; }
        else name = stripped.replace(/^"(.*)"$/, '$1') || null;
      }
      if (email) email = email.replace(/^mailto:/i, '').toLowerCase();
      if (name && email && name.toLowerCase() === email) name = null;
      out.push({ name: name, email: email });
    }
    return out;
  }

  /* -------------------------------------------------------------- html */

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
    hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
    eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä',
    szlig: 'ß', ntilde: 'ñ', iacute: 'í', oacute: 'ó', uacute: 'ú', euro: '€', pound: '£', deg: '°' };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (m, e) {
      if (e[0] === '#') {
        var cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!isFinite(cp) || cp < 0 || cp > 0x10FFFF) return m;
        return cp > 0xFFFF ? String.fromCharCode(0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF)) : String.fromCharCode(cp);
      }
      return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
    });
  }

  /**
   * Strip HTML to readable plain text (block tags → newlines, entities decoded).
   * @param {string} html
   * @returns {string}
   */
  function htmlToText(html) {
    if (!html) return '';
    var s = String(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]*\n[ \t]*/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6]|blockquote|table|pre|section|article|header|footer)>/gi, '\n')
      .replace(/<(p|div|tr|h[1-6]|blockquote|table|pre|hr|section|article)\b[^>]*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '');
    s = decodeEntities(s).replace(/ /g, ' ');
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------------------------------------------------------- entities */

  function splitHeadBody(raw) {
    var s = String(raw || '').replace(/\r\n|\r/g, '\n');
    if (/^From \S+ .*\n/.test(s)) s = s.replace(/^From .*\n/, '');
    var idx = s.indexOf('\n\n');
    if (idx < 0) {
      // No blank line: treat as headers only when the first line looks like a header.
      return /^[!-9;-~]+:/.test(s) ? { head: s, body: '' } : { head: '', body: s };
    }
    if (!/^[!-9;-~]+:/.test(s)) return { head: '', body: s };
    return { head: s.slice(0, idx), body: s.slice(idx + 2) };
  }

  function splitMultipart(body, boundary) {
    var lines = body.split('\n'), parts = [], cur = null, started = false, closed = false;
    var delim = '--' + boundary, close = delim + '--';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], trimmed = line.replace(/\s+$/, '');
      if (trimmed === close) { if (cur) parts.push(cur.join('\n')); cur = null; closed = true; break; }
      if (trimmed === delim) { if (cur) parts.push(cur.join('\n')); cur = []; started = true; continue; }
      if (cur) cur.push(line);
    }
    if (cur && !closed) parts.push(cur.join('\n'));
    if (!started) return null;
    return parts;
  }

  function decodeTextBody(body, cte, charset) {
    var enc = String(cte || '7bit').toLowerCase().trim();
    if (enc === 'base64') return decodeB64(body, charset);
    if (enc === 'quoted-printable') return decodeQP(body, charset);
    return decodeByteString(body, charset);
  }

  function bodySize(body, cte) {
    var enc = String(cte || '7bit').toLowerCase().trim();
    if (enc === 'base64') return b64Size(body);
    if (enc === 'quoted-printable') return qpToBytes(body).length;
    return body.length;
  }

  function parseEntity(raw, depth) {
    var hb = splitHeadBody(raw);
    var headers = parseHeaders(hb.head);
    var ct = parseContentType(headers.map['content-type']);
    var cd = parseContentType(headers.map['content-disposition'] || '');
    var cte = headers.map['content-transfer-encoding'] || '7bit';
    var filename = cd.params.filename || ct.params.name || null;
    if (filename) filename = decodeWords(filename).trim() || null;
    var node = {
      headers: headers.map,
      contentType: ct.type,
      params: ct.params,
      charset: ct.params.charset || null,
      disposition: cd.type && cd.type.indexOf('/') < 0 ? cd.type : (cd.type ? cd.type.split('/')[0] : null),
      filename: filename,
      contentId: headers.map['content-id'] ? headers.map['content-id'].replace(/^<|>$/g, '') : null,
      encoding: String(cte).toLowerCase().trim(),
      size: 0,
      text: null,
      children: null
    };
    if (ct.type.indexOf('multipart/') === 0 && ct.params.boundary && depth < 20) {
      var pieces = splitMultipart(hb.body, ct.params.boundary);
      if (pieces) {
        node.children = pieces.map(function (p) { return parseEntity(p, depth + 1); });
        return node;
      }
      node.contentType = 'text/plain';
    }
    node.size = bodySize(hb.body, cte);
    var isText = node.contentType.indexOf('text/') === 0;
    var isAttachment = node.disposition === 'attachment' || (!isText && node.contentType !== 'message/rfc822') ||
      (isText && !!filename && node.contentType !== 'text/plain' && node.contentType !== 'text/html') ||
      (isText && node.disposition === 'inline' && !!filename && node.contentType !== 'text/html' && node.contentType !== 'text/plain');
    if (node.contentType === 'message/rfc822') isAttachment = true;
    node.isAttachment = isAttachment;
    if (!isAttachment && isText) {
      var stripped = hb.body.replace(/\n$/, '');
      node.text = decodeTextBody(stripped, cte, node.charset || 'utf-8');
    }
    return node;
  }

  function collectLeaves(node, out) {
    if (node.children) { node.children.forEach(function (c) { collectLeaves(c, out); }); return out; }
    out.push(node);
    return out;
  }

  /**
   * Parse a raw RFC 5322 message.
   * @param {string} rawText latin1-preserving message text (CRLF or LF)
   * @returns {{headers: Object<string,string>, contentType: string, params: Object, parts: Object[], text: string, html: string|null,
   *            attachments: {name: string, type: string, size: number}[]}}
   */
  function parse(rawText) {
    var root = parseEntity(String(rawText || ''), 0);
    var leaves = collectLeaves(root, []);
    var texts = [], htmls = [], attachments = [], parts = [];
    leaves.forEach(function (leaf) {
      parts.push({
        contentType: leaf.contentType, charset: leaf.charset, encoding: leaf.encoding, disposition: leaf.disposition,
        filename: leaf.filename, contentId: leaf.contentId, size: leaf.size, isAttachment: !!leaf.isAttachment, text: leaf.text
      });
      if (leaf.isAttachment) {
        attachments.push({ name: leaf.filename || (leaf.contentType === 'message/rfc822' ? 'message.eml' : 'attachment'), type: leaf.contentType, size: leaf.size });
      } else if (leaf.contentType === 'text/html') htmls.push(leaf.text || '');
      else if (leaf.text !== null) texts.push(leaf.text);
    });
    var html = htmls.length ? htmls.join('\n') : null;
    var text = texts.filter(function (t) { return t.trim(); }).join('\n\n').trim();
    if (!text && html) text = htmlToText(html);
    var headers = root.headers;
    var decoded = {};
    Object.keys(headers).forEach(function (k) { decoded[k] = headers[k]; });
    ['subject', 'from', 'to', 'cc', 'bcc', 'reply-to', 'sender'].forEach(function (k) { if (decoded[k]) decoded[k] = decodeWords(decoded[k]); });
    return { headers: decoded, contentType: root.contentType, params: root.params, parts: parts, text: text, html: html, attachments: attachments };
  }

  /* ---------------------------------------------------------- RawEmail */

  function stripAngle(v) { return v ? String(v).trim().replace(/^<|>$/g, '') : null; }

  function parseReferences(v) {
    if (!v) return [];
    var out = [], re = /<([^<>\s]+)>/g, m;
    while ((m = re.exec(v)) !== null) out.push(m[1]);
    if (!out.length) out = String(v).split(/\s+/).filter(Boolean);
    return out;
  }

  function fallbackFnv64(str) {
    var s = String(str), h = 0xcbf29ce484222325n, p = 0x100000001b3n, mask = 0xFFFFFFFFFFFFFFFFn;
    for (var i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i) & 0xFF); h = (h * p) & mask; }
    return h.toString(16).padStart(16, '0');
  }

  function fnv64(str) {
    var u = window.VOC && window.VOC.util;
    return u && typeof u.fnv64 === 'function' ? u.fnv64(str) : fallbackFnv64(str);
  }

  function matchesAgent(email, opts) {
    if (!email || !opts) return false;
    var list = (opts.agentAddresses || []).map(function (a) { return String(a).toLowerCase().trim(); });
    if (list.indexOf(email) >= 0) return true;
    var domains = (opts.agentDomains || []).map(function (d) { return String(d).toLowerCase().replace(/^@/, ''); });
    var dom = email.split('@')[1] || '';
    return domains.indexOf(dom) >= 0;
  }

  /**
   * Convert a parsed message to a RawEmail (SPEC §2).
   * @param {Object} parsed result of parse()
   * @param {string} source 'eml'|'mbox'|'imap'|'json'
   * @param {{agentAddresses?: string[], agentDomains?: string[]}} [opts] senders treated as outbound
   * @returns {Object} RawEmail
   */
  function toRawEmail(parsed, source, opts) {
    var h = (parsed && parsed.headers) || {};
    var from = parseAddresses(h.from || h.sender || h['reply-to'])[0] || { name: null, email: null };
    var to = parseAddresses(h.to).map(function (a) { return a.email; }).filter(Boolean);
    var cc = parseAddresses(h.cc).map(function (a) { return a.email; }).filter(Boolean);
    var messageId = stripAngle(h['message-id']);
    var inReplyTo = stripAngle((parseReferences(h['in-reply-to'])[0]) || null);
    var references = parseReferences(h.references);
    var date = parseDate(h.date) || null;
    var subject = (h.subject || '').replace(/\s+/g, ' ').trim();
    var text = parsed && parsed.text ? parsed.text : '';
    if (!messageId) messageId = 'gen-' + fnv64([from.email || '', date || '', subject, text.slice(0, 200)].join('|'));
    var threadId = references[0] || inReplyTo || messageId;
    var hdr = {
      auto_submitted: h['auto-submitted'] || null,
      precedence: h.precedence || null,
      list_id: h['list-id'] || null,
      list_unsubscribe: h['list-unsubscribe'] || null,
      content_type: h['content-type'] || null,
      x_autoreply: h['x-autoreply'] || h['x-autorespond'] || h['x-auto-response-suppress'] || null
    };
    return {
      message_id: messageId,
      thread_id: threadId,
      in_reply_to: inReplyTo,
      references: references,
      date: date,
      from_name: from.name,
      from_email: from.email,
      to: to,
      cc: cc,
      subject: subject,
      text: text,
      html: parsed && parsed.html ? parsed.html : null,
      direction: matchesAgent(from.email, opts) ? 'outbound' : 'inbound',
      attachments: (parsed && parsed.attachments || []).map(function (a) { return { name: a.name, type: a.type, size: a.size }; }),
      headers: hdr,
      source: source || 'eml'
    };
  }

  return {
    parse: parse,
    decodeWords: decodeWords,
    decodeQP: decodeQP,
    decodeB64: decodeB64,
    decodeBytes: decodeBytes,
    parseDate: parseDate,
    parseAddresses: parseAddresses,
    parseContentType: parseContentType,
    htmlToText: htmlToText,
    toRawEmail: toRawEmail
  };
})();
