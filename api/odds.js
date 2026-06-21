// api/odds.js — Proxy Vercel (Node serverless) — MODÈLE MAISON pour le foot.
//
//  • FOOT : The Odds API sert UNIQUEMENT à savoir quels matchs ont lieu (endpoint /events, GRATUIT,
//           0 crédit) et à récupérer le score en direct (endpoint /scores, 1 crédit, jour même).
//           TOUTES les probabilités de paris sont calculées par NOTRE modèle de Poisson, à partir de
//           notes de force par équipe (TEAM_STRENGTH ci-dessous). Ce ne sont donc PAS des cotes de
//           bookmaker : chaque marché foot est marqué { est:true } -> l'app l'affiche comme une
//           « estimation Aléa », jamais comme une cote réelle. (Honnêteté : ces chiffres valent ce
//           que valent nos notes de force ; ils sont éditables ci-dessous.)
//  • TENNIS : inchangé, vraies cotes via The Odds API (endpoint /odds, marchés h2h + totals).
//
//  Paris JOUEUR (buteur, tirs…) : IMPOSSIBLES — aucune donnée par joueur. On ne les invente pas.
//
//  Sortie (format identique pour ne rien casser dans index.html) :
//    { "Compétition": [ { id, home, away, time, date, offset,
//                         markets:[ {type, sels:[...], odds:[...], raw:true, est?:true} ],
//                         score?:{home,away}, completed? } ] }

const ODDS_BASE = "https://api.the-odds-api.com/v4";

const FOOT_COMPS = [
  { key: "soccer_fifa_world_cup",     comp: "Coupe du Monde 2026" },
  { key: "soccer_france_ligue_one",   comp: "Ligue 1" },
  { key: "soccer_uefa_champs_league", comp: "Ligue des Champions" },
];

// Hôtes 2026 (léger avantage quand ils "reçoivent")
const HOSTS_2026 = new Set(["USA", "United States", "Mexico", "Canada"]);

// Notes de force (≈ niveau international, 50 = faible … 95 = élite mondiale).
// ÉDITABLE : ajuste librement. Toute équipe absente prend DEFAULT_STRENGTH.
const DEFAULT_STRENGTH = 66;
const TEAM_STRENGTH = {
  // Élite
  "France": 92, "Argentina": 92, "Spain": 91, "England": 89, "Brazil": 89,
  "Portugal": 88, "Netherlands": 87, "Germany": 87,
  // Très solides
  "Belgium": 85, "Italy": 84, "Croatia": 83, "Uruguay": 83, "Morocco": 83,
  "Colombia": 82, "Switzerland": 81, "Denmark": 81, "USA": 80, "Mexico": 80,
  "Japan": 80, "Senegal": 80,
  // Solides / moyens +
  "Serbia": 79, "Ecuador": 78, "Sweden": 78, "Korea Republic": 78, "South Korea": 78,
  "Austria": 78, "Ukraine": 77, "Poland": 77, "Australia": 76, "Wales": 76,
  "Turkey": 76, "Nigeria": 76, "Ivory Coast": 76, "Peru": 75, "Chile": 75,
  "Cameroon": 75, "Ghana": 74, "Egypt": 74, "Algeria": 74, "Tunisia": 73,
  "Norway": 78, "Hungary": 74, "Czech Republic": 75, "Greece": 74, "Scotland": 75,
  "Romania": 73, "Slovakia": 73, "Slovenia": 73,
  // Moyens
  "Canada": 73, "Qatar": 72, "Iran": 74, "Costa Rica": 72, "Paraguay": 72,
  "Saudi Arabia": 71, "Iraq": 70, "Jordan": 69, "UAE": 69, "Panama": 70,
  "Jamaica": 70, "Venezuela": 71, "Bolivia": 68, "Honduras": 68, "South Africa": 72,
  "Mali": 73, "Burkina Faso": 72, "DR Congo": 72, "Cape Verde": 70, "Uzbekistan": 71,
  "New Zealand": 68, "Oman": 67, "Bahrain": 65,
  // Plus faibles
  "Curaçao": 62, "Curacao": 62, "Haiti": 63, "Trinidad and Tobago": 63,
  "Guatemala": 63, "El Salvador": 62, "Suriname": 63, "New Caledonia": 55,
  "Tahiti": 52, "Fiji": 55, "Gibraltar": 50, "San Marino": 50,
};
function strengthOf(name) {
  if (name in TEAM_STRENGTH) return TEAM_STRENGTH[name];
  // tolérance accents/casse
  const norm = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const k in TEAM_STRENGTH) {
    if (k.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === norm) return TEAM_STRENGTH[k];
  }
  return DEFAULT_STRENGTH;
}

