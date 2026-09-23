import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { countsFrom } from "./filters";
import type {
  AddFeedBody,
  Closure,
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
  business: ["business"] as const,
  settings: ["settings"] as const,
  networks: ["networks"] as const,
  items: (params: ListParams) => ["items", params] as const,
  item: (id: string) => ["item", id] as const,
  counts: (sandbox: boolean) => ["counts", sandbox] as const,
  profile: ["profile"] as const,
  services: ["services"] as const,
  products: ["products"] as const,
  availability: ["availability"] as const,
  rules: ["rules"] as const,
  presets: ["presets"] as const,
  feeds: ["feeds"] as const,
  webhooks: ["webhooks"] as const,
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

/** Counts for the rail from the first hundred open and closed items: exact for a small inbox, "n+" beyond. */
export function useCounts(sandbox: boolean) {
  return useQuery({
    queryKey: qk.counts(sandbox),
    queryFn: async () => {
      const [open, everything] = await Promise.all([
        api.listItems({ open_only: true, sandbox, limit: 100 }),
        api.listItems({ open_only: false, sandbox, limit: 100 }),
      ]);
      return countsFrom(open, everything);
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

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsBody) => api.putSettings(body),
    onSuccess: (data) => {
      qc.setQueryData(qk.settings, data);
      void qc.invalidateQueries({ queryKey: ["items"] });
      void qc.invalidateQueries({ queryKey: ["counts"] });
      // A network switched on is pinged within seconds; look again once it has had the chance.
      void qc.invalidateQueries({ queryKey: qk.networks });
      setTimeout(() => void qc.invalidateQueries({ queryKey: qk.networks }), 3_000);
    },
  });
}

// ---- setup -----------------------------------------------------------------------------------

export function useProfile() {
  return useQuery({ queryKey: qk.profile, queryFn: api.profile, staleTime: 60_000 });
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

/** One mutation for add, change and archive; the list is refetched after any of them. */
export function useServiceWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: { id?: string | undefined; body?: ServiceBody | undefined; archive?: boolean | undefined }) =>
      op.archive && op.id
        ? api.archiveService(op.id)
        : op.id
          ? api.patchService(op.id, op.body ?? {})
          : api.createService(op.body ?? {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.services });
      void qc.invalidateQueries({ queryKey: qk.availability });
    },
  });
}

export function useProductWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: { id?: string | undefined; body?: ProductBody | undefined; archive?: boolean | undefined }) =>
      op.archive && op.id
        ? api.archiveProduct(op.id)
        : op.id
          ? api.patchProduct(op.id, op.body ?? {})
          : api.createProduct(op.body ?? {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.products }),
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
    onSuccess: (data) => qc.setQueryData(qk.availability, data),
  });
}

export function useClearOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) => api.clearOverride(serviceId),
    onSuccess: (data) => qc.setQueryData(qk.availability, data),
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
