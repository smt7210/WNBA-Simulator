# WNBA Monte Carlo Simulator

A mobile-first browser app that loads a WNBA schedule by date, builds a composite **Team Rating Model** from possession-based basketball analytics, adjusts for injuries/rest/market odds, and runs a 25,000-trial Monte Carlo simulation per game. Ported from an MLB build with the same overall shape (weighted category rating model → Monte Carlo engine → betting value math → backtest → weight optimizer), rebuilt for basketball where the two sports' data realities differ.

## How this differs from the MLB app it's based on

- **One data source, not two.** The MLB app blended SportsData.io with a scraped FanGraphs/Savant proxy for sabermetrics. There's no FanGraphs-equivalent third-party advanced-stats site for the WNBA, so this build gets everything from SportsData.io's WNBA API and **computes the advanced numbers itself**, client-side, from raw box-score components (see "The math" below). One upside: this also means the proxy server (`server/proxy-server.js`) doesn't need to scrape anything undocumented — it only exists to capture daily snapshots for point-in-time backtesting, and even that's optional for day-to-day use.
- **Seven weighted categories, chosen for basketball**, not a literal renaming of the MLB app's seven: Offensive Rating (32%), Defensive Rating (28%), Bench Depth & Star Availability (15%), Rebounding & Ball Control (8%), Rest & Travel (7%), Recent Form (5%), Home Court Advantage (5%). No weather category (indoor league). See `config.js` for the full rationale in comments.
- **Weight application is different and more consistent than the MLB app's.** The MLB app applied its top-level category weights inconsistently (some categories' weights barely affected the final multiplier). This build scales every category's raw deviation-from-neutral by `weight × 7`, so a category weighted at the 1/7 average swings the result exactly as much as its raw signal suggests, and above/below-average weights swing proportionally more/less. Documented in `rating-model.js`.
- **Normal-distribution scoring instead of Poisson.** Baseball's low-scoring, discrete-event nature fits a Poisson process well. Basketball scores cluster tightly around a mean and are better modeled as Normal-distributed (`simulation.js`), with simulated overtime periods resolving ties instead of extra innings.
- **League averages are computed dynamically each season**, not hard-coded constants, since `rating-model.js` derives every anchor stat from that season's actual league-wide `TeamSeasonStats` rows.

## The math

Everything advanced here — possession-based Offensive/Defensive Rating (points per 100 possessions), the Four Factors (eFG%, FT rate, 3PT rate, TOV%, AST%), and per-100-possession steal/block rates — is computed from raw box-score counting stats using the standard Dean Oliver / Basketball-Reference possession estimate:

```
Possessions ≈ FGA − OREB + TOV + 0.44 × FTA
```

**Known simplification, flagged honestly in the code and UI:** true offensive/defensive rebound *rate* (OREB%/DREB%) needs the opponent's available rebounds (their misses), which SportsData.io's team-season totals don't expose per-matchup. The Rebounding & Ball Control category uses raw per-game rebound counts vs. league average instead — informative, but not a true rate stat. Every sub-metric that can't be sourced falls back to neutral (shows "N/A") rather than guessing.

## Data source: SportsData.io WNBA API

