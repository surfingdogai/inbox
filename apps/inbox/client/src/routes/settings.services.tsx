import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { Plus } from "lucide-react";
import { useState } from "react";
import { describeService, ProductEditor, ServiceEditor } from "../components/Catalogue";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { problemOf } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useProducts, useProductWrite, useProfile, useServices, useServiceWrite } from "../lib/queries";
import type { ProductRow, ServiceRow } from "../lib/types";

export const Route = createFileRoute("/settings/services")({
  component: ServicesPage,
});

type Editing = "new" | string | null;

/** What the business offers: bookable services (duration, buffers, capacity, price) and products. */
function ServicesPage() {
  const profile = useProfile();
  const currency = profile.data?.currency ?? "EUR";
  return (
    <>
      <ServicesCard currency={currency} />
      <ProductsCard currency={currency} />
    </>
  );
}

function ServicesCard({ currency }: { currency: string }) {
  const services = useServices();
  const write = useServiceWrite();
  const [editing, setEditing] = useState<Editing>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = services.data?.items ?? [];
  const problem = write.error ? problemOf(write.error) : null;
  const done = (text: string) => {
    setEditing(null);
    setConfirm(null);
    setNotice(text);
  };
  const open = (next: Editing) => {
    write.reset();
    setNotice(null);
    setEditing(next);
  };

  return (
    <section className="card glass stack">
      <SectionHead title="Services">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => open("new")}>
          <Plus className="icon" aria-hidden="true" />
          New service
        </button>
      </SectionHead>
      <p className="lede small">
        What people and agents can book. Duration and buffers shape the free slots; capacity is how many bookings share
        one.
      </p>
      {notice && <Toast tone="success" text={notice} onDismiss={() => setNotice(null)} />}
      {services.isPending && <div className="skeleton sk-line" />}
      {services.isError && (
        <ErrorState
          title="Could not load the services"
          text={problemOf(services.error).detail}
          onRetry={() => void services.refetch()}
        />
      )}
      {services.isSuccess && rows.length === 0 && editing !== "new" && (
        <div className="state">
          <h3>No services yet</h3>
          <p>Add the first thing people can book, like a 60-minute consultation.</p>
        </div>
      )}
      {editing === "new" && (
        <ServiceEditor
          initial={undefined}
          currency={currency}
          pending={write.isPending}
          error={problem}
          onSubmit={(body) => write.mutate({ body }, { onSuccess: () => done("Service added.") })}
          onCancel={() => setEditing(null)}
        />
      )}
      <div className="stack">
        {rows.map((s) => (
          <ServiceLine
            key={s.id}
            service={s}
            editing={editing === s.id}
            confirming={confirm === s.id}
            currency={currency}
            pending={write.isPending}
            error={editing === s.id || confirm === s.id ? problem : null}
            onEdit={() => open(s.id)}
            onCancel={() => setEditing(null)}
            onSave={(body) => write.mutate({ id: s.id, body }, { onSuccess: () => done("Service saved.") })}
            onAskArchive={() => {
              write.reset();
              setConfirm(s.id);
            }}
            onArchive={() =>
              write.mutate(
                { id: s.id, archive: true },
                { onSuccess: () => done(`${s.name} archived; it no longer takes bookings.`) },
              )
            }
            onRestore={() =>
              write.mutate(
                { id: s.id, body: { active: true } },
                { onSuccess: () => done(`${s.name} is bookable again.`) },
              )
            }
            onKeep={() => setConfirm(null)}
          />
        ))}
      </div>
    </section>
  );
}

