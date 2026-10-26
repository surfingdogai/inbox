/**
 * Platform answers for the payment connectors' contract tests (ADR-023), written after Stripe's and
 * Mollie's published API reference (18 October 2026) in the shapes those APIs answer with: Stripe's
 * list objects, error objects, Price, Payment Link, webhook endpoint, Checkout Session and Event;
 * Mollie's HAL+JSON profile, payment link, payments list and its signed webhook event. Ids and keys are
 * made up; no test calls a real account.
 */

export const INBOX_ID = "5f1c0de2a9b84e7d3c61";
export const HOOK = "https://inbox.salon.example/v1/hooks";

/* --- Stripe ----------------------------------------------------------------- */

/**
 * Made-up keys, put together at run time so no file holds a string shaped like a real key: a secret
 * scanner would rightly stop a push that did.
 */
const fake = (...parts: string[]) => parts.join("_");
export const STRIPE_LIVE_KEY = fake("rk", "live", "FAKEFAKEFAKE0aBcDeFgHiJkLmNoPqRsTuVwXyZabcd");
export const STRIPE_TEST_KEY = fake("rk", "test", "FAKEFAKEFAKE0aBcDeFgHiJkLmNoPqRsTuVwXyZwxyz");
export const STRIPE_SECRET_KEY = fake("sk", "live", "FAKEFAKEFAKE0aBcDeFgHiJkLmNoPqRsTuVwXyZabcd");
export const STRIPE_WEBHOOK_SECRET = fake("whsec", "FAKEFAKEFAKE5f9a1d3c7b2e8f0a4c6d9e1b3a5c7e9f");

export const STRIPE_EMPTY_LIST = (url: string) => ({ object: "list", data: [], has_more: false, url });

/** What a restricted key without a permission is told (Stripe names the permission and the account). */
export const STRIPE_PERMISSION_ERROR = (permission: string) => ({
  error: {
    message: `The provided key 'rk_test_***********************wxyz' does not have the required permissions for this endpoint on account 'acct_1NvXk2LkdIwHu7ix'. Having the '${permission}' permission would allow this request to continue.`,
    type: "invalid_request_error",
  },
});

export const STRIPE_MISSING_PARAM = (param: string) => ({
  error: {
    code: "parameter_missing",
    doc_url: "https://docs.stripe.com/error-codes/parameter-missing",
    message: `Missing required param: ${param}.`,
    param,
    request_log_url: "https://dashboard.stripe.com/test/logs/req_8xWQe2BmFvXY3k?t=1792310400",
    type: "invalid_request_error",
  },
});

export const STRIPE_INVALID_KEY = {
  error: {
    message: "Invalid API Key provided: rk_live_*****************************abcd",
    type: "invalid_request_error",
  },
};

export const STRIPE_AMOUNT_TOO_SMALL = {
  error: {
    code: "amount_too_small",
    doc_url: "https://docs.stripe.com/error-codes/amount-too-small",
    message: "Amount must be at least €0.50 eur",
    param: "unit_amount",
    type: "invalid_request_error",
  },
};

export const STRIPE_OLD_ENDPOINTS = {
  object: "list",
  data: [
    {
      id: "we_1OldInboxEndpoint0001",
      object: "webhook_endpoint",
      api_version: null,
      application: null,
      created: 1790000000,
      description: "Inbox at inbox.salon.example: marks orders paid",
      enabled_events: [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
      ],
      livemode: true,
      metadata: { sdi_inbox: INBOX_ID },
      status: "enabled",
      url: `${HOOK}/stripe`,
    },
    {
      id: "we_1TheirOwnShopEndpoint",
      object: "webhook_endpoint",
      api_version: null,
      application: null,
      created: 1780000000,
      description: "Shop orders",
      enabled_events: ["*"],
      livemode: true,
      metadata: {},
      status: "enabled",
      url: "https://shop.salon.example/stripe/webhook",
    },
  ],
  has_more: false,
  url: "/v1/webhook_endpoints",
};

export const STRIPE_ENDPOINT_CREATED = {
  id: "we_1QaZ8xLkdIwHu7ixNewEndpoint",
  object: "webhook_endpoint",
  api_version: null,
  application: null,
  created: 1792310400,
  description: "Inbox at inbox.salon.example: marks orders paid",
  enabled_events: [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
  ],
  livemode: true,
  metadata: { sdi_inbox: INBOX_ID },
  secret: STRIPE_WEBHOOK_SECRET,
  status: "enabled",
  url: `${HOOK}/stripe`,
};

