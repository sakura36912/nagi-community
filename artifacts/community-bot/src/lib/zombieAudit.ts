import { EmbedBuilder, escapeMarkdown } from "discord.js";
import type { ZombieGame, ZombieJob } from "@workspace/db";

const statuses = { accepted: "成立", rejected: "却下", stale: "無効（状態変更・期限切れ）", pending: "確認待ち" };

export function zombieAuditEmbed(
  game: ZombieGame,
  jobId: string,
  payload: ZombieJob,
  channelName?: (id: string) => string | undefined,
) {
  const key = jobId.startsWith(`${game.id}:`) ? jobId.slice(game.id.length + 1) : "";
  const [kind, requestId] = key.split(":");
  const request = requestId && Object.hasOwn(game.requests, requestId) ? game.requests[requestId] : undefined;
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle("イベント管理ログ")
    .setFooter({ text: `イベントID：${game.id}` });
  const person = (id: string) => {
    const player = Object.hasOwn(game.players, id) ? game.players[id] : undefined;
    return `${escapeMarkdown(player?.name ?? "名前を取得できません")}\nID：${id}`.slice(0, 1024);
  };
  const vc = (id: string) => {
    const name = channelName?.(id);
    return `${name ? escapeMarkdown(name) : "VC名を取得できません（削除済み等）"}\nID：${id}`.slice(0, 1024);
  };

  if (request && ["decision", "misheal", "misheal-expired", "move-failed"].includes(kind!)) {
    embed.setFooter({ text: `操作ID：${request.id} ｜ イベントID：${game.id}` });
    if (kind === "decision") {
      const accepted = request.status === "accepted";
      const label = request.type === "infect" ? "感染" : request.misheal ? "誤治療" : "治療";
      embed.setTitle(`${label}：${statuses[request.status]}`)
        .setColor(!accepted ? 0x808080 : request.misheal ? 0xe6a23c : request.type === "infect" ? 0x9b59b6 : 0x2eaf76)
        .addFields(
          { name: "実行者", value: person(request.actor), inline: true },
          { name: "対象者", value: person(request.target), inline: true },
          { name: "判定方法", value: request.decidedBy === "system" ? "自動判定（管理承認不要）" : `管理判断\n管理者ID：${request.decidedBy ?? "未記録"}` },
          { name: "同席VC", value: vc(request.channel), inline: true },
          { name: "連続同席時間", value: `${Math.floor(request.seconds / 60)}分${Math.floor(request.seconds % 60)}秒`, inline: true },
        );
      if (accepted && request.misheal) {
        embed.addFields({ name: "処理内容", value: "対象者は人間のため感染状態は変わりません。\n対象者に60秒のVC移動制限を適用します。" });
      } else if (accepted && request.type === "heal") {
        embed.addFields({ name: "処理内容", value: "対象者を人間に戻しました。\n実行者に60秒の治療クールタイムを適用します。" });
      } else if (accepted) {
        embed.addFields({ name: "処理内容", value: "対象者がゾンビになりました。" });
      } else {
        embed.addFields({ name: "処理内容", value: "感染・治療は成立していません。" });
      }
    } else {
      const expired = kind === "misheal-expired";
      embed.setTitle(expired ? "VC移動制限：解除" : kind === "misheal" ? "誤治療：VC移動制限を開始" : "VC引き戻し：失敗")
        .setColor(expired ? 0x2eaf76 : kind === "move-failed" ? 0xe05252 : 0xe6a23c)
        .addFields({ name: "対象者", value: person(request.target), inline: true },
          { name: "対象VC", value: vc(request.channel), inline: true });
      const details = expired
        ? payload.text?.includes("イベント終了") ? "イベント終了により制限を解除しました。" : "60秒の制限時間が終了しました。"
        : kind === "misheal" ? "制限時間は60秒です。\n別のVCへ移動すると対象VCへ戻します。切断は妨げません。"
          : "Botのメンバー移動・接続・閲覧権限、VCとメンバーの状態を確認してください。\n制限時間内は再試行します。";
      embed.setDescription(details);
    }
    return embed;
  }
  // Preserve other and legacy audit messages; never discard an unrecognised job.
  return embed.setDescription(escapeMarkdown(payload.text || "詳細は記録されていません。").slice(0, 4000));
}
