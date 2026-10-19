import { App as CapApp } from "@capacitor/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readItemLink, readPhoneLink } from "../../../packages/core/src/phones/links";
import type { ItemDetail, ItemView } from "../../inbox/client/src/lib/types";
import { AppContext, type App as AppValue, type Route } from "./context";
import { InboxClient, type PhoneMe } from "./lib/client";
import { type Native, native as nativeOf } from "./lib/native";
import { Box, type KV, Outbox, type QueuedAction } from "./lib/offline";
import { setUpPush } from "./lib/push";
import { type Fetch, type InboxEntry, InboxError, Sessions } from "./lib/session";
import { needsYou } from "./lib/view";
import { Connect } from "./screens/Connect";
import { Inbox } from "./screens/Inbox";
import { Inboxes } from "./screens/Inboxes";
import { Item } from "./screens/Item";
import { Lock } from "./screens/Lock";
import { OfflineBanner } from "./screens/Offline";
import { Settings } from "./screens/Settings";
import { Today } from "./screens/Today";

export interface Deps {
  readonly native: Native;
  readonly fetch: Fetch;
  readonly kv: KV;
  /** Development only: plain http to an inbox on this computer (or the emulator's host). */
  readonly allowLocal: boolean;
  /** Where the app opens; the inbox unless a screenshot or a test says otherwise. */
  readonly initial?: Route | undefined;
}

const ACTIVE = "active";
/** Back from the background after this long, the app asks for the fingerprint or face again. */
const RELOCK_MS = 60_000;

