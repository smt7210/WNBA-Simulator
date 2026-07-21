/**
 * backtest.js
 * Runs the Team Rating Model against historical completed WNBA games (via
 * SportsData.io's historical data) and scores it against what actually
 * happened.
 *
 * POINT-IN-TIME DATA: for any date the proxy server has captured a daily
 * snapshot (see server/proxy-server.js - it snapshots team/player/injury
 * data once a day going forward), that game is graded using the stats as
 * they actually stood on that date. For dates without a snapshot (anything
 * before this feature was deployed, or if the proxy wasn't running that
 * day), the game falls back to CURRENT-SEASON aggregate stats instead -
 * meaning a June game without a snapshot gets graded with September-quality
 * full-season numbers, which makes the model look more accurate than a
 * true point-in-time backtest would. The result reports
 * `pointInTimeCoverage` (the fraction of tested games that had a real
 * snapshot) so you can see how much of a given run to trust at face value.
 *
 * Also: historical injuries and same-day rest/travel context aren't
 * reconstructable for past dates here, so those two inputs are neutral
 * (1.0x) in backtest mode.
 */

const BACKTEST_TRIALS = 3000; // fewer trials than the live 25,000, for speed across many games
const BACKTEST_MAX_DAYS = 60; // guardrail so a browser tab doesn't lock up on huge ranges

function pseudoTeam(rawAbbr) {
  return { id: null, name: rawAbbr, abbreviation: rawAbbr };
}

/**
 * Fetches historical box scores + odds for the range, resolving
 * point-in-time (or fallback) team stats per game date. Shared by
 * runBacktest() and weight-optimizer.js, so both work from the same
 * dataset.
 */
async function prepareBacktestDataset({ startDate, endDate, onProgress }) {
  const cappedEnd = clampBacktestRange(startDate, endDate);
  const season = startDate.getFullYear();

  if (!state.leagueAverages || state.leagueAveragesSeason !== season) {
    onProgress?.("Loading league season stats...");
    const teamRows = await fetchTeamSeasonStats(season);
    state.leagueAverages = buildLeagueAverages(teamRows);
    state.teamSeasonRowsBySeason = state.teamSeasonRowsBySeason || {};
    state.teamSeasonRowsBySeason[season] = teamRows;
    state.leagueAveragesSeason = season;
  }

  onProgress?.("Checking for point-in-time stat snapshots...");
  const snapshotDates = new Set(await fetchSnapshotDates());
  const snapshotCache = new Map();

  async function statsForDate(dateStr) {
    if (!snapshotDates.has(dateStr)) {
      return { teamRows: state.teamSeasonRowsBySeason[season], pointInTime: false };
    }
    if (snapshotCache.has(dateStr)) return { teamRows: snapshotCache.get(dateStr), pointInTime: true };
    const snapshot = await fetchSnapshotData(dateStr);
    if (!snapshot?.teamSeasonStats) {
      return { teamRows: state.teamSeasonRowsBySeason[season], pointInTime: false };
    }
    snapshotCache.set(dateStr, snapshot.teamSeasonStats);
    return { teamRows: snapshot.teamSeasonStats, pointInTime: true };
  }

  onProgress?.("Fetching historical box scores from SportsData.io...");
  const rawGames = await fetchBoxScoresByDateRange(startDate, cappedEnd);
  const games = [];

  for (const row of rawGames) {
    const g = row.Game || row;
    const awayAbbr = g.AwayTeam;
    const homeAbbr = g.HomeTeam;
    const awayScore = g.AwayTeamScore;
    const homeScore = g.HomeTeamScore;
    const dateStr = (g.DateTime || g.Day || "").slice(0, 10);
    if (!awayAbbr || !homeAbbr || !Number.isFinite(awayScore) || !Number.isFinite(homeScore) || !dateStr) continue;

    // The Odds API's historical odds endpoint needs a paid plan tier and
    // returns null on any failure (see odds-api-client.js), in which case
    // this falls back to SportsData.io's historical odds like before.
    const oddsApiRows = await fetchOddsApiHistoricalOdds(dateStr);
    const odds = oddsApiRows ?? await fetchHistoricalOddsByDate(new Date(dateStr));
    const matchOdds = (odds || []).find(o => (o.AwayTeam === awayAbbr && o.HomeTeam === homeAbbr) || (o.GameId === g.GameID));
    const awayMoneyline = matchOdds ? sdField(matchOdds, ["AwayTeamMoneyLine"]) : NaN;
    const homeMoneyline = matchOdds ? sdField(matchOdds, ["HomeTeamMoneyLine"]) : NaN;

    const { teamRows, pointInTime } = await statsForDate(dateStr);
    const awayRow = (teamRows || []).find(r => r.Team === awayAbbr || r.Key === awayAbbr);
    const homeRow = (teamRows || []).find(r => r.Team === homeAbbr || r.Key === homeAbbr);
    if (!awayRow || !homeRow) continue;

    games.push({
      date: dateStr,
      away: pseudoTeam(awayAbbr),
      home: pseudoTeam(homeAbbr),
      awayScore, homeScore,
      awayMoneyline, homeMoneyline,
      awayRow, homeRow,
      leagueAverages: buildLeagueAverages(teamRows),
      pointInTime
    });
  }

  return { games, cappedEnd, rawCount: rawGames.length };
}

