// The one GraphQL query this app sends to Shopify's Partner API. It reads the
// organization's event history: installs, uninstalls, subscription changes, charges,
// earnings and credits. Nothing here can change anything on Shopify's side.
//
// It was checked against the Partner API 2026-07 schema. `state` and `chargeId` mean
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

export const EVENT = {
  INSTALLED: "RELATIONSHIP_INSTALLED",
  UNINSTALLED: "RELATIONSHIP_UNINSTALLED",
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
