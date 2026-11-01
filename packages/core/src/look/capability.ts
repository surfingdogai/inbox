import { isOwnerOrSystem } from "../access/outbound";
import type { SettingsView } from "../capabilities/service";
import type { Db } from "../db";
import { readSettings, type Settings } from "../settings/schema";
import { type Caller, isCustomer, nowOf } from "../write/caller";
import { WriteError } from "../write/errors";
import { dropLogo, dropLogos, hasLogo, prepareLogo, putLogo, readLogo } from "./logo";
import { type LogoSlot, type Look, logoFile, lookOf } from "./palette";

/**
 * The business's look (logo, theme, accent): what every door reads of it, and the logo's own door.
 * The theme and the accent are settings the owner changes in Settings; the logos are files, so only
 * `setLogo` and `removeLogo` change `look.logo` and `look.logoDark`, and only the owner in person
 * calls them: what every customer sees is never the owner's AI's, or another system's, to change.
 */

type StoredLogo = NonNullable<Settings["look"]["logo"]>;

/** A logo's bytes as a door serves them. */
export interface LogoFile {
  readonly bytes: Uint8Array;
  readonly type: StoredLogo["type"];
  /** The first 16 of its sha256: its name, and its ETag. */
  readonly tag: string;
}

export class LookCapabilities {
  constructor(
    private readonly db: Db,
    private readonly deps: {
      /** The settings write, past the rule that keeps `look.logo` and `look.logoDark` to this door. */
      readonly writeLogo: (
        caller: Caller,
        logos: { readonly logo?: StoredLogo | null; readonly logoDark?: StoredLogo | null },
      ) => Promise<SettingsView>;
    },
  ) {}

  async view(): Promise<Look> {
    return lookOf(await readSettings(this.db));
  }

  /** A logo under its public name (`<sha16>.<ext>`): only one the look names now, else null. */
  async file(name: string): Promise<LogoFile | null> {
    const look = (await readSettings(this.db)).look;
    for (const logo of [look.logo, look.logo ? look.logoDark : null]) {
      if (logo && logoFile(logo) === name) return this.read(logo);
    }
    return null;
  }

  /** A logo for the owner app: any person at the business, or their key. */
  async ownerFile(caller: Caller, slot: LogoSlot = "logo"): Promise<LogoFile | null> {
    requireBusiness(caller);
    const logo = (await readSettings(this.db)).look[slot];
    return logo ? this.read(logo) : null;
  }

  /**
   * A new logo: checked, kept, named in the settings, and the one it replaces removed. The one for
   * dark pages goes with the logo, so it is taken only once there is one.
   */
  async setLogo(caller: Caller, bytes: Uint8Array, slot: LogoSlot = "logo"): Promise<SettingsView> {
    requireOwner(caller);
    const now = nowOf(caller);
    const had = (await readSettings(this.db)).look.logo !== null;
    if (slot === "logoDark" && !had) {
      throw new WriteError("wrong_state", "Add the logo first: this one is for dark pages.", {
        details: { reason: "no_logo", where: "Settings → Look" },
      });
    }
    const clean = await prepareLogo(bytes);
    const id = await putLogo(this.db, clean, now);
    const kept = { id, type: clean.type, sha256: clean.sha256, width: clean.width, height: clean.height };
    let view: SettingsView;
    try {
      view = await this.deps.writeLogo(
        caller,
        // A first logo starts with none for dark pages: one a removal crossing an upload left never comes back.
        slot === "logo" ? { logo: kept, ...(had ? {} : { logoDark: null }) } : { logoDark: kept },
      );
    } catch (error) {
      await dropLogo(this.db, id);
      throw error;
    }
    await dropLogos(this.db, now);
    // Two uploads at once: the other's clean-up may have run while this one's settings write was on
    // its way, and taken this file with the one it replaced. Once the settings name it, it is kept again.
    if (!(await hasLogo(this.db, id)) && (await readSettings(this.db)).look[slot]?.id === id) {
      await putLogo(this.db, clean, now, id);
    }
    return view;
  }

  /**
   * No logo: the business's name alone heads its pages and emails again, and the one for dark pages
   * goes with it. Only the one for dark pages: the logo sits on its white plate there again.
   */
  async removeLogo(caller: Caller, slot: LogoSlot = "logo"): Promise<SettingsView> {
    requireOwner(caller);
    const view = await this.deps.writeLogo(
      caller,
      slot === "logo" ? { logo: null, logoDark: null } : { logoDark: null },
    );
    await dropLogos(this.db, nowOf(caller));
    return view;
  }

  private async read(logo: StoredLogo): Promise<LogoFile | null> {
    const bytes = await readLogo(this.db, logo.id);
    return bytes ? { bytes, type: logo.type, tag: logo.sha256.slice(0, 16) } : null;
  }
}

function requireBusiness(caller: Caller): void {
  if (isCustomer(caller)) throw new WriteError("not_allowed", "owner operations need an owner or staff principal");
}

function requireOwner(caller: Caller): void {
  if (isOwnerOrSystem(caller)) return;
  throw new WriteError(
    "not_allowed",
    "Only the owner can change the logo, signed in to the owner app (Settings → Look): every customer sees it. Nothing was changed; tell the owner what you suggest.",
    { details: { reason: "owner_in_person", ask_owner: true, where: "Settings → Look" } },
  );
}
