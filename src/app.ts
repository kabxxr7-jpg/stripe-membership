import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { accessFor, refundChecker, visitorAccess } from "./access.ts";
import type { Config } from "./config.ts";
import {
  countCreatorsSince, creatorsOwnedBy, ensureVisitor, getCreator, getCreatorBySlug, getSubscription, getVisitor, insertCreator,
  insertPost, listCreators, logEvent, paymentsForCreator, postsFor, setCreatorAccountStatus, setVisitorCustomer,
  subscriptionsForVisitor, updateCreatorStripe, type CreatorRow, type Db, type PaymentRow, type SubscriptionRow,
} from "./db.ts";
import type { Billing } from "./gateway.ts";
import { createHandler } from "./handlers.ts";
import { handleStripeWebhook } from "./kit/webhook.ts";
import { createSqliteStore } from "./kit/idempotency.ts";
import { cookieHeader, newVisitorId, parseCookies, signId, verifySigned, COOKIE } from "./session.ts";
import {
  accessChip, avatar, creatorCard, creatorReady, date, dateTime, esc, layout, money, paymentsTable, postHtml,
  subscriptionsTable, testCardBox,
} from "./views.ts";

export interface AppDeps { db: Db; billing: Billing; config: Config; log?: (msg: string) => void }

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MAX_FORM = 16 * 1024;
const MAX_WEBHOOK = 1024 * 1024;
const VISITOR_CREATORS_PER_DAY = 40;

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Tiny fixed-window limiter for the endpoints that create things in Stripe. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < t) { hits.set(key, { n: 1, reset: t + windowMs }); if (hits.size > 5000) hits.clear(); return true; }
    h.n += 1;
    return h.n <= max;
  };
}

