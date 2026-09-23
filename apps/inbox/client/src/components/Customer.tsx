import clsx from "clsx";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { customerNotes, personStandings } from "../lib/format";
import type { Customer } from "../lib/types";

/**
 * Who is asking, beyond the name (ADR-017 §8.2, §8.3): whether it is a customer the business
 * knows or may know, how the assistant signed, and — one row per network that knows the person —
 * their standing there in plain words. Rows appear only for networks the person's assistant
 * presented them to; a business never looks a person up.
 */
export function CustomerBlock({
  customer,
  currency,
  tz,
}: {
  customer: Customer | undefined;
  currency: string;
  tz: string | undefined;
}) {
  const notes = customerNotes(customer, currency);
  const standings = personStandings(customer, undefined, tz);
  if (notes.length === 0 && standings.length === 0) return null;
  return (
    <div className="stack customer">
      {notes.length > 0 && (
        <div className="who-line">
          {notes.map((n) => (
            <span key={n.text} className={clsx("pill pill-xs", n.tone !== "neutral" && `tint-${n.tone}`)}>
              {n.text}
            </span>
          ))}
        </div>
      )}
      {standings.length > 0 && (
        <>
          <div className="eyebrow">Networks that know this customer</div>
          <ul className="standing-list">
            {standings.map((s) => (
              <li className="standing" key={s.network}>
                <ShieldCheck className="icon" aria-hidden="true" />
                <div className="standing-main">
                  <div>
                    <span className={clsx("pill pill-xs", s.tone !== "neutral" && `tint-${s.tone}`)}>{s.tier}</span> on{" "}
                    <b className="mono">{s.network}</b>
                  </div>
                  <div className="s">{s.text}</div>
                  <div className="hint">{s.when}</div>
                  {s.caution && (
                    <div className="hint caution">
                      <TriangleAlert className="icon-xs" aria-hidden="true" /> {s.caution}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