export const STRIPE_PRICE = {
  id: "price_1QaZ9cLkdIwHu7ixPrice4500",
  object: "price",
  active: true,
  billing_scheme: "per_unit",
  created: 1792310400,
  currency: "eur",
  custom_unit_amount: null,
  livemode: true,
  lookup_key: null,
  metadata: { sdi_ref: "01JC0PAYREF0000000000000001" },
  nickname: null,
  product: "prod_R3xYzLkdIwHu7i",
  recurring: null,
  tax_behavior: "unspecified",
  tiers_mode: null,
  transform_quantity: null,
  type: "one_time",
  unit_amount: 4500,
  unit_amount_decimal: "4500",
};

export const STRIPE_PAYMENT_LINK = {
  id: "plink_1QaZ9dLkdIwHu7ixLink4500",
  object: "payment_link",
  active: true,
  after_completion: {
    hosted_confirmation: {
      custom_message: "Thank you for your payment for order 4F2K9Q.",
    },
    type: "hosted_confirmation",
  },
  allow_promotion_codes: false,
  application_fee_amount: null,
  application_fee_percent: null,
  automatic_tax: { enabled: false, liability: null },
  billing_address_collection: "auto",
  consent_collection: null,
  currency: "eur",
  custom_fields: [],
  custom_text: { shipping_address: null, submit: null },
  customer_creation: "if_required",
  inactive_message:
    "This link to pay is closed. Ana's Salon's latest email about order 4F2K9Q says what is still to pay, if anything.",
  livemode: true,
  metadata: { sdi_ref: "01JC0PAYREF0000000000000001", sdi_item: "01JC0ORDER00000000000004F2K9Q", sdi_inbox: INBOX_ID },
  on_behalf_of: null,
  payment_intent_data: null,
  payment_method_collection: "always",
  payment_method_types: null,
  phone_number_collection: { enabled: false },
  restrictions: { completed_sessions: { count: 0, limit: 1 } },
  shipping_address_collection: null,
  shipping_options: [],
  submit_type: "pay",
  tax_id_collection: { enabled: false },
  transfer_data: null,
  url: "https://buy.stripe.com/7sI5nr0iZ7bUa7meUY",
};

/** A Checkout Session a Payment Link started, as Stripe returns it (retrieve, and inside the event). */
export function stripeSession(
  over: Partial<{
    id: string;
    paymentStatus: "paid" | "unpaid" | "no_payment_required";
    paymentLink: string | null;
    amount: number;
    livemode: boolean;
    ref: string;
    inbox: string;
  }> = {},
) {
  return {
    id: over.id ?? "cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ",
    object: "checkout.session",
    after_expiration: null,
    allow_promotion_codes: false,
    amount_subtotal: over.amount ?? 4500,
    amount_total: over.amount ?? 4500,
    automatic_tax: { enabled: false, liability: null, status: null },
    billing_address_collection: "auto",
    cancel_url: null,
    client_reference_id: null,
    created: 1792310500,
    currency: "eur",
    customer: null,
    customer_creation: "if_required",
    customer_details: {
      address: { city: null, country: "PT", line1: null, line2: null, postal_code: null, state: null },
      email: "rita@example.com",
      name: "Rita Fonseca",
      phone: null,
      tax_exempt: "none",
      tax_ids: [],
    },
    expires_at: 1792396900,
    invoice: null,
    livemode: over.livemode ?? true,
    locale: "auto",
    metadata: {
      sdi_ref: over.ref ?? "01JC0PAYREF0000000000000001",
      sdi_item: "01JC0ORDER00000000000004F2K9Q",
      sdi_inbox: over.inbox ?? INBOX_ID,
    },
    mode: "payment",
    payment_intent: "pi_3QaZAeLkdIwHu7ix1cDe4500",
    payment_link: over.paymentLink === undefined ? STRIPE_PAYMENT_LINK.id : over.paymentLink,
    payment_method_collection: "if_required",
    payment_method_types: ["card", "link"],
    payment_status: over.paymentStatus ?? "paid",
    status: "complete",
    submit_type: "pay",
    success_url: null,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ui_mode: "hosted",
    url: null,
  };
}

/** A webhook event as Stripe sends it, for a Checkout Session. */
export function stripeEvent(
  type: string,
  session: ReturnType<typeof stripeSession>,
  id = "evt_1QaZAfLkdIwHu7ixPaid0001",
) {
  return {
    id,
    object: "event",
    api_version: "2026-09-30.preview",
    created: 1792310510,
    data: { object: session },
    livemode: session.livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  };
}

/* --- Stripe: an assistant's shared payment token (ADR-042) ---------------------- */

/**
 * A PaymentIntent as Stripe answers it (https://docs.stripe.com/api/payment_intents/object), made from
 * a Shared Payment Token: Stripe clones the customer's card into a new PaymentMethod on confirm
 * (https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens, read 26 October 2026).
 */
