import { REST, Routes } from "discord.js";

const token    = process.env["DISCORD_BOT_TOKEN"];
const clientId = process.env["DISCORD_CLIENT_ID"];

if (!token)    throw new Error("DISCORD_BOT_TOKEN is required.");
if (!clientId) throw new Error("DISCORD_CLIENT_ID is required.");

const rest = new REST().setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: [] });
console.log("✅ Discord Bot: global commands cleared.");
