import { createHash } from "node:crypto"
import { LEGACY_EVENT_TYPES, TRANSACTION_TYPENAMES } from "./query"

// One Partner API event node -> one row. Anything that is not a usable event becomes
// null, so a single odd node cannot stop a sync.

export type ParsedEvent = {
  id: string
  occurredAt: Date
  type: string
  appGid: string | null
  appName: string | null
  appApiKey: string | null
  shop: string | null
  shopGid: string | null
  state: string | null
  reason: string | null
  reasonDescription: string | null
  planHandle: string | null
  billingPeriod: string | null
  trialDays: number | null
  /** Trial days left at the time of the event: shorter than trialDays for a merchant who used part of a trial before. */
  trialDaysRemaining: number | null
  /** When a canceled subscription actually ends (Shopify's cancelEffectiveOn), at the start of that UTC day. */
  cancelEffectiveOn: Date | null
  amountCents: number | null
  currency: string | null
  grossCents: number | null
  netCents: number | null
  feeCents: number | null
  chargeId: string | null
  payload: Record<string, unknown>
}

function cents(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/** A Date scalar ("2026-02-10") or a timestamp, as the start of that UTC day. */
function day(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  return v ? v.slice(0, max) : null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseEventNode(node: any): ParsedEvent | null {
  if (!node || typeof node.id !== "string" || typeof node.eventType !== "string") return null
  const occurredAt = new Date(node.occurredAt)
  if (Number.isNaN(occurredAt.getTime())) return null

  const subject = node.subject ?? null
  const plan = node.plan ?? null
  const flatPrice = Array.isArray(plan?.prices) ? plan.prices.find((p: { amount?: unknown }) => p && p.amount != null) : null
  const money = node.amount ?? node.money ?? null

  return {
    id: node.id,
    occurredAt,
    type: node.eventType,
    appGid: typeof subject?.id === "string" ? subject.id : null,
    appName: text(subject?.name, 200),
    appApiKey: text(subject?.apiKey, 100),
    shop: text(node.shop?.myshopifyDomain, 255)?.toLowerCase() ?? null,
    shopGid: text(node.shop?.id, 100),
    state: text(node.relationshipState ?? node.subscriptionState ?? node.status, 60),
    reason: text(node.reason, 200),
    reasonDescription: text(node.reasonDescription, 1000),
    planHandle: text(node.planHandle ?? plan?.handle, 120),
    billingPeriod: text(plan?.billingPeriod, 40),
    trialDays: Number.isInteger(plan?.trialDays) ? plan.trialDays : null,
    trialDaysRemaining: Number.isInteger(plan?.trialDaysRemaining) ? plan.trialDaysRemaining : null,
    cancelEffectiveOn: day(node.cancelEffectiveOn),
    amountCents: cents(money?.amount) ?? cents(flatPrice?.amount),
    currency: text(money?.currencyCode ?? flatPrice?.currencyCode ?? node.grossAmount?.currencyCode, 8),
    grossCents: cents(node.grossAmount?.amount),
    netCents: cents(node.netAmount?.amount),
    feeCents: cents(node.shopifyFee?.amount),
    chargeId: text(node.chargeId ?? node.earningChargeId, 100),
    payload: node as Record<string, unknown>,
  }
}

/** The number at the end of a gid, which gid://partners/App/1 and gid://shopify/App/1 share. */
const gidNumber = (gid: unknown): string | null => (typeof gid === "string" ? (/\/(\d+)$/.exec(gid)?.[1] ?? null) : null)

/** A transaction that names another app than the one it was read for. Its rows would be filed under the wrong app. */
export class ForeignTransactionError extends Error {}

/**
 * One transaction of Shopify's payout ledger -> one row, filed under the app it was read for, with
 * the type it is stored under (APP_SUBSCRIPTION_SALE, APP_SALE_CREDIT, ...). netCents is what was
 * added to or taken off your payout; grossCents and feeCents are as Shopify sent them, signs
 * included, and derive() reads them. A type that was not asked for is skipped. A transaction that
 * names another app throws, because filing it here would count another app's money.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseTransactionNode(node: any, appGid: string): ParsedEvent | null {
  if (!node || typeof node.id !== "string" || typeof node.__typename !== "string") return null
  const type = TRANSACTION_TYPENAMES[node.__typename]
  if (!type) return null
  const occurredAt = new Date(node.createdAt)
  if (Number.isNaN(occurredAt.getTime())) return null
  const netCents = cents(node.netAmount?.amount)
  if (netCents === null) return null

  const named = gidNumber(node.app?.id)
  if (named !== null && named !== gidNumber(appGid)) throw new ForeignTransactionError(`Partner API returned a transaction of app ${named} when asked for app ${gidNumber(appGid)}`)

  const shop = text(node.shop?.myshopifyDomain, 255)?.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") || null
  return {
    id: `transaction:${node.id}`,
    occurredAt,
    type,
    appGid,
    appName: null,
    appApiKey: null,
    shop,
    shopGid: text(node.shop?.id, 100),
    state: null,
    reason: null,
    reasonDescription: null,
    planHandle: null,
    billingPeriod: null,
    trialDays: null,
    trialDaysRemaining: null,
    cancelEffectiveOn: null,
    amountCents: null,
    currency: text(node.netAmount?.currencyCode ?? node.grossAmount?.currencyCode, 8),
    grossCents: cents(node.grossAmount?.amount),
    netCents,
    feeCents: cents(node.shopifyFee?.amount),
    chargeId: text(node.chargeId, 100),
    payload: node as Record<string, unknown>,
  }
}

const LEGACY_TYPES: ReadonlySet<string> = new Set(LEGACY_EVENT_TYPES)

/**
 * One node of the older App.events -> one row, filed under the app it was read for. These
 * events have no id, so the id is made from what tells one apart: its type, time, shop and
 * charge. Reading it again gives the same id, so it is stored once. A type that was not
 * asked for is skipped: an install read here would be counted twice.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseLegacyEventNode(node: any, appGid: string): ParsedEvent | null {
  if (!node || typeof node.type !== "string" || !LEGACY_TYPES.has(node.type)) return null
  const occurredAt = new Date(node.occurredAt)
  if (Number.isNaN(occurredAt.getTime())) return null

  // Shopify types this domain as a Url, so a scheme is dropped should one ever come.
  const shop = text(node.shop?.myshopifyDomain, 255)?.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") || null
  const charge = node.charge ?? null
  const chargeId = text(charge?.id, 100)
  const key = [node.type, occurredAt.toISOString(), shop ?? "", chargeId ?? ""].join("|")

  return {
    id: `legacy:${createHash("sha256").update(key).digest("hex")}`,
    occurredAt,
    type: node.type,
    appGid,
    appName: null,
    appApiKey: null,
    shop,
    shopGid: text(node.shop?.id, 100),
    state: null,
    reason: null,
    reasonDescription: null,
    planHandle: null,
    billingPeriod: null,
    trialDays: null,
    trialDaysRemaining: null,
    cancelEffectiveOn: null,
    amountCents: cents(charge?.amount?.amount),
    currency: text(charge?.amount?.currencyCode, 8),
    grossCents: null,
    netCents: null,
    feeCents: null,
    chargeId,
    payload: node as Record<string, unknown>,
  }
}
