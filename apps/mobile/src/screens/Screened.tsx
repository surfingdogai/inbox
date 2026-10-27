import { useEffect, useState } from "react";
import { partyName, snippetFor } from "../../../inbox/client/src/lib/format";
import {
  HELD_EMPTY,
  HELD_TOP,
  heldOrder,
  heldWhat,
  heldWho,
  MAY_BE_CUSTOMER,
  rowTag,
  SPAM_EMPTY,
  SPAM_TOP,
} from "../../../inbox/client/src/lib/spam";
import type { ItemView } from "../../../inbox/client/src/lib/types";
import { useApp } from "../context";
import { ago, KIND_WORD } from "../lib/view";
import { ChevronLeft } from "./icons";

/**
 * Held and Spam on the phone (ADR-041 §12): the same rows and chips as on the computer, each opening
 * its item, where Let it in, Not spam and Spam are one press each.
 */
export function Screened({ which }: { which: "held" | "spam" }) {
  const app = useApp();
  const [views, setViews] = useState<ItemView[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const tz = app.me?.business.timezone;

  useEffect(() => {
    let alive = true;
    app.client
      ?.screened(which)
      .then((page) => {
        if (alive) setViews(which === "held" ? heldOrder(page.items) : [...page.items]);
      })
      .catch((e: unknown) => {
        if (alive) setFailed(e instanceof Error ? e.message : "Couldn't read the list.");
      });
    return () => {
      alive = false;
    };
  }, [app.client, which]);

  return (
    <div className="screen">
      <header className="head" style={{ paddingLeft: 12, paddingRight: 12 }}>
        <div className="head-row">
          <button type="button" className="back" onClick={app.back}>
            <ChevronLeft />
            Inbox
          </button>
        </div>
        <h1 style={{ paddingLeft: 8 }}>{which === "held" ? "Held" : "Spam"}</h1>
        <p className="screened-top">{which === "held" ? HELD_TOP : SPAM_TOP}</p>
      </header>
      <main className="body">
        {failed && <div className="empty">{failed}</div>}
        {views?.length === 0 && (
          <div className="empty">
            <b>{which === "held" ? HELD_EMPTY : SPAM_EMPTY}</b>
          </div>
        )}
        {views?.map((v) => {
          const tag = rowTag(v.spam);
          return (
            <button
              type="button"
              key={v.item.id}
              className="card soft"
              onClick={() => app.go({ name: "item", id: v.item.id })}
            >
              <div className="meta">
                <span>
                  <span className={`chip ${v.item.type}`}>{KIND_WORD[v.item.type]}</span>
                  {tag && (
                    <span className={tag === MAY_BE_CUSTOMER ? "spam-chip is-customer" : "spam-chip"}>{tag}</span>
                  )}
                </span>
                <span>{ago(v.item.createdAt)}</span>
              </div>
              <div className="who">{which === "held" ? heldWho(v) : partyName(v.party)}</div>
              <div className="what">{which === "held" ? heldWhat(v, tz) : snippetFor(v.item, tz)}</div>
            </button>
          );
        })}
      </main>
    </div>
  );
}
