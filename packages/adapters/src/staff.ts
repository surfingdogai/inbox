import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  type Caller,
  type Capabilities,
  importSetupInput,
  listStaffInput,
  photoBytes,
  staffInput,
  updateStaffInput,
  WriteError,
} from "@surfingdog/core";
import type { Context, Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { problemFrom } from "./problem";
import type { CallerEnv } from "./rest";

/**
 * Salons' doors (ADR-035): who customers can book, for their assistants (`list_staff`, `GET /v1/staff`,
 * a photo's address), and the staff setup, a day by staff and "start from your tool" for the owner.
 * Generated from the same Zod schemas, so an agent gets the same answer whichever door it takes. The
 * public ones answer with first names and photos only, on an inbox that lists staff.
 */

const readOnly = { readOnlyHint: true, idempotentHint: true } as const;

const ok = (text: string, structured: unknown): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured as Record<string, unknown>,
});

const failed = (error: unknown): CallToolResult => {
  const p = problemFrom(error);
  return {
    content: [{ type: "text", text: `${p.title}: ${p.detail}` }],
    structuredContent: { error: p },
    isError: true,
  };
};

/** Whether the inbox lists staff: the public staff tool is offered only then. */
export async function listsStaff(caps: Capabilities): Promise<boolean> {
  return caps.listsStaff();
}

export const STAFF_INSTRUCTIONS =
  "Here people book a member of staff by name: list_staff gives who gives which service; check_availability and create_booking take staff_id (any by default), and add_ons from list_services.";

export function registerPublicStaffTools(server: McpServer, caps: Capabilities): void {
  server.registerTool(
    "list_staff",
    {
      title: "Staff",
      description:
        "Who you can book here: each member of staff's first name, their photo when there is one, and the services they give. Pass their id as staff_id to check_availability and create_booking, or any for whoever is free.",
      inputSchema: listStaffInput,
      annotations: readOnly,
    },
    async (args) => {
      try {
        const r = await caps.listStaff(args);
        return ok(
          r.items.map((s) => `${s.name} (id ${s.id}, ${s.service_ids.length} services)`).join("; ") ||
            "No staff listed.",
          r,
        );
      } catch (error) {
        return failed(error);
      }
    },
  );
}

const staffMemberResponse = z.looseObject({
  id: z.string(),
  name: z.string(),
  photo_url: z.string().optional(),
  service_ids: z.array(z.string()),
});

type Hook = Parameters<typeof validator>[2];

export function staffPublicRoutes(app: Hono<CallerEnv>, caps: Capabilities, hook: Hook): void {
  app.get(
    "/staff",
    describeRoute({
      tags: ["public"],
      summary: "Who you can book: first names, photos and the services each gives",
      responses: {
        200: {
          description: "Staff",
          content: { "application/json": { schema: resolver(z.object({ items: z.array(staffMemberResponse) })) } },
        },
      },
    }),
    validator("query", listStaffInput, hook),
    async (c) => c.json(await caps.listStaff(c.req.valid("query")), 200, { "Cache-Control": "public, max-age=60" }),
  );
  app.get(
    "/staff/:id/photo.jpg",
    describeRoute({
      tags: ["public"],
      summary: "A member of staff's photo",
      responses: { 200: { description: "JPEG" } },
    }),
    async (c) => {
      const photo = await caps.staff.photo(String(c.req.param("id")));
      const bytes = photo ? photoBytes(photo) : null;
      if (!bytes) return c.body(null, 404);
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
    },
  );
}

type Once = <T>(
  c: Context<CallerEnv>,
  op: string,
  input: unknown,
  run: (caller: Caller) => Promise<T>,
  status?: 200 | 201,
) => Promise<Response>;
type Describe = (spec: Parameters<typeof describeRoute>[0] & { write?: boolean }) => ReturnType<typeof describeRoute>;

