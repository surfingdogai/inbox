import { Link } from "@tanstack/react-router";
import { BedDouble, CalendarCheck, CalendarDays, CreditCard, ShoppingBag, Store, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { problemOf } from "../lib/api";
import { cardState, cardsFor } from "../lib/connect";
import { useIntegrations } from "../lib/queries";
import type { ConnectorGroup, GalleryCard } from "../lib/types";

const ICONS: Readonly<Record<ConnectorGroup, typeof CalendarDays>> = {
  calendars: CalendarDays,
  payments: CreditCard,
  shops: ShoppingBag,
  lodging: BedDouble,
  work: Wrench,
  pos: Store,
  booking: CalendarCheck,
};

/**
 * "Connect your system" (ADR-036): the systems a kind of business runs its days in, first, as cards —
 * the ones that work today to press, the ones that need setup or are on their way said so, with nothing
 * to press — and a way out for a business that uses none. A ready card opens Settings → Integrations,
 * where it connects; a kind may pass its own `onOpen` (a property system's own connect sheet).
 */
export function ConnectYourSystem({
  groups,
  title = "Connect your system",
  lede,
  onSkip,
  onOpen,
  children,
}: {
  groups: readonly ConnectorGroup[];
  title?: string | undefined;
  lede?: string | undefined;
  onSkip: () => void;
  onOpen?: ((card: GalleryCard) => void) | undefined;
  children?: ReactNode;
}) {
  const integrations = useIntegrations();
  const cards = cardsFor(integrations.data?.cards ?? [], groups);
  return (
    <div className="stack connect-system">
      <h2 className="sec">{title}</h2>
      {lede && <p className="lede small">{lede}</p>}
      {integrations.isPending && <div className="skeleton sk-line" />}
      {integrations.isError && <p className="hint error">{problemOf(integrations.error).detail}</p>}
      {cards.length > 0 && (
        <div className="int-grid">
          {cards.map((c) => {
            const Icon = ICONS[c.group];
            const { tag, hint } = cardState(c);
            const body = (
              <>
                <Icon className="icon int-icon" aria-hidden="true" />
                <span className="int-text">
                  <span className="int-name">{c.title}</span>
                  <span className="int-line">{hint ?? c.line}</span>
                </span>
                {tag && <span className="int-tag">{tag}</span>}
              </>
            );
            if (tag) {
              return (
                <div key={c.id} className="int-tile is-soon">
                  {body}
                </div>
              );
            }
            return onOpen ? (
              <button key={c.id} type="button" className="int-tile" onClick={() => onOpen(c)}>
                {body}
              </button>
            ) : (
              <Link key={c.id} to="/settings/integrations" className="int-tile">
                {body}
              </Link>
            );
          })}
        </div>
      )}
      {children}
      <button type="button" className="linkish connect-skip" onClick={onSkip}>
        I don't use one
      </button>
    </div>
  );
}
