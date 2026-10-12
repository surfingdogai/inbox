import { buildDownload, type Capabilities, maskEmail, readSettings, WriteError } from "@surfingdog/core";
import type { SqliteSnapshot } from "@surfingdog/platform";
import { type Context, Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { publicOrigin } from "./origin";
import { problemResponse } from "./problem";
import type { CallerEnv } from "./rest";
import { mailFailed, sendOwnerMail } from "./session";
import { checkStepUp, requireStepUpCaller, STEP_UP_TTL_MS, type StepUpDeps, sendStepUp, stepUpOwner } from "./step-up";

/**
 * Downloading the inbox (`POST /v1/owner/download`): the whole database as one SQLite file in a zip,
 * with a README and a manifest, without who is signed in, keys, connected apps or any secret
 * (`capabilities/download.ts`). The owner in person only, with a step-up code sent to their own
 * address (`step-up.ts`: `POST /v1/owner/download/code` here, or `POST /auth/step-up` from the owner
 * app), and told by email once it is done.
 *
 * Mounted under `/v1/owner` after the owner routes, so their check runs first: an owner principal,
 * with the scopes `ROUTE_SCOPES` names. A runtime that cannot copy its database (D1) answers 501 and
 * says how to copy it instead, before any code is sent.
 */
export interface DownloadDeps extends StepUpDeps {
  readonly caps: Capabilities;
  readonly version: string;
  /** Copies the database (Node: `nodeSnapshot`). Absent, the routes answer 501. */
  readonly snapshot?: SqliteSnapshot | undefined;
}

const OWNER_SECURITY = [{ ownerKey: [] }];
const ERRORS = {
  401: { description: "No owner credentials." },
  403: { description: "Only the owner in person: never the owner's AI, never an integration key." },
  501: { description: "This runtime cannot copy its database from inside it; the answer says how to copy it." },
};

export function downloadRoutes(deps: DownloadDeps): Hono<CallerEnv> {
  const app = new Hono<CallerEnv>();
  app.onError((error, c) => problemResponse(c, error));
  const clock = () => (deps.now ? deps.now() : Date.now());

  // Whether this inbox can be downloaded here, asked before anything is sent: the owner app shows the
  // way to copy the database instead where it cannot be.
  app.get(
    "/download",
    describeRoute({
      tags: ["owner"],
      summary: "Whether the inbox can be downloaded here",
      description:
        "200 when POST /download/code and POST /download work on this runtime; 501 not_available, with how to copy the database instead, where they do not (Cloudflare D1). Sends nothing and changes nothing.",
      security: OWNER_SECURITY,
      responses: {
        200: {
          description: "It can",
          content: { "application/json": { schema: resolver(z.object({ available: z.literal(true) })) } },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      requireStepUpCaller(c.get("caller"), "download the inbox");
      if (!deps.snapshot) return notAvailable(c);
      return c.json({ available: true as const }, 200);
    },
  );

  app.post(
    "/download/code",
    describeRoute({
      tags: ["owner"],
      summary: "Send the code a download needs to the owner's email",
      description:
        "Six digits, sent to the signed-in owner's own address (for a full owner key that names nobody, the owner email in Settings). They work once, for ten minutes and five tries, for POST /download. A code sent earlier keeps working until one of them is used.",
      security: OWNER_SECURITY,
      responses: {
        200: {
          description: "Sent",
          content: {
            "application/json": {
              schema: resolver(z.object({ sent_to: z.string(), expires_at: z.string() })),
            },
          },
        },
        ...ERRORS,
        429: { description: "Too many codes asked for." },
        502: { description: "The email could not be sent." },
      },
    }),
    async (c) => {
      const caller = c.get("caller");
      requireStepUpCaller(caller, "download the inbox");
      if (!deps.snapshot) return notAvailable(c);
      const owner = await stepUpOwner(deps.db, caller);
      let sent: { sentTo: string };
      try {
        sent = await sendStepUp(deps, owner, "download");
      } catch (error) {
        // A refusal says why; anything else is the mail service's, and the log has its reason.
        if (error instanceof WriteError) throw error;
        return mailFailed(c, "The code could not be sent. Try again in a minute.");
      }
      return c.json({ sent_to: sent.sentTo, expires_at: new Date(clock() + STEP_UP_TTL_MS).toISOString() }, 200);
    },
  );

  app.post(
    "/download",
    describeRoute({
      tags: ["owner"],
      summary: "Download the inbox: one SQLite file in a zip, with a README and a manifest",
      description:
        "Send the code from POST /download/code. The zip holds inbox.db, every request, conversation, customer, service, hour, rule and setting, without who is signed in, keys, connected AI apps, rate limits or any secret; README.txt lists every table and what was left out, and manifest.json says the same for a program. The file opens in an inbox you run yourself. The owner is told by email.",
      security: OWNER_SECURITY,
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  pattern: "^[0-9]{6}$",
                  description: "The six digits POST /download/code sent to the owner's email.",
                },
              },
              required: ["code"],
            },
          },
        },
      },
      responses: {
        200: {
          description: "The zip",
          content: { "application/zip": { schema: { type: "string", format: "binary" } } },
        },
        ...ERRORS,
        422: { description: "bad_code or code_expired: ask for a new code." },
        429: { description: "too_many_attempts: wait a few minutes and ask for a new code." },
      },
    }),
    async (c) => {
      const caller = c.get("caller");
      requireStepUpCaller(caller, "download the inbox");
      const snapshot = deps.snapshot;
      if (!snapshot) return notAvailable(c);
      const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
      const owner = await stepUpOwner(deps.db, caller);
      const now = clock();
      await checkStepUp(deps.db, owner, "download", typeof body.code === "string" ? body.code : "", now, deps.secrets);
      const profile = await deps.caps.getBusinessProfile();
      const download = await buildDownload(snapshot, {
        now,
        business: profile.name.trim(),
        address: publicOrigin(c.req.raw, deps.baseUrl),
        version: deps.version,
      });
      await tellOwner(deps, owner.email, profile.name.trim(), now).catch((error) => {
        console.error("download: the owner was not told:", error instanceof Error ? error.message : error);
      });
      return new Response(download.zip as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${download.filename}"`,
          "Content-Length": String(download.zip.length),
          "Cache-Control": "no-store",
        },
      });
    },
  );

  return app;
}

