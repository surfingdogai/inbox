import { linkParts } from "../lib/links";

/** A message's text with its http(s) links clickable, each opening in a new tab. */
export function Linked({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((p) =>
        p.href ? (
          <a key={p.at} href={p.href} target="_blank" rel="noopener noreferrer nofollow">
            {p.text}
          </a>
        ) : (
          <span key={p.at}>{p.text}</span>
        ),
      )}
    </>
  );
}