function memoryKv(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

export function defaultDeps(): Deps {
  let kv: KV;
  try {
    kv = localStorage;
  } catch {
    kv = memoryKv();
  }
  return { native: nativeOf(), fetch: (i, init) => fetch(i, init), kv, allowLocal: import.meta.env.DEV };
}

export function App({ deps }: { deps: Deps }) {
  const { native } = deps;
  const sessions = useMemo(() => new Sessions(native, deps.fetch), [native, deps.fetch]);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const [inboxes, setInboxes] = useState<InboxEntry[]>([]);
  const [active, setActive] = useState<InboxEntry | null>(null);
  const [views, setViews] = useState<ItemView[]>([]);
  const [me, setMe] = useState<PhoneMe | null>(null);
  const [loading, setLoading] = useState(false);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [queued, setQueued] = useState<QueuedAction[]>([]);
  const [stack, setStack] = useState<Route[]>(
    deps.initial?.name === "item" ? [{ name: "inbox" }, deps.initial] : [deps.initial ?? { name: "inbox" }],
  );
  const [toastText, setToastText] = useState<string | null>(null);
  const [needCounts, setNeedCounts] = useState<Record<string, number>>({});
  const pendingLink = useRef<string | null>(null);
  const hiddenAt = useRef<number | null>(null);
  const unlockedAt = useRef(0);

  const route = stack[stack.length - 1] ?? { name: "inbox" };
  const client = useMemo(
    () => (active ? new InboxClient(active, sessions, deps.fetch) : null),
    [active, sessions, deps.fetch],
  );
  const outbox = useMemo(() => (box ? new Outbox(box) : null), [box]);

  const toast = useCallback((text: string) => {
    setToastText(text);
    setTimeout(() => setToastText((t) => (t === text ? null : t)), 3200);
  }, []);
  const go = useCallback((r: Route) => setStack((s) => (r.name === "item" ? [...s, r] : [r])), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

  // ---- boot: the stores, the inboxes, the lock ----
  useEffect(() => {
    let alive = true;
    void (async () => {
      const opened = await Box.open(native, deps.kv);
      const list = await sessions.list();
      const last = deps.kv.getItem(`sdi.${ACTIVE}`);
      const lock = await native.canAuthenticate().catch(() => false);
      if (!alive) return;
      setBox(opened);
      setInboxes(list);
      setActive(list.find((e) => e.alias === last) ?? list[0] ?? null);
      setLocked(lock && list.length > 0);
      setReady(true);
      const launch = await CapApp.getLaunchUrl().catch(() => undefined);
      if (launch?.url) pendingLink.current = launch.url;
    })();
    return () => {
      alive = false;
    };
  }, [native, sessions, deps.kv]);

  // ---- the active inbox: its items, kept encrypted for offline ----
  const refresh = useCallback(async () => {
    if (!client || !box || !active) return;
    setLoading(true);
    try {
      const page = await client.items("all");
      setViews([...page.items]);
      setOfflineSince(null);
      await box.put(`list.${active.alias}`, { at: Date.now(), views: page.items });
      setNeedCounts((c) => ({ ...c, [active.alias]: page.items.filter(needsYou).length }));
      client
        .me()
        .then((m) => {
          setMe(m);
          // The inbox lost this phone's push (its app was reinstalled, the relay forgot it): set it up again.
          if (m.push_available && m.phone.push !== "on") void setUpPush(native, client, active.alias, false, true);
        })
        .catch(() => undefined);
    } catch (error) {
      if (error instanceof InboxError && error.code === "signed_out") {
        toast(`This phone was removed from ${active.name}. Connect it again from Settings → Phone.`);
        await sessions.forget(active);
        const list = await sessions.list();
        setInboxes(list);
        setActive(list[0] ?? null);
        return;
      }
      const cached = await box.get<{ at: number; views: ItemView[] }>(`list.${active.alias}`);
      if (cached) setViews(cached.views);
      if (error instanceof InboxError && error.offline) setOfflineSince(cached?.at ?? Date.now());
      else if (error instanceof Error) toast(error.message);
    } finally {
      setLoading(false);
    }
  }, [client, box, active, sessions, toast, native]);

  useEffect(() => {
    if (!ready || locked) return;
    setViews([]);
    setMe(null);
    void refresh();
    if (active) deps.kv.setItem(`sdi.${ACTIVE}`, active.alias);
  }, [ready, locked, active, refresh, deps.kv]);

  // ---- what was done offline goes when the inbox can be reached ----
  // `announce`: say so when something waiting from offline went. An action pressed online is not that.
  const flush = useCallback(
    async (announce = true) => {
      if (!outbox) return;
      const clients = new Map(inboxes.map((e) => [e.alias, new InboxClient(e, sessions, deps.fetch)]));
      const r = await outbox.flush(async (a) => {
        const c = clients.get(a.alias);
        if (!c) return { ok: false, offline: false, reason: "That inbox is no longer on this phone." };
        try {
          if (a.kind === "reply") await c.reply(a.itemId, String(a.body.body ?? ""), a.key);
          else await c.transition(a.itemId, a.body, a.key);
          return { ok: true };
        } catch (error) {
          const e = error instanceof InboxError ? error : new InboxError(String(error), 500, "client");
          return { ok: false, offline: e.offline, reason: e.message };
        }
      });
      for (const f of r.refused) toast(`${f.action.label}: ${f.reason}`);
      setQueued(await outbox.list());
      if (r.sent > 0 && announce) {
        toast(r.sent === 1 ? "Sent what you did offline." : `Sent the ${r.sent} things you did offline.`);
        void refresh();
      }
    },
    [outbox, inboxes, sessions, deps.fetch, toast, refresh],
  );

  useEffect(() => {
    if (!outbox) return;
    void outbox.list().then(setQueued);
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [outbox, flush]);

  const act = useCallback(
    async (itemId: string, kind: "transition" | "reply", body: Record<string, unknown>, label: string) => {
      if (!outbox || !active) return;
      // Kept first, with the idempotency key it will carry on every try, then sent.
      await outbox.add({ alias: active.alias, itemId, kind, body, label });
      await flush(false);
      const left = await outbox.list();
      setQueued(left);
      if (left.some((a) => a.itemId === itemId)) toast("Saved. It goes when you're back online.");
    },
    [outbox, active, flush, toast],
  );

  const loadItem = useCallback(
    async (id: string): Promise<ItemDetail | null> => {
      if (!client || !box || !active) return null;
      try {
        const detail = await client.item(id);
        await box.put(`item.${active.alias}.${id}`, detail);
        return detail;
      } catch (error) {
        const cached = await box.get<ItemDetail>(`item.${active.alias}.${id}`);
        if (cached) return cached;
        const fromList = views.find((v) => v.item.id === id);
        if (fromList) return { ...fromList, events: [], thread: [], mail: [], draft: null } as ItemDetail;
        if (error instanceof Error) toast(error.message);
        return null;
      }
    },
    [client, box, active, views, toast],
  );

  const connected = useCallback(
    async (entry: InboxEntry) => {
      const list = await sessions.list();
      setInboxes(list);
      setActive(list.find((e) => e.alias === entry.alias) ?? entry);
      setStack([{ name: "inbox" }]);
      toast(`Connected to ${entry.name}.`);
      // Step 2 of the approved Connect screen: notifications for new requests.
      const c = new InboxClient(entry, sessions, deps.fetch);
      const r = await setUpPush(native, c, entry.alias, true);
      if (r === "denied") toast("Notifications are off for this app. You can allow them in the phone's settings.");
    },
    [sessions, native, deps.fetch, toast],
  );

  const removeActive = useCallback(async () => {
    if (!active) return;
    await sessions.remove(active);
    box?.remove(`list.${active.alias}`);
    const list = await sessions.list();
    setInboxes(list);
    setActive(list[0] ?? null);
    setStack([{ name: list.length ? "inbox" : "connect" }]);
  }, [active, sessions, box]);

  // ---- links: a scanned or emailed link, a notification opening an item ----
  const openLink = useCallback(
    async (url: string) => {
      const phone = readPhoneLink(url, deps.allowLocal);
      if (phone) {
        try {
          const entry = phone.kind === "pair" ? await sessions.pair(phone) : await sessions.redeem(phone);
          await connected(entry);
        } catch (error) {
          toast(error instanceof Error ? error.message : "That link did not work.");
        }
        return;
      }
      const item = readItemLink(url, deps.allowLocal);
      if (!item) return;
      const entry = inboxes.find((e) => e.origin === item.origin);
      if (!entry) return;
      let action: string | undefined;
      try {
        action = new URL(url).searchParams.get("a") ?? undefined;
      } catch {
        action = undefined;
      }
      // Accept from a notification asks for the owner's fingerprint or face first, every time: once,
      // when the app has just been unlocked for it.
      const justUnlocked = Date.now() - unlockedAt.current < 30_000;
      if (action && !justUnlocked && (await native.canAuthenticate().catch(() => false))) {
        const ok = await native.authenticate("Accept from a notification").catch(() => false);
        if (!ok) action = undefined;
      }
      setActive(entry);
      setStack([{ name: "inbox" }, { name: "item", id: item.item, action }]);
    },
    [sessions, inboxes, native, deps.allowLocal, connected, toast],
  );

  useEffect(() => {
    const sub = CapApp.addListener("appUrlOpen", (e) => {
      if (locked) pendingLink.current = e.url;
      else void openLink(e.url);
    });
    const state = CapApp.addListener("appStateChange", async ({ isActive }) => {
      if (!isActive) {
        hiddenAt.current = Date.now();
        return;
      }
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      if (away > RELOCK_MS && inboxes.length > 0 && (await native.canAuthenticate().catch(() => false)))
        setLocked(true);
      else void flush().then(refresh);
    });
    return () => {
      void sub.then((s) => s.remove());
      void state.then((s) => s.remove());
    };
  }, [locked, openLink, native, inboxes.length, flush, refresh]);

  useEffect(() => {
    if (!ready || locked || !pendingLink.current) return;
    const url = pendingLink.current;
    pendingLink.current = null;
    void openLink(url);
  }, [ready, locked, openLink]);

  // Every inbox's push registration stays current: the push token changes now and then.
  const registerPush = useRef<() => void>(() => undefined);
  registerPush.current = () => {
    for (const e of inboxes) void setUpPush(native, new InboxClient(e, sessions, deps.fetch), e.alias, false);
  };
  useEffect(() => {
    native.onPushToken(() => registerPush.current());
  }, [native]);
  useEffect(() => {
    if (ready && !locked && inboxes.length > 0) registerPush.current();
  }, [ready, locked, inboxes]);

  const countAll = useCallback(async () => {
    if (!box) return;
    for (const e of inboxes) {
      const cached = await box.get<{ at: number; views: ItemView[] }>(`list.${e.alias}`);
      if (cached) setNeedCounts((c) => ({ ...c, [e.alias]: cached.views.filter(needsYou).length }));
    }
    if (offlineSince !== null) return;
    await Promise.all(
      inboxes.map(async (e) => {
        try {
          const page = await new InboxClient(e, sessions, deps.fetch).items("all");
          await box.put(`list.${e.alias}`, { at: Date.now(), views: page.items });
          setNeedCounts((c) => ({ ...c, [e.alias]: page.items.filter(needsYou).length }));
        } catch {
          // That inbox can't be reached now: its cached count stays.
        }
      }),
    );
  }, [box, inboxes, offlineSince, sessions, deps.fetch]);

  const value: AppValue = {
    native,
    sessions,
    inboxes,
    active,
    client,
    me,
    views,
    loading,
    offlineSince,
    queued,
    route,
    needCounts,
    go,
    back,
    choose: (e) => {
      setActive(e);
      setStack([{ name: "inbox" }]);
    },
    refresh,
    countAll,
    loadItem,
    act,
    connected,
    removeActive,
    toast,
    setMe,
  };

  if (!ready) return <div className="screen" />;
  if (locked)
    return (
      <AppContext.Provider value={value}>
        <Lock
          onUnlock={() => {
            unlockedAt.current = Date.now();
            setLocked(false);
          }}
        />
      </AppContext.Provider>
    );
  const screen =
    inboxes.length === 0 || route.name === "connect" ? (
      <Connect canGoBack={inboxes.length > 0} allowLocal={deps.allowLocal} />
    ) : route.name === "item" ? (
      <Item id={route.id} action={route.action} />
    ) : route.name === "today" ? (
      <Today />
    ) : route.name === "settings" ? (
      <Settings />
    ) : route.name === "inboxes" ? (
      <Inboxes />
    ) : (
      <Inbox />
    );
  return (
    <AppContext.Provider value={value}>
      {offlineSince !== null && route.name !== "inboxes" && (
        <OfflineBanner since={offlineSince} queued={queued.length} />
      )}
      {screen}
      {toastText && (
        <div className="toast" role="status">
          {toastText}
        </div>
      )}
    </AppContext.Provider>
  );
}
