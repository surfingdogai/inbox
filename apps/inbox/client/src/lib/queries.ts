import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { countsFrom } from "./filters";
import { ownerLocale } from "./geo";
import type {
  AddFeedBody,
  Closure,
  ConnectBody,
  ConnectionPatch,
  CreateKeyBody,
  CreateWebhookBody,
  FeedConnector,
  ListParams,
  PatchWebhookBody,
  PresetKey,
  ProductBody,
  ProfileBody,
  ReplyBody,
  RuleBody,
  RuleView,
  ServiceBody,
  SettingsBody,
  TransitionBody,
  WebhookView,
  Weekly,
} from "./types";

/** Query keys and hooks. Writes invalidate the item, every list and the counts. */
export const qk = {
  email: ["email"] as const,
  business: ["business"] as const,
  settings: ["settings"] as const,
  networks: ["networks"] as const,
  items: (params: ListParams) => ["items", params] as const,
  item: (id: string) => ["item", id] as const,
  payments: (id: string) => ["payments", id] as const,
  counts: (sandbox: boolean) => ["counts", sandbox] as const,
  profile: ["profile"] as const,
  services: ["services"] as const,
  products: ["products"] as const,
  catalogue: ["catalogue"] as const,
  availability: ["availability"] as const,
  rules: ["rules"] as const,
  presets: ["presets"] as const,
  feeds: ["feeds"] as const,
  integrations: ["integrations"] as const,
  webhooks: ["webhooks"] as const,
  keys: ["keys"] as const,
  spam: ["spam"] as const,
  spamModel: ["spam", "model"] as const,
  deliveries: (id: string) => ["deliveries", id] as const,
};

export function useBusiness() {
  return useQuery({ queryKey: qk.business, queryFn: api.business, staleTime: 5 * 60_000 });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.getSettings, staleTime: 60_000 });
}

/** Each network and how it is doing; refreshed while the page is open, since a ping lands on its own. */
export function useNetworks() {
  return useQuery({ queryKey: qk.networks, queryFn: api.networks, staleTime: 10_000, refetchInterval: 30_000 });
}

/**
 * The email channel (ADR-026). Read again while something is on its way: a check out, a forward just
 * added (its provider's confirmation arrives here), DNS being looked at.
 */
export function useEmailChannel() {
  return useQuery({
    queryKey: qk.email,
    queryFn: api.emailChannel,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      // A check out, or an address added in the last half hour (its provider's confirmation is on its way).
      const fresh = (f: (typeof d.forwards)[number]) =>
        f.state === "setup" && Date.now() - Date.parse(f.created_at) < 30 * 60_000;
      if (d.forwards.some((f) => f.checking || fresh(f))) return 4_000;
      // DNS takes minutes to hours: the host looks every minute, so the page every half minute.
      if (d.sending.own?.state === "dns" || d.sending.own?.state === "verifying") return 30_000;
      return false;
    },
  });
}

export function useMailStatus() {
  return useQuery({ queryKey: ["mail", "status"], queryFn: api.mailStatus, staleTime: 60_000 });
}

/** Booking networks off for one customer; the item they were asked on is read again. */
export function useStopNetworks(itemId: string) {
  const invalidate = useInvalidateItem(itemId);
  return useMutation({ mutationFn: (partyId: string) => api.stopNetworks(partyId, itemId), onSuccess: invalidate });
}

/** Erases one customer: the first call asks what it would erase (a 409 with `confirm`), the second does it. */
export function useEraseCustomer(itemId: string) {
  const invalidate = useInvalidateItem(itemId);
  return useMutation({
    mutationFn: (input: { partyId: string; confirm?: string }) => api.eraseCustomer(input.partyId, input.confirm),
    onSuccess: invalidate,
  });
}

export function useReceiptStatus() {
  return useQuery({ queryKey: ["receipts", "status"], queryFn: api.receiptStatus, staleTime: 60_000 });
}

