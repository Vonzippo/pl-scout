// Sammelt alle 15 Minuten fehlende Spieltage vergangener Saisons (danach unverändert)
import type { Config } from "@netlify/functions";
import { collectPast } from "../lib/pastsl.ts";
export default async () => { try { await collectPast(22000); } catch { /* nächster Lauf */ } };
export const config: Config = { schedule: "*/15 * * * *" };
