// KI-Einzelbewertung von Spielern: aktuelle Schlagzeilen holen und per Groq bewerten.
// Läuft sowohl in Netlify Functions (Node) als auch in Edge Functions (Deno).

export type Info = { id: number; name: string; club: string; pos: string; line: string; sid?: string; score?: number };
export type SlNews = { date: string; ts: number; title: string; text: string };
export type Headline = { title: string; source: string; date: string; ts: number };
// v2: r = verfeinerter Score, b = berechneter Score, auf dem die KI aufgebaut hat
export type Rating = { r: number; t: string; ts: number; b?: number; v?: number; n?: { title: string; source: string; date: string }[] };

const decode = (t: string) => t
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/<[^>]+>/g, "").trim();
const tag = (xml: string, name: string) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };

export async function headlinesFor(name: string, max = 4): Promise<Headline[]> {
  const q = encodeURIComponent(`"${name}" when:7d`);
  try {
    const r = await fetch(`https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; PLScout/1.0)" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const last = name.split(" ").pop()!.toLowerCase();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const it = m[1];
      const source = tag(it, "source");
      let title = tag(it, "title");
      if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
      const ts = Date.parse(tag(it, "pubDate")) || 0;
      return { title, source, ts, date: ts ? new Date(ts).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "short" }) : "" };
    }).filter((h) => h.title.toLowerCase().includes(last)).sort((a, b) => b.ts - a.ts).slice(0, max);
  } catch { return []; }
}

// Sleeper-News (Rotowire): Titel + Beschreibung, letzte 14 Tage
export async function sleeperNews(sid?: string, max = 2): Promise<SlNews[]> {
  if (!sid || !/^\d+$/.test(sid)) return [];
  try {
    const r = await fetch(`https://api.sleeper.com/players/clubsoccer/${sid}/news`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const arr: any[] = await r.json();
    const lim = Date.now() - 14 * 864e5;
    return (Array.isArray(arr) ? arr : []).filter((n) => n && n.published > lim).sort((a, b) => b.published - a.published).slice(0, max).map((n) => ({
      ts: n.published, title: String(n.metadata?.title || "").slice(0, 120), text: String(n.metadata?.description || "").slice(0, 260),
      date: new Date(n.published).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "short" }),
    }));
  } catch { return []; }
}

export function todayAndSeason() {
  const now = new Date();
  const today = now.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "long", year: "numeric" });
  const y = now.getUTCFullYear(), start = now.getUTCMonth() >= 6 ? y : y - 1;
  return { today, season: `${start}/${String(start + 1).slice(-2)}` };
}