export function useItemPages(params: ListParams) {
  return useInfiniteQuery({
    queryKey: qk.items(params),
    queryFn: ({ pageParam }) => api.listItems(pageParam ? { ...params, cursor: pageParam } : params),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useItem(id: string) {
  return useQuery({ queryKey: qk.item(id), queryFn: () => api.getItem(id) });
}

/**
 * An order's pay links (ADR-023). Read again while one is being made or waits to be paid, so "Paid"
 * shows without a reload once the platform says so.
 */
export function useItemPayments(id: string | null | undefined, waiting: boolean) {
  return useQuery({
    queryKey: qk.payments(id ?? ""),
    queryFn: () => api.itemPayments(id ?? ""),
    enabled: Boolean(id),
    staleTime: 10_000,
    refetchInterval: (q) =>
      waiting || q.state.data?.payments.some((p) => p.state === "creating" || p.state === "open") ? 15_000 : false,
  });
}

/** Counts for the rail from the first hundred open and closed items: exact for a small inbox, "n+" beyond. */
export function useCounts(sandbox: boolean) {
  return useQuery({
    queryKey: qk.counts(sandbox),
    queryFn: async () => {
      const [open, everything, held] = await Promise.all([
        api.listItems({ open_only: true, sandbox, limit: 100 }),
        api.listItems({ open_only: false, sandbox, limit: 100 }),
        // What the spam filter holds (ADR-041): an older server without it answers as for everything.
        api
          .listItems({ screen: "held", open_only: false, sandbox, limit: 100 })
          .catch(() => ({ items: [], next_cursor: null })),
      ]);
      return countsFrom(open, everything, held);
    },
    staleTime: 15_000,
  });
}

function useInvalidateItem(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.item(id) });
    void qc.invalidateQueries({ queryKey: ["items"] });
    void qc.invalidateQueries({ queryKey: ["counts"] });
  };
}

export function useTransition(id: string) {
  const invalidate = useInvalidateItem(id);
  return useMutation({ mutationFn: (body: TransitionBody) => api.transition(id, body), onSuccess: invalidate });
}

export function useReply(id: string) {
  const invalidate = useInvalidateItem(id);
  return useMutation({ mutationFn: (body: ReplyBody) => api.reply(id, body), onSuccess: invalidate });
}

/** Sends or drops an item's draft: what automation would have offered outside the owner's limits. */
export function useDraft(id: string) {
  const invalidate = useInvalidateItem(id);
  const send = useMutation({ mutationFn: (draftId: string) => api.sendDraft(id, draftId), onSuccess: invalidate });
  const drop = useMutation({ mutationFn: (draftId: string) => api.dropDraft(id, draftId), onSuccess: invalidate });
  return { send, drop };
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsBody) => api.putSettings(body),
    onSuccess: (data) => {
      qc.setQueryData(qk.settings, data);
      // What agents can do (`doors`, `doorsElsewhere`) is read back with the profile and the business.
      void qc.invalidateQueries({ queryKey: qk.business });
      void qc.invalidateQueries({ queryKey: qk.profile });
      void qc.invalidateQueries({ queryKey: ["items"] });
      void qc.invalidateQueries({ queryKey: ["counts"] });
      // A network switched on is pinged within seconds; look again once it has had the chance.
      void qc.invalidateQueries({ queryKey: qk.networks });
      void qc.invalidateQueries({ queryKey: qk.catalogue });
      setTimeout(() => void qc.invalidateQueries({ queryKey: qk.networks }), 3_000);
    },
  });
}

// ---- setup -----------------------------------------------------------------------------------

export function useProfile() {
  return useQuery({ queryKey: qk.profile, queryFn: api.profile, staleTime: 60_000 });
}

/** The owner app's locale: English as it is written where the business is (`ownerLocale`). */
export function useOwnerLocale(): string | undefined {
  return ownerLocale(useProfile().data?.timezone);
}

export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileBody) => api.putProfile(body),
    onSuccess: (data) => {
      qc.setQueryData(qk.profile, data);
      void qc.invalidateQueries({ queryKey: qk.business });
      void qc.invalidateQueries({ queryKey: qk.availability });
    },
  });
}

export function useServices() {
  return useQuery({ queryKey: qk.services, queryFn: api.services, staleTime: 30_000 });
}

export function useProducts() {
  return useQuery({ queryKey: qk.products, queryFn: api.products, staleTime: 30_000 });
}

/** Your products on networks (ADR-029): the switch, the counts, each product's notes, each network's answer. */
export function useCatalogue() {
  return useQuery({ queryKey: qk.catalogue, queryFn: api.catalogue, staleTime: 10_000 });
}

/** A barcode confirmed, or the one-time offer of barcodes answered: the products and their notes change. */
export function useCatalogueWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (op: { readonly confirm: string } | { readonly skus: boolean }): Promise<{ used: number }> => {
      if ("confirm" in op) {
        await api.confirmBarcode(op.confirm);
        return { used: 1 };
      }
      return api.skuBarcodes(op.skus);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.products });
      void qc.invalidateQueries({ queryKey: qk.catalogue });
      void qc.invalidateQueries({ queryKey: qk.settings });
    },
  });
}

