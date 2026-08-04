import { REST, Routes } from "discord.js";

const token    = process.env["COMMUNITY_BOT_TOKEN"];
const clientId = process.env["COMMUNITY_CLIENT_ID"];

if (!token)    throw new Error("COMMUNITY_BOT_TOKEN is required.");
if (!clientId) throw new Error("COMMUNITY_CLIENT_ID is required.");

const rest = new REST().setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: [] });
console.log("✅ Community Bot: global commands cleared.");
