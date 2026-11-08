import { beforeEach, describe, expect, it } from "vitest";
import { visitorAccess } from "../src/access.ts";
import { getCreator, getPayment, getSubscription, getVisitor, openDb, type Db } from "../src/db.ts";
import { createHandler } from "../src/handlers.ts";
import type { StripeEvent } from "../src/kit/events.ts";
import { event, FakeStripe, invoiceObj, seedCreator, sub } from "./helpers.ts";

const V = "v_aaaaaaaaaaaaaaaa";
let db: Db;
let stripe: FakeStripe;
let handle: ReturnType<typeof createHandler>;
const open = () => visitorAccess(db, V, "c_seed_mara").state;
const run = (e: object) => handle(e as StripeEvent);

beforeEach(() => {
  db = openDb(":memory:");
  seedCreator(db);
  stripe = new FakeStripe();
  handle = createHandler(db, stripe);
});

describe("subscribe and unlock", () => {
  it("checkout.session.completed links the visitor, stores email and syncs the subscription from Stripe", async () => {
    stripe.subs.set("sub_1", sub());
    await run(event("checkout.session.completed", { id: "cs_1", mode: "subscription", client_reference_id: V, customer: "cus_1", subscription: "sub_1", customer_details: { email: "m@example.com" } }));
    expect(getVisitor(db, V)).toMatchObject({ customer_id: "cus_1", email: "m@example.com" });
    expect(getSubscription(db, "sub_1")).toMatchObject({ visitor_id: V, creator_id: "c_seed_mara", status: "active" });
    expect(open().open).toBe(true);
  });

  it("one-time checkout sessions are ignored", async () => {
    expect(await run(event("checkout.session.completed", { id: "cs_2", mode: "payment" }))).toBe("ignored");
  });

  it("invoice.paid records the 80/20 split from the charge", async () => {
    stripe.subs.set("sub_1", sub());
    stripe.splits.set("pi_1", { chargeId: "ch_1", amountCents: 800, applicationFeeCents: 160, transferId: "tr_1", transferCents: 640 });
    await run(event("invoice.paid", invoiceObj()));
    expect(getPayment(db, "in_1")).toMatchObject({ status: "paid", amount_cents: 800, application_fee_cents: 160, transfer_cents: 640, transfer_id: "tr_1", charge_id: "ch_1", creator_id: "c_seed_mara", subscription_id: "sub_1" });
    expect(open().open).toBe(true);
  });

  it("invoice.paid without `payments` in the body (as Stripe sends it) reads the PaymentIntent from Stripe", async () => {
    stripe.subs.set("sub_1", sub());
    stripe.invoicePis.set("in_1", "pi_1");
    stripe.splits.set("pi_1", { chargeId: "ch_1", amountCents: 800, applicationFeeCents: 160, transferId: "tr_1", transferCents: 640 });
    const { payments: _omit, ...body } = invoiceObj();
    await run(event("invoice.paid", body));
    expect(getPayment(db, "in_1")).toMatchObject({ payment_intent: "pi_1", transfer_cents: 640 });
  });

  it("a subscription event without visitor metadata falls back to the customer's visitor", async () => {
    db.prepare("INSERT INTO visitors (id, created_at, customer_id) VALUES (?, 0, 'cus_1')").run(V);
    stripe.subs.set("sub_1", sub({ visitorId: null }));
    await run(event("customer.subscription.created", { id: "sub_1" }));
    expect(getSubscription(db, "sub_1")?.visitor_id).toBe(V);
  });
});

describe("relock", () => {
  beforeEach(async () => {
    stripe.subs.set("sub_1", sub());
    await run(event("invoice.paid", invoiceObj()));
    expect(open().open).toBe(true);
  });

  it("invoice.payment_failed locks (Stripe now reports past_due) and a later invoice.paid unlocks", async () => {
    stripe.subs.set("sub_1", sub({ status: "past_due", latestInvoiceId: "in_2", latestInvoiceStatus: "open", latestPaymentIntent: "pi_2" }));
    await run(event("invoice.payment_failed", invoiceObj({ id: "in_2", pi: "pi_2", status: "open" })));
    expect(getPayment(db, "in_2")?.status).toBe("failed");
    expect(open()).toEqual({ open: false, reason: "payment_failed" });

    stripe.subs.set("sub_1", sub({ latestInvoiceId: "in_2", latestPaymentIntent: "pi_2" }));
    await run(event("invoice.paid", invoiceObj({ id: "in_2", pi: "pi_2" })));
    expect(getPayment(db, "in_2")?.status).toBe("paid");
    expect(open().open).toBe(true);
  });

  it("charge.refunded (full) locks even while Stripe still says active", async () => {
    await run(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 800, amount_refunded: 800, refunded: true }));
    expect(open()).toEqual({ open: false, reason: "refunded" });
  });

  it("a partial refund keeps access", async () => {
    await run(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 800, amount_refunded: 200, refunded: false }));
    expect(open().open).toBe(true);
  });

  it("customer.subscription.deleted locks", async () => {
    stripe.subs.set("sub_1", sub({ status: "canceled", canceledAt: 1 }));
    await run(event("customer.subscription.deleted", { id: "sub_1", status: "canceled" }));
    expect(open()).toEqual({ open: false, reason: "canceled" });
  });

  it("a later $0 invoice (no payment) keeps the paying payment, so its refund still locks", async () => {
    stripe.subs.set("sub_1", sub({ latestInvoiceId: "in_0", latestPaymentIntent: null }));
    await run(event("customer.subscription.updated", { id: "sub_1" }));
    expect(getSubscription(db, "sub_1")?.latest_payment_intent).toBe("pi_1");
    await run(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 800, amount_refunded: 800, refunded: true }));
    expect(open().reason).toBe("refunded");
  });

  it("cancel at period end keeps access until the period ends", async () => {
    stripe.subs.set("sub_1", sub({ cancelAtPeriodEnd: true }));
    await run(event("customer.subscription.updated", { id: "sub_1" }));
    expect(open()).toMatchObject({ open: true, reason: "ending" });
  });
});

