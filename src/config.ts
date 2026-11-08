import { existsSync } from "node:fs";

export interface Config {
  port: number;
  host: string;
  publicBaseUrl: string;
  stripeSecretKey: string;
  webhookSecret: string;
  connectWebhookSecret: string;
  portalConfigId: string;
  sessionSecret: string;
  dbPath: string;
  platformFeePercent: number;
}

/** Loads `.env` (if present) and refuses anything but a Stripe TEST key. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, envFile = ".env"): Config {
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile);
  const key = env["STRIPE_SECRET_KEY"] ?? "";
  assertTestKey(key);
  const sessionSecret = env["SESSION_SECRET"] ?? "";
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters (npm run setup:stripe writes one)");
  return {
    port: Number(env["PORT"] ?? 8082),
    host: env["HOST"] ?? "127.0.0.1",
    publicBaseUrl: (env["PUBLIC_BASE_URL"] ?? "http://localhost:8082").replace(/\/$/, ""),
    stripeSecretKey: key,
    webhookSecret: env["STRIPE_WEBHOOK_SECRET"] ?? "",
    connectWebhookSecret: env["STRIPE_CONNECT_WEBHOOK_SECRET"] ?? "",
    portalConfigId: env["STRIPE_PORTAL_CONFIG_ID"] ?? "",
    sessionSecret,
    dbPath: env["DB_PATH"] ?? "data/members.db",
    platformFeePercent: 20,
  };
}

/** This demo must never touch real money. */
export function assertTestKey(key: string): void {
  if (/^(sk|rk)_live_/.test(key)) throw new Error("Refusing to start: a LIVE Stripe key was supplied. This demo runs in test mode only.");
  if (!/^(sk|rk)_test_/.test(key)) throw new Error("STRIPE_SECRET_KEY must be a Stripe test key (sk_test_...)");
}
