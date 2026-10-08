import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { asRows, type Row } from "../lib/types";
import { DataState } from "./Primitives";
import { MarketChart } from "./MarketChart";
import { formatTimestamp } from "../lib/format";

export function InstrumentChart({ instrument, markers = {}, initialTimeframe = "15m", tradeId }: { instrument: string; markers?: Row; initialTimeframe?: string; tradeId?: string }) {
  const [bar, setBar] = useState(["1m", "5m", "15m", "1H"].includes(initialTimeframe) ? initialTimeframe : "15m");
  const api = useApi<unknown>(`/api/candles?instId=${encodeURIComponent(instrument)}&bar=${bar}&limit=${tradeId ? 400 : 160}${tradeId ? `&tradeId=${encodeURIComponent(tradeId)}` : ""}`, 30_000);
  const rows = asRows(api.data);
  const latest = Number(rows.at(-1)?.ts);
  const interval = ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1H": 3_600_000 }[bar] ?? 900_000);
  const stale = !tradeId && rows.length > 0 && Date.now() - latest > interval * 2;
  const entry = Date.parse(String(markers.entry_ts ?? "")), exit = Date.parse(String(markers.exit_ts ?? ""));
  const partialReplay = Boolean(tradeId && rows.length > 0 &&
    (entry < Number(rows[0]?.ts) || exit > latest + interval || rows.length >= 400));
  return <>
    <div className="instrument-toolbar"><strong>{instrument}</strong><div className="workstation-tabs" aria-label="Chart timeframe">
      {["1m", "5m", "15m", "1H"].map(tf => <button key={tf} aria-pressed={bar === tf} onClick={() => setBar(tf)}>{tf.toLowerCase()}</button>)}
    </div></div>
    {stale ? <div className="inline-warning" role="status">Market data delayed. Last candle {formatTimestamp(latest)}.</div> : null}
    {partialReplay ? <div className="inline-warning" role="status">Partial stored trade window, limited to 400 candles. Entry or exit may fall outside this window. Switch to a higher timeframe for wider context.</div> : null}
    <DataState loading={api.loading} error={api.error} empty={rows.length < 2} hasData={api.data !== null} emptyTitle="No confirmed candles for this timeframe" emptyDetail={tradeId ? "No candle window was stored for this trade and timeframe." : "The exchange feed has not returned a usable candle window."}>
      <MarketChart candles={rows} markers={markers} title={`${bar.toLowerCase()} · ${tradeId ? "trade replay" : "confirmed candles"}`}/>
    </DataState>
  </>;
}
