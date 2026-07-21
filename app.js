/**
 * app.js
 * Orchestrates the WNBA Monte Carlo Simulator: schedule loading, hydrating
 * every game with team/player/injury/rest data, running the composite
 * Team Rating Model + Monte Carlo simulation per game, and all UI
 * rendering (game cards, weights panel, backtest/optimizer panels).
 */

const state = {
  weights: loadWeights(),
  odds: loadOdds(),
  selectedDate: new Date(),
  games: [],
  leagueAverages: null,
  leagueAveragesSeason: null,
  teamSeasonRowsBySeason: {},
  teamStats: new Map(),       // teamAbbr -> season row
  teamStatsLast10: new Map(), // teamAbbr -> last-10 row (best effort)
  playerStats: new Map(),     // teamAbbr -> rows
  injuries: new Map(),        // teamAbbr -> rows
  standings: new Map(),       // teamAbbr -> row (for winPct/last10WinPct)
  restInfo: new Map(),        // teamAbbr -> { daysRest, isBackToBack }
  simResults: new Map(),      // gameKey -> simulation result
  busy: false
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value) {
  const parsed = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatApiDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function teamAliasKey(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function teamNamesMatch(value, abbr) {
  if (!value || !abbr) return false;
  return teamAliasKey(value) === teamAliasKey(abbr) || value.toUpperCase() === abbr.toUpperCase();
}

function setStatus(message, type = "info") {
  const el = document.getElementById("statusText");
  const dot = document.getElementById("statusDot");
  if (el) el.textContent = message;
  const dotClass = type === "ok" ? "ready" : type === "error" ? "error" : "";
  if (dot) dot.className = `status-dot ${dotClass}`.trim();
}

function setBusy(isBusy) {
  state.busy = isBusy;
  document.querySelectorAll("button").forEach(btn => { btn.disabled = isBusy && btn.id !== "refreshButton"; });
}

// ---------------------------------------------------------------------
// Manual overrides (ratings unused for WNBA - kept structurally similar
// to the MLB build's storage pattern for odds, which basketball keeps)
// ---------------------------------------------------------------------

function loadOdds() {
  try {
    return JSON.parse(localStorage.getItem(ODDS_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveOdds() {
  localStorage.setItem(ODDS_STORAGE_KEY, JSON.stringify(state.odds));
}

function oddsKey(game) {
  return `${formatApiDate(state.selectedDate)}:${game.away.abbreviation}@${game.home.abbreviation}`;
}

function ensureOdds(game) {
  const key = oddsKey(game);
  if (!state.odds[key]) {
    state.odds[key] = {
      awayMoneyline: Number.isFinite(game.odds?.awayMoneyline) ? game.odds.awayMoneyline : null,
      homeMoneyline: Number.isFinite(game.odds?.homeMoneyline) ? game.odds.homeMoneyline : null,
      spread: Number.isFinite(game.odds?.pointSpread) ? game.odds.pointSpread : null,
      total: Number.isFinite(game.odds?.overUnder) ? game.odds.overUnder : null
    };
  }
  return state.odds[key];
}

function normalizedOdds(game) {
  const stored = state.odds[oddsKey(game)];
  if (!stored) return null;
  if (!Number.isFinite(stored.awayMoneyline) && !Number.isFinite(stored.homeMoneyline)) return null;
  return stored;
}

// ---------------------------------------------------------------------
// Schedule + hydration
// ---------------------------------------------------------------------

async function loadSchedule() {
  setBusy(true);
  setStatus("Loading WNBA schedule...", "info");
  try {
    const rawGames = await fetchSportsDataGames(state.selectedDate);
    state.games = rawGames.map(row => ({
      id: row.gameId || `${row.rawAwayTeam}@${row.rawHomeTeam}:${formatApiDate(state.selectedDate)}`,
      dateTime: row.dateTime,
      status: row.status,
      away: { name: row.rawAwayTeam, abbreviation: row.rawAwayTeam },
      home: { name: row.rawHomeTeam, abbreviation: row.rawHomeTeam },
      odds: row.odds
    }));

    if (!state.games.length) {
      setStatus(sportsDataStatus.games.available ? "No WNBA games scheduled for this date." : `Schedule unavailable: ${sportsDataStatus.games.reason}`, sportsDataStatus.games.available ? "info" : "error");
    } else {
      setStatus(`Loaded ${state.games.length} game(s). Hydrating team data...`, "info");
      await hydrateModelData();
      setStatus(`Ready - ${state.games.length} game(s) for ${formatApiDate(state.selectedDate)}.`, "ok");
    }
    renderGames();
  } catch (err) {
    setStatus(`Failed to load schedule: ${err.message}`, "error");
  } finally {
    setBusy(false);
    renderDataSourceStatus();
  }
}

async function hydrateModelData() {
  const season = currentWnbaSeason(state.selectedDate);

  if (!state.leagueAverages || state.leagueAveragesSeason !== season) {
    const teamRows = await fetchTeamSeasonStats(season);
    state.leagueAveragesSeason = season;
    state.teamSeasonRowsBySeason[season] = teamRows;
    state.leagueAverages = buildLeagueAverages(teamRows);
    teamRows.forEach(row => state.teamStats.set(row.Team || row.Key, row));

    const lastTenRows = await fetchTeamSeasonStatsLastGames(season, 10);
    if (lastTenRows) {
      lastTenRows.forEach(row => state.teamStatsLast10.set(row.Team || row.Key, row));
    }

    const standingsRows = await fetchStandings(season);
    standingsRows.forEach(row => state.standings.set(row.Team || row.Key, row));
  }

  const injuryRows = await fetchInjuries();
  const injuriesByTeam = new Map();
  injuryRows.forEach(row => {
    const key = row.Team || row.TeamAbbreviation;
    if (!key) return;
    if (!injuriesByTeam.has(key)) injuriesByTeam.set(key, []);
    injuriesByTeam.get(key).push(row);
  });
  state.injuries = injuriesByTeam;

  const teamAbbrs = new Set();
  state.games.forEach(g => { teamAbbrs.add(g.away.abbreviation); teamAbbrs.add(g.home.abbreviation); });
  for (const abbr of teamAbbrs) {
    const players = await fetchPlayerSeasonStatsByTeam(season, abbr);
    state.playerStats.set(abbr, players);
  }

  await hydrateRestInfo(teamAbbrs, season);

  const oddsRows = await fetchBettingOddsByDate(state.selectedDate);
  state.games.forEach(game => {
    const match = oddsRows.find(o => teamNamesMatch(o.AwayTeam, game.away.abbreviation) && teamNamesMatch(o.HomeTeam, game.home.abbreviation));
    if (match) {
      game.odds = {
        awayMoneyline: sdField(match, ["AwayTeamMoneyLine"]),
        homeMoneyline: sdField(match, ["HomeTeamMoneyLine"]),
        overUnder: sdField(match, ["OverUnder", "PointSpreadOverUnder"]),
        pointSpread: sdField(match, ["PointSpread"])
      };
    }
    ensureOdds(game);
  });
}

/** Looks back a few days to find each team's most recent prior game, to
 * derive days-rest and back-to-back flags for the Rest & Travel category. */
async function hydrateRestInfo(teamAbbrs, season) {
  const lookbackDays = 6;
  const gamesByTeam = new Map();
  for (let offset = 1; offset <= lookbackDays; offset += 1) {
    const day = addDays(state.selectedDate, -offset);
    const dayGames = await fetchSportsDataGames(day);
    dayGames.forEach(g => {
      [g.rawAwayTeam, g.rawHomeTeam].forEach(abbr => {
        if (!gamesByTeam.has(abbr)) gamesByTeam.set(abbr, []);
        gamesByTeam.get(abbr).push(day);
      });
    });
  }
  teamAbbrs.forEach(abbr => {
    const priorDates = (gamesByTeam.get(abbr) || []).sort((a, b) => b - a);
    if (!priorDates.length) {
      state.restInfo.set(abbr, { daysRest: NaN, isBackToBack: false });
      return;
    }
    const mostRecent = priorDates[0];
    const daysRest = Math.round((state.selectedDate - mostRecent) / (24 * 60 * 60 * 1000)) - 1;
    state.restInfo.set(abbr, { daysRest: Math.max(0, daysRest), isBackToBack: daysRest <= 0 });
  });
}

// ---------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------

function winPctFor(abbr) {
  const row = state.standings.get(abbr);
  if (!row) return NaN;
  const wins = num(row.Wins);
  const losses = num(row.Losses);
  return Number.isFinite(wins) && Number.isFinite(losses) && (wins + losses) > 0 ? wins / (wins + losses) : NaN;
}

function last10WinPctFor(abbr) {
  const row = state.standings.get(abbr);
  if (!row) return NaN;
  const value = row.LastTenGamesWon ?? row.Last10Wins;
  const losses = row.LastTenGamesLost ?? row.Last10Losses;
  if (Number.isFinite(num(value)) && Number.isFinite(num(losses)) && (num(value) + num(losses)) > 0) {
    return num(value) / (num(value) + num(losses));
  }
  return NaN;
}

function simulateGame(game) {
  const awayAbbr = game.away.abbreviation;
  const homeAbbr = game.home.abbreviation;

  const away = buildTeamRating({
    isHome: false,
    teamStats: state.teamStats.get(awayAbbr),
    teamStatsLast10: state.teamStatsLast10.get(awayAbbr),
    playerStats: state.playerStats.get(awayAbbr) || [],
    injuries: state.injuries.get(awayAbbr) || [],
    leagueAverages: state.leagueAverages || {},
    restInfo: state.restInfo.get(awayAbbr) || {},
    seasonWinPct: winPctFor(awayAbbr),
    last10WinPct: last10WinPctFor(awayAbbr),
    weights: state.weights
  });
  const home = buildTeamRating({
    isHome: true,
    teamStats: state.teamStats.get(homeAbbr),
    teamStatsLast10: state.teamStatsLast10.get(homeAbbr),
    playerStats: state.playerStats.get(homeAbbr) || [],
    injuries: state.injuries.get(homeAbbr) || [],
    leagueAverages: state.leagueAverages || {},
    restInfo: state.restInfo.get(homeAbbr) || {},
    seasonWinPct: winPctFor(homeAbbr),
    last10WinPct: last10WinPctFor(homeAbbr),
    weights: state.weights
  });

  const leagueAvgPoints = state.leagueAverages?.pointsPerGame || 82;
  const awayInjuryFactor = injuryFactorFor(awayAbbr);
  const homeInjuryFactor = injuryFactorFor(homeAbbr);

  const awayExpectedRaw = expectedPointsV2({
    leagueAvgPoints, offenseMultiplier: away.offenseMultiplier, opponentDefenseMultiplier: home.defenseMultiplier,
    benchMultiplier: away.benchMultiplier, reboundingMultiplier: away.reboundingMultiplier,
    restTravelMultiplier: away.restTravelMultiplier, recentFormMultiplier: away.recentFormMultiplier,
    homeCourtFactor: away.homeCourtFactor, injuryFactor: awayInjuryFactor
  });
  const homeExpectedRaw = expectedPointsV2({
    leagueAvgPoints, offenseMultiplier: home.offenseMultiplier, opponentDefenseMultiplier: away.defenseMultiplier,
    benchMultiplier: home.benchMultiplier, reboundingMultiplier: home.reboundingMultiplier,
    restTravelMultiplier: home.restTravelMultiplier, recentFormMultiplier: home.recentFormMultiplier,
    homeCourtFactor: home.homeCourtFactor, injuryFactor: homeInjuryFactor
  });

  const marketAdjusted = applyMarketOdds(game, awayExpectedRaw, homeExpectedRaw);
  const odds = normalizedOdds(game);
  const marketTotal = Number.isFinite(odds?.total) ? odds.total : undefined;
  const marketSpread = Number.isFinite(odds?.spread) ? odds.spread : undefined;

  const simulation = runMonteCarloV2(marketAdjusted.awayExpected, marketAdjusted.homeExpected, marketTotal, marketSpread);

  return {
    ...simulation,
    awayComponents: away,
    homeComponents: home,
    awayInjuryFactor,
    homeInjuryFactor,
    awayExpected: marketAdjusted.awayExpected,
    homeExpected: marketAdjusted.homeExpected,
    oddsSource: marketAdjusted.source
  };
}

/** Simple star-availability-driven scoring penalty from the active
 * injuries feed - separate from the Bench Depth category's own
 * (season-average) star-availability sub-metric, this reacts to who is
 * OUT for *this specific date*. */
function injuryFactorFor(abbr) {
  const rows = state.injuries.get(abbr) || [];
  const outCount = rows.filter(r => /out|doubtful/i.test(r.InjuryStatus || r.Status || "")).length;
  return clamp(1 - outCount * 0.02, 0.85, 1);
}

function applyMarketOdds(game, awayExpected, homeExpected) {
  const odds = normalizedOdds(game);
  if (!odds || !Number.isFinite(odds.awayMoneyline) || !Number.isFinite(odds.homeMoneyline)) {
    return { awayExpected, homeExpected, source: "model" };
  }
  const noVig = noVigProbability(odds.awayMoneyline, odds.homeMoneyline);
  const modelTotal = awayExpected + homeExpected;
  const modelAwayShare = modelTotal ? awayExpected / modelTotal : 0.5;
  let awayShare = modelAwayShare;
  if (noVig) {
    awayShare = solveAwayShareForWinProbability(noVig.away, modelTotal, modelAwayShare);
  }
  const marketWeight = noVig ? 0.68 : 0;
  const blendedAwayShare = modelAwayShare * (1 - marketWeight) + awayShare * marketWeight;
  return {
    awayExpected: clamp(modelTotal * blendedAwayShare, 55, 115),
    homeExpected: clamp(modelTotal * (1 - blendedAwayShare), 55, 115),
    source: "sportsdata.io odds"
  };
}

function solveAwayShareForWinProbability(targetAwayProbability, total, fallbackShare) {
  let low = 0.30, high = 0.70;
  for (let i = 0; i < 28; i += 1) {
    const mid = (low + high) / 2;
    const awayProb = 1 - analyticHomeWinProbability(total * mid, total * (1 - mid));
    if (awayProb < targetAwayProbability) low = mid; else high = mid;
  }
  const solved = (low + high) / 2;
  return Number.isFinite(solved) ? solved : fallbackShare;
}

function noVigProbability(awayMoneyline, homeMoneyline) {
  const awayImplied = americanToProbability(awayMoneyline);
  const homeImplied = americanToProbability(homeMoneyline);
  if (awayImplied === null || homeImplied === null) return null;
  const total = awayImplied + homeImplied;
  if (!total) return null;
  return { away: awayImplied / total, home: homeImplied / total };
}

function runAllSimulations() {
  document.querySelectorAll(".game-card").forEach(card => {
    const btn = card.querySelector(".simulate-button");
    if (btn) btn.click();
  });
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function renderGames() {
  const container = document.getElementById("games");
  const template = document.getElementById("gameTemplate");
  container.innerHTML = "";

  state.games.forEach(game => {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".game-card");
    card.dataset.gameId = game.id;

    card.querySelector(".game-time").textContent = game.dateTime ? new Date(game.dateTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Time TBD";
    card.querySelector(".matchup").textContent = `${game.away.abbreviation} @ ${game.home.abbreviation}`;
    card.querySelector(".away-team h3").textContent = game.away.name;
    card.querySelector(".home-team h3").textContent = game.home.name;
    card.querySelector(".away-label").textContent = game.away.abbreviation;
    card.querySelector(".home-label").textContent = game.home.abbreviation;

    const odds = ensureOdds(game);
    card.querySelector(".away-ml-input").value = odds.awayMoneyline ?? "";
    card.querySelector(".home-ml-input").value = odds.homeMoneyline ?? "";

    bindOddsInputs(card, game);
    renderGameFactors(game, card);

    card.querySelector(".simulate-button").addEventListener("click", () => simulateAndRender(game, card));

    card.querySelectorAll(".rating-toggle").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.nextElementSibling;
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!expanded));
        target.hidden = expanded;
      });
    });

    container.appendChild(node);
  });
}

function bindOddsInputs(card, game) {
  card.querySelector(".away-ml-input").addEventListener("change", e => updateOdds(game, "awayMoneyline", e.target.value));
  card.querySelector(".home-ml-input").addEventListener("change", e => updateOdds(game, "homeMoneyline", e.target.value));
}

function updateOdds(game, field, value) {
  const odds = ensureOdds(game);
  const parsed = parseFloat(value);
  odds[field] = Number.isFinite(parsed) ? parsed : null;
  saveOdds();
}

function renderGameFactors(game, card) {
  const restAway = state.restInfo.get(game.away.abbreviation);
  const restHome = state.restInfo.get(game.home.abbreviation);
  const restLine = card.querySelector(".factor-line");
  const parts = [];
  if (restAway) parts.push(`${game.away.abbreviation}: ${restAway.isBackToBack ? "B2B" : `${restAway.daysRest}d rest`}`);
  if (restHome) parts.push(`${game.home.abbreviation}: ${restHome.isBackToBack ? "B2B" : `${restHome.daysRest}d rest`}`);
  if (restLine) restLine.textContent = parts.length ? parts.join(" \u00b7 ") : "Rest/travel data loading...";

  const oddsLine = card.querySelector(".odds-line");
  const odds = ensureOdds(game);
  if (oddsLine) {
    oddsLine.textContent = Number.isFinite(odds.awayMoneyline) && Number.isFinite(odds.homeMoneyline)
      ? `Moneyline ${game.away.abbreviation} ${odds.awayMoneyline > 0 ? "+" : ""}${odds.awayMoneyline} / ${game.home.abbreviation} ${odds.homeMoneyline > 0 ? "+" : ""}${odds.homeMoneyline}`
      : "Moneyline odds unavailable - enter manually below.";
  }

  const weatherLine = card.querySelector(".weather-line");
  if (weatherLine) weatherLine.textContent = "Indoor league - no weather factor.";
}

function simulateAndRender(game, card) {
  const result = simulateGame(game);
  state.simResults.set(game.id, result);

  card.querySelector(".sim-details").hidden = false;
  card.querySelector(".average-score").textContent = `${game.away.abbreviation} ${result.awayAveragePoints.toFixed(1)} - ${game.home.abbreviation} ${result.homeAveragePoints.toFixed(1)}`;

  const awayPct = Math.round(result.awayWinProbability * 100);
  const homePct = 100 - awayPct;
  card.querySelector(".away-prob").textContent = `${awayPct}%`;
  card.querySelector(".home-prob").textContent = `${homePct}%`;
  card.querySelector(".away-bar").style.width = `${awayPct}%`;
  card.querySelector(".home-bar").style.width = `${homePct}%`;

  renderSimDetails(card, game, result);
  renderBettingValue(card, game, result);
  renderInjuryImpact(card, game, result);
  renderRatingBreakdown(card, game, result);
}

function renderSimDetails(card, game, result) {
  card.querySelector(".expected-total-runs").textContent = result.expectedTotalPoints.toFixed(1);
  card.querySelector(".run-line-summary").textContent =
    `${game.home.abbreviation} ${result.spread.line >= 0 ? "+" : ""}${result.spread.line.toFixed(1)}: ${(result.spread.homeCoverProbability * 100).toFixed(0)}% / ${game.away.abbreviation}: ${(result.spread.awayCoverProbability * 100).toFixed(0)}%`;
  card.querySelector(".total-summary").textContent =
    `${result.total.line.toFixed(1)}: Over ${(result.total.overProbability * 100).toFixed(0)}% / Under ${(result.total.underProbability * 100).toFixed(0)}%`;
  card.querySelector(".common-scores").textContent = result.mostCommonScores
    .map(s => `${s.score} (${(s.probability * 100).toFixed(1)}%)`)
    .join(", ");
}

function renderBettingValue(card, game, result) {
  const odds = ensureOdds(game);
  const awayCompleteness = averageCompleteness(result.awayComponents.breakdown);
  const homeCompleteness = averageCompleteness(result.homeComponents.breakdown);

  const awayValue = Number.isFinite(odds.awayMoneyline)
    ? computeBettingValue({ modelProbability: result.awayWinProbability, americanOdds: odds.awayMoneyline, dataCompleteness: awayCompleteness })
    : null;
  const homeValue = Number.isFinite(odds.homeMoneyline)
    ? computeBettingValue({ modelProbability: result.homeWinProbability, americanOdds: odds.homeMoneyline, dataCompleteness: homeCompleteness })
    : null;

  card.querySelector(".away-team-betting-value").innerHTML = awayValue ? bettingValueHtml(game.away.abbreviation, awayValue) : "";
  card.querySelector(".home-team-betting-value").innerHTML = homeValue ? bettingValueHtml(game.home.abbreviation, homeValue) : "";
}

function bettingValueHtml(label, value) {
  return `<span class="edge-badge edge-${value.color}">${label}: edge ${formatSignedPercent(1 + value.edge)}, ${value.recommendedBet}, EV $${value.expectedValuePer100.toFixed(0)}/100, confidence ${value.confidence}/10</span>`;
}

function averageCompleteness(breakdown) {
  const values = Object.values(breakdown).map(c => c.dataCompleteness).filter(Number.isFinite);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0.5;
}

function renderInjuryImpact(card, game, result) {
  const el = card.querySelector(".injury-impact");
  const awayOut = (state.injuries.get(game.away.abbreviation) || []).filter(r => /out|doubtful/i.test(r.InjuryStatus || r.Status || ""));
  const homeOut = (state.injuries.get(game.home.abbreviation) || []).filter(r => /out|doubtful/i.test(r.InjuryStatus || r.Status || ""));
  if (!awayOut.length && !homeOut.length) { el.hidden = true; return; }
  el.hidden = false;
  const line = (abbr, list) => list.length ? `${abbr}: ${list.map(r => r.Name || r.PlayerName).join(", ")} (out/doubtful)` : "";
  el.textContent = [line(game.away.abbreviation, awayOut), line(game.home.abbreviation, homeOut)].filter(Boolean).join(" \u00b7 ");
}

function renderRatingBreakdown(card, game, result) {
  card.querySelector(".away-rating-breakdown").innerHTML = ratingBreakdownHtml(result.awayComponents);
  card.querySelector(".home-rating-breakdown").innerHTML = ratingBreakdownHtml(result.homeComponents);
}

function ratingBreakdownHtml(components) {
  const b = components.breakdown;
  const line = (label, entry, digits = 3) => {
    if (!entry || !entry.available) return `<div class="rating-line"><span>${label}</span><span class="na">N/A</span></div>`;
    const value = typeof entry.value === "number" ? entry.value.toFixed(digits) : String(entry.value);
    return `<div class="rating-line"><span>${label}</span><span>${value}</span></div>`;
  };
  return `
    <div class="rating-section"><strong>Offensive Rating - ${formatSignedPercent(components.offenseMultiplier)}</strong>
      ${line("ORtg (pts/100 poss)", b.offense.components.offensiveRating, 1)}
      ${line("eFG%", b.offense.components.effectiveFgPct)}
      ${line("FT Rate", b.offense.components.freeThrowRate)}
      ${line("3PT Rate", b.offense.components.threePointRate)}
      ${line("AST%", b.offense.components.assistPct)}
    </div>
    <div class="rating-section"><strong>Defensive Rating - ${formatSignedPercent(components.defenseMultiplier)}</strong>
      ${line("DRtg allowed", b.defense.components.defensiveRating, 1)}
      ${line("Opp eFG%", b.defense.components.opponentEffectiveFgPct)}
      ${line("Steals/100", b.defense.components.stealsPer100, 1)}
      ${line("Blocks/100", b.defense.components.blocksPer100, 1)}
    </div>
    <div class="rating-section"><strong>Bench Depth - ${formatSignedPercent(components.benchMultiplier)}</strong>
      ${line("Bench PPG", b.bench.components.benchPointsPerGame, 1)}
      ${line("Top-3 Minutes Share", b.bench.components.minutesConcentration)}
      ${line("Star Availability", b.bench.components.starAvailability)}
    </div>
    <div class="rating-section"><strong>Rebounding &amp; Ball Control - ${formatSignedPercent(components.reboundingMultiplier)}</strong>
      ${line("OREB/gm", b.rebounding.components.offensiveReboundsPerGame, 1)}
      ${line("DREB/gm", b.rebounding.components.defensiveReboundsPerGame, 1)}
      ${line("TOV%", b.rebounding.components.turnoverPct)}
      ${line("AST/TOV", b.rebounding.components.assistToTurnover, 2)}
    </div>
    <div class="rating-section"><strong>Rest &amp; Travel - ${formatSignedPercent(components.restTravelMultiplier)}</strong>
      ${line("Days Rest", b.rest.components.daysRest, 0)}
      <div class="rating-line"><span>Back-to-back</span><span>${b.rest.components.isBackToBack.value ? "Yes" : "No"}</span></div>
    </div>
    <div class="rating-section"><strong>Recent Form - ${formatSignedPercent(components.recentFormMultiplier)}</strong>
      ${line("Season Win%", b.form.components.seasonWinPct)}
      ${line("Last-10 Win%", b.form.components.last10WinPct)}
    </div>
    <div class="rating-section"><strong>Home Court - ${formatSignedPercent(components.homeCourtFactor)}</strong></div>
  `;
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return "N/A";
  const pct = (value - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function renderDataSourceStatus() {
  const el = document.getElementById("dataSourceStatus");
  if (!el) return;
  const lines = Object.entries(sportsDataStatus).map(([key, status]) => `${key}: ${status.available ? "OK" : `unavailable (${status.reason})`}`);
  el.textContent = lines.join(" \u00b7 ");
}

// ---------------------------------------------------------------------
// Weights panel
// ---------------------------------------------------------------------

function initWeightsPanel() {
  const toggle = document.getElementById("weightsToggle");
  const body = document.getElementById("weightsBody");
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    body.hidden = expanded;
  });
  renderWeightsGrid();
  document.getElementById("saveWeightsButton").addEventListener("click", () => {
    const grid = document.getElementById("weightsGrid");
    const inputs = grid.querySelectorAll("input[data-weight-key]");
    const updated = {};
    inputs.forEach(input => { updated[input.dataset.weightKey] = parseFloat(input.value) / 100; });
    state.weights = saveWeights(updated);
    renderWeightsGrid();
    setStatus("Weights saved.", "ok");
  });
  document.getElementById("resetWeightsButton").addEventListener("click", () => {
    state.weights = saveWeights(DEFAULT_WEIGHTS);
    renderWeightsGrid();
    setStatus("Weights reset to defaults.", "ok");
  });
}

const WEIGHT_LABELS = {
  offensiveRating: "Offensive Rating",
  defensiveRating: "Defensive Rating",
  benchDepth: "Bench Depth & Star Availability",
  reboundingBallControl: "Rebounding & Ball Control",
  restTravel: "Rest & Travel",
  recentForm: "Recent Form",
  homeCourtAdvantage: "Home Court Advantage"
};

function renderWeightsGrid() {
  const grid = document.getElementById("weightsGrid");
  grid.innerHTML = Object.entries(state.weights).map(([key, value]) => `
    <label class="weight-row">
      ${WEIGHT_LABELS[key] || key}
      <input type="number" min="0" max="100" step="0.5" value="${(value * 100).toFixed(1)}" data-weight-key="${key}">%
    </label>
  `).join("");
}

// ---------------------------------------------------------------------
// Backtest + optimizer panels
// ---------------------------------------------------------------------

function isValidDate(date) {
  return date instanceof Date && !isNaN(date);
}

function initBacktestPanel() {
  const toggle = document.getElementById("backtestToggle");
  const body = document.getElementById("backtestBody");
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    body.hidden = expanded;
  });

  const today = formatApiDate(new Date());
  const twoWeeksAgo = formatApiDate(addDays(new Date(), -14));
  document.getElementById("backtestStart").value = twoWeeksAgo;
  document.getElementById("backtestEnd").value = today;

  document.getElementById("runBacktestButton").addEventListener("click", async () => {
    const start = new Date(document.getElementById("backtestStart").value);
    const end = new Date(document.getElementById("backtestEnd").value);
    if (!isValidDate(start) || !isValidDate(end) || start > end) {
      document.getElementById("backtestStatus").textContent = "Pick a valid start/end date range.";
      return;
    }
    setBusy(true);
    const statusEl = document.getElementById("backtestStatus");
    try {
      const result = await runBacktest({ startDate: start, endDate: end, onProgress: msg => { statusEl.textContent = msg; } });
      renderBacktestResults(result);
    } catch (err) {
      statusEl.textContent = `Backtest failed: ${err.message}`;
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("runOptimizerButton").addEventListener("click", async () => {
    const start = new Date(document.getElementById("backtestStart").value);
    const end = new Date(document.getElementById("backtestEnd").value);
    const target = document.getElementById("optimizerTarget").value;
    const iterations = parseInt(document.getElementById("optimizerIterations").value, 10) || 150;
    if (!isValidDate(start) || !isValidDate(end) || start > end) {
      document.getElementById("optimizerStatus").textContent = "Pick a valid start/end date range.";
      return;
    }
    setBusy(true);
    const statusEl = document.getElementById("optimizerStatus");
    try {
      const result = await optimizeWeights({ startDate: start, endDate: end, target, iterations, onProgress: msg => { statusEl.textContent = msg; } });
      renderOptimizerResults(result);
    } catch (err) {
      statusEl.textContent = `Optimization failed: ${err.message}`;
    } finally {
      setBusy(false);
    }
  });
}

function renderBacktestResults(result) {
  const el = document.getElementById("backtestResults");
  if (!result || !result.gamesTested) {
    el.hidden = false;
    el.textContent = result?.reason || "No games found for that range.";
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <div class="backtest-summary">
      <div>Games tested: <strong>${result.gamesTested}</strong></div>
      <div>Point-in-time coverage: <strong>${(result.pointInTimeCoverage * 100).toFixed(0)}%</strong></div>
      <div>Win pick accuracy: <strong>${(result.winPct * 100).toFixed(1)}%</strong></div>
      <div>Log loss: <strong>${result.logLoss.toFixed(3)}</strong></div>
      <div>Brier score: <strong>${result.brierScore.toFixed(3)}</strong></div>
      <div>ROI (flat $100 bets on positive-EV picks): <strong>${result.roi === null ? "N/A" : result.roi.toFixed(1) + "%"}</strong> (${result.betsPlaced} bets)</div>
    </div>
  `;
}

function renderOptimizerResults(result) {
  const el = document.getElementById("optimizerResults");
  if (!result?.success) {
    el.hidden = false;
    el.textContent = result?.reason || "Optimization failed.";
    return;
  }
  el.hidden = false;
  const rows = Object.keys(result.baselineWeights).map(key => `
    <tr><td>${WEIGHT_LABELS[key] || key}</td><td>${(result.baselineWeights[key] * 100).toFixed(1)}%</td><td>${(result.optimizedWeights[key] * 100).toFixed(1)}%</td></tr>
  `).join("");
  el.innerHTML = `
    <p>Holdout ${result.targetLabel}: baseline ${OPTIMIZATION_TARGETS[result.target].read(result.baselineScore).toFixed(3)} vs optimized ${OPTIMIZATION_TARGETS[result.target].read(result.optimizedScore).toFixed(3)} (${result.holdoutImproved ? "improved" : "did not improve"} on held-out games)</p>
    <table class="breakdown-table"><tr><th>Category</th><th>Baseline</th><th>Optimized</th></tr>${rows}</table>
    <button type="button" id="applyOptimizedWeightsButton">Save optimized weights as default</button>
  `;
  document.getElementById("applyOptimizedWeightsButton").addEventListener("click", () => {
    state.weights = applyOptimizedWeights(result);
    renderWeightsGrid();
    setStatus("Optimized weights saved as default.", "ok");
  });
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const dateInput = document.getElementById("gameDateInput");
  dateInput.value = formatApiDate(state.selectedDate);
  document.getElementById("dateLabel").textContent = state.selectedDate.toDateString();

  dateInput.addEventListener("change", () => {
    state.selectedDate = new Date(dateInput.value + "T12:00:00");
    document.getElementById("dateLabel").textContent = state.selectedDate.toDateString();
    loadSchedule();
  });

  document.getElementById("refreshButton").addEventListener("click", loadSchedule);
  document.getElementById("runAllButton").addEventListener("click", runAllSimulations);

  initWeightsPanel();
  initBacktestPanel();
  loadSchedule();
});
