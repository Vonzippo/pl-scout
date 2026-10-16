// Sammelt alle 15 Minuten fehlende Vorsaison-Daten (nach ein paar Läufen vollständig, danach nur Neuzugänge)
import type { Config } from "@netlify/functions";
import { collectPrior } from "../lib/prior.ts";
export default async () => { try { await collectPrior(); } catch { /* nächster Lauf */ } };
export const config: Config = { schedule: "*/15 * * * *" };
