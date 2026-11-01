import { REST, Routes } from "discord.js";
import { removeRetiredBankCommands } from "./lib/retiredBankCommands";

/** REST-only maintenance: never connect a second Bot Gateway session. */
async function main() {
  const expectedId = process.argv.find(arg => arg.startsWith("--application-id="))?.split("=")[1];
  if (!expectedId) throw new Error("Explicit --application-id is required");
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  const rest = new REST({ version: "10" }).setToken(token);
  const app = await rest.get(Routes.oauth2CurrentApplication()) as { id: string };
  if (app.id !== expectedId) throw new Error("Bank application identity mismatch");
  const guildIds: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await rest.get(Routes.userGuilds(), {
      query: new URLSearchParams({ limit: "200", ...(after ? { after } : {}) }),
    }) as { id: string }[];
    guildIds.push(...page.map(guild => guild.id));
    if (page.length < 200) break;
    after = page[page.length - 1]!.id;
  }
  if (!process.argv.includes("--apply")) {
    const found: { scope: string; name: string; id: string }[] = [];
    for (const guildId of [null, ...guildIds]) {
      const route = guildId ? Routes.applicationGuildCommands(app.id, guildId) : Routes.applicationCommands(app.id);
      const rows = await rest.get(route) as { id: string; name: string; type: number }[];
      for (const row of rows) {
        if (row.type === 1 && ["give", "guide", "leavelog", "roulette"].includes(row.name)) {
          found.push({ scope: guildId ?? "global", name: row.name, id: row.id });
        }
      }
    }
    console.log(JSON.stringify({ applicationId: app.id, guildCount: guildIds.length, mode: "preview", found }));
    return;
  }
  const result = await removeRetiredBankCommands(rest, app.id, guildIds);
  console.log(JSON.stringify({ applicationId: app.id, guildCount: guildIds.length, mode: "apply", ...result }));
  if (result.failed.length) process.exitCode = 1;
}
main().catch(error => {
  // Do not print request headers, token values or raw REST response bodies.
  console.error(JSON.stringify({ status: "failed", code: error?.code ?? null,
    message: error?.code ? "Discord API request failed" : error.message }));
  process.exitCode = 1;
});
