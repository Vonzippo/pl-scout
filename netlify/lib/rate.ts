// KI-Einzelbewertung von Spielern: aktuelle Schlagzeilen holen und per Groq bewerten.
// Läuft sowohl in Netlify Functions (Node) als auch in Edge Functions (Deno).

export type Info = { id: number; name: string; club: string; pos: string; line: string };
export type Headline = { title: string; source: string; date: string; ts: number };
export type Rating = { r: number; t: string; ts: number; n?: { title: string; source: string; date: string }[] };

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

export function todayAndSeason() {
  const now = new Date();
  const today = now.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "long", year: "numeric" });
  const y = now.getUTCFullYear(), start = now.getUTCMonth() >= 6 ? y : y - 1;
  return { today, season: `${start}/${String(start + 1).slice(-2)}` };
}

export async function rateBatch(infos: Info[], apiKey: string, model?: string): Promise<Record<number, Rating>> {
  // eigenes Kontingent: kleineres Modell zuerst, bei Limit das nächste
  const models = model ? [model] : ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3-32b"];
  const { today, season } = todayAndSeason();
  const news = await Promise.all(infos.map((i) => headlinesFor(i.name)));
  const blocks = infos.map((i, k) => {
    const h = news[k].length ? news[k].map((n) => `    - ${n.date}: ${n.title} (${n.source})`).join("\n") : "    - (keine Schlagzeilen in den letzten 7 Tagen)";
    return `ID ${i.id} | ${i.name} (${i.club}, ${i.pos}) | ${i.line}\n  Schlagzeilen:\n${h}`;
  }).join("\n\n");

  const system = `Du bist Scout für Fantasy-Fussball (englische Premier League, Saison ${season}). Heute ist ${today}.
Bewerte JEDEN Spieler einzeln mit einem KI-Rating von 0 bis 100 für die nächsten 1–3 Spiele:
- Stütze dich vor allem auf die Schlagzeilen (Verletzung, Sperre, Rotation, Trainer-Aussagen, Formkrise/Formhoch, Transfer, Rolle im Team) und ergänze mit den Zahlen.
- Skala: 90–100 = Top-Pick, fast sicher stark; 70–89 = klar aufstellen; 50–69 = solider Stammspieler; 30–49 = Risiko (Rotation, fraglich, schwache Form); 0–29 = fällt aus oder spielt kaum.
- Ein verletzter oder gesperrter Spieler bekommt höchstens 15. Ohne relevante News: Rating aus Einsatzzeit, Form und Rolle ableiten.
- "t": ein Satz Begründung auf Deutsch (Schweizer Rechtschreibung, kein ß), max. 140 Zeichen, nenne die wichtigste News mit Datum, falls vorhanden.
Antworte NUR mit JSON in genau diesem Format: {"ratings":[{"id":123,"r":72,"t":"..."}]}`;

  let data: any = null, lastErr = "";
  for (const m of models) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(22000),
      body: JSON.stringify({
        model: m,
        messages: [{ role: "system", content: system }, { role: "user", content: blocks }],
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
      t: String(x.t || "").slice(0, 220), ts,
      n: news[k].slice(0, 3).map(({ title, source, date }) => ({ title, source, date })),
    };
  }
  return out;
}
