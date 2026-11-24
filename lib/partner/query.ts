// The two GraphQL queries this app sends to Shopify's Partner API. The first reads the
// organization's event history: installs, uninstalls, subscription changes, charges,
// earnings and credits. The second reads what only the older App.events reports: what
// merchants did on the billing screen. Nothing here can change anything on Shopify's side.
//
// Both were checked against the Partner API 2026-07 schema. `state` and `chargeId` mean
// different types on different event kinds, hence the aliases. 2026-10 is not in the
// Partner schema list yet, so connections default to 2026-07 and can be changed.
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
