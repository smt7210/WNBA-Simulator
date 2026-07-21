/**
 * odds-api-client.js
 * Client for The Odds API (https://the-odds-api.com), used for betting
 * odds (moneyline, spread, total) league-wide. Replaces SportsData.io's
 * /odds endpoint - SportsData.io (sportsdata-client.js) still supplies
 * schedule/scores, team & player stats, standings, and injuries.
 *
 * The Odds API's non-historical `/sports/{sport}/odds` endpoint returns
 * every upcoming/live event across the whole slate in one call (no
 * per-date filtering param), so fetchOddsApiOdds() pulls everything and
 * the caller filters/matches by date + team locally. This also keeps
 * request usage low against the free tier's 500 requests/month.
 *
 * NOTE ON TEAM NAMES: The Odds API identifies teams by full name (e.g.
 * "Las Vegas Aces"), while SportsData.io's game rows key off abbreviation
 * codes (e.g. "LVA"). ODDS_API_TEAM_ALIASES below maps every WNBA
 * franchise's full name, city, and nickname to the abbreviation this app
 * uses elsewhere, so matching works regardless of which form either API
 * happens to hand back. If a franchise is missing/renamed (expansion,
 * relocation), matching for that team falls back to "unavailable" rather
 * than guessing - same defensiveness philosophy as sportsdata-client.js.
 */

const oddsApiStatus = {
  odds: { available: false, reason: "Not yet loaded" }
};

// Covers the 2026 15-team league (includes the Portland Fire and Toronto
// Tempo expansion teams). Update here if the league expands/relocates
// again - this app doesn't infer team identity from anywhere else.
const ODDS_API_TEAM_ALIASES = [
  { abbr: "ATL", names: ["Atlanta Dream", "Atlanta", "Dream"] },
  { abbr: "CHI", names: ["Chicago Sky", "Chicago", "Sky"] },
  { abbr: "CONN", names: ["Connecticut Sun", "Connecticut", "Sun"] },
  { abbr: "DAL", names: ["Dallas Wings", "Dallas", "Wings"] },
  { abbr: "GSV", names: ["Golden State Valkyries", "Golden State", "Valkyries"] },
  { abbr: "IND", names: ["Indiana Fever", "Indiana", "Fever"] },
  { abbr: "LVA", names: ["Las Vegas Aces", "Las Vegas", "Aces"] },
  { abbr: "LA", names: ["Los Angeles Sparks", "Los Angeles", "Sparks"] },
  { abbr: "MIN", names: ["Minnesota Lynx", "Minnesota", "Lynx"] },
  { abbr: "NY", names: ["New York Liberty", "New York", "Liberty"] },
  { abbr: "PHX", names: ["Phoenix Mercury", "Phoenix", "Mercury"] },
  { abbr: "POR", names: ["Portland Fire", "Portland", "Fire"] },
  { abbr: "SEA", names: ["Seattle Storm", "Seattle", "Storm"] },
  { abbr: "TOR", names: ["Toronto Tempo", "Toronto", "Tempo"] },
  { abbr: "WAS", names: ["Washington Mystics", "Washington", "Mystics"] }
];

function oddsApiAliasKey(value) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolves any team string (SportsData abbreviation, The Odds API full
 * name, city, or nickname) to this app's canonical abbreviation, so the
 * two APIs' team identifiers can be matched against each other. Returns
 * null if nothing matches rather than guessing.
 */
function resolveTeamAbbr(value) {
  const key = oddsApiAliasKey(value);
  if (!key) return null;
  for (const team of ODDS_API_TEAM_ALIASES) {
    if (oddsApiAliasKey(team.abbr) === key) return team.abbr;
    if (team.names.some(name => oddsApiAliasKey(name) === key)) return team.abbr;
  }
  return null;
}

function americanPrice(outcome) {
  const price = outcome?.price;
  return typeof price === "number" && Number.isFinite(price) ? price : NaN;
}

/** Picks one bookmaker's odds for an event, preferring the books listed
 * in ODDS_API_PREFERRED_BOOKMAKERS, falling back to the first available. */
function pickBookmaker(event) {
  const books = event.bookmakers || [];
  if (!books.length) return null;
  for (const preferred of ODDS_API_PREFERRED_BOOKMAKERS) {
    const match = books.find(b => b.key === preferred);
    if (match) return match;
  }
  return books[0];
}

function marketOutcomes(bookmaker, marketKey) {
  const market = (bookmaker?.markets || []).find(m => m.key === marketKey);
  return market?.outcomes || [];
}

/**
 * Fetches every upcoming/live WNBA event with odds, transformed into rows
 * shaped like { AwayTeam, HomeTeam, AwayTeamMoneyLine, HomeTeamMoneyLine,
 * OverUnder, PointSpread, commenceTime } - AwayTeam/HomeTeam are resolved
 * to this app's abbreviation via resolveTeamAbbr() (falling back to The
 * Odds API's raw team name string if no alias matches, so callers can
 * still see what came back even if matching fails). Callers filter by
 * date themselves since this endpoint doesn't take a date param.
 */
