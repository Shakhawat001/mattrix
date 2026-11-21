// Plain-language names for what Shopify's API calls things. Unknown values are made readable
// instead of shown raw, so a new event type or uninstall reason still looks fine.

/** "too_expensive" becomes "Too expensive". */
export function humanize(value: string): string {
  const text = value.trim().toLowerCase().replace(/[_\s]+/g, " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const EVENT_LABELS: Record<string, string> = {
  RELATIONSHIP_INSTALLED: "Installed",
  RELATIONSHIP_UNINSTALLED: "Uninstalled",
  RELATIONSHIP_DEACTIVATED: "Store closed",
  RELATIONSHIP_REACTIVATED: "Store reopened",
  SUBSCRIPTION_CREATED: "Subscribed",
  SUBSCRIPTION_UPDATED: "Plan changed",
  SUBSCRIPTION_CANCELED: "Canceled",
  SUBSCRIPTION_CANCELLATION_SCHEDULED: "Cancellation scheduled",
  SUBSCRIPTION_FROZEN: "Frozen",
  SUBSCRIPTION_UNFROZEN: "Unfrozen",
  CHARGE_RECURRING: "Recurring charge",
  CHARGE_ONE_TIME: "One-time charge",
  CHARGE_USAGE: "Usage charge",
  EARNING_CHARGE_RECURRING: "Earnings: recurring",
  EARNING_CHARGE_ONE_TIME: "Earnings: one-time",
  EARNING_CHARGE_USAGE: "Earnings: usage",
  EARNING_REFUND: "Refund",
  EARNING_ADJUSTMENT: "Adjustment",
  EARNING_CREDIT: "Earnings: credit",
  CREDIT_APPLIED: "Credit applied",
  CREDIT_PENDING: "Credit pending",
  CREDIT_FAILED: "Credit failed",
}

export const eventLabel = (type: string): string => EVENT_LABELS[type] ?? humanize(type)

/** An uninstall reason as the survey word, or the placeholder the query uses when there is none. */
export const reasonLabel = (reason: string): string => (reason === "No reason given" ? reason : humanize(reason))
