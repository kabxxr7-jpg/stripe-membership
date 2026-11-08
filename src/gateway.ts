import Stripe from "stripe";

/** A subscription as this app needs it, normalised from Stripe's current API shape. */
export interface SubSnapshot {
  id: string;
  customerId: string;
  status: string;
  interval: string | null;
  amountCents: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  latestInvoiceId: string | null;
  latestInvoiceStatus: string | null;
  latestPaymentIntent: string | null;
  visitorId: string | null;
  creatorId: string | null;
}

export interface ChargeSplit {
  chargeId: string;
  amountCents: number;
  applicationFeeCents: number | null;
  transferId: string | null;
  transferCents: number | null;
}

export interface AccountStatus { detailsSubmitted: boolean; transfersActive: boolean; payoutsEnabled: boolean }

/** Read-side calls the webhook handlers make. Faked in tests. */
export interface StripeReads {
  getSubscription(id: string): Promise<SubSnapshot | null>;
  getChargeSplit(paymentIntentId: string): Promise<ChargeSplit | null>;
  /** Invoice event bodies don't include `payments`; this reads the paying PaymentIntent. */
  getInvoicePaymentIntent(invoiceId: string): Promise<string | null>;
  getAccountStatus(accountId: string): Promise<AccountStatus>;
}

