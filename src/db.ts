import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  customer_id TEXT UNIQUE,
  email TEXT
);
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT '#4f46e5',
  monthly_cents INTEGER NOT NULL,
  annual_cents INTEGER NOT NULL,
  product_id TEXT,
  price_month_id TEXT,
  price_year_id TEXT,
  account_id TEXT UNIQUE,
  details_submitted INTEGER NOT NULL DEFAULT 0,
  transfers_active INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  owner_visitor_id TEXT,
  portal_config_id TEXT,
  seeded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  preview TEXT NOT NULL,
  body TEXT NOT NULL,
  members_only INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  visitor_id TEXT,
  creator_id TEXT,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  interval TEXT,
  amount_cents INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at INTEGER,
  latest_invoice_id TEXT,
  latest_payment_intent TEXT,
  latest_invoice_status TEXT,
  created_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  invoice_id TEXT PRIMARY KEY,
  subscription_id TEXT,
  creator_id TEXT,
  visitor_id TEXT,
  payment_intent TEXT,
  charge_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  application_fee_cents INTEGER,
  transfer_cents INTEGER,
  transfer_id TEXT,
  billing_reason TEXT,
  created INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_pi ON payments (payment_intent);
CREATE TABLE IF NOT EXISTS refunds (
  payment_intent TEXT PRIMARY KEY,
  charge_id TEXT,
  amount_refunded INTEGER NOT NULL,
  fully_refunded INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_events (
  id TEXT PRIMARY KEY,
  type TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  locked_at INTEGER NOT NULL,
  finished_at INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  type TEXT,
  endpoint TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // migration for databases created before per-creator portal configurations
  const cols = (db.prepare("PRAGMA table_info(creators)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("portal_config_id")) db.exec("ALTER TABLE creators ADD COLUMN portal_config_id TEXT");
  return db;
}

// ---------- row types ----------
export interface VisitorRow { id: string; created_at: number; customer_id: string | null; email: string | null }
export interface CreatorRow {
  id: string; slug: string; name: string; tagline: string; bio: string; accent: string;
  monthly_cents: number; annual_cents: number;
  product_id: string | null; price_month_id: string | null; price_year_id: string | null;
  account_id: string | null; details_submitted: number; transfers_active: number; payouts_enabled: number;
  owner_visitor_id: string | null; portal_config_id?: string | null; seeded: number; created_at: number;
}
export interface PostRow { id: number; creator_id: string; title: string; preview: string; body: string; members_only: number; created_at: number }
export interface SubscriptionRow {
  id: string; visitor_id: string | null; creator_id: string | null; customer_id: string; status: string;
  interval: string | null; amount_cents: number | null; current_period_end: number | null;
  cancel_at_period_end: number; canceled_at: number | null;
  latest_invoice_id: string | null; latest_payment_intent: string | null; latest_invoice_status: string | null;
  created_at: number; synced_at: number;
}
export interface PaymentRow {
  invoice_id: string; subscription_id: string | null; creator_id: string | null; visitor_id: string | null;
  payment_intent: string | null; charge_id: string | null; amount_cents: number; currency: string; status: string;
  application_fee_cents: number | null; transfer_cents: number | null; transfer_id: string | null;
  billing_reason: string | null; created: number; updated_at: number;
}
export interface RefundRow { payment_intent: string; charge_id: string | null; amount_refunded: number; fully_refunded: number; updated_at: number }

const now = () => Math.floor(Date.now() / 1000);

// ---------- visitors ----------
export function getVisitor(db: Db, id: string): VisitorRow | undefined {
  return db.prepare("SELECT * FROM visitors WHERE id = ?").get(id) as VisitorRow | undefined;
}
export function ensureVisitor(db: Db, id: string): VisitorRow {
  db.prepare("INSERT INTO visitors (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING").run(id, now());
  return getVisitor(db, id)!;
}
export function setVisitorCustomer(db: Db, id: string, customerId: string): void {
  db.prepare("UPDATE visitors SET customer_id = ? WHERE id = ? AND customer_id IS NULL").run(customerId, id);
}
export function setVisitorEmail(db: Db, id: string, email: string): void {
  db.prepare("UPDATE visitors SET email = ? WHERE id = ?").run(email, id);
}
export function visitorByCustomer(db: Db, customerId: string): VisitorRow | undefined {
  return db.prepare("SELECT * FROM visitors WHERE customer_id = ?").get(customerId) as VisitorRow | undefined;
}

// ---------- creators ----------
export function insertCreator(db: Db, c: Omit<CreatorRow, "details_submitted" | "transfers_active" | "payouts_enabled" | "created_at"> & Partial<CreatorRow>): void {
  db.prepare(
    `INSERT INTO creators (id, slug, name, tagline, bio, accent, monthly_cents, annual_cents, product_id, price_month_id, price_year_id, account_id, owner_visitor_id, seeded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.id, c.slug, c.name, c.tagline, c.bio, c.accent, c.monthly_cents, c.annual_cents, c.product_id, c.price_month_id, c.price_year_id, c.account_id, c.owner_visitor_id, c.seeded, c.created_at ?? now());
}
export function updateCreatorStripe(db: Db, id: string, f: { product_id?: string; price_month_id?: string; price_year_id?: string; account_id?: string; portal_config_id?: string }): void {
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined) db.prepare(`UPDATE creators SET ${k} = ? WHERE id = ?`).run(v, id);
  }
}
export function setCreatorAccountStatus(db: Db, accountId: string, s: { detailsSubmitted: boolean; transfersActive: boolean; payoutsEnabled: boolean }): number {
  const r = db.prepare("UPDATE creators SET details_submitted = ?, transfers_active = ?, payouts_enabled = ? WHERE account_id = ?")
    .run(s.detailsSubmitted ? 1 : 0, s.transfersActive ? 1 : 0, s.payoutsEnabled ? 1 : 0, accountId);
  return Number(r.changes);
}
export function getCreator(db: Db, id: string): CreatorRow | undefined {
  return db.prepare("SELECT * FROM creators WHERE id = ?").get(id) as CreatorRow | undefined;
}
export function getCreatorBySlug(db: Db, slug: string): CreatorRow | undefined {
  return db.prepare("SELECT * FROM creators WHERE slug = ?").get(slug) as CreatorRow | undefined;
}
export function listCreators(db: Db, opts: { seededOrOwner?: string | null; all?: boolean } = {}): CreatorRow[] {
  if (opts.all) return db.prepare("SELECT * FROM creators ORDER BY seeded DESC, created_at").all() as unknown as CreatorRow[];
  return db.prepare("SELECT * FROM creators WHERE seeded = 1 OR owner_visitor_id = ? ORDER BY seeded DESC, created_at")
    .all(opts.seededOrOwner ?? "") as unknown as CreatorRow[];
}
export function countCreatorsSince(db: Db, sinceSec: number): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM creators WHERE seeded = 0 AND created_at >= ?").get(sinceSec) as { n: number }).n);
}
export function creatorsOwnedBy(db: Db, visitorId: string): CreatorRow[] {
  return db.prepare("SELECT * FROM creators WHERE owner_visitor_id = ? ORDER BY created_at").all(visitorId) as unknown as CreatorRow[];
}

// ---------- posts ----------
export function insertPost(db: Db, p: { creator_id: string; title: string; preview: string; body: string; members_only: boolean }): void {
  db.prepare("INSERT INTO posts (creator_id, title, preview, body, members_only, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(p.creator_id, p.title, p.preview, p.body, p.members_only ? 1 : 0, now());
}
export function postsFor(db: Db, creatorId: string): PostRow[] {
  return db.prepare("SELECT * FROM posts WHERE creator_id = ? ORDER BY members_only, id").all(creatorId) as unknown as PostRow[];
}

// ---------- subscriptions ----------
export function upsertSubscription(db: Db, s: Omit<SubscriptionRow, "created_at" | "synced_at">): void {
  const t = now();
  db.prepare(
    `INSERT INTO subscriptions (id, visitor_id, creator_id, customer_id, status, interval, amount_cents, current_period_end, cancel_at_period_end, canceled_at, latest_invoice_id, latest_payment_intent, latest_invoice_status, created_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       visitor_id = COALESCE(excluded.visitor_id, subscriptions.visitor_id),
       creator_id = COALESCE(excluded.creator_id, subscriptions.creator_id),
       status = excluded.status, interval = excluded.interval, amount_cents = excluded.amount_cents,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       canceled_at = excluded.canceled_at, latest_invoice_id = excluded.latest_invoice_id,
       -- a $0 invoice (e.g. a plan change netted by credit) has no payment: keep pointing at the payment that paid for the period
       latest_payment_intent = COALESCE(excluded.latest_payment_intent, subscriptions.latest_payment_intent),
       latest_invoice_status = excluded.latest_invoice_status,
       synced_at = excluded.synced_at`,
  ).run(s.id, s.visitor_id, s.creator_id, s.customer_id, s.status, s.interval, s.amount_cents, s.current_period_end,
    s.cancel_at_period_end, s.canceled_at, s.latest_invoice_id, s.latest_payment_intent, s.latest_invoice_status, t, t);
}
export function getSubscription(db: Db, id: string): SubscriptionRow | undefined {
  return db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined;
}
export function subscriptionsForVisitor(db: Db, visitorId: string): SubscriptionRow[] {
  return db.prepare("SELECT * FROM subscriptions WHERE visitor_id = ? ORDER BY created_at DESC").all(visitorId) as unknown as SubscriptionRow[];
}
export function subscriptionForVisitorCreator(db: Db, visitorId: string, creatorId: string): SubscriptionRow[] {
  return db.prepare("SELECT * FROM subscriptions WHERE visitor_id = ? AND creator_id = ? ORDER BY created_at DESC").all(visitorId, creatorId) as unknown as SubscriptionRow[];
}
export function subscriptionIdForPaymentIntent(db: Db, pi: string): string | undefined {
  const a = db.prepare("SELECT subscription_id AS id FROM payments WHERE payment_intent = ? AND subscription_id IS NOT NULL").get(pi) as { id: string } | undefined;
  if (a) return a.id;
  const b = db.prepare("SELECT id FROM subscriptions WHERE latest_payment_intent = ?").get(pi) as { id: string } | undefined;
  return b?.id;
}

// ---------- payments ----------
const STATUS_RANK: Record<string, number> = { open: 0, failed: 1, paid: 2 };

/**
 * Records an invoice outcome. A late "failed" never overwrites "paid" for the same invoice
 * (Stripe does not guarantee delivery order), and a split already known is never blanked.
 */
export function upsertPayment(db: Db, p: Omit<PaymentRow, "updated_at">): void {
  const existing = db.prepare("SELECT * FROM payments WHERE invoice_id = ?").get(p.invoice_id) as PaymentRow | undefined;
  const keepStatus = existing && (STATUS_RANK[existing.status] ?? 0) > (STATUS_RANK[p.status] ?? 0);
  const merged: PaymentRow = {
    ...p,
    status: keepStatus ? existing.status : p.status,
    subscription_id: p.subscription_id ?? existing?.subscription_id ?? null,
    creator_id: p.creator_id ?? existing?.creator_id ?? null,
    visitor_id: p.visitor_id ?? existing?.visitor_id ?? null,
    payment_intent: p.payment_intent ?? existing?.payment_intent ?? null,
    charge_id: p.charge_id ?? existing?.charge_id ?? null,
    application_fee_cents: p.application_fee_cents ?? existing?.application_fee_cents ?? null,
    transfer_cents: p.transfer_cents ?? existing?.transfer_cents ?? null,
    transfer_id: p.transfer_id ?? existing?.transfer_id ?? null,
    billing_reason: p.billing_reason ?? existing?.billing_reason ?? null,
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO payments (invoice_id, subscription_id, creator_id, visitor_id, payment_intent, charge_id, amount_cents, currency, status, application_fee_cents, transfer_cents, transfer_id, billing_reason, created, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (invoice_id) DO UPDATE SET subscription_id = excluded.subscription_id, creator_id = excluded.creator_id,
       visitor_id = excluded.visitor_id, payment_intent = excluded.payment_intent, charge_id = excluded.charge_id,
       amount_cents = excluded.amount_cents, currency = excluded.currency, status = excluded.status,
       application_fee_cents = excluded.application_fee_cents, transfer_cents = excluded.transfer_cents,
       transfer_id = excluded.transfer_id, billing_reason = excluded.billing_reason, updated_at = excluded.updated_at`,
  ).run(merged.invoice_id, merged.subscription_id, merged.creator_id, merged.visitor_id, merged.payment_intent, merged.charge_id,
    merged.amount_cents, merged.currency, merged.status, merged.application_fee_cents, merged.transfer_cents, merged.transfer_id,
    merged.billing_reason, merged.created, merged.updated_at);
}
export function getPayment(db: Db, invoiceId: string): PaymentRow | undefined {
  return db.prepare("SELECT * FROM payments WHERE invoice_id = ?").get(invoiceId) as PaymentRow | undefined;
}
export function paymentsForCreator(db: Db, creatorId: string): PaymentRow[] {
  return db.prepare("SELECT * FROM payments WHERE creator_id = ? ORDER BY created DESC").all(creatorId) as unknown as PaymentRow[];
}
export function latestPaidPaymentForSubscription(db: Db, subId: string): PaymentRow | undefined {
  return db.prepare("SELECT * FROM payments WHERE subscription_id = ? AND status = 'paid' ORDER BY created DESC LIMIT 1").get(subId) as PaymentRow | undefined;
}

// ---------- refunds ----------
/** Refund amounts only grow, so the larger value always wins whatever order events arrive in. */
export function upsertRefund(db: Db, r: Omit<RefundRow, "updated_at">): void {
  db.prepare(
    `INSERT INTO refunds (payment_intent, charge_id, amount_refunded, fully_refunded, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (payment_intent) DO UPDATE SET
       charge_id = COALESCE(excluded.charge_id, refunds.charge_id),
       amount_refunded = MAX(refunds.amount_refunded, excluded.amount_refunded),
       fully_refunded = MAX(refunds.fully_refunded, excluded.fully_refunded),
       updated_at = excluded.updated_at`,
  ).run(r.payment_intent, r.charge_id, r.amount_refunded, r.fully_refunded, now());
}
export function getRefund(db: Db, pi: string): RefundRow | undefined {
  return db.prepare("SELECT * FROM refunds WHERE payment_intent = ?").get(pi) as RefundRow | undefined;
}

// ---------- event log ----------
export function logEvent(db: Db, e: { event_id: string | null; type: string | null; endpoint: string; http_status: number; outcome: string }): void {
  db.prepare("INSERT INTO event_log (event_id, type, endpoint, http_status, outcome, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(e.event_id, e.type, e.endpoint, e.http_status, e.outcome, now());
  db.prepare("DELETE FROM event_log WHERE id <= (SELECT MAX(id) - 500 FROM event_log)").run();
}
