export type Row = Record<string, unknown>;

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  reload: () => Promise<void>;
}

export function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => isRow(item)) : [];
}

export function asRow(value: unknown): Row | null {
  return isRow(value) ? value : null;
}

export function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T | null | undefined) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function asText(value: unknown, fallback = "N/A"): string {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
