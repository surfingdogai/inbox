/**
 * Answers of the food connectors' platforms (ADR-040), transcribed from what each publishes, trimmed to
 * the fields the connectors read. Ids and keys are made up (or the documents' own examples); no test
 * calls a real account.
 *
 * - GloriaFood: https://github.com/GlobalFood/integration_docs/blob/master/fetch_menu/payload/menu.json
 *   and .../accepted_orders/payload/json/EU_tax_model_order.json (read 21 Oct 2026). The menu's prices
 *   and currency are the document's; the order's client fields are the document's made-up ones, kept to
 *   prove none is kept.
 * - Flipdish: the Open API v1.0 document at https://api.flipdish.co/swagger/docs/v1.0 (Store, Menu,
 *   BusinessHoursPeriod, BusinessHoursOverride, RestApiResult wrappers).
 * - Toast: the OpenAPI documents behind https://doc.toasttab.com/openapi/ (authentication, partners,
 *   menus v2, orders v2, configuration v2).
 * - Lightspeed K-Series: https://api-docs.lsk.lightspeed.app/source.json (businesses, menu v2, to-go order).
 * - Clover: https://docs.clover.com/dev/docs/managing-modifier-groups-modifiers (items with
 *   `elements`, prices in the minor unit) and .../create-an-atomic-order.
 * - Deliverect: https://developers.deliverect.com/v3.0-ordering-experience/reference/channel_order_status
 *   and the order statuses page.
 */

/* --- GloriaFood --------------------------------------------------------------------- */

export const GLORIA_MENU_KEY = "8yCPCvb3dDo1k";
export const GLORIA_ORDERS_KEY = "pollKey-1234567";
export const GLORIA_MASTER_KEY = "e6fIguVkyG5xtT3BYGMI4rfm9iVt24YJ";

export const GLORIA_MENU = {
  id: 4108,
  restaurant_id: 4172,
  active: true,
  currency: "USD",
  categories: [
    {
      id: 14937,
      menu_id: 4108,
      name: "Pizza",
      active: true,
      items: [
        {
          id: 58424,
          menu_category_id: 14937,
          name: "Pizza Margherita",
          description: "(tomato sauce, cheese)",
          price: 7,
          active: true,
          tags: ["VEGETARIAN"],
          extras: { menu_item_order_types: ["pickup", "delivery"] },
          sizes: [
            {
              id: 37086,
              menu_item_id: 58424,
              name: "Small",
              price: 0,
              default: true,
              groups: [
                {
                  id: 16978,
                  menu_id: 4108,
                  name: "Extra Toppings (Small)",
                  required: false,
                  force_min: 1,
                  force_max: 1,
                  allow_quantity: false,
                  options: [
                    { id: 51188, option_group_id: 16978, name: "Corn", price: 0.7, default: false, extras: null },
                    {
                      id: 51189,
                      option_group_id: 16978,
                      name: "Extra mozzarella",
                      price: 1.2,
                      default: false,
                      extras: null,
                    },
                  ],
                },
              ],
            },
            { id: 37089, menu_item_id: 58424, name: "Large", price: 2, default: false, groups: [] },
          ],
          groups: [],
        },
      ],
      groups: [
        {
          id: 16977,
          menu_id: 4108,
          name: "Crust",
          required: true,
          force_min: 1,
          force_max: 1,
          allow_quantity: false,
          options: [
            { id: 51186, option_group_id: 16977, name: "Fluffy", price: 0, default: true, extras: null },
            { id: 51187, option_group_id: 16977, name: "Crispy", price: 0, default: false, extras: null },
          ],
        },
      ],
    },
    {
      id: 14938,
      menu_id: 4108,
      name: "Pasta",
      active: true,
      items: [
        {
          id: 58426,
          menu_category_id: 14938,
          name: "Spaghetti Bolognese",
          description: "",
          price: 9,
          active: true,
          sizes: [],
          groups: [],
          extras: {
            sku: "",
            menu_item_allergens_ids: [1, 3, 7, 8, 4],
            menu_item_allergens_values: [
              { id: 1, name: "Milk" },
              { id: 3, name: "Eggs" },
              { id: 7, name: "Shellfish" },
              { id: 8, name: "Soybeans" },
              { id: 4, name: "Peanuts" },
            ],
          },
        },
      ],
      groups: [],
    },
  ],
};

