// api/odds.js — Proxy hybride pour Vercel (Node serverless).
//
//  • FOOT   -> API-Football (api-sports.io). Clé dans l'env Vercel : API_FOOTBALL_KEY.
//             Bien plus de marchés que The Odds API (1X2, total buts multi-lignes, BTTS,
//             double chance, mi-temps, buts par équipe, score exact…), + score ET MINUTE en direct.
//  • TENNIS -> The Odds API (inchangé). Clé dans l'env Vercel : THE_ODDS_API_KEY.
//             (API-Football ne couvre que le foot, donc on garde l'ancienne source pour le tennis.)
//
// Sortie (identique à avant, pour ne rien casser dans index.html) :
//   { "Nom compétition": [ { id, home, away, time, date, offset,
//                            markets:[ {type, sels:[...], odds:[...], raw?} ],
//                            score?:{home,away}, completed?, minute? } ] }
//
// IMPORTANT (honnêteté) : la dispo réelle des cotes API-Football pour la Coupe du Monde sur le
// plan gratuit n'est pas garantie à 100 % — c'est précisément ce qu'on teste avec ce branchement.
// Le code est défensif : si les cotes ne reviennent pas, la compétition est simplement vide
// (et index.html bascule alors sur sa démo).

/* ============================ FOOT — API-Football ============================ */

const AF_BASE = "https://v3.football.api-sports.io";
// league = identifiant API-Football ; season = année de DÉBUT de saison.
// En juin, seules les compétitions encore en cours renvoient des matchs (la CdM 2026, donc).
const AF_LEAGUES = [
  { league: 1,  season: 2026, comp: "Coupe du Monde 2026" },
  { league: 61, season: 2025, comp: "Ligue 1" },
  { league: 2,  season: 2025, comp: "Ligue des Champions" },
];
const AF_MAX_FIXTURES_ODDS = 6; // borne le nb d'appels cotes par compétition (économie de quota)

const LIVE_ST = new Set(["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT", "SUSP"]);
const DONE_ST = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

function afHeaders(apiKey) {
  // API-Football veut la clé dans un header (pas dans l'URL) — d'où l'échec du test Safari.
  return { "x-apisports-key": apiKey };
}

async function afGet(path, apiKey) {
  const r = await fetch(`${AF_BASE}${path}`, { headers: afHeaders(apiKey) });
  if (!r.ok) return null;
  return await r.json(); // API-Football renvoie 200 + {response:[], errors:{...}} en cas de souci -> géré en aval
}

function oddOf(bet, label) {
  const v = bet.values.find(x => String(x.value).toLowerCase() === label.toLowerCase());
  return v ? parseFloat(v.odd) : null;
}

// Regroupe les valeurs "Over X / Under X" par ligne -> { "2.5":{over,under}, ... }
function ouLines(bet) {
  const lines = {};
  for (const v of bet.values) {
    const m = String(v.value).match(/(Over|Under)\s+([\d.]+)/i);
    if (!m) continue;
    (lines[m[2]] = lines[m[2]] || {})[m[1].toLowerCase()] = parseFloat(v.odd);
  }
  return lines;
}

