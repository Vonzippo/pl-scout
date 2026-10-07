// Geplanter KI-Bot: bewertet alle 10 Minuten die 15 Spieler mit der ältesten Bewertung.
import type { Config } from "@netlify/functions";
import { rateBatch } from "../lib/rate.ts";
import { dueList, mergeRatings, noteError, takeQuota } from "../lib/kistore.ts";

export default async () => {
  const key = Netlify.env.get("GROQ_API_KEY");
  if (!key) return;
  const { due } = await dueList(15);
  if (!due.length) return;
  if (!(await takeQuota("bot")).ok) return; // Tageslimit erreicht
  try {
    const add = await rateBatch(due, key, Netlify.env.get("KI_MODEL") || undefined);
    await mergeRatings(add);
  } catch (e: any) {
    await noteError(String(e?.message || e).slice(0, 200));
  }
};

export const config: Config = { schedule: "*/10 * * * *" };
