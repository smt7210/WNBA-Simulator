/**
 * sportsdata-client.js
 * Client for SportsData.io's WNBA v3 API (https://sportsdata.io/wnba-api).
 * This is the single primary data source for the app: schedule/scores,
 * team season stats (standard box-score categories), player season stats,
 * injuries, standings, and betting odds (game lines: spread, moneyline,
 * total). Unlike the MLB build this is ported from, there is no separate
 * FanGraphs/Savant-equivalent advanced-stats site to blend in - instead,
 * rating-model.js computes possession-based Offensive/Defensive Rating and
 * the "Four Factors" itself from the raw box-score components returned
 * here (FGA, FGM, 3PA, 3PM, FTA, FTM, OREB, DREB, TOV, AST, STL, BLK).
 *
 * NOTE ON ENDPOINT PATHS: these follow SportsData.io's standard v3
 * basketball URL conventions (shared with their NBA API). Exact route
 * availability can depend on your subscription tier - if a call starts
 * returning 401/403, check your plan's enabled feeds in the SportsData.io
 * dashboard before assuming the code is wrong.
 *
 * NOTE ON FIELD NAMES: SportsData.io's exact JSON key casing can vary
 * slightly by endpoint version. Every extractor below tries several
 * plausible key names and falls back to "unavailable" rather than
 * guessing.
 */

const sportsDataStatus = {
  games: { available: false, reason: "Not yet loaded" },
  teamSeasonStats: { available: false, reason: "Not yet loaded" },
  injuries: { available: false, reason: "Not yet loaded" },
  standings: { available: false, reason: "Not yet loaded" },
  odds: { available: false, reason: "Not yet loaded" }
};

