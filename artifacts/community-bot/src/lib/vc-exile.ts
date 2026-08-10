/**
 * Exile-flag helpers for VC session tracking.
 *
 * Extracted from the VoiceStateUpdate handler so the computation can be
 * imported and tested independently without starting the Discord client.
 */

/**
 * Minimal shape of a Discord.js GuildMember that is needed to decide whether
 * the member currently holds the 追放者 role.  Using a structural type keeps
 * this module free of a hard discord.js dependency and makes unit testing
 * trivial — callers supply any object that satisfies the shape.
 */
export interface ExileCheckMember {
  roles: {
    cache: {
      some(predicate: (role: { name: string }) => boolean): boolean;
    };
  };
}

/**
 * Returns true when the member currently holds the 追放者 role, false in
 * every other case — including when `member` is null or undefined (safe
 * fallback: record the session as a regular session rather than silently
 * dropping it).
 */
export function resolveIsExile(
  member: ExileCheckMember | null | undefined,
): boolean {
  return member?.roles.cache.some((r) => r.name === "追放者") ?? false;
}
