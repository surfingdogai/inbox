import {
  type CalendarChoice,
  ConnectorError,
  type ConnectorHttp,
  type ConnectorHttpResponse,
  type Interval,
} from "@surfingdog/core";
import { lookupPath, lookupSrv } from "../dns";
import { basicAuth, mayCarryCredentials, retryAfterMs } from "../http";
import { busyFromICal } from "./ical";
import { CALDAV, child, children, DAV, descendants, multistatus, prop, textOf } from "./xml";

/**
 * CalDAV (RFC 4791) as a small business meets it: iCloud, Fastmail, Nextcloud and any server that
 * speaks it. Finding the server follows RFC 6764: an address the owner gave, else the DNS SRV record
 * of their email's domain, else `/.well-known/caldav` there; then the principal, its calendar home,
 * and the calendars in it.
 *
 * The app password goes only to the calendar server that asks for it. Every address found on the
 * way (an email's domain is most often the business's website, at a website host) is first asked
 * without it, and taken only when it answers as a calendar server does: a WebDAV answer, or a
 * request to sign in. From then on the password goes to that host alone (or within a provider whose
 * hosts are all its own, `mayCarryCredentials`), and any other host a server names is refused.
 */

export interface DavAccount {
  readonly username: string;
  readonly password: string;
}

export interface Discovered {
  readonly principal: string;
  readonly home: string;
  readonly calendars: readonly (CalendarChoice & { readonly components: readonly string[] })[];
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/><d:displayname/></d:prop>
</d:propfind>`;

const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/>
    <cs:getctag/><a:calendar-order/>
  </d:prop>
</d:propfind>`;

/** How long finding a calendar may take in all, so the owner hears in time what to do instead. */
export const DISCOVERY_BUDGET_MS = 25_000;
/** One call to a calendar server, at most. */
const CALL_TIMEOUT_MS = 20_000;

/**
 * The calendar servers of providers that are their own and need no asking: the password goes to
 * them straight away.
 */
const KNOWN_SERVERS: ReadonlySet<string> = new Set(["caldav.icloud.com", "caldav.fastmail.com"]);

const NOT_FOUND = "No calendar was found for that email. Add the server address under More options.";

export class CalDavClient {
  /** The host that asked for the password, which alone receives it. */
  private authHost: string | null;
  /** When discovery must stop, so the owner hears what to do in time. */
  private deadline: number | null = null;

  constructor(
    private readonly http: ConnectorHttp,
    private readonly account: DavAccount,
    opts: { readonly authHost?: string | null | undefined } = {},
  ) {
    this.authHost = opts.authHost ?? null;
  }

  /** The host the password goes to, once one asked for it: kept with the connection. */
  get signedInAt(): string | null {
    return this.authHost;
  }

  private timeout(): number {
    if (this.deadline === null) return CALL_TIMEOUT_MS;
    return Math.max(1_000, Math.min(CALL_TIMEOUT_MS, this.deadline - Date.now()));
  }

  private expired(): boolean {
    return this.deadline !== null && Date.now() >= this.deadline;
  }

