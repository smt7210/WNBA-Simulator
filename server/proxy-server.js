/**
 * WNBA Simulator Data Proxy
 * -------------------------
 * A small Node/Express server whose one job is capturing daily snapshots
 * of SportsData.io's WNBA team season stats, player season stats, and
 * injury feed to disk, dated by calendar day.
 *
 * WHY THIS EXISTS
 * Unlike the MLB build this was adapted from - where a proxy was required
 * because FanGraphs/Savant have no CORS-enabled public API - SportsData.io
 * IS callable directly from the browser (sportsdata-client.js does this),
 * so this server is NOT required for the app to run day-to-day. It exists
 * purely to make TRUE point-in-time backtesting possible going forward: as
 * long as this server keeps running, it takes one snapshot per calendar
 * day of "what the stats actually looked like" on that date, so a backtest
 * run next month can grade a game using the stats as they stood on the
 * date it was played instead of always using today's full-season numbers
 * (see backtest.js and the README for the accuracy implications of
 * dates *before* this feature existed, which can't be backfilled).
 *
 * It also optionally hides your SportsData.io API key server-side if you
 * choose to route sportsdata-client.js calls through it instead of calling
 * SportsData.io directly from the browser - see the README for that
 * tradeoff.
 *
 * RUN
 *   cd server
 *   npm install
 *   SPORTSDATA_API_KEY=your_key npm start
 * Then optionally set WNBA_PROXY_BASE_URL in the client's index.html
 * (default http://localhost:8788) if you want the client to route
 * snapshot-lookup calls through this server (it does, for the backtest
 * panel's point-in-time checks).
 */

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs/promises");
const path = require("path");

const PORT = process.env.PORT || 8788;
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.join(__dirname, "snapshots");
const SNAPSHOT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // check hourly whether today's snapshot exists yet
const SPORTSDATA_API_KEY = process.env.SPORTSDATA_API_KEY || "";
const SPORTSDATA_BASE = "https://api.sportsdata.io/v3/wnba";

const app = express();
app.use(cors());
app.use(express.json());

async function fetchSportsDataServer(pathSuffix) {
  if (!SPORTSDATA_API_KEY) throw new Error("SPORTSDATA_API_KEY is not set on the proxy server");
  const separator = pathSuffix.includes("?") ? "&" : "?";
  const url = `${SPORTSDATA_BASE}${pathSuffix}${separator}key=${SPORTSDATA_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SportsData.io ${pathSuffix} returned ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------
// Daily stat snapshots
// ---------------------------------------------------------------------

function currentSeasonForDate(dateStr) {
  return Number(dateStr.slice(0, 4));
}

async function captureSnapshot(dateStr) {
  const season = currentSeasonForDate(dateStr);

  const fetches = {
    teamSeasonStats: `/scores/json/TeamSeasonStats/${season}`,
    injuries: `/scores/json/Injuries`,
    standings: `/scores/json/Standings/${season}`
  };

  const entries = await Promise.all(
    Object.entries(fetches).map(async ([key, pathSuffix]) => {
      try {
        const data = await fetchSportsDataServer(pathSuffix);
        return [key, data];
      } catch (error) {
        console.warn(`[snapshot] ${key} failed for ${dateStr}:`, error.message);
        return [key, null];
      }
    })
  );

  const snapshot = {
    date: dateStr,
    season,
    capturedAt: new Date().toISOString(),
    ...Object.fromEntries(entries)
  };

  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fs.writeFile(path.join(SNAPSHOT_DIR, `${dateStr}.json`), JSON.stringify(snapshot));
  console.log(`[snapshot] captured ${dateStr}`);
  return snapshot;
}

async function snapshotExists(dateStr) {
  try {
    await fs.access(path.join(SNAPSHOT_DIR, `${dateStr}.json`));
    return true;
  } catch {
    return false;
  }
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureTodaysSnapshot() {
  const dateStr = todayDateStr();
  if (await snapshotExists(dateStr)) return;
  try {
    await captureSnapshot(dateStr);
  } catch (error) {
    console.warn(`[snapshot] failed to capture ${dateStr}:`, error.message);
  }
}

app.get("/api/snapshots", async (req, res) => {
  try {
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
    const files = await fs.readdir(SNAPSHOT_DIR);
    const dates = files.filter(f => f.endsWith(".json")).map(f => f.replace(".json", "")).sort();
    res.json({ ok: true, dates });
  } catch (error) {
    res.status(200).json({ ok: false, reason: error.message, dates: [] });
  }
});

app.get("/api/snapshots/:date", async (req, res) => {
  const { date } = req.params;
  try {
    const raw = await fs.readFile(path.join(SNAPSHOT_DIR, `${date}.json`), "utf8");
    res.json({ ok: true, snapshot: JSON.parse(raw) });
  } catch (error) {
    res.status(200).json({ ok: false, reason: `No snapshot stored for ${date}`, snapshot: null });
  }
});

// Manual trigger, e.g. to backfill "today" without waiting for the hourly
// scheduler, or to force-refresh a snapshot. Cannot retroactively create a
// true point-in-time snapshot for a date before this feature was deployed -
// it always captures *current* live data under the given date.
app.post("/api/snapshots/:date/capture", async (req, res) => {
  try {
    const snapshot = await captureSnapshot(req.params.date);
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(200).json({ ok: false, reason: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(SPORTSDATA_API_KEY), uptimeSeconds: Math.round(process.uptime()) });
});

app.listen(PORT, () => {
  console.log(`WNBA simulator data proxy listening on http://localhost:${PORT}`);
  if (!SPORTSDATA_API_KEY) {
    console.warn("[startup] SPORTSDATA_API_KEY is not set - snapshot capture will fail until it is.");
  }
  ensureTodaysSnapshot();
  setInterval(ensureTodaysSnapshot, SNAPSHOT_CHECK_INTERVAL_MS);
});