const looseList = z.object({ items: z.array(z.looseObject({})) });
const dayQuery = z.object({
  date: z.iso.date().describe("The local day, YYYY-MM-DD, in the business's zone."),
});

export function staffOwnerRoutes(
  app: Hono<CallerEnv>,
  caps: Capabilities,
  helpers: { readonly once: Once; readonly owner: Describe; readonly hook: Hook },
): void {
  const { once, owner, hook } = helpers;
  const json = (description: string, status: 200 | 201 = 200) => ({
    [status]: { description, content: { "application/json": { schema: resolver(z.looseObject({})) } } },
  });
  app.get(
    "/staff",
    owner({
      tags: ["setup"],
      summary: "Your staff, with the services each gives, their own prices, lengths and hours",
      responses: { 200: { description: "Staff", content: { "application/json": { schema: resolver(looseList) } } } },
    }),
    async (c) => c.json({ items: await caps.staff.list(c.get("caller")) }),
  );
  app.post(
    "/staff",
    owner({
      tags: ["setup"],
      summary: "Add a member of staff",
      description:
        "Customers see only public_name (kept as written; default: the first word of name) and the photo. A member of staff's own price for a service is the owner's in person: the owner's AI is refused (403).",
      responses: json("Member of staff", 201),
      write: true,
    }),
    validator("json", staffInput, hook),
    async (c) => {
      const input = c.req.valid("json");
      return once(c, "staff.create", input, (caller) => caps.staff.create(caller, input), 201);
    },
  );
  app.patch(
    "/staff/:id",
    owner({ tags: ["setup"], summary: "Change a member of staff", responses: json("Member of staff"), write: true }),
    validator("json", updateStaffInput.omit({ staff_id: true }), hook),
    async (c) => {
      const input = { ...c.req.valid("json"), staff_id: String(c.req.param("id")) };
      return once(c, "staff.update", input, (caller) => caps.staff.update(caller, input));
    },
  );
  app.delete(
    "/staff/:id",
    owner({
      tags: ["setup"],
      summary: "Someone who no longer works here: off every public list",
      responses: json("Member of staff"),
      write: true,
    }),
    async (c) => {
      const id = String(c.req.param("id"));
      return once(c, "staff.archive", { id }, (caller) => caps.staff.archive(caller, id));
    },
  );
  app.get(
    "/staff/day",
    owner({
      tags: ["inbox"],
      summary: "One day by member of staff: their bookings, in the business's zone",
      responses: json("Day"),
    }),
    validator("query", dayQuery, hook),
    async (c) => c.json(await caps.staffDay(c.get("caller"), c.req.valid("query").date)),
  );
  app.get(
    "/integrations/:id/setup",
    owner({
      tags: ["integrations"],
      summary: "What a connected tool says about the business, to start from: services, staff, hours",
      description: "Read now from the tool; nothing is kept until the owner keeps it (POST).",
      responses: json("Snapshot"),
    }),
    async (c) => c.json(await caps.connectors.setupSnapshot(c.get("caller"), String(c.req.param("id")))),
  );
  app.post(
    "/integrations/:id/setup",
    owner({
      tags: ["integrations"],
      summary: "Keep what you chose of a connected tool's services and staff",
      description:
        "Read again from the tool, then the services and staff named (by the tool's ids) are made or updated in place, with the tool's own prices. The owner's, in person: the owner's AI and keys are refused (403).",
      responses: json("Kept"),
      write: true,
    }),
    validator("json", importSetupInput, hook),
    async (c) => {
      const id = String(c.req.param("id"));
      const input = c.req.valid("json");
      return once(c, "staff.import", { id, ...input }, async (caller) => {
        const snapshot = await caps.connectors.setupSnapshot(caller, id);
        if (snapshot.source.kind !== input.source) {
          throw new WriteError("invalid_input", "That is not the tool this connection reads.");
        }
        return caps.staff.importSetup(caller, snapshot, input);
      });
    },
  );
}
