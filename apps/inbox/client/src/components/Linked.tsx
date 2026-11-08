import { Fragment } from "react";
import { LINKS_TITLE, linkParts, linkRuns, splitLinksBlock } from "../lib/links";

/**
 * A message's text with its http(s) links drawn as links, each opening in a new tab, and the links
 * its email carried listed under it (`Links in this email:`). A link shows its host, and a long one
 * a shortened path; what is not drawn is still there, so a copy of the message holds every address
 * whole. It needs React alone (no router, no icon set), so the phone app draws message text with it too.
 */
export function Linked({ text }: { text: string }) {
  const block = splitLinksBlock(text);
  if (!block) return <Words text={text} />;
  return (
    <>
      {block.body && <Words text={block.body} />}
      <LinksList links={block.links} />
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
 * One link. On screen: its host, then its path, shortened in the middle when long. In full: its
 * address on hover and to a screen reader, and in a copy. `out` adds the small arrow a list's link has.
 */
export function TextLink({ href, out = false }: { href: string; out?: boolean }) {
  // Keyed by where each starts in the address, and by what it is: an empty host is a piece too.
  let at = 0;
  const runs = linkRuns(href).map((r) => {
    const key = `${at}${r.host ? "h" : ""}`;
    at += r.text.length;
    return { ...r, key };
  });
  return (
    <a
      className="msg-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={href}
      aria-label={href}
    >
      {runs.map((r) => (
        <Fragment key={r.key}>
          {/* On a narrow screen a link wraps where its path does, before a "/": never inside its host. */}
          {!r.host && (r.hidden ? (r.shows ?? "") : r.text).startsWith("/") && <wbr />}
          {r.hidden ? (
            <span className={r.host ? "msg-link-as msg-link-host" : "msg-link-as"} data-as={drawn(r.shows)}>
              <span className="msg-link-gone">{r.text}</span>
            </span>
          ) : (
            <span className={r.host ? "msg-link-host" : undefined}>{r.host ? r.text : <Breaks text={r.text} />}</span>
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
 * What a folded piece draws. An ellipsis is joined to what follows it (U+2060, drawn as nothing and
 * never copied), so a line wraps before a "/", never between "…" and the "?…" after it.
 */
function drawn(shows: string | undefined): string {
  return shows?.endsWith("…") ? `${shows}\u2060` : (shows ?? "");
}

/** A piece of a path, free to wrap before each "/" in it, as the link is before the piece itself. */
function Breaks({ text }: { text: string }) {
  let at = 0;
  return (
    <>
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
    </>
  );
}
