/**
 * RFC 8941 Structured Field Values: enough to read and write the headers of an HTTP message
 * signature (RFC 9421) — dictionaries, lists, inner lists, parameters and every bare item — and to
 * serialize a dictionary member the way a signature base needs it.
 *
 * It follows the network's reader rule for rule (the vectors in `packages/spec/vectors/signatures.json`
 * hold the two to each other), including one deliberate limit: a field over 8 KB is refused before it
 * is parsed. The fields the profiles use are a few hundred bytes, and they are read before any
 * signature is checked.
 */

export const SF_MAX_LENGTH = 8 * 1024;

export type SfBare =
  | { readonly kind: "integer"; readonly value: number }
  /** A decimal, in thousandths: all the precision RFC 8941 allows, so it serializes back exactly. */
  | { readonly kind: "decimal"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "token"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "boolean"; readonly value: boolean };

export interface SfParam {
  readonly key: string;
  readonly value: SfBare;
}

export interface SfItem {
  readonly bare: SfBare;
  readonly params: readonly SfParam[];
}

/** A list member or a dictionary value: an item, or an inner list with its own parameters. */
export type SfMember = {
  /** The dictionary key; "" in a list. */
  readonly key: string;
  /** The member's text exactly as it appeared (for a bare dictionary key, `?1` and its parameters). */
  readonly raw: string;
} & (
  | { readonly list: true; readonly inner: readonly SfItem[]; readonly params: readonly SfParam[] }
  | { readonly list: false; readonly item: SfItem }
);

export class SfError extends Error {
  constructor() {
    super("not a structured field");
    this.name = "SfError";
  }
}

const isLcAlpha = (c: string) => c >= "a" && c <= "z";
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isDigit = (c: string) => c >= "0" && c <= "9";
const isTChar = (c: string) => isAlpha(c) || isDigit(c) || "!#$%&'*+-.^_`|~".includes(c);

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  eof(): boolean {
    return this.i >= this.s.length;
  }
  peek(): string {
    return this.s[this.i] as string;
  }
  skipSP(): void {
    while (this.i < this.s.length && this.s[this.i] === " ") this.i++;
  }
  skipOWS(): void {
    while (this.i < this.s.length && (this.s[this.i] === " " || this.s[this.i] === "\t")) this.i++;
  }

  key(): string {
    if (this.eof() || !(isLcAlpha(this.peek()) || this.peek() === "*")) throw new SfError();
    const start = this.i;
    while (!this.eof()) {
      const c = this.peek();
      if (!(isLcAlpha(c) || isDigit(c) || c === "_" || c === "-" || c === "." || c === "*")) break;
      this.i++;
    }
    return this.s.slice(start, this.i);
  }

  bare(): SfBare {
    if (this.eof()) throw new SfError();
    const c = this.peek();
    if (c === "-" || isDigit(c)) return this.number();
    if (c === '"') return this.string();
    if (c === ":") return this.bytes();
    if (c === "?") return this.boolean();
    if (isAlpha(c) || c === "*") {
      const start = this.i;
      this.i++;
      while (!this.eof() && (isTChar(this.peek()) || this.peek() === ":" || this.peek() === "/")) this.i++;
      return { kind: "token", value: this.s.slice(start, this.i) };
    }
    throw new SfError();
  }

  number(): SfBare {
    let neg = false;
    if (this.peek() === "-") {
      neg = true;
      this.i++;
    }
    const start = this.i;
    let dot = -1;
    while (!this.eof()) {
      const c = this.peek();
      if (isDigit(c)) this.i++;
      else if (c === "." && dot < 0) {
        dot = this.i;
        this.i++;
      } else break;
      if ((dot < 0 && this.i - start > 15) || (dot >= 0 && this.i - start > 16)) throw new SfError();
    }
    const num = this.s.slice(start, this.i);
    if (num === "" || !isDigit(num[0] as string)) throw new SfError();
    if (dot < 0) {
      const v = Number.parseInt(num, 10);
      return { kind: "integer", value: neg ? -v : v };
    }
    const intPart = this.s.slice(start, dot);
    const frac = this.s.slice(dot + 1, this.i);
    if (intPart.length > 12 || frac.length < 1 || frac.length > 3) throw new SfError();
    const v = Number.parseInt(intPart, 10) * 1000 + Number.parseInt(`${frac}00`.slice(0, 3), 10);
    return { kind: "decimal", value: neg ? -v : v };
  }

  string(): SfBare {
    this.i++; // the opening quote
    let out = "";
    while (!this.eof()) {
      const c = this.peek();
      this.i++;
      if (c === "\\") {
        if (this.eof()) throw new SfError();
        const n = this.peek();
        if (n !== '"' && n !== "\\") throw new SfError();
        out += n;
        this.i++;
      } else if (c === '"') {
        return { kind: "string", value: out };
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) throw new SfError();
        out += c;
      }
    }
    throw new SfError();
  }

  bytes(): SfBare {
    this.i++; // the opening colon
    const start = this.i;
    while (!this.eof() && this.peek() !== ":") {
      const c = this.peek();
      if (!(isAlpha(c) || isDigit(c) || c === "+" || c === "/" || c === "=")) throw new SfError();
      this.i++;
    }
    if (this.eof()) throw new SfError();
    const encoded = this.s.slice(start, this.i);
    this.i++; // the closing colon
    // RFC 8941 §4.2.7: missing "=" padding is tolerated.
    const bare = encoded.replace(/=+$/, "");
    if (bare.includes("=") || bare.length % 4 === 1) throw new SfError();
    let binary: string;
    try {
      binary = atob(bare + "=".repeat((4 - (bare.length % 4)) % 4));
    } catch {
      throw new SfError();
    }
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return { kind: "bytes", value: out };
  }

  boolean(): SfBare {
    this.i++; // "?"
    if (this.eof() || (this.peek() !== "0" && this.peek() !== "1")) throw new SfError();
    const value = this.peek() === "1";
    this.i++;
    return { kind: "boolean", value };
  }

  /** `;key[=value]…`. A repeated key keeps its first position and its last value (RFC 8941 §4.2.3.2). */
  params(): SfParam[] {
    const out: SfParam[] = [];
    while (!this.eof() && this.peek() === ";") {
      this.i++;
      this.skipSP();
      const key = this.key();
      let value: SfBare = { kind: "boolean", value: true };
      if (!this.eof() && this.peek() === "=") {
        this.i++;
        value = this.bare();
      }
      const at = out.findIndex((p) => p.key === key);
      if (at >= 0) out[at] = { key, value };
      else out.push({ key, value });
    }
    return out;
  }

  item(): SfItem {
    const bare = this.bare();
    return { bare, params: this.params() };
  }

  member(key: string): SfMember {
    const start = this.i;
    if (!this.eof() && this.peek() === "(") {
      this.i++;
      const inner: SfItem[] = [];
      for (;;) {
        this.skipSP();
        if (this.eof()) throw new SfError();
        if (this.peek() === ")") {
          this.i++;
          const params = this.params();
          return { key, list: true, inner, params, raw: this.s.slice(start, this.i) };
        }
        inner.push(this.item());
        if (this.eof() || (this.peek() !== " " && this.peek() !== ")")) throw new SfError();
      }
    }
    const item = this.item();
    return { key, list: false, item, raw: this.s.slice(start, this.i) };
  }

  /** The separator between two members; a trailing comma is refused. */
  next(): void {
    this.skipOWS();
    if (this.eof()) return;
    if (this.peek() !== ",") throw new SfError();
    this.i++;
    this.skipOWS();
    if (this.eof()) throw new SfError();
  }
}