/** The owner's lowest prices, by product or service id. */
export function useFloors() {
  return useQuery({
    queryKey: ["floors"],
    queryFn: async () => {
      const { floors } = await api.floors();
      return new Map(floors.map((f) => [`${f.kind}:${f.ref_id}`, f.floor_minor]));
    },
    staleTime: 30_000,
  });
}

/**
 * One mutation for add, change and archive; the list is refetched after any of them. A lowest price
 * the owner changed (`floor`: minor units, or null to clear; undefined leaves it) is written after the
 * row, since it lives apart from it (ADR-018 §4).
 */
export function useServiceWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (op: {
      id?: string | undefined;
      body?: ServiceBody | undefined;
      archive?: boolean | undefined;
      floor?: number | null | undefined;
    }) => {
      const row =
        op.archive && op.id
          ? await api.archiveService(op.id)
          : op.id
            ? await api.patchService(op.id, op.body ?? {})
            : await api.createService(op.body ?? {});
      if (op.floor !== undefined) await api.putFloor("service", row.id, op.floor);
      return row;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.services });
      void qc.invalidateQueries({ queryKey: qk.availability });
      void qc.invalidateQueries({ queryKey: qk.business });
      void qc.invalidateQueries({ queryKey: qk.profile });
      void qc.invalidateQueries({ queryKey: ["floors"] });
    },
  });
}

export function useProductWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (op: {
      id?: string | undefined;
      body?: ProductBody | undefined;
      archive?: boolean | undefined;
      floor?: number | null | undefined;
    }) => {
      const row =
        op.archive && op.id
          ? await api.archiveProduct(op.id)
          : op.id
            ? await api.patchProduct(op.id, op.body ?? {})
            : await api.createProduct(op.body ?? {});
      if (op.floor !== undefined) await api.putFloor("product", row.id, op.floor);
      return row;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.products });
      void qc.invalidateQueries({ queryKey: qk.catalogue });
      void qc.invalidateQueries({ queryKey: qk.business });
      void qc.invalidateQueries({ queryKey: qk.profile });
      void qc.invalidateQueries({ queryKey: ["floors"] });
    },
  });
}

export function useAvailability() {
  return useQuery({ queryKey: qk.availability, queryFn: api.availability, staleTime: 30_000 });
}

export function useSaveWeekly() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { weekly: Weekly; serviceId?: string | undefined }) =>
      api.putWeekly(input.weekly, input.serviceId),
    onSuccess: (data) => {
      qc.setQueryData(qk.availability, data);
      void qc.invalidateQueries({ queryKey: qk.business });
      void qc.invalidateQueries({ queryKey: qk.profile });
    },
  });
}

export function useClearOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) => api.clearOverride(serviceId),
    onSuccess: (data) => {
      qc.setQueryData(qk.availability, data);
      void qc.invalidateQueries({ queryKey: qk.business });
      void qc.invalidateQueries({ queryKey: qk.profile });
    },
  });
}

export function useSaveClosures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (closures: readonly Closure[]) => api.putClosures(closures),
    onSuccess: (data) => qc.setQueryData(qk.availability, data),
  });
}

export function useRules() {
  return useQuery({ queryKey: qk.rules, queryFn: api.rules, staleTime: 30_000 });
}

export function usePresets() {
  return useQuery({ queryKey: qk.presets, queryFn: api.presets, staleTime: 5 * 60_000 });
}

export function useApplyPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: PresetKey; replace: boolean }) => api.applyPreset(input.key, input.replace),
    onSuccess: (data) => qc.setQueryData(qk.rules, data),
  });
}

/** Add, change or delete a rule; the list is refetched afterwards. */
export function useRuleWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: {
      id?: string | undefined;
      body?: RuleBody | undefined;
      remove?: boolean | undefined;
    }): Promise<RuleView | { deleted: true }> =>
      op.remove && op.id
        ? api.deleteRule(op.id)
        : op.id
          ? api.patchRule(op.id, op.body ?? {})
          : api.createRule(op.body ?? {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.rules }),
  });
}

// ---- integrations ----------------------------------------------------------------------------

/**
 * What can be connected and what is. While a connection has not finished its first sync, it is read
 * again every few seconds, so "Reading your calendar…" turns into what it found without a reload.
 */
