const STAFF_ROLES = ["守門卿", "門番", "門番見習い", "航海士", "提督", "大提督"];
const VC_COMMANDS = new Set(["vc時間", "vcランク"]);

/** Keep the existing role restrictions; permit island members' own-role lookup only. */
export function isCommunityCommandBlocked(command: string, subcommand: string | null, roleNames: Iterable<string>): boolean {
  const roles = new Set(roleNames);
  if (STAFF_ROLES.some(role => roles.has(role))) return false;
  const island = roles.has("島民"), exile = roles.has("追放者");
  if (!island && !exile || VC_COMMANDS.has(command)) return false;
  if (island && !exile && command === "zombie" && subcommand === "me") return false;
  return true;
}
