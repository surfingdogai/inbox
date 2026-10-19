/**
 * A small, namespace-aware XML reader for WebDAV answers (RFC 4918 multistatus). Neither Node nor a
 * Worker has a DOM parser, and a dependency for this is more than it is worth. It reads elements,
 * attributes, text and CDATA; it skips comments, processing instructions and any DOCTYPE, and it
 * never expands an entity it does not know, so an answer cannot make it read a file or grow without
 * end. Depth and size are bounded.
 */

export const DAV = "DAV:";
export const CALDAV = "urn:ietf:params:xml:ns:caldav";
export const CALSERVER = "http://calendarserver.org/ns/";
export const APPLE = "http://apple.com/ns/ical/";

export interface XmlNode {
  readonly ns: string;
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

const MAX_DEPTH = 64;
const MAX_NODES = 200_000;

export class XmlError extends Error {}

export function parseXml(input: string): XmlNode {
  const root: XmlNode = { ns: "", name: "#document", attrs: {}, children: [], text: "" };
  const stack: { node: XmlNode; ns: Map<string, string> }[] = [{ node: root, ns: new Map([["xml", "xml"]]) }];
  let i = 0;
  let nodes = 0;
  const xml = input.replace(/^﻿/, "");
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (!top) throw new XmlError("unbalanced");
    if (lt < 0) {
      top.node.text += decode(xml.slice(i));
      break;
    }
    if (lt > i) top.node.text += decode(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlError("unclosed CDATA");
      top.node.text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // A DOCTYPE, with or without an internal subset: skipped whole, never read.
      let depth = 0;
      let j = lt + 2;
      for (; j < xml.length; j++) {
        const c = xml[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt);
      if (end < 0) throw new XmlError("unclosed end tag");
      if (stack.length <= 1) throw new XmlError("unbalanced end tag");
      stack.pop();
      i = end + 1;
      continue;
    }
    const end = tagEnd(xml, lt);
    if (end < 0) throw new XmlError("unclosed tag");
    const selfClosing = xml[end - 1] === "/";
    const inner = xml.slice(lt + 1, selfClosing ? end - 1 : end);
    const { qname, attrs } = readTag(inner);
    const ns = new Map(top.ns);
    const plain: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "xmlns") ns.set("", v);
      else if (k.startsWith("xmlns:")) ns.set(k.slice(6), v);
      else plain[k] = v;
    }
    const colon = qname.indexOf(":");
    const prefix = colon < 0 ? "" : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    const node: XmlNode = { ns: ns.get(prefix) ?? "", name: local, attrs: plain, children: [], text: "" };
    if (++nodes > MAX_NODES) throw new XmlError("too many elements");
    top.node.children.push(node);
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) throw new XmlError("too deep");
      stack.push({ node, ns });
    }
    i = end + 1;
  }
  return root;
}

function tagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let j = from + 1; j < xml.length; j++) {
    const c = xml[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return j;
  }
  return -1;
}

function readTag(inner: string): { qname: string; attrs: Record<string, string> } {
  const m = /^\s*([^\s/>]+)/.exec(inner);
  const qname = m?.[1] ?? "";
  const attrs: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const rest = inner.slice(m?.[0].length ?? 0);
  for (let a = re.exec(rest); a; a = re.exec(rest)) {
    attrs[a[1] ?? ""] = decode(a[3] ?? a[4] ?? "");
  }
  return { qname, attrs };
}

const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const n =
        ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[ref] ?? whole;
  });
}

/** The children of a node with this namespace and name. */
export function children(node: XmlNode | undefined, ns: string, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.ns === ns && c.name === name) : [];
}

export function child(node: XmlNode | undefined, ns: string, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.ns === ns && c.name === name);
}

/** Every descendant with this namespace and name, in document order. */
export function descendants(node: XmlNode | undefined, ns: string, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.ns === ns && c.name === name) out.push(c);
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

export function textOf(node: XmlNode | undefined): string {
  return node ? node.text.trim() : "";
}

/** One `response` of a multistatus: its href and the properties that came back 200. */
export interface DavResponse {
  readonly href: string;
  readonly status: number | null;
  readonly props: XmlNode[];
}

export function multistatus(xml: string): DavResponse[] {
  const doc = parseXml(xml);
  return descendants(doc, DAV, "response").map((r) => {
    const props: XmlNode[] = [];
    for (const ps of children(r, DAV, "propstat")) {
      const code = statusCode(textOf(child(ps, DAV, "status")));
      if (code !== null && code >= 200 && code < 300) {
        for (const p of children(ps, DAV, "prop")) props.push(...p.children);
      }
    }
    return { href: textOf(child(r, DAV, "href")), status: statusCode(textOf(child(r, DAV, "status"))), props };
  });
}

export function prop(r: DavResponse, ns: string, name: string): XmlNode | undefined {
  return r.props.find((p) => p.ns === ns && p.name === name);
}

function statusCode(line: string): number | null {
  const m = /HTTP\/[\d.]+\s+(\d{3})/i.exec(line);
  return m ? Number(m[1]) : null;
}

/** Escapes text for an XML body we send. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