export function stripePaymentIntent(
  o: {
    id?: string;
    amount?: number;
    currency?: string;
    status?: "succeeded" | "processing" | "requires_action" | "requires_payment_method" | "canceled";
    livemode?: boolean;
    metadata?: Record<string, string>;
  } = {},
) {
  const status = o.status ?? "succeeded";
  const amount = o.amount ?? 18900;
  return {
    id: o.id ?? "pi_3QFjordbrodPaid0001",
    object: "payment_intent",
    amount,
    amount_capturable: 0,
    amount_received: status === "succeeded" ? amount : 0,
    capture_method: "automatic_async",
    confirmation_method: "automatic",
    created: 1792999800,
    currency: o.currency ?? "nok",
    description: "2 × Sourdough loaf (4F2K9Q)",
    last_payment_error: null,
    latest_charge: status === "succeeded" ? "ch_3QFjordbrodCharge001" : null,
    livemode: o.livemode ?? true,
    metadata: o.metadata ?? {},
    next_action: status === "requires_action" ? { type: "use_stripe_sdk", use_stripe_sdk: {} } : null,
    payment_method: "pm_1QFjordbrodCloned0001",
    payment_method_types: ["card"],
    status,
  };
}

/** A card Stripe declined on confirm: 402 with the PaymentIntent in the error (https://docs.stripe.com/declines/codes). */
export function stripeCardDeclined(declineCode: string, intent = "pi_3QFjordbrodDeclined1") {
  const auth = declineCode === "authentication_required";
  return {
    error: {
      type: "card_error",
      code: auth ? "authentication_required" : "card_declined",
      decline_code: declineCode,
      doc_url: `https://docs.stripe.com/error-codes/${auth ? "authentication-required" : "card-declined"}`,
      message: auth ? "Your card was declined. This transaction requires authentication." : "Your card was declined.",
      payment_intent: { ...stripePaymentIntent({ id: intent, status: "requires_payment_method" }) },
      request_log_url: "https://dashboard.stripe.com/logs/req_1QFjordbrod",
    },
  };
}

/**
 * A token Stripe refused. Its exact error codes are not documented for shared payment tokens (ADR-042
 * names this among what is still to check in a sandbox), so these are in the shape of its other
 * refusals, and the adapter reads the parameter and the words as much as the code.
 */
export function stripeTokenRefused(why: "missing" | "expired" | "consumed" | "revoked" | "limit", token: string) {
  const param = "payment_method_data[shared_payment_granted_token]";
  const said = {
    missing: { code: "resource_missing", message: `No such shared_payment.granted_token: '${token}'` },
    expired: { code: "shared_payment_granted_token_expired", message: "This shared payment token has expired." },
    consumed: {
      code: "shared_payment_granted_token_deactivated",
      message: "This shared payment token was deactivated: consumed.",
    },
    revoked: {
      code: "shared_payment_granted_token_deactivated",
      message: "This shared payment token was deactivated: revoked.",
    },
    limit: {
      code: "shared_payment_granted_token_usage_limit_exceeded",
      message: "The amount exceeds the usage limits of this shared payment token.",
    },
  }[why];
  return { error: { type: "invalid_request_error", param, ...said } };
}

/* --- Mollie ----------------------------------------------------------------- */

export const MOLLIE_LIVE_KEY = fake("live", "FAKEFAKEFAKEnkVtjNVWXLSlXsM");
export const MOLLIE_TEST_KEY = fake("test", "FAKEFAKEFAKEnkVtjNVWXLSlXsM");
export const MOLLIE_SIGNING_SECRET = fake("FAKE", "mollie", "signing", "8f2a9c1d7e3b5a0f6c4d");

export const MOLLIE_PROFILE = {
  resource: "profile",
  id: "pfl_QkEhN94Ba",
  mode: "live",
  name: "Ana's Salon",
  website: "https://salon.example",
  email: "hello@salon.example",
  phone: "+351210000000",
  businessCategory: "PERSONAL_SERVICES",
  status: "verified",
  createdAt: "2025-03-20T09:28:37+00:00",
  _links: {
    self: { href: "https://api.mollie.com/v2/profiles/pfl_QkEhN94Ba", type: "application/hal+json" },
    dashboard: {
      href: "https://my.mollie.com/dashboard/org_12345678/settings/profiles/pfl_QkEhN94Ba",
      type: "text/html",
    },
    documentation: { href: "https://docs.mollie.com/reference/get-current-profile", type: "text/html" },
  },
};

export const MOLLIE_UNAUTHORIZED = {
  status: 401,
  title: "Unauthorized Request",
  detail: "Missing authentication, or failed to authenticate",
  _links: { documentation: { href: "https://docs.mollie.com/overview/authentication", type: "text/html" } },
};

