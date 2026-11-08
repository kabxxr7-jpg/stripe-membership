import { describe, expect, it } from "vitest";
import { accessFor } from "../src/access.ts";
import type { SubscriptionRow } from "../src/db.ts";

const now = 1_800_000_000;
const row = (o: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: "sub_1", visitor_id: "v", creator_id: "c", customer_id: "cus", status: "active", interval: "month", amount_cents: 800,
  current_period_end: now + 86400, cancel_at_period_end: 0, canceled_at: null, latest_invoice_id: "in_1",
  latest_payment_intent: "pi_1", latest_invoice_status: "paid", created_at: now, synced_at: now, ...o,
});
const none = () => false;
const refunded = (pi: string) => pi === "pi_1";

describe("access rule", () => {
  it("no subscription: closed", () => expect(accessFor(undefined, now, none)).toEqual({ open: false, reason: "none" }));
  it("active and paid through the future: open until period end", () =>
    expect(accessFor(row(), now, none)).toEqual({ open: true, reason: "active", until: now + 86400 }));
  it("trialing: open", () => expect(accessFor(row({ status: "trialing", latest_invoice_status: "paid" }), now, none).open).toBe(true));
  it("cancel at period end keeps access until that date", () =>
    expect(accessFor(row({ cancel_at_period_end: 1 }), now, none)).toEqual({ open: true, reason: "ending", until: now + 86400 }));
  it.each(["past_due", "unpaid"])("%s: locked as payment failed", (status) =>
    expect(accessFor(row({ status }), now, none)).toEqual({ open: false, reason: "payment_failed" }));
  it.each(["incomplete", "incomplete_expired"])("%s: locked", (status) => expect(accessFor(row({ status }), now, none).open).toBe(false));
  it("canceled: locked", () => expect(accessFor(row({ status: "canceled" }), now, none)).toEqual({ open: false, reason: "canceled" }));
  it("canceled after a refund reports refunded", () => expect(accessFor(row({ status: "canceled" }), now, refunded).reason).toBe("refunded"));
  it("paused: locked", () => expect(accessFor(row({ status: "paused" }), now, none).reason).toBe("paused"));
  it("active but the paying charge was fully refunded: locked", () =>
    expect(accessFor(row(), now, refunded)).toEqual({ open: false, reason: "refunded" }));
  it("active but the latest invoice is open (renewal not paid yet): locked", () =>
    expect(accessFor(row({ latest_invoice_status: "open" }), now, none).reason).toBe("payment_failed"));
  it("period end in the past: locked as expired", () =>
    expect(accessFor(row({ current_period_end: now - 1 }), now, none).reason).toBe("expired"));
  it("period end exactly now: locked (boundary)", () => expect(accessFor(row({ current_period_end: now }), now, none).open).toBe(false));
  it("unknown status: locked", () => expect(accessFor(row({ status: "something_new" }), now, none).open).toBe(false));
});