/**
 * The owner is told of every download: at the address the code went to, and at the owner email in
 * Settings when that is another one.
 */
async function tellOwner(deps: DownloadDeps, codeWentTo: string, name: string, now: number): Promise<void> {
  const settings = await readSettings(deps.db);
  const to = [
    ...new Set(
      [codeWentTo, settings.notifications.ownerEmail]
        .filter((a): a is string => Boolean(a))
        .map((a) => a.toLowerCase()),
    ),
  ];
  const when = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(now);
  const whose = name ? `${name}'s inbox` : "your inbox";
  for (const address of to) {
    await sendOwnerMail(deps, {
      what: "download notice",
      to: address,
      subject: `A copy of ${whose} was downloaded`,
      text: [
        `A copy of ${whose} was downloaded on ${when} UTC, with the code sent to ${maskEmail(codeWentTo)}.`,
        "It holds every request and conversation, the customers, the services and the settings, and no sign-in, key or secret.",
        "",
        "If this was not you, someone can read that mailbox and is signed in to your inbox: change your email password first, then sign in and check Settings → Keys.",
      ].join("\n"),
    });
  }
}

function notAvailable(c: Context): Response {
  return c.json(
    {
      type: "https://surfingdog.ai/problems/not_available",
      title: "Not available here",
      status: 501,
      code: "not_available",
      detail:
        "This inbox's database cannot be copied from inside it on this runtime. On Cloudflare, `wrangler d1 export <database> --remote --output inbox.sql` copies the whole database, secrets included.",
    },
    501,
    { "Content-Type": "application/problem+json" },
  );
}
