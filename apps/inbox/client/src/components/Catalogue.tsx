import { type FormEvent, useState } from "react";
import type { ApiProblem } from "../lib/api";
import { formatMoney } from "../lib/format";
import type { PriceModel, ProductBody, ProductRow, ServiceBody, ServiceRow } from "../lib/types";
import { Field, Switch } from "./Form";

/** How a service reads in a list: "90 min · 15 min after · 1 at a time · every 30 min · €45.00". */
export function describeService(s: ServiceRow): string {
  const parts = [`${s.durationMin} min`];
  if (s.bufferBeforeMin) parts.push(`${s.bufferBeforeMin} min before`);
  if (s.bufferAfterMin) parts.push(`${s.bufferAfterMin} min after`);
  parts.push(s.capacity === 1 ? "one at a time" : `${s.capacity} at a time`);
  parts.push(`every ${s.granularityMin} min`);
  parts.push(describePrice(s));
  return parts.join(" · ");
}

export function describePrice(s: ServiceRow): string {
  const p = s.price;
  if (!p) return "no price";
  if (p.model === "quote") return "priced by quote";
  const money = p.value !== undefined ? formatMoney({ value: p.value, currency: p.currency ?? "EUR" }) : "";
  return p.model === "from" ? `from ${money}` : money;
}

interface ServiceDraft {
  readonly name: string;
  readonly description: string;
  readonly duration: string;
  readonly before: string;
  readonly after: string;
  readonly capacity: string;
  readonly granularity: string;
  readonly model: PriceModel;
  readonly price: string;
  readonly sort: string;
  readonly active: boolean;
}

function serviceDraft(s: ServiceRow | undefined): ServiceDraft {
  return {
    name: s?.name ?? "",
    description: s?.description ?? "",
    duration: String(s?.durationMin ?? 60),
    before: String(s?.bufferBeforeMin ?? 0),
    after: String(s?.bufferAfterMin ?? 0),
    capacity: String(s?.capacity ?? 1),
    granularity: String(s?.granularityMin ?? 15),
    model: s?.price?.model ?? "fixed",
    price: s?.price?.value !== undefined ? (s.price.value / 100).toFixed(2) : "",
    sort: String(s?.sort ?? 0),
    active: s ? s.active === 1 : true,
  };
}

const int = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

