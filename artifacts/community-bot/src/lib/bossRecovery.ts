import { createHash } from "node:crypto";
import { type Client } from "discord.js";
import { advanceBossGuild, dueBossGuilds, pendingBossNotices, deliverBossNotice } from "@workspace/db";
import { bossBattleNotice } from "./bossUi";
import { logger } from "./logger";

let running = false;
let interval: ReturnType<typeof setInterval> | undefined;
/** 期限をDBから再評価。再起動で受付・戦闘・決済状態を失わない。 */
export async function runBossRecovery(client: Client) {
  if (running) return;
  running = true;
  try {
    for (const guildId of await dueBossGuilds()) {
      try { await advanceBossGuild(guildId); }
      catch (error) { logger.error(`[boss] Deadline recovery failed guild=${guildId}`, error); }
    }
    for (const notice of await pendingBossNotices()) {
      const result = await deliverBossNotice(notice.id, async bundle => {
        const channel = await client.channels.fetch(bundle.event.channelId);
        if (!channel || !channel.isTextBased() || !("send" in channel)) throw new Error("Boss announcement channel is unavailable");
        if (!("guildId" in channel) || channel.guildId !== bundle.event.guildId) throw new Error("Boss channel guild mismatch");
        const nonce = createHash("sha256").update(`${bundle.battle.id}:${bundle.battle.status}`).digest("hex").slice(0, 24);
        const message = await channel.send({ embeds: [bossBattleNotice(bundle)], allowedMentions: { parse: [] }, nonce, enforceNonce: true });
        return message.id;
      });
      if (result?.error) logger.warn(`[boss] Announcement failed; scheduled retry battle=${notice.id}`, result.error);
    }
  } catch (error) { logger.error("[boss] Recovery cycle failed", error); }
  finally { running = false; }
}
export function startBossRecovery(client: Client) {
  if (interval) return;
  void runBossRecovery(client);
  interval = setInterval(() => { void runBossRecovery(client); }, 15000);
  interval.unref();
}
