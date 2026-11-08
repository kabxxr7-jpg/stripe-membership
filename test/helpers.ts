import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { insertCreator, insertPost, openDb, type Db } from "../src/db.ts";
import type { AccountStatus, Billing, ChargeSplit, SubSnapshot } from "../src/gateway.ts";
import { signStripePayload } from "../src/kit/verify.ts";
import { signId, COOKIE } from "../src/session.ts";

export const SECRET = "whsec_test_platform_secret";
export const CONNECT_SECRET = "whsec_test_connect_secret";
export const SESSION = "s".repeat(40);
export const NOW = () => Math.floor(Date.now() / 1000);

/** A stand-in for Stripe holding "current truth" that tests mutate between deliveries. */
export class FakeStripe implements Billing {
  subs = new Map<string, SubSnapshot>();
  splits = new Map<string, ChargeSplit>();
  accounts = new Map<string, AccountStatus>();
  calls: string[] = [];
  failNextGetSubscription = false;

  async getSubscription(id: string) {
    this.calls.push(`getSubscription ${id}`);
    if (this.failNextGetSubscription) { this.failNextGetSubscription = false; throw new Error("stripe unavailable"); }
    return this.subs.get(id) ?? null;
  }
  async getChargeSplit(pi: string) { return this.splits.get(pi) ?? null; }
  invoicePis = new Map<string, string>();
  async getInvoicePaymentIntent(inv: string) { this.calls.push(`getInvoicePaymentIntent ${inv}`); return this.invoicePis.get(inv) ?? null; }
  async getAccountStatus(id: string) { return this.accounts.get(id) ?? { detailsSubmitted: false, transfersActive: false, payoutsEnabled: false }; }
  async createCustomer(v: string) { this.calls.push(`createCustomer ${v}`); return `cus_${v}`; }
  async createCheckout(p: Parameters<Billing["createCheckout"]>[0]) { this.calls.push(`createCheckout ${JSON.stringify(p)}`); return "https://checkout.stripe.com/c/pay/cs_test_fake"; }
  async getCheckoutSession(id: string) { return { customerId: "cus_x", visitorId: this.checkoutVisitor, status: "complete", subscriptionId: id === "cs_test_pending" ? "sub_pending" : "sub_1" }; }
  checkoutVisitor: string | null = null;
  portalConfigs: string[] = [];
  async createPortal(p: { configuration: string }) { this.portalConfigs.push(p.configuration); return "https://billing.stripe.com/p/session/test_fake"; }
  async createCreatorPortalConfig(p: { creatorId: string }) { return `bpc_${p.creatorId}`; }
  async createExpressAccount(p: { creatorId: string }) { this.calls.push(`createExpressAccount ${p.creatorId}`); return `acct_${p.creatorId}`; }
  async createAccountLink(p: { accountId: string }) { return `https://connect.stripe.com/setup/e/${p.accountId}`; }
  async createLoginLink() { return "https://connect.stripe.com/express/fake"; }
  async createProductAndPrices(p: { creatorId: string }) { return { productId: `prod_${p.creatorId}`, monthId: `price_m_${p.creatorId}`, yearId: `price_y_${p.creatorId}` }; }
  async connectedBalance() { return { availableCents: 0, pendingCents: 640 }; }
  async simulateFailedRenewal(s: string) { this.calls.push(`simulateFailedRenewal ${s}`); }
  async payWithWorkingCard(s: string) { this.calls.push(`payWithWorkingCard ${s}`); }
  async refundLatestAndCancel(s: string, pi: string) { this.calls.push(`refundLatestAndCancel ${s} ${pi}`); }
}

export function sub(over: Partial<SubSnapshot> = {}): SubSnapshot {
  return {
    id: "sub_1", customerId: "cus_1", status: "active", interval: "month", amountCents: 800,
    currentPeriodEnd: NOW() + 30 * 86400, cancelAtPeriodEnd: false, canceledAt: null,
    latestInvoiceId: "in_1", latestInvoiceStatus: "paid", latestPaymentIntent: "pi_1",
    visitorId: "v_aaaaaaaaaaaaaaaa", creatorId: "c_seed_mara", ...over,
  };
}

let seq = 0;
export function event(type: string, object: Record<string, unknown>, over: Record<string, unknown> = {}) {
  seq += 1;
  return { id: `evt_test_${seq}_${Math.random().toString(36).slice(2, 8)}`, object: "event", type, created: NOW(), livemode: false, data: { object }, ...over };
}

export const invoiceObj = (o: { id?: string; sub?: string; pi?: string; amount?: number; status?: string } = {}) => ({
  id: o.id ?? "in_1", object: "invoice", amount_paid: o.status === "open" ? 0 : (o.amount ?? 800), amount_due: o.amount ?? 800, currency: "usd",
  billing_reason: "subscription_create", created: NOW(), status: o.status ?? "paid",
  parent: { type: "subscription_details", subscription_details: { subscription: o.sub ?? "sub_1", metadata: { visitor_id: "v_aaaaaaaaaaaaaaaa", creator_id: "c_seed_mara" } } },
  payments: { data: [{ payment: { type: "payment_intent", payment_intent: o.pi ?? "pi_1" } }] },
});

export function config(over: Partial<Config> = {}): Config {
  return {
    port: 0, host: "127.0.0.1", publicBaseUrl: "http://localhost:8082", stripeSecretKey: "sk_test_x",
    webhookSecret: SECRET, connectWebhookSecret: CONNECT_SECRET, portalConfigId: "bpc_test", sessionSecret: SESSION,
    dbPath: ":memory:", platformFeePercent: 20, ...over,
  };
}

export function seedCreator(db: Db, ready = true): void {
  insertCreator(db, {
    id: "c_seed_mara", slug: "mara-okafor", name: "Mara Okafor", tagline: "Field recordings", bio: "Fictional.", accent: "#0ea5e9",
    monthly_cents: 800, annual_cents: 8000, product_id: "prod_1", price_month_id: "price_m", price_year_id: "price_y",
    account_id: "acct_mara", owner_visitor_id: null, seeded: 1,
  });
  if (ready) db.prepare("UPDATE creators SET details_submitted = 1, transfers_active = 1, payouts_enabled = 1").run();
  insertPost(db, { creator_id: "c_seed_mara", title: "Free post", preview: "free", body: "FREE-BODY-TEXT", members_only: false });
  insertPost(db, { creator_id: "c_seed_mara", title: "Members post", preview: "members", body: "SECRET-MEMBERS-BODY", members_only: true });
}

export async function startApp(over: Partial<Config> = {}) {
  const db = openDb(":memory:");
  const stripe = new FakeStripe();
  const cfg = config(over);
  const { server } = createApp({ db, billing: stripe, config: cfg, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const deliver = async (evt: object, opts: { secret?: string; path?: string; tamper?: boolean; ts?: number } = {}) => {
    const body = JSON.stringify(evt);
    const sig = signStripePayload({ secret: opts.secret ?? SECRET, body, timestampSeconds: opts.ts ?? NOW() });
    const res = await fetch(`${url}${opts.path ?? "/webhooks/stripe"}`, {
      method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: opts.tamper ? body.replace("800", "1") : body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const cookieFor = (visitor: string) => `${COOKIE}=${encodeURIComponent(signId(visitor, SESSION))}`;
  return { db, stripe, url, deliver, cookieFor, close: () => new Promise<void>((r) => server.close(() => r())) };
}
