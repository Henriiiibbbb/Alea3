// api/why.js — Proxy Anthropic pour le "Pourquoi ?", "Mon pari perso" et "Dernières infos".
// Cache la clé (env ANTHROPIC_API_KEY) + règle le CORS + suit un budget mensuel PARTAGÉ
// (visible par tous ceux qui utilisent le lien) via Vercel KV, pour ne jamais dépasser
// un plafond de dépense en $ (≈ €) par mois.
//
// Variables d'env nécessaires :
//   ANTHROPIC_API_KEY        -> obligatoire pour que l'IA fonctionne
//   KV_REST_API_URL          -> créé automatiquement par Vercel quand tu connectes un KV store
//   KV_REST_API_TOKEN        -> idem
//   BUDGET_CAP_USD            -> optionnel, défaut "5" (le plafond mensuel)
//
// Sans KV_REST_API_URL/TOKEN configurés, l'IA fonctionne quand même mais SANS suivi de
// budget partagé (tracked:false) — l'app le détecte et masque la jauge.

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const kvEnabled = !!(KV_URL && KV_TOKEN);

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result; // string | null
}
async function kvIncrByFloat(key, amount) {
  const r = await fetch(`${KV_URL}/incrbyfloat/${encodeURIComponent(key)}/${amount}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const j = await r.json();
  return parseFloat(j.result) || 0;
}
async function kvIncr(key) {
  const r = await fetch(`${KV_URL}/incr/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const j = await r.json();
  return parseInt(j.result, 10) || 0;
}

// Tarifs Sonnet 4.6 (juin 2026) : $3/M tokens entrée, $15/M sortie, recherche web $10/1000.
function estimateCost(data) {
  const usage = data.usage || {};
  const inputTok = usage.input_tokens || 0;
  const outputTok = usage.output_tokens || 0;
  let searches = usage.server_tool_use && usage.server_tool_use.web_search_requests;
  if (searches == null) {
    // Repli : on compte les blocs d'appel d'outil recherche web dans la réponse.
    searches = (data.content || []).filter(
      (b) => b.type === "server_tool_use" && b.name === "web_search"
    ).length;
  }
  if (!searches) searches = 1; // l'outil est toujours fourni et quasi toujours utilisé : on ne sous-estime pas.
  return (inputTok / 1e6) * 3 + (outputTok / 1e6) * 15 + searches * 0.01;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST uniquement" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY manquante (variable d'env Vercel)." });

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const cap = parseFloat(process.env.BUDGET_CAP_USD || "5");

  // --- Vérification du budget AVANT d'appeler l'IA (si le suivi est actif) ---
  if (kvEnabled) {
    try {
      const spendKey = `alea:spend:${monthKey()}`;
      const countKey = `alea:count:${monthKey()}`;
      const spent = parseFloat(await kvGet(spendKey)) || 0;
      if (spent >= cap) {
        const count = parseInt(await kvGet(countKey), 10) || 0;
        return res.status(200).json({ blocked: true, tracked: true, spent, count, cap });
      }
    } catch (e) {
      // si KV est en panne, on laisse passer l'appel plutôt que de tout bloquer
    }
  }

  // --- Appel Anthropic ---
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ blocked: false, tracked: kvEnabled, error: data });

    if (!kvEnabled) {
      return res.status(200).json({ blocked: false, tracked: false, data });
    }

    // --- Mise à jour du compteur partagé après un appel réussi ---
    const cost = estimateCost(data);
    const spendKey = `alea:spend:${monthKey()}`;
    const countKey = `alea:count:${monthKey()}`;
    const [newSpent, newCount] = await Promise.all([
      kvIncrByFloat(spendKey, cost),
      kvIncr(countKey),
    ]);
    return res.status(200).json({ blocked: false, tracked: true, data, spent: newSpent, count: newCount, cap });
  } catch (e) {
    return res.status(502).json({ error: "Appel Anthropic échoué", detail: String(e) });
  }
}
