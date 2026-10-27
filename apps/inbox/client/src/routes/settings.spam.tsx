import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead, Switch } from "../components/Form";
import { Sheet } from "../components/Sheet";
import { problemOf } from "../lib/api";
import { useBusiness, useSaveSettings, useSettings, useSpam, useSpamWrite } from "../lib/queries";
import {
  BASIC_FREE,
  BASIC_LINE,
  basicMonth,
  CONNECT_MODEL,
  FILTER_COPY,
  FILTERS_LINE,
  filterMonth,
  KEEP_CHOICES,
  KEEP_NOTE,
  learningLine,
  MONTHLY_CHECKS,
  notIncluded,
  ONLY_YOU,
  priceLine,
  readerLine,
  SETTINGS_INTRO,
  showsModelUse,
  turnOnSheet,
} from "../lib/spam";
import type { SpamStatus } from "../lib/types";

export const Route = createFileRoute("/settings/spam")({
  component: SpamPage,
});

type FilterName = "pitches" | "scams" | "junk";

/**
 * Settings → Spam (ADR-041 §11.4): the free protection, the three filters with their choice and
 * learning week, who reads for them and what they cost (on a hosted inbox, Pro includes them; Free
 * keeps basic protection), the two lists, the two emails and how long what is put aside is kept.
 * Choosers and switches only: nothing to type. What reads a stranger's words is the owner's choice, so
 * only the owner or staff, signed in, switch them; anyone else reads the page as it is.
 */
function SpamPage() {
  const spam = useSpam();
  const settings = useSettings();
  const business = useBusiness();
  const write = useSpamWrite();
  const save = useSaveSettings();
  const [asking, setAsking] = useState<FilterName | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const tz = business.data?.timezone ?? settings.data?.doc.business.timezone;

  if (spam.isError) {
    return (
      <ErrorState
        title="Couldn't load the spam filter"
        text={problemOf(spam.error).detail}
        onRetry={() => void spam.refetch()}
      />
    );
  }
  if (!spam.data || !settings.data) {
    return (
      <section className="card glass stack" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
        <div className="skeleton sk-line" />
      </section>
    );
  }
  const s = spam.data;
  const doc = settings.data.doc.spam;
  const locked = !s.can_change;
  const hosted = s.plan !== "self_hosted";
  const currency = settings.data.doc.business.currency;
  const failed = (e: unknown) => setNotice({ tone: "danger", text: problemOf(e).detail });

  const switchFilter = (filter: FilterName, on: boolean) => {
    setNotice(null);
    // On a hosted inbox, switching one on says first who reads it.
    if (on && hosted) {
      setAsking(filter);
      return;
    }
    write.mutate({ filter, on }, { onError: failed });
  };
  const saveSpam = (patch: Record<string, unknown>) => {
    setNotice(null);
    save.mutate({ doc: { spam: patch }, expected_version: settings.data.version }, { onError: failed });
  };
  const sheet = asking ? turnOnSheet(asking, s, tz) : null;

  return (
    <>
      {notice && (
        <Toast
          tone={notice.tone === "danger" ? "neutral" : "success"}
          text={notice.text}
          onDismiss={() => setNotice(null)}
        />
      )}
      <section className="card glass stack spam-settings" aria-labelledby="spam-h">
        <SectionHead title="Spam" />
        <p className="lede small" id="spam-h">
          {SETTINGS_INTRO}
        </p>
        {locked && <p className="hint">{ONLY_YOU}</p>}

        <div className="spam-block">
          <div className="spam-block-head">
            <h4>Basic protection</h4>
            <span className="spam-always">Always on</span>
          </div>
          <p>{BASIC_LINE}</p>
          <p className="fine">{BASIC_FREE}</p>
          {s.basic.learning_until && (
            <LearningLine
              until={s.basic.learning_until}
              tz={tz}
              locked={locked}
              onStart={() => write.mutate({ start: "basic" }, { onError: failed })}
            />
          )}
          <p className="fine">{basicMonth(s)}</p>
        </div>

        <div className="spam-block">
          <h4 className="spam-block-title">Filters</h4>
          <p>{FILTERS_LINE}</p>
          <div>
            {s.filters.map((f) => (
              <FilterRow
                key={f.filter}
                f={f}
                plan={s.plan}
                tz={tz}
                locked={locked}
                onSwitch={(on) => switchFilter(f.filter, on)}
                onChoice={(choice) => write.mutate({ filter: f.filter, on: true, choice }, { onError: failed })}
                onStart={() => write.mutate({ start: f.filter }, { onError: failed })}
              />
            ))}
          </div>
          <p className="fine">
            {readerLine(s, tz)}
            {!hosted && s.reader === "no_model" && (
              <>
                {" "}
                <Link to="/settings/integrations" className="link-button">
                  {CONNECT_MODEL}
                </Link>
              </>
            )}
          </p>
          {/* On one's own server with no model there is nothing to count, cap or pay for. */}
          {(hosted || showsModelUse(s)) && <p className="fine">{priceLine(s, currency)}</p>}
          {showsModelUse(s) && (
            <div className="spam-block-head">
              <span className="fine">Most checks a month</span>
              <fieldset className="seg seg-wrap" disabled={locked} aria-label="Most checks a month">
                {MONTHLY_CHECKS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    aria-pressed={doc.monthlyChecks === c.value}
                    onClick={() => saveSpam({ monthlyChecks: c.value })}
                  >
                    {c.label}
                  </button>
                ))}
              </fieldset>
            </div>
          )}
          {showsModelUse(s) && <p className="fine">Your provider charges you for each check.</p>}
        </div>

        <div className="spam-block spam-lists">
          <ListCard
            title="Let through"
            empty="People you mark Not spam appear here."
            rows={s.lists.allow}
            locked={locked}
            onRemove={(r) =>
              write.mutate({ remove: { list: "allow", kind: r.kind, value: r.value } }, { onError: failed })
            }
          />
          <ListCard
            title="Always put aside"
            empty="People you choose to put aside appear here."
            rows={s.lists.block}
            locked={locked}
            onRemove={(r) =>
              write.mutate({ remove: { list: "block", kind: r.kind, value: r.value } }, { onError: failed })
            }
          />
        </div>

        <div className="spam-block">
          <h4 className="spam-block-title">Emails from the filter</h4>
          <Switch checked={doc.heldDigest} disabled={locked} onChange={(v) => saveSpam({ heldDigest: v })}>
            A short email in the morning when something new is held
          </Switch>
          <Switch checked={doc.weeklySummary} disabled={locked} onChange={(v) => saveSpam({ weeklySummary: v })}>
            A summary on Mondays when something was put aside
          </Switch>
        </div>

        <div className="spam-block">
          <div className="spam-block-head">
            <h4>Keep what's put aside</h4>
            <fieldset className="seg seg-wrap" disabled={locked} aria-label="Keep what's put aside">
              {KEEP_CHOICES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={doc.keepDays === c.value}
                  onClick={() => saveSpam({ keepDays: c.value })}
                >
                  {c.label}
                </button>
              ))}
            </fieldset>
          </div>
          <p className="fine">{KEEP_NOTE}</p>
        </div>
      </section>
      {asking && sheet && (
        <Sheet title={sheet.title} onClose={() => setAsking(null)}>
          <p className="lede small">{sheet.text}</p>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setAsking(null)}>
              Not now
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const filter = asking;
                setAsking(null);
                write.mutate({ filter, on: true }, { onError: failed });
              }}
            >
              Turn on
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function LearningLine({
  until,
  tz,
  locked,
  onStart,
}: {
  until: string;
  tz: string | undefined;
  locked: boolean;
  onStart: () => void;
}) {
  return (
    <p className="learning fine">
      {learningLine(until, tz)}{" "}
      {!locked && (
        <button type="button" className="link-button" onClick={onStart}>
          Start now
        </button>
      )}
    </p>
  );
}

