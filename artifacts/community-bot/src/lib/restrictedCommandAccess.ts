const STAFF_ROLES = ["守門卿", "門番", "門番見習い", "航海士", "提督", "大提督"];
const VC_COMMANDS = new Set(["vc時間", "vcランク"]);

/** Let island members reach /zombie; its handler retains per-action Administrator checks. */
export function isCommunityCommandBlocked(command: string, roleNames: Iterable<string>): boolean {
  const roles = new Set(roleNames);
  if (STAFF_ROLES.some(role => roles.has(role))) return false;
  const island = roles.has("島民"), exile = roles.has("追放者");
  if (!island && !exile || VC_COMMANDS.has(command)) return false;
  if (island && !exile && command === "zombie") return false;
  return true;
}
