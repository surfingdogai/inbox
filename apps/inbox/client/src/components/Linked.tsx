import { Fragment } from "react";
import {
  HOST_KEEP,
  LINKS_TITLE,
  type LinkRun,
  linkName,
  linkParts,
  linkRuns,
  linksToList,
  splitLinksBlock,
} from "../lib/links";

/**
 * A message's text with its http(s) links drawn as links, each opening in a new tab, and the links
 * its email carried listed under it (`Links in this email:`), those its words do not already show. A
 * link shows its host, and a long one a shortened path; what is not drawn is still there, so a copy of
 * the message holds every address whole. It needs React alone (no router, no icon set), so the phone
 * app draws message text with it too.
 */
export function Linked({ text }: { text: string }) {
  const block = splitLinksBlock(text);
  if (!block) return <Words text={text} />;
  const links = linksToList(block);
  return (
    <>
      {block.body && <Words text={block.body} />}
      {links.length > 0 && <LinksList links={links} />}
    </>
  );
}

function Words({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((p) => (p.href ? <TextLink key={p.at} href={p.href} /> : <span key={p.at}>{p.text}</span>))}
    </>
  );
}

/** The links an email carried, as a small titled list: each its host and short path, opening in a new tab. */
function LinksList({ links }: { links: readonly string[] }) {
  let at = 0;
  const keyed = links.map((href) => {
    const key = at;
    at += href.length + 1;
    return { href, key };
  });
  return (
    <div className="msg-links">
      <div className="msg-links-title">{LINKS_TITLE}</div>
      <ul className="msg-links-list">
        {keyed.map(({ href, key }) => (
          <li key={key} className="msg-links-item">
            <TextLink href={href} out />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One link. On screen: its host, its domain in bold, then its path, shortened in the middle when long.
 * On hover and to a screen reader: its address as the browser reaches it (`linkName`). In a copy: its
 * address as written. `out` adds the small arrow a list's link has.
 */
export function TextLink({ href, out = false }: { href: string; out?: boolean }) {
  // Keyed by where each starts in the address, and by what it is: an empty host piece is a piece too.
  let at = 0;
  const runs = linkRuns(href).map((r) => {
    const key = `${at}${r.host ?? ""}`;
    at += r.text.length;
    return { ...r, key };
  });
  const name = linkName(href);
  return (
    <a
      className="msg-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={name}
      aria-label={name}
      dir="ltr"
    >
      {runs.map((r) => (
        <Fragment key={r.key}>
          {r.host ? (
            <HostPiece run={r} />
          ) : (
            <>
              {/* On a narrow screen a link wraps where its path does, before a "/". */}
              {(r.hidden ? (r.shows ?? "") : r.text).startsWith("/") && <wbr />}
              {r.hidden ? (
                <span className="msg-link-as" data-as={drawn(r.shows)}>
                  <span className="msg-link-gone">{r.text}</span>
                </span>
              ) : (
                <Breaks text={r.text} />
              )}
            </>
          )}
        </Fragment>
      ))}
      {out && (
        <svg className="msg-link-out" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M3.5 8.5 8.5 3.5M4.75 3.5H8.5V7.25" />
        </svg>
      )}
    </a>
  );
}

/**
 * A piece of the host. Its domain is bold and kept on one line (when it fits one: `HOST_KEEP`); the
 * names before it are plain, each kept whole, and wrap only after a dot, so a long host never breaks
 * where it would read as another.
 */
function HostPiece({ run }: { run: LinkRun }) {
  if (run.hidden) {
    const shows = run.shows ?? "";
    const as = run.host === "domain" ? "msg-link-as msg-link-domain" : "msg-link-as";
    return (
      <span className={as} data-as={run.host === "sub" ? drawnSub(shows) : drawnWhole(shows)}>
        {run.text && <span className="msg-link-gone">{run.text}</span>}
      </span>
    );
  }
  if (run.host === "domain") {
    return (
      <span className={run.text.length <= HOST_KEEP ? "msg-link-domain msg-link-keep" : "msg-link-domain"}>
        {run.text}
      </span>
    );
  }
  if (run.host === "port") return <span>{run.text}</span>;
  let at = 0;
  return (
    <span className="msg-link-sub">
      {byName(run.text).map((name) => {
        const key = at;
        at += name.length;
        return (
          <Fragment key={key}>
            <span className={name.length <= HOST_KEEP ? "msg-link-keep" : undefined}>{name}</span>
            {name.endsWith(".") && <wbr />}
          </Fragment>
        );
      })}
    </span>
  );
}

/** A host's names, each with the dot after it: "my.", "example.", "pt". */
function byName(host: string): string[] {
  return host.match(/[^.]*\.|[^.]+$/g) ?? [];
}

/** U+2060 WORD JOINER: drawn as nothing, holds what is on either side of it on one line. */
const JOIN = "\u2060";
/** U+200B ZERO WIDTH SPACE: drawn as nothing, a place a line may wrap. */
const WRAP = "\u200b";

/**
 * What a folded piece draws. An ellipsis is joined to what follows it, so a line wraps before a "/",
 * never between "…" and the "?…" after it. Drawn by CSS, none of it is ever copied.
 */
function drawn(shows: string | undefined): string {
  return shows?.endsWith("…") ? `${shows}${JOIN}` : (shows ?? "");
}

/** The names before a host's domain, drawn in place of what was written: wrapping only after a dot. */
function drawnSub(shows: string): string {
  return byName(shows)
    .map(
      (name) => `${name.length <= HOST_KEEP ? name.replace(/-/g, `-${JOIN}`) : name}${name.endsWith(".") ? WRAP : ""}`,
    )
    .join("");
}

/** A host's domain, or its port, drawn in place of what was written: on one line when it fits one. */
function drawnWhole(shows: string): string {
  return shows.length <= HOST_KEEP ? shows.replace(/[-.]/g, (c) => `${c}${JOIN}`) : shows;
}

/** A piece of a path, free to wrap before each "/" in it, as the link is before the piece itself. */
function Breaks({ text }: { text: string }) {
  let at = 0;
  return (
    <span>
      {text.split(/(?=\/)/).map((bit) => {
        const key = at;
        at += bit.length;
        return (
          <Fragment key={key}>
            {key > 0 && <wbr />}
            {bit}
          </Fragment>
        );
      })}
    </span>
  );
}
