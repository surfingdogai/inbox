// The data for the update check (.github/workflows/update-test.yml): a business set up through the
// owner API, and a customer's booking, order and message made through the public one, each answered
// by the owner; then a read-back of all of it, to hold against the same read-back after an update.
//
//   node deploy/test/update-data.mjs seed <base URL> <owner key file> <records.json>
//   node deploy/test/update-data.mjs read <base URL> <owner key file> <records.json> <snapshot.json>
//   node deploy/test/update-data.mjs compare <before.json> <after.json> [report.md]
//
// A read-back holds every record as the inbox serves it, less the words it shows around the data
// (`human`, the buttons it offers, its guide for agents), which a new version may put differently.
// `compare` passes when every field the first read-back had is in the second, with the same value:
// fields a newer version adds are listed, not counted against it. Node 22 or later; no packages.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);

/** Words around the data, not the data: left out of a read-back. */
const PRESENTATION = new Set(["transitions", "human", "next", "identity", "mail", "draft", "guide"]);
/** Changes on every call that uses the key, the read-back's own calls included. */
const VOLATILE = new Set(["last_used_at"]);

function client(base, keyFile) {
  const key = readFileSync(keyFile, "utf8").trim();
  if (!key.startsWith("sdi_own_")) throw new Error(`${keyFile} holds no owner key`);
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(new URL(path, base), {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
  return {
    owner: (method, path, body) => call(method, path, body, { authorization: `Bearer ${key}` }),
    customer: (method, path, body, token) => call(method, path, body, token ? { "x-access-token": token } : {}),
  };
}

function want(r, status, what) {
  if (r.status !== status) {
    throw new Error(`${what}: HTTP ${r.status}, expected ${status}: ${JSON.stringify(r.json).slice(0, 800)}`);
  }
  return r.json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A priced request: the 409 names the terms, which the customer's person confirms, and it goes again. */
async function confirmed(api, path, body, what) {
  const first = await api.customer("POST", path, body);
  if (first.status === 201) return first.json;
  if (first.status !== 409 || first.json?.code !== "confirm_terms") want(first, 409, `${what}, asked for its terms`);
  return want(await api.customer("POST", path, { ...body, terms_sha: first.json.details.terms_sha }), 201, what);
}

async function seed(base, keyFile, out) {
  const api = client(base, keyFile);
  const run = Date.now().toString(36);
  const profile = want(
    await api.owner("PUT", "/v1/owner/profile", {
      name: "Tideline Surf School",
      timezone: "UTC",
      currency: "EUR",
      languages: ["en", "de"],
    }),
    200,
    "the business profile",
  );
  const service = want(
    await api.owner("POST", "/v1/owner/services", {
      name: "Surf lesson",
      description: "Ninety minutes in the water with an instructor, board and wetsuit included.",
      duration_min: 90,
      capacity: 4,
      granularity_min: 30,
      price: { model: "fixed", value: 4500, currency: "EUR", per: "person" },
    }),
    201,
    "a service",
  );
  const product = want(
    await api.owner("POST", "/v1/owner/products", {
      sku: "WAX-COLD",
      name: "Surf wax, cold water",
      description: "One bar.",
      price: { value: 650, currency: "EUR" },
      stock: 40,
    }),
    201,
    "a product",
  );
  const day = [
    ["09:00", "13:00"],
    ["14:00", "19:00"],
  ];
  want(
    await api.owner("PUT", "/v1/owner/availability", {
      weekly: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day },
    }),
    200,
    "the opening hours",
  );

  // A customer's agent, as any agent finds the business: its services, then a free time ten days out.
  const listed = want(await api.customer("GET", "/v1/services"), 200, "the public services");
  if (!JSON.stringify(listed).includes(service.id)) throw new Error("the new service is not in /v1/services");
  const date = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const free = want(
    await api.customer("GET", `/v1/availability?service_id=${service.id}&from=${date}T00:00:00Z&to=${date}T23:59:00Z`),
    200,
    "the free times",
  );
  const slot = free.slots.find((s) => s.available >= 2);
  if (!slot) throw new Error(`no free time on ${date}: ${JSON.stringify(free).slice(0, 400)}`);

  const booking = await confirmed(
    api,
    "/v1/bookings",
    {
      idempotency_key: `update-test-booking-${run}`,
      payload: {
        reservationFor: { serviceId: service.id, name: service.name },
        startTime: slot.startTime.replace(".000Z", "Z"),
        endTime: slot.endTime.replace(".000Z", "Z"),
        partySize: 2,
        notes: "Two beginners; one is left-footed.",
      },
      contact: { name: "Mia Novak", email: "mia.novak@example.com", phone: "+1 202 555 0143", locale: "en-GB" },
      message: "Can we park near the beach?",
    },
    "a booking",
  );
  const order = await confirmed(
    api,
    "/v1/orders",
    {
      idempotency_key: `update-test-order-${run}`,
      payload: {
        orderedItem: [
          { productId: product.id, sku: product.sku, name: product.name, quantity: 3, price: product.price },
        ],
        totalPrice: { value: 1950, currency: "EUR" },
      },
      contact: { name: "Tomás Reyes", email: "tomas.reyes@example.com" },
      message: "I will collect them on Saturday.",
    },
    "an order",
  );
  const message = want(
    await api.customer("POST", "/v1/messages", {
      idempotency_key: `update-test-message-${run}`,
      subject: "Wetsuits for children",
      body: "Do you have wetsuits for an eight-year-old?",
      contact: { name: "Lena Park", email: "lena.park@example.com" },
    }),
    201,
    "a message",
  );

  // The owner answers each one.
  const step = async (item, event, extra = {}) =>
    want(
      await api.owner("POST", `/v1/owner/items/${item.view.item.id}/transitions`, {
        event,
        idempotency_key: `update-test-${event}-${item.view.item.id}`,
        ...extra,
      }),
      200,
      `${event} the ${item.view.item.type}`,
    );
  await step(booking, "confirm", { reason: "See you at the beach." });
  await step(order, "accept");
  want(
    await api.owner("POST", `/v1/owner/items/${message.view.item.id}/replies`, {
      body: "Yes, from age six. Sizes XS to XL.",
      written_by: "person",
      idempotency_key: `update-test-reply-${run}`,
    }),
    200,
    "the owner's reply",
  );
  want(
    await api.owner("POST", `/v1/owner/items/${booking.view.item.id}/replies`, {
      body: "Parking is free behind the school.",
      written_by: "person",
      idempotency_key: `update-test-booking-reply-${run}`,
    }),
    200,
    "the owner's reply on the booking",
  );
  want(
    await api.customer("POST", "/v1/messages", {
      idempotency_key: `update-test-message-2-${run}`,
      item_id: message.view.item.id,
      access_token: message.accessToken,
      body: "Thank you, we will take one XS.",
    }),
    201,
    "the customer's answer",
  );

  // The receipts the confirmed booking and the accepted order earn, signed by the inbox's job runner.
  const records = {
    base,
    date,
    business: { name: profile.name },
    service: { id: service.id },
    product: { id: product.id },
    booking: { id: booking.view.item.id, token: booking.accessToken },
    order: { id: order.view.item.id, token: order.accessToken },
    message: { id: message.view.item.id, token: message.accessToken },
  };
  const status = want(await api.owner("GET", "/v1/owner/receipts"), 200, "the receipts' status");
  if (!status.ready) throw new Error(`this inbox issues no receipts: ${status.reason}`);
  for (const name of ["booking", "order"]) {
    let receipts = [];
    for (let i = 0; i < 60 && receipts.length === 0; i++) {
      receipts = want(await api.owner("GET", `/v1/owner/items/${records[name].id}`), 200, name).receipts ?? [];
      if (receipts.length === 0) await sleep(2000);
    }
    if (receipts.length === 0) throw new Error(`the ${name} got no receipt within two minutes`);
    records[name].receipts = receipts.length;
  }
  // The event stream trails live by a few seconds (EVENT_SETTLE_MS), so a read-back made at once
  // would not see the last events yet.
  await sleep(6000);
  writeFileSync(out, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  for (const name of ["booking", "order", "message"]) console.log(`${name} ${records[name].id}`);
}

/** The object less the words around its data. */
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !PRESENTATION.has(k) && !VOLATILE.has(k))
        .map(([k, v]) => [k, strip(v)]),
    );
  }
  return value;
}

