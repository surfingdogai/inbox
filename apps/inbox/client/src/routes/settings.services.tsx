import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { Plus } from "lucide-react";
import { useState } from "react";
import { ProductEditor, ServiceEditor } from "../components/Catalogue";
import { SourceTag } from "../components/Choosers";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { problemOf } from "../lib/api";
import { describeService } from "../lib/catalogue";
import { formatMoney } from "../lib/format";
import {
  useFloors,
  useProducts,
  useProductWrite,
  useProfile,
  useSaveSettings,
  useServices,
  useServiceWrite,
  useSettings,
} from "../lib/queries";
import { clearSources, sourceNote } from "../lib/sources";
import type { ProductRow, ServiceRow } from "../lib/types";

export const Route = createFileRoute("/settings/services")({
  component: ServicesPage,
});

type Editing = "new" | string | null;

/** What the business offers: services booked or asked about (length, price), and products. Prices are in the business's currency. */
function ServicesPage() {
  const profile = useProfile();
  if (profile.isError) {
    return (
      <div className="card glass">
        <ErrorState
          title="Could not load the business profile"
          text={problemOf(profile.error).detail}
          onRetry={() => void profile.refetch()}
        />
      </div>
    );
  }
  if (!profile.data) {
    return (
      <div className="card glass" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
      </div>
    );
  }
  const currency = profile.data.currency;
  return (
    <>
      <ServicesCard currency={currency} />
      <ProductsCard currency={currency} />
    </>
  );
}

function ServicesCard({ currency }: { currency: string }) {
  const services = useServices();
  const floors = useFloors();
  const write = useServiceWrite();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const sources = settings.data?.doc.setup.sources;
  const read = sourceNote(sources, "services");
  const [editing, setEditing] = useState<Editing>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = services.data?.items ?? [];
  const problem = write.error ? problemOf(write.error) : null;
  const done = (text: string) => {
    setEditing(null);
    setConfirm(null);
    setNotice(text);
    // Saved by the owner: they have checked what was read.
    const cleared = clearSources(sources, "services");
    if (cleared) saveSettings.mutate({ doc: cleared });
  };
  const open = (next: Editing) => {
    write.reset();
    setNotice(null);
    setEditing(next);
  };

  return (
    <section className="card glass stack">
      <SectionHead title="Services">
        <SourceTag source={read} />
        <span className="sp" />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => open("new")}>
          <Plus className="icon" aria-hidden="true" />
          New service
        </button>
      </SectionHead>
      <p className="lede small">What agents can book, or ask you a price for. Prices are optional.</p>
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
          <p>Add one, like a 30-minute haircut or a quote for a kitchen.</p>
        </div>
      )}
      {editing === "new" && (
        <ServiceEditor
          initial={undefined}
          currency={currency}
          pending={write.isPending}
          error={problem}
          onSubmit={(body, floor) => write.mutate({ body, floor }, { onSuccess: () => done("Service added.") })}
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
            floor={floors.data?.get(`service:${s.id}`) ?? null}
            onSave={(body, floor) =>
              write.mutate({ id: s.id, body, floor }, { onSuccess: () => done("Service saved.") })
            }
            onAskArchive={() => {
              write.reset();
              setConfirm(s.id);
            }}
            onArchive={() =>
              write.mutate(
                { id: s.id, archive: true },
                { onSuccess: () => done(`${s.name} archived; agents no longer see it.`) },
              )
            }
            onRestore={() =>
              write.mutate(
                { id: s.id, body: { active: true } },
                { onSuccess: () => done(`${s.name} is on offer again.`) },
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
  floor,
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
  floor: number | null;
  onSave: Parameters<typeof ServiceEditor>[0]["onSubmit"];
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
        <div className="s">{describeService(s, currency)}</div>
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
            Put back on offer
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
            floor={floor}
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
          <p className="hint">Agents stop seeing it; what was booked or asked keeps it.</p>
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
  const floors = useFloors();
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
      <p className="lede small">What agents can ask to order. Stock is optional.</p>
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
          onSubmit={(body, floor) => write.mutate({ body, floor }, { onSuccess: () => done("Product added.") })}
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
            floor={floors.data?.get(`product:${p.id}`) ?? null}
            onSave={(body, floor) =>
              write.mutate({ id: p.id, body, floor }, { onSuccess: () => done("Product saved.") })
            }
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
  floor,
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
  floor: number | null;
  onSave: Parameters<typeof ProductEditor>[0]["onSubmit"];
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
            floor={floor}
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
