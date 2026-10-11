import {
  ApplicationCommandType, type Client, type ApplicationCommandManager,
  type GuildApplicationCommandManager, type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { prefersGlobalCommands } from "./guildCommandScope";
import { logger } from "./logger";

/** Individually upsert /shop; never replace other applications' command definitions. */
export async function syncShopCommandRegistration(
  client: Client, definition: RESTPostAPIChatInputApplicationCommandsJSONBody,
): Promise<void> {
  if (!client.application) throw new Error("Discord application is unavailable");
  const scopes: { label: string; manager: ApplicationCommandManager | GuildApplicationCommandManager }[] = [
    { label: "global", manager: client.application.commands },
    ...[...client.guilds.cache.values()].filter((guild) => !prefersGlobalCommands(guild.id))
      .map((guild) => ({ label: `guild=${guild.id}`, manager: guild.commands })),
  ];
  const results = await Promise.allSettled(scopes.map(async ({ label, manager }) => {
    const existing = (await manager.fetch({})).find((command) =>
      command.name === "shop" && command.type === ApplicationCommandType.ChatInput);
    const saved = existing ? await manager.edit(existing.id, definition) : await manager.create(definition);
    const verified = await manager.fetch(saved.id, { force: true });
    const forumPanel = verified.options.find((option) => option.name === "forum-panel");
    if (!forumPanel || !("options" in forumPanel) || !forumPanel.options?.some((option) => option.name === "cast_role")) {
      throw new Error(`/shop cast_role registration verification failed (${label})`);
    }
    logger.info(`[shop] Command synchronized (${label})`);
  }));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "/shop command registration failed");
}
