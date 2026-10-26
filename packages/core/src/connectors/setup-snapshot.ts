/**
 * What a business's own tool says about it, brought in to start from (ADR-036, capability
 * `setup_in`): its services, staff, hours and menu sections, each with where it came from. The owner
 * keeps what they want, one press each; nothing here is published or booked until they do. Allergens
 * always arrive unconfirmed: only the owner or their staff, in person, confirm one.
 */
export interface SetupSnapshot {
  readonly source: SnapshotSource;
  readonly services?: readonly SnapshotService[] | undefined;
  readonly staff?: readonly SnapshotStaff[] | undefined;
  /** Weekly hours, `mon` … `sun` → windows `[HH:MM, HH:MM]`, in the business's zone. */
  readonly hours?: Readonly<Record<string, readonly (readonly [string, string])[]>> | undefined;
  readonly menu?: readonly SnapshotMenuSection[] | undefined;
}

/** Where a snapshot came from, and when it was read. */
export interface SnapshotSource {
  /** The connector's kind (`phorest`, `servicem8`, `flipdish`). */
  readonly kind: string;
  /** The tool's own id for the account it was read from. */
  readonly account: string;
  readonly readAt: number;
  /**
   * The time zone the tool keeps its times in, when it says (ADR-039): hours from a tool in another
   * zone than the inbox's are shown, never kept as they are.
   */
  readonly zone?: string | undefined;
}

export interface SnapshotService {
  readonly externalId: string;
  readonly name: string;
  readonly durationMin?: number | undefined;
  /** In minor units of the currency's own exponent; null when the tool gives none. */
  readonly price?: { readonly value: number; readonly currency: string } | null | undefined;
  /** The staff (by `externalId`) who give it, when the tool says. */
  readonly staff?: readonly string[] | undefined;
}

export interface SnapshotStaff {
  readonly externalId: string;
  /** As customers may see them: first names only are shown publicly. */
  readonly name: string;
}

export interface SnapshotMenuSection {
  readonly name: string;
  readonly items: readonly SnapshotMenuItem[];
}

/** One item of a tool's menu, as read from it (ADR-036): what the owner may keep, one press each. */
export interface SnapshotMenuItem {
  readonly externalId: string;
  /** The tool's own id for the group the item sits in, where its orders must name it (a Toast menu group). */
  readonly groupExternalId?: string | undefined;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly price?: { readonly value: number; readonly currency: string } | null | undefined;
  /** Never inferred, and never confirmed by an import: the owner confirms each one in person. */
  readonly allergens?:
    | {
        readonly contains: readonly string[];
        readonly mayContain?: readonly string[] | undefined;
        readonly status: "unconfirmed";
      }
    | undefined;
  /** The tool's option groups, each choice with what it adds in minor units (ADR-036). */
  readonly optionGroups?: readonly SnapshotOptionGroup[] | undefined;
  /** Dietary tags the tool holds (vegan, halal…), in the menu vocabulary; claims about allergens arrive unconfirmed too. */
  readonly dietary?: readonly string[] | undefined;
}

export interface SnapshotOptionGroup {
  readonly externalId: string;
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly choices: readonly {
    readonly externalId: string;
    readonly name: string;
    /** What it adds, in minor units of the item's currency; 0 for nothing. */
    readonly priceDelta: number;
    readonly default?: boolean | undefined;
  }[];
}
