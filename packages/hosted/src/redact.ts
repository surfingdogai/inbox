/**
 * Log lines with nothing in them that opens anything: keys and access tokens, sign-in and handoff
 * tokens in links, one-time codes, the token in a customer's or a share link, and email addresses
 * (kept to their domain). Every process of this runtime writes its log through it.
 */
const RULES: readonly [RegExp, string | ((match: string, ...groups: string[]) => string)][] = [
  // API keys and their kin: sdi_own_…, sdi_int_…, sdi_agt_…
  [/\bsdi_[a-z]{2,8}_[A-Za-z0-9_-]{8,}/g, "sdi_[redacted]"],
  // A model provider's key, the spam filter's AI check's (ADR-029 §7.2): never in a line.
  [/\b(sk|sk-ant|sk-proj|gsk)[-_][A-Za-z0-9_-]{16,}/g, "[redacted key]"],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, "[redacted key]"],
  [/((?:x-api-key|api[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{12,}/gi, "$1[redacted]"],
  // A customer's network key or pass: its secret part.
  [/\b(sd(?:key|pass)1_[a-z0-9.-]+_[a-z2-7]{16}_)[a-z2-7]{32}\b/g, "$1[redacted]"],
  // A session cookie's value.
  [/((?:__Host-)?sdi_session=)[^;\s]+/g, "$1[redacted]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // A token or a code in a query string.
  [/([?&](?:token|code|key|secret|access_token|state)=)[^&\s#"']+/gi, "$1[redacted]"],
  // A token in a path: a customer's link, a share link, a handoff.
  [/(\/(?:c|connect|share|handoff)\/)[A-Za-z0-9_-]{12,}/g, "$1[redacted]"],
  // Six-digit codes said as codes.
  [/\b(code\W{0,3})\d{6}\b/gi, "$1[redacted]"],
  // The signature and nonce of a signed call.
  [/\b(v1=)[0-9a-f]{64}\b/g, "$1[redacted]"],
  // Email addresses keep their domain only.
  [/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m: string, domain: string) => `[redacted]@${domain}`],
];

export function redact(line: string): string {
  let out = line;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement as never);
  }
  return out;
}

function redactArg(arg: unknown): unknown {
  if (typeof arg === "string") return redact(arg);
  if (arg instanceof Error) {
    const copy = new Error(redact(arg.message));
    copy.name = arg.name;
    if (arg.stack) copy.stack = redact(arg.stack);
    return copy;
  }
  if (arg !== null && typeof arg === "object") {
    try {
      return redact(JSON.stringify(arg));
    } catch {
      return "[unprintable]";
    }
  }
  return arg;
}

/** Puts `redact` in front of console.log, info, warn, error and debug, once. */
export function installRedaction(target: Console = console): void {
  const marked = target as Console & { __redacting?: boolean };
  if (marked.__redacting) return;
  marked.__redacting = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => original(...args.map(redactArg));
  }
}