// Transforme les "bets" d'un bookmaker API-Football en notre format de marchés.
function afBuildMarkets(bets, home, away) {
  const out = [];
  const find = (re) => bets.find(b => re.test(b.name));

  // 1X2
  const mw = find(/^match winner$/i);
  if (mw) {
    const h = oddOf(mw, "Home"), d = oddOf(mw, "Draw"), a = oddOf(mw, "Away");
    if (h && d && a) out.push({ type: "1X2", sels: [home, "Match nul", away], odds: [h, d, a] });
  }

  // Double chance
  const dc = find(/^double chance$/i);
  if (dc) {
    const hd = oddOf(dc, "Home/Draw"), ha = oddOf(dc, "Home/Away"), da = oddOf(dc, "Draw/Away");
    if (hd && ha && da)
      out.push({ type: "Double chance", sels: [`${home} ou nul`, `${home} ou ${away}`, `nul ou ${away}`], odds: [hd, ha, da], raw: true });
  }

  // Total de buts (toutes les lignes dispos entre 0.5 et 5.5 -> variété pour remplir les catégories)
  const ou = find(/^goals over\/under$/i);
  if (ou) {
    const lines = ouLines(ou);
    for (const line of Object.keys(lines)) {
      const L = parseFloat(line);
      if (L < 0.5 || L > 5.5) continue;
      const { over, under } = lines[line];
      if (over && under) out.push({ type: "Total buts", sels: [`+${line} buts`, `-${line} buts`], odds: [over, under] });
    }
  }

  // Les deux équipes marquent
  const btts = find(/^both teams (to )?score$/i);
  if (btts) {
    const y = oddOf(btts, "Yes"), n = oddOf(btts, "No");
    if (y && n) out.push({ type: "Les deux équipes marquent (BTTS)", sels: ["Les deux équipes marquent", "Pas les deux"], odds: [y, n] });
  }

  // Résultat à la mi-temps
  const fhw = find(/^(first half winner|halftime result|1st half winner)$/i);
  if (fhw) {
    const h = oddOf(fhw, "Home"), d = oddOf(fhw, "Draw"), a = oddOf(fhw, "Away");
    if (h && d && a) out.push({ type: "Résultat à la mi-temps", sels: [home, "Match nul", away], odds: [h, d, a] });
  }

  // Buts en première mi-temps
  const ouH1 = find(/first half.*over\/under|goals over\/under first half/i);
  if (ouH1) {
    const lines = ouLines(ouH1);
    for (const line of Object.keys(lines)) {
      const L = parseFloat(line);
      if (L < 0.5 || L > 3.5) continue;
      const { over, under } = lines[line];
      if (over && under) out.push({ type: "Plus ou moins de buts en première mi-temps", sels: [`+${line} but (1re MT)`, `-${line} but (1re MT)`], odds: [over, under] });
    }
  }

  // Résultat 2e mi-temps
  const shw = find(/^(second half winner|2nd half winner)$/i);
  if (shw) {
    const h = oddOf(shw, "Home"), d = oddOf(shw, "Draw"), a = oddOf(shw, "Away");
    if (h && d && a) out.push({ type: "Résultat de la seconde mi-temps", sels: [home, "Match nul", away], odds: [h, d, a] });
  }

  // Buts par équipe (familles distinctes -> diversité)
  const th = find(/^total - home$/i);
  if (th) {
    const lines = ouLines(th);
    const line = lines["1.5"] || lines["0.5"] || lines["2.5"];
    if (line && line.over && line.under) {
      const lbl = lines["1.5"] ? "1.5" : lines["0.5"] ? "0.5" : "2.5";
      out.push({ type: `Buts de ${home}`, sels: [`${home} +${lbl}`, `${home} -${lbl}`], odds: [line.over, line.under] });
    }
  }
  const ta = find(/^total - away$/i);
  if (ta) {
    const lines = ouLines(ta);
    const line = lines["1.5"] || lines["0.5"] || lines["2.5"];
    if (line && line.over && line.under) {
      const lbl = lines["1.5"] ? "1.5" : lines["0.5"] ? "0.5" : "2.5";
      out.push({ type: `Buts de ${away}`, sels: [`${away} +${lbl}`, `${away} -${lbl}`], odds: [line.over, line.under] });
    }
  }

  // Score exact : on garde le plus probable (cote la plus basse) comme pari "fun"
  const ex = find(/^exact score$/i);
  if (ex && ex.values.length) {
    let best = null;
    for (const v of ex.values) {
      const o = parseFloat(v.odd);
      if (o && (!best || o < best.odd)) best = { score: v.value, odd: o };
    }
    if (best) out.push({ type: "Score exact", sels: [best.score.replace(":", "-")], odds: [best.odd], raw: true });
  }

  return out;
}

// Choisit le bookmaker le plus fourni (celui qui a le plus de "bets") pour maximiser la diversité.
function pickBookmaker(oddsItem) {
  const bks = oddsItem && oddsItem.bookmakers;
  if (!bks || !bks.length) return null;
  return bks.reduce((best, b) => (!best || (b.bets || []).length > (best.bets || []).length ? b : best), null);
}

