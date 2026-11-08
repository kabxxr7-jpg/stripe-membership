import { getRefund, subscriptionForVisitorCreator, type Db, type SubscriptionRow } from "./db.ts";

export type AccessState =
  | { open: true; reason: "active" | "trialing" | "ending"; until: number }
  | { open: false; reason: "none" | "payment_failed" | "refunded" | "canceled" | "expired" | "incomplete" | "paused" };

/**
 * The single access rule. Access is open only when ALL of these hold:
 *  - Stripe says the subscription is `active` or `trialing` (so `past_due`, `unpaid`, `incomplete`,
 *    `canceled`, `paused` are closed),
 *  - the paid-through date (`current_period_end`) is still in the future,
 *  - the payment that paid for the current period has not been fully refunded.
 * A subscription set to cancel at period end keeps access until that date ("ending").
 */
export function accessFor(sub: SubscriptionRow | undefined, nowSec: number, isRefunded: (pi: string) => boolean): AccessState {
  if (!sub) return { open: false, reason: "none" };
  switch (sub.status) {
    case "past_due":
    case "unpaid":
      return { open: false, reason: "payment_failed" };
    case "incomplete":
    case "incomplete_expired":
      return { open: false, reason: "incomplete" };
    case "canceled":
      return { open: false, reason: sub.latest_payment_intent && isRefunded(sub.latest_payment_intent) ? "refunded" : "canceled" };
    case "paused":
      return { open: false, reason: "paused" };
    case "active":
    case "trialing":
      break;
    default:
      return { open: false, reason: "none" };
  }
  if (sub.latest_payment_intent && isRefunded(sub.latest_payment_intent)) return { open: false, reason: "refunded" };
  if (sub.latest_invoice_status && sub.latest_invoice_status !== "paid" && sub.status !== "trialing") {
    return { open: false, reason: "payment_failed" };
  }
  if (!sub.current_period_end || sub.current_period_end <= nowSec) return { open: false, reason: "expired" };
  if (sub.cancel_at_period_end) return { open: true, reason: "ending", until: sub.current_period_end };
  return { open: true, reason: sub.status === "trialing" ? "trialing" : "active", until: sub.current_period_end };
}

export function refundChecker(db: Db): (pi: string) => boolean {
  return (pi) => (getRefund(db, pi)?.fully_refunded ?? 0) === 1;
}

/** Access for one visitor to one creator: open if any of their subscriptions to that creator is open. */
export function visitorAccess(db: Db, visitorId: string | null, creatorId: string, nowSec = Math.floor(Date.now() / 1000)): { state: AccessState; sub: SubscriptionRow | undefined } {
  if (!visitorId) return { state: { open: false, reason: "none" }, sub: undefined };
  const subs = subscriptionForVisitorCreator(db, visitorId, creatorId);
  const check = refundChecker(db);
  for (const s of subs) {
    const st = accessFor(s, nowSec, check);
    if (st.open) return { state: st, sub: s };
  }
  const latest = subs[0];
  return { state: accessFor(latest, nowSec, check), sub: latest };
}

export const ACCESS_LABEL: Record<AccessState["reason"], string> = {
  active: "Active",
  trialing: "Trial",
  ending: "Cancels at period end",
  none: "Not a member",
  payment_failed: "Payment failed: locked",
  refunded: "Refunded: locked",
  canceled: "Cancelled: locked",
  expired: "Expired: locked",
  incomplete: "Payment incomplete",
  paused: "Paused",
};
