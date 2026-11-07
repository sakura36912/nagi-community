import { ApplicationCommandType, Events, Routes, type Client } from "discord.js";
import { logger } from "./logger";

/** Remove slash definitions only; keep balances, logs and in-progress interactions. */
export const RETIRED_BANK_COMMAND_NAMES = ["guide", "leavelog", "roulette"] as const;
const retired = new Set<string>(RETIRED_BANK_COMMAND_NAMES);
interface CommandDefinition { id: string; name: string; type: number }
interface CommandRest {
  get(path: `/${string}`): Promise<unknown>;
  delete(path: `/${string}`): Promise<unknown>;
}
export async function removeRetiredBankCommands(rest: CommandRest, applicationId: string, guildIds: string[]) {
  const app = await rest.get(Routes.oauth2CurrentApplication()) as { id: string };
  if (!applicationId || app.id !== applicationId) throw new Error("Bank application identity mismatch");
  const scopes = [null, ...new Set(guildIds)] as (string | null)[];
  const removed: { scope: string; name: string }[] = [];
  const failed: string[] = [];
  for (const guildId of scopes) {
    const scope = guildId ?? "global";
    const route = guildId ? Routes.applicationGuildCommands(applicationId, guildId) : Routes.applicationCommands(applicationId);
    try {
      const commands = await rest.get(route) as CommandDefinition[];
      for (const command of commands) {
        if (command.type !== ApplicationCommandType.ChatInput || !retired.has(command.name)) continue;
        const item = guildId ? Routes.applicationGuildCommand(applicationId, guildId, command.id)
          : Routes.applicationCommand(applicationId, command.id);
        try { await rest.delete(item); }
        catch (error) {
          // Another cleanup may already have deleted this exact definition.
          if ((error as { code?: number }).code !== 10063) throw error;
        }
        removed.push({ scope, name: command.name });
      }
      // Raw REST GET bypasses discord.js's command cache.
      const remaining = await rest.get(route) as CommandDefinition[];
      if (remaining.some(c => c.type === ApplicationCommandType.ChatInput && retired.has(c.name))) {
        throw new Error("Retired command still registered");
      }
    } catch {
      failed.push(scope);
    }
  }
  return { removed, failed };
}

/** Retry failed scopes and clean up a guild that becomes available after startup. */
export function startRetiredBankCommandCleanup(client: Client) {
  let running = false, complete = false, revision = 0;
  const run = async () => {
    if (running || complete || !client.application) return;
    running = true;
    const startedRevision = revision;
    try {
      const result = await removeRetiredBankCommands(client.rest, client.application.id, [...client.guilds.cache.keys()]);
      complete = result.failed.length === 0 && startedRevision === revision;
      if (result.removed.length) logger.info(`[commands-retired] 銀行Botの廃止コマンド${result.removed.length}件を削除しました。`);
      if (result.failed.length) logger.warn("[commands-retired] 一部の登録確認・削除に失敗しました。60秒後に再試行します。");
    } catch {
      logger.warn("[commands-retired] アプリ確認・削除に失敗しました。60秒後に再試行します。");
    } finally { running = false; }
  };
  client.on(Events.GuildCreate, () => { revision++; complete = false; void run(); });
  void run();
  const timer = setInterval(() => { void run(); }, 60000);
  timer.unref();
}
