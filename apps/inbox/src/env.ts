/**
 * The host's settings, read the same way on both runtimes. The Deploy to Cloudflare button asks for
 * every value in `.dev.vars.example`, so any of them can arrive empty or as whatever was typed: an
 * empty value is no value, and a value that cannot work is said once and left out rather than
 * breaking every request.
 */

/** A comma-separated list (INBOX_OWNER_EMAIL): trimmed, with the empty entries left out. */
export function listFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * INBOX_PUBLIC_URL as an origin, or undefined when it is empty or not an http(s) URL. Without it the
 * instance uses the address each request arrives at, and the Inbox address in Settings for work
 * that has no request (receipts, links in emails), which the owner's first sign-in fills in.
 */
export function publicUrlFrom(
  value: string | undefined,
  log: (line: string) => void = console.error,
): string | undefined {
  const typed = value?.trim();
  if (!typed) return undefined;
  try {
    const url = new URL(typed);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // said below
  }
  log(
    `INBOX_PUBLIC_URL is not an http(s) address (${typed}); it is ignored, and the Inbox address in Settings is used`,
  );
  return undefined;
}

/**
 * MAIL_FROM and MAIL_FROM_NAME as a sender, or undefined when no address was given. MAIL_FROM may be
 * written with its name, `Oficina Maré <inbox@oficinamare.pt>`; MAIL_FROM_NAME wins over that name.
 * A value that is not an address (a placeholder such as "none") is said once and left out: there is
 * then no sender, and the sign-in link goes to the log with that reason.
 */
export function senderFrom(
  address: string | undefined,
  name: string | undefined,
  log: (line: string) => void = console.error,
): { address: string; name?: string | undefined } | undefined {
  const typed = address?.trim();
  if (!typed) return undefined;
  const written = /^(?:"?([^"<]*?)"?\s*)?<([^<>]*)>$/.exec(typed);
  const a = (written ? written[2] : typed)?.trim() ?? "";
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(a)) {
    log(`MAIL_FROM is not an email address (${typed}); it is ignored: set it to one, like inbox@yourdomain.com`);
    return undefined;
  }
  const n = name?.trim() || written?.[1]?.trim();
  return n ? { address: a, name: n } : { address: a };
}

/**
 * INBOX_SECRET_KEY, trimmed, or undefined when empty. A newest key shorter than 32 characters is
 * still used, since secrets already sealed with it must keep opening, but it is said: the key seals
 * stored secrets and the receipt signing key, and a short one can be guessed from a copy of the database.
 */
export function secretKeyFrom(
  value: string | undefined,
  log: (line: string) => void = console.error,
): string | undefined {
  const typed = value?.trim();
  if (!typed) return undefined;
  const newest = typed.split(",")[0]?.trim() ?? "";
  if (newest.length < 32) {
    log(
      `INBOX_SECRET_KEY is only ${newest.length} characters; use \`openssl rand -base64 32\` for a new one, put it first, and keep the old one after a comma`,
    );
  }
  return typed;
}
