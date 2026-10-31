import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { problemOf } from "../lib/api";
import { type ChosenKind, chosenKind } from "../lib/kinds";
import { useProperty } from "../lib/property";
import { useApplyPreset, useSettings } from "../lib/queries";
import { GENERAL, KINDS, kindOf, setupKeyOfSaved, setupKindOf } from "../lib/setup";
import { SectionHead } from "./Form";
import { KindPicker } from "./KindPicker";
import { Chips } from "./Property";

/**
 * What the business runs (Settings → General), as the setup asks it: exactly what it is, typed ahead over hundreds
 * of kinds or in the owner's own words, saved at once (`directory.kind`, which networks read with the categories);
 * and, for an owner who skipped the setup or set up before a kind was there, the rules to start from, added beside
 * those the owner has, never over them. A place to stay opens its Property tab and the form for its place.
 */
export function WhatYouRun({
  onPatch,
  pending = false,
}: {
  /** The page's own settings write, so its form follows the version this one makes. */
  onPatch: (doc: Record<string, unknown>, done?: () => void) => void;
  pending?: boolean;
}) {
  const property = useProperty();
  const settings = useSettings();
  const navigate = useNavigate();
  const apply = useApplyPreset();
  const isStay = (property.data?.properties.length ?? 0) > 0;
  const saved = settings.data?.doc.directory.kind ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked ?? setupKeyOfSaved(saved) ?? (isStay ? "stays" : "");
  const kind = kindOf(value);
  // What the field shows: what the owner is typing, else what is saved.
  const [text, setText] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const keep = (next: ChosenKind | null) => {
    if (!next) return;
    setKept(false);
    onPatch({ directory: { kind: next } }, () => setKept(true));
  };
  return (
    <section className="card glass stack" aria-label="What you run">
      <SectionHead title="What you run" />
      <div className="kind-find">
        <label className="label" htmlFor="s-kind">
          Your business is
        </label>
        <KindPicker
          id="s-kind"
          text={text ?? saved?.label ?? ""}
          onText={setText}
          onPick={(k) => {
            setText(k.names.en);
            setPicked(setupKindOf(k).key);
            apply.reset();
            keep(chosenKind(k));
          }}
          onOwnWords={(words) => {
            setText(words);
            setPicked(GENERAL.key);
            apply.reset();
            keep(chosenKind(words));
          }}
        />
        <span className="hint">
          {pending
            ? "Saving…"
            : kept
              ? "Saved. Networks read it with your categories."
              : "Networks read it with your categories. Not in the list? Write it in your own words."}
        </span>
      </div>
      <Chips
        legend="Rules to start from"
        value={value}
        options={[...KINDS, GENERAL].map((k) => ({ value: k.key, label: k.label }))}
        onChange={(key) => {
          setPicked(key);
          apply.reset();
          if (key === "stays") void navigate({ to: "/settings/property" });
        }}
      />
      {kind?.preset && kind.key !== "stays" && (
        <div className="rowx">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={apply.isPending || apply.isSuccess}
            onClick={() => kind.preset && apply.mutate({ key: kind.preset, replace: false })}
          >
            {apply.isSuccess ? "Added to your rules" : `Start from the rules for ${kind.label.toLowerCase()}`}
          </button>
          <span className="hint">{kind.line}</span>
        </div>
      )}
      {kind && !kind.preset && (
        <p className="hint">Your rules follow what agents can do: add them in Settings → Rules.</p>
      )}
      {apply.isError && <p className="hint error">{problemOf(apply.error).detail}</p>}
    </section>
  );
}
