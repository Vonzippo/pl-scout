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

const SYSTEM = `Du bist «PL Scout Coach», ein erfahrener Fantasy-Fussball-Berater für eine Sleeper-Liga der englischen Premier League.
- Die Nachricht des Nutzers enthält seine Frage und seine Daten (Saisonstats aus der offiziellen FPL-API, Prognosen nach seinen Punkteregeln, Spielplan mit Gegnerstärke, Kader der Liga).
- Nutze die Websuche für alles Aktuelle: Verletzungen, Sperren, Pressekonferenzen, voraussichtliche Aufstellungen, Rotation. Bevorzuge seriöse, aktuelle Quellen und nenne das Datum einer Meldung, wenn es wichtig ist.
- Gib konkrete Empfehlungen (aufstellen, Bank, Waiver holen/abgeben) mit kurzer Begründung aus Zahlen und News.
- Empfiehl nur Spieler aus dem Kader des Nutzers oder freie Spieler, ausser er fragt ausdrücklich nach anderen.
- Erfinde keine Statistiken; sag ehrlich, wenn etwas unsicher ist.
- Antworte auf Deutsch in Schweizer Rechtschreibung (kein ß), kompakt, mit kurzen Abschnitten oder Listen in Markdown. Kein Vorwort.`;

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "Nur POST erlaubt." });

  const apiKey = Netlify.env.get("GROQ_API_KEY");
  if (!apiKey) return json(500, { error: "GROQ_API_KEY ist in Netlify nicht gesetzt." });

  const pw = Netlify.env.get("COACH_PASSWORD");
  if (pw && !safeEqual(req.headers.get("x-coach-key") || "", pw)) {
    return json(401, { error: "Falsches oder fehlendes Coach-Passwort." });
  }

  let body: { messages?: { role: string; content: string }[] };
  try { body = await req.json(); } catch { return json(400, { error: "Ungültige Anfrage." }); }

  const messages = (body.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 16000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return json(400, { error: "Keine Frage erhalten." });

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: Netlify.env.get("COACH_MODEL") || "openai/gpt-oss-120b",
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: [{ type: "browser_search" }],
      tool_choice: "auto",
      reasoning_effort: "medium",
      temperature: 0.6,
      max_completion_tokens: 4096,
    }),
  });

  let data: any = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    return json(res.status === 429 ? 429 : 502, { error: res.status === 429 ? "Groq-Limit erreicht – bitte kurz warten." : `Groq Fehler: ${msg}` });
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

  return json(200, { answer: answer || "(Keine Antwort erhalten – bitte nochmals versuchen.)", sources, queries, truncated: data?.choices?.[0]?.finish_reason === "length" });
};

export const config = { path: "/api/coach" };
