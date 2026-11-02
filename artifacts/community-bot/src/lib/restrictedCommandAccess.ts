const STAFF_ROLES = ["守門卿", "門番", "門番見習い", "航海士", "提督", "大提督"];
const VC_COMMANDS = new Set(["vc時間", "vcランク"]);

/** Island membership does not restrict commands; feature/admin checks remain in handlers. */
export function isCommunityCommandBlocked(command: string, roleNames: Iterable<string>): boolean {
  const roles = new Set(roleNames);
  if (STAFF_ROLES.some(role => roles.has(role))) return false;
  return roles.has("追放者") && !VC_COMMANDS.has(command);
}