/* ---------------- Modèle de Poisson ---------------- */

const AVG_GOALS = 1.35;   // buts moyens par équipe / match (référence internationale)
const REF = 75;           // note "moyenne" : une équipe à 75 ≈ multiplicateur 1
const MAXG = 8;           // buts max considérés par équipe
const FACT = [1,1,2,6,24,120,720,5040,40320,362880];

function poisson(k, lambda) { return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k]; }

// Buts attendus de chaque équipe à partir des notes de force.
function expectedGoals(home, away) {
  const sh = strengthOf(home), sa = strengthOf(away);
  const aH = sh / REF, dH = REF / sh;     // attaque / défense (multiplicateurs)
  const aA = sa / REF, dA = REF / sa;
  const hostAdv = HOSTS_2026.has(home) ? 1.08 : 1.0;
  let lh = AVG_GOALS * aH * dA * hostAdv;
  let la = AVG_GOALS * aA * dH;
  // bornes raisonnables
  lh = Math.min(Math.max(lh, 0.18), 4.2);
  la = Math.min(Math.max(la, 0.18), 4.2);
  return { lh, la };
}

function scoreMatrix(lh, la) {
  const M = [];
  for (let i = 0; i <= MAXG; i++) { M[i] = []; for (let j = 0; j <= MAXG; j++) M[i][j] = poisson(i, lh) * poisson(j, la); }
  return M;
}

function toOdd(p) { if (p <= 0) return 999; return Math.min(Math.max(Math.round((1 / p) * 100) / 100, 1.02), 999); }

