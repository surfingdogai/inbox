import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import clsx from "clsx";
import { BadgeCheck, Plus, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { MoneyInput, Stepper } from "../components/Choosers";
import { ErrorState, Toast } from "../components/Feedback";
import { FormActions, SectionHead, Switch } from "../components/Form";
import { parseMoney } from "../lib/actions";
import { type ApiProblem, problemOf } from "../lib/api";
import { minorUnitsOf } from "../lib/currencies";
import {
  AGE_CHOICES,
  type AllergenLists,
  allergenLine,
  allergenRows,
  confirmSentence,
  conflictOf,
  DIETARY_WORDS,
  EMPTY_MENU,
  foodApi,
  freshId,
  type GroupDraft,
  groupDrafts,
  groupsWrite,
  type MenuFields,
  type MenuSnapshot,
  NOTICE_CHOICES,
  nextId,
  type OwnerMenu,
  type OwnerMenuItem,
  sameAllergens,
  toggleAllergen,
  useMenu,
  useMenuWrite,
  WEEKDAY_WORDS,
} from "../lib/food";
import { formatMoney } from "../lib/format";
import { useIntegrations, useProductWrite, useProfile, useSaveSettings, useSettings } from "../lib/queries";
import "../food.css";
import "../trades.css";

export const Route = createFileRoute("/settings/menu")({
  component: MenuPage,
});

/** The tags that speak for allergens: confirmed with them (spec `ALLERGEN_CLAIMS`). */
const FREE_FROM = new Set(["gluten_free", "dairy_free", "nut_free"]);

/** The ordering systems a menu can be brought in from (`setup_in`). */
const MENU_SOURCES = new Set(["gloriafood", "flipdish", "toast", "lightspeed", "clover"]);

/**
 * Settings → Menu (ADR-036): what agents read with `get_menu`. Sections, each item's options and what
 * they add, when it is made and how far ahead, and its allergens: stated by the business, confirmed
 * here by the owner or staff in person, item by item, exactly as shown. Nothing confirms them on its own.
 */
function MenuPage() {
  const menu = useMenu();
  if (menu.isPending) {
    return (
      <div className="card glass" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
      </div>
    );
  }
  if (menu.isError) {
    return (
      <div className="card glass">
        <ErrorState
          title="Could not load the menu"
          text={problemOf(menu.error).detail}
          onRetry={() => void menu.refetch()}
        />
      </div>
    );
  }
  return <MenuScreen data={menu.data} />;
}

function MenuScreen({ data }: { data: OwnerMenu }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const on = data.items.filter((i) => i.menu !== null);
  const off = data.items.filter((i) => i.menu === null && i.product.active);
  const sections = [...data.sections].sort((a, b) => a.sort - b.sort);
  const known = new Set(sections.map((s) => s.id));
  // Items in a section the settings do not name yet are shown under it, by its id.
  const extra = [...new Set(on.map((i) => i.menu?.section ?? "menu"))].filter((id) => !known.has(id));
  const groups = [...sections.map((s) => ({ id: s.id, name: s.name })), ...extra.map((id) => ({ id, name: id }))];
  const unconfirmed = on.filter((i) => i.menu?.allergens.status !== "confirmed").length;
  const label = (code: string) => data.vocabulary.allergens.find((a) => a.code === code)?.label ?? code;
  const profile = useProfile();
  // The menu's prices are the business's own: a new dish is priced in its currency.
  const currency = data.items[0]?.product.price.currency ?? profile.data?.currency ?? "EUR";
  const made = (id: string, name: string) => {
    setNotice(`${name} is on the menu. State its allergens, then confirm them.`);
    setEditing(id);
  };

  return (
    <div className="stack menu-page">
      {notice && <Toast tone="success" text={notice} onDismiss={() => setNotice(null)} />}
      <section className="card glass stack">
        <SectionHead title="Menu" />
        <p className="lede small">
          What agents read before they order. Prices are yours. Allergens are what you state, and only you or your staff
          confirm them, here.
        </p>
        {unconfirmed > 0 && (
          <p className="menu-unconfirmed">
            <ShieldAlert className="icon-sm" aria-hidden="true" />
            {unconfirmed === 1 ? "1 dish has" : `${unconfirmed} dishes have`} allergens not confirmed. Agents tell
            people to ask you, and orders with them wait for you.
          </p>
        )}
        <Sections data={data} />
        {on.length === 0 && (
          <div className="stack menu-empty">
            <p className="hint">
              No dishes yet. Add one, or{" "}
              <Link to="/settings/integrations">bring in your menu from your ordering system</Link>.
            </p>
            {sections.length === 0 && <AddDish section="menu" currency={currency} onMade={made} />}
          </div>
        )}
      </section>

      {groups.map((g) => {
        const rows = on
          .filter((i) => (i.menu?.section ?? "menu") === g.id)
          .sort((a, b) => (a.menu?.sort ?? 0) - (b.menu?.sort ?? 0) || a.product.name.localeCompare(b.product.name));
        // A section the owner named shows even empty, to add its first dish in it.
        if (rows.length === 0 && !known.has(g.id)) return null;
        return (
          <section key={g.id} className="card glass stack" aria-labelledby={`sec-${g.id}`}>
            <h3 className="sec" id={`sec-${g.id}`}>
              {g.name}
            </h3>
            <div className="rows">
              {rows.map((i) => (
                <MenuRow
                  key={i.product.id}
                  item={i}
                  data={data}
                  label={label}
                  editing={editing === i.product.id}
                  onEdit={() => setEditing(editing === i.product.id ? null : i.product.id)}
                  onDone={(text) => {
                    setNotice(text);
                    setEditing(null);
                  }}
                />
              ))}
            </div>
            <AddDish section={g.id} currency={currency} onMade={made} />
          </section>
        );
      })}

      {off.length > 0 && (
        <section className="card glass stack">
          <SectionHead title="Not on the menu" />
          <p className="lede small">Products you sell that agents do not see on the menu yet.</p>
          <div className="rows">
            {off.map((i) => (
              <MenuRow
                key={i.product.id}
                item={i}
                data={data}
                label={label}
                editing={editing === i.product.id}
                onEdit={() => setEditing(editing === i.product.id ? null : i.product.id)}
                onDone={(text) => {
                  setNotice(text);
                  setEditing(null);
                }}
              />
            ))}
          </div>
        </section>
      )}
      <BringIn onDone={setNotice} />
    </div>
  );
}

/** The menu's sections, in order: add one by its name, take one off when nothing is in it. */
function Sections({ data }: { data: OwnerMenu }) {
  const save = useSaveSettings();
  const settings = useSettings();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const sections = [...data.sections].sort((a, b) => a.sort - b.sort);
  const used = new Set(data.items.map((i) => i.menu?.section).filter(Boolean));
  const write = async (next: readonly { id: string; name: string; sort: number }[]) => {
    setProblem(null);
    try {
      await save.mutateAsync({
        doc: { menu: { sections: next.map((s, i) => ({ ...s, sort: i })) } },
        expected_version: settings.data?.version,
      });
      void qc.invalidateQueries({ queryKey: ["menu"] });
    } catch (e) {
      setProblem(problemOf(e));
    }
  };
  const add = () => {
    const n = name.trim();
    if (!n) return;
    void write([
      ...sections,
      {
        id: freshId(
          n,
          sections.map((s) => s.id),
        ),
        name: n,
        sort: sections.length,
      },
    ]);
    setName("");
  };
  return (
    <div className="stack menu-sections">
      <span className="label">Sections</span>
      {sections.length > 0 ? (
        <ul className="chips" aria-label="Sections">
          {sections.map((s) => (
            <li key={s.id} className="chip chip-removable">
              <span>{s.name}</span>
              {!used.has(s.id) && (
                <button
                  type="button"
                  className="chip-x"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => void write(sections.filter((x) => x.id !== s.id))}
                >
                  <X className="icon-xs" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Add sections as your menu has them: Starters, Pizzas, Drinks.</p>
      )}
      <div className="menu-add">
        <input
          className="input"
          aria-label="New section"
          placeholder="New section"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!name.trim() || save.isPending}
          onClick={add}
        >
          Add
        </button>
      </div>
      {problem && <p className="hint error">{problem.detail}</p>}
    </div>
  );
}

function MenuRow({
  item,
  data,
  label,
  editing,
  onEdit,
  onDone,
}: {
  item: OwnerMenuItem;
  data: OwnerMenu;
  label: (code: string) => string;
  editing: boolean;
  onEdit: () => void;
  onDone: (text: string) => void;
}) {
  const write = useMenuWrite();
  const m = item.menu;
  const confirmed = m?.allergens.status === "confirmed";
  const meta = [
    formatMoney(item.product.price),
    m && m.optionGroups.length > 0
      ? `${m.optionGroups.length} option ${m.optionGroups.length === 1 ? "group" : "groups"}`
      : null,
    m?.dailyCap ? `${m.dailyCap} a day` : null,
    m?.madeToOrder ? "Made to order" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="catalogue-row row-glass menu-row">
      <div className="catalogue-main">
        <div className="t">
          <b>{item.product.name}</b>
          {/* A confirmed dish needs no pill; the switch says when it is sold out. */}
          {m && !confirmed && <span className="pill pill-xs tint-warning">Allergens not confirmed</span>}
        </div>
        <div className="s">{meta}</div>
        {m && <div className="s">{allergenLine(m.allergens, label)}</div>}
      </div>
      <div className="rowx menu-row-controls">
        {m && (
          <Switch
            checked={item.sold_out_today}
            disabled={write.soldOut.isPending}
            onChange={(next) =>
              write.soldOut.mutate(
                { productId: item.product.id, soldOut: next },
                {
                  onSuccess: () =>
                    onDone(next ? `${item.product.name}: sold out today.` : `${item.product.name}: back on.`),
                },
              )
            }
          >
            <span className="small">Sold out</span>
          </Switch>
        )}
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={editing} onClick={onEdit}>
          {m ? "Edit" : "Add to menu"}
        </button>
      </div>
      {editing && (
        <div className="wide">
          <MenuEditor item={item} data={data} label={label} onDone={onDone} onCancel={onEdit} />
        </div>
      )}
    </div>
  );
}

function MenuEditor({
  item,
  data,
  label,
  onDone,
  onCancel,
}: {
  item: OwnerMenuItem;
  data: OwnerMenu;
  label: (code: string) => string;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const write = useMenuWrite();
  const currency = item.product.price.currency;
  const e = minorUnitsOf(currency);
  const start = item.menu ?? { ...EMPTY_MENU, section: data.sections[0]?.id ?? "menu" };
  const [section, setSection] = useState(start.section);
  const [lists, setLists] = useState<AllergenLists>({
    contains: start.allergens.contains,
    mayContain: start.allergens.mayContain,
  });
  const [all, setAll] = useState(false);
  const [dietary, setDietary] = useState<readonly string[]>(start.dietary);
  const [groups, setGroups] = useState<readonly GroupDraft[]>(groupDrafts(start.optionGroups, e));
  const [notice, setNoticeMin] = useState(start.noticeMin);
  const [cap, setCap] = useState(start.dailyCap === null ? "" : String(start.dailyCap));
  const [days, setDays] = useState<readonly string[]>(start.availableDays);
  const [made, setMade] = useState(start.madeToOrder);
  const [age, setAge] = useState<MenuFields["ageRestricted"]>(start.ageRestricted);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const saved = item.menu;
  // A person confirms what is saved, as it is shown: changes are saved first.
  const claims = (tags: readonly string[]) =>
    tags
      .filter((t) => FREE_FROM.has(t))
      .sort()
      .join("|");
  const changed = !saved || !sameAllergens(lists, saved.allergens) || claims(dietary) !== claims(saved.dietary);
  const rows = allergenRows(data.vocabulary.allergens, lists, all);
  const law = data.vocabulary.law;

  const submit = async () => {
    setProblem(null);
    const written = groupsWrite(groups, start.optionGroups, currency);
    if ("problem" in written) {
      setProblem(written.problem);
      return;
    }
    const menu: MenuFields = {
      ...start,
      section,
      optionGroups: written.groups,
      allergens: { ...start.allergens, contains: [...lists.contains], mayContain: [...lists.mayContain] },
      dietary: dietary as MenuFields["dietary"],
      noticeMin: notice,
      dailyCap: cap ? Math.max(1, Math.min(10_000, Number(cap))) : null,
      availableDays: days as MenuFields["availableDays"],
      madeToOrder: made,
      ageRestricted: age,
    };
    try {
      await write.set.mutateAsync({ productId: item.product.id, menu });
      onDone(`${item.product.name} saved.`);
    } catch (err) {
      setProblem(problemOf(err).detail);
    }
  };

  const confirm = async () => {
    if (!item.fingerprint) return;
    setProblem(null);
    try {
      await write.confirm.mutateAsync({ productId: item.product.id, fingerprint: item.fingerprint });
      setConfirming(false);
      onDone(`Allergens confirmed for ${item.product.name}.`);
    } catch (err) {
      setProblem(problemOf(err).detail);
    }
  };

  const takeOff = async () => {
    try {
      await write.set.mutateAsync({ productId: item.product.id, menu: null });
      onDone(`${item.product.name} is off the menu.`);
    } catch (err) {
      setProblem(problemOf(err).detail);
    }
  };

  return (
    <div className="menu-editor stack">
      <div className="grid2">
        <div>
          <label className="label" htmlFor={`sec-${item.product.id}`}>
            Section
          </label>
          <select
            id={`sec-${item.product.id}`}
            className="input"
            value={section}
            onChange={(ev) => setSection(ev.target.value)}
          >
            {data.sections.length === 0 && <option value="menu">Menu</option>}
            {data.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="allergens">
        <legend className="label">Allergens</legend>
        <p className="hint">
          {law
            ? `The ${data.vocabulary.allergens.filter((a) => a.mandatory).length} that ${law.name} law names, and any the dish has.`
            : "The ones food laws name, and any the dish has."}{" "}
          Press what this dish contains, or may contain from shared kitchens or oil.
        </p>
        <table className="allergen-grid">
          <thead>
            <tr>
              <th scope="col">Allergen</th>
              <th scope="col">Contains</th>
              <th scope="col">May contain</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.code} className={clsx(a.parent && rows.some((r) => r.code === a.parent) && "is-part")}>
                <th scope="row">{a.label}</th>
                {(["contains", "mayContain"] as const).map((col) => {
                  const pressed = lists[col].includes(a.code);
                  return (
                    <td key={col}>
                      <button
                        type="button"
                        className={clsx("allergen-cell", col === "contains" ? "is-contains" : "is-may")}
                        aria-pressed={pressed}
                        aria-label={`${a.label}: ${col === "contains" ? "contains" : "may contain"}`}
                        onClick={() => {
                          setLists(toggleAllergen(lists, a.code, col));
                          setConfirming(false);
                        }}
                      >
                        {pressed ? (col === "contains" ? "Contains" : "May") : ""}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "Fewer" : `All ${data.vocabulary.allergens.length}, with each nut and cereal`}
        </button>
        <AllergenStatus
          item={item}
          changed={changed}
          confirming={confirming}
          pending={write.confirm.isPending}
          lists={saved?.allergens ?? lists}
          label={label}
          onAsk={() => setConfirming(true)}
          onConfirm={() => void confirm()}
          onCancel={() => setConfirming(false)}
        />
      </fieldset>

      <fieldset className="chips-field">
        <legend className="label">Dietary</legend>
        <div className="chips">
          {data.vocabulary.dietary.map((d) => {
            // A tag its own allergens contradict is not offered: "Gluten free" on a dish that contains wheat.
            const against = conflictOf(data.vocabulary.dietary_conflicts?.[d], lists);
            const on = dietary.includes(d);
            return (
              <button
                key={d}
                type="button"
                className="chip"
                aria-pressed={on}
                disabled={against !== null && !on}
                title={
                  against
                    ? `${against.list === "contains" ? "Contains" : "May contain"} ${label(against.code).toLowerCase()}`
                    : undefined
                }
                onClick={() => setDietary(on ? dietary.filter((x) => x !== d) : [...dietary, d])}
              >
                {DIETARY_WORDS[d] ?? d}
              </button>
            );
          })}
        </div>
        {dietary.some((d) => FREE_FROM.has(d)) && (
          <p className="hint">A free-from tag is told to agents as unconfirmed until you confirm the allergens.</p>
        )}
      </fieldset>

      <OptionGroups groups={groups} currency={currency} onChange={setGroups} />

      <fieldset className="chips-field">
        <legend className="label">Order ahead</legend>
        <div className="chips">
          {NOTICE_CHOICES.map((c) => (
            <button
              key={c.min}
              type="button"
              className="chip"
              aria-pressed={notice === c.min}
              onClick={() => setNoticeMin(c.min)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="chips-field">
        <legend className="label">Days it is made</legend>
        <div className="chips">
          {WEEKDAY_WORDS.map(([d, w]) => (
            <button
              key={d}
              type="button"
              className="chip"
              aria-pressed={days.includes(d)}
              onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}
            >
              {w}
            </button>
          ))}
        </div>
        {days.length === 0 && <p className="hint">Every day you take orders.</p>}
      </fieldset>

      <div className="grid2">
        <div className="stack">
          <Switch checked={cap !== ""} onChange={(v) => setCap(v ? "12" : "")}>
            A daily limit
          </Switch>
          {cap !== "" && (
            <Stepper
              id={`cap-${item.product.id}`}
              label="How many a day through here"
              value={cap}
              onChange={setCap}
              min={1}
              max={10_000}
              hint="What you set aside. Past it, orders wait for you."
            />
          )}
        </div>
        <div className="stack">
          <Switch checked={made} onChange={setMade}>
            Made to order
          </Switch>
          <p className="hint">Made for the customer, like a cake with a name: you decide on each one.</p>
        </div>
      </div>

      <fieldset className="chips-field">
        <legend className="label">Age limit</legend>
        <div className="chips">
          {AGE_CHOICES.map((a) => (
            <button key={String(a)} type="button" className="chip" aria-pressed={age === a} onClick={() => setAge(a)}>
              {a === null ? "None" : `${a}+`}
            </button>
          ))}
        </div>
      </fieldset>

      {problem && <Toast tone="danger" text={problem} onDismiss={() => setProblem(null)} />}
      <FormActions>
        {saved && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void takeOff()}>
            Take off the menu
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={write.set.isPending} onClick={() => void submit()}>
          {write.set.isPending ? "Saving…" : saved ? "Save" : "Put on the menu"}
        </button>
      </FormActions>
    </div>
  );
}

/**
 * Where the allergens stand, and the press that confirms them: a person, here, confirms exactly what is
 * saved and shown. A change makes them unconfirmed again until someone confirms them anew.
 */
function AllergenStatus({
  item,
  changed,
  confirming,
  pending,
  lists,
  label,
  onAsk,
  onConfirm,
  onCancel,
}: {
  item: OwnerMenuItem;
  changed: boolean;
  confirming: boolean;
  pending: boolean;
  lists: AllergenLists;
  label: (code: string) => string;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const a = item.menu?.allergens;
  if (!item.menu) return <p className="hint">Put it on the menu first; then you confirm its allergens here.</p>;
  if (changed) return <p className="hint">Save the changes, then confirm them.</p>;
  if (a?.status === "confirmed") {
    const by = a.confirmedBy === "staff" ? "staff" : "you";
    const when = a.confirmedAt
      ? new Date(a.confirmedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })
      : "";
    return (
      <p className="hint allergen-ok">
        <BadgeCheck className="icon-xs" aria-hidden="true" /> Confirmed by {by}
        {when ? ` on ${when}` : ""}. Changing them makes them unconfirmed again.
      </p>
    );
  }
  if (!confirming) {
    return (
      <div className="allergen-ask">
        <p className="hint">
          {a?.source ? `Brought in from ${a.source}: ` : ""}not confirmed. Agents tell people to ask you.
        </p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onAsk} disabled={!item.fingerprint}>
          Confirm allergens…
        </button>
      </div>
    );
  }
  return (
    <div className="allergen-confirm">
      <p>
        You checked with the kitchen: <b>{confirmSentence(item.product.name, lists, label)}</b>
      </p>
      <p className="hint">Agents will say this as yours. Only a person here can confirm it.</p>
      <div className="rowx">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Not yet
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={onConfirm}>
          {pending ? "Confirming…" : "Confirm, as shown"}
        </button>
      </div>
    </div>
  );
}

/** A dish's option groups: a pizza's size and crust, a coffee's milk. One level: a choice may open one group. */
function OptionGroups({
  groups,
  currency,
  onChange,
}: {
  groups: readonly GroupDraft[];
  currency: string;
  onChange: (next: readonly GroupDraft[]) => void;
}) {
  const set = (i: number, g: Partial<GroupDraft>) => onChange(groups.map((x, j) => (j === i ? { ...x, ...g } : x)));
  const addGroup = () =>
    onChange([
      ...groups,
      {
        id: nextId(
          "g",
          groups.map((g) => g.id),
        ),
        name: "",
        min: 1,
        max: 1,
        halves: false,
        choices: [{ id: "c1", name: "", adds: "", opens: "" }],
      },
    ]);
  return (
    <fieldset className="option-groups stack">
      <legend className="label">Options</legend>
      {groups.length === 0 && <p className="hint">Sizes, crusts, milks, extras: what someone chooses on this dish.</p>}
      {groups.map((g, i) => (
        <div key={g.id} className="option-group stack">
          <div className="option-head">
            <input
              className="input"
              aria-label="Option group name"
              placeholder="Size, crust, extras"
              value={g.name}
              maxLength={120}
              onChange={(ev) => set(i, { name: ev.target.value })}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label={`Remove ${g.name || "this group"}`}
              onClick={() => onChange(groups.filter((_, j) => j !== i))}
            >
              <X className="icon-sm" aria-hidden="true" />
            </button>
          </div>
          <div className="option-rules">
            <fieldset className="seg">
              <legend className="sr-only">Required</legend>
              <button type="button" aria-pressed={g.min > 0} onClick={() => set(i, { min: Math.max(1, g.min) })}>
                Required
              </button>
              <button type="button" aria-pressed={g.min === 0} onClick={() => set(i, { min: 0 })}>
                Optional
              </button>
            </fieldset>
            <Stepper
              id={`max-${g.id}`}
              label="Up to"
              value={String(g.max)}
              onChange={(v) => set(i, { max: Math.max(1, Number(v) || 1) })}
              min={1}
              max={Math.max(1, g.choices.length)}
            />
            {g.max >= 2 && (
              <Switch checked={g.halves} onChange={(v) => set(i, { halves: v })}>
                <span className="small">Halves</span>
                <span className="hint"> Half-and-half, like pizza toppings</span>
              </Switch>
            )}
          </div>
          <ul className="option-choices">
            {g.choices.map((c, k) => (
              <li key={c.id}>
                <input
                  className="input"
                  aria-label="Choice"
                  placeholder="Large, oat milk"
                  value={c.name}
                  maxLength={120}
                  onChange={(ev) =>
                    set(i, { choices: g.choices.map((x, j) => (j === k ? { ...x, name: ev.target.value } : x)) })
                  }
                />
                <MoneyInput
                  id={`adds-${g.id}-${c.id}`}
                  value={c.adds}
                  currency={currency}
                  placeholder="+0"
                  onChange={(v) => set(i, { choices: g.choices.map((x, j) => (j === k ? { ...x, adds: v } : x)) })}
                />
                {groups.length > 1 && (
                  <select
                    className="input"
                    aria-label="Then asks"
                    value={c.opens}
                    onChange={(ev) =>
                      set(i, { choices: g.choices.map((x, j) => (j === k ? { ...x, opens: ev.target.value } : x)) })
                    }
                  >
                    <option value="">Then asks: nothing</option>
                    {groups
                      .filter((o) => o.id !== g.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          Then asks: {o.name || "another group"}
                        </option>
                      ))}
                  </select>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  aria-label={`Remove ${c.name || "this choice"}`}
                  disabled={g.choices.length === 1}
                  onClick={() => set(i, { choices: g.choices.filter((_, j) => j !== k) })}
                >
                  <X className="icon-xs" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              set(i, {
                choices: [
                  ...g.choices,
                  {
                    id: nextId(
                      "c",
                      g.choices.map((c) => c.id),
                    ),
                    name: "",
                    adds: "",
                    opens: "",
                  },
                ],
              })
            }
          >
            <Plus className="icon-xs" aria-hidden="true" /> A choice
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-secondary btn-sm" onClick={addGroup}>
        <Plus className="icon-xs" aria-hidden="true" /> An option group
      </button>
    </fieldset>
  );
}

/**
 * A dish added straight to a section: its name and price here, then its editor opens for the rest. It
 * is a product like any other (Settings → Services → Products lists it too), put on the menu with its
 * allergens for the owner to state and confirm.
 */
function AddDish({
  section,
  currency,
  onMade,
}: {
  section: string;
  currency: string;
  onMade: (id: string, name: string) => void;
}) {
  const write = useProductWrite();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm menu-add-dish" onClick={() => setOpen(true)}>
        <Plus className="icon-xs" aria-hidden="true" /> A dish
      </button>
    );
  }
  const add = async () => {
    setProblem(null);
    const m = parseMoney(price, currency);
    if (!name.trim()) return setProblem("Name the dish.");
    if (!m || m.value <= 0) return setProblem("Write a price like 45,50 or 45.50.");
    try {
      const row = await write.mutateAsync({ body: { name: name.trim(), price: m, active: true } });
      await foodApi.setItem(row.id, { ...EMPTY_MENU, section });
      await qc.invalidateQueries({ queryKey: ["menu"] });
      setName("");
      setPrice("");
      setOpen(false);
      onMade(row.id, row.name);
    } catch (e) {
      setProblem(problemOf(e).detail);
    }
  };
  return (
    <div className="stack">
      <div className="menu-add">
        <input
          className="input"
          aria-label="Dish"
          placeholder="Dish"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <MoneyInput id={`dish-${section}`} value={price} currency={currency} placeholder="Price" onChange={setPrice} />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={write.isPending}
          onClick={() => void add()}
        >
          Add
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {problem && <p className="hint error">{problem}</p>}
    </div>
  );
}

/**
 * Bring in a menu from a connected ordering system: read now from it, the owner ticks what to keep.
 * Prices are the business's own, as its system has them; allergens arrive unconfirmed.
 */
function BringIn({ onDone }: { onDone: (text: string) => void }) {
  const integrations = useIntegrations();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [snap, setSnap] = useState<MenuSnapshot | null>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sources = (integrations.data?.connections ?? []).filter(
    (c) => MENU_SOURCES.has(c.kind) && c.capabilities.includes("setup_in") && c.status !== "disabled",
  );
  if (sources.length === 0) return null;
  const read = async (id: string) => {
    setOpen(id);
    setSnap(null);
    setProblem(null);
    setBusy(true);
    try {
      const s = await foodApi.snapshot(id);
      setSnap(s);
      setPicked((s.menu ?? []).flatMap((sec) => sec.items.map((i) => i.externalId)));
    } catch (e) {
      setProblem(problemOf(e).detail);
    } finally {
      setBusy(false);
    }
  };
  const keep = async () => {
    if (!open) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await foodApi.importMenu(open, picked);
      void qc.invalidateQueries({ queryKey: ["menu"] });
      setOpen(null);
      setSnap(null);
      onDone(`${r.kept + r.updated} dishes kept. Confirm each one's allergens before agents say them.`);
    } catch (e) {
      setProblem(problemOf(e).detail);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card glass stack">
      <SectionHead title="Bring in your menu" />
      <p className="lede small">From the ordering system you connected. Your prices stay as it has them.</p>
      <div className="chips">
        {sources.map((c) => (
          <button
            key={c.id}
            type="button"
            className="chip"
            aria-pressed={open === c.id}
            disabled={busy}
            onClick={() => void read(c.id)}
          >
            {c.title}
          </button>
        ))}
      </div>
      {busy && !snap && <div className="skeleton sk-line" />}
      {snap && (
        <div className="stack">
          {(snap.menu ?? []).map((sec) => (
            <div key={sec.name} className="stack bring-section">
              <span className="label">{sec.name}</span>
              {sec.items.map((i) => (
                <label key={i.externalId} className="check">
                  <input
                    type="checkbox"
                    checked={picked.includes(i.externalId)}
                    onChange={(ev) =>
                      setPicked(
                        ev.target.checked ? [...picked, i.externalId] : picked.filter((x) => x !== i.externalId),
                      )
                    }
                  />
                  <span>
                    {i.name}
                    {i.price ? <span className="hint"> · {formatMoney(i.price)}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ))}
          <FormActions>
            <button type="button" className="btn btn-ghost" onClick={() => setSnap(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || picked.length === 0}
              onClick={() => void keep()}
            >
              Keep {picked.length}
            </button>
          </FormActions>
        </div>
      )}
      {problem && <p className="hint error">{problem}</p>}
    </section>
  );
}
