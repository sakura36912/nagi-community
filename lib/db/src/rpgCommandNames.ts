/** Discord command ownership: gameplay is served by the community Bot. */
export const RPG_COMMAND_NAMES = [
  "武器選択", "武器", "強化", "強化費用確認", "強化費用設定", "強化成功率設定",
  "強化費用リセット", "強化成功率リセット", "武器変更", "武器リセット", "武器確認",
  "ボス開催", "ボス終了", "ボス情報", "参加", "攻撃", "回復", "ボス料金設定", "ボス料金確認",
] as const;
export const LEGACY_RPG_COMMAND_NAMES = [
  "weapon_select", "weapon", "upgrade", "weapon_admin_change", "weapon_admin_reset", "weapon_admin_edit",
  "boss_start", "boss_end", "boss_info", "boss_join", "boss_attack", "boss_heal",
] as const;
export function isRpgCommandName(name: string) {
  return (RPG_COMMAND_NAMES as readonly string[]).includes(name);
}
export function isRetiredBankRpgCommand(name: string) {
  return isRpgCommandName(name) || (LEGACY_RPG_COMMAND_NAMES as readonly string[]).includes(name);
}
