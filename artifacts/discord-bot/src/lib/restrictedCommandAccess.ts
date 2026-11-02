const STAFF_ROLES = [
  "守門卿", "門番", "門番見習い", "見習い門番", "航海士", "提督", "大提督", "賭博頭領", "賭博師",
];
const EXPELLED_COMMANDS = new Set([
  "送金", "残高確認", "slot", "blackjack", "highlow", "chinchiro", "裏航海", "bounty",
]);

/** Only the exile restriction remains; this never grants feature-specific or admin permission. */
export function isBankCommandBlocked(command: string, roleNames: Iterable<string>): boolean {
  const roles = new Set(roleNames);
  if (STAFF_ROLES.some(role => roles.has(role))) return false;
  return roles.has("追放者") && !EXPELLED_COMMANDS.has(command);
}
