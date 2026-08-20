/** VC滞在報酬の対象となる砂浜VCを判定する。 */
export function isBeachVoiceChannel(
  channelName: string,
  parentCategoryName: string | null | undefined,
): boolean {
  return channelName.trim() === "砂浜" || parentCategoryName?.trim() === "砂浜";
}