// Manueller Lauf des KI-Bots («Jetzt bewerten»): holt fällige Spieler, bewertet sie und speichert das Ergebnis.
import { rateBatch } from "../lib/rate.ts";

declare const Netlify: { env: { get(key: string): string | undefined } };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "Nur POST" });
  const key = Netlify.env.get("GROQ_API_KEY"), secret = Netlify.env.get("KI_SECRET");
  if (!key || !secret) return json(500, { error: "GROQ_API_KEY oder KI_SECRET fehlt" });
  const base = new URL(req.url).origin;
  const d = await fetch(`${base}/api/ki/due?n=15`).then((r) => r.json()).catch(() => null);
  if (!d?.due?.length) return json(200, { done: 0, pending: 0, total: d?.total || 0 });
  let ratings = {}, error = "";
  try { ratings = await rateBatch(d.due, key, Netlify.env.get("KI_MODEL") || undefined); }
  catch (e) { error = String((e as Error)?.message || e).slice(0, 200); }
  await fetch(`${base}/api/ki/save`, {
    method: "POST", headers: { "content-type": "application/json", "x-ki-secret": secret },
    body: JSON.stringify(error ? { error } : { ratings }),
  });
  if (error) return json(502, { error });
  return json(200, { done: Object.keys(ratings).length, pending: Math.max(0, d.pending - Object.keys(ratings).length), total: d.total });
};

export const config = { path: "/api/ki/run" };