function FilterRow({
  f,
  plan,
  tz,
  locked,
  onSwitch,
  onChoice,
  onStart,
}: {
  f: SpamStatus["filters"][number];
  plan: SpamStatus["plan"];
  tz: string | undefined;
  locked: boolean;
  onSwitch: (on: boolean) => void;
  onChoice: (choice: "aside" | "label") => void;
  onStart: () => void;
}) {
  const copy = FILTER_COPY[f.filter];
  return (
    <div className="spam-filter">
      <div className="switch-cell">
        <Switch checked={f.on} disabled={locked || (!f.allowed && !f.on)} onChange={onSwitch}>
          <span className="sr-only">{copy.title}</span>
        </Switch>
      </div>
      <div className="body">
        <span className="title">{copy.title}</span>
        <p>{copy.line}</p>
        {!f.allowed && <p className="fine">{notIncluded(plan)}</p>}
        {f.on && (
          <fieldset className="seg" disabled={locked} aria-label={`What ${copy.title} does`}>
            <button type="button" aria-pressed={f.choice === "aside"} onClick={() => onChoice("aside")}>
              Put aside
            </button>
            <button type="button" aria-pressed={f.choice === "label"} onClick={() => onChoice("label")}>
              Just label
            </button>
          </fieldset>
        )}
        {f.on && f.learning_until && (
          <LearningLine until={f.learning_until} tz={tz} locked={locked} onStart={onStart} />
        )}
        {f.on && <p className="fine">{filterMonth(f)}</p>}
      </div>
    </div>
  );
}

function ListCard({
  title,
  empty,
  rows,
  locked,
  onRemove,
}: {
  title: string;
  empty: string;
  rows: SpamStatus["lists"]["allow"];
  locked: boolean;
  onRemove: (row: SpamStatus["lists"]["allow"][number]) => void;
}) {
  return (
    <div className="spam-list">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="fine">{empty}</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={`${r.kind}:${r.value}`}>
              <span className="spam-list-value" title={r.value}>
                {r.kind === "agent_key" ? "An app" : r.value}
              </span>
              {!locked && (
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => onRemove(r)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
