import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { signStripePayload, verifyStripeSignature } from "../src/kit/verify.ts";

const stripe = new Stripe("sk_test_unused");
const secret = "whsec_cross_check";
const body = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", created: 1, data: { object: {} } });

describe("signature check agrees with the official stripe package", () => {
  it("a header made by Stripe's own helper verifies here", () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    expect(verifyStripeSignature({ secret, header, body })).toMatchObject({ ok: true });
  });
  it("a header made here verifies with Stripe's constructEvent", () => {
    const header = signStripePayload({ secret, body, timestampSeconds: Math.floor(Date.now() / 1000) });
    expect(stripe.webhooks.constructEvent(body, header, secret).id).toBe("evt_1");
  });
  it("both reject a modified body", () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    const changed = body.replace("evt_1", "evt_2");
    expect(verifyStripeSignature({ secret, header, body: changed })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(() => stripe.webhooks.constructEvent(changed, header, secret)).toThrow();
  });
});
