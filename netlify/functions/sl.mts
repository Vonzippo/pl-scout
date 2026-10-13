// Zwischenspeicher für Sleeper (Liga, Kader, Stats, Prognosen): CDN-Cache + letzte gute Kopie bei Ausfall
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request) => {
  const u = new URL(req.url);
  const rest = u.pathname.replace(/^\/api\/sl\//, "");
  if (!/^[a-z0-9_\-:/]+$/i.test(rest)) return new Response('{"error":"ungültig"}', { status: 400 });
  const isStats = /^(stats|projections)\//.test(rest);
  const qs = [...u.searchParams].filter(([k]) => k === "season_type").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const target = (isStats ? "https://api.sleeper.com/" : "https://api.sleeper.app/v1/") + rest + (qs ? "?" + qs : "");
  const ttl = isStats ? (rest.startsWith("projections") ? 900 : 300) : 60;
  const key = (rest + "_" + qs).replace(/[^a-z0-9]/gi, "_");
  const store = getStore({ name: "sleeper-cache" });
  const out = (body: string, src: string, cdn: string) => new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=30", "netlify-cdn-cache-control": cdn, "x-source": src, "x-fetched": new Date().toISOString() },
  });
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(target, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const body = await r.text();
        if (body && body !== "null") await store.set(key, body).catch(() => {});
        return out(body, "live", `public, durable, s-maxage=${ttl}, stale-while-revalidate=${ttl * 6}`);
      }
      if (r.status === 404) return new Response(await r.text(), { status: 404, headers: { "content-type": "application/json" } });
    } catch { /* nochmals */ }
    if (i === 0) await new Promise((res) => setTimeout(res, 600));
  }
  const cached = await store.get(key).catch(() => null);
  if (cached) return out(cached as string, "cache", "public, s-maxage=60");
  return new Response('{"error":"Sleeper nicht erreichbar"}', { status: 502, headers: { "content-type": "application/json" } });
};

export const config: Config = { path: "/api/sl/*" };