/** Every page of a listing that pages with next_cursor. */
async function all(api, path, field) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const page = want(
      await api.owner("GET", `${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ""}`),
      200,
      path,
    );
    out.push(...page[field]);
    cursor = page.next_cursor ?? null;
    if (!cursor) return out;
  }
  throw new Error(`${path} kept paging`);
}

async function read(base, keyFile, recordsFile, out) {
  const api = client(base, keyFile);
  const records = JSON.parse(readFileSync(recordsFile, "utf8"));
  const snapshot = {
    health: want(await api.customer("GET", "/healthz"), 200, "/healthz"),
    profile: want(await api.owner("GET", "/v1/owner/profile"), 200, "the profile"),
    services: want(await api.owner("GET", "/v1/owner/services"), 200, "the services").items,
    products: want(await api.owner("GET", "/v1/owner/products"), 200, "the products").items,
    availability: want(await api.owner("GET", "/v1/owner/availability"), 200, "the opening hours"),
    items: await all(api, "/v1/owner/items?limit=100", "items"),
    events: await all(api, "/v1/owner/events?limit=100", "events"),
    receipts: want(await api.owner("GET", "/v1/owner/receipts"), 200, "the receipts' status"),
    keys: want(await api.owner("GET", "/v1/owner/api-keys"), 200, "the keys").items,
    records: {},
  };
  for (const name of ["booking", "order", "message"]) {
    const { id, token } = records[name];
    const owner = want(await api.owner("GET", `/v1/owner/items/${id}`), 200, `the ${name}, as the owner sees it`);
    const customer = want(
      await api.customer("GET", `/v1/items/${id}`, undefined, token),
      200,
      `the ${name}, as its customer sees it`,
    );
    snapshot.records[name] = { owner, customer };
  }
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  const r = snapshot.records;
  console.log(
    `${snapshot.health.version}: ${snapshot.items.length} items, ${snapshot.events.length} events, ` +
      `booking ${r.booking.owner.item.state}, order ${r.order.owner.item.state}, message ${r.message.owner.item.state}`,
  );
}

