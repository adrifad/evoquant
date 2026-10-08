// .env mutation helpers for the dashboard Settings page (§87/§88).
// Keys are written to the env file on the SERVER only — never returned to
// the frontend. Other lines (OKX credentials etc.) are preserved verbatim.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function setEnvKeys(file: string, updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n\u0000]/.test(value)) throw new Error("Invalid settings value");
  }
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && m[1] && m[1] in updates) {
      out.push(`${m[1]}=${updates[m[1]]}`);
      seen.add(m[1]);
    } else out.push(line);
  }
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

// mask a secret for display: keep scheme prefix + length, rest dots (§87)
export function maskKey(key: string | undefined): string {
  if (!key) return "";
  const prefix = key.slice(0, 5);
  return `${prefix}${"•".repeat(12)} (${key.length} chars)`;
}