Single source for schedule/scores, team & player season stats, standings, injuries, and betting odds. Get a key at [sportsdata.io](https://sportsdata.io) (WNBA API) and replace the placeholder in `config.js` (`SPORTSDATA_API_KEY`).

**Endpoint paths are unverified against a live account.** They follow SportsData.io's standard v3 basketball URL conventions (shared with their NBA API), but exact route availability depends on your subscription tier. If a call starts returning 401/403/empty, check your plan's enabled feeds in the SportsData.io dashboard before assuming the code is wrong — this is the same caution the original MLB README gave about its FanGraphs/Savant routes, just for a documented commercial API instead of scraped endpoints.

**Field-name defensiveness:** every stat extractor tries several plausible JSON key names and returns "unavailable" rather than silently guessing, since exact key casing can vary slightly by endpoint version.

## Files

| File | Purpose |
|---|---|
| `config.js` | Configurable category weights and sub-weights (not hard-coded — editable in the UI, persisted to `localStorage`, read at run time), plus the SportsData.io key/base URL. |
| `sportsdata-client.js` | All SportsData.io WNBA API calls: schedule/scores, team/player season stats, standings, injuries, betting odds, historical box scores + odds for backtesting. |
| `rating-model.js` | Computes the Four Factors/possession-based ratings from raw stats, dynamic league averages, and the full seven-category Team Rating Model. |
| `simulation.js` | The 25,000-trial Monte Carlo engine (Normal-distribution scoring, simulated OT for ties), spread/total probability, most-common-scores, and betting-value math (edge %, EV, recommended bet, 1–10 confidence, color coding). |
| `backtest.js` | Runs the model against historical SportsData.io results; point-in-time-aware via the snapshot proxy; reports Win %, Brier Score, Log Loss, ROI, calibration by decile. |
| `weight-optimizer.js` | Local random-search hill-climber over weight profiles, scored with a fast analytic (Normal-CDF closed-form) win probability during search and validated with the full Monte Carlo engine on a chronological holdout split. |
| `proxy-client.js` | Client for the snapshot endpoints below (only used by the backtest/optimizer panels). |
| `server/proxy-server.js` | Optional Node/Express server that captures a daily snapshot of team/player/injury data to `server/snapshots/{date}.json`, enabling true point-in-time backtesting **going forward** from whenever you first run it. Not required for live predictions. |
| `app.js` | Orchestration: schedule loading, hydrating every game with team/player/injury/rest/odds data, running the model, and all UI rendering. |
| `index.html`, `styles.css`, `manifest.webmanifest`, `service-worker.js`, `icon.svg` | UI shell, PWA install support, offline app-shell caching. |

## Backtesting

Pick a start/end date (max 60 days per run) in the "Backtest" panel and click "Run backtest." It pulls completed games + odds from SportsData.io for the range, runs the model against each one at a reduced 3,000 trials/game (vs. the live 25,000, for speed across many games), and reports Win %, Brier Score, Log Loss, ROI, Net Profit, Bets Placed, and calibration by decile.

**Read this before trusting the numbers:** any date without a captured snapshot (see below) falls back to **current-season stats** — a June game gets graded with September-quality full-season numbers, which makes the model look more accurate than a true point-in-time backtest would. Historical injuries and same-day rest/travel context also aren't reconstructable for past dates, so those inputs are neutral in backtest mode. Every result reports `pointInTimeCoverage` so you can see how much of a given run to trust at face value.

## Daily stat snapshots — enables true point-in-time backtesting going forward

`server/proxy-server.js` captures team season stats, injuries, and standings once per calendar day (checks hourly) to `server/snapshots/{date}.json`, for as long as it keeps running.

```
cd server
npm install
SPORTSDATA_API_KEY=your_key npm start
```

- `GET /api/snapshots` — list captured dates
- `GET /api/snapshots/:date` — fetch one
- `POST /api/snapshots/:date/capture` — manual trigger/backfill (captures *today's* live data under an arbitrary date label; cannot retroactively reconstruct what stats looked like on a past date before this feature existed)

This only starts covering dates from whenever you first deploy and run it. There's no way to get true point-in-time stats for games before that.

## Weight optimization

In the Backtest panel, pick a date range, a target (Lowest Log Loss / Lowest Brier / Maximum ROI / Highest Accuracy), an iteration count (20–500), and click "Optimize weights." This is local random search (a lightweight hill-climber), not an exhaustive search — it is not guaranteed to find a global optimum, and rerunning can land on a different profile. The most recent 30% of the date range (by date) is held out and never touched during search, so the reported improvement reflects generalization rather than overfitting to the exact range you picked. An "Apply optimized weights as default" button persists the winner the same way the manual weights panel does.

## Betting value

For any game with moneylines (auto-populated from SportsData.io odds where available, or entered manually per game), each team gets an edge %, expected value per $100, a recommended Bet/Pass, and a 1–10 confidence score blending edge size with how much underlying data was actually available for that matchup (`dataCompleteness`). Spread and total lines default to SportsData.io's posted numbers when available, falling back to the model's own expected margin/total otherwise.

## Setup

1. Get a SportsData.io WNBA API key and set `SPORTSDATA_API_KEY` in `config.js`.
2. Serve the root folder with any static file server (the app calls SportsData.io directly from the browser — no build step). E.g. `npx serve .` or open `index.html` via a local server (not `file://`, since `fetch` and the service worker need an http origin).
3. (Optional) Run `server/proxy-server.js` if you want point-in-time backtesting going forward: `cd server && npm install && SPORTSDATA_API_KEY=your_key npm start`. Confirm `window.WNBA_PROXY_BASE_URL` in `index.html` matches where it's running (defaults to `http://localhost:8788`).

## Known limitations / deferred scope

- No true point-in-time rebound-rate, since opponent-available-rebounds data isn't exposed per matchup by the source used (see "The math" above).
- Bench Net Rating (a planned Bench Depth sub-metric) isn't populated — SportsData.io's player season stats don't expose an on/off net-rating split, so it's flagged N/A rather than approximated.
- Rest & Travel currently models days-rest and back-to-backs only; it does not account for travel distance/time-zone changes between cities, which real point-spread models often include.
- The weight optimizer is a single "current best profile" workflow (like the MLB app's), not a multi-profile save/switch system, and there's no scheduled auto-re-optimization.
- Endpoint paths against SportsData.io's WNBA API are based on their documented v3 URL conventions but haven't been verified against a live paid account — see the caution above.