export function useIntegrations() {
  return useQuery({
    queryKey: qk.integrations,
    queryFn: api.integrations,
    staleTime: 10_000,
    // A link the inbox serves stays unread until another platform opens it: nothing to wait for there.
    refetchInterval: (q) =>
      q.state.data?.connections.some((c) => c.status === "configured" && c.capabilities.length > 0) ? 3_000 : 60_000,
  });
}

/** Every write to a connection refreshes the list, and the free times it changes. */
export function useIntegrationWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      op:
        | { readonly connect: ConnectBody }
        | { readonly id: string; readonly patch: ConnectionPatch }
        | { readonly id: string; readonly sync: true }
        | { readonly id: string; readonly link: true }
        | { readonly id: string; readonly remove: true },
    ): Promise<unknown> =>
      "connect" in op
        ? api.connect(op.connect)
        : "patch" in op
          ? api.updateConnection(op.id, op.patch)
          : "sync" in op
            ? api.syncConnection(op.id)
            : "link" in op
              ? api.newConnectionLink(op.id)
              : api.removeConnection(op.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.integrations });
      void qc.invalidateQueries({ queryKey: qk.availability });
    },
  });
}

/**
 * "Propose the shop's total" on an order whose link is held (ADR-030): the change goes to the
 * customer, and the order and its payments are read again.
 */
export function useProposeShopTotal(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.proposeShopTotal(itemId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.item(itemId) });
      void qc.invalidateQueries({ queryKey: qk.payments(itemId) });
    },
  });
}

export function useFeeds() {
  return useQuery({ queryKey: qk.feeds, queryFn: api.feeds, staleTime: 15_000 });
}

/** Add, import now, or disconnect. The catalogue is refetched too: an import writes products. */
export function useFeedWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: {
      body?: AddFeedBody | undefined;
      id?: string | undefined;
      remove?: boolean | undefined;
    }): Promise<FeedConnector | { queued: true; connector_id: string } | { removed: true; deactivated: number }> =>
      op.remove && op.id ? api.removeFeed(op.id) : op.id ? api.importFeed(op.id) : api.addFeed(op.body ?? { url: "" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.feeds });
      void qc.invalidateQueries({ queryKey: qk.products });
    },
  });
}

export function useWebhooks() {
  return useQuery({ queryKey: qk.webhooks, queryFn: api.webhooks, staleTime: 15_000 });
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWebhookBody) => api.createWebhook(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.webhooks }),
  });
}

/** Change, pause, resume or remove an endpoint. */
export function useWebhookWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: {
      id: string;
      body?: PatchWebhookBody | undefined;
      remove?: boolean | undefined;
    }): Promise<WebhookView | { deleted: true }> =>
      op.remove ? api.deleteWebhook(op.id) : api.patchWebhook(op.id, op.body ?? {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.webhooks }),
  });
}

export function useTestWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.testWebhook(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.webhooks }),
  });
}

export function useRotateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rotateWebhookSecret(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.webhooks }),
  });
}

// ---- keys ---------------------------------------------------------------------------------------

export function useKeys() {
  return useQuery({ queryKey: qk.keys, queryFn: api.keys, staleTime: 15_000 });
}

export function useCreateKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateKeyBody) => api.createKey(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.keys }),
  });
}

export function useDisconnectApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.disconnectApp(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.keys }),
  });
}

export function useRevokeKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeKey(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.keys }),
  });
}

// ---- the spam filter (ADR-041) ---------------------------------------------------------------

export function useSpam() {
  return useQuery({ queryKey: qk.spam, queryFn: api.spam, staleTime: 15_000 });
}

/** A filter switched, a learning week ended, a list row removed: the status is read again. */
export function useSpamWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      op:
        | { readonly filter: "pitches" | "scams" | "junk"; readonly on: boolean; readonly choice?: "aside" | "label" }
        | { readonly start: "basic" | "pitches" | "scams" | "junk" }
        | { readonly remove: { list: "allow" | "block"; kind: string; value: string } },
    ): Promise<unknown> =>
      "start" in op
        ? api.startSpamFilter(op.start)
        : "remove" in op
          ? api.removeSpamListEntry(op.remove)
          : api.setSpamFilter(op.filter, { on: op.on, ...(op.choice ? { choice: op.choice } : {}) }),
    onSuccess: (data) => {
      if (data && typeof data === "object" && "filters" in data) qc.setQueryData(qk.spam, data);
      void qc.invalidateQueries({ queryKey: qk.spam });
    },
  });
}

export function useSpamModel() {
  return useQuery({ queryKey: qk.spamModel, queryFn: api.spamModel, staleTime: 30_000 });
}
