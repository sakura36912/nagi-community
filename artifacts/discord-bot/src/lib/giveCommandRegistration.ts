import { ApplicationCommandType, PermissionFlagsBits, type Client } from "discord.js";
import { giveCommand } from "../commands/give";
import { prefersGlobalCommands } from "./guildCommandScope";
import { logger } from "./logger";

/** Publish only /give; never replace any command collection. */
export async function syncGiveCommandRegistration(client: Client): Promise<void> {
  if (!client.application) throw new Error("Discord application is unavailable");
  const definition = giveCommand.data.toJSON();
  const global = client.application.commands;
  // Global first so global-preferring guilds can safely drop only a duplicate.
  const upsert = async (manager: typeof global | import("discord.js").GuildApplicationCommandManager) => {
    const existing = (await manager.fetch({})).find(c =>
      c.name === "give" && c.type === ApplicationCommandType.ChatInput);
    const saved = existing ? await manager.edit(existing.id, definition) : await manager.create(definition);
    const verified = await manager.fetch(saved.id, { force: true });
    const amount = verified.options.find(o => o.name === "amount");
    if (verified.defaultMemberPermissions?.bitfield !== PermissionFlagsBits.Administrator
      || verified.options.length !== 2
      || !verified.options.some(o => o.name === "user" && "required" in o && o.required)
      || !amount || !("min_value" in amount) || amount.min_value !== 1
      || !("max_value" in amount) || amount.max_value !== 2_147_483_647) {
      throw new Error("/give registration verification failed");
    }
  };
  await upsert(global);
  const results = await Promise.allSettled([...client.guilds.cache.values()].map(async guild => {
    if (prefersGlobalCommands(guild.id)) {
      const duplicates = (await guild.commands.fetch({})).filter(c =>
        c.name === "give" && c.type === ApplicationCommandType.ChatInput);
      for (const command of duplicates.values()) await guild.commands.delete(command.id);
      const remaining = await guild.commands.fetch({});
      if (remaining.some(c => c.name === "give" && c.type === ApplicationCommandType.ChatInput)) {
        throw new Error("/give duplicate cleanup verification failed");
      }
    } else {
      await upsert(guild.commands);
    }
  }));
  const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
  if (errors.length) throw new AggregateError(errors, "/give guild registration failed");
  logger.info("[give] Admin grant command synchronized");
}
