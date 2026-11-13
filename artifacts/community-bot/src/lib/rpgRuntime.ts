import type { Client } from "discord.js";
import { ensureBossSchema } from "@workspace/db";
import { startBossRecovery } from "./bossRecovery.js";
import { syncForgeCommandRegistration } from "./forgeCommandRegistration.js";
import { syncBossCommandRegistration } from "./bossCommandRegistration.js";
import { logger } from "./logger.js";
import { startRpgCards } from "./rpgCards";
import { syncPvpCommandRegistration } from "./pvpCommandRegistration.js";

/** Restart order and transient REST failures must not strand the command transfer. */
export function startRpgRuntime(client: Client) {
  let running = false, complete = false, recoveryStarted = false;
  const attempt = async () => {
    if (running || complete) return;
    running = true;
    try {
      await ensureBossSchema();
      if (!recoveryStarted) { startBossRecovery(client); recoveryStarted = true; }
      startRpgCards(client);
      await Promise.all([syncForgeCommandRegistration(client), syncBossCommandRegistration(client)]);
      await syncPvpCommandRegistration(client);
      complete = true;
      clearInterval(timer);
      logger.info("[rpg] 武器・ボス・PvPコマンドを多機能Botへ登録しました。");
    } catch {
      logger.warn("[rpg] 初期化・個別登録に失敗しました。60秒後に再試行します。");
    } finally { running = false; }
  };
  const timer = setInterval(() => { void attempt(); }, 60000);
  timer.unref();
  void attempt();
  return () => clearInterval(timer);
}