  async send(
    method: string,
    url: string,
    opts: { body?: string; depth?: "0" | "1"; headers?: Record<string, string>; contentType?: string } = {},
  ): Promise<ConnectorHttpResponse> {
    const host = hostOf(url);
    if (!this.authHost || !mayCarryCredentials(this.authHost, host)) {
      // A server naming a calendar on another host does not take the password there with it.
      throw new ConnectorError("config", `${host} is not the calendar server this account signed in to.`);
    }
    const res = await this.http.request({
      method,
      url,
      headers: {
        authorization: basicAuth(this.account.username, this.account.password),
        ...(opts.depth ? { depth: opts.depth } : {}),
        ...(opts.body ? { "content-type": opts.contentType ?? "application/xml; charset=utf-8" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.body ? { body: opts.body } : {}),
      followRedirects: method === "PROPFIND" || method === "GET" || method === "REPORT",
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: this.timeout(),
    });
    if (res.status === 401) {
      throw new ConnectorError(
        "auth",
        "The calendar did not take that email and app password. Make a new app password and press Connect again.",
        { field: "password" },
      );
    }
    if (res.status === 429) {
      throw new ConnectorError("rate_limited", `${host} asked this inbox to wait.`, {
        retryAfterMs: retryAfterMs(res.headers),
      });
    }
    if (res.status >= 500) {
      throw new ConnectorError(
        "unreachable",
        `${host} is not answering properly; this inbox tries again in a few minutes.`,
        {
          retryAfterMs: retryAfterMs(res.headers),
        },
      );
    }
    return res;
  }

  /**
   * Asks an address, without the password, whether a calendar server is there: a WebDAV answer, or
   * a request to sign in with a password. The address it ends at, after its redirects, or null.
   */
  private async probe(url: string): Promise<{ readonly url: string } | { readonly problem: string }> {
    let res: ConnectorHttpResponse;
    try {
      res = await this.http.request({
        method: "PROPFIND",
        url,
        headers: { depth: "0", "content-type": "application/xml; charset=utf-8" },
        body: PROPFIND_PRINCIPAL,
        followRedirects: true,
        maxBytes: 256 * 1024,
        timeoutMs: this.timeout(),
      });
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) };
    }
    if (res.status === 207) return { url: res.url };
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      if (/(^|[\s,])basic(\s|$|,)/i.test(challenge)) return { url: res.url };
      return { problem: `${hostOf(res.url)} asks for a kind of sign-in this inbox cannot give` };
    }
    return { problem: `${hostOf(res.url)} is not a calendar server` };
  }

  /* --- finding the account ---------------------------------------------- */

  /** The account's principal, calendar home and calendars, from a server address or the email alone. */
  async discover(server: string | undefined): Promise<Discovered> {
    this.deadline = Date.now() + DISCOVERY_BUDGET_MS;
    try {
      return await this.discoverWithin(server);
    } finally {
      this.deadline = null;
    }
  }

  private async discoverWithin(server: string | undefined): Promise<Discovered> {
    const starts = server ? fromServer(server) : await this.fromEmail();
    if (starts.length === 0) throw new ConnectorError("config", NOT_FOUND, { field: "server" });
    let lastProblem: string | null = null;
    for (const start of starts) {
      if (this.expired()) break;
      // Asked first without the password, unless it is a provider's own server.
      let target = start;
      if (!KNOWN_SERVERS.has(hostOf(start))) {
        const probed = await this.probe(start);
        if ("problem" in probed) {
          lastProblem = probed.problem;
          continue;
        }
        target = probed.url;
      }
      this.authHost = hostOf(target);
      let res: ConnectorHttpResponse;
      try {
        res = await this.send("PROPFIND", target, { body: PROPFIND_PRINCIPAL, depth: "0" });
      } catch (error) {
        if (error instanceof ConnectorError && (error.code === "auth" || error.code === "rate_limited")) throw error;
        lastProblem = error instanceof Error ? error.message : String(error);
        this.authHost = null;
        continue;
      }
      if (res.status !== 207) {
        lastProblem = `${hostOf(target)} is not a calendar server`;
        this.authHost = null;
        continue;
      }
      const responses = safeMultistatus(res.text);
      const first = responses[0];
      if (!first) continue;
      const principalHref = textOf(child(prop(first, DAV, "current-user-principal"), DAV, "href"));
      // A server that skips the principal and answers on a calendar (or a home) directly is read as it stands.
      if (!principalHref) {
        if (isCalendar(first)) {
          const url = absolute(first.href || res.url, res.url);
          return { principal: url, home: parentOf(url), calendars: [calendarOf(first, url)] };
        }
        const homeHref = textOf(child(prop(first, CALDAV, "calendar-home-set"), DAV, "href"));
        if (homeHref) {
          const home = absolute(homeHref, res.url);
          return { principal: res.url, home, calendars: await this.calendars(home) };
        }
        lastProblem = `${hostOf(target)} is not a calendar server`;
        this.authHost = null;
        continue;
      }
      const principal = absolute(principalHref, res.url);
      const home = await this.homeOf(principal);
      return { principal, home, calendars: await this.calendars(home) };
    }
    if (!server) throw new ConnectorError("config", NOT_FOUND, { field: "server" });
    throw new ConnectorError(
      "config",
      `No calendar was found there${lastProblem ? ` (${lastProblem})` : ""}. Check the server address under More options.`,
      { field: "server" },
    );
  }

