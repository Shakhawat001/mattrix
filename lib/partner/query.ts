// The three GraphQL queries this app sends to Shopify's Partner API. The first reads the
// organization's event history: installs, uninstalls, subscription changes, charges,
// earnings and credits. The second reads Shopify's payout ledger, the only place that says
// what reached you after every fee. The third reads what only the older App.events reports:
// what merchants did on the billing screen. Nothing here can change anything on Shopify's side.
//
// All three were checked against the Partner API 2026-07 schema; the payout ledger query also
// against Shopify's published schema file for 2026-07, fragment by fragment (its shared fields have
// the same types on all five transaction types, so they merge). `state` and `chargeId` mean
// different types on different event kinds, hence the aliases in the first. Connections default
// to 2026-07 and can be changed.
//
// Docs: https://shopify.dev/docs/api/partner/historical-events

export const DEFAULT_API_VERSION = "2026-07"

export const EVENTS_QUERY = `query AppMetricsEvents($filter: EventFilterInput, $cursor: String) {
  events(filter: $filter, orderBy: OCCURRED_AT_ASC, first: 250, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      cursor
      node {
        id
        occurredAt
        eventType
        shop {
          id
          myshopifyDomain
        }
        subject {
          __typename
          ... on AppReference {
            id
            name
            apiKey
          }
        }
        ... on Relationship {
          relationshipState: state
          reason
          reasonDescription
        }
        ... on SubscriptionStatus {
          subscriptionState: state
          cancelEffectiveOn
          plan {
            handle
            billingPeriod
            trialDays
            trialDaysRemaining
            prices {
              __typename
              currencyCode
              ... on FlatRatePlanPrice {
                amount
              }
            }
          }
        }
        ... on Charge {
          chargeId
          chargeType
          amount {
            amount
            currencyCode
          }
          planHandle
          description
        }
        ... on Earning {
          earningType
          earningChargeId: chargeId
          grossAmount {
            amount
            currencyCode
          }
          netAmount {
            amount
            currencyCode
          }
          shopifyFee {
            amount
            currencyCode
          }
          settlementDate
          description
        }
        ... on Credit {
          status
          money {
            amount
            currencyCode
          }
          description
        }
      }
    }
  }
}`

/** Installs, plan changes and charges: what the "Manage apps" permission covers. */
export const CORE_EVENT_TYPES = [
  "RELATIONSHIP_INSTALLED",
  "RELATIONSHIP_UNINSTALLED",
  "RELATIONSHIP_DEACTIVATED",
  "RELATIONSHIP_REACTIVATED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_CANCELED",
  "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  "SUBSCRIPTION_FROZEN",
  "SUBSCRIPTION_UNFROZEN",
  "CHARGE_ONE_TIME",
  "CHARGE_RECURRING",
  "CHARGE_USAGE",
  "CREDIT_PENDING",
  "CREDIT_APPLIED",
  "CREDIT_FAILED",
] as const

/**
 * Payouts. Read in their own pass: Shopify's documentation disagrees with itself
 * about which permission they need, so a token without it loses the payout numbers
 * and nothing else.
 */
export const EARNING_EVENT_TYPES = [
  "EARNING_CHARGE_ONE_TIME",
  "EARNING_CHARGE_RECURRING",
  "EARNING_CHARGE_USAGE",
  "EARNING_REFUND",
  "EARNING_ADJUSTMENT",
  "EARNING_CREDIT",
] as const

/**
 * The older App.events, read one app at a time. Its events have no id, and its page info has
 * no end cursor: the last edge's cursor asks for the next page. Pages hold 100, the size
 * Shopify's own examples use, since its limit is not documented. `charge` is an AppSubscription
 * or an AppPurchaseOneTime, and both have these fields.
 *
 * Docs: https://shopify.dev/docs/api/partner/2026-07/objects/App#field-App.fields.events
 */
export const LEGACY_EVENTS_QUERY = `query AppMetricsLegacyEvents($appId: ID!, $types: [AppEventTypes!], $occurredAtMin: DateTime, $occurredAtMax: DateTime, $cursor: String) {
  app(id: $appId) {
    events(types: $types, occurredAtMin: $occurredAtMin, occurredAtMax: $occurredAtMax, first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
      }
      edges {
        cursor
        node {
          type
          occurredAt
          shop {
            id
            myshopifyDomain
          }
          ... on AppSubscriptionEvent {
            charge {
              id
              name
              test
              amount {
                amount
                currencyCode
              }
            }
          }
          ... on AppPurchaseOneTimeEvent {
            charge {
              id
              name
              test
              amount {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
}`

/**
 * The billing screen: charges accepted, declined or left to expire, and usage caps. The newer
 * events never report a decline or an expiry. Same SUBSCRIPTION_ prefix as the core types, but
 * derive() leaves them out.
 */
