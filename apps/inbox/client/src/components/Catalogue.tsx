import { ChevronRight } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { parseMajor } from "../lib/actions";
import type { ApiProblem } from "../lib/api";
import { type ListingDraft, productListingBody, type ServiceDraft, serviceDraft, serviceWrite } from "../lib/catalogue";
import type { ProductBody, ProductNote, ProductRow, ServiceBody, ServiceRow } from "../lib/types";
import { LengthPicker, MoneyInput, Stepper } from "./Choosers";
import { Field, FormActions, Switch } from "./Form";

/** A lowest price as typed: minor units, null for none, undefined when it is not a price. */
function floorOf(typed: string): number | null | undefined {
  return typed.trim() === "" ? null : parseMajor(typed);
}

const majorOf = (minor: number | null | undefined) =>
  minor === null || minor === undefined ? "" : (minor / 100).toFixed(2);

/** Minutes to pick from, with the stored value in its place when it is another. */
const withMinutes = (steps: readonly number[], keep: string) => {
  const n = Number(keep);
  return Number.isInteger(n) && !steps.includes(n) ? [...steps, n].sort((a, b) => a - b) : steps;
};
const SLOT_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const BUFFERS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];

/** Two or three choices in a row, one press each (a radio group underneath, so arrows move between them). */
function Choice<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="chips-field">
      <legend className="label">{legend}</legend>
      <div className="chips" role="radiogroup">
        {options.map((o) => (
          <label key={o.value} className="chip">
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** "More options" folded, "Fewer options" open, with the chevron that turns. */
export function MoreOptions({ children }: { children: ReactNode }) {
  return (
    <details className="details more">
      <summary className="disclosure">
        <ChevronRight className="icon-sm disclosure-icon" aria-hidden="true" />
        <span className="disclosure-open">Fewer options</span>
        <span className="disclosure-closed">More options</span>
      </summary>
      {children}
    </details>
  );
}

/**
 * A service: its name, whether it is booked or asked about, its length from the usual ones, and a
 * price in the business's currency, or none ("on request"). The rest — exact or starting at, per
 * person, the lowest price, buffers, how often slots start, bookings per slot — is under More
 * options. Its place in lists is set in the list itself, by moving it up or down.
 */
export function ServiceEditor({
  initial,
  prefill,
  floor,
  currency,
  priceCounters,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: ServiceRow | undefined;
  /** A new service started from a suggestion: its name. */
  prefill?: { readonly name: string } | undefined;
  /** Its lowest price now, in minor units. */
  floor?: number | null | undefined;
  currency: string;
  /** Whether customers may suggest a price of their own at all (General): only then is it asked per service. */
  priceCounters: boolean;
  pending: boolean;
  error: ApiProblem | null;
  /** The row's fields, and its lowest price when the owner changed it (null clears it). */
  onSubmit: (body: ServiceBody, floor?: number | null) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<ServiceDraft>(() => ({
    ...serviceDraft(initial, floor),
    ...(prefill && !initial ? { name: prefill.name } : {}),
  }));
  const [local, setLocal] = useState<string | null>(null);
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) => setF((d) => ({ ...d, [key]: value }));
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const out = serviceWrite(f, { currency, isNew: !initial, floor });
    if ("problem" in out) return setLocal(out.problem);
    setLocal(null);
    onSubmit(out.body, out.floor);
  };
  const err = (path: string) => error?.field(path);
  const book = f.taken === "book";
  const priced = book && f.price.trim() !== "";
  return (
    <form className="confirm row-glass stack" onSubmit={submit}>
      <h3>{initial ? `Edit ${initial.name}` : "New service"}</h3>
      <div className="settings-grid">
        <Field id={`${id}-name`} label="Name" error={err("name")}>
          <input
            id={`${id}-name`}
            className="input"
            value={f.name}
            placeholder="Haircut"
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Choice
          legend="Agents can"
          value={f.taken}
          options={[
            { value: "book", label: "Book a time" },
            { value: "ask", label: "Ask for a price" },
          ]}
          onChange={(v) => set("taken", v)}
        />
        {book && (
          <div className="wide">
            <LengthPicker
              legend="Length"
              value={f.duration}
              onChange={(v) => set("duration", v)}
              error={err("duration_min")}
            />
          </div>
        )}
        {book && (
          <Field
            id={`${id}-price`}
            label="Price"
            optional
            error={err("price.value") ?? err("price")}
            hint={priced ? undefined : "Empty: on request."}
          >
            <MoneyInput
              id={`${id}-price`}
              currency={currency}
              placeholder="On request"
              value={f.price}
              onChange={(v) => set("price", v)}
            />
          </Field>
        )}
        <Field id={`${id}-desc`} label="Description" optional error={err("description")}>
          <input
            id={`${id}-desc`}
            className="input"
            value={f.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <div className="wide">
          <Switch checked={f.active} onChange={(v) => set("active", v)}>
            On offer
          </Switch>
        </div>
      </div>
      <MoreOptions>
        <div className="settings-grid">
          {priced && (
            <Choice
              legend="The price is"
              value={f.model}
              options={[
                { value: "fixed", label: "Exact" },
                { value: "from", label: "Starting at" },
              ]}
              onChange={(v) => set("model", v)}
            />
          )}
          {priced && (
            <Choice
              legend="For"
              value={f.per}
              options={[
                { value: "booking", label: "The booking" },
                { value: "person", label: "Each person" },
              ]}
              onChange={(v) => set("per", v)}
            />
          )}
          {priced && f.model === "fixed" && (
            <Field
              id={`${id}-floor`}
              label="Lowest price"
              optional
              error={err("floors.0.floor_minor")}
              hint="Your AI and rules never go under it, and never learn it."
            >
              <MoneyInput id={`${id}-floor`} currency={currency} value={f.floor} onChange={(v) => set("floor", v)} />
            </Field>
          )}
          {book && (
            <Field id={`${id}-gran`} label="Slots start every" error={err("granularity_min")}>
              <select
                id={`${id}-gran`}
                className="input"
                value={f.granularity}
                onChange={(e) => set("granularity", e.target.value)}
              >
                {withMinutes(SLOT_STEPS, f.granularity).map((m) => (
                  <option key={m} value={String(m)}>
                    {m} min
                  </option>
                ))}
              </select>
            </Field>
          )}
          {book && (
            <Field id={`${id}-before`} label="Free before" error={err("buffer_before_min")}>
              <select
                id={`${id}-before`}
                className="input"
                value={f.before}
                onChange={(e) => set("before", e.target.value)}
              >
                {withMinutes(BUFFERS, f.before).map((m) => (
                  <option key={m} value={String(m)}>
                    {m ? `${m} min` : "None"}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {book && (
            <Field id={`${id}-after`} label="Free after" error={err("buffer_after_min")}>
              <select
                id={`${id}-after`}
                className="input"
                value={f.after}
                onChange={(e) => set("after", e.target.value)}
              >
                {withMinutes(BUFFERS, f.after).map((m) => (
                  <option key={m} value={String(m)}>
                    {m ? `${m} min` : "None"}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {book && (
            <Stepper
              id={`${id}-capacity`}
              label="Bookings per slot"
              min={1}
              max={100}
              value={f.capacity}
              onChange={(v) => set("capacity", v)}
              error={err("capacity")}
            />
          )}
          {priceCounters && (
            <div className="wide">
              <Switch checked={f.negotiable} onChange={(v) => set("negotiable", v)}>
                Customers may suggest a price for it
              </Switch>
            </div>
          )}
        </div>
      </MoreOptions>
      {(local || (error && !error.fields?.length)) && (
        <p className="hint error" role="alert">
          {local ?? error?.detail}
        </p>
      )}
      <FormActions>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          {initial ? "Keep as is" : "Cancel"}
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {initial ? "Save service" : "Add service"}
        </button>
      </FormActions>
    </form>
  );
}

interface ProductDraft extends ListingDraft {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly price: string;
  readonly stock: string;
  readonly active: boolean;
  readonly negotiable: boolean;
  readonly floor: string;
}

const CONDITIONS = [
  { value: "new", label: "New" },
  { value: "used", label: "Used" },
  { value: "refurbished", label: "Refurbished" },
] as const;

const conditionOf = (c: string | undefined): ListingDraft["condition"] =>
  c === "used" || c === "refurbished" ? c : "new";

/** A barcode as it is printed: the shortest of 8, 12, 13 or 14 digits. */
const printed = (gtin14: string) =>
  gtin14.startsWith("000000") ? gtin14.slice(6) : gtin14.startsWith("00") ? gtin14.slice(2) : gtin14.replace(/^0/, "");

/**
 * What needs a look on one product (ADR-029), in plain words, with the one tap that fixes it where
 * there is one: using a barcode the owner's AI proposed.
 */
export function ProductNotes({
  notes,
  pending,
  onConfirmBarcode,
}: {
  notes: readonly ProductNote[];
  pending: boolean;
  onConfirmBarcode: () => void;
}) {
  if (notes.length === 0) return null;
  return (
    <ul className="hint product-notes">
      {notes.map((n) => (
        <li key={`${n.code}:${n.words}`}>
          {n.words}
          {n.action === "confirm_barcode" && (
            <>
              {" "}
              <button type="button" className="btn btn-ghost btn-sm" onClick={onConfirmBarcode} disabled={pending}>
                Use it
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ProductEditor({
  initial,
  floor,
  currency,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: ProductRow | undefined;
  /** Its lowest price now, in minor units, per unit. */
  floor?: number | null | undefined;
  currency: string;
  pending: boolean;
  error: ApiProblem | null;
  /** The row's fields, and its lowest price when the owner changed it (null clears it). */
  onSubmit: (body: ProductBody, floor?: number | null) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<ProductDraft>({
    sku: initial?.sku ?? "",
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    price: initial ? (initial.price.value / 100).toFixed(2) : "",
    stock: initial?.stock === null || initial?.stock === undefined ? "" : String(initial.stock),
    active: initial ? initial.active === 1 : true,
    negotiable: initial ? initial.negotiable !== 0 : true,
    floor: majorOf(floor),
    brand: initial?.brand ?? "",
    mpn: initial?.mpn ?? "",
    condition: conditionOf(initial?.condition),
    url: initial?.url ?? "",
    imageUrl: initial?.imageUrl ?? "",
    keptOff: initial?.listed === 0,
    noGtin: initial?.noGtin === 1,
  });
  const [local, setLocal] = useState<string | null>(null);
  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => setF((d) => ({ ...d, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!f.name.trim()) return setLocal("Give the product a name.");
    const value = parseMajor(f.price);
    if (value === undefined) return setLocal("Write the price like 39.20.");
    const stock = f.stock.trim() === "" ? null : Number(f.stock);
    if (stock !== null && (!Number.isInteger(stock) || stock < 0))
      return setLocal("Stock is a whole number, or empty when not tracked.");
    const lowest = floorOf(f.floor);
    if (lowest === undefined) return setLocal("Write the lowest price like 30, or leave it empty.");
    setLocal(null);
    onSubmit(
      {
        ...(f.sku.trim() ? { sku: f.sku.trim() } : {}),
        name: f.name.trim(),
        description: f.description.trim(),
        price: { value, currency: initial?.price.currency ?? currency },
        stock,
        active: f.active,
        negotiable: f.negotiable,
        ...productListingBody(f),
      },
      lowest !== (floor ?? null) ? lowest : undefined,
    );
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
        <Field id="pr-price" label="Price" error={err("price.value") ?? err("price.currency")}>
          <MoneyInput
            id="pr-price"
            currency={initial?.price.currency ?? currency}
            value={f.price}
            onChange={(v) => set("price", v)}
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
        <Field
          id="pr-floor"
          label="Lowest price"
          optional
          error={err("floors.0.floor_minor")}
          hint="Per unit. Your AI and rules never go under it, and never learn it."
        >
          <MoneyInput
            id="pr-floor"
            currency={initial?.price.currency ?? currency}
            value={f.floor}
            onChange={(v) => set("floor", v)}
          />
        </Field>
        <div className="wide">
          <Switch checked={f.active} onChange={(v) => set("active", v)}>
            For sale
          </Switch>
        </div>
        <div className="wide">
          <Switch checked={f.negotiable} onChange={(v) => set("negotiable", v)}>
            Customers may suggest a price for it
          </Switch>
          <div className="hint">Only while you take customers' own prices (Settings). Off, one goes to you.</div>
        </div>
      </div>
      <MoreOptions>
        <div className="settings-grid">
          <div className="wide">
            <div className="label">Barcode</div>
            <div className="hint">
              {initial?.gtin
                ? printed(initial.gtin)
                : f.noGtin
                  ? "It has none."
                  : "None yet. It comes from your shop's import, or your AI can propose one for you to confirm."}
            </div>
            {!initial?.gtin && (
              <Switch checked={f.noGtin} onChange={(v) => set("noGtin", v)}>
                It has no barcode
              </Switch>
            )}
          </div>
          <Field id="pr-brand" label="Brand" optional error={err("brand")} hint="Who makes it, as on the pack.">
            <input id="pr-brand" className="input" value={f.brand} onChange={(e) => set("brand", e.target.value)} />
          </Field>
          <Field id="pr-mpn" label="Part number" optional error={err("mpn")} hint="The maker's, as on the pack.">
            <input
              id="pr-mpn"
              className="input"
              spellCheck={false}
              value={f.mpn}
              onChange={(e) => set("mpn", e.target.value)}
            />
          </Field>
          <div className="wide">
            <Choice legend="Condition" value={f.condition} options={CONDITIONS} onChange={(v) => set("condition", v)} />
          </div>
          <Field
            id="pr-url"
            label="Its page"
            optional
            error={err("url")}
            hint="On your own site. Networks are given it only when it is."
          >
            <input
              id="pr-url"
              className="input"
              type="url"
              inputMode="url"
              placeholder="https://"
              value={f.url}
              onChange={(e) => set("url", e.target.value)}
            />
          </Field>
          <Field
            id="pr-image"
            label="Picture link"
            optional
            error={err("image_url")}
            hint="A link; it is never copied."
          >
            <input
              id="pr-image"
              className="input"
              type="url"
              inputMode="url"
              placeholder="https://"
              value={f.imageUrl}
              onChange={(e) => set("imageUrl", e.target.value)}
            />
          </Field>
          <div className="wide">
            <Switch checked={f.keptOff} onChange={(v) => set("keptOff", v)}>
              Keep it off networks
            </Switch>
            <div className="hint">It stays on sale at your own doors.</div>
          </div>
        </div>
      </MoreOptions>
      {(local || (error && !error.fields?.length)) && (
        <p className="hint error" role="alert">
          {local ?? error?.detail}
        </p>
      )}
      <FormActions>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          {initial ? "Keep as is" : "Cancel"}
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {initial ? "Save product" : "Add product"}
        </button>
      </FormActions>
    </form>
  );
}
