// api/odds.js — Proxy The Odds API (région "fr"), pour Vercel (Node serverless).
// Cache la clé (env THE_ODDS_API_KEY) et règle le CORS.
// Renvoie : { "Nom compétition": [ {home,away,time,offset,markets:[{type,sels,odds}]} ] }
//
// Le foot demande jusqu'à 7 marchés (h2h,totals,btts,double_chance,draw_no_bet,h2h_h1,totals_h1) au
// lieu de 2 à l'origine : ça coûte plus de crédits par appel chez The Odds API. Le cache de 2 min
// (en bas du fichier) limite la casse, mais surveille ta conso sur the-odds-api.com si tu approches
// le palier gratuit. Les marchés mi-temps (h2h_h1/totals_h1) sont EXPÉRIMENTAUX : la doc officielle
// les associe surtout à l'endpoint historique (payant, 10x le coût), pas garanti qu'ils remontent en
// direct. D'où le filet de sécurité à 3 paliers ci-dessous : si le palier le plus riche échoue, on
// retombe sur celui qui marchait déjà, jamais sur rien.
// Les marchés joueurs (buteur...) ne sont eux PAS disponibles pour la Coupe du Monde, quel que soit
// l'effort mis ici — réservés à EPL/Ligue 1/Bundesliga/Serie A/Liga/MLS, et via bookmakers US.

// Mappe le "sport" de l'app -> clés The Odds API + nom d'affichage de la compétition.
// Le foot reste en dur (les championnats/compétitions ne changent pas de clé en cours de saison).
// Le tennis, lui, change de tournoi CHAQUE SEMAINE (clé différente à chaque fois) : au lieu de
// deviner/figer un tournoi qui devient vite obsolète, on demande à l'API quels tournois ATP sont
// actuellement en cours (voir discoverTennisTargets ci-dessous) — ça s'adapte tout seul, sans
// jamais avoir besoin de retoucher ce fichier semaine après semaine.
const SPORTS = {
  foot: [
    { key: "soccer_fifa_world_cup",   comp: "Coupe du Monde 2026" },
    { key: "soccer_france_ligue_one", comp: "Ligue 1" },
    { key: "soccer_uefa_champs_league", comp: "Ligue des Champions" },
  ],
};

