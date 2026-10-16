import { asNumber, asText } from "./types.ts";

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const preciseFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const signedFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "always" });

export function formatNumber(value: unknown, digits = 2): string {
  const number = asNumber(value);
  if (number === null) return "N/A";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number);
}

export function formatPrice(value: unknown): string {
  const number = asNumber(value);
  if (number === null) return "N/A";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(number);
}

export function formatPrecise(value: unknown): string {
  const number = asNumber(value);
  return number === null ? "N/A" : preciseFormat.format(number);
}

export function formatMoney(value: unknown, currency = "USDT"): string {
  const number = asNumber(value);
  if (number === null) return "N/A";
  const sign = number < 0 ? "−" : number > 0 ? "+" : "";
  const absolute = Math.abs(number);
  if (number !== 0 && absolute < 0.000001) return `${sign}<0.000001 ${currency}`;
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: number !== 0 && absolute < 0.01 ? 6 : 2,
    maximumFractionDigits: number !== 0 && absolute < 0.01 ? 6 : 2,
  });
  return `${sign}${formatter.format(absolute)} ${currency}`;
}

export function formatAmount(value: unknown, currency = "USDT"): string {
  const number = asNumber(value);
  if (number === null) return "N/A";
  return `${numberFormat.format(number)}${currency ? ` ${currency}` : ""}`;
}

export function formatLeverage(value: unknown): string {
  return asNumber(value) === null ? "N/A" : `${formatPrice(value)}x`;
}

export function formatPercent(value: unknown, digits = 2, signed = true): string {
  const number = asNumber(value);
  return number === null ? "N/A" : `${signed && number > 0 ? "+" : ""}${formatNumber(number, digits)}%`;
}

export function formatR(value: unknown): string {
  const number = asNumber(value);
  return number === null ? "N/A" : `${signedFormat.format(number)}R`;
}

export function formatTimestamp(value: unknown): string {
  const raw = asText(value, "");
  if (!raw) return "N/A";
  const isEpoch = typeof value === "number" || /^\d{12,}$/.test(raw);
  const date = new Date(isEpoch ? Number(value) : raw);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    timeZone: "UTC", timeZoneName: "short",
  }).format(date);
}

export function formatDuration(value: unknown): string {
  const number = asNumber(value);
  if (number === null || number < 0) return "N/A";
  const seconds = Math.floor(number);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function toneFor(value: unknown): "positive" | "negative" | "neutral" {
  const number = asNumber(value);
  return number === null || number === 0 ? "neutral" : number > 0 ? "positive" : "negative";
}

export function evidenceLevel(sample: unknown): { label: string; tone: string } {
  const count = asNumber(sample) ?? 0;
  if (count < 5) return { label: "INSUFFICIENT", tone: "neutral" };
  if (count < 15) return { label: "LOW", tone: "warning" };
  if (count < 30) return { label: "MODERATE", tone: "info" };
  return { label: "HIGH", tone: "positive" };
}
