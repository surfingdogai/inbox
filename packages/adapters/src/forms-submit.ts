import { type Caller, type Capabilities, ulid, WriteError } from "@surfingdog/core";
import { Hono } from "hono";
import { z } from "zod";
import { bucketAddress, consume } from "./limits";
import { forbidden, problemResponse, tooManyRequests, unauthorized } from "./problem";
import type { CallerEnv } from "./rest";

/**
 * `POST /v1/forms/submit` (ADR-029 §4.2): the business keeps its own website's forms — a contact form
 * plugin, a site builder's form — and what visitors send there arrives here as a message, screened
 * like one sent through the inbox's own form. Its caller is the website, with a key that may do this
 * and nothing else (`forms:submit`); the visitor is anonymous. The site says what it saw of the
 * visitor: their address (each visitor is limited by it, as on the inbox's own form), whether its
 * hidden field came back filled, and how long the visitor took. The answer is the same whatever the
 * spam filter makes of the message.
 */

const MAX_FIELDS = 30;
const MAX_VALUE = 5_000;

export const formSubmitInput = z.object({
  form: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('Which form, as the website names it: "cf7:123", "wpforms:7", "contact".'),
  page: z
    .url({ protocol: /^https?$/ })
    .max(2_048)
    .optional()
    .describe("The page the form was on."),
  fields: z
    .record(z.string().trim().min(1).max(120), z.string().max(MAX_VALUE))
    .refine((f) => Object.keys(f).length >= 1 && Object.keys(f).length <= MAX_FIELDS, {
      message: `between 1 and ${MAX_FIELDS} fields`,
    })
    .describe(
      "The visitor's answers by field label: name, email, phone and message are read as such; the rest is kept as written.",
    ),
  visitor: z
    .object({
      ip: z.string().trim().max(64).optional(),
      user_agent: z.string().max(400).optional(),
    })
    .optional(),
  signals: z
    .object({
      trap_filled: z.boolean().optional().describe("The form's hidden field came back filled."),
      elapsed_ms: z
        .number()
        .int()
        .min(0)
        .max(30 * 86_400_000)
        .optional()
        .describe("How long the visitor had the form open."),
      drawn_at: z.number().int().min(0).optional().describe("When the page drew the form, in milliseconds."),
    })
    .optional(),
});

export type FormSubmitInput = z.infer<typeof formSubmitInput>;

const NAME = /^(your[-_ ]?)?(full[-_ ]?)?name$|^nome$|^nombre$|^nom$|^name[-_ ]?\d*$/i;
const EMAIL = /e-?mail|courriel|correo/i;
const PHONE = /phone|tel(efone|éfono|ephone)?|mobile|whatsapp/i;
const MESSAGE = /message|mensagem|mensaje|comment|enquiry|inquiry|question|body|details|text/i;

/** The fields as a message: the visitor's name, address and phone apart, every other answer in order. */
export function readFields(fields: Readonly<Record<string, string>>): {
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly body: string;
} {
  let name: string | undefined;
  let email: string | undefined;
  let phone: string | undefined;
  let message: string | undefined;
  const rest: string[] = [];
  for (const [label, raw] of Object.entries(fields)) {
    const value = raw.trim();
    if (!value) continue;
    if (!email && EMAIL.test(label) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) email = value.slice(0, 254);
    else if (!name && NAME.test(label.trim())) name = value.slice(0, 200);
    else if (!phone && PHONE.test(label)) phone = value.slice(0, 40);
    else if (!message && MESSAGE.test(label)) message = value;
    else rest.push(`${label.trim()}: ${value}`);
  }
  const body = [message, ...rest].filter(Boolean).join("\n\n").slice(0, 20_000);
  return { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}), body };
}

export function formsSubmitRoutes(deps: { readonly caps: Capabilities; readonly now?: (() => number) | undefined }) {
  const app = new Hono<CallerEnv>();
  const clock = () => (deps.now ? deps.now() : Date.now());
  app.post("/submit", async (c) => {
    const site = c.get("caller");
    // A website's key, given this scope by name (a key for everything is not a website's); never a
    // visitor, never the AI.
    if (!site?.principal) return unauthorized(c, "Send a key that holds forms:submit as a Bearer token.");
    if (!site.principal.scopes.includes("forms:submit") || site.actor.kind === "owner_ai") {
      return forbidden(c, "Send this with a key that holds forms:submit (Settings → Keys → Website forms).");
    }
    let parsed: FormSubmitInput;
    try {
      const body = (await c.req.json()) as unknown;
      const r = formSubmitInput.safeParse(body);
      if (!r.success) {
        throw new WriteError("invalid_input", "That is not a form submission.", {
          fields: r.error.issues.map((i) => ({
            path: i.path.map(String).join("."),
            problem: "invalid",
            message: i.message,
          })),
        });
      }
      parsed = r.data;
    } catch (error) {
      return problemResponse(
        c,
        error instanceof WriteError ? error : new WriteError("invalid_input", "The body is not JSON."),
      );
    }
    const now = clock();
    // Each visitor is limited by their own address, as on the inbox's own form.
    const visitorIp = parsed.visitor?.ip ? bucketAddress(parsed.visitor.ip) : `site:${site.principal.id}`;
    const take = await consume(deps.caps.db, "create", `form:${visitorIp}`, now);
    if (!take.allowed) return tooManyRequests(c, "Too many requests from this visitor right now.", take.retryAfterSec);
    const read = readFields(parsed.fields);
    if (!read.body) {
      return problemResponse(
        c,
        new WriteError("invalid_input", "The form holds no message.", {
          fields: [{ path: "fields", problem: "missing", message: "a message" }],
        }),
      );
    }
    // One submission is one message, however often the site sends it.
    const key = await submissionKey(parsed);
    const visitor: Caller = {
      actor: { kind: "customer_human", id: `site:${site.principal.id}:${ulid(now)}`, channel: "form" },
      tier: "anonymous",
      sandbox: site.sandbox,
      idempotency: { scope: `forms:${site.principal.id}`, key },
      now: () => now,
    };
    try {
      const r = await deps.caps.sendMessage(
        visitor,
        {
          body: read.body,
          contact: {
            ...(read.name ? { name: read.name } : {}),
            ...(read.email ? { email: read.email } : {}),
            ...(read.phone ? { phone: read.phone } : {}),
          },
        },
        {
          screen: {
            door: "site_form",
            form: {
              key: "none",
              trap: parsed.signals?.trap_filled === true,
              ...(parsed.signals?.elapsed_ms !== undefined ? { elapsedMs: parsed.signals.elapsed_ms } : {}),
            },
          },
        },
      );
      const id = (r as { view: { item: { id: string } }; replayed?: boolean }).view.item.id;
      return c.json({ ok: true, item_id: id }, (r as { replayed?: boolean }).replayed ? 200 : 201);
    } catch (error) {
      return problemResponse(c, error);
    }
  });
  return app;
}

/** The submission's own key: the form, its answers and when it was drawn. */
async function submissionKey(p: FormSubmitInput): Promise<string> {
  const text = JSON.stringify([
    p.form,
    Object.entries(p.fields).sort(([a], [b]) => a.localeCompare(b)),
    p.signals?.drawn_at ?? null,
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as BufferSource));
  return Array.from(digest.slice(0, 20), (b) => b.toString(16).padStart(2, "0")).join("");
}