async function fetchSportsData(path) {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${SPORTSDATA_BASE}${path}${separator}key=${SPORTSDATA_API_KEY}`;
  const response = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": SPORTSDATA_API_KEY } });
  if (!response.ok) {
    throw new Error(`SportsData.io ${path} returned ${response.status}`);
  }
  return response.json();
}

function sdField(row, candidates, fallback = NaN) {
  for (const key of candidates) {
    if (row && row[key] !== undefined && row[key] !== null) {
      const value = typeof row[key] === "string" ? parseFloat(row[key]) : row[key];
      if (Number.isFinite(value)) return value;
    }
  }
  return fallback;
}

function currentWnbaSeason(date = new Date()) {
  // WNBA season runs May-October within a single calendar year, unlike
  // MLB's Oct-Mar-spanning offseason quirks, so the season label is just
  // the calendar year.
  return date.getFullYear();
}

/**
 * Games (schedule + scores + embedded odds) for a date. Returns an array,
 * not keyed by abbreviation, since app.js matches rows to games via its
 * teamNamesMatch() alias matcher against rawAwayTeam/rawHomeTeam.
 */
async function fetchSportsDataGames(date) {
  try {
    const dateStr = formatApiDate(date); // YYYY-MM-DD, shared helper from app.js
    const rows = await fetchSportsData(`/scores/json/GamesByDate/${dateStr}`);
    const games = (rows || []).map(row => ({
      gameId: row.GameID ?? row.GameId ?? null,
      status: row.Status ?? null,
      rawAwayTeam: row.AwayTeam ?? row.AwayTeamName ?? "",
      rawHomeTeam: row.HomeTeam ?? row.HomeTeamName ?? "",
      dateTime: row.DateTime ?? row.Day ?? null,
      finalAwayScore: sdField(row, ["AwayTeamScore"]),
      finalHomeScore: sdField(row, ["HomeTeamScore"]),
      odds: {
        awayMoneyline: sdField(row, ["AwayTeamMoneyLine"]),
        homeMoneyline: sdField(row, ["HomeTeamMoneyLine"]),
        overUnder: sdField(row, ["OverUnder", "PointSpreadOverUnder"]),
        pointSpread: sdField(row, ["PointSpread"])
      }
    }));
    sportsDataStatus.games = { available: true, reason: null };
    return games;
  } catch (err) {
    sportsDataStatus.games = { available: false, reason: err.message };
    return [];
  }
}

/**
 * Team-level season stats (standard box-score aggregates). Everything the
 * rating model needs (Four Factors, possession-based ORtg/DRtg, bench
 * production, rebounding/turnover rates) is derivable from these raw
 * counting stats plus games played.
 */
async function fetchTeamSeasonStats(season) {
  try {
    const rows = await fetchSportsData(`/scores/json/TeamSeasonStats/${season}`);
    sportsDataStatus.teamSeasonStats = { available: true, reason: null };
    return rows || [];
  } catch (err) {
    sportsDataStatus.teamSeasonStats = { available: false, reason: err.message };
    return [];
  }
}

/** Team stats over the trailing window used for the "recent form" blend. */
async function fetchTeamSeasonStatsLastGames(season, numberOfGames = 10) {
  try {
    const rows = await fetchSportsData(`/scores/json/TeamSeasonStats/${season}?numberofgames=${numberOfGames}`);
    return rows || [];
  } catch {
    // Not every plan exposes a trailing-window variant; caller falls back
    // to computing recent form from box scores instead.
    return null;
  }
}

/** Player season stats for a team - used for bench production and the
 * minutes-concentration ("how top-heavy is the rotation") component. */
async function fetchPlayerSeasonStatsByTeam(season, teamAbbr) {
  try {
    const rows = await fetchSportsData(`/stats/json/PlayerSeasonStatsByTeam/${season}/${teamAbbr}`);
    return rows || [];
  } catch {
    return [];
  }
}

/** All active injuries league-wide. */
async function fetchInjuries() {
  try {
    const rows = await fetchSportsData(`/scores/json/Injuries`);
    sportsDataStatus.injuries = { available: true, reason: null };
    return rows || [];
  } catch (err) {
    sportsDataStatus.injuries = { available: false, reason: err.message };
    return [];
  }
}

async function fetchStandings(season) {
  try {
    const rows = await fetchSportsData(`/scores/json/Standings/${season}`);
    sportsDataStatus.standings = { available: true, reason: null };
    return rows || [];
  } catch (err) {
    sportsDataStatus.standings = { available: false, reason: err.message };
    return [];
  }
}

/**
 * Betting odds (game lines) for a date - spread, moneyline, total, across
 * available sportsbooks. Falls back to the odds already embedded in
 * GamesByDate if this endpoint isn't available on your plan.
 */
async function fetchBettingOddsByDate(date) {
  try {
    const dateStr = formatApiDate(date);
    const rows = await fetchSportsData(`/odds/json/BettingGameOddsByDate/${dateStr}`);
    sportsDataStatus.odds = { available: true, reason: null };
    return rows || [];
  } catch (err) {
    sportsDataStatus.odds = { available: false, reason: err.message };
    return [];
  }
}

/**
 * Historical box scores for a date range - the data source a backtest
 * pulls from. WNBA seasons are short (~40 games/team over ~4-5 months) so
 * even a full-season range is a modest number of calls.
 */
async function fetchBoxScoresByDateRange(startDate, endDate) {
  const games = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    try {
      const dateStr = formatApiDate(cursor);
      const rows = await fetchSportsData(`/stats/json/BoxScoresByDate/${dateStr}`);
      (rows || []).forEach(row => {
        const game = row.Game || row;
        if (game && (game.Status === "Final" || game.IsClosed)) {
          games.push(row);
        }
      });
    } catch {
      // Skip dates with no data / outside plan coverage rather than aborting the whole range.
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return games;
}

/** Historical closing odds for a date, used by the backtest ROI/EV math. */
async function fetchHistoricalOddsByDate(date) {
  try {
    return (await fetchSportsData(`/odds/json/BettingGameOddsByDate/${formatApiDate(date)}`)) || [];
  } catch {
    return [];
  }
}