/** JSON with its keys in order, for a checksum that does not depend on key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha = (value) => createHash("sha256").update(canonical(value)).digest("hex");

/** `after` cut to the fields `before` has: what a checksum of the same record compares. */
function shaped(before, after) {
  if (Array.isArray(before)) {
    return Array.isArray(after) ? after.map((a, i) => (i < before.length ? shaped(before[i], a) : a)) : after;
  }
  if (before && typeof before === "object") {
    if (!after || typeof after !== "object" || Array.isArray(after)) return after;
    return Object.fromEntries(
      Object.keys(before).map((k) => [k, k in after ? shaped(before[k], after[k]) : undefined]),
    );
  }
  return after;
}

/** The differences between two values: fields changed or gone (problems), and fields added (news). */
function differences(before, after, path, problems, added) {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return problems.push(`${path}: was a list, now ${JSON.stringify(after)}`);
    if (after.length !== before.length) problems.push(`${path}: ${before.length} entries, now ${after.length}`);
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      differences(before[i], after[i], `${path}[${i}]`, problems, added);
    }
    return;
  }
  if (before && typeof before === "object") {
    if (!after || typeof after !== "object" || Array.isArray(after)) {
      return problems.push(`${path}: was an object, now ${JSON.stringify(after)}`);
    }
    for (const k of Object.keys(before)) {
      if (!(k in after)) problems.push(`${path}.${k}: gone (was ${JSON.stringify(before[k]).slice(0, 200)})`);
      else differences(before[k], after[k], `${path}.${k}`, problems, added);
    }
    for (const k of Object.keys(after)) if (!(k in before)) added.add(`${path.replace(/\[\d+\]/g, "[]")}.${k}`);
    return;
  }
  if (before !== after) problems.push(`${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
}

const money = (m) => (m && typeof m.value === "number" ? `${(m.value / 100).toFixed(2)} ${m.currency}` : "");

function compare(beforeFile, afterFile, reportFile) {
  const load = (f) => strip(JSON.parse(readFileSync(f, "utf8")));
  const before = load(beforeFile);
  const after = load(afterFile);
  delete before.health;
  delete after.health;
  const rows = [];
  const problems = [];
  const added = new Set();
  const check = (label, b, a, summary) => {
    const p = [];
    differences(b, a, label, p, added);
    problems.push(...p);
    rows.push({ label, summary, before: sha(b), after: sha(shaped(b, a)), ok: p.length === 0 });
  };
  for (const name of ["booking", "order", "message"]) {
    const b = before.records[name];
    const a = after.records[name];
    const item = b.owner.item;
    const summary = [
      item.id,
      item.state,
      money(item.payload?.totalPrice),
      b.owner.party?.name ?? "",
      `${b.owner.events.length} events`,
      `${b.owner.thread?.length ?? 0} in the thread`,
      `${b.owner.receipts.length} receipts`,
    ]
      .filter(Boolean)
      .join(" · ");
    check(`${name} (owner)`, b.owner, a.owner, summary);
    check(
      `${name} (customer)`,
      b.customer,
      a.customer,
      `${b.customer.reference} · ${b.customer.thread.length} in the thread`,
    );
  }
  check("profile", before.profile, after.profile, before.profile.name);
  check("services", before.services, after.services, `${before.services.length}`);
  check("products", before.products, after.products, `${before.products.length}`);
  check("opening hours", before.availability, after.availability, before.availability.timezone);
  check("item list", before.items, after.items, `${before.items.length} items`);
  check("event stream", before.events, after.events, `${before.events.length} events`);
  check("receipts", before.receipts, after.receipts, `${before.receipts.issued} issued`);
  check("owner keys", before.keys, after.keys, `${before.keys.length}`);

  const lines = [
    "| Record | What it holds | sha256 before | sha256 after | |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.summary} | \`${r.before.slice(0, 12)}\` | \`${r.after.slice(0, 12)}\` | ${r.ok ? "✓" : "✗"} |`,
    ),
  ];
  if (problems.length) lines.push("", "**Changed or gone:**", "", ...problems.slice(0, 100).map((p) => `- \`${p}\``));
  if (added.size)
    lines.push("", `Fields the new version adds (not counted against it): ${[...added].sort().join(", ")}`);
  const report = `${lines.join("\n")}\n`;
  if (reportFile) writeFileSync(reportFile, report);
  console.log(report);
  if (problems.length) {
    console.error(`${problems.length} differences: the data did not read back identical.`);
    process.exit(1);
  }
  console.log(`Every record read back identical (${rows.length} checked).`);
}

try {
  if (command === "seed" && args.length === 3) await seed(...args);
  else if (command === "read" && args.length === 4) await read(...args);
  else if (command === "compare" && (args.length === 2 || args.length === 3)) compare(...args);
  else {
    console.error("usage: update-data.mjs seed <base> <key file> <records.json>");
    console.error("       update-data.mjs read <base> <key file> <records.json> <snapshot.json>");
    console.error("       update-data.mjs compare <before.json> <after.json> [report.md]");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