/** Everything the web app asks Stripe to do. */
export interface Billing extends StripeReads {
  createCustomer(visitorId: string): Promise<string>;
  createCheckout(p: { customerId: string; priceId: string; destination: string; feePercent: number; visitorId: string; creatorId: string; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<string>;
  getCheckoutSession(id: string): Promise<{ customerId: string | null; visitorId: string | null; status: string | null; subscriptionId: string | null }>;
  createPortal(p: { customerId: string; returnUrl: string; configuration: string }): Promise<string>;
  /** A portal configuration that only offers this creator's monthly/annual prices (so a plan change can't move money to another creator). */
  createCreatorPortalConfig(p: { creatorId: string; name: string; productId: string; priceIds: string[] }): Promise<string>;
  createExpressAccount(p: { creatorId: string; name: string; url: string }): Promise<string>;
  createAccountLink(p: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<string>;
  createLoginLink(accountId: string): Promise<string>;
  createProductAndPrices(p: { name: string; monthlyCents: number; annualCents: number; creatorId: string }): Promise<{ productId: string; monthId: string; yearId: string }>;
  connectedBalance(accountId: string): Promise<{ availableCents: number; pendingCents: number }>;
  simulateFailedRenewal(subscriptionId: string, customerId: string): Promise<void>;
  payWithWorkingCard(subscriptionId: string, customerId: string): Promise<void>;
  refundLatestAndCancel(subscriptionId: string, paymentIntentId: string): Promise<void>;
}

function id(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === "string" ? x : x.id;
}

export function normaliseSubscription(sub: Stripe.Subscription): SubSnapshot {
  const item = sub.items.data[0];
  const inv = sub.latest_invoice && typeof sub.latest_invoice !== "string" ? sub.latest_invoice : null;
  const pay = inv?.payments?.data?.find((p) => p.payment?.type === "payment_intent");
  return {
    id: sub.id,
    customerId: id(sub.customer)!,
    status: sub.status,
    interval: item?.price.recurring?.interval ?? null,
    amountCents: item?.price.unit_amount ?? null,
    currentPeriodEnd: item?.current_period_end ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: sub.canceled_at ?? null,
    latestInvoiceId: id(sub.latest_invoice),
    latestInvoiceStatus: inv?.status ?? null,
    latestPaymentIntent: id(pay?.payment?.payment_intent ?? null),
    visitorId: sub.metadata["visitor_id"] ?? null,
    creatorId: sub.metadata["creator_id"] ?? null,
  };
}

export function createStripeBilling(secretKey: string): Billing {
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 2, appInfo: { name: "studio-pass-demo" } });

  const getSubscription = async (subId: string): Promise<SubSnapshot | null> => {
    try {
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice.payments"] });
      return normaliseSubscription(sub);
    } catch (e) {
      if (e instanceof Stripe.errors.StripeInvalidRequestError && e.statusCode === 404) return null;
      throw e;
    }
  };

  return {
    getSubscription,

    async getChargeSplit(pi) {
      const intent = await stripe.paymentIntents.retrieve(pi, { expand: ["latest_charge.transfer"] });
      const charge = intent.latest_charge && typeof intent.latest_charge !== "string" ? intent.latest_charge : null;
      if (!charge) return null;
      const transfer = charge.transfer && typeof charge.transfer !== "string" ? charge.transfer : null;
      return {
        chargeId: charge.id,
        amountCents: charge.amount,
        applicationFeeCents: charge.application_fee_amount ?? null,
        transferId: id(charge.transfer),
        // Destination charge: Stripe transfers the whole amount to the creator, then collects the
        // application fee back from them. The creator's share is therefore amount minus fee.
        transferCents: transfer ? transfer.amount - (charge.application_fee_amount ?? 0) : null,
      };
    },

    async getInvoicePaymentIntent(invoiceId) {
      const inv = await stripe.invoices.retrieve(invoiceId, { expand: ["payments"] });
      const paid = inv.payments?.data?.filter((p) => p.payment?.type === "payment_intent") ?? [];
      const best = paid.find((p) => p.status === "paid") ?? paid[paid.length - 1];
      return id(best?.payment?.payment_intent ?? null);
    },

    async getAccountStatus(accountId) {
      const a = await stripe.accounts.retrieve(accountId);
      return { detailsSubmitted: a.details_submitted ?? false, transfersActive: a.capabilities?.transfers === "active", payoutsEnabled: a.payouts_enabled ?? false };
    },

    async createCustomer(visitorId) {
      const c = await stripe.customers.create({ metadata: { visitor_id: visitorId, demo: "studio-pass" } }, { idempotencyKey: `customer-${visitorId}` });
      return c.id;
    },

    async createCheckout(p) {
      const s = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: p.customerId,
          line_items: [{ price: p.priceId, quantity: 1 }],
          client_reference_id: p.visitorId,
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
          customer_update: { name: "auto" },
          adaptive_pricing: { enabled: false }, // keep the price (and the 80/20 split) in USD
          subscription_data: {
            application_fee_percent: p.feePercent,
            transfer_data: { destination: p.destination },
            // Classic billing: resetting the billing anchor bills a full period (used by the
            // "simulate failed renewal" demo). Flexible mode nets that to $0 right after a payment.
            billing_mode: { type: "classic" },
            metadata: { visitor_id: p.visitorId, creator_id: p.creatorId },
          },
          metadata: { visitor_id: p.visitorId, creator_id: p.creatorId },
        },
        { idempotencyKey: p.idempotencyKey },
      );
      return s.url!;
    },

    async getCheckoutSession(sid) {
      const s = await stripe.checkout.sessions.retrieve(sid);
      return { customerId: id(s.customer), visitorId: s.client_reference_id ?? null, status: s.status ?? null, subscriptionId: id(s.subscription) };
    },

    async createPortal(p) {
      const s = await stripe.billingPortal.sessions.create({ customer: p.customerId, return_url: p.returnUrl, ...(p.configuration ? { configuration: p.configuration } : {}) });
      return s.url;
    },

