import { ChannelType, type Client, type Guild } from "discord.js";
import {
  db,
  dealerCasinoSettingsTable,
  getDealerCasinoSettings,
} from "@workspace/db";
import { logger } from "./logger";

// Initial configuration requested for this guild. The row is inserted only
// when absent; administrators can subsequently change it with /casino setup.
const GUILD_ID = "1526418867335725247";
const VOICE_CHANNEL_ID = "1528954400263897088"; // 賭博VC
const DEALER_ROLE_ID = "1528278375829864459"; // 賭博師
const DIRECTOR_ROLE_ID = "1540665709686689863"; // 賭博頭領
const ADMIN_ROLE_ID = "1526565082769653760"; // 管理者

async function verifyGuildTargets(guild: Guild): Promise<void> {
  const [voice, dealer, director, admin] = await Promise.all([
    guild.channels.fetch(VOICE_CHANNEL_ID),
    guild.roles.fetch(DEALER_ROLE_ID),
    guild.roles.fetch(DIRECTOR_ROLE_ID),
    guild.roles.fetch(ADMIN_ROLE_ID),
  ]);
  if (voice?.type !== ChannelType.GuildVoice || voice.name !== "賭博VC" ||
      dealer?.name !== "賭博師" || director?.name !== "賭博頭領" ||
      admin?.name !== "管理者") {
    throw new Error("賭博場VCまたは進行役ロールを確認できません。初期設定を保存しませんでした。");
  }
}

export async function initializeDealerCasinoForGuild(client: Client): Promise<void> {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    logger.warn("[dealer-casino] Initial configuration skipped: target guild is unavailable");
    return;
  }
  if (await getDealerCasinoSettings(GUILD_ID)) return;
  await verifyGuildTargets(guild);

  const [inserted] = await db.insert(dealerCasinoSettingsTable).values({
    guildId: GUILD_ID,
    voiceChannelId: VOICE_CHANNEL_ID,
    dealerRoleId: DEALER_ROLE_ID,
    directorRoleId: DIRECTOR_ROLE_ID,
    adminRoleId: ADMIN_ROLE_ID,
    minBet: 1000,
    maxBet: 10000,
    maxPlayers: 16,
    chohanEnabled: 1,
    chohanMultipliers: {
      "1": 2, "2": 2.5, "3": 3, "4": 4, "5": 5,
      "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
    },
    chohanMaxStreakMultiplier: 10,
    streakRetentionSeconds: 5 * 60,
    pokerEnabled: 1,
    pokerBaseMultiplier: 2,
    pokerAceLowEnabled: 1,
    pokerBonusEnabled: 1,
    pokerBonusMultipliers: {
      "high-card": 2,
      pair: 2.5,
      flush: 3,
      straight: 4,
      "three-of-a-kind": 6,
      "straight-flush": 10,
    },
    pokerDealerQualificationEnabled: 1,
    pokerDealerQualificationRank: "high-card",
    pokerDealerMinimumHighCard: 12, // Q
    pokerTimeoutSeconds: 60,
  }).onConflictDoNothing().returning({ guildId: dealerCasinoSettingsTable.guildId });
  if (inserted) {
    logger.info("[dealer-casino] Initial game settings saved for guild");
  }
}