/**
 * weight-optimizer.js
 * Searches for a better category-weight profile by scoring many candidates
 * against the same historical dataset backtest.js uses, then writes the
 * winner back into config.js's weight storage so it becomes the model's
 * default.
 *
 * SPEED: scoring a weight profile with the full 25,000- (or even 3,000-)
 * trial Monte Carlo, repeated over dozens/hundreds of candidate profiles,
 * would lock up a browser tab. During the search itself, each candidate is
 * scored with an exact analytic win probability (Normal-distribution
 * closed form, see analyticHomeWinProbability in backtest.js) instead of
 * simulation - mathematically equivalent to what an infinite-trial Monte
 * Carlo would converge to for win probability, just without the
 * score-distribution extras. Once the search picks a winner, that one
 * profile is re-scored with the real Monte Carlo engine (BACKTEST_TRIALS)
 * so the numbers you see in the final comparison match what the live app
 * would actually show.
 *
 * SEARCH METHOD: this is local random search (a lightweight hill-climber),
 * not a true grid search over thousands of combinations - each iteration
 * perturbs the current best profile by a shrinking random amount and keeps
 * it only if it improves the target metric. It's a reasonable amount of
 * search for a few hundred iterations in a browser tab; it is not
 * guaranteed to find a global optimum.
 */

const OPTIMIZER_MIN_ITERATIONS = 20;
const OPTIMIZER_MAX_ITERATIONS = 500;
const OPTIMIZER_HOLDOUT_FRACTION = 0.3; // last 30% of the range (by date) is never used for search
const OPTIMIZER_MIN_HOLDOUT_GAMES = 15; // below this, a holdout score is too noisy to trust

/**
 * Splits a prepared dataset chronologically (not randomly - random would
 * leak point-in-time-ness and let the search see games "from the future"
 * relative to holdout games) into a search set and a holdout set. The
 * search set is what perturbWeights/candidate-scoring iterates over; the
 * holdout set is scored exactly once, at the end, with the winning
 * profile, so the reported improvement reflects generalization rather
 * than fitting noise in the exact date range you searched.
 */
function splitDatasetChronologically(dataset, holdoutFraction) {
  const sorted = [...dataset.games].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const holdoutCount = Math.round(sorted.length * holdoutFraction);
  const searchGames = sorted.slice(0, sorted.length - holdoutCount);
  const holdoutGames = sorted.slice(sorted.length - holdoutCount);
  return {
    searchDataset: { ...dataset, games: searchGames },
    holdoutDataset: { ...dataset, games: holdoutGames }
  };
}

const OPTIMIZATION_TARGETS = {
  logLoss: { label: "Lowest Log Loss", better: "lower", read: r => r.logLoss },
  brier: { label: "Lowest Brier Score", better: "lower", read: r => r.brierScore },
  roi: { label: "Maximum ROI", better: "higher", read: r => (r.roi === null ? -Infinity : r.roi) },
  winPct: { label: "Highest Prediction Accuracy", better: "higher", read: r => r.winPct }
};

function isBetter(candidateMetric, bestMetric, direction) {
  return direction === "lower" ? candidateMetric < bestMetric : candidateMetric > bestMetric;
}

function perturbWeights(baseWeights, progressFraction) {
  // Search magnitude shrinks as the run progresses (simple annealing) so
  // early iterations explore broadly and later ones fine-tune.
  const magnitude = 0.18 * (1 - progressFraction) + 0.02;
  const candidate = {};
  Object.entries(baseWeights).forEach(([key, value]) => {
    const jitter = (Math.random() * 2 - 1) * magnitude;
    candidate[key] = Math.max(0.005, value + jitter);
  });
  return normalizeWeights(candidate);
}

/**
 * Runs the search and returns baseline vs. optimized weights/metrics.
 * Does NOT save anything - call applyOptimizedWeights() (or saveWeights()
 * directly) with the result to make it the model's default.
 */
