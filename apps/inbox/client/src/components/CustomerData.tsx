import { Download, ShieldOff, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, problemOf } from "../lib/api";
import { useEraseCustomer, useStopNetworks } from "../lib/queries";
import type { Customer, CustomerSummary } from "../lib/types";
import { Sheet } from "./Sheet";

/**
 * What the owner can do with one customer's data (Tiago, 23 September 2026): download everything the
 * inbox holds about them, switch booking networks off for them, and erase them. Erasing cannot be
 * undone: the server first says what it would erase, and the owner types ERASE to go ahead.
 */
export function CustomerData({
  partyId,
  itemId,
  customer,
  onDone,
}: {
  partyId: string | undefined;
  itemId: string;
  customer: Customer | undefined;
  onDone: (text: string) => void;
}) {
  const stop = useStopNetworks(itemId);
  const erase = useEraseCustomer(itemId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ summary: CustomerSummary; confirm: string } | null>(null);
  const [asked, setAsked] = useState(false);
  if (!partyId) return null;

  const download = async () => {
    setProblem(null);
    setBusy(true);
    try {
      const data = await api.exportCustomer(partyId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `customer-${partyId.slice(-6).toLowerCase()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setProblem(problemOf(error).detail);
    } finally {
      setBusy(false);
    }
  };

  const askErase = () => {
    setProblem(null);
    erase.mutate(
      { partyId },
      {
        onError: (error) => {
          const p = problemOf(error);
          const details = p.details as { summary?: CustomerSummary; confirm?: string } | undefined;
          if (p.code === "confirm_erase" && details?.summary && details.confirm) {
            setConfirming({ summary: details.summary, confirm: details.confirm });
          } else {
            setProblem(p.detail);
          }
        },
        onSuccess: (r) => onDone(r.already ? "This customer was erased already." : "Customer erased."),
      },
    );
  };

  return (
    <div className="stack">
      <div className="eyebrow">Customer's data</div>
      <div className="actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void download()} disabled={busy}>
          <Download className="icon" aria-hidden="true" />
          Download their data
        </button>
        {!customer?.networks_off && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAsked(true)}>
            <ShieldOff className="icon" aria-hidden="true" />
            Stop using networks for them
          </button>
        )}
        <button type="button" className="btn btn-danger btn-sm" onClick={askErase} disabled={erase.isPending}>
          <Trash2 className="icon" aria-hidden="true" />
          Erase this customer…
        </button>
      </div>
      {problem && (
        <p className="hint error" role="alert">
          {problem}
        </p>
      )}
      {asked && (
        <Sheet title="Stop using booking networks for them?" onClose={() => setAsked(false)}>
          <p>
            From now on no network is sent anything about this customer, and no network's standing for them is read.
            Their bookings, orders and emails are not affected. It cannot be switched back on here.
          </p>
          <p className="hint">
            What a network already has stays with it: networks cannot yet be asked to erase it. You will see what each
            one had.
          </p>
          <div className="rowx">
            <button
              type="button"
              className="btn btn-primary"
              disabled={stop.isPending}
              onClick={() =>
                stop.mutate(partyId, {
                  onSuccess: () => {
                    setAsked(false);
                    onDone("Booking networks are off for this customer.");
                  },
                  onError: (error) => {
                    setAsked(false);
                    setProblem(problemOf(error).detail);
                  },
                })
              }
            >
              {stop.isPending && <span className="spinner" aria-hidden="true" />}
              Stop using networks
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAsked(false)}>
              Keep as is
            </button>
          </div>
        </Sheet>
      )}
      {confirming && (
        <EraseSheet
          summary={confirming.summary}
          pending={erase.isPending}
          onCancel={() => setConfirming(null)}
          onErase={() =>
            erase.mutate(
              { partyId, confirm: confirming.confirm },
              {
                onSuccess: () => {
                  setConfirming(null);
                  onDone("Customer erased.");
                },
                onError: (error) => {
                  setConfirming(null);
                  setProblem(problemOf(error).detail);
                },
              },
            )
          }
        />
      )}
    </div>
  );
}

function EraseSheet({
  summary,
  pending,
  onCancel,
  onErase,
}: {
  summary: CustomerSummary;
  pending: boolean;
  onCancel: () => void;
  onErase: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = typed.trim().toUpperCase() === "ERASE";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !pending) onErase();
  };
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <Sheet title={`Erase ${summary.name ?? "this customer"}?`} onClose={onCancel}>
      <form className="stack" onSubmit={submit}>
        <p>
          This cannot be undone. Their name, email address, phone number, addresses, messages, your notes and the emails
          about them are erased from {plural(summary.items, "item", "items")} and{" "}
          {plural(summary.emails, "email", "emails")}. What stays: which items there were, their states, times and
          amounts, and their history.
        </p>
        {summary.open_items > 0 && (
          <p className="hint caution">
            {plural(summary.open_items, "item is", "items are")} still open. They stay as they are, and nobody can be
            emailed about them any more.
          </p>
        )}
        <p className="hint">
          Booking networks are switched off for them for good. Download their data first if they asked for it.
        </p>
        <div>
          <label className="label" htmlFor="erase-confirm">
            Type ERASE to confirm
          </label>
          <input
            id="erase-confirm"
            className="input"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="rowx">
          <button type="submit" className="btn btn-danger" disabled={!ready || pending}>
            {pending && <span className="spinner" aria-hidden="true" />}
            Erase for good
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
            Keep as is
          </button>
        </div>
      </form>
    </Sheet>
  );
}
