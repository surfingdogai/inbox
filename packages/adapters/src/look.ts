import { type Capabilities, isTooLarge, LOGO_MAX_BYTES, LOGO_WORDS, type LogoFile } from "@surfingdog/core";
import type { Context, Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { problemResponse } from "./problem";
import { settingsViewSchema } from "./responses";
import type { CallerEnv } from "./rest";
import { readBody } from "./trades";

/**
 * The business's logo (Settings → Look): the owner's upload, its removal and their own view of it,
 * under `/v1/owner`; and the copy every customer's page and email loads, at `/p/logo/<sha16>.<ext>`
 * (`logoFile`). The public name changes with the picture, so it may be kept for good, and an old one
 * is simply not found. Theme and accent are settings (`PUT /v1/owner/settings`, `look`).
 */

const settingsAnswer = (description: string) => ({
  200: { description, content: { "application/json": { schema: resolver(settingsViewSchema) } } },
});

export function lookOwnerRoutes(app: Hono<CallerEnv>, caps: Capabilities): void {
  app.put(
    "/look/logo",
    describeRoute({
      tags: ["owner"],
      summary: "Upload the business's logo",
      description: `The picture's bytes as the body: PNG, JPEG or WebP (told by its first bytes), up to ${LOGO_MAX_BYTES / 1024} KB, 16 to 2048 pixels a side. Its metadata is taken out. It replaces the logo there was. The owner in person only: refused (403 owner_in_person) to the owner's AI and to integration keys. Answers the settings, with look.logo.`,
      security: [{ ownerKey: [] }],
      responses: {
        ...settingsAnswer("Settings"),
        413: { description: `Larger than ${LOGO_MAX_BYTES / 1024} KB.` },
        422: { description: "Not a PNG, JPEG or WebP picture, or not one that size." },
      },
    }),
    async (c) => {
      const declared = Number(c.req.header("content-length") ?? "");
      if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) return tooLarge(c);
      const bytes = await readBody(c.req.raw, LOGO_MAX_BYTES);
      if (!bytes) return tooLarge(c);
      try {
        return c.json(await caps.look.setLogo(c.get("caller"), bytes), 200, { "Cache-Control": "no-store" });
      } catch (error) {
        return isTooLarge(error) ? tooLarge(c) : problemResponse(c, error);
      }
    },
  );
  app.delete(
    "/look/logo",
    describeRoute({
      tags: ["owner"],
      summary: "Remove the business's logo: its name alone heads its pages and emails again",
      description: "The owner in person only. Answers the settings.",
      security: [{ ownerKey: [] }],
      responses: settingsAnswer("Settings"),
    }),
    async (c) => c.json(await caps.look.removeLogo(c.get("caller")), 200, { "Cache-Control": "no-store" }),
  );
  app.get(
    "/look/logo",
    describeRoute({
      tags: ["owner"],
      summary: "The business's logo, as it is kept",
      security: [{ ownerKey: [] }],
      responses: {
        200: {
          description: "The picture",
          content: {
            "image/png": { schema: { type: "string", format: "binary" } },
            "image/jpeg": { schema: { type: "string", format: "binary" } },
            "image/webp": { schema: { type: "string", format: "binary" } },
          },
        },
        404: { description: "No logo." },
      },
    }),
    async (c) => {
      const file = await caps.look.ownerFile(c.get("caller"));
      if (!file) return c.json({ error: "not_found" }, 404, { "Cache-Control": "no-store" });
      return picture(file, "private, no-cache");
    },
  );
}

const PUBLIC_NAME = /^[0-9a-f]{16}\.(png|jpg|webp)$/;

/**
 * `GET /p/logo/<sha16>.<ext>`: the logo the settings name now, kept a year (its name changes with
 * it); any other name is not found, and that is kept a minute.
 */
export async function publicLogo(caps: Capabilities, c: Context): Promise<Response> {
  const name = c.req.param("file") ?? "";
  const file = PUBLIC_NAME.test(name) ? await caps.look.file(name) : null;
  if (!file) return c.body(null, 404, { "Cache-Control": "max-age=60" });
  return picture(file, "public, max-age=31536000, immutable");
}

function picture(file: LogoFile, cache: string): Response {
  return new Response(file.bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.type,
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": "inline",
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
      ETag: `"${file.tag}"`,
    },
  });
}

function tooLarge(c: Context): Response {
  return c.json(
    {
      type: "https://surfingdog.ai/problems/too_large",
      title: "Too large",
      status: 413,
      code: "too_large",
      detail: LOGO_WORDS.tooLarge,
    },
    413,
    { "Content-Type": "application/problem+json" },
  );
}