export const LEGACY_EVENT_TYPES = [
  "SUBSCRIPTION_CHARGE_ACCEPTED",
  "SUBSCRIPTION_CHARGE_DECLINED",
  "SUBSCRIPTION_CHARGE_EXPIRED",
  "ONE_TIME_CHARGE_ACCEPTED",
  "ONE_TIME_CHARGE_DECLINED",
  "ONE_TIME_CHARGE_EXPIRED",
  "SUBSCRIPTION_APPROACHING_CAPPED_AMOUNT",
  "SUBSCRIPTION_CAPPED_AMOUNT_UPDATED",
] as const

/**
 * Shopify's payout ledger: one transaction per app sale, credit and adjustment, read one app at a
 * time. It is the only place the Partner API reports what actually reaches your payout. An
 * earning event's netAmount is only "after commission" (Shopify's revenue share), while a
 * transaction's netAmount is "the net amount that is added to or deducted from your payout": the
 * 2.9% processing fee and any regulatory operating fee are taken off too. The fee fields that split
 * those two out exist only in the unstable API version, so the fees are read as gross minus net.
 * Needs the token's View financials permission. Its page info has no end cursor, so the last
 * edge's cursor asks for the next page, as with App.events. Every type is listed with the same
 * fields, since no interface holds them.
 *
 * Docs: https://shopify.dev/docs/api/partner/2026-07/queries/transactions
 */
const TRANSACTION_FIELDS = `
          app {
            id
          }
          chargeId
          shop {
            id
            myshopifyDomain
          }
          grossAmount {
            amount
            currencyCode
          }
          netAmount {
            amount
            currencyCode
          }
          shopifyFee {
            amount
            currencyCode
          }`

export const TRANSACTIONS_QUERY = `query AppMetricsTransactions($appId: ID!, $types: [TransactionType!], $createdAtMin: DateTime, $createdAtMax: DateTime, $cursor: String) {
  transactions(appId: $appId, types: $types, createdAtMin: $createdAtMin, createdAtMax: $createdAtMax, first: 100, after: $cursor) {
    pageInfo {
      hasNextPage
    }
    edges {
      cursor
      node {
        __typename
        id
        createdAt
        ... on AppSubscriptionSale {${TRANSACTION_FIELDS}
        }
        ... on AppOneTimeSale {${TRANSACTION_FIELDS}
        }
        ... on AppUsageSale {${TRANSACTION_FIELDS}
        }
        ... on AppSaleCredit {${TRANSACTION_FIELDS}
        }
        ... on AppSaleAdjustment {${TRANSACTION_FIELDS}
        }
      }
    }
  }
}`

/**
 * The ledger's app transactions, stored under these names as Shopify sends them. Sales are what a
 * merchant paid; a credit is an app credit you gave, and an adjustment is a refund, a downgrade or
 * another correction, each deducted from your payout.
 */
export const TRANSACTION_TYPES = [
  "APP_SUBSCRIPTION_SALE",
  "APP_ONE_TIME_SALE",
  "APP_USAGE_SALE",
  "APP_SALE_CREDIT",
  "APP_SALE_ADJUSTMENT",
] as const

/** The GraphQL type of each transaction, and the name it is stored under. */
export const TRANSACTION_TYPENAMES: Record<string, (typeof TRANSACTION_TYPES)[number]> = {
  AppSubscriptionSale: "APP_SUBSCRIPTION_SALE",
  AppOneTimeSale: "APP_ONE_TIME_SALE",
  AppUsageSale: "APP_USAGE_SALE",
  AppSaleCredit: "APP_SALE_CREDIT",
  AppSaleAdjustment: "APP_SALE_ADJUSTMENT",
}

/** `app(id:)` takes gid://partners/App/123; the newer events, and so the stored apps, name it gid://shopify/App/123. */
export function partnersAppId(gid: string): string {
  const number = /\/App\/(\d+)$/.exec(gid)?.[1]
  return number ? `gid://partners/App/${number}` : gid
}

export const EVENT = {
  INSTALLED: "RELATIONSHIP_INSTALLED",
  UNINSTALLED: "RELATIONSHIP_UNINSTALLED",
  DEACTIVATED: "RELATIONSHIP_DEACTIVATED",
  REACTIVATED: "RELATIONSHIP_REACTIVATED",
  SUB_CREATED: "SUBSCRIPTION_CREATED",
  SUB_UPDATED: "SUBSCRIPTION_UPDATED",
  SUB_CANCELED: "SUBSCRIPTION_CANCELED",
  SUB_CANCELLATION_SCHEDULED: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  SUB_FROZEN: "SUBSCRIPTION_FROZEN",
  SUB_UNFROZEN: "SUBSCRIPTION_UNFROZEN",
  CHARGE_RECURRING: "CHARGE_RECURRING",
  EARNING_REFUND: "EARNING_REFUND",
  CREDIT_APPLIED: "CREDIT_APPLIED",
} as const
