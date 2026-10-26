import type { Doc } from "./admin";

/**
 * Every GraphQL document the Shopify connector sends (Admin API 2026-10), each named, with what it is
 * expected to cost at most (the cost model: an object 1, a connection 2 plus `first` times its node,
 * a mutation 10; https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits). Only what the
 * inbox uses is asked for: no customer's name, email or address is ever read back.
 *
 * - shop: https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Shop
 * - productVariants: https://shopify.dev/docs/api/admin-graphql/2026-10/queries/productVariants
 * - draftOrderCreate: https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/draftOrderCreate
 * - draftOrderDelete: https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/draftOrderDelete
 * - DraftOrder: https://shopify.dev/docs/api/admin-graphql/2026-10/objects/DraftOrder
 * - Order: https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Order
 * - webhookSubscriptionCreate: https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/webhookSubscriptionCreate
 *   (`includeFields`: https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/WebhookSubscriptionInput;
 *   https://shopify.dev/docs/api/admin-graphql/2026-10/objects/WebhookSubscription)
 * - webhookSubscriptionDelete: https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/webhookSubscriptionDelete
 */

export const SHOP: Doc = {
  name: "InboxShop",
  cost: 5,
  text: `query InboxShop {
  shop { id name myshopifyDomain currencyCode taxesIncluded primaryDomain { url } plan { partnerDevelopment } }
  currentAppInstallation { accessScopes { handle } }
}`,
};

/**
 * A variant as the catalogue reads it, with its barcode and its own picture (ADR-029). `barcode` and
 * `image` are deprecated in 2026-10 for `barcodes` and `media`, and still answered.
 */
const VARIANT = `id title sku barcode price availableForSale inventoryQuantity inventoryPolicy inventoryItem { tracked } image { url }`;

/** A product as the catalogue reads it: its maker (`vendor`), its page on the shop and its picture. */
const PRODUCT = `id title status description(truncateAt: 500) vendor onlineStoreUrl featuredImage { url }`;

/**
 * One page of variants: every one (a full pass), or those changed since (`updated_at:>…`). 100 at 5
 * each (the variant, its inventory item and picture, its product and the product's picture), plus 2.
 */
export const VARIANTS: Doc = {
  name: "InboxVariants",
  cost: 502,
  text: `query InboxVariants($first: Int!, $after: String, $query: String) {
  productVariants(first: $first, after: $after, query: $query, sortKey: ID) {
    nodes { ${VARIANT} product { ${PRODUCT} } }
    pageInfo { hasNextPage endCursor }
  }
}`,
};

/**
 * Products changed since, with their variants: a product's own change (taken off sale, renamed) is
 * not always a change of its variants. At most 25 variants each here; a full pass reads the rest. 10
 * products at 79 each (the product, its picture, and 25 variants at 3 with their connection's 2), plus 2.
 */
export const PRODUCTS_CHANGED: Doc = {
  name: "InboxProductsChanged",
  cost: 792,
  text: `query InboxProductsChanged($first: Int!, $after: String, $query: String!) {
  products(first: $first, after: $after, query: $query, sortKey: ID) {
    nodes { ${PRODUCT} variants(first: 25) { nodes { ${VARIANT} } } }
    pageInfo { hasNextPage endCursor }
  }
}`,
};

const ORDER = `id name test tags cancelledAt displayFinancialStatus displayFulfillmentStatus fullyPaid processedAt
    paymentGatewayNames legacyResourceId
    totalReceivedSet { presentmentMoney { amount currencyCode } }
    totalRefundedSet { presentmentMoney { amount currencyCode } }
    fulfillments(first: 5) { status displayStatus deliveredAt createdAt trackingInfo(first: 1) { company number url } }`;

const DRAFT = `id name status ready invoiceUrl legacyResourceId tags
    totalPriceSet { presentmentMoney { amount currencyCode } }
    order { ${ORDER} }`;

export const DRAFT_CREATE: Doc = {
  name: "InboxDraftCreate",
  cost: 20,
  text: `mutation InboxDraftCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { ${DRAFT} }
    userErrors { field message }
  }
}`,
};

export const DRAFT_READ: Doc = {
  name: "InboxDraft",
  cost: 12,
  text: `query InboxDraft($id: ID!) {
  draftOrder(id: $id) { ${DRAFT} }
}`,
};

/** The inbox's own draft for one link, by the tag it put on it. */
export const DRAFT_FIND: Doc = {
  name: "InboxDraftFind",
  cost: 15,
  text: `query InboxDraftFind($query: String!) {
  draftOrders(first: 1, query: $query) { nodes { ${DRAFT} } }
}`,
};

/** The inbox's latest completed drafts and the orders they became, for an order whose tags say nothing. */
export const DRAFTS_COMPLETED: Doc = {
  name: "InboxDraftsCompleted",
  cost: 77,
  text: `query InboxDraftsCompleted {
  draftOrders(first: 25, query: "tag:inbox status:completed", sortKey: ID, reverse: true) {
    nodes { id tags order { id } }
  }
}`,
};

export const DRAFT_DELETE: Doc = {
  name: "InboxDraftDelete",
  cost: 10,
  text: `mutation InboxDraftDelete($input: DraftOrderDeleteInput!) {
  draftOrderDelete(input: $input) { deletedId userErrors { field message } }
}`,
};

export const ORDER_READ: Doc = {
  name: "InboxOrder",
  cost: 12,
  text: `query InboxOrder($id: ID!) {
  order(id: $id) { ${ORDER} }
}`,
};

export const HOOKS: Doc = {
  name: "InboxHooks",
  cost: 52,
  text: `query InboxHooks {
  webhookSubscriptions(first: 50) { nodes { id topic uri includeFields } }
}`,
};

export const HOOK_CREATE: Doc = {
  name: "InboxHookCreate",
  cost: 10,
  text: `mutation InboxHookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id topic uri includeFields }
    userErrors { field message }
  }
}`,
};

export const HOOK_DELETE: Doc = {
  name: "InboxHookDelete",
  cost: 10,
  text: `mutation InboxHookDelete($id: ID!) {
  webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } }
}`,
};
