// API für KI-Bewertungen: lesen, Beobachtungsliste setzen, fällige Spieler, Ergebnisse speichern
import type { Config } from "@netlify/functions";
import { loadRatings, saveWatch, dueList, mergeRatings, noteError, takeQuota, loadMemory, updateMemory, loadFavs, saveFavs, loadMatchAi, saveMatchAi, loadPredSnap, savePredSnap } from "../lib/kistore.ts";

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

export default async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path.endsWith("/ratings") && req.method === "GET") {
    const { ratings, meta } = await loadRatings();
    const d = await dueList(0);
    return json(200, { ratings, meta: { ...meta, pending: d.pending, watched: d.total } }, { "cache-control": "no-store" });
  }

  if (path.endsWith("/watchlist") && req.method === "POST") {
    const body: any = await req.json().catch(() => null);
    const players = (Array.isArray(body?.players) ? body.players : [])
      .filter((p: any) => Number.isInteger(p?.id) && typeof p?.name === "string")
      .map((p: any) => ({ id: p.id, name: String(p.name).slice(0, 60), club: String(p.club || "").slice(0, 5), pos: String(p.pos || "").slice(0, 4), line: String(p.line || "").slice(0, 300), ...(/^\d{1,10}$/.test(String(p.sid || "")) ? { sid: String(p.sid) } : {}), ...(Number.isFinite(p.score) ? { score: Math.max(0, Math.min(100, Math.round(p.score))) } : {}) }));
    if (!players.length) return json(400, { error: "Keine Spieler" });
    await saveWatch(players);
    return json(200, { ok: true, count: players.length });
  }

  if (path.endsWith("/due") && req.method === "GET") {
    return json(200, await dueList(Math.min(20, Number(url.searchParams.get("n")) || 15)), { "cache-control": "no-store" });
  }

  if (path.endsWith("/save") && req.method === "POST") {
    const secret = Netlify.env.get("KI_SECRET");
    if (!secret || req.headers.get("x-ki-secret") !== secret) return json(401, { error: "nicht erlaubt" });
    const body: any = await req.json().catch(() => null);
    if (body?.error) { await noteError(String(body.error).slice(0, 200)); return json(200, { ok: true }); }
    const total = await mergeRatings(body?.ratings || {});
    return json(200, { ok: true, total });
  }

  if (path.endsWith("/quota") && req.method === "POST") {
    const secret = Netlify.env.get("KI_SECRET");
    if (!secret || req.headers.get("x-ki-secret") !== secret) return json(401, { error: "nicht erlaubt" });
    const body: any = await req.json().catch(() => null);
    return json(200, await takeQuota(String(body?.kind || "")));
  }

  // Gedächtnis nachführen: nach jeder Coach-Antwort dauerhafte Fakten festhalten (günstiges Modell über OpenRouter)
  if (path.endsWith("/remember") && req.method === "POST") {
    const key = Netlify.env.get("OPENROUTER_API_KEY");
    const body: any = await req.json().catch(() => ({}));
    const k = String(body?.k || "");
    if (!key || !/^[0-9a-z_-]{3,60}$/i.test(k)) return json(200, { ok: false });
    if (!(await takeQuota("mem")).ok) return json(200, { ok: false, reason: "limit" });
    const notes = await loadMemory(k);
    const prompt = `Du pflegst das Langzeitgedächtnis eines Fantasy-Fussball-Coaches für einen Nutzer (Sleeper-Liga, Premier League). Heute: ${new Date().toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}.
Bisherige Notizen (id: text):
${notes.map((n) => `${n.id}: ${n.t}`).join("\n") || "(keine)"}

Neue Frage des Nutzers: ${String(body?.question || "").slice(0, 1500)}
Antwort des Coaches (gekürzt): ${String(body?.answer || "").slice(0, 2500)}

Halte NUR fest, was in späteren Gesprächen nützlich bleibt: Vorlieben und Ziele des Nutzers, getroffene oder geplante Entscheide (Trades, Waiver, Aufstellung), Abmachungen, was er von Ratschlägen hält, wichtige Empfehlungen des Coaches (mit Datum). Keine Werte, die sich ohnehin aus den Live-Daten ergeben (Punkte, Scores, FAAB-Stand). Kurze deutsche Sätze, Schweizer Rechtschreibung. Entferne Notizen, die überholt sind oder der neuen Info widersprechen.
Antworte nur mit JSON: {"add":["..."],"remove":["id"]} – leere Listen, wenn nichts zu tun ist.`;
    const model = (Netlify.env.get("OPENROUTER_MODELS") || "openai/gpt-5.6-luna").split(",")[0].trim();
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(20000),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "HTTP-Referer": "https://pl-scout-oetterli.netlify.app", "X-Title": "PL Scout" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 700 }),
      });
      const d: any = await r.json().catch(() => null);
      const m = String(d?.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/);
      if (!m) return json(200, { ok: false, reason: d?.error?.message || "keine JSON-Antwort" });
      const j = JSON.parse(m[0]);
      const add = (Array.isArray(j.add) ? j.add : []).map(String).slice(0, 8), remove = (Array.isArray(j.remove) ? j.remove : []).map(String).slice(0, 20);
      const out = add.length || remove.length ? await updateMemory(k, add, remove) : notes;
      return json(200, { ok: true, added: add.length, removed: remove.length, notes: out });
    } catch (e: any) { return json(200, { ok: false, reason: String(e?.message || e).slice(0, 120) }); }
  }

  // Prognose-Schnappschuss vor einem Spieltag: lesen und speichern (für die Auswertung)
  if (path.endsWith("/predsnap")) {
    if (req.method === "GET") { const gw = Number(url.searchParams.get("gw")); if (!(gw >= 1 && gw <= 38)) return json(400, { error: "gw fehlt" }); return json(200, (await loadPredSnap(gw)) || {}, { "cache-control": "no-store" }); }
    if (req.method === "POST") { const body: any = await req.json().catch(() => null); const gw = Number(body?.gw); if (!(gw >= 1 && gw <= 38)) return json(400, { error: "gw fehlt" }); return json(200, await savePredSnap(gw, body?.preds, { own: body?.own, sl: body?.sl, model: body?.model })); }
  }

  // KI-Spielvorschau: lesen (alle), speichern (nur die Edge-Funktion mit Geheimnis)
  if (path.endsWith("/matches")) {
    const gw = Number(url.searchParams.get("gw"));
    if (req.method === "GET") { if (!(gw >= 1 && gw <= 38)) return json(400, { error: "gw fehlt" }); return json(200, (await loadMatchAi(gw)) || {}, { "cache-control": "no-store" }); }
    if (req.method === "POST") {
      const secret = Netlify.env.get("KI_SECRET");
      if (!secret || req.headers.get("x-ki-secret") !== secret) return json(401, { error: "nicht erlaubt" });
      const body: any = await req.json().catch(() => null);
      const g = Number(body?.gw); if (!(g >= 1 && g <= 38)) return json(400, { error: "gw fehlt" });
      return json(200, await saveMatchAi(g, body));
    }
  }

  // Favoriten: lesen und speichern (geräteübergreifend)
  if (path.endsWith("/fav")) {
    const k = String(url.searchParams.get("k") || "");
    if (!/^[0-9a-z_-]{3,60}$/i.test(k)) return json(400, { error: "ungültig" });
    if (req.method === "GET") return json(200, await loadFavs(k), { "cache-control": "no-store" });
    if (req.method === "POST") { const body: any = await req.json().catch(() => ({})); return json(200, await saveFavs(k, body?.ids, body?.start)); }
  }

  // Gedächtnis: lesen (Seite + Coach), Notiz löschen (Seite), Notizen ändern (nur Coach mit Geheimnis)
  if (path.endsWith("/memory")) {
    const k = String(url.searchParams.get("k") || "");
    if (!/^[0-9a-z_-]{3,60}$/i.test(k)) return json(400, { error: "ungültig" });
    if (req.method === "GET") return json(200, { notes: await loadMemory(k) }, { "cache-control": "no-store" });
    const body: any = await req.json().catch(() => ({}));
    if (req.method === "DELETE") return json(200, { notes: await updateMemory(k, [], [String(body?.id || "")]) });
    if (req.method === "POST") {
      const secret = Netlify.env.get("KI_SECRET");
      if (!secret || req.headers.get("x-ki-secret") !== secret) return json(401, { error: "nicht erlaubt" });
      const add = (Array.isArray(body?.add) ? body.add : []).map(String).slice(0, 8);
      const remove = (Array.isArray(body?.remove) ? body.remove : []).map(String).slice(0, 20);
      return json(200, { notes: await updateMemory(k, add, remove) });
    }
  }

  return json(404, { error: "unbekannt" });
};

export const config: Config = { path: ["/api/ki/ratings", "/api/ki/watchlist", "/api/ki/due", "/api/ki/save", "/api/ki/quota", "/api/ki/memory", "/api/ki/remember", "/api/ki/fav", "/api/ki/matches", "/api/ki/predsnap"] };
