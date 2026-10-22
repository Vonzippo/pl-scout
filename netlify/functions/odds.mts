// Wettquoten Premier League: Siegchancen (1X2), Über/Unter 2.5 Tore und daraus die erwarteten Tore pro Team.
// Quelle 1: The Odds API (nur wenn ODDS_API_KEY gesetzt ist – Gratis-Kontingent 500 Abfragen/Monat, hier max. ~6 pro Tag)
// Quelle 2: football-data.co.uk/fixtures.csv (gratis, ohne Schlüssel; die Wochenend-Spiele erscheinen meist ab Donnerstag/Freitag)
//   GET /api/odds  →  { ts, src, remaining, rows: [{ home, away, hk, ak, ko, src, books, odds, best, p, over25, xg }] }
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

declare const Netlify: { env: { get(key: string): string | undefined } };

type Trio = { h: number; d: number; a: number };
type Row = { home: string; away: string; hk: string; ak: string; ko: number | null; src: string; books: number; odds: Trio | null; best: Trio | null; p: Trio; over25: number | null; xg: { h: number; a: number } };

const TEAM: [RegExp, string][] = [
  [/^(manchester city|man city)$/, "mci"], [/^(manchester united|manchester utd|man united|man utd)$/, "mun"],
  [/^(nott ?m forest|nottingham forest|nottingham)$/, "nfo"], [/^(tottenham( hotspur)?|spurs)$/, "tot"],
  [/^brighton( and hove albion)?$/, "bha"], [/^(wolverhampton( wanderers)?|wolves)$/, "wol"], [/^west ham( united| utd)?$/, "whu"],
  [/^newcastle( united| utd)?$/, "new"], [/^leeds( united| utd)?$/, "lee"], [/^sheffield (united|utd)$/, "shu"], [/^west brom(wich albion)?$/, "wba"],
  [/^ipswich( town)?$/, "ips"], [/^hull( city)?$/, "hul"], [/^coventry( city)?$/, "cov"], [/^leicester( city)?$/, "lei"], [/^norwich( city)?$/, "nor"],
  [/^stoke( city)?$/, "sto"], [/^luton( town)?$/, "lut"], [/^cardiff( city)?$/, "car"], [/^swansea( city)?$/, "swa"], [/^derby( county)?$/, "der"],
  [/^(bournemouth)$/, "bou"], [/^aston villa$/, "avl"], [/^crystal palace$/, "cry"], [/^sunderland$/, "sun"], [/^arsenal$/, "ars"], [/^chelsea$/, "che"],
  [/^liverpool$/, "liv"], [/^everton$/, "eve"], [/^fulham$/, "ful"], [/^brentford$/, "bre"], [/^southampton$/, "sou"], [/^burnley$/, "bur"],
  [/^middlesbrough$/, "mid"], [/^watford$/, "wat"], [/^sheffield wednesday$/, "shw"], [/^(qpr|queens park rangers)$/, "qpr"],
];
function teamKey(n: string): string {
  const s = (n || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z ]/g, " ")
    .replace(/\b(fc|afc)\b/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, k] of TEAM) if (re.test(s)) return k;
  return s;
}