export function ServiceEditor({
  initial,
  currency,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: ServiceRow | undefined;
  currency: string;
  pending: boolean;
  error: ApiProblem | null;
  onSubmit: (body: ServiceBody) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<ServiceDraft>(() => serviceDraft(initial));
  const [local, setLocal] = useState<string | null>(null);
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) => setF((d) => ({ ...d, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!f.name.trim()) return setLocal("Give the service a name.");
    const value = f.price.trim() ? Math.round(Number(f.price.replace(",", ".")) * 100) : undefined;
    if (f.model !== "quote" && (value === undefined || !Number.isFinite(value) || value < 0)) {
      return setLocal("Give a price, like 45 or 45.90, or choose priced by quote.");
    }
    setLocal(null);
    onSubmit({
      name: f.name.trim(),
      description: f.description.trim(),
      duration_min: int(f.duration),
      buffer_before_min: int(f.before),
      buffer_after_min: int(f.after),
      capacity: int(f.capacity),
      granularity_min: int(f.granularity),
      price: f.model === "quote" ? { model: "quote" } : { model: f.model, value: value ?? 0, currency },
      sort: int(f.sort),
      active: f.active,
    });
  };
  const err = (path: string) => error?.field(path);
  return (
    <form className="confirm row-glass" onSubmit={submit}>
      <h3>{initial ? `Edit ${initial.name}` : "New service"}</h3>
      <div className="settings-grid">
        <Field id="sv-name" label="Name" error={err("name")}>
          <input id="sv-name" className="input" value={f.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field id="sv-desc" label="Description" optional error={err("description")}>
          <input
            id="sv-desc"
            className="input"
            value={f.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <Field id="sv-duration" label="Duration (minutes)" error={err("duration_min")}>
          <input
            id="sv-duration"
            className="input"
            type="number"
            min={5}
            max={1440}
            value={f.duration}
            onChange={(e) => set("duration", e.target.value)}
          />
        </Field>
        <Field id="sv-gran" label="Slots start every (minutes)" error={err("granularity_min")}>
          <input
            id="sv-gran"
            className="input"
            type="number"
            min={5}
            max={240}
            value={f.granularity}
            onChange={(e) => set("granularity", e.target.value)}
          />
        </Field>
        <Field id="sv-before" label="Buffer before (minutes)" error={err("buffer_before_min")}>
          <input
            id="sv-before"
            className="input"
            type="number"
            min={0}
            max={240}
            value={f.before}
            onChange={(e) => set("before", e.target.value)}
          />
        </Field>
        <Field id="sv-after" label="Buffer after (minutes)" error={err("buffer_after_min")}>
          <input
            id="sv-after"
            className="input"
            type="number"
            min={0}
            max={240}
            value={f.after}
            onChange={(e) => set("after", e.target.value)}
          />
        </Field>
        <Field
          id="sv-capacity"
          label="At the same time"
          error={err("capacity")}
          hint="How many bookings can share one slot."
        >
          <input
            id="sv-capacity"
            className="input"
            type="number"
            min={1}
            max={100}
            value={f.capacity}
            onChange={(e) => set("capacity", e.target.value)}
          />
        </Field>
        <Field id="sv-sort" label="Order in lists" error={err("sort")}>
          <input
            id="sv-sort"
            className="input"
            type="number"
            min={0}
            value={f.sort}
            onChange={(e) => set("sort", e.target.value)}
          />
        </Field>
        <Field id="sv-model" label="Price" error={err("price")}>
          <select
            id="sv-model"
            className="input"
            value={f.model}
            onChange={(e) => set("model", e.target.value as PriceModel)}
          >
            <option value="fixed">A fixed price</option>
            <option value="from">Starting at</option>
            <option value="quote">Priced by quote</option>
          </select>
        </Field>
        {f.model !== "quote" && (
          <Field id="sv-price" label={`Amount (${currency})`} error={err("price.value")}>
            <input
              id="sv-price"
              className="input"
              inputMode="decimal"
              value={f.price}
              onChange={(e) => set("price", e.target.value)}
            />
          </Field>
        )}
        <div className="wide">
          <Switch checked={f.active} onChange={(v) => set("active", v)}>
            Bookable
          </Switch>
        </div>
      </div>
      {(local || (error && !error.fields?.length)) && (
        <p className="hint error" role="alert">
          {local ?? error?.detail}
        </p>
      )}
      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {initial ? "Save service" : "Add service"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Keep as is
        </button>
      </div>
    </form>
  );
}

interface ProductDraft {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly price: string;
  readonly stock: string;
  readonly active: boolean;
}

export function ProductEditor({
  initial,
  currency,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: ProductRow | undefined;
  currency: string;
  pending: boolean;
  error: ApiProblem | null;
  onSubmit: (body: ProductBody) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<ProductDraft>({
    sku: initial?.sku ?? "",
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    price: initial ? (initial.price.value / 100).toFixed(2) : "",
    stock: initial?.stock === null || initial?.stock === undefined ? "" : String(initial.stock),
    active: initial ? initial.active === 1 : true,
  });
  const [local, setLocal] = useState<string | null>(null);
  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => setF((d) => ({ ...d, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!f.name.trim()) return setLocal("Give the product a name.");
    const value = Math.round(Number(f.price.replace(",", ".")) * 100);
    if (!f.price.trim() || !Number.isFinite(value) || value < 0) return setLocal("Give a price, like 39.20.");
    const stock = f.stock.trim() === "" ? null : Number(f.stock);
    if (stock !== null && (!Number.isInteger(stock) || stock < 0))
      return setLocal("Stock is a whole number, or empty when not tracked.");
    setLocal(null);
    onSubmit({
      ...(f.sku.trim() ? { sku: f.sku.trim() } : {}),
      name: f.name.trim(),
      description: f.description.trim(),
      price: { value, currency: initial?.price.currency ?? currency },
      stock,
      active: f.active,
    });
  };
  const err = (path: string) => error?.field(path);
  return (
    <form className="confirm row-glass" onSubmit={submit}>
      <h3>{initial ? `Edit ${initial.name}` : "New product"}</h3>
      <div className="settings-grid">
        <Field id="pr-name" label="Name" error={err("name")}>
          <input id="pr-name" className="input" value={f.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field id="pr-sku" label="SKU" optional error={err("sku")}>
          <input
            id="pr-sku"
            className="input"
            spellCheck={false}
            value={f.sku}
            onChange={(e) => set("sku", e.target.value)}
          />
        </Field>
        <Field id="pr-price" label={`Price (${initial?.price.currency ?? currency})`} error={err("price.value")}>
          <input
            id="pr-price"
            className="input"
            inputMode="decimal"
            value={f.price}
            onChange={(e) => set("price", e.target.value)}
          />
        </Field>
        <Field id="pr-stock" label="Stock" optional error={err("stock")} hint="Empty when you do not track it.">
          <input
            id="pr-stock"
            className="input"
            type="number"
            min={0}
            value={f.stock}
            onChange={(e) => set("stock", e.target.value)}
          />
        </Field>
        <Field id="pr-desc" label="Description" optional error={err("description")}>
          <input
            id="pr-desc"
            className="input"
            value={f.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <div className="wide">
          <Switch checked={f.active} onChange={(v) => set("active", v)}>
            For sale
          </Switch>
        </div>
      </div>
      {(local || (error && !error.fields?.length)) && (
        <p className="hint error" role="alert">
          {local ?? error?.detail}
        </p>
      )}
      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {initial ? "Save product" : "Add product"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Keep as is
        </button>
      </div>
    </form>
  );
}
