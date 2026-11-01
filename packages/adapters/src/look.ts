import {
  type Capabilities,
  isTooLarge,
  LOGO_MAX_BYTES,
  LOGO_WORDS,
  type LogoFile,
  type LogoSlot,
} from "@surfingdog/core";
import type { Context, Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { problemResponse } from "./problem";
import { settingsViewSchema } from "./responses";
import type { CallerEnv } from "./rest";
import { readBody } from "./trades";

/**
 * The business's logo (Settings → Look), and the one for dark pages: the owner's upload, its removal
 * and their own view of it, under `/v1/owner`; and the copy every customer's page and email loads, at
 * `/p/logo/<sha16>.<ext>` (`logoFile`). The public name changes with the picture, so it may be kept
 * for good, and an old one is simply not found. Theme and accent are settings (`PUT /v1/owner/settings`, `look`).
 */

const settingsAnswer = (description: string) => ({
  200: { description, content: { "application/json": { schema: resolver(settingsViewSchema) } } },
});

export function lookOwnerRoutes(app: Hono<CallerEnv>, caps: Capabilities): void {
  logoRoutes(app, caps, "logo", {
    path: "/look/logo",
    what: "the business's logo",
    replaces: "It replaces the logo there was.",
    removed: "Remove the business's logo: its name alone heads its pages and emails again",
    removedMore: "The logo for dark pages goes with it.",
  });
  logoRoutes(app, caps, "logoDark", {
    path: "/look/logo-dark",
    what: "the logo for dark pages",
    replaces:
      "For a logo drawn in white: shown in place of the logo wherever the ground is dark (the Dark theme, Standard on a dark device, the owner app at night), with no white plate. Emails keep the logo. Refused (409 no_logo) until there is a logo; it replaces the one there was.",
    removed: "Remove the logo for dark pages: the logo sits on its white plate there again",
    removedMore: "",
  });
}

function logoRoutes(
  app: Hono<CallerEnv>,
  caps: Capabilities,
  slot: LogoSlot,
  words: { path: string; what: string; replaces: string; removed: string; removedMore: string },
): void {
  app.put(
    words.path,
    describeRoute({
      tags: ["owner"],
      summary: `Upload ${words.what}`,
      description: `The picture's bytes as the body: PNG, JPEG or WebP (told by its first bytes), up to ${LOGO_MAX_BYTES / 1024} KB, 16 to 2048 pixels a side. Only what draws the picture is kept: its metadata, Content Credentials and any other block are taken out. ${words.replaces} The owner in person only: refused (403 owner_in_person) to the owner's AI and to integration keys. Answers the settings, with look.${slot}.`,
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
        return c.json(await caps.look.setLogo(c.get("caller"), bytes, slot), 200, { "Cache-Control": "no-store" });
      } catch (error) {
        return isTooLarge(error) ? tooLarge(c) : problemResponse(c, error);
      }
    },
  );
  app.delete(
    words.path,
    describeRoute({
      tags: ["owner"],
      summary: words.removed,
      description: `${words.removedMore ? `${words.removedMore} ` : ""}The owner in person only. Answers the settings.`,
      security: [{ ownerKey: [] }],
      responses: settingsAnswer("Settings"),
    }),
    async (c) => c.json(await caps.look.removeLogo(c.get("caller"), slot), 200, { "Cache-Control": "no-store" }),
  );
  app.get(
    words.path,
    describeRoute({
      tags: ["owner"],
      summary: `${words.what.charAt(0).toUpperCase()}${words.what.slice(1)}, as it is kept`,
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
        404: { description: "None kept." },
      },
    }),
    async (c) => {
      const file = await caps.look.ownerFile(c.get("caller"), slot);
      if (!file) return c.json({ error: "not_found" }, 404, { "Cache-Control": "no-store" });
      return picture(file, "private, no-cache");
    },
  );
}

const PUBLIC_NAME = /^[0-9a-f]{16}\.(png|jpg|webp)$/;

/**
 * `GET /p/logo/<sha16>.<ext>`: a logo the settings name now (the logo, or the one for dark pages),
 * kept a year (its name changes with it); any other name is not found, and that is kept a minute.
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
