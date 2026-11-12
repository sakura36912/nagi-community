import { randomUUID } from "node:crypto";
import { Events, type Client } from "discord.js";
import { awardPetMessage, observePetVoice } from "@workspace/db";
import { petCommand } from "../commands/pet";
import { logger } from "./logger";

/** No gateway login on import. Called only by the already running community bot. */
export function startPetRuntime(client: Client) {
  let epoch = randomUUID(), busy = false;
  const reset = () => { epoch = randomUUID(); };
  client.on(Events.ShardDisconnect, reset);
  client.on(Events.ShardResume, reset);
  client.on(Events.ShardReady, reset);
  client.on(Events.GuildUnavailable, reset);
  client.on(Events.MessageCreate, async message => {
    if (!message.guildId || message.author.bot || message.webhookId) return;
    try { await awardPetMessage(message.id, message.guildId, message.author.id, message.createdTimestamp); }
    catch { logger.warn("[pet] メッセージ経験値を保存できませんでした。"); }
  });
  client.on(Events.VoiceStateUpdate, async (oldState, state) => {
    if (oldState.channelId === state.channelId || state.member?.user.bot) return;
    try {
      // Settle the final partial observation before clearing/moving the session.
      if (oldState.channelId) await observePetVoice(state.guild.id, state.id, oldState.channelId, epoch);
      await observePetVoice(state.guild.id, state.id, state.channelId, epoch);
    }
    catch { logger.warn("[pet] VC経験値の観測を更新できませんでした。"); }
  });
  const tick = async () => {
    if (busy || !client.isReady()) return;
    busy = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        if (!guild.available) continue;
        for (const state of guild.voiceStates.cache.values()) {
          if (!state.channelId || state.member?.user.bot) continue;
          await observePetVoice(guild.id, state.id, state.channelId, epoch);
        }
      }
    } catch { logger.warn("[pet] VC経験値の定期保存に失敗しました。"); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000);
  timer.unref();
  void tick();
  // Individual upsert only: never replace all global or guild commands.
  void (async () => {
    if (!client.application) throw new Error("Discord application unavailable");
    await client.application.commands.create(petCommand.data.toJSON());
    const registered = await client.application.commands.fetch({});
    if (!registered.some(c => c.name === "pet" && c.type === 1)) throw new Error("Pet registration verification failed");
    logger.info("[pet] /pet を個別登録しました。");
  })().catch(() => logger.warn("[pet] /pet の個別登録に失敗しました。"));
}
