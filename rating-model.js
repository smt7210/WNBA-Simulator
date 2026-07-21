/**
 * rating-model.js
 * Builds a composite WNBA Team Rating from seven weighted categories:
 *   Offensive Rating (32%), Defensive Rating (28%), Bench Depth & Star
 *   Availability (15%), Rebounding & Ball Control (8%), Rest & Travel (7%),
 *   Recent Form (5%), Home Court Advantage (5%).
 * Weights come from config.js / state.weights, NOT hard-coded here.
 *
 * Unlike the MLB build this was adapted from, there is no separate
 * FanGraphs/Savant-equivalent advanced-stats provider for the WNBA. Instead
 * every advanced number here (possession-based ORtg/DRtg, the Four Factors,
 * per-100-possession rates) is computed client-side from the raw box-score
 * counting stats SportsData.io's TeamSeasonStats/PlayerSeasonStats
 * endpoints return. League-average anchors are computed dynamically from
 * that season's league-wide data (buildLeagueAverages) rather than
 * hard-coded, since pace/scoring environment can shift year to year.
 *
 * WEIGHT APPLICATION: each category produces a raw multiplier centered at
 * 1.0 (clamped 0.75-1.35, the standard z-score-derived-multiplier
 * convention). That raw deviation from 1.0 is then scaled by
 * `weight * 7` (7 = number of categories) before being applied, so a
 * category weighted exactly at the 1/7 average swings the final number
 * exactly as much as its raw z-score suggests, while an above-average
 * weight (e.g. Offensive Rating at 32%) swings proportionally more and a
 * below-average one (Recent Form at 5%) swings proportionally less. This
 * is a deliberate, transparent scaling rule for this build - not a literal
 * port of the MLB app's category-weighting, which applied weights
 * inconsistently across categories.
 *
 * Every sub-metric that can't be sourced falls back to a neutral value
 * (1.0 multiplier) and is flagged in the returned `components` object so
 * the UI can show "N/A - reason" instead of pretending we have data we
 * don't.
 */

const NUM_RATING_CATEGORIES = 7;

function zMultiplier(value, leagueAvg, spread, invert = false) {
  if (!Number.isFinite(value) || !Number.isFinite(leagueAvg) || !leagueAvg) {
    return 1;
  }
  const raw = value / leagueAvg;
  const signed = invert ? 2 - raw : raw;
  return clamp(1 + (signed - 1) * spread, 0.75, 1.35);
}

function applyCategoryWeight(rawMultiplier, weight) {
  if (!Number.isFinite(rawMultiplier)) return 1;
  const scaled = 1 + (rawMultiplier - 1) * weight * NUM_RATING_CATEGORIES;
  return clamp(scaled, 0.6, 1.6);
}

