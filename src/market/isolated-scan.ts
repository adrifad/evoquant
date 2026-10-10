export interface IsolatedScanResult<T> {
  values: T[];
  failures: Array<{ symbol: string; error: unknown }>;
}

/** Sequential per-symbol isolation keeps failures local and avoids request fan-out. */
export async function scanSymbolsIsolated<T>(
  symbols: readonly string[],
  evaluate: (symbol: string) => Promise<T | null>,
  onFailure: (symbol: string, error: unknown) => void,
): Promise<IsolatedScanResult<T>> {
  const values: T[] = [];
  const failures: Array<{ symbol: string; error: unknown }> = [];
  for (const symbol of symbols) {
    try {
      const value = await evaluate(symbol);
      if (value !== null) values.push(value);
    } catch (error) {
      failures.push({ symbol, error });
      onFailure(symbol, error);
    }
  }
  return { values, failures };
}
