// api/usage.js — Lecture seule du budget IA partagé du mois en cours.
// Permet à l'app d'afficher la jauge "X € / 5 €" au chargement, sans déclencher d'appel IA.
// Mêmes variables d'env que why.js (KV_REST_API_URL, KV_REST_API_TOKEN, BUDGET_CAP_USD).

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const cap = parseFloat(process.env.BUDGET_CAP_USD || "5");

  if (!KV_URL || !KV_TOKEN) {
    return res.status(200).json({ tracked: false, spent: 0, count: 0, cap });
  }
  try {
    const spent = parseFloat(await kvGet(`alea:spend:${monthKey()}`)) || 0;
    const count = parseInt(await kvGet(`alea:count:${monthKey()}`), 10) || 0;
    return res.status(200).json({ tracked: true, spent, count, cap });
  } catch (e) {
    return res.status(200).json({ tracked: false, spent: 0, count: 0, cap });
  }
}
