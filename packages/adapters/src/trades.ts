import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { ATTACHMENT_LIMITS, type Caller, type Capabilities, checkAreaInputSchema } from "@surfingdog/core";
import type { Context, Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { problemFrom, problemResponse } from "./problem";
import type { CallerEnv } from "./rest";

/**
 * The trades doors (ADR-034): `check_area` for a customer's agent (MCP and REST), uploads of a
 * request's files (`POST /v1/uploads`), the business's own short-lived links to them
 * (`GET /v1/files/<id>`), and the owner's view of a request's files and job tool. Generated from the
 * same Zod schemas on every door; what an agent is told speaks as the business.
 */

const ok = (text: string, structured: unknown): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured as Record<string, unknown>,
});

const failed = (error: unknown): CallToolResult => {
  const p = problemFrom(error);
  const fields = p.fields?.length ? ` Fix: ${p.fields.map((f) => `${f.path} (${f.problem})`).join(", ")}.` : "";
  return {
    content: [{ type: "text", text: `${p.title}: ${p.detail}${fields}` }],
    structuredContent: { error: p },
    isError: true,
  };
};

/** Whether the business says where it works: `check_area` is offered then. */
export async function takesWork(caps: Capabilities): Promise<boolean> {
  const profile = await caps.getBusinessProfile();
  return profile.work !== undefined;
}

export const TRADES_INSTRUCTIONS = [
  "This business quotes jobs. get_business_profile's work says where it goes, whether it takes emergencies online, and what coming out costs; check_area tells you whether a site is inside where it works (inside, outside, or on_request when it decides).",
  "request_quote takes the job (payload.job: urgency, whether a visit comes first, the site and how to find the way, up to three windows that suit) and photos or plans (attachments: JPEG, PNG, WebP or PDF, at most six of 10 MB; inline as data_base64 up to 4 MB each and 8 MB a call, else by an https url, or an upload_id from POST /v1/uploads). HEIC photos: send them as JPEG.",
].join(" ");

export function registerPublicTradesTools(server: McpServer, caps: Capabilities, _caller: Caller): void {
  server.registerTool(
    "check_area",
    {
      title: "Is this site inside where the business works?",
      description:
        "Send the site's postal code with its country, or its point (lat, lng). Answers inside, outside (a request from there is declined) or on_request (the business decides), with the band it falls in for a radius (within 5, 10, 25 or 50 km), never a distance.",
      inputSchema: checkAreaInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        const r = await caps.trades.checkArea(args);
        return ok(r.words, r);
      } catch (error) {
        return failed(error);
      }
    },
  );
}

/** The largest upload body read, with room for nothing else. */
export const MAX_UPLOAD_BYTES = ATTACHMENT_LIMITS.maxBytes;

export function tradesPublicRoutes(app: Hono<CallerEnv>, caps: Capabilities, hook: never): void {
  app.get(
    "/area",
    describeRoute({
      tags: ["public"],
      summary: "Whether a site is inside where the business works",
      description:
        "postal_code with country, or lat and lng. inside, outside (declined) or on_request (the business decides); a band for a radius, never a distance.",
      responses: {
        200: { description: "The answer" },
        422: { description: "Neither a postal code with its country nor a point." },
      },
    }),
    validator(
      "query",
      z
        .object({
          postal_code: z.string().min(1).max(20).optional(),
          country: z
            .string()
            .regex(/^[A-Za-z]{2}$/)
            .optional(),
          lat: z.coerce.number().min(-90).max(90).optional(),
          lng: z.coerce.number().min(-180).max(180).optional(),
        })
        .pipe(checkAreaInputSchema),
      hook,
    ),
    async (c) => c.json(await caps.trades.checkArea(c.req.valid("query")), 200, { "Cache-Control": "no-store" }),
  );

  app.post(
    "/uploads",
    describeRoute({
      tags: ["public"],
      summary: "Upload a photo or a plan for a request",
      description:
        "The file's bytes as the body (JPEG, PNG, WebP or PDF, told by its first bytes; up to 10 MB), its name in `X-File-Name` or `?name=`. Answers an upload_id a request names in attachments within the hour. Image metadata (where a photo was taken) is taken out. HEIC: send it as JPEG.",
      responses: {
        201: { description: "Kept for an hour", content: { "application/json": { schema: resolver(uploadAnswer) } } },
        413: { description: "Larger than 10 MB." },
        422: { description: "Not a JPEG, PNG, WebP or PDF." },
      },
    }),
    async (c) => {
      const declared = Number(c.req.header("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return tooLarge(c);
      const bytes = await readBody(c.req.raw, MAX_UPLOAD_BYTES);
      if (!bytes) return tooLarge(c);
      const name = c.req.header("x-file-name") ?? c.req.query("name") ?? undefined;
      try {
        const r = await caps.trades.upload(c.get("caller"), bytes, name ? decodeName(name) : undefined);
        return c.json(r, 201);
      } catch (error) {
        return problemResponse(c, error);
      }
    },
  );

  app.get(
    "/files/:id",
    describeRoute({
      tags: ["public"],
      summary: "A file on a request, through the business's own link",
      description: "Only through a link the business's app made; it works for ten minutes.",
      responses: { 200: { description: "The file" }, 404: { description: "No such link, or it ran out." } },
    }),
    async (c) => {
      const caller = c.get("caller");
      const now = caller.now ? caller.now() : Date.now();
      const file = await caps.trades.serveFile(c.req.param("id"), c.req.query("e"), c.req.query("s"), now);
      if (!file) return c.json({ error: "not_found" }, 404, { "Cache-Control": "no-store" });
      return new Response(file.bytes as BodyInit, { status: 200, headers: file.headers });
    },
  );
}

const uploadAnswer = z.object({
  upload_id: z.string(),
  attachment: z.object({
    id: z.string(),
    name: z.string(),
    content_type: z.string(),
    size: z.number().int(),
    sha256: z.string(),
  }),
  expires_at: z.string(),
});

const ref = z.looseObject({ id: z.string(), name: z.string(), content_type: z.string(), size: z.number().int() });
const filesAnswer = z.object({
  files: z.array(ref.extend({ url: z.string().describe("Works for ten minutes."), expires_at: z.string() })),
});
const jobToolAnswer = z.looseObject({
  mode: z.enum(["every", "accepted", "never"]),
  tools: z.array(z.looseObject({ id: z.string(), kind: z.string(), name: z.string() })),
  sent: z.array(
    z.looseObject({
      connection_id: z.string(),
      outcome: z.string(),
      external_id: z.string().nullable(),
      url: z.string().nullable(),
    }),
  ),
});
const sendAnswer = z.object({
  outcomes: z.array(
    z.looseObject({
      connectorId: z.string(),
      kind: z.string(),
      status: z.enum(["written", "pending", "refused", "busy", "skipped"]),
      note: z.string(),
    }),
  ),
});
const setupAnswer = z.looseObject({
  source: z.looseObject({ kind: z.string(), account: z.string(), readAt: z.number(), zone: z.string().optional() }),
  hours: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))).optional(),
});
const workAnswer = z.looseObject({ area: z.looseObject({}), work: z.looseObject({}), public: z.looseObject({}) });
const body = (description: string, schema: z.ZodType) => ({
  200: { description, content: { "application/json": { schema: resolver(schema) } } },
});

