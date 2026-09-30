import {
  ApplicationCommandType,
  type ApplicationCommandManager,
  type ApplicationCommandData,
  type Client,
  type GuildApplicationCommandManager,
} from "discord.js";
import { commands } from "../commands";
import { logger } from "./logger";

const dailyDebitCommand = commands.find((command) => command.data.name === "日額引き落とし");

/** Upsert only the daily-debit command, without replacing unrelated commands. */
export async function syncDailyRoleDebitCommandRegistration(client: Client): Promise<void> {
  if (!dailyDebitCommand || !client.application) {
    throw new Error("[daily-debit] Cannot register command without its definition or application");
  }
  const definition = dailyDebitCommand.data.toJSON() as ApplicationCommandData;
  const scopes: Array<{
    label: string;
    manager: ApplicationCommandManager | GuildApplicationCommandManager;
  }> = [
    { label: "global", manager: client.application.commands },
    ...[...client.guilds.cache.values()].map((guild) => ({
      label: `guild=${guild.id}`, manager: guild.commands,
    })),
  ];
  const results = await Promise.allSettled(scopes.map(async ({ label, manager }) => {
    const existing = (await manager.fetch({})).find((command) =>
      command.name === definition.name && command.type === ApplicationCommandType.ChatInput);
    const saved = existing
      ? await manager.edit(existing.id, definition)
      : await manager.create(definition);
    const verified = await manager.fetch(saved.id, { force: true });
    if (!verified || verified.options.map((option) => option.name).join(",") !== "set,remove,list") {
      throw new Error(`/日額引き落とし verification failed (${label})`);
    }
    logger.info(`[daily-debit] Command synchronized (${label})`);
  }));
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    logger.error(`[daily-debit] Command registration failed (${scopes[index]!.label})`, result.reason);
    return [result.reason];
  });
  if (failures.length) throw new AggregateError(failures, "[daily-debit] Command registration failed");
}