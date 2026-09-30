import {
  ApplicationCommandType,
  type ApplicationCommand,
  type ApplicationCommandManager,
  type ApplicationCommandData,
  type Client,
  type GuildApplicationCommandManager,
} from "discord.js";
import { casinoCommand } from "../commands/casino";
import { logger } from "./logger";

type CommandManager = ApplicationCommandManager | GuildApplicationCommandManager;

function matchesCasinoDefinition(command: ApplicationCommand, definition: ReturnType<typeof casinoCommand.data.toJSON>): boolean {
  // The builder includes nsfw: undefined; Discord stores the default as false.
  // Discord may also expand omitted context/integration defaults differently
  // between guild and global scopes, so only compare those when explicitly set.
  const comparable = {
    ...definition,
    nsfw: definition.nsfw ?? false,
    contexts: definition.contexts ?? command.contexts ?? undefined,
    integration_types: definition.integration_types ?? command.integrationTypes ?? undefined,
  } as unknown as ApplicationCommandData;
  return command.equals(comparable);
}

/** Upsert /casino alone. Never replace another command in either scope. */
async function syncScope(manager: CommandManager, scope: string): Promise<void> {
  const definition = casinoCommand.data.toJSON();
  const existing = (await manager.fetch({}))
    .find((command) => command.name === definition.name && command.type === ApplicationCommandType.ChatInput);
  if (existing && matchesCasinoDefinition(existing, definition)) {
    logger.info(`[casino] Command already matches code (${scope})`);
    return;
  }
  const saved = existing
    ? await manager.edit(existing.id, definition)
    : await manager.create(definition);
  // Fetch from Discord, not discord.js' command cache populated by edit/create.
  const verified = await manager.fetch(saved.id, { force: true });
  if (!verified || !matchesCasinoDefinition(verified, definition)) {
    throw new Error(`/casino verification failed (${scope}): Discord definition differs from code`);
  }
  logger.info(`[casino] Command synchronized and verified (${scope})`);
}

export async function syncCasinoCommandRegistration(client: Client): Promise<void> {
  if (!client.application) throw new Error("[casino] Cannot register commands without a Discord application");
  const scopes: Array<{ name: string; manager: CommandManager }> = [
    { name: "global", manager: client.application.commands },
    ...[...client.guilds.cache.values()].map((guild) => ({
      name: `guild=${guild.id}`, manager: guild.commands,
    })),
  ];
  const results = await Promise.allSettled(scopes.map(({ name, manager }) => syncScope(manager, name)));
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    logger.error(`[casino] Command registration failed (${scopes[index]!.name})`, result.reason);
    return [result.reason];
  });
  if (failures.length) throw new AggregateError(failures, `[casino] ${failures.length} command scope(s) failed to synchronize`);
}