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

export default async (req: Request, context?: any) => {
  if (req.method !== "POST") return json(405, { error: "Nur POST erlaubt." });

  const apiKey = Netlify.env.get("GROQ_API_KEY") || "";
  const orKey = Netlify.env.get("OPENROUTER_API_KEY") || "";
  if (!apiKey && !orKey) return json(500, { error: "Weder OPENROUTER_API_KEY noch GROQ_API_KEY ist in Netlify gesetzt." });

  const pw = Netlify.env.get("COACH_PASSWORD");
  if (pw && !safeEqual(req.headers.get("x-coach-key") || "", pw)) {
    return json(401, { error: "Falsches oder fehlendes Coach-Passwort." });
  }

  let body: { messages?: { role: string; content: string }[]; news?: unknown; league?: string; me?: string; question?: string; stream?: boolean };
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
  if (!q?.ok) return json(429, { error: `Tageslimit des Coaches erreicht (${q?.limit ?? "?"} Fragen pro Tag) – morgen wieder verfügbar.` });

  const gather = async () => {
    // Sleeper-Gesamtbild (Tabelle, alle Kader, FAAB, Transaktionen, Verletzungen, Sleeper-News, KI-Score)
    const lid = /^\d{5,25}$/.test(String(body.league || "")) ? String(body.league) : "";
    const meId = /^\d{3,25}$/.test(String(body.me || "")) ? String(body.me) : "";
    const digestP = lid ? fetch(new URL(`/api/digest?league=${lid}${meId ? "&me=" + meId : ""}`, req.url), { signal: AbortSignal.timeout(14000) })
      .then((r) => (r.ok ? r.text() : "")).catch(() => "") : Promise.resolve("");
    // Gedächtnis aus früheren Gesprächen
    const memK = lid ? `${lid}_${meId || "x"}` : "";
    const memP = memK ? fetch(new URL(`/api/ki/memory?k=${memK}`, req.url), { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).then((j) => j.notes || []).catch(() => []) : Promise.resolve([]);
    const [news, digestRaw, notes] = await Promise.all([gatherNews(body.news), digestP, memP]);
    const memBlock = notes.length ? `\n\nGEDÄCHTNIS (was du dir aus früheren Gesprächen mit dem Nutzer gemerkt hast – berücksichtige es, prüfe es aber gegen die aktuellen Daten):\n` +
      notes.map((n: any) => `- ${new Date(n.ts).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "short" })}: ${n.t}`).join("\n") : "";
    const digest = digestRaw ? `\n\nSLEEPER-DATEN DER LIGA (live von Sleeper, soeben abgerufen – massgebend für Kader, Besitzer, FAAB, Trades, Waiver, Verletzungsstatus; «ICH» = der Nutzer):\n${digestRaw.slice(0, 15000)}` : "";
    const newsBlock = news.length
      ? `\n\nAKTUELLE SCHLAGZEILEN (Google News, letzte 7 Tage, neueste zuerst – vom System soeben abgerufen):\n` +
        news.map((n) => `- [${n.player}] ${n.date}: ${n.title} (${n.source})`).join("\n") +
        `\n\nWerte diese Schlagzeilen zuerst aus (Verletzungen, Sperren, Rotation, Transfers) und beziehe dich mit Datum darauf. Nutze die Websuche, um wichtige Meldungen im Detail zu lesen oder Lücken zu füllen.`
      : "";
    return { news, notes, sys: systemPrompt(today, season) + memBlock + digest + newsBlock };
  };

  // Streaming (OpenRouter): Antwort erscheint laufend, kein 40-Sekunden-Limit der Edge Function
  if (body.stream && orKey) {
    const enc = new TextEncoder();
    const orModelsS = (Netlify.env.get("OPENROUTER_MODELS") || "anthropic/claude-sonnet-5.5,openai/gpt-5.6-luna,anthropic/claude-haiku-5.5").split(",").map((x) => x.trim()).filter(Boolean);
    // 1) Hauptmodell recherchiert selbst (native Websuche), 2) günstigeres Modell ebenfalls mit Suche, 3) Rest ohne Suche
    const planS: [string, boolean, number][] = orModelsS.map((m, i): [string, boolean, number] => [m, i < 2, i === 0 ? 4000 : 1500]);
    const stream = new ReadableStream({
      async start(ctrl) {
        const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* Client weg */ } };
        let errs: string[] = [];
        try {
          send({ t: "status", c: "Lade Liga-Daten, News und Gedächtnis …" });
          const { sys, news, notes } = await gather();
          const newsOut = news.map(({ player, title, source, date, url }) => ({ player, title, source, date, url }));
          for (const [m, search, think] of planS) {
            send({ t: "status", c: search ? "Claude sucht im Web und denkt nach …" : "Claude denkt nach …" });
            const note = search ? `\n\nDu hast eine eigene Websuche. Recherchiere selbständig, wenn es um aktuelle Infos geht (Verletzungen, Pressekonferenzen, voraussichtliche Aufstellungen, Transfers, Formkrisen): suche gezielt mit Spielername + Monat/Saison ${season}, mehrere Suchen sind erlaubt. Nenne Quelle und Datum. Für Kader, FAAB, Scores und Prognosen gelten die Live-Daten oben.` : "\n\n(Hinweis: Websuche ist gerade nicht verfügbar – stütze dich auf die Live-Daten, Sleeper-News und Schlagzeilen oben.)";
            let r: Response;
            try {
              r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST", signal: AbortSignal.timeout(120000),
                headers: { "content-type": "application/json", authorization: `Bearer ${orKey}`, "HTTP-Referer": "https://pl-scout-oetterli.netlify.app", "X-Title": "PL Scout" },
                body: JSON.stringify({ model: m, stream: true, messages: [{ role: "system", content: sys + note }, ...messages], max_tokens: 8000,
                  reasoning: { max_tokens: think, exclude: true },
                  ...(search ? { plugins: [{ id: "web", engine: "native", max_results: 5 }], web_search_options: { search_context_size: "medium" } } : {}),
                  usage: { include: true } }),
              });
            } catch (e) { errs.push(`${m}: Verbindung/Zeit`); continue; }
            if (!r.ok || !r.body) { const tx = await r.text().catch(() => ""); errs.push(`${m}: ${r.status} ${tx.slice(0, 140)}`); continue; }
            const reader = r.body.getReader(), dec = new TextDecoder();
            let buf = "", got = false, cost = 0, err = "";
            const sources: { url: string; title?: string }[] = [];
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") continue;
                let j: any; try { j = JSON.parse(data); } catch { continue; }
                if (j.error) { err = j.error.message || "Fehler"; continue; }
                const ch = j.choices?.[0];
                const c = ch?.delta?.content;
                if (c) { got = true; send({ t: "d", c }); }
                for (const an of ch?.delta?.annotations || ch?.message?.annotations || []) { const u = an?.url_citation; if (u?.url && !sources.some((x) => x.url === u.url) && sources.length < 8) sources.push({ url: u.url, title: u.title }); }
                if (j.usage?.cost != null) cost = Number(j.usage.cost) || 0;
              }
            }
            if (got) { send({ t: "done", model: m + (search ? " + Websuche" : ""), cost, sources, news: newsOut, memory: notes.length }); ctrl.close(); return; }
            errs.push(`${m}: ${err || "leere Antwort"}`);
          }
          send({ t: "error", error: "Der Coach konnte gerade keine Antwort erzeugen. Bitte nochmals senden.", detail: errs.join(" · ") });
        } catch (e) { send({ t: "error", error: "Fehler im Coach: " + String((e as any)?.message || e).slice(0, 160), detail: errs.join(" · ") }); }
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  const { news, notes, sys } = await gather();
  const t0 = Date.now();
  // OpenRouter: Websuche über das «web»-Plugin (ein paar aktuelle Treffer), begrenztes Nachdenken, damit die Antwort sicher Platz hat
  const orCall = (model: string, msgs: any[], maxTokens: number, think: number, search: boolean, ms: number) => fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${orKey}`, "HTTP-Referer": "https://pl-scout-oetterli.netlify.app", "X-Title": "PL Scout" },
    signal: AbortSignal.timeout(ms),
    body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens, ...(think ? { reasoning: { max_tokens: think, exclude: true } } : {}),
      ...(search ? { plugins: [{ id: "web", max_results: 4, search_prompt: `Aktuelle Web-Ergebnisse (heute ${today}, Saison ${season}). Nutze sie für News, Verletzungen und Aufstellungen und nenne die Quelle mit Datum:` }] } : {}),
      usage: { include: true } }),
  });
  const orModels = (Netlify.env.get("OPENROUTER_MODELS") || "anthropic/claude-sonnet-5.5,openai/gpt-5.6-luna,anthropic/claude-haiku-5.5").split(",").map((x) => x.trim()).filter(Boolean);
  const orPlan: [string, boolean, number][] = [[orModels[0], true, 2048], [orModels[0], false, 1024], ...orModels.slice(1).map((m): [string, boolean, number] => [m, false, 1024])];
  let orAnswer = "", orModel = "", orCost = 0, orErr = "", orSources: { url: string; title?: string }[] = [], orSearched = false;
  if (orKey) {
    for (const [m, search, think] of orPlan) {
      const left = 36000 - (Date.now() - t0);
      if (left < 8000) break;
      try {
        const note = search ? "" : "\n\n(Hinweis: Websuche ist gerade nicht verfügbar – stütze dich auf die Live-Daten, Sleeper-News und Schlagzeilen oben und sage, wenn etwas unklar ist.)";
        const r = await orCall(m, [{ role: "system", content: sys + note }, ...messages], 8000, think, search, Math.min(left, search ? 28000 : left));
        const raw = await r.text().catch(() => "");
        let d: any = null; try { d = JSON.parse(raw.trim()); } catch { /* unten melden */ }
        const msg = d?.choices?.[0]?.message || {};
        const c = msg.content;
        if (r.ok && c && String(c).trim()) {
          orAnswer = String(c); orModel = m; orCost = Number(d?.usage?.cost) || 0; orSearched = search;
          for (const an of msg.annotations || []) { const u = an?.url_citation; if (u?.url && !orSources.some((x) => x.url === u.url) && orSources.length < 8) orSources.push({ url: u.url, title: u.title }); }
          break;
        }
        orErr = `${m}: ${r.status} ${d?.error?.message || d?.choices?.[0]?.error?.message || (r.ok ? "leere Antwort (" + (d?.choices?.[0]?.finish_reason || raw.replace(/\s+/g, " ").slice(0, 160)) + ")" : "")}`.trim();
      } catch (e) { orErr = `Zeitüberschreitung (${m}${search ? " mit Websuche" : ""})`; }
    }
  }
  if (orAnswer) {
    const answer = orAnswer.replace(/【[^】]*】/g, "").trim();
    return json(200, { answer, sources: orSources, queries: orSearched ? ["Websuche (aktuelle Treffer)"] : [], news: news.map(({ player, title, source, date, url }) => ({ player, title, source, date, url })),
      model: orModel + (orSearched ? " + Websuche" : ""), cost: orCost, memory: notes.length });
  }
  if (!apiKey) return json(502, { error: `OpenRouter-Fehler (${orErr || "keine Antwort"}). Bitte nochmals versuchen.` });
  const call = (model: string, withSearch: boolean, effort: string) => fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(Math.max(5000, 37000 - (Date.now() - t0))),
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: sys + (withSearch ? "" :
        "\n\n(Websuche ist gerade nicht verfügbar – stütze dich auf die Schlagzeilen und Daten oben.)") }, ...messages],
      ...(withSearch ? { tools: [{ type: "browser_search" }], tool_choice: "auto" } : {}),
      ...(model.startsWith("openai/") ? { reasoning_effort: effort } : {}),
      temperature: 0.6,
      max_completion_tokens: 4096,
    }),
  });
  // Ausweichstufen: 1) mit Websuche, 2) nochmals mit Websuche, 3) ohne Websuche (Schlagzeilen genügen),
  // 4) kleineres Modell. Bei Tageslimit direkt aufs kleinere Modell (eigenes Kontingent).
  const big = Netlify.env.get("COACH_MODEL") || "openai/gpt-oss-120b", small = "openai/gpt-oss-20b";
  // weitere Modelle mit eigenem Tageskontingent als letzte Ausweichstufe
  const plan: [string, boolean, string][] = [[big, true, "medium"], [big, true, "low"], [big, false, "medium"], [small, false, "medium"]];
  let res: Response | null = null, data: any = null, usedModel = big, lastErr = "";
  for (let i = 0; i < plan.length; i++) {
    let [m, search, effort] = plan[i];
    if (lastErr.startsWith("429") && m === big) continue;
    if (Date.now() - t0 > 30000) break; // Zeitbudget der Edge Function
    try { res = await call(m, search, effort); } catch (e) { lastErr = "timeout"; continue; }
    data = null; try { data = await res.json(); } catch { /* leer */ }
    if (res.ok && data?.choices?.[0]?.message?.content) { usedModel = m; break; }
    lastErr = `${res.status} ${data?.error?.message || ""}`;
    res = null;
  }
  if (!res || !res.ok) {
    const is429 = lastErr.startsWith("429");
    return json(is429 ? 429 : 502, { error: is429
      ? `Groq-Limit erreicht (${/per day|TPD|RPD/.test(lastErr) ? "Tageskontingent aufgebraucht – morgen wieder verfügbar, " : "bitte 1 Minute warten"}).`
      : "Der Coach konnte gerade keine Antwort erzeugen (mehrere Versuche). Bitte nochmals senden.",
      detail: `OpenRouter: ${orKey ? (orErr || "kein Ergebnis") : "nicht eingerichtet (OPENROUTER_API_KEY fehlt)"} · Groq: ${lastErr.slice(0, 160)}` });
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
