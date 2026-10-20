import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { problemOf } from "../lib/api";
import { useProperty } from "../lib/property";
import { useApplyPreset } from "../lib/queries";
import { KINDS, kindOf } from "../lib/setup";
import { SectionHead } from "./Form";
import { Chips } from "./Property";

/**
 * What the business runs (Settings → General), for an owner who skipped the setup or set up before a
 * kind was there: a place to stay opens its Property tab and the form for its place; another kind
 * offers its rules to start from, added beside those the owner has, never over them.
 */
export function WhatYouRun() {
  const property = useProperty();
  const navigate = useNavigate();
  const apply = useApplyPreset();
  const isStay = (property.data?.properties.length ?? 0) > 0;
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked ?? (isStay ? "stays" : "");
  const kind = kindOf(value);
  return (
    <section className="card glass stack" aria-label="What you run">
      <SectionHead title="What you run" />
      <Chips
        legend="Your business is"
        value={value}
        options={KINDS.map((k) => ({ value: k.key, label: k.label }))}
        onChange={(key) => {
          setPicked(key);
          apply.reset();
          if (key === "stays") void navigate({ to: "/settings/property" });
        }}
      />
      {kind && kind.key !== "stays" && (
        <div className="rowx">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={apply.isPending || apply.isSuccess}
            onClick={() => apply.mutate({ key: kind.preset, replace: false })}
          >
            {apply.isSuccess ? "Added to your rules" : `Start from the rules for ${kind.label.toLowerCase()}`}
          </button>
          <span className="hint">{kind.line}</span>
        </div>
      )}
      {apply.isError && <p className="hint error">{problemOf(apply.error).detail}</p>}
    </section>
  );
}