export async function rateBatch(infos: Info[], apiKey: string, model?: string): Promise<Record<number, Rating>> {
  // eigenes Kontingent: kleineres Modell zuerst, bei Limit das nächste
  // Bot nutzt nie das grosse 120b-Modell – dessen Tageskontingent bleibt für den Coach reserviert
  const models = model ? [model] : ["openai/gpt-oss-20b"];
  const { today, season } = todayAndSeason();
  const [news, sl] = await Promise.all([
    Promise.all(infos.map((i) => headlinesFor(i.name))),
    Promise.all(infos.map((i) => sleeperNews(i.sid))),
  ]);
  const blocks = infos.map((i, k) => {
    const h = news[k].length ? news[k].map((n) => `    - ${n.date}: ${n.title} (${n.source})`).join("\n") : "    - (keine Schlagzeilen in den letzten 7 Tagen)";
    const s = sl[k].length ? `\n  Sleeper-News (Rotowire, zuverlässig):\n` + sl[k].map((n) => `    - ${n.date}: ${n.title} – ${n.text}`).join("\n") : "";
    return `ID ${i.id} | ${i.name} (${i.club}, ${i.pos}) | BERECHNETER SCORE: ${i.score ?? "unbekannt"} | ${i.line}${s}\n  Schlagzeilen:\n${h}`;
  }).join("\n\n");

  const system = `Du bist Scout für Fantasy-Fussball (englische Premier League, Saison ${season}). Heute ist ${today}.
Jeder Spieler hat einen BERECHNETEN SCORE (0–100): Spielerqualität im Vergleich zu seiner Position, nur aus Zahlen (Form, Punkte pro 90, xG/xA, Einsatzzeit, Ballbeteiligung, Verletzungsstatus).
Deine Aufgabe: Gib einen VERFEINERTEN SCORE zurück – eine genauere Schätzung desselben Werts, weil du zusätzlich News, Trainer-Aussagen, Rolle, Rotation, Transfer und Fitness kennst, die die Zahlen nicht sehen.
- Der Score misst, WIE GUT der Spieler ist – nicht, ob er gerade verfügbar ist. Verletzungen und Sperren werden separat in Prognose und Einsatzminuten berücksichtigt: dafür NICHTS abziehen.
- Ohne relevante News: nahe am berechneten Score bleiben (höchstens ±3).
- Positive Qualitäts-Signale (neue offensivere Rolle, Formhoch bestätigt, Trainer setzt klar auf ihn): bis +10.
- Negative Qualitäts-Signale (verliert Stammplatz an Konkurrenten, Formkrise laut Trainer, schwächere Rolle): bis −8.
- Die Sleeper-News (Rotowire) sind am zuverlässigsten, die Schlagzeilen ergänzen.
- Achtung Namensvettern: Schlagzeilen, die nicht eindeutig diesen Fussballer dieses Klubs betreffen (andere Person, anderer Sport, Todesanzeige), ignorieren. Hat er laut Zahlen zuletzt gespielt und melden weder Sleeper noch die Premier League eine Verletzung, gilt er als verfügbar.
- Ist der berechnete Score unbekannt, schätze ihn selbst aus den Zahlen.
- SPRACHE: "t" immer auf DEUTSCH, auch wenn die News englisch sind. Keine Zahl wie «+5» im Text, die Abweichung steht schon im Score.
- "t": ein Satz auf Deutsch (Schweizer Rechtschreibung, kein ß), max. 140 Zeichen: warum du vom berechneten Score abweichst (oder dass nichts dagegen spricht), mit Datum der wichtigsten News. Verletzungsstatus darfst du erwähnen, er ändert den Score aber nicht.
Antworte NUR mit JSON in genau diesem Format: {"ratings":[{"id":123,"r":72,"t":"..."}]}`;

  let data: any = null, lastErr = "";
  for (const m of models) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(22000),
      body: JSON.stringify({
        model: m,
        messages: [{ role: "system", content: system }, { role: "user", content: blocks + "\n\nAntworte nur mit dem JSON. Jede Begründung \"t\" auf Deutsch (Schweizer Rechtschreibung)." }],
        ...(m.startsWith("openai/") ? { reasoning_effort: "low" } : {}),
        temperature: 0.3,
        max_completion_tokens: 3500,
      }),
    });
    const d: any = await res.json().catch(() => null);
    if (res.ok) { data = d; break; }
    lastErr = `Groq ${res.status} (${m}): ${d?.error?.message || ""}`.slice(0, 300);
    if (res.status !== 429 && res.status !== 404 && res.status !== 400) break;
  }
  if (!data) throw new Error(lastErr || "Groq nicht erreichbar");
  const text = String(data?.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Keine JSON-Antwort von der KI");
  const parsed = JSON.parse(m[0]);
  const out: Record<number, Rating> = {};
  const ts = Date.now();
  for (const x of parsed.ratings || []) {
    const id = Number(x.id); const k = infos.findIndex((i) => i.id === id);
    if (k < 0 || !isFinite(Number(x.r))) continue;
    out[id] = {
      r: Math.max(0, Math.min(100, Math.round(Number(x.r)))),
      t: String(x.t || "").slice(0, 220), ts, v: 4,
      ...(Number.isFinite(infos[k].score) ? { b: infos[k].score } : {}),
      n: [...sl[k].slice(0, 1).map(({ title, date }) => ({ title, source: "Sleeper", date })), ...news[k].slice(0, 3).map(({ title, source, date }) => ({ title, source, date }))].slice(0, 3),
    };
  }
  return out;
}
