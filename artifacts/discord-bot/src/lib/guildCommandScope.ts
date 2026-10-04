import { REST, Routes, type APIApplicationCommand } from "discord.js";

/** This guild uses global definitions when the same name/type exists in both scopes. */
export const GLOBAL_PREFERRED_GUILD_ID = "1526418867335725247";
export function prefersGlobalCommands(guildId: string): boolean {
  return guildId === GLOBAL_PREFERRED_GUILD_ID;
}

export function commandScopeKey(command: Pick<APIApplicationCommand, "name" | "type">): string {
  return `${command.type}:${command.name}`;
}

/** Delete individual guild duplicates only, never replace a scope or write globals. */
export async function deleteDuplicateGuildCommands(
  rest: Pick<REST, "get" | "delete">,
  applicationId: string,
  guildId: string,
): Promise<string[]> {
  const globalRoute = Routes.applicationCommands(applicationId);
  const guildRoute = Routes.applicationGuildCommands(applicationId, guildId);
  const [globalCommands, guildCommands] = await Promise.all([
    rest.get(globalRoute) as Promise<APIApplicationCommand[]>,
    rest.get(guildRoute) as Promise<APIApplicationCommand[]>,
  ]);
  const globalKeys = new Set(globalCommands.map(commandScopeKey));
  const duplicates = guildCommands.filter((command) => globalKeys.has(commandScopeKey(command)));
  const protectedIds = guildCommands
    .filter((command) => !globalKeys.has(commandScopeKey(command)))
    .map((command) => command.id);
  for (const command of duplicates) {
    await rest.delete(Routes.applicationGuildCommand(applicationId, guildId, command.id));
  }
  // REST reads bypass discord.js' command cache.
  const remaining = await rest.get(guildRoute) as APIApplicationCommand[];
  if (remaining.some((command) => globalKeys.has(commandScopeKey(command)))) {
    throw new Error("Duplicate guild commands remain after deletion");
  }
  if (protectedIds.some((id) => !remaining.some((command) => command.id === id))) {
    throw new Error("A guild-only command disappeared during duplicate cleanup");
  }
  return duplicates.map((command) => command.name);
}