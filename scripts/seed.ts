/**
 * Seeds the three fictional platform creators: local rows and posts, a Stripe product with a
 * monthly and an annual price each, and a Connect Express account each. Safe to re-run.
 * `node scripts/seed.ts --links` prints an onboarding link for every seeded creator not yet onboarded.
 */
import { assertTestKey } from "../src/config.ts";
import { getCreator, insertCreator, insertPost, openDb, setCreatorAccountStatus, updateCreatorStripe } from "../src/db.ts";
import { createStripeBilling } from "../src/gateway.ts";

process.loadEnvFile(".env");
const key = process.env["STRIPE_SECRET_KEY"] ?? "";
assertTestKey(key);
const base = (process.env["PUBLIC_BASE_URL"] ?? "http://localhost:8082").replace(/\/$/, "");
const db = openDb(process.env["DB_PATH"] ?? "data/members.db");
const billing = createStripeBilling(key);

const CREATORS = [
  {
    id: "c_seed_mara", slug: "mara-okafor", name: "Mara Okafor", accent: "#0ea5e9", monthly: 800,
    tagline: "Field recordings and the stories behind them",
    bio: "Mara (a fictional creator) records rivers, markets and night trains, and writes about how each sound was caught.",
    posts: [
      { t: "How I record rain without the hiss", p: "A free look at my three-mic setup.", b: "The trick is distance and a dead cat windscreen. Free post, anyone can read it.", m: false },
      { t: "Session notes: the 5 a.m. fish market", p: "Gain settings, placement and the full 40-minute take.", b: "Members-only. I set the recorder at -18 dB and walked the aisle twice before pressing record.\n\nThe full take and my edit decisions are below. Access to this post was unlocked by a verified Stripe webhook.", m: true },
      { t: "Monthly sample pack: rivers", p: "Twelve loops, cleared for your projects.", b: "Members-only. Twelve loops recorded along three rivers, with notes on where each one was captured.", m: true },
    ],
  },
  {
    id: "c_seed_theo", slug: "theo-lind", name: "Theo Lind", accent: "#f59e0b", monthly: 500,
    tagline: "Sourdough, step by step, every week",
    bio: "Theo (a fictional creator) bakes one loaf a day and writes down what went wrong.",
    posts: [
      { t: "My starter schedule", p: "Feeding times that fit a working week.", b: "Feed at 7 a.m. and 9 p.m., 1:5:5. Free post.", m: false },
      { t: "Hydration table for every flour I use", p: "Twelve flours, tested.", b: "Members-only. Rye 85%, spelt 72%, strong white 75%. The full table, plus the loaves that failed and why.", m: true },
    ],
  },
  {
    id: "c_seed_juno", slug: "juno-park", name: "Juno Park", accent: "#10b981", monthly: 1200,
    tagline: "Watercolour lessons with full-resolution scans",
    bio: "Juno (a fictional creator) paints city corners in under an hour and shares every layer.",
    posts: [
      { t: "The only three brushes you need", p: "A free starter post.", b: "A size 12 round, a 1-inch flat and a rigger. Free post.", m: false },
      { t: "Lesson 14: wet-in-wet skies", p: "Video notes and a printable scan.", b: "Members-only. Wet the whole sky, drop in cerulean, tilt the board 15 degrees and wait.", m: true },
    ],
  },
];

for (const c of CREATORS) {
  if (!getCreator(db, c.id)) {
    insertCreator(db, { id: c.id, slug: c.slug, name: c.name, tagline: c.tagline, bio: c.bio, accent: c.accent, monthly_cents: c.monthly, annual_cents: c.monthly * 10, product_id: null, price_month_id: null, price_year_id: null, account_id: null, owner_visitor_id: null, seeded: 1 });
    for (const p of c.posts) insertPost(db, { creator_id: c.id, title: p.t, preview: p.p, body: p.b, members_only: p.m });
    console.log(`seeded ${c.name}`);
  }
  let row = getCreator(db, c.id)!;
  if (!row.product_id) {
    const pr = await billing.createProductAndPrices({ name: c.name, monthlyCents: c.monthly, annualCents: c.monthly * 10, creatorId: c.id });
    updateCreatorStripe(db, c.id, { product_id: pr.productId, price_month_id: pr.monthId, price_year_id: pr.yearId });
    console.log(`  product + prices for ${c.name}`);
  }
  row = getCreator(db, c.id)!;
  if (!row.portal_config_id) {
    updateCreatorStripe(db, c.id, { portal_config_id: await billing.createCreatorPortalConfig({ creatorId: c.id, name: c.name, productId: row.product_id!, priceIds: [row.price_month_id!, row.price_year_id!] }) });
    console.log(`  portal configuration for ${c.name}`);
  }
  row = getCreator(db, c.id)!;
  if (!row.account_id) {
    try {
      const acct = await billing.createExpressAccount({ creatorId: c.id, name: c.name, url: `${base}/c/${c.slug}` });
      updateCreatorStripe(db, c.id, { account_id: acct });
      console.log(`  Express account ${acct}`);
    } catch (e) {
      console.log(`  could not create an Express account (is Connect enabled on the test account?): ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
  }
  row = getCreator(db, c.id)!;
  setCreatorAccountStatus(db, row.account_id!, await billing.getAccountStatus(row.account_id!));
  row = getCreator(db, c.id)!;
  console.log(`  ${c.name}: details=${row.details_submitted} transfers=${row.transfers_active} payouts=${row.payouts_enabled}`);
  if (process.argv.includes("--links") && !row.transfers_active) {
    console.log(`  onboarding link: ${await billing.createAccountLink({ accountId: row.account_id!, refreshUrl: `${base}/`, returnUrl: `${base}/admin` })}`);
  }
}
db.close();