async function loadFoot(apiKey, day) {
  const wantDate = parisDateKeyOffset(day);
  const result = {};
  for (const { league, season, comp } of AF_LEAGUES) {
    try {
      // 1) Fixtures du jour voulu (1 requête) — donne équipes, heure, score live + minute + statut.
      const fx = await afGet(`/fixtures?league=${league}&season=${season}&date=${wantDate}&timezone=Europe/Paris`, apiKey);
      const fixtures = (fx && fx.response) || [];
      if (!fixtures.length) continue;

      const matches = [];
      let oddsCalls = 0;
      for (const f of fixtures) {
        const id = f.fixture.id;
        const home = f.teams.home.name, away = f.teams.away.name;
        const iso = f.fixture.date;
        const st = f.fixture.status?.short;
        const elapsed = f.fixture.status?.elapsed;

        let markets = [];
        if (oddsCalls < AF_MAX_FIXTURES_ODDS) {
          oddsCalls++;
          // 2) Cotes de ce match (1 requête / match) — c'est là qu'est la richesse des marchés.
          const od = await afGet(`/odds?fixture=${id}&timezone=Europe/Paris`, apiKey);
          const item = od && od.response && od.response[0];
          const bk = pickBookmaker(item);
          if (bk) markets = afBuildMarkets(bk.bets || [], home, away);
        }
        if (!markets.length) continue; // sans cotes, pas de pari à proposer -> on saute

        const m = {
          id, home, away,
          time: parisTime(iso), date: parisDateKeyFromISO(iso), offset: day, markets,
        };
        // Score + minute en direct (bonus API-Football : la minute, que The Odds API ne donnait pas)
        if (f.goals && (f.goals.home !== null || f.goals.away !== null)) {
          m.score = { home: Number(f.goals.home || 0), away: Number(f.goals.away || 0) };
        }
        if (DONE_ST.has(st)) m.completed = true;
        else if (LIVE_ST.has(st) && typeof elapsed === "number") m.minute = elapsed;
        matches.push(m);
      }
      if (matches.length) result[comp] = matches;
    } catch (_) { /* compétition en erreur : on ignore, on ne casse pas le reste */ }
  }
  return result;
}

/* ============================ TENNIS — The Odds API (inchangé) ============================ */

async function discoverTennisTargets(apiKey) {
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`);
    if (!r.ok) return [];
    const sports = await r.json();
    return sports.filter(s => s.key && s.key.startsWith("tennis_atp_") && s.active).slice(0, 4)
      .map(s => ({ key: s.key, comp: s.title || s.key }));
  } catch (_) { return []; }
}

function buildTennisMarkets(ev) {
  const out = [];
  const bk = (ev.bookmakers && ev.bookmakers[0]) || null;
  if (!bk) return out;
  const h2h = bk.markets?.find(m => m.key === "h2h");
  if (h2h) {
    const a = h2h.outcomes.find(o => o.name === ev.home_team);
    const b = h2h.outcomes.find(o => o.name === ev.away_team);
    if (a && b) out.push({ type: "Vainqueur", sels: [a.name, b.name], odds: [a.price, b.price] });
  }
  const totals = bk.markets?.find(m => m.key === "totals");
  if (totals && totals.outcomes?.length >= 2) {
    const over = totals.outcomes.find(o => /over/i.test(o.name));
    const under = totals.outcomes.find(o => /under/i.test(o.name));
    if (over && under) {
      const pt = over.point ?? "";
      out.push({ type: "Total sets", sels: [`+${pt} sets`, `-${pt} sets`], odds: [over.price, under.price] });
    }
  }
  return out;
}

async function loadTennis(apiKey, day) {
  const wantKey = parisDateKeyOffset(day);
  const targets = await discoverTennisTargets(apiKey);
  const result = {};
  for (const { key, comp } of targets) {
    try {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${key}/odds?apiKey=${apiKey}&regions=fr&oddsFormat=decimal&dateFormat=iso&markets=h2h,totals`);
      if (!r.ok) continue;
      const events = await r.json();
      const matches = [];
      for (const ev of events) {
        if (parisDateKeyFromISO(ev.commence_time) !== wantKey) continue;
        const markets = buildTennisMarkets(ev);
        if (!markets.length) continue;
        matches.push({ id: ev.id, home: ev.home_team, away: ev.away_team, time: parisTime(ev.commence_time), date: parisDateKeyFromISO(ev.commence_time), offset: day, markets });
      }
      if (matches.length) result[comp] = matches;
    } catch (_) { /* ignore */ }
  }
  return result;
}