function sdNum(row, keys, fallback = NaN) {
  for (const key of keys) {
    const value = row ? row[key] : undefined;
    if (value !== undefined && value !== null) {
      const parsed = typeof value === "string" ? parseFloat(value) : value;
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

/** Season totals -> per-game, guarding against payloads that already give
 * per-game averages instead of totals. */
function perGame(row, key, gamesKey = "Games") {
  const value = sdNum(row, [key]);
  const games = sdNum(row, [gamesKey], NaN);
  if (!Number.isFinite(value)) return NaN;
  if (Number.isFinite(games) && games > 0 && value > 200) return value / games;
  return value;
}

/**
 * Computes possessions and the Four Factors for a team from raw box-score
 * fields. Possessions formula: FGA - OREB + TOV + 0.44*FTA (standard
 * Basketball Reference / Dean Oliver estimate).
 */
function computeFourFactors(row) {
  if (!row) return null;
  const pts = perGame(row, "Points");
  const fga = perGame(row, "FieldGoalsAttempted");
  const fgm = perGame(row, "FieldGoalsMade");
  const tpa = perGame(row, "ThreePointersAttempted");
  const tpm = perGame(row, "ThreePointersMade");
  const fta = perGame(row, "FreeThrowsAttempted");
  const oreb = perGame(row, "OffensiveRebounds");
  const dreb = perGame(row, "DefensiveRebounds");
  const tov = perGame(row, "Turnovers");
  const ast = perGame(row, "Assists");
  const stl = perGame(row, "Steals");
  const blk = perGame(row, "BlockedShots") || perGame(row, "Blocks");

  const possessions = Number.isFinite(fga) && Number.isFinite(oreb) && Number.isFinite(tov) && Number.isFinite(fta)
    ? fga - oreb + tov + 0.44 * fta
    : NaN;

  return {
    possessions,
    pointsPerGame: pts,
    offensiveRating: Number.isFinite(pts) && possessions > 0 ? (pts / possessions) * 100 : NaN,
    effectiveFgPct: Number.isFinite(fgm) && Number.isFinite(tpm) && fga > 0 ? (fgm + 0.5 * tpm) / fga : NaN,
    freeThrowRate: Number.isFinite(fta) && fga > 0 ? fta / fga : NaN,
    threePointRate: Number.isFinite(tpa) && fga > 0 ? tpa / fga : NaN,
    assistPct: Number.isFinite(ast) && fgm > 0 ? ast / fgm : NaN,
    turnoverPct: Number.isFinite(tov) && possessions > 0 ? tov / possessions : NaN,
    offensiveReboundRaw: oreb,
    defensiveReboundRaw: dreb,
    stealsPer100: Number.isFinite(stl) && possessions > 0 ? (stl / possessions) * 100 : NaN,
    blocksPer100: Number.isFinite(blk) && possessions > 0 ? (blk / possessions) * 100 : NaN,
    assistToTurnover: Number.isFinite(ast) && tov > 0 ? ast / tov : NaN
  };
}

/** Opponent-facing side of the Four Factors (what a team allows), using
 * SportsData.io's mirrored Opponent* fields when present. */
function computeOpponentFourFactors(row) {
  if (!row) return null;
  const oppPts = perGame(row, "OpponentPoints");
  const oppFga = perGame(row, "OpponentFieldGoalsAttempted");
  const oppFgm = perGame(row, "OpponentFieldGoalsMade");
  const oppTpm = perGame(row, "OpponentThreePointersMade");
  const oppOreb = perGame(row, "OpponentOffensiveRebounds");
  const oppTov = perGame(row, "OpponentTurnovers");
  const oppFta = perGame(row, "OpponentFreeThrowsAttempted");

  const oppPossessions = Number.isFinite(oppFga) && Number.isFinite(oppOreb) && Number.isFinite(oppTov) && Number.isFinite(oppFta)
    ? oppFga - oppOreb + oppTov + 0.44 * oppFta
    : NaN;

  return {
    oppPossessions,
    defensiveRating: Number.isFinite(oppPts) && oppPossessions > 0 ? (oppPts / oppPossessions) * 100 : NaN,
    opponentEffectiveFgPct: Number.isFinite(oppFgm) && Number.isFinite(oppTpm) && oppFga > 0 ? (oppFgm + 0.5 * oppTpm) / oppFga : NaN
  };
}

/**
 * League-wide averages for every anchor stat this model uses, computed
 * from that season's full set of TeamSeasonStats rows instead of a
 * hard-coded constant.
 */
function buildLeagueAverages(teamRows) {
  const factors = (teamRows || []).map(computeFourFactors).filter(Boolean);
  const oppFactors = (teamRows || []).map(computeOpponentFourFactors).filter(Boolean);
  const avg = (arr, key) => {
    const values = arr.map(f => f[key]).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
  };
  return {
    offensiveRating: avg(factors, "offensiveRating"),
    effectiveFgPct: avg(factors, "effectiveFgPct"),
    freeThrowRate: avg(factors, "freeThrowRate"),
    threePointRate: avg(factors, "threePointRate"),
    assistPct: avg(factors, "assistPct"),
    turnoverPct: avg(factors, "turnoverPct"),
    stealsPer100: avg(factors, "stealsPer100"),
    blocksPer100: avg(factors, "blocksPer100"),
    assistToTurnover: avg(factors, "assistToTurnover"),
    defensiveRating: avg(oppFactors, "defensiveRating"),
    opponentEffectiveFgPct: avg(oppFactors, "opponentEffectiveFgPct"),
    pointsPerGame: avg(factors, "pointsPerGame"),
    offensiveReboundsPerGame: avg(factors, "offensiveReboundRaw"),
    defensiveReboundsPerGame: avg(factors, "defensiveReboundRaw"),
    benchPointsPerGame: NaN // filled in by app.js once bench data is loaded league-wide, else per-team self-anchored
  };
}

function offenseComponentScore(seasonRow, last10Row, leagueAvg) {
  const season = computeFourFactors(seasonRow);
  const last10 = last10Row ? computeFourFactors(last10Row) : null;
  const components = {};
  const scores = [];
  const weights = [];

  function add(key, seasonValue, last10Value, anchor, weight, invert) {
    const blendCfg = OFFENSE_RECENCY_BLEND;
    let value = seasonValue;
    if (Number.isFinite(seasonValue) && Number.isFinite(last10Value)) {
      value = seasonValue * blendCfg.season + last10Value * blendCfg.last10;
    } else if (Number.isFinite(last10Value)) {
      value = last10Value;
    }
    const available = Number.isFinite(value);
    components[key] = { value: available ? value : null, available };
    if (available && Number.isFinite(anchor)) {
      scores.push(zMultiplier(value, anchor, 0.9, invert));
      weights.push(weight);
    }
  }

  add("offensiveRating", season?.offensiveRating, last10?.offensiveRating, leagueAvg.offensiveRating, OFFENSE_SUBWEIGHTS.offensiveRating, false);
  add("effectiveFgPct", season?.effectiveFgPct, last10?.effectiveFgPct, leagueAvg.effectiveFgPct, OFFENSE_SUBWEIGHTS.effectiveFgPct, false);
  add("freeThrowRate", season?.freeThrowRate, last10?.freeThrowRate, leagueAvg.freeThrowRate, OFFENSE_SUBWEIGHTS.freeThrowRate, false);
  add("threePointRate", season?.threePointRate, last10?.threePointRate, leagueAvg.threePointRate, OFFENSE_SUBWEIGHTS.threePointRate, false);
  add("assistPct", season?.assistPct, last10?.assistPct, leagueAvg.assistPct, OFFENSE_SUBWEIGHTS.assistPct, false);

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const blended = totalWeight ? scores.reduce((sum, s, i) => sum + s * weights[i], 0) / totalWeight : 1;
  const maxWeight = Object.values(OFFENSE_SUBWEIGHTS).reduce((a, b) => a + b, 0);

  return { multiplier: blended, components, dataCompleteness: totalWeight / maxWeight, pointsPerGame: season?.pointsPerGame ?? null };
}

function defenseComponentScore(seasonRow, last10Row, leagueAvg) {
  const season = computeOpponentFourFactors(seasonRow);
  const last10 = last10Row ? computeOpponentFourFactors(last10Row) : null;
  const components = {};
  const scores = [];
  const weights = [];

  function add(key, seasonValue, last10Value, anchor, weight, invert) {
    const blendCfg = DEFENSE_RECENCY_BLEND;
    let value = seasonValue;
    if (Number.isFinite(seasonValue) && Number.isFinite(last10Value)) {
      value = seasonValue * blendCfg.season + last10Value * blendCfg.last10;
    } else if (Number.isFinite(last10Value)) {
      value = last10Value;
    }
    const available = Number.isFinite(value);
    components[key] = { value: available ? value : null, available };
    if (available && Number.isFinite(anchor)) {
      scores.push(zMultiplier(value, anchor, 0.9, invert));
      weights.push(weight);
    }
  }

  // Lower defensive rating / opponent eFG% allowed = better defense, so
  // these are NOT inverted - a below-average number should already pull
  // the multiplier down via zMultiplier's raw ratio.
  add("defensiveRating", season?.defensiveRating, last10?.defensiveRating, leagueAvg.defensiveRating, DEFENSE_SUBWEIGHTS.defensiveRating, false);
  add("opponentEffectiveFgPct", season?.opponentEffectiveFgPct, last10?.opponentEffectiveFgPct, leagueAvg.opponentEffectiveFgPct, DEFENSE_SUBWEIGHTS.opponentEffectiveFgPct, false);

  const seasonOwn = computeFourFactors(seasonRow);
  const last10Own = last10Row ? computeFourFactors(last10Row) : null;
  // Higher steals/blocks = better defense = should LOWER the "points
  // allowed" multiplier, hence invert = true here.
  add("stealsPer100", seasonOwn?.stealsPer100, last10Own?.stealsPer100, leagueAvg.stealsPer100, DEFENSE_SUBWEIGHTS.stealPct, true);
  add("blocksPer100", seasonOwn?.blocksPer100, last10Own?.blocksPer100, leagueAvg.blocksPer100, DEFENSE_SUBWEIGHTS.blockPct, true);

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const blended = totalWeight ? scores.reduce((sum, s, i) => sum + s * weights[i], 0) / totalWeight : 1;
  const maxWeight = Object.values(DEFENSE_SUBWEIGHTS).reduce((a, b) => a + b, 0);

  return { multiplier: blended, components, dataCompleteness: totalWeight / maxWeight, pointsAllowedPerGame: season?.defensiveRating ?? null };
}

/**
 * Bench depth & star availability. Uses player season stats (minutes,
 * points) to find bench scoring and rotation concentration, and the
 * active injury feed to discount for missing high-usage players.
 */
function benchComponentScore(playerRows, injuryRows, leagueAvg) {
  const components = {};
  const scores = [];
  const weights = [];

  const players = (playerRows || [])
    .filter(p => Number.isFinite(sdNum(p, ["Minutes"])) || Number.isFinite(sdNum(p, ["MinutesPerGame"])))
    .map(p => ({
      name: p.Name || p.ShortDisplayName || "Unknown",
      minutes: sdNum(p, ["MinutesPerGame", "Minutes"], 0),
      points: sdNum(p, ["PointsPerGame", "Points"], 0)
    }))
    .sort((a, b) => b.minutes - a.minutes);

  if (players.length) {
    const starters = players.slice(0, 5);
    const bench = players.slice(5);
    const benchPointsPerGame = bench.reduce((sum, p) => sum + (p.points || 0), 0);
    components.benchPointsPerGame = { value: benchPointsPerGame, available: true };
    scores.push(zMultiplier(benchPointsPerGame, leagueAvg.benchPointsPerGame || benchPointsPerGame || 1, 0.8, false));
    weights.push(BENCH_SUBWEIGHTS.benchPointsPerGame);

    const totalMinutes = players.reduce((sum, p) => sum + (p.minutes || 0), 0);
    const top3MinutesShare = totalMinutes > 0 ? starters.slice(0, 3).reduce((s, p) => s + p.minutes, 0) / totalMinutes : NaN;
    components.minutesConcentration = { value: Number.isFinite(top3MinutesShare) ? top3MinutesShare : null, available: Number.isFinite(top3MinutesShare) };
    if (Number.isFinite(top3MinutesShare)) {
      scores.push(zMultiplier(top3MinutesShare, 0.45, 0.8, true)); // ~45% is a typical top-3 share; higher = more top-heavy = worse depth
      weights.push(BENCH_SUBWEIGHTS.minutesConcentration);
    }

    const outNames = new Set((injuryRows || []).filter(inj => /out|doubtful/i.test(inj.InjuryStatus || inj.Status || "")).map(inj => inj.Name));
    const usageWeightedMinutes = players.reduce((sum, p) => sum + p.minutes, 0);
    const activeUsageMinutes = players.filter(p => !outNames.has(p.name)).reduce((sum, p) => sum + p.minutes, 0);
    const starAvailability = usageWeightedMinutes > 0 ? activeUsageMinutes / usageWeightedMinutes : NaN;
    components.starAvailability = { value: Number.isFinite(starAvailability) ? starAvailability : null, available: Number.isFinite(starAvailability) };
    if (Number.isFinite(starAvailability)) {
      scores.push(clamp(0.7 + starAvailability * 0.3, 0.75, 1.05));
      weights.push(BENCH_SUBWEIGHTS.starAvailability);
    }
  } else {
    components.benchPointsPerGame = { value: null, available: false };
    components.minutesConcentration = { value: null, available: false };
    components.starAvailability = { value: null, available: false };
  }

  components.benchNetRating = { value: null, available: false, reason: "Not exposed by this data source" };

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const blended = totalWeight ? scores.reduce((sum, s, i) => sum + s * weights[i], 0) / totalWeight : 1;
  const maxWeight = Object.values(BENCH_SUBWEIGHTS).reduce((a, b) => a + b, 0);
  return { multiplier: blended, components, dataCompleteness: totalWeight / maxWeight };
}

function reboundingComponentScore(seasonRow, leagueAvg) {
  const own = computeFourFactors(seasonRow);
  const components = {};
  const scores = [];
  const weights = [];

  // True rebound-RATE needs the opponent's available rebounds (their
  // misses), which raw team-season totals don't expose per-opponent here.
  // We use per-game raw counts vs league average instead, which is still
  // informative, and flag this as a simplification rather than fabricate
  // a rate we can't actually compute.
  components.offensiveReboundsPerGame = { value: own?.offensiveReboundRaw ?? null, available: Number.isFinite(own?.offensiveReboundRaw), note: "Raw per-game count, not a true OREB% (opponent available-rebound data not exposed)" };
  components.defensiveReboundsPerGame = { value: own?.defensiveReboundRaw ?? null, available: Number.isFinite(own?.defensiveReboundRaw), note: "Raw per-game count, not a true DREB%" };

  if (Number.isFinite(own?.offensiveReboundRaw) && Number.isFinite(leagueAvg.offensiveReboundsPerGame)) {
    scores.push(zMultiplier(own.offensiveReboundRaw, leagueAvg.offensiveReboundsPerGame, 0.7, false));
    weights.push(REBOUNDING_SUBWEIGHTS.offensiveReboundPct);
  }
  if (Number.isFinite(own?.defensiveReboundRaw) && Number.isFinite(leagueAvg.defensiveReboundsPerGame)) {
    scores.push(zMultiplier(own.defensiveReboundRaw, leagueAvg.defensiveReboundsPerGame, 0.7, false));
    weights.push(REBOUNDING_SUBWEIGHTS.defensiveReboundPct);
  }

  components.turnoverPct = { value: own?.turnoverPct ?? null, available: Number.isFinite(own?.turnoverPct) };
  if (Number.isFinite(own?.turnoverPct) && Number.isFinite(leagueAvg.turnoverPct)) {
    scores.push(zMultiplier(own.turnoverPct, leagueAvg.turnoverPct, 0.9, true));
    weights.push(REBOUNDING_SUBWEIGHTS.turnoverPct);
  }

  components.assistToTurnover = { value: own?.assistToTurnover ?? null, available: Number.isFinite(own?.assistToTurnover) };
  if (Number.isFinite(own?.assistToTurnover) && Number.isFinite(leagueAvg.assistToTurnover)) {
    scores.push(zMultiplier(own.assistToTurnover, leagueAvg.assistToTurnover, 0.7, false));
    weights.push(REBOUNDING_SUBWEIGHTS.assistToTurnoverRatio);
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const blended = totalWeight ? scores.reduce((sum, s, i) => sum + s * weights[i], 0) / totalWeight : 1;
  const maxWeight = Object.values(REBOUNDING_SUBWEIGHTS).reduce((a, b) => a + b, 0);
  return { multiplier: blended, components, dataCompleteness: totalWeight / maxWeight };
}

/** Rest & travel: back-to-backs are the dominant WNBA schedule effect
 * given the league's compressed calendar. */
function restTravelFactor({ daysRest, isBackToBack } = {}) {
  const components = { daysRest: { value: Number.isFinite(daysRest) ? daysRest : null, available: Number.isFinite(daysRest) }, isBackToBack: { value: !!isBackToBack, available: true } };
  if (!Number.isFinite(daysRest)) {
    return { multiplier: 1, components, dataCompleteness: 0 };
  }
  let multiplier;
  if (isBackToBack) multiplier = 0.94;
  else multiplier = clamp(1 + (clamp(daysRest, 0, 5) - 1) * 0.012, 0.94, 1.05);
  return { multiplier, components, dataCompleteness: 1 };
}

/** Momentum: last-10 win% vs season win%, separate from the recency blend
 * already folded into offense/defense sub-metrics above. */
function recentFormFactor(seasonWinPct, last10WinPct) {
  const available = Number.isFinite(seasonWinPct) && Number.isFinite(last10WinPct);
  const components = { seasonWinPct: { value: Number.isFinite(seasonWinPct) ? seasonWinPct : null, available: Number.isFinite(seasonWinPct) }, last10WinPct: { value: Number.isFinite(last10WinPct) ? last10WinPct : null, available: Number.isFinite(last10WinPct) } };
  if (!available) return { multiplier: 1, components, dataCompleteness: 0 };
  const diff = last10WinPct - seasonWinPct; // -1..1
  const multiplier = clamp(1 + diff * 0.15, 0.9, 1.1);
  return { multiplier, components, dataCompleteness: 1 };
}

/**
 * Full composite rating for one team in a specific matchup context.
 * Returns per-category multipliers (already weight-scaled) plus the raw
 * breakdown for the UI.
 */
function buildTeamRating({ isHome, teamStats, teamStatsLast10, playerStats, injuries, leagueAverages, restInfo, seasonWinPct, last10WinPct, weights }) {
  const offense = offenseComponentScore(teamStats, teamStatsLast10, leagueAverages);
  const defense = defenseComponentScore(teamStats, teamStatsLast10, leagueAverages);
  const bench = benchComponentScore(playerStats, injuries, leagueAverages);
  const rebounding = reboundingComponentScore(teamStats, leagueAverages);
  const rest = restTravelFactor(restInfo);
  const form = recentFormFactor(seasonWinPct, last10WinPct);

  const homeCourtRaw = isHome ? 1 + weights.homeCourtAdvantage : 1 - weights.homeCourtAdvantage;

  return {
    offenseMultiplier: applyCategoryWeight(offense.multiplier, weights.offensiveRating),
    defenseMultiplier: applyCategoryWeight(defense.multiplier, weights.defensiveRating),
    benchMultiplier: applyCategoryWeight(bench.multiplier, weights.benchDepth),
    reboundingMultiplier: applyCategoryWeight(rebounding.multiplier, weights.reboundingBallControl),
    restTravelMultiplier: applyCategoryWeight(rest.multiplier, weights.restTravel),
    recentFormMultiplier: applyCategoryWeight(form.multiplier, weights.recentForm),
    homeCourtFactor: clamp(homeCourtRaw, 0.9, 1.1),
    breakdown: { offense, defense, bench, rebounding, rest, form }
  };
}
