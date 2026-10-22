// KI-Spielvorschau für alle Partien des nächsten Spieltags: wie die Teams voraussichtlich spielen, Ausfälle, Tipp.
// Ein Aufruf mit Websuche (OpenRouter) für alle Spiele zusammen; Ergebnis wird pro Spieltag gespeichert (/api/ki/matches).
// Tageslimit «match» schützt vor Kosten. Antwort als NDJSON-Stream (status / done / error), damit kein Zeitlimit greift.
//   POST /api/matches-ai  { gw: 8, data: "<Spiele mit Quoten, Form, Ausfällen …>" }

declare const Netlify: { env: { get(key: string): string | undefined } };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const system = (today: string, season: string) => `Du bist ein erfahrener Fussball-Analyst für die englische Premier League. HEUTE IST ${today}, Saison ${season}.
Für jedes Spiel in der Liste schreibst du eine kurze Vorschau:
- wie beide Teams voraussichtlich spielen werden (System, Spielweise: Ballbesitz, Pressing, Konter, Standards; wer das Spiel macht),
- wichtige Ausfälle, Rückkehrer oder Rotation und was das fürs Spiel bedeutet,
- ein Tipp fürs Resultat und der Spieler, auf den es am meisten ankommt.
Nutze die Websuche für die aktuellen Team-News dieser Woche (Verletzungen, Sperren, Pressekonferenzen, voraussichtliche Aufstellungen) – suche gezielt mit Teamnamen, Monat und Jahr. Ignoriere Meldungen aus früheren Saisons.
Die mitgelieferten Zahlen (Quoten, Siegchancen, erwartete Tore, Tabelle, Form, xG, Ausfälle) sind aktuell und massgebend. Erfinde keine Statistiken.
Antworte NUR mit gültigem JSON, ohne Markdown und ohne Text davor oder danach:
{"matches":[{"id":<Spiel-ID aus der Liste>,"text":"2–3 Sätze, höchstens 330 Zeichen","tipp":"2:1","key":"Name des Schlüsselspielers"}]}
Genau ein Eintrag pro Spiel. Deutsch in Schweizer Rechtschreibung (kein ß).`;

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "Nur POST erlaubt." });
  const orKey = Netlify.env.get("OPENROUTER_API_KEY") || "", secret = Netlify.env.get("KI_SECRET") || "";
  if (!orKey || !secret) return json(500, { error: "OPENROUTER_API_KEY oder KI_SECRET fehlt in Netlify." });
  let body: { gw?: number; data?: string };
  try { body = await req.json(); } catch { return json(400, { error: "Ungültige Anfrage." }); }
  const gw = Number(body.gw), data = String(body.data || "").slice(0, 14000);
  if (!(gw >= 1 && gw <= 38) || data.length < 50) return json(400, { error: "Spieltag oder Spieldaten fehlen." });

  const q = await fetch(new URL("/api/ki/quota", req.url), { method: "POST", headers: { "content-type": "application/json", "x-ki-secret": secret }, body: JSON.stringify({ kind: "match" }) })
    .then((r) => r.json()).catch(() => null);
  if (!q?.ok) return json(429, { error: `Tageslimit für Spielanalysen erreicht (${q?.limit ?? "?"} pro Tag) – morgen wieder möglich.` });

  const now = new Date();
  const today = now.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "long", year: "numeric" });
  const y = now.getUTCFullYear(), startYear = now.getUTCMonth() >= 6 ? y : y - 1;
  const season = `${startYear}/${String(startYear + 1).slice(-2)}`;
  const models = (Netlify.env.get("OPENROUTER_MODELS") || "openai/gpt-5.6-luna,anthropic/claude-haiku-5.5").split(",").map((x) => x.trim()).filter(Boolean);
  const plan: [string, boolean][] = [[models[0], true], ...(models[1] ? [[models[1], true] as [string, boolean]] : []), [models[0], false]];
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* Client weg */ } };
      const errs: string[] = [];
      for (const [m, search] of plan) {
        send({ t: "status", c: search ? "KI recherchiert die Team-News und schreibt die Vorschau …" : "KI schreibt die Vorschau …" });
        let r: Response;
        try {
          r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST", signal: AbortSignal.timeout(150000),
            headers: { "content-type": "application/json", authorization: `Bearer ${orKey}`, "HTTP-Referer": "https://pl-scout-oetterli.netlify.app", "X-Title": "PL Scout" },
            body: JSON.stringify({ model: m, stream: true, max_tokens: 6000, reasoning: { max_tokens: 2500, exclude: true },
              messages: [{ role: "system", content: system(today, season) }, { role: "user", content: `SPIELTAG ${gw}:\n${data}` }],
              ...(search ? { plugins: [{ id: "web", engine: "native", max_results: 8 }], web_search_options: { search_context_size: "medium" } } : {}),
              usage: { include: true } }),
          });
        } catch { errs.push(`${m}: Verbindung/Zeit`); continue; }
        if (!r.ok || !r.body) { errs.push(`${m}: ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`); continue; }
        const reader = r.body.getReader(), dec = new TextDecoder();
        let buf = "", text = "", cost = 0, n = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const d = line.slice(5).trim(); if (d === "[DONE]") continue;
            let j: any; try { j = JSON.parse(d); } catch { continue; }
            const c = j.choices?.[0]?.delta?.content;
            if (c) { text += c; if (++n % 40 === 0) send({ t: "status", c: `Vorschau wird geschrieben … (${text.length} Zeichen)` }); }
            if (j.usage?.cost != null) cost = Number(j.usage.cost) || 0;
          }
        }
        const raw = text.replace(/【[^】]*】/g, "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
        let items: any[] = [];
        try { const s = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1); items = JSON.parse(s).matches || []; } catch { /* unten */ }
        if (!items.length) { errs.push(`${m}: keine gültige Antwort`); continue; }
        const saved = await fetch(new URL("/api/ki/matches", req.url), { method: "POST", headers: { "content-type": "application/json", "x-ki-secret": secret },
          body: JSON.stringify({ gw, items, model: m + (search ? " + Websuche" : ""), cost }) }).then((x) => x.json()).catch(() => null);
        send({ t: "done", ...(saved?.items?.length ? saved : { gw, ts: Date.now(), items, model: m, cost }) });
        ctrl.close(); return;
      }
      send({ t: "error", error: "Die Spielanalyse konnte gerade nicht erstellt werden. Bitte später nochmals versuchen.", detail: errs.join(" · ") });
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
};

export const config = { path: "/api/matches-ai" };
