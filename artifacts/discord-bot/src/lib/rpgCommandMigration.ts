import { ApplicationCommandType, Events, Routes, type APIApplicationCommand, type Client, type Interaction } from "discord.js";
import {
  LEGACY_RPG_COMMAND_NAMES,
  RPG_COMMAND_NAMES,
  isRetiredBankRpgCommand,
} from "@workspace/db";
import { logger } from "./logger";

/** Commands intentionally removed from the Bank Bot while keeping PvP and unrelated commands. */
export const REMOVED_BANK_COMMAND_NAMES = [
  "guide",
  "leavelog",
  "roulette",
  ...RPG_COMMAND_NAMES.filter((name) => name !== "pvp"),
  ...LEGACY_RPG_COMMAND_NAMES,
] as const;

const removedNames = new Set<string>(REMOVED_BANK_COMMAND_NAMES);

export async function handleRetiredBankRpgInteraction(interaction: Interaction) {
  if (!((interaction.isButton() && /^(boss|forge):/.test(interaction.customId)) ||
    (interaction.isChatInputCommand() && isRetiredBankRpgCommand(interaction.commandName)))) return false;
  await interaction.reply({
    content: "武器・鍛冶屋・ボス討伐は多機能Botへ移動しました。多機能Botの同名コマンドを実行してください。データと銀行残高は共通です。この操作では課金しません。",
    ephemeral: true,
  });
  return true;
}

/** Remove only the explicitly retired slash commands from the Bank Bot's global and cached guild scopes. */
export async function removeBankRpgCommands(bank: Client) {
  if (!bank.application) throw new Error("Bank application unavailable");

  const applicationId = bank.application.id;
  const scopes = [
    { name: "global", route: Routes.applicationCommands(applicationId) },
    ...[...bank.guilds.cache.values()].map((guild) => ({
      name: `guild:${guild.id}`,
      route: Routes.applicationGuildCommands(applicationId, guild.id),
    })),
  ];

  let removed = 0;
  for (const scope of scopes) {
    const current = await bank.rest.get(scope.route) as APIApplicationCommand[];
    for (const command of current) {
      if (command.type !== ApplicationCommandType.ChatInput || !removedNames.has(command.name)) continue;
      await bank.rest.delete(`${scope.route}/${command.id}`);
      removed++;
    }

    const remaining = await bank.rest.get(scope.route) as APIApplicationCommand[];
    if (remaining.some((command) =>
      command.type === ApplicationCommandType.ChatInput && removedNames.has(command.name))) {
      throw new Error(`Removed Bank Bot commands remain in ${scope.name}`);
    }
  }
  return removed;
}

/** Retry until all currently known Bank Bot scopes have only the requested removals applied. */
export function startBankRpgCleanup(client: Client) {
  let running = false;
  let complete = false;
  let guildRevision = 0;
  const run = async () => {
    if (running || complete) return;
    running = true;
    const revision = guildRevision;
    try {
      const count = await removeBankRpgCommands(client);
      logger.info(`[bank-commands] Removed ${count} targeted obsolete boss/weapon commands and disabled slash commands.`);
      complete = revision === guildRevision;
    } catch (error) {
      logger.warn("[bank-commands] Targeted command cleanup failed; retrying in 60 seconds.", error);
    } finally {
      running = false;
    }
  };

  client.on(Events.GuildCreate, () => {
    guildRevision++;
    complete = false;
    void run();
  });
  void run();
  const timer = setInterval(() => void run(), 60_000);
  timer.unref();
}
