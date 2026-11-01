import { createFileRoute } from "@tanstack/react-router";
import { type ChangeEvent, useRef, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { AccentDots, LookPreview, ThemeSwatches } from "../components/Look";
import { problemOf } from "../lib/api";
import { LOGO_HINT, LOGO_TYPES, logoProblem, useLogoUrl, useLogoWrite, useLookChoice } from "../lib/look";
import { useBusiness, useSettings } from "../lib/queries";

export const Route = createFileRoute("/settings/look")({
  component: LookPage,
});

/**
 * Settings → Look: the business's logo, its theme and its accent, on its pages, in its emails and
 * here. A picture to choose, swatches and dots to press: nothing to type. A choice saves itself a
 * moment later (`useLookChoice`); only the owner, signed in, may change it, and the inbox says so to
 * anyone else.
 */
function LookPage() {
  const settings = useSettings();
  const business = useBusiness();
  const logo = useLogoWrite();
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const kept = settings.data?.doc.look.logo ?? null;
  const shownLogo = useLogoUrl(kept?.sha256);
  const logoUrl = shownLogo.url;
  const failed = (e: unknown) => setNotice({ tone: "danger", text: problemOf(e).detail });
  const savedLook = settings.data?.doc.look;
  const [look, choose] = useLookChoice(
    { theme: savedLook?.theme ?? "standard", accent: savedLook?.accent ?? "ink" },
    failed,
  );

  if (settings.isError) {
    return (
      <ErrorState
        title="Couldn't load the settings"
        text={problemOf(settings.error).detail}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  if (!settings.data) {
    return (
      <section className="card glass stack" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
        <div className="skeleton sk-line" />
      </section>
    );
  }
  const name = business.data?.name || settings.data.doc.business.name || "Your business";
  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = logoProblem(file);
    if (problem) {
      setNotice({ tone: "danger", text: problem });
      return;
    }
    setNotice(null);
    logo.upload.mutate(file, {
      onSuccess: () => setNotice({ tone: "success", text: "Logo saved." }),
      onError: failed,
    });
  };
  const remove = () => {
    setNotice(null);
    logo.remove.mutate(undefined, {
      onSuccess: () => setNotice({ tone: "success", text: "Logo removed." }),
      onError: failed,
    });
  };
  const busy = logo.upload.isPending || logo.remove.isPending;

  return (
    <>
      {notice && (
        <Toast
          tone={notice.tone === "danger" ? "neutral" : "success"}
          text={notice.text}
          onDismiss={() => setNotice(null)}
        />
      )}
      <section className="card glass stack look-settings" aria-labelledby="look-h">
        <SectionHead title="Look" />
        <p className="lede small" id="look-h">
          How your business looks: on your pages, in your emails, and here.
        </p>

        <div className="look-logo">
          <span className="label">Logo</span>
          <div className="look-logo-row">
            <div className="look-logo-frame">
              {logoUrl ? (
                <img src={logoUrl} alt="Your logo" />
              ) : shownLogo.waiting ? null : (
                <span className="fine">No logo</span>
              )}
            </div>
            <div className="look-logo-acts">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                Choose a picture
              </button>
              {kept && (
                <button type="button" className="linkish" disabled={busy} onClick={remove}>
                  Remove
                </button>
              )}
            </div>
          </div>
          <p className="hint">{LOGO_HINT}</p>
          <input
            ref={input}
            type="file"
            accept={LOGO_TYPES.join(",")}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={picked}
          />
        </div>

        <ThemeSwatches
          theme={look.theme}
          accent={look.accent}
          onChoose={(theme) => {
            setNotice(null);
            choose({ theme });
          }}
        />
        <AccentDots
          theme={look.theme}
          accent={look.accent}
          onChoose={(accent) => {
            setNotice(null);
            choose({ accent });
          }}
        />
        <LookPreview theme={look.theme} accent={look.accent} business={name} logoUrl={logoUrl} />
      </section>
    </>
  );
}
