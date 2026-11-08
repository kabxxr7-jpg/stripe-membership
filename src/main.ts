import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createStripeBilling } from "./gateway.ts";
import { createApp } from "./app.ts";

const config = loadConfig();
if (!config.webhookSecret) console.warn("STRIPE_WEBHOOK_SECRET is not set: run `npm run setup:stripe`. Webhooks will answer 503.");
const db = openDb(config.dbPath);
const { server } = createApp({ db, billing: createStripeBilling(config.stripeSecretKey), config });
server.listen(config.port, config.host, () => console.log(`Studio Pass (Stripe TEST mode) on http://${config.host}:${config.port} -> ${config.publicBaseUrl}`));
const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