// Construit tous les marchés dérivés du modèle pour un match.
function modelMarkets(home, away) {
  const { lh, la } = expectedGoals(home, away);
  const M = scoreMatrix(lh, la);
  let pH = 0, pD = 0, pA = 0, bttsY = 0;
  const totalAtLeast = {}; // buts totaux
  let oddTotal = 0, evenTotal = 0;
  let homeGoals0 = 0, homeGoals1 = 0, awayGoals0 = 0, awayGoals1 = 0;
  let bestS = { p: -1, i: 0, j: 0 };
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const p = M[i][j];
    if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
    if (i >= 1 && j >= 1) bttsY += p;
    const tot = i + j;
    totalAtLeast[tot] = (totalAtLeast[tot] || 0) + p;
    if (tot % 2 === 0) evenTotal += p; else oddTotal += p;
    if (i === 0) awayGoals0 += 0; // placeholder
    if (p > bestS.p) bestS = { p, i, j };
  }
  // marges par équipe
  for (let i = 0; i <= MAXG; i++) { const ph = poisson(i, lh), pa = poisson(i, la);
    if (i === 0) { homeGoals0 += ph; awayGoals0 += pa; }
    if (i <= 1) { homeGoals1 += ph; awayGoals1 += pa; } }

  // P(total > ligne)
  const overOf = (line) => { let s = 0; for (const t in totalAtLeast) if (Number(t) > line) s += totalAtLeast[t]; return s; };

  const out = [];
  const est = true, raw = true;

  // 1X2
  out.push({ type: "1X2", sels: [home, "Match nul", away], odds: [toOdd(pH), toOdd(pD), toOdd(pA)], raw, est });
  // Double chance
  out.push({ type: "Double chance", sels: [`${home} ou nul`, `${home} ou ${away}`, `nul ou ${away}`], odds: [toOdd(pH + pD), toOdd(pH + pA), toOdd(pD + pA)], raw, est });
  // Totaux (plusieurs lignes)
  for (const line of [1.5, 2.5, 3.5]) { const o = overOf(line); out.push({ type: "Total buts", sels: [`+${line} buts`, `-${line} buts`], odds: [toOdd(o), toOdd(1 - o)], raw, est }); }
  // BTTS
  out.push({ type: "Les deux équipes marquent (BTTS)", sels: ["Les deux équipes marquent", "Pas les deux"], odds: [toOdd(bttsY), toOdd(1 - bttsY)], raw, est });
  // Pair / impair
  out.push({ type: "Nombre de buts pair / impair", sels: ["Nombre de buts pair", "Nombre de buts impair"], odds: [toOdd(evenTotal), toOdd(oddTotal)], raw, est });
  // Buts par équipe (over/under 1.5)
  out.push({ type: `Buts de ${home}`, sels: [`${home} marque +1.5`, `${home} marque -1.5`], odds: [toOdd(1 - homeGoals1), toOdd(homeGoals1)], raw, est });
  out.push({ type: `Buts de ${away}`, sels: [`${away} marque +1.5`, `${away} marque -1.5`], odds: [toOdd(1 - awayGoals1), toOdd(awayGoals1)], raw, est });
  // Une équipe garde sa cage inviolée
  out.push({ type: "Clean sheet", sels: [`${home} encaisse 0`, `${away} encaisse 0`], odds: [toOdd(awayGoals0), toOdd(homeGoals0)], raw, est });

  // Mi-temps (≈45% des buts en 1re période, indépendance supposée)
  const lh1 = lh * 0.45, la1 = la * 0.45;
  const H = scoreMatrix(lh1, la1);
  let h1H = 0, h1D = 0, h1A = 0, h1Over05 = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) { const p = H[i][j];
    if (i > j) h1H += p; else if (i === j) h1D += p; else h1A += p; if (i + j >= 1) h1Over05 += p; }
  out.push({ type: "Résultat à la mi-temps", sels: [home, "Match nul", away], odds: [toOdd(h1H), toOdd(h1D), toOdd(h1A)], raw, est });
  out.push({ type: "Plus ou moins de buts en première mi-temps", sels: ["+0.5 but (1re MT)", "-0.5 but (1re MT)"], odds: [toOdd(h1Over05), toOdd(1 - h1Over05)], raw, est });

  // Score exact le plus probable (pari "fun")
  out.push({ type: "Score exact", sels: [`${bestS.i}-${bestS.j}`], odds: [toOdd(bestS.p)], raw, est });

  return out;
}

/* ---------------- Dates (Europe/Paris) ---------------- */

