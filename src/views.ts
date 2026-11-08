import { ACCESS_LABEL, type AccessState } from "./access.ts";
import type { CreatorRow, PaymentRow, PostRow, SubscriptionRow } from "./db.ts";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const money = (cents: number | null | undefined, currency = "usd"): string =>
  cents == null ? "–" : new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

export const date = (sec: number | null | undefined): string =>
  sec ? new Date(sec * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "–";

export const dateTime = (sec: number | null | undefined): string =>
  sec ? new Date(sec * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC" : "–";

export function maskEmail(e: string | null | undefined): string {
  if (!e) return "–";
  const [u = "", d = ""] = e.split("@");
  return `${u.slice(0, 1)}•••@${d.replace(/^(.).*(\..*)$/, "$1•••$2")}`;
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#17171a;--muted:#5d5f68;--line:#e4e4e0;--brand:#4f46e5;--brand-ink:#fff;--ok:#0f7a4d;--ok-bg:#e3f5ec;--bad:#b42318;--bad-bg:#fdecea;--warn:#8a5a00;--warn-bg:#fff4d6;--chip:#f0f0ec;--banner:#fff4d6;--banner-ink:#5c3d00;--shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04)}
@media (prefers-color-scheme:dark){:root{--bg:#111114;--card:#1a1a1f;--ink:#ececf1;--muted:#a1a3ad;--line:#2c2c33;--brand:#8b85ff;--brand-ink:#0d0d12;--ok:#4ade80;--ok-bg:#12301f;--bad:#f87171;--bad-bg:#3a1414;--warn:#facc15;--warn-bg:#352b05;--chip:#24242b;--banner:#352b05;--banner-ink:#fde68a;--shadow:none}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--brand)}
.banner{background:var(--banner);color:var(--banner-ink);font-size:14px;padding:8px 16px;text-align:center;border-bottom:1px solid var(--line)}
.banner b{font-weight:700}
header.top{max-width:1080px;margin:0 auto;padding:18px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.logo{font-weight:800;font-size:20px;text-decoration:none;color:var(--ink);letter-spacing:-.02em;display:flex;align-items:center;gap:8px}
.logo i{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#ec4899);display:inline-block}
nav{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
nav a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:8px;font-size:15px}
nav a:hover,nav a.on{background:var(--chip);color:var(--ink)}
main{max-width:1080px;margin:0 auto;padding:8px 16px 64px}
h1{font-size:clamp(28px,5vw,44px);line-height:1.1;letter-spacing:-.03em;margin:24px 0 12px}
h2{font-size:22px;letter-spacing:-.01em;margin:36px 0 12px}
h3{margin:0 0 6px;font-size:18px}
.lead{font-size:18px;color:var(--muted);max-width:680px}
.muted{color:var(--muted)}.small{font-size:14px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:var(--shadow)}
.card.creator{display:flex;flex-direction:column;gap:8px;text-decoration:none;color:inherit}
.card.creator:hover{border-color:var(--brand)}
.avatar{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:20px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--brand);background:var(--brand);color:var(--brand-ink);font:inherit;font-weight:600;padding:10px 16px;border-radius:10px;cursor:pointer;text-decoration:none;min-height:44px}
.btn.ghost{background:transparent;color:var(--brand)}
.btn.quiet{background:var(--chip);color:var(--ink);border-color:var(--line)}
.btn.danger{background:transparent;color:var(--bad);border-color:var(--bad)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
form.inline{display:inline}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.chip{display:inline-block;font-size:13px;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--chip);color:var(--muted)}
.chip.ok{background:var(--ok-bg);color:var(--ok)}.chip.bad{background:var(--bad-bg);color:var(--bad)}.chip.warn{background:var(--warn-bg);color:var(--warn)}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0}
.plan{border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--card)}
.plan .price{font-size:28px;font-weight:800;letter-spacing:-.02em}
.post{border:1px solid var(--line);border-radius:12px;padding:18px;background:var(--card);margin:12px 0}
.post.locked .body{filter:blur(5px);user-select:none;pointer-events:none}
.lockline{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:14px;margin-top:8px}
.testcard{border:1px dashed var(--line);border-radius:12px;padding:14px 16px;background:var(--card);font-size:14px}
.testcard code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
code{background:var(--chip);padding:1px 6px;border-radius:6px}
.steps{counter-reset:s;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.steps .card{position:relative;padding-top:44px}
.steps .card::before{counter-increment:s;content:counter(s);position:absolute;top:14px;left:20px;width:24px;height:24px;border-radius:50%;background:var(--brand);color:var(--brand-ink);display:grid;place-items:center;font-size:13px;font-weight:700}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin:12px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:24px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat span{font-size:13px;color:var(--muted)}
.split{display:flex;height:12px;border-radius:999px;overflow:hidden;margin:8px 0}
.split .c{background:#10b981}.split .p{background:#6366f1}
.legend{display:flex;gap:14px;font-size:13px;color:var(--muted);flex-wrap:wrap}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.notice{border-radius:12px;padding:12px 16px;margin:12px 0;border:1px solid var(--line);background:var(--card)}
.notice.ok{background:var(--ok-bg);border-color:transparent;color:var(--ok)}
.notice.bad{background:var(--bad-bg);border-color:transparent;color:var(--bad)}
.notice.warn{background:var(--warn-bg);border-color:transparent;color:var(--warn)}
label{display:block;font-weight:600;margin:14px 0 6px}
input,select,textarea{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
footer{max-width:1080px;margin:0 auto;padding:24px 16px 48px;color:var(--muted);font-size:13px;border-top:1px solid var(--line)}
@media (max-width:560px){nav{margin-left:0;width:100%}.card{padding:16px}th,td{padding:8px 10px}}
`;

export function layout(p: { title: string; body: string; nav?: string; refresh?: number }): string {
  const link = (href: string, label: string, key: string) => `<a href="${href}"${p.nav === key ? ' class="on"' : ""}>${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} · Studio Pass (demo)</title><meta name="color-scheme" content="light dark">
${p.refresh ? `<meta http-equiv="refresh" content="${p.refresh}">` : ""}
<meta name="description" content="A working demo of a creator membership platform on Stripe test mode: subscriptions, customer portal, Connect Express payouts with an 80/20 split, and signed webhooks.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%236366f1'/%3E%3C/svg%3E">
<style>${CSS}</style></head><body>
<div class="banner"><b>TEST MODE</b> · Fictional demo platform running on Stripe test mode. No real money moves. Pay with card <b>4242 4242 4242 4242</b>, any future date, any CVC.</div>
<header class="top"><a class="logo" href="/"><i></i>Studio Pass</a>
<nav>${link("/", "Creators", "home")}${link("/account", "My memberships", "account")}${link("/creators/new", "Become a creator", "new")}${link("/admin", "Admin", "admin")}${link("/how", "How it works", "how")}</nav></header>
<main>${p.body}</main>
<footer>Studio Pass is a fictional platform built to demonstrate a Stripe Billing + Connect integration. Creators, posts and prices are made up. Everything runs in Stripe <b>test mode</b>. Source: <a href="https://github.com/kabxxr7-jpg/stripe-membership">github.com/kabxxr7-jpg/stripe-membership</a></footer>
</body></html>`;
}

export function testCardBox(): string {
  return `<div class="testcard"><b>Try it with Stripe test cards</b> (test mode, nothing is charged)<br>
Success: <code>4242 4242 4242 4242</code> · Needs 3-D Secure: <code>4000 0025 0000 3155</code> · Declined: <code>4000 0000 0000 9995</code><br>
Any future expiry (e.g. <code>12/34</code>), any CVC, any ZIP. Use any email; it only goes to Stripe's test mode.</div>`;
}

export function avatar(c: CreatorRow, size = 48): string {
  const initials = c.name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
  return `<span class="avatar" style="background:${esc(c.accent)};width:${size}px;height:${size}px">${esc(initials)}</span>`;
}

export function creatorReady(c: CreatorRow): boolean {
  return !!(c.account_id && c.transfers_active && c.price_month_id && c.price_year_id);
}

export function accessChip(s: AccessState): string {
  const cls = s.open ? (s.reason === "ending" ? "warn" : "ok") : s.reason === "none" ? "" : "bad";
  return `<span class="chip ${cls}">${esc(ACCESS_LABEL[s.reason])}${s.open ? ` · until ${date(s.until)}` : ""}</span>`;
}

export function creatorCard(c: CreatorRow, s: AccessState | null): string {
  return `<a class="card creator" href="/c/${esc(c.slug)}">
<div class="row">${avatar(c)}<div><h3>${esc(c.name)}</h3><div class="muted small">${esc(c.tagline)}</div></div></div>
<div class="row small"><b>${money(c.monthly_cents)}</b>/month · <b>${money(c.annual_cents)}</b>/year</div>
<div class="row">${s && s.reason !== "none" ? accessChip(s) : creatorReady(c) ? '<span class="chip ok">Open for members</span>' : '<span class="chip warn">Finishing payout setup</span>'}${c.seeded ? "" : '<span class="chip">Yours (visitor-created)</span>'}</div></a>`;
}

export function postHtml(p: PostRow, unlocked: boolean): string {
  const locked = p.members_only && !unlocked;
  return `<article class="post${locked ? " locked" : ""}"><div class="row"><h3>${esc(p.title)}</h3>${p.members_only ? (locked ? '<span class="chip">Members only</span>' : '<span class="chip ok">Members only · unlocked</span>') : '<span class="chip">Free preview</span>'}</div>
<p class="muted">${esc(p.preview)}</p><div class="body">${locked ? esc("This post is for members. ".repeat(14)) : esc(p.body).replace(/\n\n/g, "</p><p>").replace(/^/, "<p>") + "</p>"}</div>
${locked ? '<div class="lockline">🔒 Locked. The server only sends this text after Stripe confirms your payment by webhook.</div>' : ""}</article>`;
}

export function subscriptionsTable(rows: { sub: SubscriptionRow; creator: CreatorRow | undefined; state: AccessState; email?: string | null }[], withMember: boolean): string {
  if (rows.length === 0) return `<p class="muted">None yet.</p>`;
  return `<div class="tablewrap"><table><thead><tr>${withMember ? "<th>Member</th>" : ""}<th>Creator</th><th>Plan</th><th>Stripe status</th><th>Access</th><th>Paid through</th><th>Subscription</th></tr></thead><tbody>
${rows.map((r) => `<tr>${withMember ? `<td>${esc(maskEmail(r.email))}</td>` : ""}<td>${esc(r.creator?.name ?? "–")}</td><td>${money(r.sub.amount_cents)}/${esc(r.sub.interval ?? "")}</td><td><span class="chip">${esc(r.sub.status)}</span>${r.sub.cancel_at_period_end ? ' <span class="chip warn">cancel at end</span>' : ""}</td><td>${accessChip(r.state)}</td><td>${date(r.sub.current_period_end)}</td><td class="mono">${esc(r.sub.id)}</td></tr>`).join("")}
</tbody></table></div>`;
}

export function paymentsTable(rows: (PaymentRow & { creator_name?: string | null; refunded?: number | null })[]): string {
  if (rows.length === 0) return `<p class="muted">No payments yet.</p>`;
  return `<div class="tablewrap"><table><thead><tr><th>When (UTC)</th><th>Creator</th><th>Status</th><th class="num">Gross</th><th class="num">Platform 20%</th><th class="num">Creator 80%</th><th>Transfer</th><th>Invoice</th></tr></thead><tbody>
${rows.map((p) => {
  const status = p.refunded ? '<span class="chip bad">refunded</span>' : p.status === "paid" ? '<span class="chip ok">paid</span>' : p.status === "failed" ? '<span class="chip bad">failed</span>' : `<span class="chip">${esc(p.status)}</span>`;
  return `<tr><td>${dateTime(p.created)}</td><td>${esc(p.creator_name ?? "–")}</td><td>${status}</td><td class="num">${money(p.amount_cents, p.currency)}</td><td class="num">${p.status === "paid" ? money(p.application_fee_cents, p.currency) : "–"}</td><td class="num">${p.status === "paid" ? money(p.transfer_cents, p.currency) : "–"}</td><td class="mono">${esc(p.transfer_id ?? "–")}</td><td class="mono">${esc(p.invoice_id)}</td></tr>`;
}).join("")}
</tbody></table></div>`;
}
