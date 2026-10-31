import clsx from "clsx";
import { problemOf } from "../lib/api";
import { SOURCE_WORDS, type SourceRow, sourceRows } from "../lib/bring";
import { useIntegrations } from "../lib/queries";

/**
 * "Bring them from what you already use": the systems a part of the setup can come from (a shop's catalogue, a
 * till's menu, a property system's rooms, a booking platform's times), a line each, with how far along each one is
 * said plainly: built and not yet verified on a live account, waiting for the partner, needing setup on this server,
 * or on its way. One that can be connected opens its card in Settings → Integrations in a new tab, so the setup stays
 * where it is.
 */
export function BringFrom({
  ids,
  feed = false,
  lodging = false,
}: {
  ids: readonly string[];
  feed?: boolean;
  /** A place to stay: its calendar is its channels' calendar links. */
  lodging?: boolean;
}) {
  const integrations = useIntegrations();
  const rows = sourceRows(integrations.data?.cards ?? [], ids, { lodging });
  return (
    <div className="stack">
      <p className="lede small">
        Connect it in Settings → Integrations. It opens in a new tab, so this setup stays where it is; what comes in is
        what agents see.
      </p>
      {integrations.isPending && <div className="skeleton sk-line" />}
      {integrations.isError && <p className="hint error">{problemOf(integrations.error).detail}</p>}
      <ul className="src-list">
        {rows.map((r) => (
          <Row key={r.key} row={r} />
        ))}
        {feed && (
          <Row
            row={{
              key: "feed",
              name: "A product feed or a spreadsheet",
              line: "A CSV export, or the Google Merchant feed WooCommerce, Wix, PrestaShop and others make. Read again every six hours.",
              card: "",
              state: "ready",
              words: SOURCE_WORDS.ready,
              hint: null,
            }}
          />
        )}
      </ul>
      {integrations.isSuccess && rows.length === 0 && !feed && (
        <p className="hint">Nothing here connects to that yet. Add them yourself, now or later.</p>
      )}
    </div>
  );
}

function Row({ row }: { row: SourceRow }) {
  const open = row.state === "ready" || row.state === "unverified";
  const href = row.card ? `/settings/integrations?open=${encodeURIComponent(row.card)}` : "/settings/integrations";
  return (
    <li className="src-row">
      {open ? (
        <a className="src-name" href={href} target="_blank" rel="noopener">
          {row.name}
        </a>
      ) : (
        <span className="src-name">{row.name}</span>
      )}
      <span className={clsx("src-state", row.state === "ready" && "is-ready")}>{row.words}</span>
      <span className="src-line">{row.hint ?? row.line}</span>
    </li>
  );
}
