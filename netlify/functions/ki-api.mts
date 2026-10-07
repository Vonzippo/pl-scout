// API für KI-Bewertungen: lesen, Beobachtungsliste setzen, fällige Spieler, Ergebnisse speichern
import type { Config } from "@netlify/functions";
import { loadRatings, saveWatch, dueList, mergeRatings, noteError, takeQuota } from "../lib/kistore.ts";

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
      .map((p: any) => ({ id: p.id, name: String(p.name).slice(0, 60), club: String(p.club || "").slice(0, 5), pos: String(p.pos || "").slice(0, 4), line: String(p.line || "").slice(0, 300) }));
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

  return json(404, { error: "unbekannt" });
};

export const config: Config = { path: ["/api/ki/ratings", "/api/ki/watchlist", "/api/ki/due", "/api/ki/save", "/api/ki/quota"] };
