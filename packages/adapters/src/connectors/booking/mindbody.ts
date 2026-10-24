import { type ConnectorDefinition, field, secretField } from "@surfingdog/core";
import { z } from "zod";

/**
 * Mindbody (ADR-035): switched off, and nothing here calls it.
 *
 * Every call to Mindbody's Public API carries the developer's own `Api-Key` (a Mindbody developer
 * account, which Mindbody reviews) and the studio's `SiteId`, and a studio owner activates the developer
 * for their site with an activation code; bookings are made as a staff user, with a token issued for
 * them (https://developers.mindbodyonline.com/, whose reference is drawn in the browser only; the
 * shape of the calls is described by third parties, https://www.usecarly.com/blog/mindbody-api/ and
 * https://apis.io/agentic-access/mindbody/mindbody-agentic-access/). Nothing of this can be built honestly before the company has
 * the developer account and can read the reference under it: until then the card says "Needs setup",
 * there is no Connect button, and a self-hoster's inbox offers it the same way.
 *
 * The form below is what an owner would give once it is on: their site and the staff user bookings are
 * made as. The calls (services, staff, bookable times, a booking written first) follow the developer
 * account.
 */
export const MINDBODY_READY = false;

export const MINDBODY_DOCS = "https://surfingdog.ai/docs/connectors/mindbody";

export const mindbodyForm = z.object({
  site_id: field(
    z
      .string()
      .trim()
      .regex(/^-?\d{1,10}$/),
    {
      label: "Site ID",
      help: "Your studio's Site ID in Mindbody.",
    },
  ),
  username: field(z.string().trim().min(1).max(200), {
    label: "Staff username",
    help: "A staff login bookings are made as.",
    autocomplete: "off",
  }),
  password: secretField(z.string().min(1).max(200), { label: "Staff password" }),
});

export function mindbodyConnector(): ConnectorDefinition {
  return {
    kind: "mindbody",
    title: "Mindbody",
    group: "booking",
    capabilities: ["setup_in", "availability_in", "write_bookings"],
    auth: "form",
    form: mindbodyForm,
    ready: () => (MINDBODY_READY ? true : "Not available yet: Mindbody has to approve it first."),
    whenNotReady: {
      status: "setup",
      hint: "Not available yet: Mindbody has to approve it first.",
      href: MINDBODY_DOCS,
      tag: "Not available yet",
    },
  };
}
