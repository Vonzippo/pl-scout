// Liefert die Vorsaison-Daten; fehlen noch viele, wird sofort ein Teil nachgeladen
import type { Config } from "@netlify/functions";
import { collectPrior, priorStore, lastSeasonName } from "../lib/prior.ts";
export default async () => {
  let d: any = await priorStore().get("prior", { type: "json" }).catch(() => null);
  if (!d || d.season !== lastSeasonName() || (d.missing ?? 1) > 0) { try { await collectPrior(140, 18000); } catch { /* egal */ } d = await priorStore().get("prior", { type: "json" }).catch(() => null); }
  const complete = d && d.missing === 0;
  return new Response(JSON.stringify(d || { p: {} }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300",
    "netlify-cdn-cache-control": complete ? "public, durable, s-maxage=21600" : "no-store" } });
};
export const config: Config = { path: "/api/prior" };
