import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCreator, getSubscription } from "../src/db.ts";
import { assertTestKey, loadConfig } from "../src/config.ts";
import { verifySigned, signId } from "../src/session.ts";
import { CONNECT_SECRET, event, invoiceObj, NOW, seedCreator, startApp, sub } from "./helpers.ts";

const V = "v_aaaaaaaaaaaaaaaa";
let app: Awaited<ReturnType<typeof startApp>>;
beforeEach(async () => { app = await startApp(); seedCreator(app.db); });
afterEach(async () => { await app.close(); });

describe("webhook endpoint", () => {
  it("accepts a correctly signed event and applies it", async () => {
    app.stripe.subs.set("sub_1", sub());
    const r = await app.deliver(event("invoice.paid", invoiceObj()));
    expect(r).toEqual({ status: 200, body: { received: true, status: "ok" } });
    expect(getSubscription(app.db, "sub_1")?.status).toBe("active");
  });

  it("rejects a body changed after signing (raw-body verification)", async () => {
    const r = await app.deliver(event("invoice.paid", invoiceObj()), { tamper: true });
    expect(r.status).toBe(400);
    expect(getSubscription(app.db, "sub_1")).toBeUndefined();
  });

  it("rejects a wrong secret, a missing header and an old timestamp", async () => {
    expect((await app.deliver(event("invoice.paid", invoiceObj()), { secret: "whsec_wrong" })).status).toBe(400);
    expect((await app.deliver(event("invoice.paid", invoiceObj()), { ts: NOW() - 3600 })).status).toBe(400);
    const res = await fetch(`${app.url}/webhooks/stripe`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });

  it("answers a repeated event id as a duplicate without running it again", async () => {
    app.stripe.subs.set("sub_1", sub());
    const e = event("customer.subscription.updated", { id: "sub_1" });
    await app.deliver(e);
    const calls = app.stripe.calls.length;
    const r = await app.deliver(e);
    expect(r.body).toEqual({ received: true, status: "duplicate" });
    expect(app.stripe.calls.length).toBe(calls);
  });

  it("returns 500 when handling fails, and the retry of the same event succeeds", async () => {
    app.stripe.subs.set("sub_1", sub());
    app.stripe.failNextGetSubscription = true;
    const e = event("customer.subscription.updated", { id: "sub_1" });
    expect((await app.deliver(e)).status).toBe(500);
    expect((await app.deliver(e)).body).toEqual({ received: true, status: "ok" });
  });

  it("the Connect endpoint uses its own secret", async () => {
    app.db.prepare("UPDATE creators SET transfers_active = 0").run();
    app.stripe.accounts.set("acct_mara", { detailsSubmitted: true, transfersActive: true, payoutsEnabled: true });
    const e = event("account.updated", { id: "acct_mara" });
    expect((await app.deliver(e, { path: "/webhooks/connect" })).status).toBe(400); // signed with the platform secret
    expect((await app.deliver(e, { path: "/webhooks/connect", secret: CONNECT_SECRET })).status).toBe(200);
    expect(getCreator(app.db, "c_seed_mara")?.transfers_active).toBe(1);
  });

  it("logs every delivery for the admin page", async () => {
    app.stripe.subs.set("sub_1", sub());
    await app.deliver(event("invoice.paid", invoiceObj()));
    await app.deliver(event("invoice.paid", invoiceObj()), { secret: "whsec_wrong" });
    const html = await (await fetch(`${app.url}/admin`)).text();
    expect(html).toContain("invoice.paid");
    expect(html).toContain("signature_mismatch");
  });
});

describe("gated content", () => {
  const page = async (cookie?: string) => (await fetch(`${app.url}/c/mara-okafor`, cookie ? { headers: { cookie } } : {})).text();

  it("members-only text is never sent before Stripe confirms payment", async () => {
    const html = await page(app.cookieFor(V));
    expect(html).toContain("FREE-BODY-TEXT");
    expect(html).not.toContain("SECRET-MEMBERS-BODY");
  });

  it("is sent after the webhook, only to that visitor, and removed again on cancel", async () => {
    app.stripe.subs.set("sub_1", sub());
    await app.deliver(event("invoice.paid", invoiceObj()));
    expect(await page(app.cookieFor(V))).toContain("SECRET-MEMBERS-BODY");
    expect(await page(app.cookieFor("v_bbbbbbbbbbbbbbbb"))).not.toContain("SECRET-MEMBERS-BODY");
    expect(await page()).not.toContain("SECRET-MEMBERS-BODY");

    app.stripe.subs.set("sub_1", sub({ status: "canceled" }));
    await app.deliver(event("customer.subscription.deleted", { id: "sub_1" }));
    expect(await page(app.cookieFor(V))).not.toContain("SECRET-MEMBERS-BODY");
  });

  it("a forged cookie is treated as no visitor", async () => {
    app.stripe.subs.set("sub_1", sub());
    await app.deliver(event("invoice.paid", invoiceObj()));
    expect(await page(`sp_vid=${V}.forged`)).not.toContain("SECRET-MEMBERS-BODY");
  });

  it("the checkout success redirect alone unlocks nothing (waits for the webhook)", async () => {
    app.stripe.checkoutVisitor = V;
    const html = await (await fetch(`${app.url}/account?checkout=cs_test_pending`, { headers: { cookie: app.cookieFor(V) } })).text();
    expect(html).toContain("Waiting for the signed");
    expect(await page(app.cookieFor(V))).not.toContain("SECRET-MEMBERS-BODY");
  });
});

describe("subscribe, portal and demo actions", () => {
  it("subscribe creates a customer and a Checkout Session with the 20% fee and the creator as destination", async () => {
    const res = await fetch(`${app.url}/subscribe`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "creator=c_seed_mara&interval=year" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(res.headers.get("set-cookie")).toMatch(/sp_vid=.*HttpOnly; SameSite=Lax/);
    const call = app.stripe.calls.find((c) => c.startsWith("createCheckout"))!;
    const p = JSON.parse(call.slice("createCheckout ".length));
    expect(p).toMatchObject({ priceId: "price_y", destination: "acct_mara", feePercent: 20, creatorId: "c_seed_mara" });
  });

  it("the portal opens with the membership's creator configuration (plan changes stay with that creator)", async () => {
    app.db.prepare("UPDATE creators SET portal_config_id = 'bpc_mara'").run();
    app.stripe.subs.set("sub_1", sub());
    await app.deliver(event("checkout.session.completed", { id: "cs_1", mode: "subscription", client_reference_id: V, customer: "cus_1", subscription: "sub_1" }));
    const res = await fetch(`${app.url}/portal`, { method: "POST", redirect: "manual", headers: { cookie: app.cookieFor(V), "content-type": "application/x-www-form-urlencoded" }, body: "sub=sub_1" });
    expect(res.status).toBe(303);
    expect(app.stripe.portalConfigs).toEqual(["bpc_mara"]);
    const other = await fetch(`${app.url}/portal`, { method: "POST", redirect: "manual", headers: { cookie: app.cookieFor(V), "content-type": "application/x-www-form-urlencoded" }, body: "sub=sub_other" });
    expect(other.status).toBe(404);
  });

  it("refuses to sell a creator whose Connect account can't receive transfers", async () => {
    app.db.prepare("UPDATE creators SET transfers_active = 0").run();
    const res = await fetch(`${app.url}/subscribe`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "creator=c_seed_mara&interval=month" });
    expect(res.status).toBe(409);
  });

  it("refuses cross-site form posts", async () => {
    const res = await fetch(`${app.url}/subscribe`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "creator=c_seed_mara&interval=month" });
    expect(res.status).toBe(403);
  });

  it("demo refund works only on the visitor's own membership", async () => {
    app.stripe.subs.set("sub_1", sub());
    await app.deliver(event("invoice.paid", invoiceObj()));
    const post = (cookie: string) => fetch(`${app.url}/demo/refund`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "sub=sub_1" });
    expect((await post(app.cookieFor("v_bbbbbbbbbbbbbbbb"))).status).toBe(404);
    expect((await post(app.cookieFor(V))).status).toBe(303);
    expect(app.stripe.calls).toContain("refundLatestAndCancel sub_1 pi_1");
  });

  it("becoming a creator makes prices and an Express account, then redirects to onboarding", async () => {
    const res = await fetch(`${app.url}/creators`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=Rowan+Hale&tagline=Film+photography&price=500" });
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(/^\/studio\/c_[a-f0-9]+\/onboard$/);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const onboard = await fetch(`${app.url}${loc}`, { redirect: "manual", headers: { cookie } });
    expect(onboard.headers.get("location")).toMatch(/^https:\/\/connect\.stripe\.com\/setup\/e\/acct_c_/);
    // another browser can't open that studio
    expect((await fetch(`${app.url}${loc}`, { redirect: "manual" })).status).toBe(404);
  });

  it("pages render (smoke)", async () => {
    for (const p of ["/", "/how", "/admin", "/account", "/creators/new", "/health"]) expect((await fetch(`${app.url}${p}`)).status).toBe(200);
    expect((await fetch(`${app.url}/nope`)).status).toBe(404);
  });
});

describe("config and session", () => {
  it("refuses live keys and non-test keys", () => {
    expect(() => assertTestKey("sk_live_abc")).toThrow(/LIVE/);
    expect(() => assertTestKey("rk_live_abc")).toThrow(/LIVE/);
    expect(() => assertTestKey("pk_test_abc")).toThrow();
    expect(() => assertTestKey("sk_test_abc")).not.toThrow();
    expect(() => loadConfig({ STRIPE_SECRET_KEY: "sk_live_x", SESSION_SECRET: "x".repeat(40) }, "")).toThrow(/LIVE/);
  });
  it("signed visitor cookie round-trips and rejects tampering", () => {
    const s = "k".repeat(40);
    expect(verifySigned(signId(V, s), s)).toBe(V);
    expect(verifySigned(signId(V, s), "other".repeat(10))).toBeNull();
    expect(verifySigned(signId(V, s).replace("aaaa", "aaab"), s)).toBeNull();
  });
});
