import { isOwnerOrSystem } from "../access/outbound";
import type { SettingsView } from "../capabilities/service";
import type { Db } from "../db";
import { readSettings, type Settings } from "../settings/schema";
import { type Caller, isCustomer, nowOf } from "../write/caller";
import { WriteError } from "../write/errors";
import { dropLogo, dropLogos, prepareLogo, putLogo, readLogo } from "./logo";
import { type Look, logoFile, lookOf } from "./palette";

/**
 * The business's look (logo, theme, accent): what every door reads of it, and the logo's own door.
 * The theme and the accent are settings the owner changes in Settings; the logo is a file, so only
 * `setLogo` and `removeLogo` change `look.logo`, and only the owner in person calls them: what every
 * customer sees is never the owner's AI's, or another system's, to change.
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
      /** The settings write, past the rule that keeps `look.logo` to this door. */
      readonly writeLogo: (caller: Caller, logo: StoredLogo | null) => Promise<SettingsView>;
    },
  ) {}

  async view(): Promise<Look> {
    return lookOf(await readSettings(this.db));
  }

  /** The logo under its public name (`<sha16>.<ext>`): only the one the settings name now, else null. */
  async file(name: string): Promise<LogoFile | null> {
    const logo = (await readSettings(this.db)).look.logo;
    if (!logo || logoFile(logo) !== name) return null;
    return this.read(logo);
  }

  /** The logo for the owner app: any person at the business, or their key. */
  async ownerFile(caller: Caller): Promise<LogoFile | null> {
    requireBusiness(caller);
    const logo = (await readSettings(this.db)).look.logo;
    return logo ? this.read(logo) : null;
  }

  /** A new logo: checked, kept, named in the settings, and the one it replaces removed. */
  async setLogo(caller: Caller, bytes: Uint8Array): Promise<SettingsView> {
    requireOwner(caller);
    const now = nowOf(caller);
    const clean = await prepareLogo(bytes);
    const id = await putLogo(this.db, clean, now);
    let view: SettingsView;
    try {
      view = await this.deps.writeLogo(caller, {
        id,
        type: clean.type,
        sha256: clean.sha256,
        width: clean.width,
        height: clean.height,
      });
    } catch (error) {
      await dropLogo(this.db, id);
      throw error;
    }
    await dropLogos(this.db, now, id);
    return view;
  }

  /** No logo: the business's name alone heads its pages and emails again. */
  async removeLogo(caller: Caller): Promise<SettingsView> {
    requireOwner(caller);
    const view = await this.deps.writeLogo(caller, null);
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