function ServiceLine({
  service: s,
  editing,
  confirming,
  currency,
  pending,
  error,
  onEdit,
  onCancel,
  onSave,
  onAskArchive,
  onArchive,
  onRestore,
  onKeep,
}: {
  service: ServiceRow;
  editing: boolean;
  confirming: boolean;
  currency: string;
  pending: boolean;
  error: ReturnType<typeof problemOf> | null;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Parameters<typeof ServiceEditor>[0]["onSubmit"] extends (b: infer B) => void ? B : never) => void;
  onAskArchive: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onKeep: () => void;
}) {
  const archived = s.active !== 1;
  return (
    <div className={clsx("catalogue-row row-glass", archived && "is-archived")}>
      <div className="catalogue-main">
        <div className="t">
          <b>{s.name}</b>
          {archived && <span className="pill pill-xs">Archived</span>}
        </div>
        <div className="s">{describeService(s)}</div>
        {s.description && <div className="s">{s.description}</div>}
      </div>
      <div className="rowx">
        {!archived && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit} aria-expanded={editing}>
            Edit
          </button>
        )}
        {archived ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRestore} disabled={pending}>
            Make bookable
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onAskArchive} aria-expanded={confirming}>
            Archive
          </button>
        )}
      </div>
      {editing && (
        <div className="wide">
          <ServiceEditor
            initial={s}
            currency={currency}
            pending={pending}
            error={error}
            onSubmit={onSave}
            onCancel={onCancel}
          />
        </div>
      )}
      {confirming && (
        <div className="confirm row-glass wide">
          <h3>Archive {s.name}</h3>
          <p className="hint">It stops taking bookings and leaves the public list; existing bookings keep it.</p>
          {error && (
            <p className="hint error" role="alert">
              {error.detail}
            </p>
          )}
          <div className="rowx">
            <button type="button" className="btn btn-danger" onClick={onArchive} disabled={pending}>
              Archive service
            </button>
            <button type="button" className="btn btn-ghost" onClick={onKeep} disabled={pending}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProductsCard({ currency }: { currency: string }) {
  const products = useProducts();
  const write = useProductWrite();
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = products.data?.items ?? [];
  const problem = write.error ? problemOf(write.error) : null;
  const done = (text: string) => {
    setEditing(null);
    setNotice(text);
  };
  const open = (next: Editing) => {
    write.reset();
    setNotice(null);
    setEditing(next);
  };
  return (
    <section className="card glass stack">
      <SectionHead title="Products">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => open("new")}>
          <Plus className="icon" aria-hidden="true" />
          New product
        </button>
      </SectionHead>
      <p className="lede small">What agents can order. Prices are in {currency}; stock is optional.</p>
      {notice && <Toast tone="success" text={notice} onDismiss={() => setNotice(null)} />}
      {products.isPending && <div className="skeleton sk-line" />}
      {products.isError && (
        <ErrorState
          title="Could not load the products"
          text={problemOf(products.error).detail}
          onRetry={() => void products.refetch()}
        />
      )}
      {products.isSuccess && rows.length === 0 && editing !== "new" && (
        <div className="state">
          <h3>No products yet</h3>
          <p>Add what you sell, or leave this empty if you only take bookings and quotes.</p>
        </div>
      )}
      {editing === "new" && (
        <ProductEditor
          initial={undefined}
          currency={currency}
          pending={write.isPending}
          error={problem}
          onSubmit={(body) => write.mutate({ body }, { onSuccess: () => done("Product added.") })}
          onCancel={() => setEditing(null)}
        />
      )}
      <div className="stack">
        {rows.map((p) => (
          <ProductLine
            key={p.id}
            product={p}
            editing={editing === p.id}
            currency={currency}
            pending={write.isPending}
            error={editing === p.id ? problem : null}
            onEdit={() => open(p.id)}
            onCancel={() => setEditing(null)}
            onSave={(body) => write.mutate({ id: p.id, body }, { onSuccess: () => done("Product saved.") })}
            onArchive={() =>
              write.mutate({ id: p.id, archive: true }, { onSuccess: () => done(`${p.name} is no longer for sale.`) })
            }
            onRestore={() =>
              write.mutate(
                { id: p.id, body: { active: true } },
                { onSuccess: () => done(`${p.name} is for sale again.`) },
              )
            }
          />
        ))}
      </div>
    </section>
  );
}

function ProductLine({
  product: p,
  editing,
  currency,
  pending,
  error,
  onEdit,
  onCancel,
  onSave,
  onArchive,
  onRestore,
}: {
  product: ProductRow;
  editing: boolean;
  currency: string;
  pending: boolean;
  error: ReturnType<typeof problemOf> | null;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Parameters<typeof ProductEditor>[0]["onSubmit"] extends (b: infer B) => void ? B : never) => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const archived = p.active !== 1;
  const meta = [p.sku, formatMoney(p.price), p.stock === null ? "stock not tracked" : `${p.stock} in stock`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={clsx("catalogue-row row-glass", archived && "is-archived")}>
      <div className="catalogue-main">
        <div className="t">
          <b>{p.name}</b>
          {archived && <span className="pill pill-xs">Not for sale</span>}
        </div>
        <div className="s">{meta}</div>
      </div>
      <div className="rowx">
        {!archived && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit} aria-expanded={editing}>
            Edit
          </button>
        )}
        {archived ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRestore} disabled={pending}>
            Put on sale
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive} disabled={pending}>
            Take off sale
          </button>
        )}
      </div>
      {editing && (
        <div className="wide">
          <ProductEditor
            initial={p}
            currency={currency}
            pending={pending}
            error={error}
            onSubmit={onSave}
            onCancel={onCancel}
          />
        </div>
      )}
    </div>
  );
}
