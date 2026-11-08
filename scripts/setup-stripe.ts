/**
 * One-time Stripe TEST-mode setup for this build. Safe to re-run.
 *  - writes SESSION_SECRET and PUBLIC_BASE_URL into .env if missing
 *  - creates two webhook endpoints for PUBLIC_BASE_URL (platform events, and Connect events) and
 *    stores their signing secrets in .env (Stripe only reveals a secret when the endpoint is created)
 *  - creates (or updates) this build's own Customer Portal configuration
 * It never touches other webhook endpoints on the account.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { assertTestKey } from "../src/config.ts";

process.loadEnvFile(".env");
const key = process.env["STRIPE_SECRET_KEY"] ?? "";
assertTestKey(key);
const stripe = new Stripe(key);
const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const has = (k: string) => new RegExp(`^${k}=.+`, "m").test(env);
const put = (k: string, v: string) => { appendFileSync(".env", `${env.endsWith("\n") || env === "" ? "" : "\n"}${k}=${v}\n`); console.log(`.env: set ${k}`); };

const base = (process.env["PUBLIC_BASE_URL"] ?? "https://members.kabiirlabs.com").replace(/\/$/, "");
if (!has("PUBLIC_BASE_URL")) put("PUBLIC_BASE_URL", base);
if (!has("SESSION_SECRET")) put("SESSION_SECRET", randomBytes(32).toString("base64url"));

const PLATFORM_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed", "invoice.paid", "invoice.payment_failed", "charge.refunded",
];
const CONNECT_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = ["account.updated"];

const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data;
async function endpoint(path: string, events: typeof PLATFORM_EVENTS, connect: boolean, idVar: string, secretVar: string) {
  const url = `${base}${path}`;
  const found = existing.find((e) => e.url === url);
  if (found && has(secretVar)) {
    await stripe.webhookEndpoints.update(found.id, { enabled_events: events });
    console.log(`webhook ${url}: exists (${found.id}), events refreshed`);
    return;
  }
  if (found) throw new Error(`An endpoint for ${url} exists (${found.id}) but its secret is not in .env. Delete it in the dashboard or add ${secretVar} by hand.`);
  const created = await stripe.webhookEndpoints.create({
    url, enabled_events: events, connect, api_version: Stripe.API_VERSION as Stripe.WebhookEndpointCreateParams.ApiVersion,
    description: `Studio Pass demo (${connect ? "Connect" : "platform"} events)`,
  });
  put(idVar, created.id);
  put(secretVar, created.secret!);
  console.log(`webhook ${url}: created ${created.id} (api ${created.api_version})`);
}
await endpoint("/webhooks/stripe", PLATFORM_EVENTS, false, "STRIPE_WEBHOOK_ID", "STRIPE_WEBHOOK_SECRET");
await endpoint("/webhooks/connect", CONNECT_EVENTS, true, "STRIPE_CONNECT_WEBHOOK_ID", "STRIPE_CONNECT_WEBHOOK_SECRET");

// Portal: card updates, invoice history and immediate cancel. Used when a membership has no creator configuration.
const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
  customer_update: { enabled: true, allowed_updates: ["email", "name"] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: "immediately", proration_behavior: "none", cancellation_reason: { enabled: true, options: ["too_expensive", "unused", "other"] } },
  // Plan changes live in each creator's own configuration (scripts/seed.ts), so a switch can never
  // move a member to another creator's price while the payout still goes to the first creator.
  subscription_update: { enabled: false },
};
const business_profile = { headline: "Studio Pass demo (test mode): your membership" };
const portalId = process.env["STRIPE_PORTAL_CONFIG_ID"];
if (portalId) {
  await stripe.billingPortal.configurations.update(portalId, { features, business_profile });
  console.log(`portal configuration ${portalId}: updated`);
} else {
  const cfg = await stripe.billingPortal.configurations.create({ features, business_profile, metadata: { demo: "studio-pass" } });
  put("STRIPE_PORTAL_CONFIG_ID", cfg.id);
}
