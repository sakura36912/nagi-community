import {
  type Client, type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { profileCommands } from "../commands/profile.js";
import { logger } from "./logger.js";

/** Upsert only profile commands so unrelated guild/global commands are untouched. */
export async function syncProfileCommandRegistration(client: Client) {
  if (!client.application) throw new Error("Discord application unavailable");
  const registered = await client.application.commands.fetch({});
  for (const command of profileCommands) {
    const body = command.data.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody;
    const existing = registered.find(item => item.name === body.name && item.type === 1);
    if (existing) await client.application.commands.edit(existing.id, body);
    else await client.application.commands.create(body);
  }
  const verified = await client.application.commands.fetch({});
  const missing = profileCommands.filter(command =>
    !verified.some(item => item.name === command.data.name && item.type === 1));
  if (missing.length) throw new Error(`Profile command registration incomplete: ${missing.map(item => item.data.name).join(", ")}`);
  logger.info("[profile] /プロフィール と管理設定を同期しました。");
}