describe("out-of-order and repeated delivery", () => {
  it("state comes from Stripe, not the event body: a stale 'updated: active' after 'deleted' cannot reopen access", async () => {
    stripe.subs.set("sub_1", sub({ status: "canceled" }));
    await run(event("customer.subscription.deleted", { id: "sub_1", status: "canceled" }));
    // the older event arrives last, carrying an old "active" body
    await run(event("customer.subscription.updated", { id: "sub_1", status: "active" }, { created: 1 }));
    expect(getSubscription(db, "sub_1")?.status).toBe("canceled");
    expect(open().open).toBe(false);
  });

  it("deleted delivered before created ends canceled", async () => {
    stripe.subs.set("sub_1", sub({ status: "canceled" }));
    await run(event("customer.subscription.deleted", { id: "sub_1" }));
    await run(event("customer.subscription.created", { id: "sub_1" }));
    expect(open().open).toBe(false);
  });

  it("a late invoice.payment_failed never downgrades a paid invoice", async () => {
    stripe.subs.set("sub_1", sub());
    await run(event("invoice.paid", invoiceObj()));
    await run(event("invoice.payment_failed", invoiceObj({ status: "open" })));
    expect(getPayment(db, "in_1")?.status).toBe("paid");
  });

  it("refund delivered before invoice.paid still locks once the payment arrives", async () => {
    stripe.subs.set("sub_1", sub());
    await run(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 800, amount_refunded: 800, refunded: true }));
    await run(event("invoice.paid", invoiceObj()));
    expect(open()).toEqual({ open: false, reason: "refunded" });
  });

  it("a smaller, older refund amount never shrinks a bigger one", async () => {
    stripe.subs.set("sub_1", sub());
    await run(event("invoice.paid", invoiceObj()));
    await run(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 800, amount_refunded: 800, refunded: true }));
    await run(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 800, amount_refunded: 300, refunded: false }));
    expect(open().reason).toBe("refunded");
  });

  it("the same event handled twice gives the same rows (handlers are upserts)", async () => {
    stripe.subs.set("sub_1", sub());
    const e = event("invoice.paid", invoiceObj());
    await run(e);
    await run(e);
    expect(db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM subscriptions").get()).toEqual({ n: 1 });
  });

  it("a Stripe read failure throws so the delivery is retried", async () => {
    stripe.failNextGetSubscription = true;
    await expect(run(event("customer.subscription.updated", { id: "sub_1" }))).rejects.toThrow("stripe unavailable");
  });
});

describe("guards and Connect", () => {
  it("refuses live-mode events", async () => {
    await expect(run(event("invoice.paid", invoiceObj(), { livemode: true }))).rejects.toThrow(/live-mode/);
  });

  it("unknown event types are acknowledged and ignored", async () => {
    expect(await run(event("customer.created", { id: "cus_1" }))).toBe("ignored");
  });

  it("account.updated re-reads the account and opens the creator for members", async () => {
    db.prepare("UPDATE creators SET details_submitted = 0, transfers_active = 0, payouts_enabled = 0").run();
    stripe.accounts.set("acct_mara", { detailsSubmitted: true, transfersActive: true, payoutsEnabled: true });
    expect(await run(event("account.updated", { id: "acct_mara", charges_enabled: false }))).toBe("applied");
    expect(getCreator(db, "c_seed_mara")).toMatchObject({ details_submitted: 1, transfers_active: 1, payouts_enabled: 1 });
  });

  it("account.updated for an account this platform doesn't know is ignored", async () => {
    expect(await run(event("account.updated", { id: "acct_other" }))).toBe("ignored");
  });
});