export function createApp(deps: AppDeps): { server: Server; handleEvent: ReturnType<typeof createHandler> } {
  const { db, billing, config } = deps;
  const log = deps.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${m}`));
  const store = createSqliteStore({ db });
  const handleEvent = createHandler(db, billing);
  const secure = config.publicBaseUrl.startsWith("https://");
  const createLimit = limiter(20, 60 * 60_000);
  const actionLimit = limiter(60, 10 * 60_000);
  const base = config.publicBaseUrl;

  const html = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "DENY", ...extra });
    res.end(body);
  };
  const redirect = (res: ServerResponse, to: string, extra: Record<string, string> = {}) => { res.writeHead(303, { location: to, "cache-control": "no-store", ...extra }); res.end(); };
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  function visitorOf(req: IncomingMessage): string | null {
    return verifySigned(parseCookies(req.headers.cookie)[COOKIE], config.sessionSecret);
  }
  /** Returns the visitor id, creating one (and a cookie header) if needed. */
  function ensureVisitorFor(req: IncomingMessage): { id: string; setCookie: Record<string, string> } {
    const existing = visitorOf(req);
    if (existing) { ensureVisitor(db, existing); return { id: existing, setCookie: {} }; }
    const id = newVisitorId();
    ensureVisitor(db, id);
    return { id, setCookie: { "set-cookie": cookieHeader(signId(id, config.sessionSecret), secure) } };
  }
  function clientIp(req: IncomingMessage): string {
    return String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
  }
  function checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (!origin || origin === "null") return; // SameSite=Lax cookies already block cross-site form posts
    const allowed = new Set([new URL(base).origin, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
    if (!allowed.has(origin)) throw new HttpError(403, "Cross-site request refused");
  }
  async function form(req: IncomingMessage): Promise<URLSearchParams> {
    return new URLSearchParams((await readBody(req, MAX_FORM)).toString("utf8"));
  }
  function ownedCreator(req: IncomingMessage, id: string): CreatorRow {
    const c = getCreator(db, id);
    const v = visitorOf(req);
    if (!c || c.seeded || !v || c.owner_visitor_id !== v) throw new HttpError(404, "Creator studio not found for this browser");
    return c;
  }
  function ownedSub(visitor: string | null, subId: string): SubscriptionRow {
    const s = getSubscription(db, subId);
    if (!s || !visitor || s.visitor_id !== visitor) throw new HttpError(404, "Membership not found for this browser");
    return s;
  }

  // ------------------------------------------------------------------ webhooks
  async function webhook(req: IncomingMessage, res: ServerResponse, endpoint: "platform" | "connect") {
    const secret = endpoint === "platform" ? config.webhookSecret : config.connectWebhookSecret;
    if (!secret) { json(res, 503, { error: "webhook_not_configured" }); return; }
    const raw = await readBody(req, MAX_WEBHOOK);
    let outcome = "ok";
    let evt: { id: string | null; type: string | null } = { id: null, type: null };
    const result = await handleStripeWebhook({
      rawBody: raw,
      headers: req.headers as Record<string, string>,
      secret,
      store,
      handler: async (event) => {
        evt = { id: event.id, type: event.type };
        outcome = await handleEvent(event);
      },
    });
    if (result.status === 200 && result.body["status"] === "duplicate") outcome = "duplicate";
    else if (result.status !== 200) outcome = result.reason ?? result.body["error"] as string ?? "error";
    if (!evt.id && result.status === 200) {
      try { const e = JSON.parse(raw.toString("utf8")); evt = { id: e.id, type: e.type }; } catch { /* verified already */ }
    }
    logEvent(db, { event_id: evt.id, type: evt.type, endpoint, http_status: result.status, outcome });
    log(`webhook ${endpoint} ${evt.type ?? "-"} ${evt.id ?? "-"} -> ${result.status} ${outcome}${result.error ? " " + result.error : ""}`);
    json(res, result.status, result.body);
  }

  // ------------------------------------------------------------------ pages
  function home(req: IncomingMessage, res: ServerResponse) {
    const v = visitorOf(req);
    const creators = listCreators(db, { seededOrOwner: v });
    const cards = creators.map((c) => creatorCard(c, v ? visitorAccess(db, v, c.id).state : null)).join("");
    html(res, 200, layout({ title: "Creators", nav: "home", body: `
<h1>Support creators. Unlock their work.</h1>
<p class="lead">A working membership platform on Stripe: subscribe to a creator monthly or yearly, read their members-only posts, manage or cancel in Stripe's customer portal. Creators get paid out through Stripe Connect with an <b>80 / 20 split</b>.</p>
<div class="steps" style="margin:24px 0">
<div class="card"><b>Pick a creator and a plan.</b><br><span class="muted small">Stripe Checkout takes the (test) card. Use 4242 4242 4242 4242.</span></div>
<div class="card"><b>Stripe's webhook unlocks the posts.</b><br><span class="muted small">Not the redirect: access changes only on a signed, verified event.</span></div>
<div class="card"><b>Cancel, fail a payment or refund.</b><br><span class="muted small">Access locks again. Every step is visible on the <a href="/admin">admin page</a>.</span></div>
</div>
${testCardBox()}
<h2>Creators</h2>
<div class="grid">${cards || '<p class="muted">No creators yet.</p>'}</div>
<p class="muted small" style="margin-top:20px">Want to see the creator side? <a href="/creators/new">Become a creator</a> and go through Stripe Connect Express onboarding with Stripe's test data.</p>` }));
  }

  function creatorPage(req: IncomingMessage, res: ServerResponse, slug: string, url: URL) {
    const c = getCreatorBySlug(db, slug);
    const v = visitorOf(req);
    if (!c || (!c.seeded && c.owner_visitor_id !== v)) throw new HttpError(404, "Creator not found");
    const { state, sub } = visitorAccess(db, v, c.id);
    const posts = postsFor(db, c.id);
    const ready = creatorReady(c);
    const canceled = url.searchParams.get("canceled") === "1";
    const plans = state.open
      ? `<div class="notice ok">You're a member. ${accessChip(state)} <a href="/account">Manage membership</a></div>`
      : `${sub && state.reason !== "none" ? `<div class="notice bad">Your membership is locked. ${accessChip(state)} <a href="/account">See details</a></div>` : ""}
<div class="plans">
${(["month", "year"] as const).map((i) => `<form class="plan" method="post" action="/subscribe"><input type="hidden" name="creator" value="${esc(c.id)}"><input type="hidden" name="interval" value="${i}">
<div class="muted small">${i === "month" ? "Monthly" : "Annual · 2 months free"}</div><div class="price">${money(i === "month" ? c.monthly_cents : c.annual_cents)}<span class="muted small">/${i}</span></div>
<p class="small muted">Creator receives ${money(Math.round((i === "month" ? c.monthly_cents : c.annual_cents) * 0.8))} (80%).</p>
<button class="btn" ${ready ? "" : "disabled"}>${ready ? `Join ${i === "month" ? "monthly" : "yearly"}` : "Payout setup pending"}</button></form>`).join("")}
</div>${ready ? testCardBox() : `<div class="notice warn">This creator hasn't finished Stripe Connect onboarding, so payments are switched off until Stripe enables transfers to their account.</div>`}`;
    html(res, 200, layout({ title: c.name, body: `
<div class="row" style="margin-top:24px">${avatar(c, 64)}<div><h1 style="margin:0">${esc(c.name)}</h1><div class="muted">${esc(c.tagline)}</div></div></div>
<p class="lead">${esc(c.bio)}</p>
${canceled ? '<div class="notice warn">Checkout was cancelled. Nothing was charged.</div>' : ""}
${plans}
<h2>Posts</h2>${posts.map((p) => postHtml(p, state.open)).join("")}` }));
  }

  async function subscribe(req: IncomingMessage, res: ServerResponse) {
    checkOrigin(req);
    if (!createLimit(clientIp(req))) throw new HttpError(429, "Too many checkouts from this network. Try again in an hour.");
    const f = await form(req);
    const c = getCreator(db, f.get("creator") ?? "");
    const interval = f.get("interval") === "year" ? "year" : "month";
    if (!c) throw new HttpError(404, "Creator not found");
    if (!creatorReady(c)) throw new HttpError(409, "This creator can't take payments yet");
    const { id: visitor, setCookie } = ensureVisitorFor(req);
    if (visitorAccess(db, visitor, c.id).state.open) return redirect(res, "/account?already=1", setCookie);
    let customer = getVisitor(db, visitor)?.customer_id ?? null;
    if (!customer) { customer = await billing.createCustomer(visitor); setVisitorCustomer(db, visitor, customer); }
    const url = await billing.createCheckout({
      customerId: customer, priceId: interval === "month" ? c.price_month_id! : c.price_year_id!, destination: c.account_id!,
      feePercent: config.platformFeePercent, visitorId: visitor, creatorId: c.id,
      successUrl: `${base}/account?checkout={CHECKOUT_SESSION_ID}`, cancelUrl: `${base}/c/${c.slug}?canceled=1`,
      idempotencyKey: `checkout-${visitor}-${c.id}-${interval}-${Math.floor(Date.now() / 60_000)}`,
    });
    log(`checkout created visitor=${visitor} creator=${c.id} interval=${interval}`);
    redirect(res, url, setCookie);
  }

  async function account(req: IncomingMessage, res: ServerResponse, url: URL) {
    const v = visitorOf(req);
    const cs = url.searchParams.get("checkout");
    let waiting = false;
    let checkoutNote = "";
    if (cs && /^cs_test_[A-Za-z0-9]+$/.test(cs)) {
      const s = await billing.getCheckoutSession(cs);
      if (s.visitorId !== v) checkoutNote = `<div class="notice warn">That checkout belongs to another browser.</div>`;
      else if (s.subscriptionId && !getSubscription(db, s.subscriptionId)) waiting = true;
      else if (s.subscriptionId) checkoutNote = `<div class="notice ok">Payment confirmed by Stripe's webhook. Your posts are unlocked.</div>`;
    }
    const subs = v ? subscriptionsForVisitor(db, v) : [];
    const now = Math.floor(Date.now() / 1000);
    const check = refundChecker(db);
    const flash = url.searchParams.get("done");
    const flashText: Record<string, string> = {
      fail: "Stripe tried to renew with a card that always declines. When the invoice.payment_failed webhook arrives the membership locks (refresh in a few seconds).",
      fix: "Paid the open invoice with a working test card. The invoice.paid webhook unlocks access again.",
      refund: "Refunded the last payment (the creator's transfer and the 20% fee are reversed too) and cancelled the subscription. The webhooks lock access.",
    };
    const cards = subs.map((s) => {
      const c = s.creator_id ? getCreator(db, s.creator_id) : undefined;
      const st = accessFor(s, now, check);
      const live = !["canceled", "incomplete_expired"].includes(s.status);
      return `<div class="card"><div class="row">${c ? avatar(c, 40) : ""}<div style="flex:1;min-width:200px"><h3>${esc(c?.name ?? "Creator")}</h3>
<div class="muted small">${money(s.amount_cents)}/${esc(s.interval ?? "")} · Stripe status <b>${esc(s.status)}</b>${s.cancel_at_period_end ? " · cancels at period end" : ""} · paid through ${date(s.current_period_end)}</div></div>${accessChip(st)}</div>
<div class="row" style="margin-top:14px">
${c ? `<a class="btn ${st.open ? "" : "quiet"}" href="/c/${esc(c.slug)}">${st.open ? "Read posts" : "View creator"}</a>` : ""}
${live ? `<form class="inline" method="post" action="/portal"><input type="hidden" name="sub" value="${esc(s.id)}"><button class="btn ghost">Manage billing / cancel (Stripe portal)</button></form>` : ""}
</div>
${live ? `<details style="margin-top:14px"><summary class="small muted">Demo controls: make Stripe produce the events a real member would trigger over weeks</summary>
<div class="row" style="margin-top:10px">
${s.status === "active" ? `<form class="inline" method="post" action="/demo/fail"><input type="hidden" name="sub" value="${esc(s.id)}"><button class="btn quiet">Simulate failed renewal</button></form>` : ""}
${["past_due", "unpaid"].includes(s.status) ? `<form class="inline" method="post" action="/demo/fix"><input type="hidden" name="sub" value="${esc(s.id)}"><button class="btn quiet">Pay with a working card</button></form>` : ""}
${s.latest_payment_intent && s.latest_invoice_status === "paid" ? `<form class="inline" method="post" action="/demo/refund"><input type="hidden" name="sub" value="${esc(s.id)}"><button class="btn danger">Refund last payment</button></form>` : ""}
</div><p class="small muted">These call the real Stripe test API (a declining test card on renewal, a refund with transfer reversal). The page never changes access itself: it waits for the webhook.</p></details>` : ""}
</div>`;
    }).join("");
    const owned = v ? creatorsOwnedBy(db, v) : [];
    html(res, 200, layout({ title: "My memberships", nav: "account", ...(waiting ? { refresh: 2 } : {}), body: `
<h1>My memberships</h1>
<p class="muted small">No password in this demo: memberships belong to this browser (a signed cookie). ${v ? `Your visitor id: <code>${esc(v)}</code>` : ""}</p>
${waiting ? `<div class="notice warn">Payment received by Stripe. Waiting for the signed <code>checkout.session.completed</code> / <code>invoice.paid</code> webhook before unlocking… (this page refreshes itself)</div>` : checkoutNote}
${url.searchParams.get("already") ? '<div class="notice ok">You already have an active membership with this creator.</div>' : ""}
${flash && flashText[flash] ? `<div class="notice warn">${flashText[flash]}</div>` : ""}
<div style="display:grid;gap:12px">${cards || `<div class="card"><p>No memberships yet. <a href="/">Pick a creator</a> and subscribe with the test card <code>4242 4242 4242 4242</code>.</p></div>`}</div>
${owned.length ? `<h2>Your creator studios</h2><div class="grid">${owned.map((c) => `<a class="card creator" href="/studio/${esc(c.id)}"><div class="row">${avatar(c)}<div><h3>${esc(c.name)}</h3><div class="small muted">${creatorReady(c) ? "Payouts ready" : "Onboarding not finished"}</div></div></div></a>`).join("")}</div>` : ""}` }));
  }

  async function portal(req: IncomingMessage, res: ServerResponse) {
    checkOrigin(req);
    const v = visitorOf(req);
    const customer = v ? getVisitor(db, v)?.customer_id : null;
    if (!customer) throw new HttpError(404, "No billing account for this browser yet");
    const subId = (await form(req)).get("sub");
    const sub = subId ? ownedSub(v, subId) : undefined;
    const creator = sub?.creator_id ? getCreator(db, sub.creator_id) : undefined;
    // The creator's own configuration only offers that creator's prices; the default one allows no plan changes.
    const configuration = creator?.portal_config_id ?? config.portalConfigId;
    redirect(res, await billing.createPortal({ customerId: customer, returnUrl: `${base}/account`, configuration }));
  }

  async function demoAction(req: IncomingMessage, res: ServerResponse, kind: "fail" | "fix" | "refund") {
    checkOrigin(req);
    if (!actionLimit(clientIp(req))) throw new HttpError(429, "Too many demo actions. Try again in a few minutes.");
    const v = visitorOf(req);
    const s = ownedSub(v, (await form(req)).get("sub") ?? "");
    if (kind === "fail") {
      if (s.status !== "active") throw new HttpError(409, "Only an active membership can be renewed");
      await billing.simulateFailedRenewal(s.id, s.customer_id);
    } else if (kind === "fix") {
      await billing.payWithWorkingCard(s.id, s.customer_id);
    } else {
      if (!s.latest_payment_intent || s.latest_invoice_status !== "paid") throw new HttpError(409, "No paid payment to refund");
      await billing.refundLatestAndCancel(s.id, s.latest_payment_intent);
    }
    log(`demo ${kind} sub=${s.id}`);
    redirect(res, `/account?done=${kind}`);
  }

  // ------------------------------------------------------------------ creators
  function newCreatorForm(_req: IncomingMessage, res: ServerResponse, error = "") {
    html(res, error ? 400 : 200, layout({ title: "Become a creator", nav: "new", body: `
<h1>Become a creator</h1>
<p class="lead">Create a creator page and get paid through <b>Stripe Connect Express</b>. Stripe hosts the identity and bank-account forms; this platform never sees them. You keep 80% of every membership.</p>
<div class="notice warn"><b>Test mode:</b> on Stripe's onboarding pages use the test values Stripe shows: phone verification code <code>000000</code>, SSN <code>000-00-0000</code>, routing <code>110000000</code>, account <code>000123456789</code>, or the "Use test data" buttons where offered. Never enter real details.</div>
${error ? `<div class="notice bad">${esc(error)}</div>` : ""}
<form class="card" method="post" action="/creators" style="max-width:560px">
<label for="name">Creator name</label><input id="name" name="name" maxlength="40" required placeholder="e.g. Rowan Hale">
<label for="tagline">What members get</label><input id="tagline" name="tagline" maxlength="80" required placeholder="e.g. Weekly film photography breakdowns">
<label for="price">Monthly price</label><select id="price" name="price"><option value="500">$5 / month ($50 / year)</option><option value="800" selected>$8 / month ($80 / year)</option><option value="1200">$12 / month ($120 / year)</option></select>
<p class="small muted">Your page is only listed for you (this browser) and on the admin page. Posts are sample text.</p>
<button class="btn">Create page and start Stripe onboarding</button></form>` }));
  }

  async function createCreator(req: IncomingMessage, res: ServerResponse) {
    checkOrigin(req);
    if (!createLimit(clientIp(req))) throw new HttpError(429, "Too many requests from this network. Try again in an hour.");
    if (countCreatorsSince(db, Math.floor(Date.now() / 1000) - 86400) >= VISITOR_CREATORS_PER_DAY) throw new HttpError(429, "The demo's daily limit for new creators is reached. Try tomorrow.");
    const f = await form(req);
    const name = (f.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const tagline = (f.get("tagline") ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const monthly = [500, 800, 1200].includes(Number(f.get("price"))) ? Number(f.get("price")) : 800;
    if (name.length < 2 || tagline.length < 3) return newCreatorForm(req, res, "Please enter a name and a short description.");
    const { id: visitor, setCookie } = ensureVisitorFor(req);
    const id = "c_" + randomBytes(6).toString("hex");
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "creator"}-${id.slice(2, 6)}`;
    const accents = ["#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899"];
    insertCreator(db, {
      id, slug, name, tagline, bio: `${name} is a visitor-created creator on this demo platform.`, accent: accents[randomBytes(1)[0]! % accents.length]!,
      monthly_cents: monthly, annual_cents: monthly * 10, product_id: null, price_month_id: null, price_year_id: null, account_id: null,
      owner_visitor_id: visitor, seeded: 0,
    });
    insertPost(db, { creator_id: id, title: "Welcome to my page", preview: "A free post anyone can read.", body: "Thanks for stopping by. This is a free preview post.", members_only: false });
    insertPost(db, { creator_id: id, title: "Members-only: my first deep dive", preview: "Only members can read this one.", body: "You're reading members-only content. Access was granted by a verified Stripe webhook, not by the checkout redirect.\n\nCancel in the portal and this post locks again.", members_only: true });
    const prices = await billing.createProductAndPrices({ name, monthlyCents: monthly, annualCents: monthly * 10, creatorId: id });
    updateCreatorStripe(db, id, { product_id: prices.productId, price_month_id: prices.monthId, price_year_id: prices.yearId });
    updateCreatorStripe(db, id, { portal_config_id: await billing.createCreatorPortalConfig({ creatorId: id, name, productId: prices.productId, priceIds: [prices.monthId, prices.yearId] }) });
    const acct = await billing.createExpressAccount({ creatorId: id, name, url: `${base}/c/${slug}` });
    updateCreatorStripe(db, id, { account_id: acct });
    log(`creator created ${id} account=${acct}`);
    redirect(res, `/studio/${id}/onboard`, setCookie);
  }

  async function onboard(req: IncomingMessage, res: ServerResponse, id: string) {
    const c = ownedCreator(req, id);
    if (!c.account_id) throw new HttpError(409, "No Stripe account for this creator");
    redirect(res, await billing.createAccountLink({ accountId: c.account_id, refreshUrl: `${base}/studio/${id}/onboard`, returnUrl: `${base}/studio/${id}?returned=1` }));
  }

  async function studio(req: IncomingMessage, res: ServerResponse, id: string, url: URL) {
    let c = ownedCreator(req, id);
    if (c.account_id) {
      // The return URL is not proof of anything; re-read the account. account.updated keeps it current too.
      try { setCreatorAccountStatus(db, c.account_id, await billing.getAccountStatus(c.account_id)); c = getCreator(db, id)!; } catch (e) { log(`account refresh failed: ${String(e)}`); }
    }
    let balance = "";
    if (c.account_id && c.details_submitted) {
      try { const b = await billing.connectedBalance(c.account_id); balance = `<div class="stat"><b>${money(b.pendingCents)}</b><span>Pending in your Stripe balance</span></div><div class="stat"><b>${money(b.availableCents)}</b><span>Available for payout</span></div>`; } catch { /* ignore */ }
    }
    const pays = paymentsForCreator(db, c.id);
    const earned = pays.filter((p) => p.status === "paid").reduce((a, p) => a + (p.transfer_cents ?? 0), 0);
    const step = (ok: boolean, label: string) => `<div class="row"><span class="chip ${ok ? "ok" : "warn"}">${ok ? "Done" : "To do"}</span> ${label}</div>`;
    html(res, 200, layout({ title: `${c.name} studio`, body: `
<div class="row" style="margin-top:24px">${avatar(c, 56)}<div><h1 style="margin:0">${esc(c.name)} · studio</h1><div class="muted">Stripe account <code>${esc(c.account_id ?? "–")}</code></div></div></div>
${url.searchParams.get("returned") && !c.details_submitted ? '<div class="notice warn">You came back before finishing onboarding. Continue where you left off.</div>' : ""}
<div class="card" style="margin-top:16px;display:grid;gap:8px">
${step(!!c.account_id, "Stripe Express account created")}
${step(!!c.details_submitted, "Onboarding details submitted to Stripe")}
${step(!!c.transfers_active, "Transfers capability active (members can now subscribe)")}
${step(!!c.payouts_enabled, "Payouts to your bank enabled")}
<div class="row" style="margin-top:8px">${!c.details_submitted || !c.transfers_active ? `<a class="btn" href="/studio/${esc(c.id)}/onboard">${c.details_submitted ? "Update details on Stripe" : "Continue Stripe onboarding"}</a>` : ""}
${c.details_submitted ? `<form class="inline" method="post" action="/studio/${esc(c.id)}/dashboard"><button class="btn ghost">Open Stripe Express dashboard</button></form>` : ""}
<a class="btn quiet" href="/c/${esc(c.slug)}">View public page</a></div></div>
<h2>Earnings</h2><div class="stats"><div class="stat"><b>${money(earned)}</b><span>Your 80% share, transferred</span></div>${balance}</div>
${paymentsTable(pays.map((p) => ({ ...p, creator_name: c.name })))}` }));
  }

  async function expressDashboard(req: IncomingMessage, res: ServerResponse, id: string) {
    checkOrigin(req);
    const c = ownedCreator(req, id);
    if (!c.account_id) throw new HttpError(409, "No Stripe account");
    redirect(res, await billing.createLoginLink(c.account_id));
  }

  // ------------------------------------------------------------------ admin
  function admin(_req: IncomingMessage, res: ServerResponse) {
    const now = Math.floor(Date.now() / 1000);
    const check = refundChecker(db);
    const subs = db.prepare("SELECT s.*, v.email FROM subscriptions s LEFT JOIN visitors v ON v.id = s.visitor_id ORDER BY s.created_at DESC LIMIT 100").all() as unknown as (SubscriptionRow & { email: string | null })[];
    const creators = listCreators(db, { all: true });
    const byId = new Map(creators.map((c) => [c.id, c]));
    const rows = subs.map((s) => ({ sub: s, creator: s.creator_id ? byId.get(s.creator_id) : undefined, state: accessFor(s, now, check), email: s.email }));
    const pays = db.prepare(`SELECT p.*, c.name AS creator_name, r.fully_refunded AS refunded FROM payments p LEFT JOIN creators c ON c.id = p.creator_id
      LEFT JOIN refunds r ON r.payment_intent = p.payment_intent ORDER BY p.created DESC LIMIT 100`).all() as unknown as (PaymentRow & { creator_name: string | null; refunded: number | null })[];
    const paid = pays.filter((p) => p.status === "paid" && !p.refunded);
    const gross = paid.reduce((a, p) => a + p.amount_cents, 0);
    const fees = paid.reduce((a, p) => a + (p.application_fee_cents ?? 0), 0);
    const transfers = paid.reduce((a, p) => a + (p.transfer_cents ?? 0), 0);
    const openCount = rows.filter((r) => r.state.open).length;
    const events = db.prepare("SELECT * FROM event_log ORDER BY id DESC LIMIT 20").all() as unknown as { event_id: string; type: string; endpoint: string; http_status: number; outcome: string; at: number }[];
    const cPct = gross ? (transfers / gross) * 100 : 80;
    html(res, 200, layout({ title: "Admin", nav: "admin", body: `
<h1>Platform admin</h1>
<p class="muted">Read-only view of what the webhooks have recorded. Public on purpose for this demo; emails are masked. Amounts exclude refunded payments.</p>
<div class="stats">
<div class="stat"><b>${openCount}</b><span>Members with access now</span></div>
<div class="stat"><b>${money(gross)}</b><span>Gross membership revenue</span></div>
<div class="stat"><b>${money(fees)}</b><span>Platform share (20% application fees)</span></div>
<div class="stat"><b>${money(transfers)}</b><span>Creator share (80%, transferred)</span></div>
</div>
<div class="card"><b>Where each membership dollar goes</b><div class="split"><div class="c" style="width:${cPct}%"></div><div class="p" style="width:${100 - cPct}%"></div></div>
<div class="legend"><span><i style="background:#10b981"></i>Creator, sent by Stripe as a destination-charge transfer</span><span><i style="background:#6366f1"></i>Platform, kept as the application fee (Stripe's processing fee comes out of this share)</span></div></div>
<h2>Members</h2>${subscriptionsTable(rows, true)}
<h2>Payments and payouts</h2>${paymentsTable(pays)}
<h2>Creators (Stripe Connect Express)</h2>
<div class="tablewrap"><table><thead><tr><th>Creator</th><th>Type</th><th>Account</th><th>Details</th><th>Transfers</th><th>Payouts</th><th>Price</th></tr></thead><tbody>
${creators.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.seeded ? "platform demo" : "visitor-created"}</td><td class="mono">${esc(c.account_id ?? "–")}</td><td>${c.details_submitted ? '<span class="chip ok">submitted</span>' : '<span class="chip warn">pending</span>'}</td><td>${c.transfers_active ? '<span class="chip ok">active</span>' : '<span class="chip warn">inactive</span>'}</td><td>${c.payouts_enabled ? '<span class="chip ok">enabled</span>' : '<span class="chip warn">off</span>'}</td><td>${money(c.monthly_cents)}/mo</td></tr>`).join("")}
</tbody></table></div>
<h2>Webhook deliveries</h2>
<p class="muted small">Every delivery is signature-checked over the raw body, de-duplicated by event id, and answered with the status Stripe's retry logic needs.</p>
<div class="tablewrap"><table><thead><tr><th>Received (UTC)</th><th>Endpoint</th><th>Event</th><th>HTTP</th><th>Result</th><th>Event id</th></tr></thead><tbody>
${events.map((e) => `<tr><td>${dateTime(e.at)}</td><td>${esc(e.endpoint)}</td><td>${esc(e.type ?? "–")}</td><td>${e.http_status}</td><td><span class="chip ${e.http_status === 200 ? (e.outcome === "applied" || e.outcome === "ok" ? "ok" : "") : "bad"}">${esc(e.outcome)}</span></td><td class="mono">${esc(e.event_id ?? "–")}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No deliveries yet.</td></tr>'}
</tbody></table></div>` }));
  }

  function how(_req: IncomingMessage, res: ServerResponse) {
    html(res, 200, layout({ title: "How it works", nav: "how", body: `
<h1>How it works</h1>
<p class="lead">Small Node server + SQLite, the official Stripe SDK for API calls, and a hand-checked webhook receiver. Everything below is real Stripe (test mode) unless marked.</p>
<div class="grid">
<div class="card"><h3>Subscriptions</h3><p class="small">Stripe Checkout in <code>subscription</code> mode with a monthly and an annual price per creator. Each subscription carries <code>application_fee_percent: 20</code> and <code>transfer_data.destination</code> = the creator's connected account, so every renewal invoice splits 80/20 automatically.</p></div>
<div class="card"><h3>Access = webhooks only</h3><p class="small">The success redirect unlocks nothing. Access opens when a signed <code>checkout.session.completed</code> / <code>invoice.paid</code> arrives and closes on <code>invoice.payment_failed</code>, <code>charge.refunded</code> and <code>customer.subscription.deleted</code>.</p></div>
<div class="card"><h3>Out-of-order safe</h3><p class="small">Stripe can deliver events late or twice. Each subscription event re-reads the subscription from Stripe, so the newest state always wins; invoice status and refund amounts only move forward; event ids are de-duplicated.</p></div>
<div class="card"><h3>Connect Express</h3><p class="small">Creators onboard on Stripe-hosted account links. <code>account.updated</code> (Connect webhook) flips them to "open for members" once Stripe activates transfers.</p></div>
<div class="card"><h3>Customer portal</h3><p class="small">Members switch monthly ↔ annual, update their card and cancel in Stripe's hosted portal. The portal configuration cancels immediately, so the lock is visible straight away.</p></div>
<div class="card"><h3>Admin</h3><p class="small">Members, payments with the fee and transfer per invoice, creators' Connect status and every webhook delivery with its result.</p></div>
</div>
<h2>Try the whole loop (about 3 minutes)</h2>
<ol><li>Open a creator, join monthly, pay with <code>4242 4242 4242 4242</code>.</li><li>Back on <a href="/account">My memberships</a> the page waits for the webhook, then the posts unlock.</li>
<li>Click <b>Manage billing / cancel</b>, cancel in Stripe's portal, come back: locked.</li><li>Or subscribe again and use the demo controls: a failed renewal locks, paying with a working card unlocks, a refund locks.</li>
<li>Check the <a href="/admin">admin page</a>: 80/20 split, transfers, webhook log.</li><li><a href="/creators/new">Become a creator</a> to see Connect Express onboarding with Stripe's test data.</li></ol>` }));
  }

  function errorPage(res: ServerResponse, status: number, msg: string) {
    html(res, status, layout({ title: "Error", body: `<h1>${status === 404 ? "Not found" : "Something went wrong"}</h1><div class="notice ${status >= 500 ? "bad" : "warn"}">${esc(msg)}</div><p><a href="/">Back to creators</a></p>` }));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const m = req.method ?? "GET";
    try {
      if (m === "POST" && path === "/webhooks/stripe") return await webhook(req, res, "platform");
      if (m === "POST" && path === "/webhooks/connect") return await webhook(req, res, "connect");
      if (m === "GET" && path === "/health") return json(res, 200, { ok: true, mode: "test" });
      if (m === "GET" && path === "/") return home(req, res);
      if (m === "GET" && path === "/how") return how(req, res);
      if (m === "GET" && path === "/admin") return admin(req, res);
      if (m === "GET" && path === "/account") return await account(req, res, url);
      if (m === "GET" && path === "/creators/new") return newCreatorForm(req, res);
      if (m === "POST" && path === "/creators") return await createCreator(req, res);
      if (m === "POST" && path === "/subscribe") return await subscribe(req, res);
      if (m === "POST" && path === "/portal") return await portal(req, res);
      if (m === "POST" && path === "/demo/fail") return await demoAction(req, res, "fail");
      if (m === "POST" && path === "/demo/fix") return await demoAction(req, res, "fix");
      if (m === "POST" && path === "/demo/refund") return await demoAction(req, res, "refund");
      let mm: RegExpMatchArray | null;
      if (m === "GET" && (mm = path.match(/^\/c\/([a-z0-9-]{1,64})$/))) return creatorPage(req, res, mm[1]!, url);
      if (m === "GET" && (mm = path.match(/^\/studio\/(c_[a-z0-9]+)$/))) return await studio(req, res, mm[1]!, url);
      if (m === "GET" && (mm = path.match(/^\/studio\/(c_[a-z0-9]+)\/onboard$/))) return await onboard(req, res, mm[1]!);
      if (m === "POST" && (mm = path.match(/^\/studio\/(c_[a-z0-9]+)\/dashboard$/))) return await expressDashboard(req, res, mm[1]!);
      throw new HttpError(404, "Page not found");
    } catch (e) {
      if (e instanceof HttpError) return errorPage(res, e.status, e.message);
      log(`error ${m} ${path}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      const msg = e instanceof Error && /Connect/i.test(e.message) ? "Stripe Connect isn't enabled on this platform's test account yet." : "Stripe or the server returned an error. Please try again.";
      errorPage(res, 500, msg);
    }
  });
  return { server, handleEvent };
}