/* ============================ Helpers dates (Europe/Paris) ============================ */

function parisDateKeyFromISO(iso) {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
function parisTime(iso) {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
function parisDateKeyOffset(day) {
  const now = new Date();
  const d = new Date(now.getTime() + (Number(day) || 0) * 24 * 3600 * 1000);
  return parisDateKeyFromISO(d.toISOString());
}

/* ============================ Handler ============================ */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const sport = (req.query.sport || "foot").toString();
  const day = Number(req.query.day || 0);

  // --- Mode diagnostic temporaire : /api/odds?debug=1 ---
  // Montre EXACTEMENT ce que renvoie API-Football (nb de matchs, nb de cotes, erreurs éventuelles),
  // pour comprendre pourquoi la réponse est vide. À retirer une fois le souci compris.
  if (req.query.debug) {
    const k = process.env.API_FOOTBALL_KEY;
    if (!k) return res.status(200).json({ debug: "API_FOOTBALL_KEY absente de l'env Vercel" });
    const out = { keyPresent: true, today: parisDateKeyOffset(day), leagues: [] };
    for (const { league, season, comp } of AF_LEAGUES) {
      const url = `/fixtures?league=${league}&season=${season}&date=${parisDateKeyOffset(day)}&timezone=Europe/Paris`;
      let fx = null, errTxt = null;
      try {
        const r = await fetch(`${AF_BASE}${url}`, { headers: afHeaders(k) });
        const j = await r.json();
        fx = j;
      } catch (e) { errTxt = String(e); }
      const entry = { comp, league, season,
        httpOk: !errTxt,
        nbFixtures: (fx && fx.response && fx.response.length) || 0,
        apiErrors: fx && fx.errors,
        firstFixture: fx && fx.response && fx.response[0]
          ? { home: fx.response[0].teams?.home?.name, away: fx.response[0].teams?.away?.name, id: fx.response[0].fixture?.id, status: fx.response[0].fixture?.status?.short }
          : null,
      };
      // Si un match existe, on teste tout de suite si ses cotes reviennent
      if (entry.firstFixture) {
        try {
          const ro = await fetch(`${AF_BASE}/odds?fixture=${entry.firstFixture.id}&timezone=Europe/Paris`, { headers: afHeaders(k) });
          const jo = await ro.json();
          entry.oddsResults = (jo && jo.response && jo.response.length) || 0;
          entry.oddsErrors = jo && jo.errors;
          const bk = jo && jo.response && jo.response[0] && jo.response[0].bookmakers && jo.response[0].bookmakers[0];
          entry.nbBetsFirstBookmaker = bk ? (bk.bets || []).length : 0;
        } catch (e) { entry.oddsErr = String(e); }
      }
      out.leagues.push(entry);
    }
    return res.status(200).json(out);
  }

  try {
    let result = {};
    if (sport === "tennis") {
      const k = process.env.THE_ODDS_API_KEY;
      if (!k) return res.status(500).json({ error: "THE_ODDS_API_KEY manquante (env Vercel)." });
      result = await loadTennis(k, day);
    } else {
      const k = process.env.API_FOOTBALL_KEY;
      if (!k) return res.status(500).json({ error: "API_FOOTBALL_KEY manquante (env Vercel)." });
      result = await loadFoot(k, day);
    }
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300"); // limite la conso de quota
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: "Erreur de récupération des cotes." });
  }
}
