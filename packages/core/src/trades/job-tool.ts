import type { Statement } from "@surfingdog/platform";
import { itemFiles, readFile } from "../attachments/store";
import type { ConnectorCapabilities } from "../connectors/capability";
import type { OutboundFile, OutboundRequest, PostalAddress, RunContext } from "../connectors/sdk";
import { registerWriteResolver, type WriteRow, type WrittenRef, writeFirst } from "../connectors/write-first";
import { shortRef } from "../customer/format";
import type { Db } from "../db";
import type { JobHandler } from "../jobs/runner";
import { readSettings } from "../settings/schema";
import { jobStatement } from "../write/common";
import type { JobToolMode } from "./settings";

/**
 * Requests into the owner's job tool (ADR-034 §5): ServiceM8, Housecall Pro, Fergus, Jobber. A request
 * goes there only as the owner chose (Settings → Work): every one as it arrives, only the ones they
 * take on (they quote it, or press "Send to …"), or none. The default is only the ones they take on:
 * a tool full of requests nobody looked at is how a tradesperson stops using it.
 *
 * Each write is written first and journalled (`writeFirst`, ADR-032): one at a time per request and
 * tool, under a key that is the same on every retry, so a request is never in the tool twice, and one
 * whose answer never came is looked for by that key before anything else. Only what the job needs goes
 * (who to answer, the site, what it is, when suits, the photos); nothing goes back to any network. A
 * test item never leaves the inbox.
 */

/** The job tools, by connector kind: the kinds are frozen once merged (they name connection rows). */
export const JOB_TOOL_KINDS = ["servicem8", "housecallpro", "fergus", "jobber"] as const;

export const WORK_PUSH_KIND = "work_push";
/** Who settles a request write left unknown (`registerWriteResolver`). */
export const WORK_WRITE_OWNER = "trades";

export type PushReason = "created" | "quoted" | "sent";

const KINDS_SQL = JOB_TOOL_KINDS.map((k) => `'${k}'`).join(", ");

/** The job tools connected and not paused, oldest first. */
export async function jobToolConnections(db: Db): Promise<{ id: string; kind: string; name: string }[]> {
  const { rows } = await db.client.query({
    sql: `SELECT id, kind, name FROM connectors WHERE kind IN (${KINDS_SQL}) AND status <> 'disabled' ORDER BY created_at, id`,
    params: [],
    method: "all",
  });
  return rows.map((r) => ({ id: String(r[0]), kind: String(r[1]), name: String(r[2] ?? r[1]) }));
}

/** Whether a reason sends a request in a mode: every one as it arrives; the owner's own as they take it on. */
export function sends(mode: JobToolMode, reason: PushReason): boolean {
  if (mode === "never") return false;
  if (reason === "created") return mode === "every";
  return true;
}

/**
 * The job that sends a request to the job tool, queued in the batch that wrote the event it follows:
 * none when no job tool is connected, so an inbox without one writes nothing more.
 */
export async function workPushStatements(
  db: Db,
  itemId: string,
  reason: PushReason,
  now: number,
): Promise<Statement[]> {
  if ((await jobToolConnections(db)).length === 0) return [];
  return [jobStatement(WORK_PUSH_KIND, { itemId, reason }, now, { dedupeKey: `work_push:${itemId}:${reason}` })];
}

interface RequestRow {
  readonly id: string;
  readonly type: string;
  readonly state: string;
  readonly sandbox: boolean;
  readonly payload: Record<string, unknown>;
  readonly name: string | null;
  readonly contact: { name?: unknown; email?: unknown; phone?: unknown; locale?: unknown } | null;
}

