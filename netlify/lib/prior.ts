// Vorsaison-Daten (FPL element-summary → history_past) als «Klasse»-Prior für den Score
import { getStore } from "@netlify/blobs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const KEEP = ["minutes", "starts", "goals_scored", "assists", "clean_sheets", "goals_conceded", "saves", "penalties_saved", "penalties_missed",
  "yellow_cards", "red_cards", "own_goals", "tackles", "clearances_blocks_interceptions", "recoveries", "expected_goals", "expected_assists", "expected_goals_conceded", "total_points"];
export const priorStore = () => getStore({ name: "fpl-prior" });
export function lastSeasonName(d = new Date(), back = 1) {
  const y = d.getUTCFullYear(), start = d.getUTCMonth() >= 6 ? y : y - 1; // laufende Saison beginnt im Sommer
  return `${start - back}/${String(start - back + 1).slice(-2)}`;
}
export const SEASONS = () => [1, 2, 3].map((b) => lastSeasonName(new Date(), b)); // letzte 3 PL-Saisons
const VERSION = 2;
const fpl = async (path: string) => {
  const r = await fetch(`https://fantasy.premierleague.com/api/${path}`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`FPL ${r.status}`);
  return r.json();
};
// Sammelt pro Aufruf bis zu `max` noch fehlende Spieler (Vorsaison ändert sich nicht mehr)
export async function collectPrior(max = 160, budgetMs = 22000) {
  const t0 = Date.now(), s = priorStore(), season = lastSeasonName();
  const cur: any = (await s.get("prior", { type: "json" }).catch(() => null)) || {};
  const data = cur.season === season && cur.v === VERSION ? cur : { season, v: VERSION, seasons: SEASONS(), p: {} as Record<string, any>, h: {} as Record<string, any> };
  data.h ||= {};
  const boot = await fpl("bootstrap-static/");
  const ids: number[] = boot.elements.map((e: any) => e.id).filter((id: number) => !(String(id) in data.p));
  const todo = ids.slice(0, max);
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < todo.length && Date.now() - t0 < budgetMs) {
      const id = todo[i++];
      try {
        const es = await fpl(`element-summary/${id}/`);
        const pick = (name: string) => { const h = (es.history_past || []).find((x: any) => x.season_name === name); return h && h.minutes > 0 ? Object.fromEntries(KEEP.map((k) => [k, Number(h[k]) || 0])) : null; };
        data.p[id] = pick(season);
        const older: Record<string, any> = {};
        for (const sn of data.seasons.slice(1)) { const x = pick(sn); if (x) older[sn] = x; }
        if (Object.keys(older).length) data.h[id] = older;
      } catch { /* nächster Lauf */ }
    }
  }));
  data.ts = Date.now(); data.missing = ids.length - todo.filter((id) => String(id) in data.p).length;
  await s.setJSON("prior", data);
  return { season, done: Object.keys(data.p).length, missing: data.missing };
}