async function optimizeWeights({ startDate, endDate, target = "logLoss", iterations = 150, onProgress }) {
  const targetDef = OPTIMIZATION_TARGETS[target] || OPTIMIZATION_TARGETS.logLoss;
  const cappedIterations = clamp(Math.round(iterations), OPTIMIZER_MIN_ITERATIONS, OPTIMIZER_MAX_ITERATIONS);

  onProgress?.("Preparing backtest dataset...");
  const dataset = await prepareBacktestDataset({ startDate, endDate, onProgress });
  if (!dataset.games.length) {
    return {
      success: false,
      reason: dataset.rawCount
        ? "Historical games were found but couldn't be matched to team stats/odds to grade against."
        : "No completed games with results were returned for this date range."
    };
  }

  const { searchDataset, holdoutDataset } = splitDatasetChronologically(dataset, OPTIMIZER_HOLDOUT_FRACTION);
  if (holdoutDataset.games.length < OPTIMIZER_MIN_HOLDOUT_GAMES || searchDataset.games.length < OPTIMIZER_MIN_HOLDOUT_GAMES) {
    return {
      success: false,
      reason: `Date range only has ${dataset.games.length} gradeable games. Optimization holds out the most recent ${Math.round(OPTIMIZER_HOLDOUT_FRACTION * 100)}% for honest validation and needs at least ${OPTIMIZER_MIN_HOLDOUT_GAMES} games on each side - pick a wider date range.`
    };
  }

  const startingWeights = { ...state.weights };
  const baselineSearchScore = scoreDataset(searchDataset, startingWeights, { trials: 0, sampleLimit: 0 });
  let bestWeights = startingWeights;
  let bestMetric = targetDef.read(baselineSearchScore);

  for (let i = 0; i < cappedIterations; i += 1) {
    if (i % 10 === 0) onProgress?.(`Searching weight profiles (${i + 1}/${cappedIterations})...`);
    const candidateWeights = perturbWeights(bestWeights, i / cappedIterations);
    const candidateScore = scoreDataset(searchDataset, candidateWeights, { trials: 0, sampleLimit: 0 });
    const candidateMetric = targetDef.read(candidateScore);
    if (isBetter(candidateMetric, bestMetric, targetDef.better)) {
      bestWeights = candidateWeights;
      bestMetric = candidateMetric;
    }
  }

  // Everything below is scored ONLY on the holdout games, which the search
  // loop above never touched - this is what actually generalizes, as
  // opposed to the in-sample search score, which is reported separately
  // for transparency but should not be read as real-world performance.
  onProgress?.("Validating best profile on held-out games...");
  const optimizedScoreHoldout = scoreDataset(holdoutDataset, bestWeights, { trials: BACKTEST_TRIALS });
  const baselineScoreHoldout = scoreDataset(holdoutDataset, startingWeights, { trials: BACKTEST_TRIALS, sampleLimit: 0 });
  const holdoutImproved = isBetter(targetDef.read(optimizedScoreHoldout), targetDef.read(baselineScoreHoldout), targetDef.better);

  return {
    success: true,
    target,
    targetLabel: targetDef.label,
    iterations: cappedIterations,
    gamesTested: dataset.games.length,
    searchGames: searchDataset.games.length,
    holdoutGames: holdoutDataset.games.length,
    pointInTimeCoverage: optimizedScoreHoldout.pointInTimeCoverage,
    baselineWeights: startingWeights,
    baselineScore: baselineScoreHoldout,
    optimizedWeights: bestWeights,
    optimizedScore: optimizedScoreHoldout,
    holdoutImproved,
    changedMeaningfully: Object.keys(startingWeights).some(
      key => Math.abs(startingWeights[key] - bestWeights[key]) > 0.01
    )
  };
}

/** Persists an optimizer result's winning profile as the model's default. */
function applyOptimizedWeights(result) {
  if (!result?.success) return null;
  const saved = saveWeights(result.optimizedWeights);
  state.weights = saved;
  return saved;
}