export const MOLLIE_UNPROCESSABLE = {
  status: 422,
  title: "Unprocessable Entity",
  detail: "The amount is lower than the minimum",
  field: "amount",
  _links: { documentation: { href: "https://docs.mollie.com/overview/handling-errors", type: "text/html" } },
};

export function molliePaymentLink(
  over: Partial<{ id: string; value: string; currency: string; webhookUrl: string; paidAt: string | null }> = {},
) {
  const id = over.id ?? "pl_4Y0eZitmBnQ6IDoMqZQKh";
  return {
    resource: "payment-link",
    id,
    mode: "live",
    description: "Colour and cut (4F2K9Q)",
    amount: { currency: over.currency ?? "EUR", value: over.value ?? "45.00" },
    minimumAmount: null,
    archived: false,
    redirectUrl: null,
    webhookUrl: over.webhookUrl ?? `${HOOK}/mollie?ref=01JC0PAYREF0000000000000001`,
    profileId: "pfl_QkEhN94Ba",
    createdAt: "2026-10-18T09:29:56+00:00",
    paidAt: over.paidAt ?? null,
    expiresAt: null,
    reusable: false,
    allowedMethods: null,
    sequenceType: "oneoff",
    customerId: null,
    _links: {
      self: { href: `https://api.mollie.com/v2/payment-links/${id}`, type: "application/hal+json" },
      paymentLink: { href: `https://payment-links.mollie.com/payment/${id.slice(3)}`, type: "text/html" },
      documentation: { href: "https://docs.mollie.com/reference/create-payment-link", type: "text/html" },
    },
  };
}

export function mollieLinkPayments(
  payments: readonly Partial<{ id: string; status: string; value: string; method: string; mode: string }>[],
) {
  return {
    count: payments.length,
    _embedded: {
      payments: payments.map((p) => ({
        resource: "payment",
        id: p.id ?? "tr_5B8cwPMGnU",
        mode: p.mode ?? "live",
        status: p.status ?? "paid",
        isCancelable: false,
        amount: { value: p.value ?? "45.00", currency: "EUR" },
        description: "Colour and cut (4F2K9Q)",
        method: p.method ?? "ideal",
        metadata: null,
        details: { consumerName: "R. Fonseca", consumerAccount: "NL55INGB0000000000", consumerBic: "INGBNL2A" },
        profileId: "pfl_QkEhN94Ba",
        sequenceType: "oneoff",
        redirectUrl: null,
        webhookUrl: `${HOOK}/mollie?ref=01JC0PAYREF0000000000000001`,
        createdAt: "2026-10-18T09:31:00+00:00",
        ...(p.status === undefined || p.status === "paid" ? { paidAt: "2026-10-18T09:31:42+00:00" } : {}),
        _links: {
          self: { href: `https://api.mollie.com/v2/payments/${p.id ?? "tr_5B8cwPMGnU"}`, type: "application/hal+json" },
          dashboard: {
            href: `https://my.mollie.com/dashboard/org_12345678/payments/${p.id ?? "tr_5B8cwPMGnU"}`,
            type: "text/html",
          },
          documentation: { href: "https://docs.mollie.com/reference/get-payment", type: "text/html" },
        },
      })),
    },
    _links: {
      self: {
        href: "https://api.mollie.com/v2/payment-links/pl_4Y0eZitmBnQ6IDoMqZQKh/payments?limit=10",
        type: "application/hal+json",
      },
      previous: null,
      next: null,
      documentation: { href: "https://docs.mollie.com/reference/get-payment-link-payments", type: "text/html" },
    },
  };
}

/** A signed (next-gen) Mollie webhook event: a payment link paid, with the link's snapshot embedded. */
export function mollieLinkPaidEvent(linkId = "pl_4Y0eZitmBnQ6IDoMqZQKh") {
  return {
    resource: "event",
    id: "event_GvJ8WHrp5isUdRub9CJyH",
    type: "payment-link.paid",
    entityId: linkId,
    createdAt: "2026-10-18T09:31:43+00:00",
    _embedded: { entity: molliePaymentLink({ id: linkId, paidAt: "2026-10-18T09:31:42+00:00" }) },
    _links: {
      self: { href: "https://api.mollie.com/v2/events/event_GvJ8WHrp5isUdRub9CJyH", type: "application/hal+json" },
      documentation: { href: "https://docs.mollie.com/reference/webhooks-new", type: "text/html" },
      "payment-link": { href: `https://api.mollie.com/v2/payment-links/${linkId}`, type: "application/hal+json" },
    },
  };
}