const trimSpaces = (s: string) => s.replace(/^ +| +$/g, "");

/** A dictionary. A repeated key keeps its first position and its last value. */
export function parseDictionary(field: string): SfMember[] {
  if (field.length > SF_MAX_LENGTH) throw new SfError();
  const p = new Parser(trimSpaces(field));
  const out: SfMember[] = [];
  while (!p.eof()) {
    const key = p.key();
    let m: SfMember;
    if (!p.eof() && p.peek() === "=") {
      p.i++;
      m = p.member(key);
    } else {
      const start = p.i;
      const params = p.params();
      m = {
        key,
        list: false,
        item: { bare: { kind: "boolean", value: true }, params },
        raw: `?1${p.s.slice(start, p.i)}`,
      };
    }
    const at = out.findIndex((x) => x.key === key);
    if (at >= 0) out[at] = m;
    else out.push(m);
    p.next();
  }
  return out;
}

/** A list. */
export function parseList(field: string): SfMember[] {
  if (field.length > SF_MAX_LENGTH) throw new SfError();
  const p = new Parser(trimSpaces(field));
  const out: SfMember[] = [];
  while (!p.eof()) {
    out.push(p.member(""));
    p.next();
  }
  return out;
}

/** A lone inner list with its parameters: the form of a forwarded signature's `signature_input`. */
export function parseInnerList(text: string): SfMember & { readonly list: true } {
  if (text.length > SF_MAX_LENGTH) throw new SfError();
  const p = new Parser(text);
  if (p.eof() || p.peek() !== "(") throw new SfError();
  const m = p.member("");
  if (!m.list || !p.eof()) throw new SfError();
  return m;
}

/** A single item (the legacy string form of `Signature-Agent`). */
export function parseItem(field: string): SfItem {
  if (field.length > SF_MAX_LENGTH) throw new SfError();
  const p = new Parser(trimSpaces(field));
  const item = p.item();
  if (!p.eof()) throw new SfError();
  return item;
}

export function dictionaryMember(members: readonly SfMember[], key: string): SfMember | undefined {
  return members.find((m) => m.key === key);
}

export function paramString(params: readonly SfParam[], key: string): string | undefined {
  const p = params.find((x) => x.key === key);
  return p?.value.kind === "string" ? p.value.value : undefined;
}

export function paramInteger(params: readonly SfParam[], key: string): number | undefined {
  const p = params.find((x) => x.key === key);
  return p?.value.kind === "integer" ? p.value.value : undefined;
}

/* --- serialization (RFC 8941 §4.1) ------------------------------------------------------------ */

export function serializeString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function standardBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function serializeBare(b: SfBare): string {
  switch (b.kind) {
    case "integer":
      return String(b.value);
    case "decimal": {
      const sign = b.value < 0 ? "-" : "";
      const v = Math.abs(b.value);
      const frac = String(v % 1000)
        .padStart(3, "0")
        .replace(/0+$/, "");
      return `${sign}${Math.floor(v / 1000)}.${frac || "0"}`;
    }
    case "string":
      return serializeString(b.value);
    case "token":
      return b.value;
    case "bytes":
      return `:${standardBase64(b.value)}:`;
    case "boolean":
      return b.value ? "?1" : "?0";
  }
}

export function serializeParams(params: readonly SfParam[]): string {
  let out = "";
  for (const p of params) {
    out += `;${p.key}`;
    if (!(p.value.kind === "boolean" && p.value.value)) out += `=${serializeBare(p.value)}`;
  }
  return out;
}

export function serializeMember(m: SfMember): string {
  if (!m.list) return serializeBare(m.item.bare) + serializeParams(m.item.params);
  const parts = m.inner.map((it) => serializeBare(it.bare) + serializeParams(it.params));
  return `(${parts.join(" ")})${serializeParams(m.params)}`;
}
