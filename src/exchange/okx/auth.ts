// M1 scope item 2 — OK-ACCESS-* request signing.
// Spec §6 (OK-ACCESS-KEY/SIGN/TIMESTAMP/PASSPHRASE), §5.2 (x-simulated-trading: 1).
//
// prehash = timestamp + METHOD(upper) + requestPath(+query) + body
// signature = Base64(HMAC-SHA256(secret, prehash))
//
// Pure functions only; timestamp is injectable for deterministic tests.

import { createHmac } from "node:crypto";

export interface OkxCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

// OKX timestamp format: ISO-8601 UTC with milliseconds, e.g. 2026-10-01T12:00:00.000Z
export function okxTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

export function buildPrehash(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string = "",
): string {
  return `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
}

export function signPayload(prehash: string, secret: string): string {
  return createHmac("sha256", secret).update(prehash, "utf8").digest("base64");
}

export function buildAuthHeaders(
  credentials: OkxCredentials,
  method: string,
  requestPath: string,
  body: string,
  timestamp: string = okxTimestamp(),
): Record<string, string> {
  const signature = signPayload(
    buildPrehash(timestamp, method, requestPath, body),
    credentials.secret,
  );
  return {
    "OK-ACCESS-KEY": credentials.apiKey,
    "OK-ACCESS-SIGN": signature,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
  };
}
