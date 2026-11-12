import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export * from "./forgeRules";
export * from "./forgeSchema";
export * from "./forge";
export * from "./bossRules";
export * from "./pvpRules";
export * from "./pvp";
export * from "./rpgNotices";
export * from "./bossAttackEffects";
export * from "./rpgCommandNames";
export * from "./zombieRules";
export * from "./zombieVoice";
export * from "./zombieSchema";
export * from "./zombie";
export * from "./zombieDelivery";
export * from "./bossSchema";
export * from "./boss";
export * from "./bossBattle";
export * from "./bossNotifications";

export * from "./schema";
export * from "./vcHub";
export * from "./evalSheetConfig";
export * from "./preban";
export * from "./timedRoleGrants";
export * from "./shopForumPanel";
export * from "./uraRecruitment";
export * from "./schema-check";
export * from "./dealerCasino";
export * from "./bounty";
export * from "./kpTicket";
export * from "./kpTicketPricing";
export * from "./petRules";
export * from "./pet";
