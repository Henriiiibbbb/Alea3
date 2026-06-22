// api/users.js — Enregistrement des profils + liste admin (protégée par code).
//
// Variables d'env Vercel :
//   KV_REST_API_URL / KV_REST_API_TOKEN  -> déjà présents (Upstash KV)
//   ADMIN_CODE                            -> À AJOUTER : ton code secret pour voir la liste
//
// POST  { firstName, username }      -> enregistre / met à jour le profil (firstSeen, lastSeen, visits)
// GET   ?code=XXX                    -> si code == ADMIN_CODE, renvoie la liste des inscrits
//
// Vie privée : on ne stocke que prénom + pseudo (ce que l'utilisateur a saisi) + dates. Rien d'autre.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const kvEnabled = !!(KV_URL && KV_TOKEN);

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result;
}
async function kvCmd(args) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result;
}

function clean(s, max) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max); }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!kvEnabled) return res.status(200).json({ ok: false, error: "KV non configuré." });

  // -------- Enregistrement d'un profil (création OU rattrapage auto au chargement) --------
  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const username = clean(body.username, 40);
    const firstName = clean(body.firstName, 40);
    if (!username && !firstName) return res.status(200).json({ ok: false, error: "profil vide" });
    const id = (username || firstName).toLowerCase();
    const now = new Date().toISOString();
    try {
      await kvCmd(["SADD", "alea:users", id]);
      let rec = {};
      try { const raw = await kvGet(`alea:user:${id}`); if (raw) rec = JSON.parse(raw); } catch (_) {}
      rec.username = username || rec.username || "";
      rec.firstName = firstName || rec.firstName || "";
      rec.firstSeen = rec.firstSeen || now;
      rec.lastSeen = now;
      rec.visits = (rec.visits || 0) + 1;
      await kvCmd(["SET", `alea:user:${id}`, JSON.stringify(rec)]);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(200).json({ ok: false, error: "enregistrement échoué" });
    }
  }

  // -------- Liste admin (protégée par code) --------
  if (req.method === "GET") {
    const code = (req.query.code || "").toString();
    const adminCode = process.env.ADMIN_CODE;
    if (!adminCode) return res.status(200).json({ ok: false, error: "ADMIN_CODE non configuré dans Vercel." });
    if (code !== adminCode) return res.status(403).json({ ok: false, error: "Code incorrect." });
    try {
      const ids = (await kvCmd(["SMEMBERS", "alea:users"])) || [];
      const users = [];
      for (const id of ids) {
        try { const raw = await kvGet(`alea:user:${id}`); if (raw) users.push(JSON.parse(raw)); } catch (_) {}
      }
      users.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
      return res.status(200).json({ ok: true, total: users.length, users });
    } catch (e) {
      return res.status(200).json({ ok: false, error: "lecture échouée" });
    }
  }

  return res.status(405).json({ ok: false, error: "Méthode non autorisée" });
}
