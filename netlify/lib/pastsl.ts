// Vergangene Saisons aus den Sleeper-Stats (Premier League + LaLiga, Bundesliga, Serie A, Ligue 1)
// Gleiche Stat-Schlüssel wie die Liga-Wertung → exakte Punkte, auch für Zuzüge aus anderen Top-Ligen.
import { getStore } from "@netlify/blobs";

export const COMPS = ["epl", "laliga", "bundesliga", "seriea", "ligue1"];
const WEEKS = 38;
export const pastStore = () => getStore({ name: "sleeper-past" });
const get = async (url: string, ms = 8000) => {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};
export function pastSeasons(d = new Date()) {
  const y = d.getUTCFullYear(), start = d.getUTCMonth() >= 6 ? y : y - 1; // laufende Saison
  return [start - 1, start - 2, start - 3];
}
async function eplIds(): Promise<Set<string>> {
  const c: any = await getStore({ name: "sleeper-cache" }).get("players_min_v1", { type: "json" }).catch(() => null);
  if (c?.p) return new Set(Object.keys(c.p));
  const all = await get("https://api.sleeper.app/v1/players/clubsoccer:epl", 15000);
  return new Set(Object.keys(all));
}
export async function collectPast(budgetMs = 20000) {
  const t0 = Date.now(), s = pastStore(), seasons = pastSeasons();
  const cur: any = (await s.get("agg", { type: "json" }).catch(() => null)) || {};
  const data = cur.key === seasons.join(",") ? cur : { key: seasons.join(","), seasons, done: {} as Record<string, number>, p: {} as Record<string, any> };
  const units: string[] = [];
  for (const se of seasons) for (const c of COMPS) for (let w = 1; w <= WEEKS; w++) { const u = `${c}:${se}:${w}`; if (!(u in data.done)) units.push(u); }
  if (!units.length) return { missing: 0 };
  const ids = await eplIds();
  let i = 0, changed = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < units.length && Date.now() - t0 < budgetMs) {
      const u = units[i++]; const [c, se, w] = u.split(":");
      try {
        const arr = await get(`https://api.sleeper.com/stats/clubsoccer:${c}/${se}/${w}?season_type=regular`);
        for (const e of Array.isArray(arr) ? arr : []) {
          const sid = String(e?.player_id || ""); const st = e?.stats;
          if (!ids.has(sid) || !st || !(Number(st.min) > 0)) continue;
          const acc = (((data.p[sid] ||= {})[se] ||= {})[c] ||= { gp: 0 });
          acc.gp += 1;
          for (const [k, v] of Object.entries(st)) if ((k === "min" || k === "gs" || k === "g" || k === "at" || k === "cs" || k.startsWith("pos_")) && typeof v === "number") acc[k] = Math.round(((acc[k] || 0) + v) * 100) / 100;
        }
        data.done[u] = 1; changed++;
      } catch { /* nächster Lauf */ }
    }
  }));
  data.missing = units.length - changed; data.ts = Date.now();
  await s.setJSON("agg", data);
  return { missing: data.missing };
}
