// Sleeper-Gesamtbild als Text: Liga, Tabelle, alle Kader, FAAB, Transaktionen, Verletzungen, Trends, News, KI-Score.
// Für den KI-Coach (kompakt) und zum Abrufen von aussen (?full=1).
//   /api/digest?league=<id>&me=<user_id>[&full=1][&format=json]
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { loadRatings, loadWatch } from "../lib/kistore.ts";

const DEFAULT_LEAGUE = "1393632953241735168";
const V1 = "https://api.sleeper.app/v1/";
const POS: Record<string, string> = { GK: "TW", G: "TW", D: "VER", M: "MIT", F: "STU" };
const ST: Record<string, string> = { out: "fällt aus", sus: "gesperrt", ir: "langzeitverletzt", questionable: "fraglich", doubtful: "unwahrscheinlich", probable: "wahrscheinlich fit", na: "nicht verfügbar" };
const stDe = (x?: string | null) => (x ? ST[String(x).toLowerCase()] || x : "");
const day = (t: number | string | undefined) => { const n = typeof t === "string" ? Date.parse(t) : Number(t); return n ? new Date(n).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "short" }) : "?"; };

async function get(url: string, ms = 7000): Promise<any> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
type P = { n: string; t: string; p: string[]; inj?: string; ret?: string; since?: string; tc?: number; num?: number; age?: number };
async function playersMin(): Promise<Record<string, P>> {
  const s = getStore({ name: "sleeper-cache" });
  const c: any = await s.get("players_min_v2", { type: "json" }).catch(() => null);
  if (c && Date.now() - c.ts < 3 * 3600e3) return c.p;
  try {
    const all = await get(V1 + "players/clubsoccer:epl", 15000);
    const p: Record<string, P> = {};
    for (const [id, x] of Object.entries<any>(all)) {
      if (!x) continue;
      const md = x.metadata || {};
      p[id] = { n: x.full_name || `${x.first_name || ""} ${x.last_name || ""}`.trim(), t: x.team_abbr || "", p: (x.fantasy_positions || [x.position]).filter(Boolean),
        ...(x.injury_status ? { inj: x.injury_status, ret: md.soccer_injury_return_date, since: md.soccer_injury_status_started_at } : {}),
        ...(x.team_changed_at ? { tc: x.team_changed_at } : {}), ...(x.number ? { num: x.number } : {}), ...(x.age ? { age: x.age } : {}) };
    }
    // Veraltete Verzeichnis-Einträge mit den Spielerdaten aus aktuellen Stats/Prognosen korrigieren
    // (z. B. ID 1031 ist inzwischen James Trafford, im Verzeichnis aber noch «Nottingham Forest» als Team-Abwehr)
    try {
      const st: any = await get(V1 + "state/clubsoccer:epl");
      const season = Number(st.season) || new Date().getFullYear(), wk = Math.max(1, Number(st.week) || 1);
      const urls = [`projections/clubsoccer:epl/${season}/${wk}`, ...[wk - 1, wk - 2].filter((w) => w >= 1).map((w) => `stats/clubsoccer:epl/${season}/${w}`)];
      const feeds = await Promise.allSettled(urls.map((x) => get(`https://api.sleeper.com/${x}?season_type=regular`, 8000)));
      const isPl = (x: any) => !!x && ["GK", "G", "D", "M", "F"].includes((x.fantasy_positions || [])[0] || x.position);
      const toks = (v: string) => (v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z]+/).filter((t) => t.length > 1);
      for (const f of feeds) if (f.status === "fulfilled" && Array.isArray(f.value)) for (const e of f.value as any[]) {
        const id = String(e.player_id), pl = e.player; if (!pl || !isPl(pl)) continue;
        const raw = (all as any)[id];
        if (raw && isPl(raw) && toks(pl.last_name).some((t) => toks(raw.last_name || raw.full_name).includes(t))) continue;
        p[id] = { n: pl.metadata?.full_name || `${pl.first_name || ""} ${pl.last_name || ""}`.trim(), t: pl.team_abbr || "", p: (pl.fantasy_positions || [pl.position]).filter(Boolean), ...(pl.injury_status ? { inj: pl.injury_status } : {}) };
      }
    } catch { /* Verzeichnis unverändert */ }
    await s.setJSON("players_min_v2", { ts: Date.now(), p }).catch(() => {});
    return p;
  } catch (e) { if (c) return c.p; throw e; }
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export default async (req: Request) => {
  const u = new URL(req.url);
  const league = /^\d{5,25}$/.test(u.searchParams.get("league") || "") ? u.searchParams.get("league")! : DEFAULT_LEAGUE;
  const me = /^\d{3,25}$/.test(u.searchParams.get("me") || "") ? u.searchParams.get("me")! : "";
  const full = u.searchParams.get("full") === "1";
  const asJson = u.searchParams.get("format") === "json";
  const t0 = Date.now();

  const [lg, users, rosters, state, P, trendAdd, trendDrop, ki, watch] = await Promise.all([
    get(V1 + `league/${league}`), get(V1 + `league/${league}/users`), get(V1 + `league/${league}/rosters`),
    get(V1 + "state/clubsoccer:epl").catch(() => ({})), playersMin(),
    get(V1 + "players/clubsoccer:epl/trending/add?lookback_hours=24&limit=25").catch(() => []),
    get(V1 + "players/clubsoccer:epl/trending/drop?lookback_hours=24&limit=25").catch(() => []),
    loadRatings().catch(() => ({ ratings: {} as any, meta: {} })), loadWatch().catch(() => []),
  ]);
  const week = Number(state.leg || state.week) || 1;
  const team: Record<string, string> = {}, ownerName: Record<string, string> = {};
  for (const x of users || []) { ownerName[x.user_id] = x.display_name || ""; team[x.user_id] = x.metadata?.team_name || x.display_name || "Team"; }
  const byRid: Record<number, any> = {}; const ownerOf: Record<string, string> = {};
  for (const r of rosters || []) { byRid[r.roster_id] = r; for (const pid of r.players || []) ownerOf[pid] = r.owner_id; }
  const tName = (rid: number) => team[byRid[rid]?.owner_id] || `Team ${rid}`;
  const kiBySid: Record<string, any> = {}, lineBySid: Record<string, string> = {};
  for (const w of watch as any[]) { if (w.sid && ki.ratings[w.id]) kiBySid[w.sid] = ki.ratings[w.id]; if (w.sid && w.line) lineBySid[w.sid] = w.line; }
  const pName = (pid: string) => { const p = P[pid]; return p ? `${p.n} (${p.t} ${p.p.map((x) => POS[x] || x).join("/")})` : pid; };
  const status = (pid: string) => { const p = P[pid]; return p?.inj ? `${stDe(p.inj)}${p.ret ? ", zurück ca. " + day(p.ret) : ""}` : ""; };
  const kiTxt = (pid: string) => { const k = kiBySid[pid]; if (!k || Date.now() - k.ts > 48 * 3600e3) return ""; return k.v >= 2 && k.b != null ? `Score ${k.r} (Rechnung ${k.b}): ${k.t}` : `KI ${k.r}: ${k.t}`; };

  // Transaktionen
  const weeks = full ? Array.from({ length: week }, (_, i) => i + 1) : [week - 2, week - 1, week].filter((w) => w >= 1);
  const tx = (await Promise.all(weeks.map((w) => get(V1 + `league/${league}/transactions/${w}`).catch(() => [])))).flat()
    .filter((t: any) => t && t.status === "complete").sort((a: any, b: any) => (b.status_updated || b.created) - (a.status_updated || a.created));
  const txLines = tx.slice(0, full ? 200 : 25).map((t: any) => {
    const when = day(t.status_updated || t.created);
    const adds = Object.entries<number>(t.adds || {}), drops = Object.entries<number>(t.drops || {});
    if (t.type === "trade") {
      const parts = (t.roster_ids || []).map((rid: number) => {
        const got = adds.filter(([, r]) => r === rid).map(([pid]) => P[pid]?.n || pid);
        const faab = (t.waiver_budget || []).filter((b: any) => b.receiver === rid).reduce((s: number, b: any) => s + b.amount, 0);
        return `${tName(rid)} erhält ${[...got, ...(faab ? [faab + " $ FAAB"] : [])].join(", ") || "nichts"}`;
      });
      return `- ${when} TRADE: ${parts.join(" · ")}`;
    }
    const rid = (t.roster_ids || [])[0];
    const what = t.type === "waiver" ? `Waiver${t.settings?.waiver_bid != null ? " (" + t.settings.waiver_bid + " $)" : ""}` : "Free Agent";
    return `- ${when} ${what}: ${tName(rid)}${adds.length ? " holt " + adds.map(([pid]) => P[pid]?.n || pid).join(", ") : ""}${drops.length ? " · gibt ab " + drops.map(([pid]) => P[pid]?.n || pid).join(", ") : ""}`;
  });

  // News: mein Kader + verletzte Kaderspieler (+ alle Kaderspieler bei full)
  const myR = (rosters || []).find((r: any) => r.owner_id === me);
  const injured = Object.keys(ownerOf).filter((pid) => P[pid]?.inj);
  const newsIds = [...new Set([...(myR?.players || []), ...injured, ...(full ? Object.keys(ownerOf) : [])])].slice(0, full ? 220 : 45);
  const budget = Math.max(2000, (full ? 20000 : 8000) - (Date.now() - t0));
  const deadline = Date.now() + budget;
  const news: Record<string, any> = {};
  await pool(newsIds, 12, async (pid) => {
    if (Date.now() > deadline) return;
    try {
      const arr = await get(`https://api.sleeper.com/players/clubsoccer/${pid}/news`, 4000);
      const n = (Array.isArray(arr) ? arr : []).filter((x: any) => x?.published > Date.now() - 14 * 864e5).sort((a: any, b: any) => b.published - a.published)[0];
      if (n) news[pid] = { date: day(n.published), title: n.metadata?.title || "", text: String(n.metadata?.description || "").slice(0, full ? 400 : 220) };
    } catch { /* ignorieren */ }
  });

  const budgetTotal = lg.settings?.waiver_budget ?? 100;
  const table = [...(rosters || [])].sort((a: any, b: any) => (b.settings?.wins || 0) - (a.settings?.wins || 0) || (b.settings?.fpts || 0) + (b.settings?.fpts_decimal || 0) / 100 - (a.settings?.fpts || 0) - (a.settings?.fpts_decimal || 0) / 100);
  const pts = (s: any, k: string) => ((s?.[k] || 0) + (s?.[k + "_decimal"] || 0) / 100).toFixed(1);
  const playerLine = (pid: string) => { const s = status(pid), k = kiTxt(pid), n = news[pid];
    return `${pName(pid)}${s ? " ⚠ " + s : ""}${k ? " | " + k : ""}${n ? ` | News ${n.date}: ${n.title} – ${n.text}` : ""}`; };

  if (asJson) {
    return Response.json({ league: { id: league, name: lg.name, season: lg.season, week, roster_positions: lg.roster_positions, waiver_budget: budgetTotal, scoring_settings: lg.scoring_settings },
      teams: table.map((r: any) => ({ roster_id: r.roster_id, owner_id: r.owner_id, team: team[r.owner_id], owner: ownerName[r.owner_id], wins: r.settings?.wins, losses: r.settings?.losses, ties: r.settings?.ties, fpts: +pts(r.settings, "fpts"), fpts_against: +pts(r.settings, "fpts_against"), faab_left: budgetTotal - (r.settings?.waiver_budget_used || 0),
        starters: (r.starters || []).filter((x: string) => x && x !== "0").map((pid: string) => ({ id: pid, ...P[pid], ki: kiBySid[pid] || null, news: news[pid] || null })),
        bench: (r.players || []).filter((x: string) => !(r.starters || []).includes(x)).map((pid: string) => ({ id: pid, ...P[pid], ki: kiBySid[pid] || null, news: news[pid] || null })) })),
      transactions: txLines, trending: { add: trendAdd, drop: trendDrop }, generated: new Date().toISOString() },
      { headers: { "cache-control": "public, max-age=60", "netlify-cdn-cache-control": "public, s-maxage=300, stale-while-revalidate=600" } });
  }

  const out: string[] = [];
  out.push(`# Sleeper-Liga «${lg.name}» (Premier League, Saison ${lg.season}) – Stand ${new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}, Spieltag ${week}`);
  out.push(`Kaderplätze: ${(lg.roster_positions || []).join(", ")} · FAAB-Budget ${budgetTotal} $ · ${lg.total_rosters} Teams`);
  out.push(`\n## Tabelle (Bilanz · Punkte für/gegen · FAAB übrig)`);
  table.forEach((r: any, i: number) => out.push(`${i + 1}. ${team[r.owner_id]}${ownerName[r.owner_id] ? " (" + ownerName[r.owner_id] + ")" : ""}${r.owner_id === me ? " ← ICH" : ""}: ${r.settings?.wins || 0}-${r.settings?.losses || 0}${r.settings?.ties ? "-" + r.settings.ties : ""} · ${pts(r.settings, "fpts")}/${pts(r.settings, "fpts_against")} · FAAB ${budgetTotal - (r.settings?.waiver_budget_used || 0)} $`));
  const rosterBlock = (r: any, detail: boolean) => {
    const st = (r.starters || []).filter((x: string) => x && x !== "0"), bench = (r.players || []).filter((x: string) => !st.includes(x));
    const f = (pid: string) => (detail ? playerLine(pid) : `${pName(pid)}${status(pid) ? " ⚠ " + status(pid) : ""}`);
    return detail ? `Startelf:\n${st.map((p: string) => "- " + f(p)).join("\n")}\nBank:\n${bench.map((p: string) => "- " + f(p)).join("\n")}`
      : `Startelf: ${st.map(f).join("; ")}\nBank: ${bench.map(f).join("; ")}`;
  };
  if (myR) { out.push(`\n## Mein Team: ${team[me]}`); out.push(rosterBlock(myR, true)); }
  out.push(`\n## Kader der anderen Teams`);
  for (const r of table) if (r.owner_id !== me) out.push(`### ${team[r.owner_id]}\n${rosterBlock(r, full)}`);
  const injOthers = injured.filter((pid) => ownerOf[pid] !== me);
  if (injOthers.length) out.push(`\n## Verletzte/gesperrte Spieler in anderen Kadern\n${injOthers.map((pid) => `- ${pName(pid)} – ${team[ownerOf[pid]]}: ${status(pid)}${news[pid] && !full ? ` (News ${news[pid].date}: ${news[pid].title})` : ""}`).join("\n")}`);
  out.push(`\n## Transaktionen (${full ? "ganze Saison" : "letzte 3 Spieltage"}, neueste zuerst)\n${txLines.join("\n") || "- keine"}`);
  const tr = (arr: any[]) => arr.slice(0, 12).map((x: any) => `${P[x.player_id]?.n || x.player_id} (${P[x.player_id]?.t || ""}, ${x.count}×${ownerOf[x.player_id] ? ", bei " + team[ownerOf[x.player_id]] : ", FREI"})`).join("; ");
  // Beste freie Spieler nach PL-Scout-Score (inkl. KI-Feinschliff), mit Zahlen
  const freeBest = (watch as any[]).filter((w) => w.sid && !ownerOf[w.sid]).map((w) => ({ w, k: ki.ratings[w.id] }))
    .map((x) => ({ ...x, sc: x.k && x.k.v >= 2 ? x.k.r : x.w.score ?? 0 })).sort((a, b) => b.sc - a.sc).slice(0, full ? 40 : 15);
  if (freeBest.length) out.push(`\n## Beste FREIE Spieler (PL-Scout-Score 0–100 inkl. KI-Feinschliff)\n` + freeBest.map(({ w, k, sc }) =>
    `- ${w.name} (${w.club} ${w.pos}) Score ${sc}${status(w.sid) ? " ⚠ " + status(w.sid) : ""}${k ? " – " + k.t : ""}${full ? " | " + w.line : ""}`).join("\n"));
  if (full && myR) out.push(`\n## Zahlen zu meinem Kader (Score-Bausteine, Minuten, Tore, xG, nächste Gegner)\n` + (myR.players || []).filter((pid: string) => lineBySid[pid]).map((pid: string) => `- ${P[pid]?.n || pid}: ${lineBySid[pid]}`).join("\n"));
  out.push(`\n## Sleeper-Trend letzte 24 h (alle Sleeper-Ligen)\nMeistgeholt: ${tr(trendAdd)}\nMeistabgegeben: ${tr(trendDrop)}`);
  return new Response(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60", "netlify-cdn-cache-control": "public, s-maxage=300, stale-while-revalidate=600" } });
};

export const config: Config = { path: "/api/digest" };