// ---------- Poisson: Siegchancen und Über 2.5 aus erwarteten Toren; erwartete Tore aus Quoten zurückrechnen ----------
function outcome(lh: number, la: number) {
  const ph: number[] = [], pa: number[] = [];
  let fh = Math.exp(-lh), fa = Math.exp(-la);
  for (let k = 0; k <= 10; k++) { ph.push(fh); pa.push(fa); fh *= lh / (k + 1); fa *= la / (k + 1); }
  let h = 0, d = 0, u = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const q = ph[i] * pa[j]; if (i > j) h += q; else if (i === j) d += q; if (i + j <= 2) u += q; }
  return { h, d, a: Math.max(0, 1 - h - d), o: 1 - u };
}
function fitGoals(p: Trio, over: number | null): { h: number; a: number } {
  const err = (h: number, a: number) => { const o = outcome(h, a); return (o.h - p.h) ** 2 + (o.d - p.d) ** 2 + (o.a - p.a) ** 2 + (over != null ? (o.o - over) ** 2 : 0); };
  let best = { e: Infinity, h: 1.4, a: 1.1 };
  for (let h = 0.1; h <= 4.01; h += 0.05) for (let a = 0.1; a <= 4.01; a += 0.05) { const e = err(h, a); if (e < best.e) best = { e, h, a }; }
  const h0 = best.h, a0 = best.a;
  for (let h = h0 - 0.05; h <= h0 + 0.051; h += 0.01) for (let a = a0 - 0.05; a <= a0 + 0.051; a += 0.01) { if (h <= 0.05 || a <= 0.05) continue; const e = err(h, a); if (e < best.e) best = { e, h, a }; }
  return { h: Math.round(best.h * 100) / 100, a: Math.round(best.a * 100) / 100 };
}
const fair = (o: Trio): Trio => { const s = 1 / o.h + 1 / o.d + 1 / o.a; return { h: 1 / o.h / s, d: 1 / o.d / s, a: 1 / o.a / s }; };
const r2 = (x: number) => Math.round(x * 100) / 100, r3 = (x: number) => Math.round(x * 1000) / 1000;
const finish = (base: Omit<Row, "xg">): Row => ({ ...base, p: { h: r3(base.p.h), d: r3(base.p.d), a: r3(base.p.a) }, over25: base.over25 != null ? r3(base.over25) : null, xg: fitGoals(base.p, base.over25) });

