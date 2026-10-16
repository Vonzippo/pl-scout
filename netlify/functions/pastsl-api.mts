// Vergangene Saisons (Sleeper-Stats) für die Seite; solange etwas fehlt, wird bei jedem Aufruf weitergesammelt
import type { Config } from "@netlify/functions";
import { collectPast, pastStore, pastSeasons } from "../lib/pastsl.ts";
export default async () => {
  let d: any = await pastStore().get("agg", { type: "json" }).catch(() => null);
  if (!d || d.key !== pastSeasons().join(",") || (d.missing ?? 1) > 0) { try { await collectPast(18000); } catch { /* egal */ } d = await pastStore().get("agg", { type: "json" }).catch(() => null); }
  const out = d ? { seasons: d.seasons, missing: d.missing, p: d.p } : { seasons: pastSeasons(), missing: 1, p: {} };
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300",
    "netlify-cdn-cache-control": out.missing === 0 ? "public, durable, s-maxage=21600" : "no-store" } });
};
export const config: Config = { path: "/api/pastsl" };