    async createCreatorPortalConfig(p) {
      const cfg = await stripe.billingPortal.configurations.create(
        {
          business_profile: { headline: `${p.name} membership (test mode)`.slice(0, 60) },
          features: {
            customer_update: { enabled: true, allowed_updates: ["email", "name"] },
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: "immediately", proration_behavior: "none" },
            subscription_update: { enabled: true, default_allowed_updates: ["price"], products: [{ product: p.productId, prices: p.priceIds }], proration_behavior: "always_invoice" }, // monthly->yearly: charge $80 minus the unused-month credit now (create_prorations double-counts the year),
          },
          metadata: { demo: "studio-pass", creator_id: p.creatorId },
        },
        { idempotencyKey: `portal-${p.creatorId}` },
      );
      return cfg.id;
    },

    async createExpressAccount(p) {
      // Accounts v2 (Stripe's current API for new Connect platforms): a "recipient" account with the
      // Express dashboard. The platform is merchant of record (destination charges without on_behalf_of)
      // and collects fees and covers losses. The account id is a normal acct_ id usable by v1 APIs.
      const a = await stripe.v2.core.accounts.create({
        display_name: p.name,
        contact_email: `${p.creatorId.replace(/[^a-z0-9]/gi, "")}@example.com`,
        dashboard: "express",
        identity: { country: "us", entity_type: "individual" },
        configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
        defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
        metadata: { creator_id: p.creatorId, demo: "studio-pass", page: p.url },
      });
      return a.id;
    },

    async createAccountLink(p) {
      const l = await stripe.v2.core.accountLinks.create({
        account: p.accountId,
        use_case: { type: "account_onboarding", account_onboarding: { collection_options: { fields: "currently_due" }, refresh_url: p.refreshUrl, return_url: p.returnUrl } },
      });
      return l.url;
    },

    async createLoginLink(accountId) {
      return (await stripe.accounts.createLoginLink(accountId)).url;
    },

    async createProductAndPrices(p) {
      const product = await stripe.products.create({ name: `${p.name} membership`, metadata: { creator_id: p.creatorId, demo: "studio-pass" } }, { idempotencyKey: `product-${p.creatorId}` });
      const month = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: p.monthlyCents, recurring: { interval: "month" }, lookup_key: `${p.creatorId}-month` }, { idempotencyKey: `price-m-${p.creatorId}` });
      const year = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: p.annualCents, recurring: { interval: "year" }, lookup_key: `${p.creatorId}-year` }, { idempotencyKey: `price-y-${p.creatorId}` });
      return { productId: product.id, monthId: month.id, yearId: year.id };
    },

    async connectedBalance(accountId) {
      const b = await stripe.balance.retrieve({}, { stripeAccount: accountId });
      const sum = (xs: { amount: number; currency: string }[]) => xs.filter((x) => x.currency === "usd").reduce((a, x) => a + x.amount, 0);
      return { availableCents: sum(b.available), pendingCents: sum(b.pending) };
    },

    // ----- demo helpers: real Stripe calls that reproduce what a member would otherwise wait weeks for -----

    async simulateFailedRenewal(subscriptionId, customerId) {
      // Stripe's test card that attaches fine but declines every charge.
      const pm = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: customerId });
      const params: Stripe.SubscriptionUpdateParams = { default_payment_method: pm.id, billing_cycle_anchor: { type: "now" }, proration_behavior: "none", payment_behavior: "allow_incomplete" };
      await stripe.subscriptions.update(subscriptionId, params);
    },

    async payWithWorkingCard(subscriptionId, customerId) {
      const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customerId });
      const sub = await stripe.subscriptions.update(subscriptionId, { default_payment_method: pm.id });
      const inv = id(sub.latest_invoice);
      if (inv) {
        const invoice = await stripe.invoices.retrieve(inv);
        if (invoice.status === "open") await stripe.invoices.pay(inv, { payment_method: pm.id });
      }
    },

    async refundLatestAndCancel(subscriptionId, paymentIntentId) {
      // Destination charge: take the creator's share back and return the platform fee too.
      await stripe.refunds.create({ payment_intent: paymentIntentId, reverse_transfer: true, refund_application_fee: true }, { idempotencyKey: `refund-${paymentIntentId}` });
      await stripe.subscriptions.cancel(subscriptionId);
    },
  };
}