// Liste les tournois ATP "en saison" en ce moment via l'endpoint /sports (gratuit, ne coûte
// aucun crédit). On garde au plus 4 tournois pour limiter le nombre d'appels ensuite.
async function discoverTennisTargets(apiKey) {
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`);
    if (!r.ok) return [];
    const sports = await r.json();
    return sports
      .filter(s => s.key && s.key.startsWith("tennis_atp_") && s.active)
      .slice(0, 4)
      .map(s => ({ key: s.key, comp: s.title || s.key }));
  } catch (_) { return []; }
}

// Décale une date ISO (UTC) vers la date "calendaire" à Paris (YYYY-MM-DD)
function parisDateKey(iso) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}
function parisTime(iso) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}
function todayKeys() {
  const now = new Date();
  const t0 = parisDateKey(now.toISOString());
  const tmrw = new Date(now.getTime() + 24 * 3600 * 1000);
  const t1 = parisDateKey(tmrw.toISOString());
  return { t0, t1 };
}

// h2h (1X2 / vainqueur) + totals -> nos "markets"
function buildMarkets(ev, isTennis) {
  const out = [];
  const bk = (ev.bookmakers && ev.bookmakers[0]) || null; // 1er book de la région
  if (!bk) return out;

  const h2h = bk.markets?.find(m => m.key === "h2h");
  if (h2h) {
    if (isTennis) {
      const a = h2h.outcomes.find(o => o.name === ev.home_team);
      const b = h2h.outcomes.find(o => o.name === ev.away_team);
      if (a && b) out.push({ type: "Vainqueur", sels: [a.name, b.name], odds: [a.price, b.price] });
    } else {
      const home = h2h.outcomes.find(o => o.name === ev.home_team);
      const away = h2h.outcomes.find(o => o.name === ev.away_team);
      const draw = h2h.outcomes.find(o => o.name === "Draw");
      if (home && away && draw)
        out.push({ type: "1X2", sels: [home.name, "Match nul", away.name], odds: [home.price, draw.price, away.price] });
    }
  }

  const totals = bk.markets?.find(m => m.key === "totals");
  if (totals && totals.outcomes?.length >= 2) {
    const over = totals.outcomes.find(o => /over/i.test(o.name));
    const under = totals.outcomes.find(o => /under/i.test(o.name));
    if (over && under) {
      const pt = over.point ?? "";
      const unit = isTennis ? "sets" : "buts";
      out.push({ type: isTennis ? "Total sets" : "Total buts",
        sels: [`+${pt} ${unit}`, `-${pt} ${unit}`], odds: [over.price, under.price] });
    }
  }

  // Marchés additionnels foot uniquement (non couverts pour la Coupe du Monde dans tous les cas
  // pour les marchés joueurs, mais BTTS/double chance sont des marchés "équipe", donc disponibles).
  if (!isTennis) {
    const btts = bk.markets?.find(m => m.key === "btts");
    if (btts && btts.outcomes?.length === 2) {
      out.push({ type: "Les deux équipes marquent (BTTS)", sels: btts.outcomes.map(o => o.name), odds: btts.outcomes.map(o => o.price) });
    }
    const dc = bk.markets?.find(m => m.key === "double_chance");
    if (dc && dc.outcomes?.length === 3) {
      out.push({ type: "Double chance", sels: dc.outcomes.map(o => o.name), odds: dc.outcomes.map(o => o.price), raw: true });
    }
    const dnb = bk.markets?.find(m => m.key === "draw_no_bet");
    if (dnb && dnb.outcomes?.length === 2) {
      out.push({ type: "Pari remboursé si match nul (Draw No Bet)", sels: dnb.outcomes.map(o => o.name), odds: dnb.outcomes.map(o => o.price) });
    }
    // Mi-temps (expérimental — pas garanti disponible en live, voir commentaire plus haut)
    const h1 = bk.markets?.find(m => m.key === "h2h_h1");
    if (h1) {
      const home = h1.outcomes.find(o => o.name === ev.home_team);
      const away = h1.outcomes.find(o => o.name === ev.away_team);
      const draw = h1.outcomes.find(o => o.name === "Draw");
      if (home && away && draw)
        out.push({ type: "Résultat à la mi-temps", sels: [home.name, "Match nul", away.name], odds: [home.price, draw.price, away.price] });
    }
    const t1 = bk.markets?.find(m => m.key === "totals_h1");
    if (t1 && t1.outcomes?.length >= 2) {
      const over = t1.outcomes.find(o => /over/i.test(o.name));
      const under = t1.outcomes.find(o => /under/i.test(o.name));
      if (over && under) {
        const pt = over.point ?? "";
        out.push({ type: "Plus ou moins de buts en première mi-temps", sels: [`+${pt} but (1re MT)`, `-${pt} but (1re MT)`], odds: [over.price, under.price] });
      }
    }
  }
  return out;
}

// Score en direct : 1 crédit/appel (2 si on demandait l'historique, ce qu'on ne fait pas ici).
// On ne l'appelle que pour "aujourd'hui" (day=0) — inutile de le payer pour les matchs de demain,
// qui n'ont jamais de score. Fusion par id d'événement (le plus fiable, pas par nom d'équipe).
async function fetchScores(key, apiKey) {
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/${key}/scores/?apiKey=${apiKey}&dateFormat=iso`);
    if (!r.ok) return [];
    return await r.json();
  } catch (_) { return []; }
}
function attachScores(matches, scoreEvents) {
  if (!scoreEvents || !scoreEvents.length) return;
  const byId = new Map(scoreEvents.map(s => [s.id, s]));
  for (const m of matches) {
    const s = byId.get(m.id);
    if (!s || !s.scores) continue;
    const hs = s.scores.find(x => x.name === m.home);
    const as = s.scores.find(x => x.name === m.away);
    if (hs && as) {
      m.score = { home: Number(hs.score), away: Number(as.score) };
      m.completed = !!s.completed;
    }
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "THE_ODDS_API_KEY manquante (variable d'env Vercel)." });

  const sport = (req.query.sport || "foot").toString();
  const day = Number(req.query.day || 0); // 0 = aujourd'hui, 1 = demain
  const isTennis = sport === "tennis";
  const targets = isTennis ? await discoverTennisTargets(apiKey) : (SPORTS[sport] || []);
  const { t0, t1 } = todayKeys();
  const wantKey = day === 1 ? t1 : t0;

  const result = {};
  for (const { key, comp } of targets) {
    // 3 paliers, du plus riche au plus sûr — on ne perd jamais ce qui marchait avant si un palier échoue.
    const tiers = isTennis ? ["h2h,totals"] : [
      "h2h,totals,btts,double_chance,draw_no_bet,h2h_h1,totals_h1", // tente aussi la mi-temps (expérimental)
      "h2h,totals,btts,double_chance,draw_no_bet",                 // palier connu pour fonctionner
      "h2h,totals",                                                 // base minimale, ne doit jamais échouer
    ];
    const baseUrl = `https://api.the-odds-api.com/v4/sports/${key}/odds`
      + `?apiKey=${apiKey}&regions=fr&oddsFormat=decimal&dateFormat=iso&markets=`;
    try {
      let r, events;
      for (const tier of tiers) {
        r = await fetch(baseUrl + tier);
        if (r.ok) { events = await r.json(); break; }
      }
      if (!r || !r.ok || !events) continue;  // compétition hors-saison / non couverte : on saute
      const matches = [];
      for (const ev of events) {
        if (parisDateKey(ev.commence_time) !== wantKey) continue;
        const markets = buildMarkets(ev, isTennis);
        if (!markets.length) continue;
        matches.push({
          id: ev.id, home: ev.home_team, away: ev.away_team,
          time: parisTime(ev.commence_time), date: parisDateKey(ev.commence_time), offset: day, markets,
        });
      }
      if (matches.length) {
        if (day === 0) {
          const scoreEvents = await fetchScores(key, apiKey);
          attachScores(matches, scoreEvents);
        }
        result[comp] = matches;
      }
    } catch (_) { /* on ignore une compétition en erreur */ }
  }
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300"); // limite la conso de crédits
  return res.status(200).json(result);
}
