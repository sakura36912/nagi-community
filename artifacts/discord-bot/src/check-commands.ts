import { REST, Routes } from "discord.js";

async function main() {
  const guildIds = ["1475483930810384582", "1513449271955951646"];

  const communityRest = new REST().setToken(process.env["COMMUNITY_BOT_TOKEN"]!);
  const communityClientId = process.env["COMMUNITY_CLIENT_ID"]!;

  for (const gid of guildIds) {
    try {
      const cmds = await communityRest.get(Routes.applicationGuildCommands(communityClientId, gid)) as any[];
      const pay = cmds.filter((c: any) => c.name === "送金");
      console.log(`Community Bot guild ${gid}: total=${cmds.length}, 送金=${pay.length}`);
      if (cmds.length > 0) console.log("  commands:", cmds.map((c: any) => c.name).join(", "));
    } catch (e: any) {
      console.log(`Community Bot guild ${gid}: ${e.message}`);
    }
  }
}

main().catch(console.error);