function parisDateKeyFromISO(iso) { return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)); }
function parisTime(iso) { return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
function parisDateKeyOffset(day) { const now = new Date(); const d = new Date(now.getTime() + (Number(day) || 0) * 864e5); return parisDateKeyFromISO(d.toISOString()); }

/* ---------------- FOOT : fixtures (gratuit) + scores + modèle ---------------- */

async function fetchEvents(key, apiKey) {
  try { const r = await fetch(`${ODDS_BASE}/sports/${key}/events?apiKey=${apiKey}&dateFormat=iso`); if (!r.ok) return []; return await r.json(); }
  catch (_) { return []; }
}
async function fetchScores(key, apiKey) {
  try { const r = await fetch(`${ODDS_BASE}/sports/${key}/scores/?apiKey=${apiKey}&dateFormat=iso`); if (!r.ok) return []; return await r.json(); }
  catch (_) { return []; }
}
function attachScores(matches, scoreEvents) {
  if (!scoreEvents || !scoreEvents.length) return;
  const byId = new Map(scoreEvents.map(s => [s.id, s]));
  for (const m of matches) { const s = byId.get(m.id); if (!s || !s.scores) continue;
    const hs = s.scores.find(x => x.name === m.home), as = s.scores.find(x => x.name === m.away);
    if (hs && as) { m.score = { home: Number(hs.score), away: Number(as.score) }; m.completed = !!s.completed; } }
}

async function loadFoot(apiKey, day) {
  const wantKey = parisDateKeyOffset(day);
  const result = {};
  for (const { key, comp } of FOOT_COMPS) {
    const events = await fetchEvents(key, apiKey);   // 0 crédit
    if (!events.length) continue;
    const matches = [];
    for (const ev of events) {
      if (!ev.commence_time || parisDateKeyFromISO(ev.commence_time) !== wantKey) continue;
      const home = ev.home_team, away = ev.away_team;
      if (!home || !away) continue;
      matches.push({ id: ev.id, home, away, time: parisTime(ev.commence_time), date: parisDateKeyFromISO(ev.commence_time), offset: day, markets: modelMarkets(home, away) });
    }
    if (!matches.length) continue;
    if (day === 0) attachScores(matches, await fetchScores(key, apiKey)); // 1 crédit
    result[comp] = matches;
  }
  return result;
}

/* ---------------- TENNIS : vraies cotes (inchangé) ---------------- */

async function discoverTennisTargets(apiKey) {
  try { const r = await fetch(`${ODDS_BASE}/sports/?apiKey=${apiKey}`); if (!r.ok) return [];
    const sports = await r.json();
    return sports.filter(s => s.key && s.key.startsWith("tennis_atp_") && s.active).slice(0, 4).map(s => ({ key: s.key, comp: s.title || s.key }));
  } catch (_) { return []; }
}
function buildTennisMarkets(ev) {
  const out = []; const bk = (ev.bookmakers && ev.bookmakers[0]) || null; if (!bk) return out;
  const h2h = bk.markets?.find(m => m.key === "h2h");
  if (h2h) { const a = h2h.outcomes.find(o => o.name === ev.home_team), b = h2h.outcomes.find(o => o.name === ev.away_team);
    if (a && b) out.push({ type: "Vainqueur", sels: [a.name, b.name], odds: [a.price, b.price] }); }
  const totals = bk.markets?.find(m => m.key === "totals");
  if (totals && totals.outcomes?.length >= 2) { const over = totals.outcomes.find(o => /over/i.test(o.name)), under = totals.outcomes.find(o => /under/i.test(o.name));
    if (over && under) { const pt = over.point ?? ""; out.push({ type: "Total sets", sels: [`+${pt} sets`, `-${pt} sets`], odds: [over.price, under.price] }); } }
  return out;
}
async function loadTennis(apiKey, day) {
  const wantKey = parisDateKeyOffset(day); const targets = await discoverTennisTargets(apiKey); const result = {};
  for (const { key, comp } of targets) {
    try { const r = await fetch(`${ODDS_BASE}/sports/${key}/odds?apiKey=${apiKey}&regions=fr&oddsFormat=decimal&dateFormat=iso&markets=h2h,totals`); if (!r.ok) continue;
      const events = await r.json(); const matches = [];
      for (const ev of events) { if (parisDateKeyFromISO(ev.commence_time) !== wantKey) continue; const markets = buildTennisMarkets(ev); if (!markets.length) continue;
        matches.push({ id: ev.id, home: ev.home_team, away: ev.away_team, time: parisTime(ev.commence_time), date: parisDateKeyFromISO(ev.commence_time), offset: day, markets }); }
      if (matches.length) result[comp] = matches;
    } catch (_) {}
  }
  return result;
}

/* ---------------- Handler ---------------- */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const sport = (req.query.sport || "foot").toString();
  const day = Number(req.query.day || 0);
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "THE_ODDS_API_KEY manquante (env Vercel)." });
  try {
    const result = sport === "tennis" ? await loadTennis(apiKey, day) : await loadFoot(apiKey, day);
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: "Erreur de récupération." });
  }
}
