import { describe, expect, it } from "vitest";
import { Collection, PermissionFlagsBits, PermissionsBitField, type VoiceChannel } from "discord.js";
import { buildHubVcPanelMessage, hubVoiceOverwrites, isBeachTransferHub, vcCommand } from "../commands/vc.js";
import {
  buildShiftEmbeds,
  buildShiftPanelComponents,
  SHIFT_UNAVAILABLE_PREFIX,
  shiftCommand,
} from "../commands/shift.js";

describe("Hub VCインチャットパネル", () => {
  it("転送先に Hub の島民・賭博師・賭博頭領の権限上書きをそのまま複製する", () => {
    const source = {
      permissionOverwrites: {
        cache: new Collection([
          ["everyone", { id: "everyone", type: 0, allow: new PermissionsBitField(), deny: new PermissionsBitField(PermissionFlagsBits.UseApplicationCommands) }],
          ["island", { id: "island", type: 0, allow: new PermissionsBitField(PermissionFlagsBits.ViewChannel), deny: new PermissionsBitField() }],
          ["dealer", { id: "dealer", type: 0, allow: new PermissionsBitField(PermissionFlagsBits.UseApplicationCommands), deny: new PermissionsBitField() }],
          ["director", { id: "director", type: 0, allow: new PermissionsBitField(PermissionFlagsBits.UseApplicationCommands), deny: new PermissionsBitField() }],
        ]),
      },
    } as unknown as VoiceChannel;

    expect(hubVoiceOverwrites(source)).toEqual([
      { id: "everyone", type: 0, allow: 0n, deny: PermissionFlagsBits.UseApplicationCommands },
      { id: "island", type: 0, allow: PermissionFlagsBits.ViewChannel, deny: 0n },
      { id: "dealer", type: 0, allow: PermissionFlagsBits.UseApplicationCommands, deny: 0n },
      { id: "director", type: 0, allow: PermissionFlagsBits.UseApplicationCommands, deny: 0n },
    ]);
  });

  it("通常のHubでは画面共有コントロールを表示する", () => {
    const message = buildHubVcPanelMessage("channel-1", "owner-1", true);
    const row = message.components[0]!;

    expect(row.components).toHaveLength(2);
    expect(message.embeds[0]!.toJSON().description).toContain("画面共有");
  });

  it("画面共有コントロールを無効にしたHubではVC名変更だけを表示する", () => {
    const message = buildHubVcPanelMessage("channel-1", "owner-1", true, false);
    const row = message.components[0]!;

    expect(row.components).toHaveLength(1);
    expect((row.components[0]!.toJSON() as { label?: string }).label).toBe("VC名変更");
    expect(message.embeds[0]!.toJSON().title).toBe("🏖️ 砂浜コントロールパネル");
    expect(message.embeds[0]!.toJSON().description).not.toContain("画面共有");
  });

  it("砂浜の名前またはカテゴリから砂浜パネルを判定する", () => {
    expect(isBeachTransferHub("砂浜")).toBe(true);
    expect(isBeachTransferHub("募集", "砂浜")).toBe(true);
    expect(isBeachTransferHub("募集", "通常VC")).toBe(false);
  });

  it("ネスト形式の /vc hub add と従来の /vc hub-add を登録する", () => {
    const definition = vcCommand.data.toJSON() as {
      options?: Array<{ name: string; options?: Array<{ name: string }> }>;
    };
    const hubGroup = definition.options?.find((option) => option.name === "hub");

    expect(hubGroup?.options?.map((option) => option.name)).toEqual(
      expect.arrayContaining(["add", "remove", "list"]),
    );
    expect(definition.options?.some((option) => option.name === "hub-add")).toBe(true);
  });

  it("shiftコマンドをDiscordの候補に表示する", () => {
    const definition = shiftCommand.data.toJSON() as {
      default_member_permissions?: string | null;
    };
    expect(definition.default_member_permissions).toBe("0");
  });

  it("/shift panelに3週分の「出れません」ボタンを表示する", () => {
    const rows = buildShiftPanelComponents((offset) => ["今週", "来週", "再来週"][offset]!);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.components).toHaveLength(3);
    expect(rows[1]!.components).toHaveLength(3);
    const unavailableButtons = rows[1]!.components.map((button) => button.toJSON() as { custom_id?: string; label?: string });
    expect(unavailableButtons.map((button) => button.custom_id)).toEqual([
      `${SHIFT_UNAVAILABLE_PREFIX}0`,
      `${SHIFT_UNAVAILABLE_PREFIX}1`,
      `${SHIFT_UNAVAILABLE_PREFIX}2`,
    ]);
    expect(unavailableButtons.map((button) => button.label)).toEqual([
      "今週：出れません",
      "来週：出れません",
      "再来週：出れません",
    ]);
  });

  it("シフト一覧に週全体の出勤不可を表示する", () => {
    const embeds = buildShiftEmbeds(
      [],
      "今週のシフト",
      "2026-09-19",
      "2026-09-25",
      true,
      [{
        id: 1,
        guildId: "guild-1",
        userId: "user-1",
        weekStart: "2026-09-19",
        createdAt: new Date(),
      }],
    );

    expect(embeds[0]!.toJSON().description).toContain("出勤不可（週全体）");
    expect(embeds[0]!.toJSON().description).toContain("<@user-1>");
  });
});