export function tradesOwnerRoutes(app: Hono<CallerEnv>, caps: Capabilities): void {
  app.get(
    "/items/:id/files",
    describeRoute({
      tags: ["owner"],
      summary: "A request's files, each with a link that works for ten minutes",
      security: [{ ownerKey: [] }],
      responses: body("Files", filesAnswer),
    }),
    async (c) =>
      c.json(await caps.trades.files(c.get("caller"), c.req.param("id")), 200, { "Cache-Control": "no-store" }),
  );
  app.get(
    "/items/:id/job-tool",
    describeRoute({
      tags: ["owner"],
      summary: "Where a request stands in the job tool: the mode, the tools, what was sent",
      security: [{ ownerKey: [] }],
      responses: body("Job tool", jobToolAnswer),
    }),
    async (c) => c.json(await caps.trades.jobTool(c.get("caller"), c.req.param("id"))),
  );
  app.post(
    "/items/:id/job-tool",
    describeRoute({
      tags: ["owner"],
      summary: "Send a request to the job tool now",
      description: "A person at the business, in a mode that sends any (Settings → Work). Safe to send again.",
      security: [{ ownerKey: [] }],
      responses: body("What each job tool did", sendAnswer),
    }),
    async (c) => c.json(await caps.trades.sendToJobTool(c.get("caller"), c.req.param("id"))),
  );
  app.get(
    "/integrations/:id/setup",
    describeRoute({
      tags: ["integrations"],
      summary: "What a connected tool says about the business, to start from: a job tool's opening hours",
      description:
        "Read now from the tool (`setup_in`); nothing is kept. The owner keeps the hours through PUT /v1/owner/availability.",
      security: [{ ownerKey: [] }],
      responses: body("Snapshot", setupAnswer),
    }),
    async (c) =>
      c.json(await caps.connectors.setupSnapshot(c.get("caller"), c.req.param("id")), 200, {
        "Cache-Control": "no-store",
      }),
  );
  app.get(
    "/work",
    describeRoute({
      tags: ["owner"],
      summary: "Settings → Area and Work, with what the business says of them in public",
      security: [{ ownerKey: [] }],
      responses: body("Area and work", workAnswer),
    }),
    async (c) => c.json(await caps.trades.workView(c.get("caller")), 200, { "Cache-Control": "no-store" }),
  );
}

function tooLarge(c: Context): Response {
  return c.json(
    {
      type: "https://surfingdog.ai/problems/too_large",
      title: "Too large",
      status: 413,
      code: "too_large",
      detail: `A file is at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    },
    413,
    { "Content-Type": "application/problem+json" },
  );
}

/** A file name sent in a header, percent-encoded or as it is. */
function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw).slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

/** The body's bytes, read only up to `max`; null past it. */
async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // closed already
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
