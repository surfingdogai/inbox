/**
 * What a business's own tool says about it, brought in to start from (ADR-032, capability
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
  readonly items: readonly {
    readonly externalId: string;
    readonly name: string;
    readonly price?: { readonly value: number; readonly currency: string } | null | undefined;
    /** Never inferred, and never confirmed by an import: the owner confirms each one in person. */
    readonly allergens?: { readonly contains: readonly string[]; readonly status: "unconfirmed" } | undefined;
  }[];
}
