// KI-Coach über Groq (openai/gpt-oss-120b mit eingebauter Websuche).
// Der API-Schlüssel bleibt auf dem Server und ist nie im Browser sichtbar.
//
// Netlify-Umgebungsvariablen:
//   GROQ_API_KEY    (Pflicht)
//   COACH_PASSWORD  (empfohlen) – damit nur du den Coach nutzen kannst
//   COACH_MODEL     (optional)  – Standard: openai/gpt-oss-120b

declare const Netlify: { env: { get(key: string): string | undefined } };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const systemPrompt = (today: string, season: string) => `Du bist «PL Scout Coach», ein erfahrener Fantasy-Fussball-Berater für eine Sleeper-Liga der englischen Premier League.
HEUTE IST ${today}. Es läuft die Premier-League-Saison ${season}.
- WICHTIG zur Aktualität: Suche immer mit aktuellem Monat und Jahr bzw. der Saison ${season} im Suchbegriff (z. B. «Saka injury news ${today.split(" ").slice(-2).join(" ")}»). Ignoriere Meldungen aus früheren Saisons. Findest du nichts Aktuelles, sag das klar statt alte News wiederzugeben.
- Die Nachricht des Nutzers enthält seine Frage und seine Daten (Saisonstats aus der offiziellen FPL-API, Prognosen nach seinen Punkteregeln, Spielplan mit Gegnerstärke, Kader der Liga).
- Nutze die Websuche für alles Aktuelle: Verletzungen, Sperren, Pressekonferenzen, voraussichtliche Aufstellungen, Rotation. Bevorzuge seriöse, aktuelle Quellen und nenne das Datum einer Meldung, wenn es wichtig ist.
- Gib konkrete Empfehlungen (aufstellen, Bank, Waiver holen/abgeben) mit kurzer Begründung aus Zahlen und News.
- Empfiehl nur Spieler aus dem Kader des Nutzers oder freie Spieler, ausser er fragt ausdrücklich nach anderen.
- Erfinde keine Statistiken; sag ehrlich, wenn etwas unsicher ist.
- Antworte auf Deutsch in Schweizer Rechtschreibung (kein ß), kompakt, mit kurzen Abschnitten oder Listen in Markdown. Kein Vorwort.`;

// ---------- News: aktuelle Schlagzeilen über Google News RSS ----------
type NewsItem = { player: string; title: string; source: string; date: string; ts: number; url: string };
const decode = (t: string) => t
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/<[^>]+>/g, "").trim();
const tag = (xml: string, name: string) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };

