import { App as CapApp } from "@capacitor/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readItemLink, readPhoneLink } from "../../../packages/core/src/phones/links";
import type { ItemDetail, ItemView } from "../../inbox/client/src/lib/types";
import { checkForUpdate } from "./channel";
import { AppContext, type App as AppValue, type Route } from "./context";
import { ACCOUNT_ORIGIN, Account, readCodeLink, readOpenLink } from "./lib/account";
import type { PublicFacts } from "./lib/chips";
import {
  DEMO_ENTRY,
  DEMO_READ_ONLY,
  DemoClient,
  InboxClient,
  type PhoneAsk,
  type PhoneMe,
  type PhoneSpam,
  sendQueued,
} from "./lib/client";
import { type Native, native as nativeOf } from "./lib/native";
import { Box, factsName, type KV, Outbox, type QueuedAction } from "./lib/offline";
import { setUpPush } from "./lib/push";
import { QuickReplies } from "./lib/replies";
import { type Fetch, type InboxEntry, InboxError, type PendingPhone, Sessions } from "./lib/session";
import { NO_UPDATE, type UpdateState } from "./lib/update";
import { needsYou } from "./lib/view";
import { Connect } from "./screens/Connect";
import { Inbox } from "./screens/Inbox";
import { Inboxes } from "./screens/Inboxes";
import { Item } from "./screens/Item";
import { Lock } from "./screens/Lock";
import { OfflineBanner } from "./screens/Offline";
import { Screened } from "./screens/Screened";
import { dayAndTime, PhoneAskSheet, Settings, Waiting } from "./screens/Settings";
import { Today } from "./screens/Today";

export interface Deps {
  readonly native: Native;
  readonly fetch: Fetch;
  readonly kv: KV;
  /** Development only: plain http to an inbox on this computer (or the emulator's host). */
  readonly allowLocal: boolean;
  /** Where the app opens; the inbox unless a screenshot or a test says otherwise. */
  readonly initial?: Route | undefined;
  /** This build's version and versionCode (Capacitor's App.getInfo on the phone). */
  readonly appInfo?: (() => Promise<AppInfo>) | undefined;
  /** Where signing in with an email code goes: Surfing Dog's own sign-in, unless a test says otherwise. */
  readonly accountOrigin?: string | undefined;
  /** Where the Connect screen opens (the screenshots): the camera, or signing in with email. */
  readonly connectStart?: "scan" | "email" | undefined;
}

export interface AppInfo {
  readonly version: string;
  readonly build: number;
}

async function capAppInfo(): Promise<AppInfo> {
  const i = await CapApp.getInfo();
  return { version: i.version, build: Number.parseInt(i.build, 10) || 0 };
}

const ACTIVE = "active";
/**
 * Back from the background after this long, the app asks for the fingerprint or face again. Five
 * minutes: a glance between customers asks nothing, and an Accept always asks on its own.
 */
export const RELOCK_MS = 300_000;
/** An Accept right after the app was unlocked asks nothing more. */
const JUST_UNLOCKED_MS = 30_000;
/**
 * While the app is in front, how often it asks every inbox whether a new phone waits for its yes. In the
 * background it never asks, and these looks never ask for the fingerprint or face (`phoneAsks`).
 */
const ASK_EVERY_MS = 30_000;

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
  return {
    native: nativeOf(),
    fetch: (i, init) => fetch(i, init),
    kv,
    allowLocal: import.meta.env.DEV,
    appInfo: capAppInfo,
  };
}

/** An item's cached details, with when they were read (the cache drops what nobody read for a month). */
interface KeptItem {
  readonly at: number;
  readonly detail: ItemDetail;
}