  /**
   * Where to look from the email alone (RFC 6764): the SRV record's server, then the email's domain
   * and its `caldav.` name, each asked without the password first.
   */
  private async fromEmail(): Promise<string[]> {
    const at = this.account.username.lastIndexOf("@");
    if (at < 0) return [];
    const domain = this.account.username
      .slice(at + 1)
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return [];
    const out: string[] = [];
    for (const srv of await lookupSrv(this.http, `_caldavs._tcp.${domain}`)) {
      const path = (await lookupPath(this.http, `_caldavs._tcp.${domain}`)) ?? "/.well-known/caldav";
      out.push(`https://${srv.target}${srv.port === 443 ? "" : `:${srv.port}`}${path}`);
    }
    out.push(`https://${domain}/.well-known/caldav`);
    out.push(`https://caldav.${domain}/.well-known/caldav`);
    return [...new Set(out)];
  }

  private async homeOf(principal: string): Promise<string> {
    const res = await this.send("PROPFIND", principal, { body: PROPFIND_HOME, depth: "0" });
    if (res.status !== 207)
      throw new ConnectorError("config", `${hostOf(principal)} did not say where the calendars are.`);
    const r = safeMultistatus(res.text)[0];
    const href = r ? textOf(child(prop(r, CALDAV, "calendar-home-set"), DAV, "href")) : "";
    if (!href) throw new ConnectorError("config", `${hostOf(principal)} did not say where the calendars are.`);
    return absolute(href, res.url);
  }

  /** The event calendars in a calendar home: not task lists, not inboxes, not the home itself. */
  async calendars(home: string): Promise<Discovered["calendars"]> {
    const res = await this.send("PROPFIND", home, { body: PROPFIND_CALENDARS, depth: "1" });
    if (res.status !== 207) throw new ConnectorError("config", `${hostOf(home)} did not list the calendars.`);
    const out: (CalendarChoice & { components: string[] })[] = [];
    for (const r of safeMultistatus(res.text)) {
      if (!isCalendar(r)) continue;
      const url = absolute(r.href, res.url);
      const c = calendarOf(r, url);
      if (c.components.length > 0 && !c.components.includes("VEVENT")) continue;
      out.push(c);
    }
    if (out.length === 0) throw new ConnectorError("not_found", "This account has no calendar for events.");
    return out;
  }

  /* --- busy times ------------------------------------------------------------ */

