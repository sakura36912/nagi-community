import {
  ApplicationCommandType,
  type ApplicationCommandManager,
  type ApplicationCommandData,
  type Client,
  type GuildApplicationCommandManager,
} from "discord.js";
import { commands } from "../commands";
import { logger } from "./logger";

/** Upsert just the selected debit command; never replace unrelated commands. */
async function syncDebitCommandRegistration(client: Client, name: string, tag: string): Promise<void> {
  const target = commands.find((command) => command.data.name === name);
  if (!target || !client.application) {
    throw new Error(`[${tag}] Cannot register command without its definition or application`);
  }
  const definition = target.data.toJSON() as ApplicationCommandData;
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
      throw new Error(`/${name} verification failed (${label})`);
    }
    logger.info(`[${tag}] Command synchronized (${label})`);
  }));
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    logger.error(`[${tag}] Command registration failed (${scopes[index]!.label})`, result.reason);
    return [result.reason];
  });
  if (failures.length) throw new AggregateError(failures, `[${tag}] Command registration failed`);
}

export async function syncDailyRoleDebitCommandRegistration(client: Client): Promise<void> {
  await syncDebitCommandRegistration(client, "日額引き落とし", "daily-debit");
}

export async function syncMonthlyRoleDebitCommandRegistration(client: Client): Promise<void> {
  await syncDebitCommandRegistration(client, "月額引き落とし", "monthly-debit");
}