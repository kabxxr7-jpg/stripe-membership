import type { StripeEvent } from "./kit/events.ts";
import type { StripeReads } from "./gateway.ts";
import {
  ensureVisitor, setCreatorAccountStatus, setVisitorCustomer, setVisitorEmail, subscriptionIdForPaymentIntent,
  upsertPayment, upsertRefund, upsertSubscription, visitorByCustomer, type Db,
} from "./db.ts";

export type HandleOutcome = "applied" | "ignored";

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null);
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v)?.["id"]);

/**
 * Turns verified Stripe events into local state.
 *
 * Ordering: Stripe does not promise delivery order, so subscription state is never taken from the
 * event body. Every subscription-related event re-reads the subscription from Stripe and stores
 * that snapshot, so the last write is always Stripe's current truth. Facts that only move one way
 * (an invoice reaching "paid", a refund amount) are merged monotonically in db.ts.
 *
 * A thrown error becomes HTTP 500, so Stripe retries the delivery.
 */
export function createHandler(db: Db, stripe: StripeReads) {
  async function syncSubscription(subId: string): Promise<void> {
    const s = await stripe.getSubscription(subId);
    if (!s) return;
    const visitor = s.visitorId ?? visitorByCustomer(db, s.customerId)?.id ?? null;
    if (visitor) {
      ensureVisitor(db, visitor);
      setVisitorCustomer(db, visitor, s.customerId);
    }
    upsertSubscription(db, {
      id: s.id, visitor_id: visitor, creator_id: s.creatorId, customer_id: s.customerId, status: s.status,
      interval: s.interval, amount_cents: s.amountCents, current_period_end: s.currentPeriodEnd,
      cancel_at_period_end: s.cancelAtPeriodEnd ? 1 : 0, canceled_at: s.canceledAt,
      latest_invoice_id: s.latestInvoiceId, latest_payment_intent: s.latestPaymentIntent, latest_invoice_status: s.latestInvoiceStatus,
    });
  }

  async function recordInvoice(inv: Record<string, unknown>, status: "paid" | "failed"): Promise<string | null> {
    const invoiceId = str(inv["id"]);
    if (!invoiceId) throw new Error("invoice without id");
    const parent = obj(inv["parent"]);
    const subId = idOf(obj(parent?.["subscription_details"])?.["subscription"]) ?? idOf(inv["subscription"]);
    const payments = obj(inv["payments"]);
    const list = Array.isArray(payments?.["data"]) ? (payments["data"] as unknown[]) : [];
    let pi: string | null = null;
    for (const p of list) {
      const pay = obj(obj(p)?.["payment"]);
      if (pay?.["type"] === "payment_intent") pi = idOf(pay["payment_intent"]);
    }
    pi ??= idOf(inv["payment_intent"]);
    if (!pi && status === "paid") pi = await stripe.getInvoicePaymentIntent(invoiceId);
    const meta = obj(obj(parent?.["subscription_details"])?.["metadata"]);
    const split = status === "paid" && pi ? await stripe.getChargeSplit(pi) : null;
    upsertPayment(db, {
      invoice_id: invoiceId,
      subscription_id: subId,
      creator_id: str(meta?.["creator_id"]),
      visitor_id: str(meta?.["visitor_id"]),
      payment_intent: pi,
      charge_id: split?.chargeId ?? null,
      amount_cents: num(status === "paid" ? inv["amount_paid"] : inv["amount_due"]) ?? 0,
      currency: str(inv["currency"]) ?? "usd",
      status,
      application_fee_cents: split?.applicationFeeCents ?? null,
      transfer_cents: split?.transferCents ?? null,
      transfer_id: split?.transferId ?? null,
      billing_reason: str(inv["billing_reason"]),
      created: num(inv["created"]) ?? Math.floor(Date.now() / 1000),
    });
    return subId;
  }

  return async function handle(event: StripeEvent): Promise<HandleOutcome> {
    if (event.livemode === true) throw new Error("live-mode event refused: this demo is test mode only");
    const o = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        if (o["mode"] !== "subscription") return "ignored";
        const visitor = str(o["client_reference_id"]);
        const customer = idOf(o["customer"]);
        const email = str(obj(o["customer_details"])?.["email"]);
        if (visitor) {
          ensureVisitor(db, visitor);
          if (customer) setVisitorCustomer(db, visitor, customer);
          if (email) setVisitorEmail(db, visitor, email);
        }
        const sub = idOf(o["subscription"]);
        if (sub) await syncSubscription(sub);
        return "applied";
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        const sub = str(o["id"]);
        if (!sub) throw new Error("subscription event without id");
        await syncSubscription(sub);
        return "applied";
      }
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const sub = await recordInvoice(o, "paid");
        if (sub) await syncSubscription(sub);
        return "applied";
      }
      case "invoice.payment_failed": {
        const sub = await recordInvoice(o, "failed");
        if (sub) await syncSubscription(sub);
        return "applied";
      }
      case "charge.refunded": {
        const pi = idOf(o["payment_intent"]);
        if (!pi) return "ignored";
        const amount = num(o["amount"]) ?? 0;
        const refunded = num(o["amount_refunded"]) ?? 0;
        upsertRefund(db, { payment_intent: pi, charge_id: str(o["id"]), amount_refunded: refunded, fully_refunded: o["refunded"] === true || (amount > 0 && refunded >= amount) ? 1 : 0 });
        const sub = subscriptionIdForPaymentIntent(db, pi);
        if (sub) await syncSubscription(sub);
        return "applied";
      }
      case "account.updated": {
        const acct = str(o["id"]);
        if (!acct) return "ignored";
        // Re-read rather than trust the body, for the same ordering reason as subscriptions.
        const s = await stripe.getAccountStatus(acct);
        return setCreatorAccountStatus(db, acct, s) > 0 ? "applied" : "ignored";
      }
      default:
        return "ignored";
    }
  };
}