async function newsFor(player: string): Promise<NewsItem[]> {
  const q = encodeURIComponent(`"${player}" (injury OR fitness OR "team news" OR lineup OR Premier League) when:7d`);
  try {
    const r = await fetch(`https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; PLScout/1.0)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const lastName = player.split(" ").pop()!.toLowerCase();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const it = m[1];
      const source = tag(it, "source");
      let title = tag(it, "title");
      if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
      const ts = Date.parse(tag(it, "pubDate")) || 0;
      return { player, title, source, ts, url: tag(it, "link"),
        date: ts ? new Date(ts).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "short" }) : "" };
    }).filter((n) => n.title && n.title.toLowerCase().includes(lastName))
      .sort((a, b) => b.ts - a.ts).slice(0, 3);
  } catch { return []; }
}

async function gatherNews(names: unknown): Promise<NewsItem[]> {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim().slice(0, 60));
  const unique = [...new Set(list)].slice(0, 20);
  const all = (await Promise.all(unique.map(newsFor))).flat();
  const seen = new Set<string>();
  return all.filter((n) => { const k = n.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "Nur POST erlaubt." });

  const apiKey = Netlify.env.get("GROQ_API_KEY");
  if (!apiKey) return json(500, { error: "GROQ_API_KEY ist in Netlify nicht gesetzt." });

  const pw = Netlify.env.get("COACH_PASSWORD");
  if (pw && !safeEqual(req.headers.get("x-coach-key") || "", pw)) {
    return json(401, { error: "Falsches oder fehlendes Coach-Passwort." });
  }

  let body: { messages?: { role: string; content: string }[]; news?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: "Ungültige Anfrage." }); }

  const messages = (body.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 16000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return json(400, { error: "Keine Frage erhalten." });

  const now = new Date();
  const today = now.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "long", year: "numeric" });
  const y = now.getUTCFullYear(), startYear = now.getUTCMonth() >= 6 ? y : y - 1;
  const season = `${startYear}/${String(startYear + 1).slice(-2)}`;

  // Harte Tageslimite gegen Kosten
  const secret = Netlify.env.get("KI_SECRET");
  const q = secret ? await fetch(new URL("/api/ki/quota", req.url), { method: "POST", headers: { "content-type": "application/json", "x-ki-secret": secret }, body: JSON.stringify({ kind: "coach" }) }).then((r) => r.json()).catch(() => null) : null;
  if (!q?.ok) return json(429, { error: `Tageslimit des Coaches erreicht (${q?.limit ?? "?"} Fragen pro Tag) – morgen wieder verfügbar, oder «In Claude öffnen» nutzen.` });

  const news = await gatherNews(body.news);
  const newsBlock = news.length
    ? `\n\nAKTUELLE SCHLAGZEILEN (Google News, letzte 7 Tage, neueste zuerst – vom System soeben abgerufen):\n` +
      news.map((n) => `- [${n.player}] ${n.date}: ${n.title} (${n.source})`).join("\n") +
      `\n\nWerte diese Schlagzeilen zuerst aus (Verletzungen, Sperren, Rotation, Transfers) und beziehe dich mit Datum darauf. Nutze die Websuche, um wichtige Meldungen im Detail zu lesen oder Lücken zu füllen.`
    : "";

  const call = (model: string) => fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt(today, season) + newsBlock }, ...messages],
      tools: [{ type: "browser_search" }],
      tool_choice: "auto",
      reasoning_effort: "medium",
      temperature: 0.6,
      max_completion_tokens: 4096,
    }),
  });
  // Bei Tageslimit auf das kleinere Modell (eigenes Kontingent) ausweichen
  let usedModel = Netlify.env.get("COACH_MODEL") || "openai/gpt-oss-120b";
  let res = await call(usedModel);
  if (res.status === 429 && usedModel !== "openai/gpt-oss-20b") { usedModel = "openai/gpt-oss-20b"; res = await call(usedModel); }

  let data: any = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    return json(res.status === 429 ? 429 : 502, { error: res.status === 429 ? `Groq-Limit erreicht (${/per day|TPD|RPD/.test(msg) ? "Tageskontingent aufgebraucht – morgen wieder verfügbar, oder «In Claude öffnen» nutzen" : "bitte 1 Minute warten"}).` : `Groq Fehler: ${msg}` });
  }

  const msg = data?.choices?.[0]?.message || {};
  // Zitat-Marker wie 【3†L6-L10】 entfernen
  const answer = String(msg.content || "").replace(/【[^】]*】/g, "").trim();

  // Durchsuchte Quellen einsammeln (Feldnamen defensiv, da Groq sie erweitert)
  const sources: { url: string; title?: string }[] = [];
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const t of msg.executed_tools || []) {
    try {
      const args = typeof t.arguments === "string" ? JSON.parse(t.arguments) : t.arguments;
      if (args?.query) queries.push(String(args.query));
    } catch { /* ignorieren */ }
    const results = t?.search_results?.results || [];
    for (const r of results) {
      if (r?.url && !seen.has(r.url) && sources.length < 8) { seen.add(r.url); sources.push({ url: r.url, title: r.title }); }
    }
  }

  return json(200, {
    answer: answer || "(Keine Antwort erhalten – bitte nochmals versuchen.)", sources, queries,
    news: news.map(({ player, title, source, date, url }) => ({ player, title, source, date, url })),
    truncated: data?.choices?.[0]?.finish_reason === "length",
    model: usedModel,
  });
};

export const config = { path: "/api/coach" };
