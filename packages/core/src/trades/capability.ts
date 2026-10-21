import type { AttachmentRef, CheckAreaInput, CheckAreaOutput, Job } from "@surfingdog/spec";
import { eq } from "drizzle-orm";
import { answerOf, areaSummary, areaWords, checkSite } from "../area/index";
import {
  checkFileLink,
  type FileInput,
  type FileIntake,
  fileHeaders,
  fileLink,
  fileRow,
  itemFiles,
  readFile,
  takeFiles,
  uploadFile,
} from "../attachments/index";
import type { ConnectorCapabilities } from "../connectors/capability";
import type { Db } from "../db";
import type { ItemFlags } from "../domain/types";
import { items } from "../schema/tables";
import type { SecretBox } from "../secrets/box";
import { readSettings } from "../settings/schema";
import { hashText } from "../util/canonical";
import { type Caller, isCustomer, isPerson, nowOf } from "../write/caller";
import { findIdempotent } from "../write/common";
import { WriteError } from "../write/errors";
import { JOB_WORDS, judgeRequest, openNow, premisesOf, siteOf, workProfile } from "./job";
import { jobToolConnections, type PushOutcome, pushRequest, sentTo } from "./job-tool";

/**
 * The trades doors (ADR-034): files on a request, where the business works, the job a request
 * describes, and the owner's job tool. Each door calls these; what a customer's agent is told speaks
 * as the business.
 */

/** What the inbox adds to a customer's request, and the files it took for it (`CreateInput.inboxAdds`). */
export interface InboxAdds {
  readonly payload: Record<string, unknown>;
  readonly files: readonly string[];
  readonly flags?: Partial<ItemFlags> | undefined;
  readonly hash: unknown;
}