/**
 * Scores a prepared dataset with a given weight profile using the full
 * Monte Carlo engine (or the fast analytic scorer when trials=0, used by
 * the weight optimizer).
 */
function scoreDataset(dataset, weights, { trials = BACKTEST_TRIALS, onProgress, sampleLimit = 25 } = {}) {
  const { games } = dataset;
  if (!games.length) return null;

  let correctPicks = 0;
  let brierSum = 0;
  let logLossSum = 0;
  let totalWagered = 0;
  let netProfit = 0;
  let edgeSum = 0;
  let betsPlaced = 0;
  let pointInTimeGames = 0;
  const calibrationBuckets = Array.from({ length: 10 }, () => ({ predictedSum: 0, actualWins: 0, count: 0 }));
  const sampleResults = [];

  games.forEach((game, i) => {
    onProgress?.(`Simulating ${i + 1} of ${games.length} (${game.date})...`);
    if (game.pointInTime) pointInTimeGames += 1;

    const neutralInjuries = [];
    const away = buildTeamRating({
      isHome: false, teamStats: game.awayRow, teamStatsLast10: null,
      playerStats: [], injuries: neutralInjuries, leagueAverages: game.leagueAverages,
      restInfo: {}, seasonWinPct: NaN, last10WinPct: NaN, weights
    });
    const home = buildTeamRating({
      isHome: true, teamStats: game.homeRow, teamStatsLast10: null,
      playerStats: [], injuries: neutralInjuries, leagueAverages: game.leagueAverages,
      restInfo: {}, seasonWinPct: NaN, last10WinPct: NaN, weights
    });

    const leagueAvgPoints = game.leagueAverages.pointsPerGame || 82;
    const awayExpected = expectedPointsV2({
      leagueAvgPoints, offenseMultiplier: away.offenseMultiplier, opponentDefenseMultiplier: home.defenseMultiplier,
      benchMultiplier: away.benchMultiplier, reboundingMultiplier: away.reboundingMultiplier,
      restTravelMultiplier: away.restTravelMultiplier, recentFormMultiplier: away.recentFormMultiplier,
      homeCourtFactor: away.homeCourtFactor, injuryFactor: 1
    });
    const homeExpected = expectedPointsV2({
      leagueAvgPoints, offenseMultiplier: home.offenseMultiplier, opponentDefenseMultiplier: away.defenseMultiplier,
      benchMultiplier: home.benchMultiplier, reboundingMultiplier: home.reboundingMultiplier,
      restTravelMultiplier: home.restTravelMultiplier, recentFormMultiplier: home.recentFormMultiplier,
      homeCourtFactor: home.homeCourtFactor, injuryFactor: 1
    });

    const homeWinProbability = trials > 0
      ? runMonteCarloV2(awayExpected, homeExpected, undefined, undefined, trials).homeWinProbability
      : analyticHomeWinProbability(awayExpected, homeExpected);
    const awayWinProbability = 1 - homeWinProbability;

    const homeWon = game.homeScore > game.awayScore;
    const modelPickedHome = homeWinProbability >= 0.5;
    if (modelPickedHome === homeWon) correctPicks += 1;

    const p = clamp(homeWinProbability, 0.001, 0.999);
    brierSum += (p - (homeWon ? 1 : 0)) ** 2;
    logLossSum += homeWon ? -Math.log(p) : -Math.log(1 - p);

    const bucket = calibrationBuckets[Math.min(9, Math.floor(p * 10))];
    bucket.predictedSum += p;
    bucket.actualWins += homeWon ? 1 : 0;
    bucket.count += 1;

    if (Number.isFinite(game.homeMoneyline) && Number.isFinite(game.awayMoneyline)) {
      const homeValue = computeBettingValue({ modelProbability: homeWinProbability, americanOdds: game.homeMoneyline });
      const awayValue = computeBettingValue({ modelProbability: awayWinProbability, americanOdds: game.awayMoneyline });
      const bestBet = [homeValue, awayValue].filter(Boolean).sort((a, b) => b.expectedValuePer100 - a.expectedValuePer100)[0];
      if (bestBet && bestBet.expectedValuePer100 > 0) {
        betsPlaced += 1;
        totalWagered += 100;
        edgeSum += Math.abs(bestBet.edge);
        const betOnHome = bestBet === homeValue;
        const won = betOnHome ? homeWon : !homeWon;
        const odds = betOnHome ? game.homeMoneyline : game.awayMoneyline;
        netProfit += won ? (odds > 0 ? odds : (100 / Math.abs(odds)) * 100) : -100;
      }
    }

    if (sampleResults.length < sampleLimit) {
      sampleResults.push({
        date: game.date,
        matchup: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
        actualScore: `${game.awayScore}-${game.homeScore}`,
        modelHomeWinProb: homeWinProbability,
        correct: modelPickedHome === homeWon
      });
    }
  });

  const n = games.length;
  return {
    gamesTested: n,
    pointInTimeGames,
    pointInTimeCoverage: pointInTimeGames / n,
    winPct: correctPicks / n,
    brierScore: brierSum / n,
    logLoss: logLossSum / n,
    roi: totalWagered ? (netProfit / totalWagered) * 100 : null,
    netProfit,
    betsPlaced,
    averageEdge: betsPlaced ? edgeSum / betsPlaced : null,
    calibration: calibrationBuckets.filter(b => b.count > 0).map(b => ({ predicted: b.predictedSum / b.count, actual: b.actualWins / b.count, count: b.count })),
    sampleResults,
    trialsPerGame: trials
  };
}

