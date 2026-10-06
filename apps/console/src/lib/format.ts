import { asNumber, asText } from "./types";

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
  return `${number < 0 ? "−" : number > 0 ? "+" : ""}${numberFormat.format(Math.abs(number))} ${currency}`;
}

export function formatPercent(value: unknown, digits = 2): string {
  const number = asNumber(value);
  return number === null ? "N/A" : `${number > 0 ? "+" : ""}${formatNumber(number, digits)}%`;
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
