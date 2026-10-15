import type { Settings } from "./types";

/**
 * What agents can do here, door by door, as the owner's switches show it (`settings.doors`): where
 * each switch stands, whether the door is really open (what `GET /v1/business` lists), and what it
 * still needs when it is switched on and not open yet.
 */
export type DoorKey = "booking" | "quoteRequest" | "message";

export interface DoorView {
  readonly key: DoorKey;
  /** The one line the switch says. */
  readonly label: string;
  /** Where the switch stands. */
  readonly on: boolean;
  /** Whether agents are told of it now. */
  readonly open: boolean;
  /** What it waits for, switched on and not open: a service, opening hours, or both. */
  readonly needs: "service" | "hours" | "service_and_hours" | null;
  /** Bookings taken at another site instead, its host; only for booking. */
  readonly elsewhere: string | null;
}

export interface DoorFacts {
  readonly doors: Settings["doors"];
  readonly itemTypes: readonly string[];
  /** An active service. */
  readonly hasService: boolean;
  /** Opening hours with a window, the business's or a service's own. */
  readonly hasHours: boolean;
  readonly doorsElsewhere: Settings["doorsElsewhere"];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export function doorViews(f: DoorFacts): readonly DoorView[] {
  const away = f.doorsElsewhere.find((d) => d.itemType === "booking");
  const bookingOn = f.doors.booking !== false;
  const bookingOpen = f.itemTypes.includes("booking");
  return [
    {
      key: "booking",
      label: "Agents can book time",
      on: bookingOn && !away,
      open: bookingOpen,
      needs:
        bookingOn && !away && !bookingOpen
          ? !f.hasService && !f.hasHours
            ? "service_and_hours"
            : !f.hasService
              ? "service"
              : "hours"
          : null,
      elsewhere: away ? hostOf(away.url) : null,
    },
    {
      key: "quoteRequest",
      label: "Agents can ask for a price",
      // Left to follow the catalogue, it stands where the door is: on once something is listed.
      on: f.doors.quoteRequest ?? f.itemTypes.includes("quote_request"),
      open: f.itemTypes.includes("quote_request"),
      needs: null,
      elsewhere: null,
    },
    {
      key: "message",
      label: "Agents can send a message",
      on: f.doors.message !== false,
      open: f.itemTypes.includes("message"),
      needs: null,
      elsewhere: null,
    },
  ];
}

/** The settings write a switch makes: on is true (a price can be asked before anything is listed), off is false. */
export function doorSwitchDoc(key: DoorKey, on: boolean): { doors: Partial<Record<DoorKey, boolean>> } {
  return { doors: { [key]: on } };
}

/** What a switched-on door still needs, in words. */
export function needsWords(needs: DoorView["needs"]): string {
  if (needs === "service_and_hours") return "Needs a service and opening hours.";
  if (needs === "service") return "Needs a service.";
  if (needs === "hours") return "Needs opening hours.";
  return "";
}

/** What a switched-on door is waiting for, after its line: "once you add a service". */
export function waitWords(needs: DoorView["needs"]): string {
  if (needs === "service_and_hours") return "once you add a service and your hours";
  if (needs === "service") return "once you add a service";
  if (needs === "hours") return "once you set your hours";
  return "";
}