export class TradeCapabilities {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox | null,
    private readonly deps: {
      readonly connectors: ConnectorCapabilities;
      /** The host's outbound fetch, for files an agent names by address. */
      readonly fetchImpl?: typeof fetch | undefined;
      /** What files may take at most, in bytes, as the host says (100 MB hosted); null: no limit. */
      readonly quotaBytes: () => number | null;
    },
  ) {}

  /** How files are taken here now: not at all without `INBOX_SECRET_KEY` (no link could show them). */
  intake(now: number, sentBy?: string | undefined): FileIntake {
    return {
      db: this.db,
      fetchImpl: this.deps.fetchImpl,
      quotaBytes: this.deps.quotaBytes(),
      enabled: this.secrets !== null,
      now,
      ...(sentBy ? { sentBy } : {}),
    };
  }

  private async businessName(): Promise<string> {
    const { rows } = await this.db.client.query({
      sql: "SELECT name FROM business LIMIT 1",
      params: [],
      method: "all",
    });
    const s = await readSettings(this.db);
    return String(rows[0]?.[0] ?? "").trim() || s.business.name.trim() || "The business";
  }

  /** `check_area`: whether a site is inside where the business works, as a band, never a distance. */
  async checkArea(input: CheckAreaInput): Promise<CheckAreaOutput> {
    const settings = await readSettings(this.db);
    const site = {
      ...(input.postal_code ? { postalCode: input.postal_code } : {}),
      ...(input.country ? { country: input.country.toUpperCase() } : {}),
      ...(input.lat !== undefined && input.lng !== undefined ? { point: { lat: input.lat, lng: input.lng } } : {}),
    };
    const check = checkSite(settings.area, premisesOf(settings), site);
    return {
      answer: answerOf(settings.area, check),
      ...(check.within_km ? { within_km: check.within_km } : {}),
      area: areaSummary(settings.area),
      words: areaWords(await this.businessName(), settings.area, check),
    };
  }

  /**
   * A customer's request for a price, as the inbox takes it: its site checked against the area, an
   * emergency against the emergency door, its files checked, cleaned and kept. Refuses a site outside an
   * area that declines and an emergency the door does not take, in the business's words. A retry of a
   * request already made keeps no new files: the create answers it as it was.
   */
  async prepareRequest(
    caller: Caller,
    payload: { readonly job?: Omit<Job, "areaCheck" | "visitBookingId"> | undefined } & Record<string, unknown>,
    files: readonly FileInput[] | undefined,
  ): Promise<InboxAdds | undefined> {
    const now = nowOf(caller);
    const hash = files?.length ? await hashText(JSON.stringify(files)) : null;
    if (caller.idempotency && (await findIdempotent(this.db, caller.idempotency))) {
      return { payload: {}, files: [], hash };
    }
    const settings = await readSettings(this.db);
    const job = payload.job;
    const site = siteOf(payload as Parameters<typeof siteOf>[0]);
    const check = checkSite(settings.area, premisesOf(settings), site);
    const open = await openNow(this.db, settings.business.timezone, now);
    const verdict = judgeRequest({ area: settings.area, work: settings.work, check, urgency: job?.urgency, open });
    const business = await this.businessName();
    if (verdict.refused) {
      const message = JOB_WORDS[verdict.refused](business, settings.commerce.legal.phone);
      throw new WriteError(verdict.refused === "outside" ? "not_allowed" : "invalid_input", message, {
        ...(verdict.refused === "outside"
          ? {}
          : { fields: [{ path: "payload.job.urgency", problem: "invalid" as const, message }] }),
        details: {
          reason: verdict.refused === "outside" ? "outside_area" : "emergency",
          area: areaSummary(settings.area),
        },
      });
    }
    const refs: AttachmentRef[] = await takeFiles(this.intake(now), files);
    const adds: Record<string, unknown> = {};
    // The area is checked whenever the business has one, and the job carries what it found.
    if (job || settings.area.mode !== "anywhere") adds.job = { ...(job ?? {}), areaCheck: check };
    if (refs.length) adds.attachments = refs;
    return {
      payload: adds,
      files: refs.map((r) => r.id),
      flags: {
        ...(verdict.priority > 0 ? { priority: verdict.priority } : {}),
        ...(verdict.needsHuman ? { needsHuman: true } : {}),
      },
      hash,
    };
  }

  /** Files on a booking or an order (a cake's picture, a plan): checked, cleaned, kept, nothing else asked. */
  async prepareFiles(caller: Caller, files: readonly FileInput[] | undefined): Promise<InboxAdds | undefined> {
    if (!files?.length) return undefined;
    const now = nowOf(caller);
    const hash = await hashText(JSON.stringify(files));
    if (caller.idempotency && (await findIdempotent(this.db, caller.idempotency))) {
      return { payload: {}, files: [], hash };
    }
    const refs = await takeFiles(this.intake(now), files);
    return { payload: { attachments: refs }, files: refs.map((r) => r.id), hash };
  }

  /**
   * `POST /v1/uploads`: one file, kept an hour for a request to name. `sentBy` is the address the door
   * counts the sender by, so one sender cannot take every waiting file's room.
   */
  async upload(caller: Caller, bytes: Uint8Array, name: string | undefined, sentBy?: string | undefined) {
    return uploadFile(this.intake(nowOf(caller), sentBy), bytes, name);
  }

  /** An item's files with a link each that works for ten minutes, for the business only. */
  async files(
    caller: Caller,
    itemId: string,
  ): Promise<{ files: (AttachmentRef & { url: string; expires_at: string })[] }> {
    if (isCustomer(caller)) throw new WriteError("not_allowed", "only the business sees the files on a request");
    const [row] = await this.db.orm
      .select({ id: items.id, payload: items.payload })
      .from(items)
      .where(eq(items.id, itemId));
    if (!row) throw new WriteError("not_found", "no such item");
    if (!this.secrets) return { files: [] };
    const now = nowOf(caller);
    // In the order the customer sent them, as the item names them.
    const order = ((row.payload as { attachments?: { id?: unknown }[] } | null)?.attachments ?? []).map((a) =>
      String(a.id),
    );
    const kept = (await itemFiles(this.db, itemId)).sort(
      (a, b) => (order.indexOf(a.ref.id) >>> 0) - (order.indexOf(b.ref.id) >>> 0),
    );
    const out: (AttachmentRef & { url: string; expires_at: string })[] = [];
    for (const f of kept) {
      const link = await fileLink(this.secrets, f.ref.id, now);
      out.push({ ...f.ref, url: link.path, expires_at: new Date(link.expires).toISOString() });
    }
    return { files: out };
  }

  /** A file through its link: the bytes and the headers they are served with; null for anything else. */
  async serveFile(
    id: string,
    e: string | null | undefined,
    s: string | null | undefined,
    now: number,
  ): Promise<{ headers: Record<string, string>; bytes: Uint8Array } | null> {
    if (!this.secrets || !/^att_[A-Za-z0-9_-]{16,48}$/.test(id)) return null;
    if (!(await checkFileLink(this.secrets, id, e, s, now))) return null;
    const row = await fileRow(this.db, id);
    // A file nobody's request took is not served: it is not the business's yet.
    if (!row || row.itemId === null) return null;
    const got = await readFile(this.db, id);
    if (!got) return null;
    return {
      headers: fileHeaders(got.file.ref.content_type, got.file.ref.name, got.bytes.byteLength),
      bytes: got.bytes,
    };
  }

  /**
   * Settings → Area and Work for the owner: what is set, and what the business says of it in public
   * (never the base). The days left on a job tool's token that runs out (Fergus's, a year).
   */
  async workView(caller: Caller) {
    if (isCustomer(caller)) throw new WriteError("not_allowed", "this needs the owner");
    const settings = await readSettings(this.db);
    const tools = await jobToolConnections(this.db);
    const now = nowOf(caller);
    const expiring: { connection_id: string; kind: string; expires_at: string }[] = [];
    for (const t of tools) {
      const { rows } = await this.db.client.query({
        sql: "SELECT json_extract(config_public, '$.extra.tokenExpiresAt') FROM connectors WHERE id = ?",
        params: [t.id],
        method: "all",
      });
      const at = Number(rows[0]?.[0] ?? 0);
      // Said from fifteen days before: the owner makes a new token before the old one stops.
      if (at > 0 && at - now < 15 * 86_400_000) {
        expiring.push({ connection_id: t.id, kind: t.kind, expires_at: new Date(at).toISOString() });
      }
    }
    return {
      area: settings.area,
      work: settings.work,
      public: { area: areaSummary(settings.area), work: workProfile(settings) },
      job_tools: tools.map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        // The owner can start from what the tool says (its opening hours: "Start from ServiceM8").
        starts: this.deps.connectors.definition(t.kind)?.capabilities.includes("setup_in") === true,
      })),
      expiring,
    };
  }

  /** The job tools connected, the owner's mode, and what went where for one request. */
  async jobTool(caller: Caller, itemId: string) {
    if (isCustomer(caller)) throw new WriteError("not_allowed", "this needs the owner");
    const [settings, tools, sent] = await Promise.all([
      readSettings(this.db),
      jobToolConnections(this.db),
      sentTo(this.db, itemId),
    ]);
    return {
      mode: settings.work.jobTool,
      tools: tools.map((t) => ({ id: t.id, kind: t.kind, name: t.name })),
      sent: sent.map((s) => {
        const tool = tools.find((t) => t.id === s.connectorId);
        const open = tool ? this.deps.connectors.definition(tool.kind)?.requests?.openUrl : undefined;
        const url = s.externalId && open ? open(s.externalId) : null;
        return { connection_id: s.connectorId, outcome: s.outcome, external_id: s.externalId, url };
      }),
    };
  }

  /**
   * The owner sends a request to their job tool by hand: a person at the business, in a mode that sends
   * any. Their AI may not: what goes into another system is the owner's to send.
   */
  async sendToJobTool(caller: Caller, itemId: string): Promise<{ outcomes: readonly PushOutcome[] }> {
    if (!isPerson(caller)) {
      throw new WriteError(
        "not_allowed",
        "Only a person at the business sends a request to their job tool. Leave the owner a note instead.",
        { details: { reason: "person_only" } },
      );
    }
    const settings = await readSettings(this.db);
    if (settings.work.jobTool === "never") {
      throw new WriteError("not_allowed", "Requests go to no job tool: choose another in Settings → Work.", {
        details: { reason: "job_tool_never" },
      });
    }
    const [row] = await this.db.orm.select({ type: items.type }).from(items).where(eq(items.id, itemId));
    if (!row) throw new WriteError("not_found", "no such item");
    if (row.type !== "quote_request")
      throw new WriteError("wrong_state", "only a request for a price goes to a job tool");
    return { outcomes: await pushRequest(this.db, this.deps.connectors, itemId, "sent", nowOf(caller)) };
  }
}
