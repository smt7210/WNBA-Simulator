/**
 * config.js
 * Central, editable configuration for the WNBA Team Rating Model.
 *
 * WEIGHTS ARE NOT HARD-CODED INTO THE MODEL MATH.
 * `DEFAULT_WEIGHTS` below is just the starting profile. The model reads
 * whatever is in `state.weights` at run time, and `state.weights` is
 * editable from the UI and persisted to localStorage under
 * WEIGHTS_STORAGE_KEY. The weight-optimizer can write a new profile into
 * the same shape and the rating model does not need to change.
 */

const PROXY_BASE_URL = window.WNBA_PROXY_BASE_URL || "http://localhost:8788";

// SportsData.io WNBA v3 API. Covers schedule/scores, team & player season
// stats, standings, injuries, and betting odds with a hosted historical
// archive. Used as the single primary data source (there is no
// FanGraphs/Savant-equivalent third-party advanced-stats site for the WNBA,
// so unlike the MLB build, all inputs here come from one provider and the
// four-factors/ratings math is computed client-side from raw box score
// components rather than sourced pre-computed).
//
// Get your own key at https://sportsdata.io (WNBA API) and replace this
// placeholder before deploying. Do not commit a real key to a public repo -
// for anything beyond local/personal use, route requests through the proxy
// server instead so the key isn't sitting in client-side JS.
const SPORTSDATA_API_KEY = "f2c686d441914b7d9ee12db47c7f1e00";
const SPORTSDATA_BASE = "https://api.sportsdata.io/v3/wnba";

// The Odds API (https://the-odds-api.com) - used for betting odds (moneyline,
// spread, total) instead of SportsData.io's /odds endpoint. SportsData.io
// remains the source for schedule/scores, team & player stats, standings,
// and injuries; only odds are sourced from here now. Free tier is 500
// requests/month, so the client fetches the whole slate once per page
// load/date change rather than per game - see odds-api-client.js.
//
// Get your own key at https://the-odds-api.com and replace this placeholder.
// Same caution as the SportsData.io key: don't ship a real key in
// client-side JS for anything beyond local/personal use.
const ODDS_API_KEY = "7cc3cd569bfa99aa62edbefbb46cd348";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const ODDS_API_SPORT_KEY = "basketball_wnba";
const ODDS_API_REGIONS = "us";
const ODDS_API_MARKETS = "h2h,spreads,totals";
// Preference order when multiple sportsbooks are returned for the same
// game - the first one present in a given event's bookmakers array wins.
// Falls back to whichever bookmaker the event happens to list first.
const ODDS_API_PREFERRED_BOOKMAKERS = ["draftkings", "fanduel", "betmgm", "williamhill_us"];

const WEIGHTS_STORAGE_KEY = "wnba-monte-carlo-simulator:weights:v1";
const RATINGS_STORAGE_KEY = "wnba-monte-carlo-simulator:manual-ratings:v1";
const ODDS_STORAGE_KEY = "wnba-monte-carlo-simulator:manual-odds:v1";

// Category weights must sum to 1. UI enforces/normalizes this on edit.
// Basketball equivalent of the MLB build's 7-category spec:
//   Starting Pitcher -> Offensive Rating (the primary scoring engine)
//   Offense           -> Defensive Rating
//   Bullpen           -> Bench Depth & Star Availability
//   Defense            } combined into Rebounding & Ball Control
//   Baserunning        }
//   Park & Weather    -> Rest & Travel (no weather indoors; back-to-backs
//                         and schedule density matter a lot in the WNBA's
//                         compressed calendar)
//   Home Field        -> Home Court Advantage
// Recent form (last-10) is added as its own small slice since a 40-game
// season makes momentum swings larger than in a 162-game MLB season.
const DEFAULT_WEIGHTS = {
  offensiveRating: 0.32,
  defensiveRating: 0.28,
  benchDepth: 0.15,
  reboundingBallControl: 0.08,
  restTravel: 0.07,
  recentForm: 0.05,
  homeCourtAdvantage: 0.05
};

// Sub-weights within Offensive Rating (blended into a single 0-1 score
// before the category weight is applied).
const OFFENSE_SUBWEIGHTS = {
  offensiveRating: 0.40, // possession-based ORtg (points per 100 possessions)
  effectiveFgPct: 0.25,
  freeThrowRate: 0.15,
  threePointRate: 0.10,
  assistPct: 0.10
};

const DEFENSE_SUBWEIGHTS = {
  defensiveRating: 0.45, // possession-based DRtg allowed
  opponentEffectiveFgPct: 0.25,
  blockPct: 0.15,
  stealPct: 0.15
};

const OFFENSE_RECENCY_BLEND = { season: 0.65, last10: 0.35 };
const DEFENSE_RECENCY_BLEND = { season: 0.65, last10: 0.35 };

const BENCH_SUBWEIGHTS = {
  benchPointsPerGame: 0.35,
  benchNetRating: 0.25,
  starAvailability: 0.25, // injury-adjusted: fraction of usage-weighted minutes active
  minutesConcentration: 0.15 // inverted - lower reliance on a short rotation is better depth
};

const REBOUNDING_SUBWEIGHTS = {
  offensiveReboundPct: 0.30,
  defensiveReboundPct: 0.30,
  turnoverPct: 0.25, // inverted (lower is better)
  assistToTurnoverRatio: 0.15
};

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (!total) return { ...DEFAULT_WEIGHTS };
  const normalized = {};
  Object.entries(weights).forEach(([key, value]) => {
    normalized[key] = (Number(value) || 0) / total;
  });
  return normalized;
}

function loadWeights() {
  try {
    const stored = JSON.parse(localStorage.getItem(WEIGHTS_STORAGE_KEY));
    if (stored && typeof stored === "object") {
      return normalizeWeights({ ...DEFAULT_WEIGHTS, ...stored });
    }
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_WEIGHTS };
}

function saveWeights(weights) {
  const normalized = normalizeWeights(weights);
  localStorage.setItem(WEIGHTS_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}