export const GLORIA_ORDERS = {
  count: 1,
  orders: [
    {
      id: 6819,
      total_price: 41.14,
      sub_total_price: 27.4,
      client_first_name: "John",
      client_last_name: "Doe",
      client_email: "john.doe@gmail.com",
      client_phone: "+12126871225",
      client_address: "Main street 5, Dublin",
      latitude: "53.32016595583847",
      longitude: "-6.394491487835694",
      client_ip_address: "127.0.0.1",
      currency: "EUR",
      type: "delivery",
      status: "accepted",
      accepted_at: "2019-05-29T14:51:52.000Z",
      fulfill_at: "2019-05-29T15:46:52.000Z",
      for_later: false,
      api_version: 2,
      items: [
        {
          id: 27187,
          name: "DELIVERY_FEE",
          total_item_price: 10,
          price: 10,
          quantity: 1,
          type: "delivery_fee",
          options: [],
        },
        {
          id: 27188,
          name: "Pizza Margherita",
          total_item_price: 9,
          price: 7,
          quantity: 1,
          type: "item",
          options: [{ id: 1, name: "Large", group_name: "Size", type: "size", quantity: 1, price: 2 }],
        },
      ],
    },
  ],
};

/* --- Flipdish ------------------------------------------------------------------------- */

export const FLIPDISH_CLIENT_ID = "pizzeria-volcan-app";
export const FLIPDISH_SECRET = "flipdish-secret-key-0001";

export const FLIPDISH_STORE = {
  StoreId: 18452,
  Name: "Pizzería Volcán Roma Norte",
  MenuId: 90311,
  IanaTimeZone: "America/Mexico_City",
  Currency: "MXN",
  PickupHours: [
    { DayOfWeek: "Monday", StartTime: "12:00", Period: "10:00" },
    { DayOfWeek: "Friday", StartTime: "12:00:00", Period: "12:00:00" },
    { DayOfWeek: "Saturday", StartTime: "13:00", Period: "1.00:00:00" },
  ],
};

export const FLIPDISH_MENU = {
  MenuId: 90311,
  Name: "Carta",
  MenuSections: [
    {
      MenuSectionId: 1,
      Name: "Pizzas",
      IsAvailable: true,
      IsHiddenFromCustomers: false,
      MenuItems: [
        {
          MenuItemId: 501,
          Name: "Pizza al pastor",
          Description: "Pastor, piña, cilantro",
          Price: 189,
          IsAvailable: true,
          MenuItemOptionSets: [
            {
              MenuItemOptionSetId: 71,
              Name: "Tamaño",
              MinSelectCount: 1,
              MaxSelectCount: 1,
              MenuItemOptionSetItems: [
                { MenuItemOptionSetItemId: 9001, Name: "Chica", Price: 0, IsAvailable: true },
                { MenuItemOptionSetItemId: 9002, Name: "Grande", Price: 60, IsAvailable: true },
              ],
            },
          ],
        },
      ],
    },
    { MenuSectionId: 2, Name: "Oculto", IsAvailable: true, IsHiddenFromCustomers: true, MenuItems: [] },
  ],
};

/* --- Toast ---------------------------------------------------------------------------- */

export const TOAST_HOST = "https://ws-sandbox-api.eng.toasttab.com";
export const TOAST_PARTNER = {
  clientId: "toast-partner-client",
  clientSecret: "toast-partner-secret",
  apiHost: TOAST_HOST,
};
export const TOAST_RESTAURANT = "e2b6c5a6-0f4c-4a61-9b0d-3d0c2f6e1a01";

export const TOAST_MENUS = {
  restaurantGuid: TOAST_RESTAURANT,
  restaurantTimeZone: "America/Mexico_City",
  menus: [
    {
      name: "Comida",
      menuGroups: [
        {
          name: "Pizzas",
          guid: "11111111-0000-4000-8000-000000000001",
          menuItems: [
            {
              guid: "22222222-0000-4000-8000-000000000001",
              name: "Pizza diavola",
              description: "Salami picante",
              price: 199,
              modifierGroupReferences: [1],
            },
          ],
          menuGroups: [],
        },
      ],
    },
  ],
  modifierGroupReferences: {
    "1": {
      guid: "33333333-0000-4000-8000-000000000001",
      name: "Orilla",
      minSelections: 0,
      maxSelections: 1,
      modifierOptionReferences: [10],
    },
  },
  modifierOptionReferences: {
    "10": { guid: "44444444-0000-4000-8000-000000000001", name: "Orilla rellena", price: 35, isDefault: false },
  },
};

/* --- Deliverect ----------------------------------------------------------------------- */

export const DELIVERECT_PARTNER = {
  clientId: "dlv-client",
  clientSecret: "dlv-secret",
  channel: "surfingdog",
  staging: true,
};
export const DELIVERECT_LINK = "5f8a7b6c5d4e3f2a1b0c9d8e";
