export const WAITING_ROLE_NAME = "入島待ち";
export const POST_ISLAND_ROLE_NAMES = ["本船員", "新入り", "漂流者", "追放者"] as const;
export const MAX_DISPLAYED_LATEST_ROLES = 10;
export const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;

export interface DepartureRoleSnapshot {
  hasWaitingRole: boolean;
  hasPostIslandRole: boolean;
  roleNames: string[];
}

export function buildDepartureRoleSnapshot(roleNames: readonly string[]): DepartureRoleSnapshot {
  return {
    hasWaitingRole: roleNames.includes(WAITING_ROLE_NAME),
    hasPostIslandRole: roleNames.some((name) => POST_ISLAND_ROLE_NAMES.includes(name as typeof POST_ISLAND_ROLE_NAMES[number])),
    roleNames: [...roleNames],
  };
}

export interface RejoinLogTextParams {
  displayName: string;
  userId: string;
  waitingExitCount: number;
  postIslandExitCount: number;
  latestPostIslandRoles: readonly string[];
}

/** Discordの通常メッセージ本文として検索できる出戻りログを作る。 */
export function buildRejoinLogText(params: RejoinLogTextParams): string {
  const normalizedDisplayName = params.displayName.replace(/\s+/g, " ").slice(0, 100);
  const displayedRoles = params.latestPostIslandRoles
    .slice(0, MAX_DISPLAYED_LATEST_ROLES)
    .map((name) => name.replace(/\s+/g, " ").slice(0, 100));
  const omittedRoleCount = Math.max(
    0,
    params.latestPostIslandRoles.length - displayedRoles.length,
  );
  const latestRoleText = displayedRoles.length === 0
    ? "未記録"
    : displayedRoles.join(" / ")
      + (omittedRoleCount > 0 ? ` / … 他 ${omittedRoleCount}件` : "");

  const content = [
    `名前: ${normalizedDisplayName}`,
    `ID: ${params.userId}`,
    `入島待ち退出回数: ${params.waitingExitCount}回`,
    `入島後退出回数: ${params.postIslandExitCount}回`,
    `最新ロール: ${latestRoleText}`,
  ].join("\n");

  // Discord message content is limited to 2,000 characters. The limits above
  // should keep normal content far below this, and this guard protects against
  // unexpectedly large numeric/string inputs.
  return content.slice(0, DISCORD_MESSAGE_CONTENT_LIMIT);
}