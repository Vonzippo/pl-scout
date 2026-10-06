// Zwischenspeicher für die offizielle FPL-API: Netlify-CDN cached 10 Min., bei Sperre/Fehler letzte gute Kopie.
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export default async (req: Request) => {
  const u = new URL(req.url);
  const sub = u.pathname.replace(/^\/api\/fpl\//, "");
  if (!/^[a-z0-9\-/]+\/?$/i.test(sub)) return new Response('{"error":"ungültig"}', { status: 400 });
  const search = [...u.searchParams].filter(([k]) => /^(event|future)$/.test(k)).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const target = `https://fantasy.premierleague.com/api/${sub}${search ? "?" + search : ""}`;
  const key = (sub + "_" + search).replace(/[^a-z0-9]/gi, "_");
  const store = getStore({ name: "fpl-cache" });
  const ok = (body: string, src: string, cdn: string) => new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", "netlify-cdn-cache-control": cdn, "x-source": src },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(target, { headers: { "user-agent": UA, accept: "application/json", "accept-language": "en-GB,en;q=0.9" }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const body = await r.text();
        await store.set(key, body).catch(() => {});
        return ok(body, "live", "public, durable, s-maxage=600, stale-while-revalidate=3600");
      }
    } catch { /* nochmals versuchen */ }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 700));
  }
  const cached = await store.get(key).catch(() => null);
  if (cached) return ok(cached as string, "cache", "public, s-maxage=120");
  return new Response('{"error":"FPL nicht erreichbar"}', { status: 502, headers: { "content-type": "application/json" } });
};

export const config: Config = { path: "/api/fpl/*" };
