import { ApplicationCommandType, type Client } from "discord.js";
import { zombieCommands } from "../commands/zombie.js";
export async function syncZombieCommands(client: Client) {
  if (!client.application) throw new Error("Community application unavailable");
  const manager = client.application.commands;
  const existing = await manager.fetch({});
  for (const command of zombieCommands) {
    const definition = command.data.toJSON();
    const old = existing.find(c => c.name === definition.name && c.type === ApplicationCommandType.ChatInput);
    const saved = old ? await manager.edit(old.id, definition) : await manager.create(definition);
    const verified = await manager.fetch(saved.id, { force: true });
    if (verified.name !== definition.name) throw new Error("Community zombie command registration mismatch");
  }
}
