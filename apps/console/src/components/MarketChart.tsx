import { useMemo, useState, type MouseEvent } from "react";
import { asNumber, asRows, asText, type Row } from "../lib/types";
import { formatPrice, formatTimestamp } from "../lib/format";

type Candle = Row & { ts?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; vol?: unknown };

export function MarketChart({ candles, markers = {}, title = "Market structure" }: { candles: Candle[]; markers?: Row; title?: string }) {
  const [ema20On, setEma20On] = useState(false);
  const [ema50On, setEma50On] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const values = useMemo(() => candles.map(c => ({
    ts: c.ts,
    open: asNumber(c.o), high: asNumber(c.h), low: asNumber(c.l), close: asNumber(c.c), volume: asNumber(c.vol),
  })).filter(c => c.open !== null && c.high !== null && c.low !== null && c.close !== null), [candles]);
  const width = 860, height = 330, plotLeft = 12, plotTop = 14, plotRight = 78, plotBottom = 30;
  if (values.length < 2) return <div className="chart-empty"><strong>Waiting for first confirmed candle</strong><span>The chart fills as confirmed market data is stored.</span></div>;

  const rawPrices = values.flatMap(c => [c.high!, c.low!]);
  for (const key of ["entry_px", "stop_px", "take_profit_px", "exit_px"]) {
    const value = asNumber(markers[key]);
    if (value !== null) rawPrices.push(value);
  }
  const rawLow = Math.min(...rawPrices), rawHigh = Math.max(...rawPrices);
  const pad = Math.max((rawHigh - rawLow) * 0.07, Math.abs(rawHigh) * 0.00015, 0.000001);
  const low = rawLow - pad, high = rawHigh + pad;
  const plotWidth = width - plotLeft - plotRight, plotHeight = height - plotTop - plotBottom;
  const y = (price: number) => plotTop + (high - price) / (high - low) * plotHeight;
  const step = plotWidth / values.length;
  const candleWidth = Math.max(2, Math.min(11, step * 0.62));
  const mapX = (index: number) => plotLeft + (index + 0.5) * step;
  const ema = (period: number) => {
    const factor = 2 / (period + 1);
    let current = values[0]!.close!;
    return values.map((item, index) => (current = index === 0 ? item.close! : item.close! * factor + current * (1 - factor)));
  };
  const ema20 = ema(20), ema50 = ema(50);
  const markersConfig = [
    { key: "entry_px", label: `ENTRY ${asText(markers.side, "")}`, cls: "chart-entry" },
    { key: "stop_px", label: "STOP", cls: "chart-stop" },
    { key: "take_profit_px", label: "TARGET", cls: "chart-target" },
    { key: "exit_px", label: `EXIT ${asText(markers.exit_reason, "")}`, cls: "chart-exit" },
  ];
  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewX = (event.clientX - rect.left) / rect.width * width;
    const index = Math.max(0, Math.min(values.length - 1, Math.floor((viewX - plotLeft) / plotWidth * values.length)));
    setActiveIndex(current => current === index ? current : index);
  };
  const active = activeIndex === null ? null : values[activeIndex];
  const timePoints = [0, Math.floor((values.length - 1) / 2), values.length - 1];

  return <div className="chart-frame">
    <div className="chart-toolbar">
      <div><strong>{title}</strong><span>{values.length} confirmed candles</span></div>
      <div className="chart-overlays" aria-label="Chart overlays">
        <button className={ema20On ? "overlay-active" : ""} aria-pressed={ema20On} onClick={() => setEma20On(v => !v)}>EMA20</button>
        <button className={ema50On ? "overlay-active" : ""} aria-pressed={ema50On} onClick={() => setEma50On(v => !v)}>EMA50</button>
      </div>
    </div>
    {active ? <div className="chart-readout" aria-live="polite">
      <span>{formatTimestamp(active.ts)}</span><span>O {formatPrice(active.open)}</span><span>H {formatPrice(active.high)}</span><span>L {formatPrice(active.low)}</span><span>C {formatPrice(active.close)}</span>
    </div> : null}
    <svg className="market-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Confirmed market candlestick chart. Move pointer across candles to inspect OHLC values." onMouseMove={onMove} onMouseLeave={() => setActiveIndex(null)}>
      {Array.from({ length: 5 }, (_, index) => {
        const price = high - ((high - low) * index / 4);
        const py = y(price);
        return <g key={`grid-${index}`} className="chart-gridline"><line x1={plotLeft} x2={width - plotRight + 4} y1={py} y2={py}/><text x={width - plotRight + 10} y={py + 4}>{formatPrice(price)}</text></g>;
      })}
      {values.map((candle, index) => {
        const x = mapX(index), rising = candle.close! >= candle.open!;
        const bodyY = Math.min(y(candle.open!), y(candle.close!));
        const bodyHeight = Math.max(1.3, Math.abs(y(candle.open!) - y(candle.close!)));
        return <g key={asText(candle.ts, String(index))} className={rising ? "candle-up" : "candle-down"}>
          <line x1={x} x2={x} y1={y(candle.high!)} y2={y(candle.low!)}/>
          <rect x={x - candleWidth / 2} y={bodyY} width={candleWidth} height={bodyHeight}/>
        </g>;
      })}
      {ema20On ? <polyline className="ema-line ema-20" points={ema20.map((value, index) => `${mapX(index)},${y(value)}`).join(" ")}/> : null}
      {ema50On ? <polyline className="ema-line ema-50" points={ema50.map((value, index) => `${mapX(index)},${y(value)}`).join(" ")}/> : null}
      {markersConfig.map(({ key, label, cls }) => {
        const value = asNumber(markers[key]);
        if (value === null || value < low || value > high) return null;
        return <g key={key} className={`chart-marker ${cls}`}><line x1={plotLeft} x2={width - plotRight} y1={y(value)} y2={y(value)}/><text x={plotLeft + 5} y={y(value) - 4}>{label}</text></g>;
      })}
      {activeIndex !== null ? <line className="chart-crosshair" x1={mapX(activeIndex)} x2={mapX(activeIndex)} y1={plotTop} y2={height - plotBottom}/> : null}
      {timePoints.map(index => <text className="chart-time-label" key={`time-${index}`} x={mapX(index)} y={height - 7} textAnchor={index === 0 ? "start" : index === values.length - 1 ? "end" : "middle"}>{formatTimestamp(values[index]?.ts).replace(/:\d{2}$/, "")}</text>)}
    </svg>
    <div className="chart-legend"><span><i className="legend-up"/>Up candle</span><span><i className="legend-down"/>Down candle</span>{ema20On ? <span><i className="legend-ema20"/>EMA20</span> : null}{ema50On ? <span><i className="legend-ema50"/>EMA50</span> : null}</div>
  </div>;
}

export function latestCandles(value: unknown): Candle[] {
  return asRows(value) as Candle[];
}
