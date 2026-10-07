// Speicher für KI-Bewertungen und Beobachtungsliste (Netlify Blobs)
import { getStore } from "@netlify/blobs";
import type { Info, Rating } from "./rate.ts";

const store = () => getStore({ name: "pl-scout-ki", consistency: "strong" });
export const MAX_AGE_H = 20;

export async function loadRatings(): Promise<{ ratings: Record<string, Rating>; meta: any }> {
  const s = store();
  const [ratings, meta] = await Promise.all([s.get("ratings", { type: "json" }), s.get("meta", { type: "json" })]);
  return { ratings: (ratings as any) || {}, meta: (meta as any) || {} };
}
export async function loadWatch(): Promise<Info[]> {
  return (((await store().get("watchlist", { type: "json" })) as any)?.players) || [];
}
export async function saveWatch(players: Info[]) {
  await store().setJSON("watchlist", { players: players.slice(0, 300), ts: Date.now() });
}
export async function mergeRatings(add: Record<string, Rating>, info: { error?: string } = {}) {
  const s = store();
  const { ratings, meta } = await loadRatings();
  Object.assign(ratings, add);
  const n = Object.keys(add).length;
  await s.setJSON("ratings", ratings);
  await s.setJSON("meta", { ...meta, lastRun: Date.now(), lastCount: n, lastError: info.error || (n ? "" : meta.lastError || "") });
  return Object.keys(ratings).length;
}
export async function noteError(error: string) {
  const s = store(); const { meta } = await loadRatings();
  await s.setJSON("meta", { ...meta, lastRun: Date.now(), lastError: error });
}
export async function dueList(n = 15) {
  const [watch, { ratings }] = await Promise.all([loadWatch(), loadRatings()]);
  const now = Date.now();
  const due = watch.filter((p) => !ratings[p.id] || now - ratings[p.id].ts > MAX_AGE_H * 3600e3)
    .sort((a, b) => (ratings[a.id]?.ts || 0) - (ratings[b.id]?.ts || 0));
  return { due: due.slice(0, n), pending: due.length, total: watch.length };
}

// Harte Tageslimits (Schutz vor Kosten): zählt Aufrufe pro Tag und Art
export const DAILY_LIMITS: Record<string, number> = { coach: 40, bot: 25 };
export async function takeQuota(kind: string): Promise<{ ok: boolean; used: number; limit: number }> {
  const limit = DAILY_LIMITS[kind] ?? 0;
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
  const s = store(); const key = `quota-${day}`;
  const q: any = (await s.get(key, { type: "json" })) || {};
  const used = q[kind] || 0;
  if (used >= limit) return { ok: false, used, limit };
  q[kind] = used + 1;
  await s.setJSON(key, q);
  return { ok: true, used: used + 1, limit };
}