// ---------- Quelle 1: The Odds API ----------
async function fromOddsApi(key: string): Promise<{ rows: Row[]; remaining: string | null }> {
  const url = `https://api.the-odds-api.com/v4/sports/soccer_epl/odds/?apiKey=${encodeURIComponent(key)}&regions=eu&markets=h2h,totals&oddsFormat=decimal&dateFormat=unix`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Odds API ${r.status}`);
  const data: any[] = await r.json();
  const rows: Row[] = [];
  for (const ev of data || []) {
    const H = ev.home_team, A = ev.away_team;
    const ps: Trio[] = [], os: Trio[] = [], overs: number[] = [];
    let pin: { o: Trio; p: Trio; over: number | null } | null = null;
    const best: Trio = { h: 0, d: 0, a: 0 };
    for (const b of ev.bookmakers || []) {
      const h2h = (b.markets || []).find((m: any) => m.key === "h2h");
      const tot = (b.markets || []).find((m: any) => m.key === "totals");
      let o: Trio | null = null;
      if (h2h) {
        const g = (nm: string) => Number((h2h.outcomes || []).find((x: any) => x.name === nm)?.price) || 0;
        const t = { h: g(H), d: g("Draw"), a: g(A) };
        if (t.h > 1 && t.d > 1 && t.a > 1) { o = t; os.push(t); ps.push(fair(t)); best.h = Math.max(best.h, t.h); best.d = Math.max(best.d, t.d); best.a = Math.max(best.a, t.a); }
      }
      let ov: number | null = null;
      if (tot) {
        const ou = (nm: string) => (tot.outcomes || []).find((x: any) => x.name === nm && Number(x.point) === 2.5);
        const O = Number(ou("Over")?.price), U = Number(ou("Under")?.price);
        if (O > 1 && U > 1) { ov = (1 / O) / (1 / O + 1 / U); overs.push(ov); }
      }
      if (b.key === "pinnacle" && o) pin = { o, p: fair(o), over: ov };
    }
    if (!ps.length) continue;
    const avg = (k: keyof Trio) => ps.reduce((t, x) => t + x[k], 0) / ps.length;
    const avgO = (k: keyof Trio) => os.reduce((t, x) => t + x[k], 0) / os.length;
    const p = pin ? pin.p : { h: avg("h"), d: avg("d"), a: avg("a") };
    const over = pin?.over ?? (overs.length ? overs.reduce((t, x) => t + x, 0) / overs.length : null);
    rows.push(finish({ home: H, away: A, hk: teamKey(H), ak: teamKey(A), ko: ev.commence_time ? Number(ev.commence_time) * 1000 : null,
      src: pin ? "Pinnacle (The Odds API)" : `Ø ${ps.length} Wettanbieter (The Odds API)`, books: ps.length,
      odds: pin ? pin.o : { h: r2(avgO("h")), d: r2(avgO("d")), a: r2(avgO("a")) }, best, p, over25: over }));
  }
  return { rows, remaining: r.headers.get("x-requests-remaining") };
}

// ---------- Quelle 2: football-data.co.uk ----------
const lastSunday = (y: number, m: number) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
function ukToUtc(date: string, time: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(date || ""); if (!m) return null;
  const d = +m[1], mo = +m[2] - 1, y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const [hh, mm] = (time || "15:00").split(":").map(Number);
  const bst = (mo > 2 && mo < 9) || (mo === 2 && d >= lastSunday(y, 2)) || (mo === 9 && d < lastSunday(y, 9));
  return Date.UTC(y, mo, d, (hh || 0) - (bst ? 1 : 0), mm || 0);
}
async function fromFootballData(): Promise<Row[]> {
  const r = await fetch("https://www.football-data.co.uk/fixtures.csv", { signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (compatible; PLScout/1.0)" } });
  if (!r.ok) throw new Error(`football-data ${r.status}`);
  const lines = (await r.text()).replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const head = lines.shift()!.split(",").map((x) => x.trim());
  const rows: Row[] = [];
  for (const ln of lines) {
    const c = ln.split(","), v = (k: string) => c[head.indexOf(k)];
    if (v("Div") !== "E0") continue;
    const num = (k: string) => { const x = Number(v(k)); return x > 1 ? x : 0; };
    const trio = (pre: string) => { const t = { h: num(pre + "H"), d: num(pre + "D"), a: num(pre + "A") }; return t.h && t.d && t.a ? t : null; };
    const pick = trio("PS") ? ["PS", "Pinnacle"] : trio("Avg") ? ["Avg", "Ø Wettanbieter"] : trio("B365") ? ["B365", "Bet365"] : null;
    if (!pick) continue;
    const o = trio(pick[0])!;
    const ouPre = [["P", "PS"], ["Avg", "Avg"], ["B365", "B365"]].map(([x]) => x).find((x) => num(x + ">2.5") && num(x + "<2.5"));
    const over = ouPre ? (1 / num(ouPre + ">2.5")) / (1 / num(ouPre + ">2.5") + 1 / num(ouPre + "<2.5")) : null;
    const books = head.filter((k) => /H$/.test(k) && !/^(Max|Avg|HTH|FTH|AH|B365AH|PAH|MaxAH|AvgAH)/.test(k) && num(k) && head.includes(k.slice(0, -1) + "A")).length;
    rows.push(finish({ home: v("HomeTeam"), away: v("AwayTeam"), hk: teamKey(v("HomeTeam")), ak: teamKey(v("AwayTeam")), ko: ukToUtc(v("Date"), v("Time")),
      src: `${pick[1]} (football-data.co.uk)`, books, odds: o, best: trio("Max"), p: fair(o), over25: over }));
  }
  return rows;
}

export default async (req: Request) => {
  const store = getStore({ name: "odds-cache" });
  const cached: any = await store.get("epl-v1", { type: "json" }).catch(() => null);
  const key = Netlify.env.get("ODDS_API_KEY") || "";
  const ttl = (key ? 4 : 2) * 3600e3;
  const out = (body: unknown, cdn = 600) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", "netlify-cdn-cache-control": `public, s-maxage=${cdn}` } });
  if (cached && Date.now() - cached.ts < ttl && !new URL(req.url).searchParams.has("force")) return out(cached);
  let rows: Row[] = [], src = "", remaining: string | null = null, errors: string[] = [];
  if (key) { try { const r = await fromOddsApi(key); rows = r.rows; remaining = r.remaining; src = "the-odds-api"; } catch (e) { errors.push(String((e as Error).message || e)); } }
  if (!rows.length) { try { rows = await fromFootballData(); src = "football-data"; } catch (e) { errors.push(String((e as Error).message || e)); } }
  if (!rows.length && cached?.rows?.length) return out({ ...cached, stale: true, errors });
  const body = { ts: Date.now(), src, remaining, rows, errors, hasKey: !!key };
  if (rows.length) await store.setJSON("epl-v1", body).catch(() => {});
  return out(body, rows.length ? 1800 : 300);
};

export const config: Config = { path: "/api/odds" };
