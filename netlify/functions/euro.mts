// Europapokal und Ligapokal der Premier-League-Klubs (Champions League, Europa League, Conference League, EFL-Cup):
// Spiele der letzten und nächsten Tage + wer gespielt hat (Startelf / eingewechselt) – für Rotations-Hinweise.
// Quelle: öffentliche Spielplan-Daten von ESPN (ohne Schlüssel), 3 Std. zwischengespeichert.
//   GET /api/euro  →  { ts, events: [{ id, comp, label, ko, state, home, away, hk, ak, hs, as, players: [{ k, n, s, i, o, a }] | null }] }
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const COMPS: [string, string, string][] = [
  ["uefa.champions", "CL", "Champions League"], ["uefa.europa", "EL", "Europa League"],
  ["uefa.europa.conf", "ECL", "Conference League"], ["eng.league_cup", "LC", "Ligapokal"],
];
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/";
const TEAM: [RegExp, string][] = [
  [/^(manchester city|man city)$/, "mci"], [/^(manchester united|manchester utd|man united|man utd)$/, "mun"],
  [/^(nott ?m forest|nottingham forest|nottingham)$/, "nfo"], [/^(tottenham( hotspur)?|spurs)$/, "tot"],
  [/^brighton( and hove albion)?$/, "bha"], [/^(wolverhampton( wanderers)?|wolves)$/, "wol"], [/^west ham( united| utd)?$/, "whu"],
  [/^newcastle( united| utd)?$/, "new"], [/^leeds( united| utd)?$/, "lee"], [/^ipswich( town)?$/, "ips"], [/^hull( city)?$/, "hul"],
  [/^coventry( city)?$/, "cov"], [/^leicester( city)?$/, "lei"], [/^(bournemouth)$/, "bou"], [/^aston villa$/, "avl"], [/^crystal palace$/, "cry"],
  [/^sunderland$/, "sun"], [/^arsenal$/, "ars"], [/^chelsea$/, "che"], [/^liverpool$/, "liv"], [/^everton$/, "eve"], [/^fulham$/, "ful"],
  [/^brentford$/, "bre"], [/^southampton$/, "sou"], [/^burnley$/, "bur"],
];
const ENG = new Set(TEAM.map(([, k]) => k));
function teamKey(n: string): string {
  const s = (n || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z ]/g, " ")
    .replace(/\b(fc|afc)\b/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, k] of TEAM) if (re.test(s)) return k;
  return s;
}
async function get(url: string, ms = 6000): Promise<any> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");

export default async (req: Request) => {
  const store = getStore({ name: "euro-cache" });
  const cached: any = await store.get("v1", { type: "json" }).catch(() => null);
  const out = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "netlify-cdn-cache-control": "public, s-maxage=1800" } });
  if (cached && Date.now() - cached.ts < 3 * 3600e3 && !new URL(req.url).searchParams.has("force")) return out(cached);
  const now = Date.now(), dates: string[] = [];
  for (let d = -11; d <= 11; d++) { const t = now + d * 864e5, wd = new Date(t).getUTCDay(); if (wd >= 2 && wd <= 4) dates.push(ymd(t)); } // Di–Do
  const jobs = COMPS.flatMap(([lg, code, label]) => dates.map((d) => ({ lg, code, label, d })));
  const res = await pool(jobs, 8, async (j) => { try { return { j, data: await get(`${BASE}${j.lg}/scoreboard?dates=${j.d}`) }; } catch { return { j, data: null }; } });
  const events = new Map<string, any>();
  for (const { j, data } of res) for (const e of data?.events || []) {
    const cs = e.competitions?.[0]?.competitors || [];
    const H = cs.find((x: any) => x.homeAway === "home"), A = cs.find((x: any) => x.homeAway === "away");
    if (!H || !A) continue;
    const hk = teamKey(H.team?.displayName || ""), ak = teamKey(A.team?.displayName || "");
    if (!ENG.has(hk) && !ENG.has(ak)) continue;
    const state = e.status?.type?.state || "pre";
    events.set(String(e.id), { id: String(e.id), lg: j.lg, comp: j.code, label: j.label, ko: Date.parse(e.date), state,
      home: H.team?.displayName || "", away: A.team?.displayName || "", hk, ak,
      hs: state !== "pre" && H.score != null ? Number(H.score) : null, as: state !== "pre" && A.score != null ? Number(A.score) : null, players: null });
  }
  // Wer hat gespielt? Aufstellungen der beendeten Spiele (letzte 11 Tage)
  const done = [...events.values()].filter((e) => e.state === "post" && e.ko > now - 11 * 864e5);
  await pool(done, 6, async (e) => {
    try {
      const sm = await get(`${BASE}${e.lg}/summary?event=${e.id}`);
      const pl: any[] = [];
      for (const t of sm.rosters || []) {
        const k = teamKey(t.team?.displayName || ""); if (!ENG.has(k)) continue;
        for (const p of t.roster || []) {
          const app = (p.stats || []).find((s: any) => s.name === "appearances");
          pl.push({ k, n: p.athlete?.displayName || "", s: !!p.starter, i: !!p.subbedIn, o: !!p.subbedOut, a: app ? Number(app.value) > 0 : !!(p.starter || p.subbedIn) });
        }
      }
      if (pl.length) e.players = pl;
    } catch { /* ohne Aufstellung */ }
  });
  const body = { ts: Date.now(), events: [...events.values()].map(({ lg, ...e }) => e).sort((a, b) => a.ko - b.ko) };
  if (body.events.length || !cached) await store.setJSON("v1", body).catch(() => {});
  return out(body);
};

export const config: Config = { path: "/api/euro" };