async function fetchOddsApiOdds() {
  try {
    const url = `${ODDS_API_BASE}/sports/${ODDS_API_SPORT_KEY}/odds/` +
      `?apiKey=${ODDS_API_KEY}&regions=${ODDS_API_REGIONS}&markets=${ODDS_API_MARKETS}` +
      `&oddsFormat=american&dateFormat=iso`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`The Odds API returned ${response.status}`);
    }
    const events = await response.json();
    const rows = (events || []).map(event => {
      const bookmaker = pickBookmaker(event);
      const h2h = marketOutcomes(bookmaker, "h2h");
      const spreads = marketOutcomes(bookmaker, "spreads");
      const totals = marketOutcomes(bookmaker, "totals");

      const awayAbbr = resolveTeamAbbr(event.away_team) || event.away_team;
      const homeAbbr = resolveTeamAbbr(event.home_team) || event.home_team;

      const awayMoneyline = americanPrice(h2h.find(o => resolveTeamAbbr(o.name) === resolveTeamAbbr(event.away_team) || o.name === event.away_team));
      const homeMoneyline = americanPrice(h2h.find(o => resolveTeamAbbr(o.name) === resolveTeamAbbr(event.home_team) || o.name === event.home_team));

      const homeSpreadOutcome = spreads.find(o => resolveTeamAbbr(o.name) === resolveTeamAbbr(event.home_team) || o.name === event.home_team);
      const pointSpread = typeof homeSpreadOutcome?.point === "number" ? homeSpreadOutcome.point : NaN;

      const overOutcome = totals.find(o => (o.name || "").toLowerCase() === "over");
      const overUnder = typeof overOutcome?.point === "number" ? overOutcome.point : NaN;

      return {
        AwayTeam: awayAbbr,
        HomeTeam: homeAbbr,
        AwayTeamMoneyLine: awayMoneyline,
        HomeTeamMoneyLine: homeMoneyline,
        PointSpread: pointSpread,
        OverUnder: overUnder,
        commenceTime: event.commence_time,
        bookmakerKey: bookmaker?.key ?? null
      };
    });
    oddsApiStatus.odds = { available: true, reason: null };
    return rows;
  } catch (err) {
    oddsApiStatus.odds = { available: false, reason: err.message };
    return [];
  }
}

/**
 * Filters fetchOddsApiOdds() rows down to a single calendar date. Compares
 * against the event's commence_time in both UTC and the browser's local
 * timezone, since a late-evening US tipoff can fall on different calendar
 * dates depending on which one The Odds API's iso timestamp is read as.
 */
function filterOddsApiRowsByDate(rows, date) {
  const targetLocal = formatApiDate(date);
  const targetUtc = new Date(date).toISOString().slice(0, 10);
  return rows.filter(row => {
    if (!row.commenceTime) return true; // keep undated rows rather than dropping them
    const commence = new Date(row.commenceTime);
    const localDate = formatApiDate(commence);
    const utcDate = commence.toISOString().slice(0, 10);
    return localDate === targetLocal || utcDate === targetLocal || utcDate === targetUtc;
  });
}

/**
 * The Odds API's historical odds (`/historical/sports/{sport}/odds`) require
 * a paid plan tier and cost 10x the request quota of live odds - this is a
 * best-effort call for the backtest panel. On any failure (wrong plan, rate
 * limit, date out of the plan's retention window) it returns null so the
 * caller can fall back to SportsData.io's historical odds instead, which is
 * what backtest.js does.
 */
async function fetchOddsApiHistoricalOdds(date) {
  try {
    const dateStr = new Date(date).toISOString();
    const url = `${ODDS_API_BASE}/historical/sports/${ODDS_API_SPORT_KEY}/odds/` +
      `?apiKey=${ODDS_API_KEY}&regions=${ODDS_API_REGIONS}&markets=${ODDS_API_MARKETS}` +
      `&oddsFormat=american&dateFormat=iso&date=${dateStr}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`The Odds API historical odds returned ${response.status}`);
    }
    const payload = await response.json();
    const events = payload?.data || [];
    return events.map(event => {
      const bookmaker = pickBookmaker(event);
      const h2h = marketOutcomes(bookmaker, "h2h");
      return {
        AwayTeam: resolveTeamAbbr(event.away_team) || event.away_team,
        HomeTeam: resolveTeamAbbr(event.home_team) || event.home_team,
        AwayTeamMoneyLine: americanPrice(h2h.find(o => o.name === event.away_team)),
        HomeTeamMoneyLine: americanPrice(h2h.find(o => o.name === event.home_team))
      };
    });
  } catch {
    return null;
  }
}
