import type { Db } from "@surfingdog/core";
import type { Inbox } from "@surfingdog/inbox/app";

/**
 * The internal test as an agent: one call per door, made in this process to an instance over the
 * inbox's own file with its doors open, each marked as a test (`x-sandbox: 1`), so nothing it makes
 * is real, nobody is written to, and nothing goes through the network. The control plane asks for it
 * while the inbox is still closed to everyone else, and shows the owner what passed.
 */

export interface ProbeResult {
  readonly door: string;
  readonly ok: boolean;
  readonly status: number;
  readonly detail: string;
}

/** A documentation address (RFC 5737): never a real client, and a rate-limit bucket of its own. */
const PROBE_ADDRESS = "192.0.2.10";
const CONTACT = { name: "Test" };

export async function probeDoors(inbox: Inbox, origin: string, doors: readonly string[]): Promise<ProbeResult[]> {
  const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
    await inbox.app.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: {
          accept: "application/json",
          "x-sandbox": "1",
          "cf-connecting-ip": PROBE_ADDRESS,
          "user-agent": "inbox-self-test",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  // A priced request is answered with its terms to confirm first, as a person's assistant would.
  const create = async (path: string, body: Record<string, unknown>): Promise<Response> => {
    const first = await call("POST", path, body);
    if (first.status !== 409) return first;
    const problem = (await first
      .clone()
      .json()
      .catch(() => null)) as { code?: string; details?: { terms_sha?: unknown } } | null;
    const sha = problem?.code === "confirm_terms" ? problem.details?.terms_sha : undefined;
    return typeof sha === "string" ? await call("POST", path, { ...body, terms_sha: sha }) : first;
  };
  const result = async (door: string, res: Response): Promise<ProbeResult> => {
    const ok = res.status === 201 || res.status === 200;
    let detail = ok ? "passed" : `answered ${res.status}`;
    if (!ok) {
      const body = (await res.json().catch(() => null)) as { detail?: unknown; message?: unknown } | null;
      const said =
        typeof body?.detail === "string" ? body.detail : typeof body?.message === "string" ? body.message : "";
      if (said) detail = `${detail}: ${said.slice(0, 300)}`;
    }
    return { door, ok, status: res.status, detail };
  };
  const out: ProbeResult[] = [];
  for (const door of doors) {
    try {
      if (door === "message") {
        out.push(
          await result(
            door,
            await create("/v1/messages", { body: "A test message, sent to check this door.", contact: CONTACT }),
          ),
        );
      } else if (door === "quote_request") {
        out.push(
          await result(
            door,
            await create("/v1/quotes", {
              payload: {
                itemOffered: { name: "Test request" },
                description: "A test request, sent to check this door.",
              },
              contact: CONTACT,
            }),
          ),
        );
      } else if (door === "booking") {
        out.push(await probeBooking(call, create, result));
      } else if (door === "order") {
        out.push(await probeOrder(call, create, result));
      } else if (door === "refund") {
        out.push({ door, ok: false, status: 0, detail: "not tested: a refund needs an order first" });
      } else {
        out.push({ door, ok: false, status: 0, detail: "not a door" });
      }
    } catch (error) {
      out.push({ door, ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;
type Create = (path: string, body: Record<string, unknown>) => Promise<Response>;
type Result = (door: string, res: Response) => Promise<ProbeResult>;

async function probeBooking(call: Call, create: Create, result: Result): Promise<ProbeResult> {
  const services = (await (await call("GET", "/v1/services?limit=50")).json().catch(() => null)) as {
    items?: { id: string; name: string; durationMin: number }[];
  } | null;
  const now = Date.now();
  for (const service of services?.items ?? []) {
    const from = new Date(now + 3_600_000).toISOString();
    const to = new Date(now + 14 * 86_400_000 - 60_000).toISOString();
    const q = new URLSearchParams({ service_id: service.id, from, to });
    const slots = (await (await call("GET", `/v1/availability?${q}`)).json().catch(() => null)) as {
      slots?: { startTime: string }[];
    } | null;
    const slot = slots?.slots?.[0];
    if (!slot) continue;
    const end = new Date(Date.parse(slot.startTime) + service.durationMin * 60_000).toISOString();
    return await result(
      "booking",
      await create("/v1/bookings", {
        payload: {
          reservationFor: { serviceId: service.id, name: service.name },
          startTime: slot.startTime,
          endTime: end,
        },
        contact: CONTACT,
      }),
    );
  }
  return {
    door: "booking",
    ok: false,
    status: 0,
    detail: (services?.items ?? []).length === 0 ? "no service to book" : "no free time in the next two weeks",
  };
}

async function probeOrder(call: Call, create: Create, result: Result): Promise<ProbeResult> {
  const products = (await (await call("GET", "/v1/products?limit=50")).json().catch(() => null)) as {
    items?: { id: string; name: string; price: unknown; active: number }[];
  } | null;
  const product = products?.items?.find((p) => p.active !== 0);
  if (!product) return { door: "order", ok: false, status: 0, detail: "no product to order" };
  return await result(
    "order",
    await create("/v1/orders", {
      payload: { orderedItem: [{ productId: product.id, name: product.name, quantity: 1, price: product.price }] },
      contact: CONTACT,
    }),
  );
}

/** What an archive leaves: one test item kept as the owner's example, the rest out of sight. */
export interface ArchiveResult {
  readonly archived: number;
  readonly kept_id: string | null;
}

/** The door whose test item makes the best example, first. */
const EXAMPLE_ORDER = ["booking", "quote_request", "message", "order", "refund"];

/**
 * Marks every test item archived (`flags.archived`), but one kept as the example (`flags.example`)
 * when asked. Only test items are touched, and only their flags: nothing real changes, and no item
 * moves through its states for it.
 */
export async function archiveSandbox(db: Db, keep: "example" | "none"): Promise<ArchiveResult> {
  const { rows } = await db.client.query({
    sql: `SELECT id, type FROM items WHERE COALESCE(sandbox, 0) = 1 AND COALESCE(json_extract(flags, '$.archived'), 0) = 0
           ORDER BY created_at DESC, id DESC`,
    params: [],
    method: "all",
  });
  const items = rows.map((r) => ({ id: String(r[0]), type: String(r[1]) }));
  let kept: string | null = null;
  if (keep === "example" && items.length > 0) {
    const rank = (t: string) => (EXAMPLE_ORDER.includes(t) ? EXAMPLE_ORDER.indexOf(t) : EXAMPLE_ORDER.length);
    kept = [...items].sort((a, b) => rank(a.type) - rank(b.type))[0]?.id ?? null;
  }
  const archive = items.filter((i) => i.id !== kept);
  const statements = [
    ...archive.map((i) => ({
      sql: "UPDATE items SET flags = json_set(flags, '$.archived', json('true')) WHERE id = ?",
      params: [i.id],
      method: "run" as const,
    })),
    ...(kept
      ? [
          {
            sql: "UPDATE items SET flags = json_set(flags, '$.example', json('true')) WHERE id = ?",
            params: [kept],
            method: "run" as const,
          },
        ]
      : []),
  ];
  if (statements.length > 0) await db.client.batch(statements);
  return { archived: archive.length, kept_id: kept };
}
