import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type ApplicationCommandManager,
  type Client,
  type GuildApplicationCommandManager,
} from "discord.js";
import { chinchiroCommand } from "../commands/chinchiro";
import { logger } from "./logger";

type CommandManager = ApplicationCommandManager | GuildApplicationCommandManager;

function hasLiveOption(options: readonly { name: string; type: number; options?: readonly { name: string; type: number }[] }[]): boolean {
  const config = options.find((option) =>
    option.name === "config" && option.type === ApplicationCommandOptionType.Subcommand);
  return Boolean(config?.options?.some((option) =>
    option.name === "live" && option.type === ApplicationCommandOptionType.Boolean));
}

/** Upsert only /chinchiro; never replace unrelated application commands. */
export async function syncChinchiroCommandRegistration(client: Client): Promise<void> {
  if (!client.application) throw new Error("[chinchiro] Cannot register without an application");
  const definition = chinchiroCommand.data.toJSON();
  if (!hasLiveOption(definition.options ?? [])) throw new Error("[chinchiro] Code definition is missing config.live");
  const scopes: Array<{ label: string; manager: CommandManager }> = [
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
    if (!verified || !hasLiveOption(verified.options)) {
      throw new Error(`[chinchiro] config.live verification failed (${label})`);
    }
    logger.info(`[chinchiro] Command synchronized (${label})`);
  }));
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    logger.error(`[chinchiro] Command registration failed (${scopes[index]!.label})`, result.reason);
    return [result.reason];
  });
  if (failures.length) throw new AggregateError(failures, "[chinchiro] Command registration failed");
}