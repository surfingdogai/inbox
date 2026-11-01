import type { LogoSlot } from "@surfingdog/core/look";
import { createFileRoute } from "@tanstack/react-router";
import { type ChangeEvent, useRef, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { AccentDots, LookPreview, ThemeSwatches } from "../components/Look";
import { problemOf } from "../lib/api";
import {
  LOGO_DARK_HINT,
  LOGO_HINT,
  LOGO_TYPES,
  type LogoShown,
  logoProblem,
  useLogoUrl,
  useLogoWrite,
  useLookChoice,
} from "../lib/look";
import { useBusiness, useSettings } from "../lib/queries";

export const Route = createFileRoute("/settings/look")({
  component: LookPage,
});

/** What each logo's line says when it is saved or removed. */
const SAID: Readonly<Record<LogoSlot, { readonly saved: string; readonly removed: string }>> = {
  logo: { saved: "Logo saved.", removed: "Logo removed." },
  logoDark: { saved: "Logo for dark pages saved.", removed: "Logo for dark pages removed." },
};

/**
 * Settings → Look: the business's logo, its theme and its accent, on its pages, in its emails and
 * here; once there is a logo, an optional one for dark pages under it. A picture to choose, swatches
 * and dots to press: nothing to type. A choice saves itself a moment later (`useLookChoice`); only
 * the owner, signed in, may change it, and the inbox says so to anyone else.
 */
function LookPage() {
  const settings = useSettings();
  const business = useBusiness();
  const logo = useLogoWrite();
  const logoDark = useLogoWrite("logoDark");
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const kept = settings.data?.doc.look.logo ?? null;
  const keptDark = kept ? (settings.data?.doc.look.logoDark ?? null) : null;
  const shownLogo = useLogoUrl(kept?.sha256);
  const shownDark = useLogoUrl(keptDark?.sha256, "logoDark");
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
  const writes = { logo, logoDark };
  const picked = (slot: LogoSlot, file: File) => {
    const problem = logoProblem(file);
    if (problem) {
      setNotice({ tone: "danger", text: problem });
      return;
    }
    setNotice(null);
    writes[slot].upload.mutate(file, {
      onSuccess: () => setNotice({ tone: "success", text: SAID[slot].saved }),
      onError: failed,
    });
  };
  const remove = (slot: LogoSlot) => {
    setNotice(null);
    writes[slot].remove.mutate(undefined, {
      onSuccess: () => setNotice({ tone: "success", text: SAID[slot].removed }),
      onError: failed,
    });
  };
  const busy = [logo, logoDark].some((w) => w.upload.isPending || w.remove.isPending);

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

        <LogoLine
          label="Logo"
          hint={LOGO_HINT}
          alt="Your logo"
          shown={shownLogo}
          kept={kept !== null}
          busy={busy}
          onPick={(file) => picked("logo", file)}
          onRemove={() => remove("logo")}
        />
        {kept && (
          <LogoLine
            label="For dark pages"
            hint={LOGO_DARK_HINT}
            alt="Your logo for dark pages"
            shown={shownDark}
            kept={keptDark !== null}
            busy={busy}
            dark
            onPick={(file) => picked("logoDark", file)}
            onRemove={() => remove("logoDark")}
          />
        )}

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
        <LookPreview
          theme={look.theme}
          accent={look.accent}
          business={name}
          logoUrl={logoUrl}
          logoDarkUrl={shownDark.url}
        />
      </section>
    </>
  );
}

/**
 * One logo: the picture in a small frame (white for the logo, dark for the one for dark pages, as
 * each is seen), a button to choose another, and Remove once there is one.
 */
function LogoLine({
  label,
  hint,
  alt,
  shown,
  kept,
  busy,
  dark,
  onPick,
  onRemove,
}: {
  label: string;
  hint: string;
  alt: string;
  shown: LogoShown;
  kept: boolean;
  busy: boolean;
  dark?: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) onPick(file);
  };
  return (
    <div className={dark ? "look-logo is-dark" : "look-logo"}>
      <span className="label">{label}</span>
      <div className="look-logo-row">
        <div className="look-logo-frame">
          {shown.url ? (
            <img src={shown.url} alt={alt} />
          ) : shown.waiting ? null : (
            <span className="fine">{dark ? "None" : "No logo"}</span>
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
            <button type="button" className="linkish" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
      </div>
      <p className="hint">{hint}</p>
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
  );
}
