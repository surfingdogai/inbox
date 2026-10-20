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
/**
 * Back from the background after this long, the app asks for the fingerprint or face again. Five
 * minutes: a glance between customers asks nothing, and an Accept always asks on its own.
 */
export const RELOCK_MS = 300_000;
/** An Accept right after the app was unlocked asks nothing more. */
const JUST_UNLOCKED_MS = 30_000;

function memoryKv(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
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

/** An item's cached details, with when they were read (the cache drops what nobody read for a month). */
interface KeptItem {
  readonly at: number;
  readonly detail: ItemDetail;
}

export function App({ deps }: { deps: Deps }) {
  const { native } = deps;
  const sessions = useMemo(() => new Sessions(native, deps.fetch), [native, deps.fetch]);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [insecure, setInsecure] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const [inboxes, setInboxes] = useState<InboxEntry[]>([]);
  const [active, setActive] = useState<InboxEntry | null>(null);
  const [views, setViews] = useState<ItemView[]>([]);
  const [me, setMe] = useState<PhoneMe | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
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
      // Item details nobody opened for a month go.
      await opened.evict().catch(() => 0);
      const list = await sessions.list();
      const last = deps.kv.getItem(`sdi.${ACTIVE}`);
      const lock = await native.canAuthenticate().catch(() => false);
      const secure = await native.deviceSecure().catch(() => true);
      if (!alive) return;
      setBox(opened);
      setInboxes(list);
      setActive(list.find((e) => e.alias === last) ?? list[0] ?? null);
      // No screen lock on a phone with inboxes on it: nothing opens until there is one.
      setInsecure(!secure && list.length > 0);
      setLocked(lock && list.length > 0);
      setReady(true);
      const launch = await CapApp.getLaunchUrl().catch(() => undefined);
      if (launch?.url) pendingLink.current = launch.url;
    })();
    return () => {
      alive = false;
    };
  }, [native, sessions, deps.kv]);

  /** Everything of one inbox goes from the phone: tokens, keys, cached items, what waited to send. */
  const wipe = useCallback(
    async (entry: InboxEntry, how: "remove" | "forget") => {
      if (how === "remove") await sessions.remove(entry);
      else await sessions.forget(entry);
      const list = await sessions.list();
      await box?.forgetInbox(entry.alias, native, list.length === 0);
      // The last inbox gone took the cache's key with it: a fresh one for whatever comes next.
      if (list.length === 0) setBox(await Box.open(native, deps.kv));
      else if (outbox) setQueued(await outbox.list());
      setNeedCounts((c) => {
        const { [entry.alias]: _gone, ...rest } = c;
        return rest;
      });
      setInboxes(list);
      setActive(list[0] ?? null);
      return list;
    },
    [sessions, box, native, outbox, deps.kv],
  );

  // ---- the active inbox: its items, kept encrypted for offline ----
  const refresh = useCallback(async () => {
    if (!client || !box || !active) return;
    setLoading(true);
    try {
      const page = await client.items("all");
      setViews([...page.items]);
      setOffline(false);
      setCachedAt(null);
      setListLoaded(true);
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
        const list = await wipe(active, "forget");
        if (list.length === 0) setStack([{ name: "connect" }]);
        return;
      }
      const cached = await box.get<{ at: number; views: ItemView[] }>(`list.${active.alias}`);
      if (cached) {
        setViews(cached.views);
        setListLoaded(true);
      }
      if (error instanceof InboxError && error.offline) {
        // Honest: the time the shown list was read, or that nothing of it is on this phone.
        setOffline(true);
        setCachedAt(cached?.at ?? null);
      } else if (error instanceof Error) toast(error.message);
    } finally {
      setLoading(false);
    }
  }, [client, box, active, toast, native, wipe]);

  useEffect(() => {
    if (!ready || locked || insecure) return;
    setViews([]);
    setMe(null);
    setListLoaded(false);
    void refresh();
    if (active) deps.kv.setItem(`sdi.${ACTIVE}`, active.alias);
  }, [ready, locked, insecure, active, refresh, deps.kv]);

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
    const online = () => void flush().then(refresh);
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [outbox, flush, refresh]);

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
        await box.put(`item.${active.alias}.${id}`, { at: Date.now(), detail } satisfies KeptItem);
        return detail;
      } catch (error) {
        const kept = await box.get<KeptItem>(`item.${active.alias}.${id}`);
        if (kept?.detail) return kept.detail;
        const fromList = views.find((v) => v.item.id === id);
        if (fromList) return { ...fromList, events: [], thread: [], mail: [], draft: null } as ItemDetail;
        if (error instanceof InboxError && error.offline) {
          // The banner says it already: the item screen says what it can, and tries again when back.
          setOffline(true);
          return null;
        }
        if (error instanceof Error) toast(error.message);
        return null;
      }
    },
    [client, box, active, views, toast],
  );

  /**
   * A phone the owner confirmed on the computer: kept, opened, and asked for notifications. A phone
   * connected by an emailed link arrives here at once.
   */
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
    const list = await wipe(active, "remove");
    setStack([{ name: list.length ? "inbox" : "connect" }]);
  }, [active, wipe]);

  // A code handed over by the page a QR code opens (intent://pair…): Connect asks before it pairs.
  const [handed, setHanded] = useState<ReturnType<typeof readPhoneLink>>(null);

  // ---- links: a scanned or emailed link, a notification opening an item ----
  const openLink = useCallback(
    async (url: string) => {
      const phone = readPhoneLink(url, deps.allowLocal);
      if (phone) {
        if (phone.kind === "pair") {
          // The owner agrees to the inbox's address on the Connect screen first.
          setHanded(phone);
          setStack([{ name: "connect" }]);
          return;
        }
        try {
          await connected(await sessions.redeem(phone));
        } catch (error) {
          toast(error instanceof Error ? error.message : "That link did not work.");
        }
        return;
      }
      const item = readItemLink(url, deps.allowLocal);
      if (!item) return;
      const entry = inboxes.find((e) => e.origin === item.origin);
      if (!entry) return;
      let q: URLSearchParams;
      try {
        q = new URL(url).searchParams;
      } catch {
        q = new URLSearchParams();
      }
      const title = q.get("t") ?? "";
      const body = q.get("b") ?? "";
      let action: string | undefined = q.get("a") ?? undefined;
      // Only one of this app's own notifications can choose an action: it carries a nonce the
      // notification service kept. A link any other app or page opens only opens the item.
      if (action && !(await native.claimAction(q.get("n") ?? "", item.item, action).catch(() => false)))
        action = undefined;
      // Accept from a notification asks for the owner's fingerprint or face first, unless the app was
      // unlocked for it a moment ago.
      const justUnlocked = Date.now() - unlockedAt.current < JUST_UNLOCKED_MS;
      if (action && !justUnlocked && (await native.canAuthenticate().catch(() => false))) {
        const ok = await native.authenticate("Confirm it's you", "To accept this request").catch(() => false);
        if (!ok) action = undefined;
      }
      setActive(entry);
      setStack([
        { name: "inbox" },
        { name: "item", id: item.item, action, ...(title ? { hint: { title, body } } : {}) },
      ]);
    },
    [sessions, inboxes, native, deps.allowLocal, connected, toast],
  );

  useEffect(() => {
    const sub = CapApp.addListener("appUrlOpen", (e) => {
      // Android hands the link over before the app is back in front: when it has been away long
      // enough to lock, lock now and open the link once unlocked, so one prompt does for both.
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      if (locked) {
        pendingLink.current = e.url;
        return;
      }
      if (away > RELOCK_MS && inboxes.length > 0) {
        void native.canAuthenticate().then((can) => {
          if (can) {
            pendingLink.current = e.url;
            hiddenAt.current = null;
            setLocked(true);
          } else void openLink(e.url);
        });
        return;
      }
      void openLink(e.url);
    });
    const state = CapApp.addListener("appStateChange", async ({ isActive }) => {
      if (!isActive) {
        hiddenAt.current = Date.now();
        return;
      }
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      if (locked) return;
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
    if (!ready || locked || insecure || !pendingLink.current) return;
    const url = pendingLink.current;
    pendingLink.current = null;
    void openLink(url);
  }, [ready, locked, insecure, openLink]);

  // Every inbox's push registration stays current: the push token changes now and then.
  const registerPush = useRef<() => void>(() => undefined);
  registerPush.current = () => {
    for (const e of inboxes) void setUpPush(native, new InboxClient(e, sessions, deps.fetch), e.alias, false);
  };
  useEffect(() => {
    native.onPushToken(() => registerPush.current());
  }, [native]);
  useEffect(() => {
    if (ready && !locked && !insecure && inboxes.length > 0) registerPush.current();
  }, [ready, locked, insecure, inboxes]);

  const countAll = useCallback(async () => {
    if (!box) return;
    for (const e of inboxes) {
      const cached = await box.get<{ at: number; views: ItemView[] }>(`list.${e.alias}`);
      if (cached) setNeedCounts((c) => ({ ...c, [e.alias]: cached.views.filter(needsYou).length }));
    }
    if (offline) return;
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
  }, [box, inboxes, offline, sessions, deps.fetch]);

  const value: AppValue = {
    native,
    sessions,
    inboxes,
    active,
    client,
    me,
    views,
    loading,
    offline,
    cachedAt,
    listLoaded,
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

  if (!ready) return <div className="shell" />;
  if (insecure || locked)
    return (
      <AppContext.Provider value={value}>
        <div className="shell">
          <Lock
            insecure={insecure}
            onUnlock={async () => {
              if (insecure) {
                if (!(await native.deviceSecure().catch(() => false))) return false;
                setInsecure(false);
                // A screen lock now: the app opens as any locked app does, with the fingerprint or face.
                if (await native.canAuthenticate().catch(() => false)) {
                  setLocked(true);
                  return true;
                }
              }
              unlockedAt.current = Date.now();
              setLocked(false);
              return true;
            }}
          />
        </div>
      </AppContext.Provider>
    );
  const screen =
    inboxes.length === 0 || route.name === "connect" ? (
      <Connect
        canGoBack={inboxes.length > 0}
        allowLocal={deps.allowLocal}
        handed={handed}
        onHandled={() => setHanded(null)}
      />
    ) : route.name === "item" ? (
      <Item id={route.id} action={route.action} hint={route.hint} />
    ) : route.name === "today" ? (
      <Today />
    ) : route.name === "settings" ? (
      <Settings />
    ) : route.name === "inboxes" ? (
      <Inboxes />
    ) : (
      <Inbox />
    );
  const showBanner = offline && inboxes.length > 0 && route.name !== "connect";
  return (
    <AppContext.Provider value={value}>
      <div className={`shell${showBanner ? " offline" : ""}`}>
        {showBanner && <OfflineBanner cachedAt={cachedAt} inbox={active?.name ?? ""} queued={queued.length} />}
        {screen}
      </div>
      {toastText && (
        <div className="toast" role="status">
          {toastText}
        </div>
      )}
    </AppContext.Provider>
  );
}
