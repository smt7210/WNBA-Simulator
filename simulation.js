/**
 * simulation.js
 * Monte Carlo engine (25,000 trials/game) driven by the composite Team
 * Rating Model, plus betting-value math (edge %, EV, recommended bet,
 * confidence rating).
 *
 * SCORING MODEL: unlike baseball's low-scoring, Poisson-friendly run
 * environment, basketball scores cluster tightly around a mean and are
 * well approximated by a Normal distribution (this is standard practice
 * in public basketball prediction models). Each trial samples both teams'
 * points from Normal(mean = expected points, sd = SCORE_STD_DEV), rounds
 * to the nearest integer, and - because real games can't end tied in
 * regulation - resolves any tie with a simulated 5-minute overtime period
 * (mean scaled to 5/40 of a full game) repeated until someone wins,
 * mirroring extra innings in the MLB build this was adapted from.
 */

const SIMULATIONS_V2 = 25000;
const SCORE_STD_DEV = 10.5; // typical WNBA team single-game scoring std. dev.
const REGULATION_MINUTES = 40;
const OT_MINUTES = 5;

function gaussianRandom(mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * sd;
}

function sampleScore(mean, sd) {
  return Math.max(45, Math.round(gaussianRandom(mean, sd)));
}

/**
 * Combines every per-team multiplier into an expected-points figure for
 * one side of the matchup. `opponentDefenseMultiplier` represents the
 * opposing team's points-allowed rate, so it applies to THIS team's
 * offense the same way `offenseMultiplier` does.
 */
function expectedPointsV2({ leagueAvgPoints, offenseMultiplier, opponentDefenseMultiplier, benchMultiplier, reboundingMultiplier, restTravelMultiplier, recentFormMultiplier, homeCourtFactor, injuryFactor, paceMultiplier = 1 }) {
  const points = leagueAvgPoints *
    offenseMultiplier *
    opponentDefenseMultiplier *
    benchMultiplier *
    reboundingMultiplier *
    restTravelMultiplier *
    recentFormMultiplier *
    homeCourtFactor *
    injuryFactor *
    paceMultiplier;
  return clamp(points, 55, 115);
}

/**
 * Runs the full Monte Carlo simulation for a game.
 * `marketSpread` is the HOME team's spread convention (negative = home
 * favored, e.g. -3.5). `marketTotal` is the game total (over/under line).
 * Both fall back to the model's own numbers when the market hasn't been
 * entered/loaded for a game.
 */
function runMonteCarloV2(awayExpected, homeExpected, marketTotal, marketSpread, trials = SIMULATIONS_V2) {
  const scoreFrequency = new Map();
  let awayWins = 0;
  let homeCovers = 0;
  let awayCovers = 0;
  let overs = 0;
  let unders = 0;
  let awayPointsTotal = 0;
  let homePointsTotal = 0;

  const total = Number.isFinite(marketTotal) ? marketTotal : awayExpected + homeExpected;
  const spread = Number.isFinite(marketSpread) ? marketSpread : -(homeExpected - awayExpected);

  for (let i = 0; i < trials; i += 1) {
    let awayPoints = sampleScore(awayExpected, SCORE_STD_DEV);
    let homePoints = sampleScore(homeExpected, SCORE_STD_DEV);

    while (awayPoints === homePoints) {
      const otAway = expectedForMinutes(awayExpected, OT_MINUTES);
      const otHome = expectedForMinutes(homeExpected, OT_MINUTES);
      awayPoints += sampleScore(otAway, SCORE_STD_DEV * Math.sqrt(OT_MINUTES / REGULATION_MINUTES)) - Math.round(otAway * 0.4);
      homePoints += sampleScore(otHome, SCORE_STD_DEV * Math.sqrt(OT_MINUTES / REGULATION_MINUTES)) - Math.round(otHome * 0.4);
      awayPoints = Math.max(awayPoints, 45);
      homePoints = Math.max(homePoints, 45);
    }

    awayPointsTotal += awayPoints;
    homePointsTotal += homePoints;

    if (awayPoints > homePoints) awayWins += 1;

    const margin = homePoints - awayPoints; // positive = home won by this much
    if (margin + spread > 0) homeCovers += 1;
    if (-margin - spread > 0) awayCovers += 1;

    const gameTotal = awayPoints + homePoints;
    if (gameTotal > total) overs += 1;
    else if (gameTotal < total) unders += 1;

    const key = `${awayPoints}-${homePoints}`;
    scoreFrequency.set(key, (scoreFrequency.get(key) || 0) + 1);
  }

  const mostCommonScores = [...scoreFrequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([score, count]) => ({ score, probability: count / trials }));

  return {
    simulations: trials,
    awayWinProbability: awayWins / trials,
    homeWinProbability: (trials - awayWins) / trials,
    awayAveragePoints: awayPointsTotal / trials,
    homeAveragePoints: homePointsTotal / trials,
    expectedTotalPoints: (awayPointsTotal + homePointsTotal) / trials,
    spread: {
      line: spread,
      homeCoverProbability: homeCovers / trials,
      awayCoverProbability: awayCovers / trials
    },
    total: {
      line: total,
      overProbability: overs / trials,
      underProbability: unders / trials
    },
    mostCommonScores,
    scoreFrequency
  };
}

function expectedForMinutes(fullGameExpected, minutes) {
  return fullGameExpected * (minutes / REGULATION_MINUTES);
}

/**
 * Betting value: compares model win probability to no-vig sportsbook
 * implied probability. Returns edge %, EV per $100, a recommended bet,
 * and a 1-10 confidence rating.
 */
function computeBettingValue({ modelProbability, americanOdds, dataCompleteness = 1, sampleAgreement = 1 }) {
  if (!Number.isFinite(modelProbability) || !Number.isFinite(americanOdds)) {
    return null;
  }

  const impliedProbability = americanToProbability(americanOdds);
  if (impliedProbability === null) return null;

  const decimalOdds = americanOdds > 0 ? americanOdds / 100 + 1 : 100 / Math.abs(americanOdds) + 1;
  const edge = modelProbability - impliedProbability;
  const expectedValuePer100 = (modelProbability * (decimalOdds - 1) * 100) - ((1 - modelProbability) * 100);

  let color = "yellow";
  if (expectedValuePer100 > 3) color = "green";
  if (expectedValuePer100 < 0) color = "red";

  const edgeScore = clamp(Math.abs(edge) * 100 / 8, 0, 1);
  const confidenceRaw = (edgeScore * 0.6 + dataCompleteness * 0.25 + sampleAgreement * 0.15) * 10;
  const confidence = Math.round(clamp(confidenceRaw, 1, 10));

  return {
    modelProbability,
    impliedProbability,
    edge,
    expectedValuePer100,
    color,
    confidence,
    recommendedBet: expectedValuePer100 > 0 ? "Bet" : "Pass",
    americanOdds
  };
}

function americanToProbability(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}
