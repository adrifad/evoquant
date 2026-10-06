# EvoQuant Console Workstation Implementation Plan

> **For agentic workers:** Inline implementation is requested. Steps use checkbox syntax for tracking.

**Goal:** Refactor the React console into a responsive quantitative trading workstation while preserving every existing API contract and all backend/trading behavior.

**Architecture:** Keep the existing Vite + React app and fetch endpoints. Move shared API state, formatters, shell controls, chart, and domain pages into small files under `apps/console/src`; do not change `src/core/dashboard.ts` or trading modules. Render only values backed by current API responses, and show descriptive empty/loading/error states for unavailable evidence.

**Tech Stack:** React 19, TypeScript, Vite, existing lucide-react icons, CSS variables, semantic HTML; no new dependency.

---

## Design Read

Reading this as an OKX Demo operations and research workstation for the bot operator, in a restrained flat quant-desk visual language, with ENERGY 2 / RHYTHM 2 / MOTION 1.

- Core palette: Carbon Slate `#121a22`, Panel Slate `#19232d`, Raised Slate `#202d38`, Cyan `#61b8d4`, with semantic green `#48b887`, red `#df706d`, and amber `#d6a34f` over neutral text.
- Typography: system UI sans for labels and explanation to avoid remote font loading; system monospace only for prices, IDs, timestamps, and technical values so columns scan cleanly.
- Layout: persistent 224px desktop rail; compact sticky execution tape; risk state before KPI and position; dashboard chart/position split; dense semantic tables; mobile collapses to one column and a 44px navigation/control surface.
- Purpose: flat borders separate operational regions without floating-card effects; cyan is reserved for navigation/focus/instrument context; green/red/amber communicate actual outcomes and risk states; restrained radius distinguishes controls from data surfaces.
- No logo artwork or fabricated market data will be created. The wordmark remains text; navigation icons are selected for their named product domains.
- Major decisions: DEMO remains pinned in the execution tape because simulation/live ambiguity is a safety hazard; position and risk precede AI narrative because operators need exposure before explanation; monospace is restricted to high-precision values because long text is more readable in sans; hover-only motion is used because this is an operational workstation.

## File Map

- Create `apps/console/src/lib/types.ts`, `format.ts`, and `hooks/useApi.ts` for API shape helpers, safe formatting, polling, and one shared WebSocket refresh listener.
- Create `apps/console/src/components/` for shell/navigation, status badges, metrics/panels/tables/empty states, chart, position, and decision/risk presentation.
- Create `apps/console/src/pages/` for Dashboard, Markets, Trades/detail, Strategies, Evolution, Memory, Risk, Logs, and Settings.
- Replace `apps/console/src/main.tsx` with the app composition and `apps/console/src/styles.css` with scoped design tokens, components, accessibility, and responsive rules.
- Preserve `/api/status`, `/api/candles`, `/api/market`, `/api/trades`, `/api/trades/:id`, `/api/reviews`, `/api/strategies`, `/api/evolution`, `/api/lessons`, `/api/events`, `/api/settings`, `/api/pause`, `/api/resume`, and `/api/emergency-stop` without server edits.

## Tasks

### Task 1: Shared data and application shell

- [x] Define defensive JSON types/parsers and format functions; keep missing data explicitly unavailable and never coerce it into a statistic.
- [x] Centralize API polling and attach one reconnecting WebSocket listener to signal refreshes, retaining a slow polling fallback.
- [x] Build the persistent sidebar and sticky execution tape with real route state, exchange/DEMO/connection/timeframe/bot status, pause/resume, and confirmed emergency stop.
- [x] Add semantic panel, metric, badge, table, confidence, and empty/loading/error components.

### Task 2: Dashboard and market monitoring

- [x] Build responsive Dashboard order: risk banner, account KPIs, position, market chart, decision vs deterministic risk verdict, current limits, and recent data.
- [x] Build chart with existing confirmed candles, toggled EMA overlays, axis labels/crosshair, and only persisted open/trade markers.
- [x] Build Markets feature groups, current regime, current signal weights, and watchlist scanner; explicitly disclose when raw per-signal scores are not in the API.

### Task 3: Research and audit pages

- [x] Build searchable/filterable Trades ledger and an accessible closable detail dialog with replay, decision snapshot, orders/fills, risk, parsed review, and lesson candidates.
- [x] Build strategy version cards/details with only derivable regime evidence.
- [x] Build Champion/Challenger Evolution comparison and timeline from existing comparisons/events; parse JSON safely and avoid unsupported metrics.
- [x] Build Lessons, Regimes, Signals, and Confidence tabs as structured tables/matrices/charts with sample confidence.

### Task 4: Risk, logs, and settings

- [x] Build serious risk summary, hard limits, and separate filtered risk timeline from `/api/status` and `/api/events`.
- [x] Build searchable operational logs with ALL/RISK/TRADE/ERROR/PROMOTION/AI/EXCHANGE filters and functional JSON export.
- [x] Build Exchange, Trading, Risk, AI Provider, Learning/Evolution, and Appearance settings sections; keep hard controls read-only, and retain only the existing AI provider POST fields/API-key behavior.

### Task 5: Verification and design gate

- [x] Run console typecheck/build and root typecheck/tests.
- [ ] Run the app, inspect desktop/tablet/mobile renders, test loading/error/empty states and keyboard paths, then click through every navigation/control/tab/filter/export/detail dialog. (Desktop, tablet, and mobile shell/error states rendered; full interaction/data-state validation remains limited because the local API returned HTTP 401 and browser automation engines are unavailable.)
- [ ] Check no horizontal overflow, no unbacked data/statistics, DEMO visibility, all API endpoints unchanged, and no backend/trading files modified.
- [ ] Run the antislop Delivery Gate and record any API-limited displays honestly.

## Known API Limits

- `/api/market` includes features, regime, weights, and scanner scores, but not normalized score per signal or weighted contribution.
- `/api/status` includes equity, daily loss percentage, drawdown, closed count, total PnL, expectancy, open positions, limits, latest decision, regime, and market features; it does not provide available equity, risk exposure in quote currency, win rate, leverage/margin metadata per position, or next evaluation time.
- Regime stats expose trades, wins/losses, win rate, expectancy, and a currently unpopulated profit factor field; do not show that profit factor as meaningful evidence.
- Champion comparison metrics and lessons expose only fields returned by existing storage/API; do not synthesize max drawdown, evidence linkage, previous weight history, or MFE/MAE.

## Self-Review

- Coverage: dashboard, markets, trades/detail/review, strategies, evolution, memory, risk, logs, settings, safety shell, responsive layout, and loading/empty/error states are each assigned above.
- API compatibility: all data comes from existing endpoints; controls use existing POST endpoints only; no backend source is in the file map.
- Safety: DEMO stays pinned; risk controls remain separate from AI controls; emergency stop remains explicit and confirmed; credentials remain masked and are sent only through the existing settings POST.