/**
 * Exact (non-Monte Carlo) home win probability from two Normal-distributed
 * scoring means, used by the weight optimizer to score many candidate
 * weight profiles quickly. P(home > away) for independent Normals reduces
 * to Phi(meanDiff / (sd*sqrt(2))); the small continuous-tie mass basketball
 * doesn't actually have in real life is ignored here as a deliberate
 * simplification for search speed.
 */
function analyticHomeWinProbability(awayExpected, homeExpected, sd = SCORE_STD_DEV) {
  const meanDiff = homeExpected - awayExpected;
  const sigma = sd * Math.sqrt(2);
  return clamp(normalCdf(meanDiff / sigma), 0.01, 0.99);
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  // Abramowitz-Stegun 7.1.26 approximation.
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/**
 * Runs the backtest and returns aggregate metrics + a capped sample of
 * individual game results for display.
 */
async function runBacktest({ startDate, endDate, onProgress }) {
  const dataset = await prepareBacktestDataset({ startDate, endDate, onProgress });
  if (!dataset.games.length) {
    return {
      gamesTested: 0,
      reason: dataset.rawCount
        ? "Historical games were found but couldn't be matched to team stats/odds to grade against."
        : "No completed games with results were returned for this date range."
    };
  }
  const result = scoreDataset(dataset, state.weights, { trials: BACKTEST_TRIALS, onProgress });
  return { ...result, dateRange: { start: formatApiDate(startDate), end: formatApiDate(dataset.cappedEnd) } };
}

function clampBacktestRange(startDate, endDate) {
  const maxEnd = addDays(startDate, BACKTEST_MAX_DAYS - 1);
  return endDate > maxEnd ? maxEnd : endDate;
}