async function requestRow(db: Db, itemId: string): Promise<RequestRow | null> {
  const { rows } = await db.client.query({
    sql: `SELECT i.id, i.type, i.state, i.flags, i.payload, p.display_name, p.contact
            FROM items i LEFT JOIN parties p ON p.id = i.party_id WHERE i.id = ?`,
    params: [itemId],
    method: "all",
  });
  const r = rows[0];
  if (!r) return null;
  const json = (v: unknown) => {
    if (typeof v !== "string") return v ?? null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const flags = (json(r[3]) ?? {}) as { sandbox?: unknown };
  return {
    id: String(r[0]),
    type: String(r[1]),
    state: String(r[2]),
    sandbox: flags.sandbox === true,
    payload: (json(r[4]) ?? {}) as Record<string, unknown>,
    name: r[5] === null || r[5] === undefined ? null : String(r[5]),
    contact: json(r[6]) as RequestRow["contact"],
  };
}

const URGENCY_WORDS = {
  emergency: "Emergency",
  within_24h: "Within 24 hours",
  this_week: "This week",
  flexible: "Flexible",
} as const;
const VISIT_WORDS = {
  needed: "A visit is needed first",
  not_needed: "No visit needed",
  unsure: "Not sure about a visit",
} as const;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The request as the job tool is given it. Files are read only when the tool takes them. */
export async function outboundRequest(
  db: Db,
  row: RequestRow,
  ctx: Pick<RunContext, "inbox">,
): Promise<OutboundRequest> {
  const p = row.payload as {
    itemOffered?: { name?: string };
    description?: string;
    deliveryAddress?: PostalAddress;
    job?: {
      urgency?: keyof typeof URGENCY_WORDS;
      visit?: keyof typeof VISIT_WORDS;
      site?: { address?: PostalAddress; accessNotes?: string };
      windows?: { from: string; to: string }[];
    };
  };
  const reference = shortRef(row.id);
  const job = p.job ?? {};
  const urgency = job.urgency ?? "flexible";
  const visit = job.visit ?? "unsure";
  const site = job.site?.address ?? p.deliveryAddress ?? null;
  const windows = (job.windows ?? [])
    .map((w) => ({ start: Date.parse(w.from), end: Date.parse(w.to) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
  const fmt = (ms: number) => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: ctx.inbox.timezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toISOString();
    }
  };
  const files = await itemFiles(db, row.id);
  const lines = [
    str(p.description) ?? "",
    "",
    `Urgency: ${URGENCY_WORDS[urgency]}. ${VISIT_WORDS[visit]}.`,
    ...(windows.length
      ? [`Times that suit: ${windows.map((w) => `${fmt(w.start)} – ${fmt(w.end)}`).join("; ")}.`]
      : []),
    ...(str(job.site?.accessNotes) ? [`Finding the way: ${str(job.site?.accessNotes)}`] : []),
    ...(files.length ? [`Photos and plans: ${files.length}.`] : []),
    `Request ${reference}: ${ctx.inbox.origin}/items/${row.id}`,
  ];
  const outFiles: OutboundFile[] = files.map((f) => ({
    id: f.ref.id,
    name: f.ref.name,
    contentType: f.ref.content_type,
    size: f.ref.size,
    read: async () => {
      const got = await readFile(db, f.ref.id);
      if (!got) throw new Error(`the file ${f.ref.id} is gone`);
      return got.bytes;
    },
  }));
  return {
    itemId: row.id,
    reference,
    key: `${ctx.inbox.id}:${row.id}`,
    title: str(p.itemOffered?.name) ?? `Request ${reference}`,
    description: lines.join("\n").trim().slice(0, 8_000),
    urgency,
    visit,
    site,
    siteNotes: str(job.site?.accessNotes),
    windows,
    customer: {
      name: str(row.contact?.name) ?? str(row.name),
      email: str(row.contact?.email),
      phone: str(row.contact?.phone),
      language: str(row.contact?.locale) ?? ctx.inbox.language,
    },
    url: `${ctx.inbox.origin}/items/${row.id}`,
    files: outFiles,
  };
}

export interface PushOutcome {
  readonly connectorId: string;
  readonly kind: string;
  readonly status: "written" | "pending" | "refused" | "busy" | "skipped";
  readonly externalId?: string | undefined;
  readonly url?: string | undefined;
  readonly note: string;
}

/**
 * Sends one request to every job tool connected, as the owner's mode allows for the reason. Answers
 * what each did; throws only on our own bugs.
 */
export async function pushRequest(
  db: Db,
  connectors: ConnectorCapabilities,
  itemId: string,
  reason: PushReason,
  now: number,
): Promise<PushOutcome[]> {
  const settings = await readSettings(db);
  const row = await requestRow(db, itemId);
  const tools = await jobToolConnections(db);
  if (row?.type !== "quote_request") return [];
  const out: PushOutcome[] = [];
  for (const tool of tools) {
    const skip = (note: string): PushOutcome => ({ connectorId: tool.id, kind: tool.kind, status: "skipped", note });
    if (row.sandbox) {
      out.push(skip("a test request never goes to a job tool"));
      continue;
    }
    if (!sends(settings.work.jobTool, reason)) {
      out.push(skip(`the owner sends ${settings.work.jobTool === "never" ? "none" : "only the ones they take on"}`));
      continue;
    }
    const run = await connectors.contextFor(tool.id, now);
    const writer = run?.definition.requests;
    if (!run || !writer || !run.definition.capabilities.includes("requests_out")) {
      out.push(skip("this job tool cannot take requests here"));
      continue;
    }
    const request = await outboundRequest(db, row, run.ctx);
    const r = await writeFirst(db, {
      connectorId: tool.id,
      itemId,
      op: "request",
      owner: WORK_WRITE_OWNER,
      key: request.key,
      request: { reference: request.reference, title: request.title, files: request.files.map((f) => f.id) },
      write: async () => toWritten(await writer.put(run.ctx, request)),
      find: async () => {
        const found = await writer.find(run.ctx, request);
        return found ? toWritten(found) : null;
      },
      now,
    });
    if (r.status === "written") {
      const url = str(r.ref.detail?.url) ?? writer.openUrl?.(r.ref.externalId) ?? undefined;
      out.push({
        connectorId: tool.id,
        kind: tool.kind,
        status: "written",
        externalId: r.ref.externalId,
        ...(url ? { url } : {}),
        note: r.replayed ? "there already" : "written",
      });
    } else if (r.status === "refused") {
      out.push({ connectorId: tool.id, kind: tool.kind, status: "refused", note: r.reason });
    } else if (r.status === "pending") {
      out.push({ connectorId: tool.id, kind: tool.kind, status: "pending", note: "no answer yet: looked for again" });
    } else if (r.status === "busy") {
      out.push({ connectorId: tool.id, kind: tool.kind, status: "busy", note: "being written now" });
    } else {
      out.push({ connectorId: tool.id, kind: tool.kind, status: "refused", note: "the tool took it back" });
    }
  }
  return out;
}

function toWritten(ref: { externalId: string; url?: string | undefined }): WrittenRef {
  return { externalId: ref.externalId, ...(ref.url ? { detail: { url: ref.url } } : {}) };
}

/** What has gone to which job tool for a request, for the owner's item screen. */
export async function sentTo(
  db: Db,
  itemId: string,
): Promise<{ connectorId: string; externalId: string | null; outcome: string }[]> {
  const { rows } = await db.client.query({
    sql: `SELECT w.connector_id, w.external_id, w.outcome FROM connector_writes w
           WHERE w.item_id = ? AND w.op = 'request'
             AND w.attempt = (SELECT MAX(attempt) FROM connector_writes v WHERE v.connector_id = w.connector_id AND v.item_id = w.item_id)
           ORDER BY w.created_at`,
    params: [itemId],
    method: "all",
  });
  return rows.map((r) => ({
    connectorId: String(r[0]),
    externalId: r[1] === null || r[1] === undefined ? null : String(r[1]),
    outcome: String(r[2]),
  }));
}

/** The job: one request, once per reason. */
export function workPushHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { db, now }) => {
    const p = job.payload as { itemId?: unknown; reason?: unknown } | null;
    const itemId = typeof p?.itemId === "string" ? p.itemId : null;
    const reason = p?.reason === "created" || p?.reason === "quoted" || p?.reason === "sent" ? p.reason : null;
    if (!itemId || !reason) return { note: "no item" };
    const outcomes = await pushRequest(db, connectors, itemId, reason, now);
    return { note: outcomes.map((o) => `${o.kind}: ${o.status} (${o.note})`).join("; ") || "no job tool" };
  };
}

/**
 * Settles a request write whose answer never came: looked for again by its key in the tool. Found, the
 * link keeps its id; never found, the next push (the owner's press, the next quote) writes it again.
 */
export function registerWorkResolver(connectors: ConnectorCapabilities): void {
  registerWriteResolver(WORK_WRITE_OWNER, {
    async find(db: Db, row: WriteRow, now: number) {
      const run = await connectors.contextFor(row.connectorId, now);
      const writer = run?.definition.requests;
      const item = await requestRow(db, row.itemId);
      if (!run || !writer || !item) return null;
      const found = await writer.find(run.ctx, await outboundRequest(db, item, run.ctx));
      return found ? toWritten(found) : null;
    },
    async settled(db: Db, row: WriteRow, outcome, ref, now) {
      if (outcome !== "written" || !ref) return;
      await db.client.query({
        sql: `UPDATE connector_links SET external_id = ?, state = 'synced', updated_at = ? WHERE connector_id = ? AND item_id = ?`,
        params: [ref.externalId, now, row.connectorId, row.itemId],
        method: "run",
      });
    },
  });
}
