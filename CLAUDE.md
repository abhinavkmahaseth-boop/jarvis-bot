# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

JARVIS is an SMC (Smart Money Concepts) crypto trading bot for Delta Exchange India perps (BTC/ETH/SOL). It has no build step, no package manager, and no test framework dependency — everything is plain Node.js (`fetch` built-in, Node 20) and a single static `index.html` dashboard. There is nothing to `npm install`.

It runs three independent things off the **same shared engine**:
1. A scheduled Telegram/Discord **report** (`report.js` via `report.yml`).
2. A 5-minute **paper-trading loop** with two parallel books, one of which can place **real live orders** on Delta (`paper-trade.js` via `paper.yml`).
3. A static **dashboard** (`index.html`) that reads state from a separate git branch and renders charts/controls — this is what gets served (e.g. GitHub Pages), not a Node server.

## Commands

There is no `package.json`. Run scripts directly with Node:

```bash
node .github/scripts/unit-test.js     # offline unit tests (TP ladder, applyBar exit FSM, sizing, single-position invariant)
node .github/scripts/smoke-test.js    # loads every module + hits the live Delta API (read-only) to prove no ReferenceErrors
node .github/scripts/report.js        # send a real Telegram/Discord report (needs TG_TOKEN/TG_CHAT_ID or DISCORD_WEBHOOK env vars)
node .github/scripts/paper-trade.js monitor   # one scan/manage cycle of the paper books
node .github/scripts/paper-trade.js review    # post the weekly performance review
node .github/scripts/backtest.js 60           # walk-forward backtest over 60 days, writes backtest.json
node audit-trades.js                  # verify recorded paper trades against real Delta candle data
node heal-state.js [--apply]          # reconcile state.json/state-algo.json against real settled data (dry-run unless --apply)
```

CI (`.github/workflows/smoke.yml`) runs `unit-test.js` then `smoke-test.js` on every push/PR to `main` — this is the only required check. There's no linter configured.

To run a single unit test, there's no test-name filtering — `unit-test.js` and `smoke-test.js` are short, linear scripts; comment out/isolate the block you care about, or just read the console output (each assertion prints `✓`/`✗` with a label).

## Architecture

**Shared core modules** (root-level, used by everything — browser via `<script>` UMD, Node via `require`). Edit these once; never fork them:
- `engine.js` — **single source of truth** for the SMC strategy: candle fetch from Delta's public API, market structure/pivots, bias, FVG detection + grading (A/B/C), liquidity levels, SL calculation, the 3-rung TP ladder (`orderTPs`), and `computeAlgo(sym, opts)` which ties fetch→analyze together. Pure logic — no DOM, no localStorage, no env reads; all config is passed in via `opts`.
- `claude.js` — the **only** place the Claude verification prompt is built and verdicts are parsed (`buildVerifyPrompt`, `parseVerdict`, `verifyTrade`). Calls `api.anthropic.com` directly with `claude-haiku-4-5-20251001`. No API key → `verifyTrade` returns `null` (fail closed, never silently approves).
- `notify.js` — fans a single Telegram-HTML-formatted message out to Discord (converted to Discord markdown) and/or Telegram. Add a channel here and every caller gets it for free.

**Per-environment code**:
- `.github/scripts/paper-trade.js` — the live engine. Maintains **two independent books** off one scan (`BOOKS.claude` and `BOOKS.algo`):
  - `claude` book: Claude-gated, grades A+B, paper-only, full Telegram pings.
  - `algo` book: no Claude gate, Grade-A only, and is the one that can go **live** on Delta (`.github/scripts/delta.js`) — gated by two independent switches: trade API keys present as secrets, AND `live-config.json`'s `armed: true` (set by the dashboard). Either being false means zero real orders.
  - Trade lifecycle state machine: `applyBar` (TP1-then-trail: book 50% at TP1 → SL to breakeven → trail to TP1 on TP2 → close runner at TP3). `replayTrade` re-derives a trade's entire life from its entry on fresh candle data on every run — nothing is incrementally mutated and persisted as truth, so a bad tick from a prior run can never get baked in permanently.
  - `SETTLE_BARS = 1`: the most-recently-closed candle is always dropped before fills/exits are evaluated, so a transient bad print has one bar to self-correct before it's acted on.
  - One-position-per-symbol invariant enforced by `enforceSinglePosition`/`symOpen`/`symActive`.
- `.github/scripts/backtest.js` — walk-forward replay (Grade-A, no Claude) reusing `engine.analyze` and `paper-trade.applyBar` so backtest behavior is identical to live, with no look-ahead (decisions only see bars closed by that point).
- `.github/scripts/report.js` — scheduled multi-symbol report; reuses `engine.computeAlgo` + `claude.verifyTrade`.
- `.github/scripts/delta.js` — signed Delta India REST client (HMAC). Server-side only (needs the secret). Hard-caps order size at `MAX_LOTS = 100` contracts regardless of any config input — this ceiling cannot be bypassed by changing `live-config.json`.
- `audit-trades.js` / `heal-state.js` — out-of-band correctness tools: independently re-derive recorded trades from real Delta history to catch any divergence between stored state and what the market actually did.
- `index.html` — single-file dashboard (no bundler). Reads `state.json`, `state-algo.json`, `backtest.json`, `live-config.json` as raw files from the `paper-data` branch (via `raw.githubusercontent.com` / GitHub Contents API), and writes `live-config.json` back via the GitHub API to arm/disarm live trading and set lot size.

**State storage**: `state.json`, `state-algo.json`, `backtest.json`, and `live-config.json` live on an **orphan branch called `paper-data`**, not on `main`. Workflows clone/checkout that branch to read/write state and push back with retry-on-conflict (rebase) since `paper.yml` and `backtest.yml` can write it concurrently. Never commit these files to `main`.

**GitHub Actions are the only runtime** — there is no long-running server. `paper.yml` is triggered both by an external cron-job.org webhook (`repository_dispatch`, primary — GitHub's native `schedule` trigger is throttled/unreliable) and by `schedule` as backup.

## Key conventions

- Money/sizing is always in **whole Delta contracts**, not raw asset units — use `ENGINE.contractQty`/`roundTick`/`contractSpec`, never compute position size or price ticks ad hoc.
- Every alert message is composed once as Telegram-HTML and pushed through `notify.js`, never sent to a specific channel API directly.
- When changing the strategy (FVG detection, grading, SL/TP, entry trigger), edit `engine.js` only — it's loaded identically by the browser, the cron, the paper-trader and the backtester, and the smoke test will catch a module that fails to load even if `node --check` wouldn't.
- Any change to the live-order path (`delta.js`, `livePlace`/`liveCancel`/`liveEnsureFlat` in `paper-trade.js`) is safety-critical: the dormant-by-default double-gate (keys + `armed`) and the `MAX_LOTS` hard cap must be preserved.
