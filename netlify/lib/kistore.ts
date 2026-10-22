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
  // tiefe Bewertungen (Ausfall) alle 6 h neu prüfen – Status ändert sich schnell, Fehlalarme verschwinden
  // Alte Bewertungen (vor v2, nicht auf den Score aufgebaut) sofort neu machen
  const due = watch.filter((p) => !ratings[p.id] || (ratings[p.id] as any).v !== 4 || now - ratings[p.id].ts > (ratings[p.id].r <= 20 ? 6 : MAX_AGE_H) * 3600e3)
    .sort((a, b) => (ratings[a.id]?.ts || 0) - (ratings[b.id]?.ts || 0));
  return { due: due.slice(0, n), pending: due.length, total: watch.length };
}

// Harte Tageslimits (Schutz vor Kosten): zählt Aufrufe pro Tag und Art
export const DAILY_LIMITS: Record<string, number> = { coach: 40, bot: 25, mem: 60, match: 4 };
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

// Gedächtnis des Coaches pro Liga + Nutzer: dauerhafte Notizen (Vorlieben, Entscheide, Trades, Pläne)
export type Note = { id: string; t: string; ts: number };
const memKey = (k: string) => "memory-" + k.replace(/[^0-9a-z_-]/gi, "").slice(0, 60);
export async function loadMemory(k: string): Promise<Note[]> {
  return (((await store().get(memKey(k), { type: "json" })) as any)?.notes) || [];
}
export async function updateMemory(k: string, add: string[], remove: string[]): Promise<Note[]> {
  const notes = (await loadMemory(k)).filter((n) => !remove.includes(n.id));
  const now = Date.now();
  for (const t of add) {
    const x = String(t || "").trim().slice(0, 240);
    if (x && !notes.some((n) => n.t.toLowerCase() === x.toLowerCase())) notes.push({ id: now.toString(36) + Math.random().toString(36).slice(2, 6), t: x, ts: now });
  }
  const keep = notes.slice(-60);
  await store().setJSON(memKey(k), { notes: keep });
  return keep;
}

// Markierungen pro Liga + Nutzer: ids = 🔒 behalten (nie abgeben), start = ★ immer aufstellen (und behalten)
const favKeyOf = (k: string) => "fav-" + k.replace(/[^0-9a-z_-]/gi, "").slice(0, 60);
const cleanIds = (a: unknown) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 60);
export async function loadFavs(k: string): Promise<{ ids: number[]; start: number[] }> {
  const v: any = await store().get(favKeyOf(k), { type: "json" });
  return { ids: cleanIds(v?.ids), start: cleanIds(v?.start) };
}
export async function saveFavs(k: string, ids: unknown, start: unknown) {
  const s = cleanIds(start), keep = cleanIds(ids).filter((x) => !s.includes(x));
  await store().setJSON(favKeyOf(k), { ids: keep, start: s, ts: Date.now() });
  return { ids: keep, start: s };
}

// KI-Spielvorschau pro Spieltag (alle Geräte sehen dieselbe Analyse)
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export async function loadMatchAi(gw: number): Promise<any> {
  return (await store().get(`match-ai-${gw}`, { type: "json" }).catch(() => null)) || null;
}
export async function saveMatchAi(gw: number, d: any) {
  const items = (Array.isArray(d?.items) ? d.items : []).slice(0, 12)
    .map((x: any) => ({ id: Number(x?.id) || 0, text: clip(x?.text, 700), tipp: clip(x?.tipp, 12), key: clip(x?.key, 80) }))
    .filter((x: any) => x.id > 0 && x.text);
  const out = { gw, ts: Date.now(), model: clip(d?.model, 80), cost: Number(d?.cost) || 0, items };
  if (items.length) await store().setJSON(`match-ai-${gw}`, out);
  return out;
}
