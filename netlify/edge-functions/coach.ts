// KI-Coach: leitet Fragen mit Team-Kontext an die Claude API weiter (inkl. Websuche)
// und streamt die Antwort zurück. Der API-Schlüssel bleibt auf dem Server.
//
// Netlify-Umgebungsvariablen:
//   ANTHROPIC_API_KEY  (Pflicht)  – Schlüssel von console.anthropic.com
//   COACH_PASSWORD     (empfohlen) – Zugangspasswort, damit niemand sonst deinen Schlüssel nutzt
//   COACH_MODEL        (optional) – Standard: claude-sonnet-5-5

declare const Netlify: { env: { get(key: string): string | undefined } };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "Nur POST erlaubt." });

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(500, { error: "ANTHROPIC_API_KEY ist in Netlify nicht gesetzt." });

  const pw = Netlify.env.get("COACH_PASSWORD");
  if (pw && !timingSafeEqual(req.headers.get("x-coach-key") || "", pw)) {
    return json(401, { error: "Falsches oder fehlendes Coach-Passwort." });
  }

  let body: { messages?: { role: string; content: string }[]; context?: unknown; today?: string };
  try { body = await req.json(); } catch { return json(400, { error: "Ungültige Anfrage." }); }

  const messages = (body.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json(400, { error: "Keine Frage erhalten." });
  }

  const context = JSON.stringify(body.context ?? {}).slice(0, 60000);
  const today = (body.today || new Date().toISOString().slice(0, 10)).slice(0, 40);

  const system = `Du bist «PL Scout Coach», ein erfahrener Fantasy-Fussball-Berater für eine Sleeper-Liga der englischen Premier League.
Heute ist ${today}.

So arbeitest du:
- Nutze die Daten im KONTEXT unten (Saisonstatistiken aus der offiziellen Fantasy-Premier-League-API, Prognosen nach den Punkteregeln des Nutzers, Spielplan mit Gegnerstärke 1 = leicht bis 5 = schwer, Kader der Sleeper-Liga).
- Nutze die Websuche für alles Aktuelle: Verletzungen, Sperren, Pressekonferenzen, voraussichtliche Aufstellungen, Rotation, Form. Suche gezielt (z. B. «<Spieler> injury news», «<Klub> predicted lineup gameweek»), bevorzugt seriöse Quellen von heute oder den letzten Tagen. Nenne das Datum einer Meldung, wenn es relevant ist.
- Gib konkrete Empfehlungen: wen aufstellen, wen auf die Bank, wen vom Waiver holen und wen dafür abgeben. Begründe kurz mit Zahlen (Pkt/90, xG/xA, Minuten, Gegner) und aktuellen News.
- Empfiehl nur Spieler, die laut Kontext frei sind oder dem Nutzer gehören, ausser er fragt ausdrücklich nach anderen.
- Sei ehrlich bei Unsicherheit (z. B. «Einsatz fraglich»). Erfinde keine Statistiken.
- Antworte auf Deutsch in Schweizer Rechtschreibung (kein ß, «ss» verwenden), kompakt und gut lesbar mit kurzen Abschnitten oder Listen. Kein Vorwort.

KONTEXT (JSON):
${context}`;

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: Netlify.env.get("COACH_MODEL") || "claude-sonnet-5-5",
      max_tokens: 3000,
      stream: true,
      system,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try { const e = await upstream.json(); detail = e?.error?.message || ""; } catch { /* leer */ }
    return json(upstream.status || 502, { error: `Claude API Fehler ${upstream.status}${detail ? ": " + detail : ""}` });
  }

  return new Response(upstream.body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
};

export const config = { path: "/api/coach" };