export function App({ deps }: { deps: Deps }) {
  const { native } = deps;
  const sessions = useMemo(() => new Sessions(native, deps.fetch), [native, deps.fetch]);
  const account = useMemo(
    () => new Account(native, deps.fetch, deps.accountOrigin ?? ACCOUNT_ORIGIN),
    [native, deps.fetch, deps.accountOrigin],
  );
  /**
   * New phones that ask this one for a yes (ADR-028 Amendment 4), in every inbox on the phone: the sheet
   * shows the first, naming its inbox, over any screen.
   */
  const [asks, setAsks] = useState<readonly { entry: InboxEntry; ask: PhoneAsk }[]>([]);
  /**
   * Asks answered on this phone, and asks put off ("Later") until the app next comes to the front or a
   * notification about one is opened: the sheet does not come back for them before.
   */
  const answered = useRef(new Set<string>());
  const putOff = useRef(new Set<string>());
  const shownAsk = asks.find((a) => !answered.current.has(a.ask.id) && !putOff.current.has(a.ask.id));
  /** Whether the app is in front: the half-minute look for asks runs only then. */
  const [front, setFront] = useState(true);
  /** A phone that redeemed an emailed link and waits for the owner's other phone: Connect shows it. */
  const [waitingPhone, setWaitingPhone] = useState<PendingPhone | null>(null);
  /** A code the sign-in email's button handed to the app: the Connect screen takes it. */
  const [codeLink, setCodeLink] = useState<{ id: string; code: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [insecure, setInsecure] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const [inboxes, setInboxes] = useState<InboxEntry[]>([]);
  const [active, setActive] = useState<InboxEntry | null>(null);
  /** "Try the demo" (lib/client.ts): the demo shop in front, read-only, and nothing of it kept on the phone. */
  const [demo, setDemo] = useState(false);
  const [views, setViews] = useState<ItemView[]>([]);
  const [me, setMe] = useState<PhoneMe | null>(null);
  const [spam, setSpam] = useState<PhoneSpam | null>(null);
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
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState>(NO_UPDATE);
  /** What Android's back button closes first: an open sheet, before the screen under it. */
  const backHandlers = useRef<(() => boolean)[]>([]);
  const pendingLink = useRef<string | null>(null);
  const hiddenAt = useRef<number | null>(null);
  const unlockedAt = useRef(0);

  const route = stack[stack.length - 1] ?? { name: "inbox" };
  const client = useMemo(
    () => (demo ? new DemoClient(sessions, deps.fetch) : active ? new InboxClient(active, sessions, deps.fetch) : null),
    [demo, active, sessions, deps.fetch],
  );
  const outbox = useMemo(() => (box ? new Outbox(box) : null), [box]);
  // The owner's quick replies for the inbox in front, sealed in the box; none for the demo.
  const replies = useMemo(
    () => (box && active && !demo ? new QuickReplies(box, active.alias) : null),
    [box, active, demo],
  );

  const toast = useCallback((text: string) => {
    setToastText(text);
    setTimeout(() => setToastText((t) => (t === text ? null : t)), 3200);
  }, []);
  const go = useCallback(
    (r: Route) => setStack((s) => (r.name === "item" || r.name === "screened" ? [...s, r] : [r])),
    [],
  );
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
      // The link the app was opened with (a code handed over, a sign-in link, a notification), read
      // before the app is ready: once ready, nothing else would make the app look for it again.
      const launch = await CapApp.getLaunchUrl().catch(() => undefined);
      if (!alive) return;
      if (launch?.url) pendingLink.current = launch.url;
      setBox(opened);
      setInboxes(list);
      setActive(list.find((e) => e.alias === last) ?? list[0] ?? null);
      // No screen lock on a phone with inboxes on it: nothing opens until there is one.
      setInsecure(!secure && list.length > 0);
      setLocked(lock && list.length > 0);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [native, sessions, deps.kv]);

  // ---- this build, and whether a newer one is ready (installed from the download page, not a store) ----
  useEffect(() => {
    let alive = true;
    void (deps.appInfo ?? capAppInfo)()
      .then((i) => alive && setAppInfo(i))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [deps.appInfo]);
  const checkUpdate = useRef<() => void>(() => undefined);
  checkUpdate.current = () => {
    // Only the Android app from the download page looks: on an iPhone the App Store updates it, and the
    // copy from Google Play is built without the check (channel.play.ts), since Play updates it.
    if (!appInfo || native.platform !== "android") return;
    void checkForUpdate(deps.fetch, deps.kv, appInfo.build)
      .then(setUpdate)
      .catch(() => undefined);
  };
  useEffect(() => {
    if (ready && !locked && !insecure && appInfo) checkUpdate.current();
  }, [ready, locked, insecure, appInfo]);

  // An inbox that moved to a new address (a hosted inbox now live at the business's own name): the
  // list and the inbox in front follow it, and the owner is told where it is now.
  useEffect(
    () =>
      sessions.onMove((moved) => {
        void sessions.list().then((list) => {
          setInboxes(list);
          setActive((a) => (a?.alias === moved.alias ? (list.find((e) => e.alias === moved.alias) ?? a) : a));
        });
        toast(`${moved.name} is now at ${new URL(moved.origin).host}.`);
      }),
    [sessions, toast],
  );

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
  /** "Check again", pressed on a phone waiting out its day: the look says so when it still waits. */
  const checking = useRef(false);
  const refresh = useCallback(async () => {
    if (!client || !box || !active) return;
    // A phone waiting out its day opens nothing: it only asks whether it was let in, or stopped.
    if (active.waitingUntil && !demo) {
      const state = await sessions.confirmed(active);
      if (state === "confirmed") {
        const entry = await sessions.settled(active);
        setInboxes(await sessions.list());
        setActive(entry);
        toast(`Connected to ${entry.name}.`);
        void setUpPush(native, new InboxClient(entry, sessions, deps.fetch), entry.alias, true);
      } else if (state === "refused") {
        toast(`Connecting this phone to ${active.name} was stopped.`);
        const list = await wipe(active, "forget");
        if (list.length === 0) setStack([{ name: "connect" }]);
      } else if (checking.current) toast(`Still waiting. It connects on ${dayAndTime(active.waitingUntil)}.`);
      return;
    }
    setLoading(true);
    try {
      const page = await client.items("all");
      setViews([...page.items]);
      setOffline(false);
      setCachedAt(null);
      setListLoaded(true);
      // The demo's examples are never kept on the phone: leaving it leaves nothing behind.
      if (!demo) await box.put(`list.${active.alias}`, { at: Date.now(), views: page.items });
      setNeedCounts((c) => ({ ...c, [active.alias]: page.items.filter(needsYou).length }));
      client
        .me()
        .then((m) => {
          setMe(m);
          // The inbox lost this phone's push (its app was reinstalled, the relay forgot it): set it up again.
          if (m.push_available && m.phone.push !== "on") void setUpPush(native, client, active.alias, false, true);
        })
        .catch(() => undefined);
      // The spam filter's foot line: an inbox from before it answers nothing, and the line stays away.
      client
        .spam()
        .then(setSpam)
        .catch(() => setSpam(null));
      // A new phone that asked to connect waits for this one's yes: the sheet asks, on any screen.
      if (!demo) void askAll.current(false);
    } catch (error) {
      if (error instanceof InboxError && error.code === "signed_out") {
        toast(`This phone was removed from ${active.name}. Connect it again from Settings → Phone.`);
        const list = await wipe(active, "forget");
        if (list.length === 0) setStack([{ name: "connect" }]);
        return;
      }
      const cached = demo ? null : await box.get<{ at: number; views: ItemView[] }>(`list.${active.alias}`);
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
  }, [client, box, active, demo, toast, native, wipe, sessions, deps.fetch]);
  const checkAgain = useCallback(async () => {
    checking.current = true;
    try {
      await refresh();
    } finally {
      checking.current = false;
    }
  }, [refresh]);

  useEffect(() => {
    if (!ready || locked || insecure) return;
    setViews([]);
    setMe(null);
    setSpam(null);
    setListLoaded(false);
    void refresh();
    if (active && !demo) deps.kv.setItem(`sdi.${ACTIVE}`, active.alias);
  }, [ready, locked, insecure, active, demo, refresh, deps.kv]);

  // ---- what was done offline goes when the inbox can be reached ----
  // `announce`: say so when something waiting from offline went. An action pressed online is not that.
  const flush = useCallback(
    async (announce = true) => {
      if (!outbox) return;
      const clients = new Map(inboxes.map((e) => [e.alias, new InboxClient(e, sessions, deps.fetch)]));
      // What the inbox did not answer now (offline, busy, or an unlock not given) waits for next time.
      const r = await outbox.flush((a) => sendQueued(clients.get(a.alias), a));
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
    async (itemId: string, kind: QueuedAction["kind"], body: Record<string, unknown>, label: string) => {
      if (!outbox || !active) return;
      // The demo changes nothing: said at once, and nothing is kept to send later.
      if (demo) {
        toast(DEMO_READ_ONLY);
        return;
      }
      // Kept first, with the idempotency key it will carry on every try, then sent.
      await outbox.add({ alias: active.alias, itemId, kind, body, label });
      await flush(false);
      const left = await outbox.list();
      setQueued(left);
      // Kept on the phone: offline, the inbox not answering just now, or an unlock not given.
      if (left.some((a) => a.itemId === itemId)) toast("Saved on this phone. It goes as soon as your inbox answers.");
    },
    [outbox, active, demo, flush, toast],
  );

  /** The chips' facts: read from the inbox's public door, else the copy kept on the phone (never the demo's). */
  const facts = useCallback(async (): Promise<PublicFacts | null> => {
    if (!client || !box || !active) return null;
    try {
      const read = await client.facts();
      if (!demo) await box.put(factsName(active.alias), read);
      return read;
    } catch {
      return demo ? null : await box.get<PublicFacts>(factsName(active.alias));
    }
  }, [client, box, active, demo]);

  const loadItem = useCallback(
    async (id: string): Promise<ItemDetail | null> => {
      if (!client || !box || !active) return null;
      try {
        const detail = await client.item(id);
        if (!demo) await box.put(`item.${active.alias}.${id}`, { at: Date.now(), detail } satisfies KeptItem);
        return detail;
      } catch (error) {
        const kept = demo ? null : await box.get<KeptItem>(`item.${active.alias}.${id}`);
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
    [client, box, active, demo, views, toast],
  );

  /**
   * A phone the owner confirmed on the computer, or on their other phone: kept, opened, and asked for
   * notifications. A phone connected by an emailed link, or by a code from Surfing Dog when the owner
   * has no other phone, arrives here at once; one waiting out its day arrives here to wait.
   */
  const connected = useCallback(
    async (entry: InboxEntry) => {
      // A real inbox connected from the demo: the demo is left behind.
      setDemo(false);
      const list = await sessions.list();
      setInboxes(list);
      setActive(list.find((e) => e.alias === entry.alias) ?? entry);
      setStack([{ name: "inbox" }]);
      // Waiting out its day ("I don't have my other phone"): kept, opening nothing, and nothing to hear yet.
      if (entry.waitingUntil) return;
      toast(`Connected to ${entry.name}.`);
      // Step 2 of the approved Connect screen: notifications for new requests.
      const c = new InboxClient(entry, sessions, deps.fetch);
      const r = await setUpPush(native, c, entry.alias, true);
      if (r === "denied") toast("Notifications are off for this app. You can allow them in the phone's settings.");
    },
    [sessions, native, deps.fetch, toast],
  );

  /** "Try the demo" on the first screen: the demo shop opens, read-only; nothing is set up on the phone. */
  const tryDemo = useCallback(() => {
    setDemo(true);
    setActive(DEMO_ENTRY);
    setStack([{ name: "inbox" }]);
  }, []);
  const leaveDemo = useCallback(() => {
    setDemo(false);
    setActive(inboxes[0] ?? null);
    setStack([{ name: inboxes.length ? "inbox" : "connect" }]);
  }, [inboxes]);

  const removeActive = useCallback(async () => {
    if (demo) return leaveDemo();
    if (!active) return;
    const list = await wipe(active, "remove");
    setStack([{ name: list.length ? "inbox" : "connect" }]);
  }, [demo, leaveDemo, active, wipe]);

  // A code handed over by the page a QR code opens (intent://pair…): Connect asks before it pairs.
  const [handed, setHanded] = useState<ReturnType<typeof readPhoneLink>>(null);

  // ---- links: a scanned or emailed link, a notification opening an item ----
  const openLink = useCallback(
    async (url: string) => {
      // The sign-in email's button: Connect confirms its code for the sign-in this phone started.
      const handedCode = readCodeLink(url);
      if (handedCode) {
        setCodeLink(handedCode);
        setStack([{ name: "connect" }]);
        return;
      }
      const phone = readPhoneLink(url, deps.allowLocal);
      if (phone) {
        if (phone.kind === "pair") {
          // The owner agrees to the inbox's address on the Connect screen first.
          setHanded(phone);
          setStack([{ name: "connect" }]);
          return;
        }
        try {
          const r = await sessions.redeem(phone);
          if ("entry" in r) await connected(r.entry);
          else {
            // The owner has a phone that says yes first: Connect shows the two digits and waits.
            setWaitingPhone(r.pending);
            setStack([{ name: "connect" }]);
          }
        } catch (error) {
          toast(error instanceof Error ? error.message : "That link did not work.");
        }
        return;
      }
      // A notification about the inbox, not an item ("A new phone wants to connect"): that inbox in
      // front, where the sheet asks, even one put off before. The owner opened it, so this look may ask
      // for the fingerprint or face.
      const opened = readOpenLink(url, deps.allowLocal);
      if (opened) {
        const entry = inboxes.find((e) => e.origin === opened);
        if (entry) {
          putOff.current.clear();
          setActive(entry);
          setStack([{ name: "inbox" }]);
          void askAll.current(true);
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

  // Whether the app is in front, for the sessions (no fingerprint or face is asked for in the
  // background) and the half-minute look for asks. A listener of its own, made once, so no change of
  // the screens' state can make it miss the app coming back; read from the app's state at the start too.
  useEffect(() => {
    const said = (isActive: boolean) => {
      sessions.setFront(isActive);
      setFront(isActive);
    };
    void CapApp.getState()
      .then((s) => said(s.isActive))
      .catch(() => undefined);
    const sub = CapApp.addListener("appStateChange", ({ isActive }) => said(isActive));
    return () => {
      void sub.then((s) => s.remove()).catch(() => undefined);
    };
  }, [sessions]);

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
      // Back in front: what was put off is asked again ("Later: it asks again when you next open the app").
      putOff.current.clear();
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      if (locked) return;
      if (away > RELOCK_MS && inboxes.length > 0 && (await native.canAuthenticate().catch(() => false)))
        setLocked(true);
      else {
        void flush().then(refresh);
        void askAll.current(false);
        checkUpdate.current();
      }
    });
    return () => {
      void sub.then((s) => s.remove());
      void state.then((s) => s.remove());
    };
  }, [locked, openLink, native, inboxes.length, flush, refresh]);

  // Android's back button and back gesture: an open sheet closes, then an item goes back to the list,
  // then another tab goes back to the inbox, and from the inbox the app goes to the background.
  const onBackButton = useRef<() => void>(() => undefined);
  onBackButton.current = () => {
    const handler = backHandlers.current[backHandlers.current.length - 1];
    if (handler?.()) return;
    if (locked || insecure) {
      void CapApp.minimizeApp().catch(() => undefined);
      return;
    }
    if (stack.length > 1) back();
    else if ((inboxes.length > 0 || demo) && route.name !== "inbox") setStack([{ name: "inbox" }]);
    else void CapApp.minimizeApp().catch(() => undefined);
  };
  const onBack = useCallback((handler: () => boolean) => {
    backHandlers.current.push(handler);
    return () => {
      backHandlers.current = backHandlers.current.filter((h) => h !== handler);
    };
  }, []);
  useEffect(() => {
    const sub = CapApp.addListener("backButton", () => onBackButton.current());
    return () => {
      void sub.then((s) => s.remove()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!ready || locked || insecure || !pendingLink.current) return;
    const url = pendingLink.current;
    pendingLink.current = null;
    void openLink(url);
  }, [ready, locked, insecure, openLink]);

  // New phones that ask for this one's yes, in every inbox on the phone: when the app opens or comes
  // back, after a refresh, every half minute while it is in front, and when a notification about one is
  // opened. Only that last look may ask for the fingerprint or face (`loud`): the others are quiet, and
  // an inbox whose token cannot be renewed without an unlock is looked at again after the next one.
  const askAll = useRef<(loud: boolean) => Promise<void>>(async () => undefined);
  askAll.current = async (loud: boolean) => {
    if (demo || locked || insecure) return;
    const open = inboxes.filter((e) => !e.waitingUntil);
    const found = await Promise.all(
      open.map(async (entry) => {
        try {
          return { entry, asks: await new InboxClient(entry, sessions, deps.fetch).phoneAsks({ quiet: !loud }) };
        } catch {
          // Not reached, or not unlocked lately: what it asked before stays until it answers again.
          return { entry, asks: null };
        }
      }),
    );
    setAsks((before) =>
      found
        .flatMap(({ entry, asks: list }) =>
          list ? list.map((ask) => ({ entry, ask })) : before.filter((a) => a.entry.alias === entry.alias),
        )
        // The inbox in front first.
        .sort((a, b) => Number(b.entry.alias === active?.alias) - Number(a.entry.alias === active?.alias)),
    );
  };
  useEffect(() => {
    if (!ready || locked || insecure || demo || inboxes.length === 0) return;
    void askAll.current(false);
  }, [ready, locked, insecure, demo, inboxes.length]);
  useEffect(() => {
    if (!ready || locked || insecure || demo || inboxes.length === 0 || !front) return;
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void askAll.current(false);
    }, ASK_EVERY_MS);
    return () => clearInterval(t);
  }, [ready, locked, insecure, demo, inboxes.length, front]);

  // Every inbox's push registration stays current: the push token changes now and then.
  const registerPush = useRef<() => void>(() => undefined);
  registerPush.current = () => {
    // A phone waiting out its day hears nothing yet: it is set up once it is let in.
    for (const e of inboxes.filter((x) => !x.waitingUntil))
      void setUpPush(native, new InboxClient(e, sessions, deps.fetch), e.alias, false);
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
      inboxes
        .filter((e) => !e.waitingUntil)
        .map(async (e) => {
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
    account,
    inboxes,
    active,
    client,
    clientFor: (entry) => new InboxClient(entry, sessions, deps.fetch),
    demo,
    tryDemo,
    leaveDemo,
    me,
    spam,
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
    checkAgain,
    countAll,
    loadItem,
    act,
    replies,
    facts,
    connected,
    removeActive,
    toast,
    setMe,
    appInfo,
    update,
    onBack,
    setSpam,
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
              sessions.setFront(true);
              setLocked(false);
              return true;
            }}
          />
        </div>
      </AppContext.Provider>
    );
  const screen =
    (inboxes.length === 0 && !demo) || route.name === "connect" ? (
      <Connect
        canGoBack={inboxes.length > 0 || demo}
        allowLocal={deps.allowLocal}
        handed={handed}
        onHandled={() => setHanded(null)}
        code={codeLink}
        onCode={() => setCodeLink(null)}
        waiting={waitingPhone}
        onWaiting={() => setWaitingPhone(null)}
        start={deps.connectStart}
      />
    ) : active?.waitingUntil && !demo ? (
      <Waiting entry={active} />
    ) : route.name === "item" ? (
      <Item id={route.id} action={route.action} hint={route.hint} />
    ) : route.name === "today" ? (
      <Today />
    ) : route.name === "settings" ? (
      <Settings />
    ) : route.name === "screened" ? (
      <Screened which={route.which} />
    ) : route.name === "inboxes" ? (
      <Inboxes />
    ) : (
      <Inbox />
    );
  const showBanner = offline && (inboxes.length > 0 || demo) && route.name !== "connect";
  return (
    <AppContext.Provider value={value}>
      <div className={`shell${showBanner ? " offline" : ""}`}>
        {showBanner && <OfflineBanner cachedAt={cachedAt} inbox={active?.name ?? ""} queued={queued.length} />}
        {screen}
        {shownAsk && route.name !== "connect" && (
          <PhoneAskSheet
            key={shownAsk.ask.id}
            entry={shownAsk.entry}
            ask={shownAsk.ask}
            many={inboxes.length > 1}
            onDone={(how) => {
              // Answered: gone. "Later": not asked again until the app next comes to the front.
              if (how === "later") {
                putOff.current.add(shownAsk.ask.id);
                setAsks((a) => [...a]);
                return;
              }
              answered.current.add(shownAsk.ask.id);
              setAsks((a) => a.filter((x) => x.ask.id !== shownAsk.ask.id));
            }}
          />
        )}
      </div>
      {toastText && (
        <div className="toast" role="status">
          {toastText}
        </div>
      )}
    </AppContext.Provider>
  );
}
