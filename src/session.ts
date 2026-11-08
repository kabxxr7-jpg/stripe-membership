import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Anonymous visitor identity: a random id in an HMAC-signed, HttpOnly cookie. No passwords:
 * a visitor's memberships belong to their browser (stated on the page).
 */
export const COOKIE = "sp_vid";

export function newVisitorId(): string {
  return "v_" + randomBytes(12).toString("base64url");
}

export function signId(id: string, secret: string): string {
  return `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
}

export function verifySigned(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  if (!/^v_[A-Za-z0-9_-]{16}$/.test(id)) return null;
  const expected = Buffer.from(signId(id, secret).slice(dot + 1));
  const got = Buffer.from(value.slice(dot + 1));
  return expected.length === got.length && timingSafeEqual(expected, got) ? id : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function cookieHeader(value: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}${secure ? "; Secure" : ""}`;
}
