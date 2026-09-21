import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { countsFrom } from "./filters";
import type { ListParams, ReplyBody, SettingsBody, TransitionBody } from "./types";

/** Query keys and hooks. Writes invalidate the item, every list and the counts. */
export const qk = {
  business: ["business"] as const,
  settings: ["settings"] as const,
  items: (params: ListParams) => ["items", params] as const,
  item: (id: string) => ["item", id] as const,
  counts: (sandbox: boolean) => ["counts", sandbox] as const,
};

export function useBusiness() {
  return useQuery({ queryKey: qk.business, queryFn: api.business, staleTime: 5 * 60_000 });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.getSettings, staleTime: 60_000 });
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
    },
  });
}