  /**
   * Busy times in one calendar. The server is asked to expand repeating events; one that will not
   * is asked again without, and the repeats are worked out here.
   */
  async busy(
    calendar: string,
    window: Interval,
    opts: { timezone: string; skipUid: (uid: string) => boolean; skipHref: (href: string) => boolean },
  ): Promise<Interval[]> {
    const start = davTime(window.start);
    const end = davTime(window.end);
    const query = (expand: boolean) => `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data>${expand ? `<c:expand start="${start}" end="${end}"/>` : ""}</c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
    let res: ConnectorHttpResponse | null = null;
    try {
      res = await this.send("REPORT", calendar, { body: query(true), depth: "1" });
    } catch (error) {
      // Some servers fail outright on `expand` rather than saying no: asked again without it.
      if (!(error instanceof ConnectorError && error.code === "unreachable")) throw error;
    }
    if (!res || (res.status !== 207 && res.status !== 404 && res.status !== 410)) {
      res = await this.send("REPORT", calendar, { body: query(false), depth: "1" });
    }
    if (res.status === 404 || res.status === 410) return [];
    if (res.status !== 207) {
      throw new ConnectorError("bad_response", `${hostOf(calendar)} would not list the events in that calendar.`);
    }
    const out: Interval[] = [];
    for (const r of safeMultistatus(res.text)) {
      if (r.href && opts.skipHref(absolute(r.href, res.url))) continue;
      const data = textOf(prop(r, CALDAV, "calendar-data"));
      if (!data) continue;
      out.push(...busyFromICal(data, window, { timezone: opts.timezone, skipUid: opts.skipUid }));
    }
    return out;
  }

  /* --- writing one event ------------------------------------------------------ */

  /** Creates or replaces the event at `href`. The resource is the inbox's own, so a newer copy wins. */
  async put(href: string, ics: string, etag: string | null): Promise<string | null> {
    const write = (headers: Record<string, string>) =>
      this.send("PUT", href, { body: ics, contentType: "text/calendar; charset=utf-8", headers });
    let res = await write(etag ? { "if-match": etag } : { "if-none-match": "*" });
    // Already there (a run that stopped after writing), or changed since: ours to overwrite.
    if (res.status === 412) res = await write({});
    if (res.status === 404 && etag) res = await write({ "if-none-match": "*" });
    if (res.status === 403 || res.status === 405) {
      throw new ConnectorError("refused", `${hostOf(href)} does not let this account add events to that calendar.`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorError("bad_response", `${hostOf(href)} would not take the booking.`);
    }
    return res.headers.get("etag");
  }

  /** Deletes the event at `href`; gone already is done. */
  async remove(href: string): Promise<void> {
    const res = await this.send("DELETE", href);
    if (res.status === 404 || res.status === 410) return;
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorError("bad_response", `${hostOf(href)} would not remove the booking.`);
    }
  }
}

function safeMultistatus(text: string) {
  try {
    return multistatus(text);
  } catch {
    throw new ConnectorError("bad_response", "The calendar server sent an answer this inbox could not read.");
  }
}

function isCalendar(r: ReturnType<typeof multistatus>[number]): boolean {
  return child(prop(r, DAV, "resourcetype"), CALDAV, "calendar") !== undefined;
}

function calendarOf(r: ReturnType<typeof multistatus>[number], url: string): CalendarChoice & { components: string[] } {
  const components = children(prop(r, CALDAV, "supported-calendar-component-set"), CALDAV, "comp")
    .map((c) => (c.attrs.name ?? "").toUpperCase())
    .filter(Boolean);
  const privileges = prop(r, DAV, "current-user-privilege-set");
  const granted = privileges
    ? descendants(privileges, DAV, "privilege").flatMap((p) => p.children.map((c) => `${c.ns}${c.name}`))
    : null;
  const writable =
    granted === null ||
    granted.some((g) => g === "DAV:write" || g === "DAV:write-content" || g === "DAV:all" || g === "DAV:bind");
  const name = textOf(prop(r, DAV, "displayname")) || decodeURIComponent(lastSegment(url)) || "Calendar";
  return { id: url, name: name.slice(0, 120), writable, components };
}

/** Where to start from a server address the owner gave: it, then its well-known address. */
export function fromServer(server: string): string[] {
  const raw = server.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConnectorError("config", "That is not a server address.", { field: "server" });
  }
  if (url.protocol === "http:") url.protocol = "https:";
  url.hash = "";
  url.search = "";
  const origin = url.origin;
  const path = url.pathname;
  if (path === "/" || path === "") return [`${origin}/.well-known/caldav`, `${origin}/`];
  return [url.toString(), `${origin}/.well-known/caldav`];
}

/** An href as a server gave it, made absolute against the address the answer came from. */
export function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return base;
  }
}

function parentOf(url: string): string {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/[^/]+\/?$/, "");
  return u.toString();
}

function lastSegment(url: string): string {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return "";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the calendar server";
  }
}

/** A CalDAV time-range value: UTC, basic format. */
export function davTime(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}
