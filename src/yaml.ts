// Minimal YAML subset: block mappings, block sequences, flow sequences of
// scalars, quoted/plain scalars, block scalars (| and >), comments.
// Enough for roles.yml and spec/report frontmatter. No anchors, no tags.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

export class YamlError extends Error {
  constructor(message: string, public line: number) {
    super(`yaml line ${line}: ${message}`);
  }
}

interface Line {
  indent: number;
  text: string; // comment-stripped, trimmed right
  raw: string;
  no: number;
}

function stripComment(s: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) {
      if (inD && s[i - 1] === '\\') continue;
      inD = !inD;
    } else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function toLines(src: string): Line[] {
  const out: Line[] = [];
  const rows = src.replace(/\r\n?/g, '\n').split('\n');
  rows.forEach((raw, i) => {
    if (raw.includes('\t') && /^\s*\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', i + 1);
    const text = stripComment(raw).replace(/\s+$/, '');
    const indent = raw.length - raw.replace(/^ +/, '').length;
    out.push({ indent, text: text.trimStart(), raw, no: i + 1 });
  });
  return out;
}

function splitFlow(inner: string, lineNo: number): string[] {
  const items: string[] = [];
  let cur = '';
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS && inner[i - 1] !== '\\') inD = !inD;
    else if (!inS && !inD && (c === '[' || c === '{')) depth++;
    else if (!inS && !inD && (c === ']' || c === '}')) depth--;
    if (c === ',' && !inS && !inD && depth === 0) {
      items.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (inS || inD) throw new YamlError('unterminated string in flow sequence', lineNo);
  if (cur.trim() !== '') items.push(cur.trim());
  return items;
}

export function parseScalar(s: string, lineNo = 0): YamlValue {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new YamlError('unterminated flow sequence', lineNo);
    return splitFlow(t.slice(1, -1), lineNo).map((x) => parseScalar(x, lineNo));
  }
  if (t.startsWith('{')) {
    if (!t.endsWith('}')) throw new YamlError('unterminated flow mapping', lineNo);
    const obj: { [k: string]: YamlValue } = {};
    for (const part of splitFlow(t.slice(1, -1), lineNo)) {
      const m = /^("[^"]*"|'[^']*'|[^:]+):\s*(.*)$/.exec(part);
      if (!m) throw new YamlError(`bad flow mapping entry: ${part}`, lineNo);
      obj[unquoteKey(m[1])] = parseScalar(m[2], lineNo);
    }
    return obj;
  }
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new YamlError('unterminated double-quoted string', lineNo);
    return JSON.parse(t.replace(/\\'/g, "'"));
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new YamlError('unterminated single-quoted string', lineNo);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

function unquoteKey(k: string): string {
  const t = k.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return String(parseScalar(t));
  }
  return t;
}

const KEY_RE = /^("[^"]*"|'[^']*'|[^\s"'#\-?:,\[\]{}][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*)|)$/;

export function parse(src: string): YamlValue {
  const lines = toLines(src);
  let i = 0;

  function skipBlank() {
    while (i < lines.length && lines[i].text === '') i++;
  }

  function blockScalar(style: string, parentIndent: number): string {
    const folded = style.startsWith('>');
    const keep = style.includes('+');
    const strip = style.includes('-');
    const body: string[] = [];
    let ind = -1;
    while (i < lines.length) {
      const l = lines[i];
      const rawIndent = l.raw.length - l.raw.replace(/^ +/, '').length;
      if (l.raw.trim() === '') {
        body.push('');
        i++;
        continue;
      }
      if (rawIndent <= parentIndent) break;
      if (ind < 0) ind = rawIndent;
      if (rawIndent < ind) break;
      body.push(l.raw.slice(ind));
      i++;
    }
    while (!keep && body.length && body[body.length - 1] === '') body.pop();
    let text = folded ? body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : body.join('\n');
    if (!strip) text += '\n';
    return text;
  }

  function parseValueAfter(rest: string, parentIndent: number, lineNo: number): YamlValue {
    if (rest === '' || rest === undefined) {
      skipBlank();
      if (i >= lines.length) return null;
      const next = lines[i];
      if (next.indent > parentIndent) return parseBlock(next.indent);
      if (next.indent === parentIndent && next.text.startsWith('- ')) return parseBlock(next.indent);
      if (next.indent === parentIndent && next.text === '-') return parseBlock(next.indent);
      return null;
    }
    if (rest.startsWith('|') || rest.startsWith('>')) return blockScalar(rest, parentIndent);
    return parseScalar(rest, lineNo);
  }

  function parseBlock(indent: number): YamlValue {
    skipBlank();
    if (i >= lines.length) return null;
    const first = lines[i];
    if (first.text === '-' || first.text.startsWith('- ')) {
      const arr: YamlValue[] = [];
      while (i < lines.length) {
        skipBlank();
        if (i >= lines.length) break;
        const l = lines[i];
        if (l.indent < indent) break;
        if (l.indent > indent) throw new YamlError('unexpected indentation', l.no);
        if (!(l.text === '-' || l.text.startsWith('- '))) break;
        const content = l.text === '-' ? '' : l.text.slice(2).trim();
        i++;
        if (content === '') {
          arr.push(parseValueAfter('', indent, l.no));
        } else if (KEY_RE.test(content) && !content.startsWith('"') && !content.startsWith("'")) {
          // mapping inside sequence item: re-inject as virtual line
          const itemIndent = indent + 2;
          i--;
          lines[i] = { ...l, indent: itemIndent, text: content };
          arr.push(parseBlock(itemIndent));
        } else {
          arr.push(parseValueAfter(content, indent, l.no));
        }
      }
      return arr;
    }
    const obj: { [k: string]: YamlValue } = {};
    while (i < lines.length) {
      skipBlank();
      if (i >= lines.length) break;
      const l = lines[i];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.no);
      if (l.text.startsWith('- ')) break;
      const m = KEY_RE.exec(l.text);
      if (!m) throw new YamlError(`expected "key: value", got: ${l.text}`, l.no);
      const key = unquoteKey(m[1]);
      i++;
      if (key in obj) throw new YamlError(`duplicate key: ${key}`, l.no);
      obj[key] = parseValueAfter((m[2] ?? '').trim(), indent, l.no);
    }
    return obj;
  }

  skipBlank();
  if (i >= lines.length) return null;
  const root = parseBlock(lines[i].indent);
  skipBlank();
  if (i < lines.length) throw new YamlError(`unexpected content: ${lines[i].text}`, lines[i].no);
  return root;
}

// ---------- serializer ----------

function needsQuote(s: string): boolean {
  if (s === '') return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/[:#]\s|\s#|:$|\s$|[\n\r\t]/.test(s)) return true;
  if (/[*{}\[\],"']/.test(s)) return true;
  return false;
}

export function scalar(v: YamlValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return needsQuote(v) ? JSON.stringify(v) : v;
  throw new Error('not a scalar');
}

function isScalar(v: YamlValue): boolean {
  return v === null || typeof v !== 'object';
}

export function stringify(v: YamlValue, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (isScalar(v)) return pad + scalar(v) + '\n';
  if (Array.isArray(v)) {
    if (v.every(isScalar)) return pad + '[' + v.map((x) => JSON.stringify(x)).join(', ') + ']\n';
    return v.map((x) => (isScalar(x) ? `${pad}- ${scalar(x)}\n` : `${pad}-\n${stringify(x, indent + 2)}`)).join('');
  }
  let out = '';
  for (const [k, val] of Object.entries(v as { [k: string]: YamlValue })) {
    const key = needsQuote(k) ? JSON.stringify(k) : k;
    if (isScalar(val)) out += `${pad}${key}: ${scalar(val)}\n`;
    else if (Array.isArray(val) && val.every(isScalar)) {
      out += `${pad}${key}: [${val.map((x) => JSON.stringify(x)).join(', ')}]\n`;
    } else if (Array.isArray(val)) {
      out += `${pad}${key}:\n${stringify(val, indent + 2)}`;
    } else {
      out += `${pad}${key}:\n${stringify(val, indent + 2)}`;
    }
  }
  return out;
}
