const STAFF_ROLES = ["守門卿", "門番", "門番見習い", "航海士", "提督", "大提督"];
const VC_COMMANDS = new Set(["vc時間", "vcランク"]);
const ZOMBIE_COMMANDS = new Set(["zombie", "infect", "heal"]);

/** Island members may reach event handlers; role, participation and admin checks remain there. */
export function isCommunityCommandBlocked(command: string, roleNames: Iterable<string>): boolean {
  const roles = new Set(roleNames);
  if (STAFF_ROLES.some(role => roles.has(role))) return false;
  const island = roles.has("島民"), exile = roles.has("追放者");
  if (!island && !exile || VC_COMMANDS.has(command)) return false;
  if (island && !exile && ZOMBIE_COMMANDS.has(command)) return false;
  return true;
}
