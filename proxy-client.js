/**
 * proxy-client.js
 * Talks to the local snapshot proxy (see /server) for point-in-time
 * backtesting support. The live app does NOT need this proxy for
 * day-to-day predictions - sportsdata-client.js calls SportsData.io
 * directly from the browser. This file is only exercised by the
 * backtest / weight-optimizer panels.
 */

async function fetchProxyJson(path) {
  const response = await fetch(`${PROXY_BASE_URL}${path}`);
  if (!response.ok) {
    throw new Error(`Proxy ${path} returned ${response.status}`);
  }
  return response.json();
}

/** List of dates (YYYY-MM-DD) the proxy has a captured snapshot for. */
async function fetchSnapshotDates() {
  try {
    const payload = await fetchProxyJson("/api/snapshots");
    return payload.ok ? payload.dates : [];
  } catch {
    return [];
  }
}

/**
 * Loads a single day's captured snapshot (team season stats, injuries,
 * standings) as they stood on that date.
 */
async function fetchSnapshotData(dateStr) {
  try {
    const payload = await fetchProxyJson(`/api/snapshots/${dateStr}`);
    if (!payload.ok || !payload.snapshot) return null;
    return payload.snapshot;
  } catch (error) {
    console.warn(`Snapshot fetch failed for ${dateStr}`, error.message);
    return null;
  }
}
