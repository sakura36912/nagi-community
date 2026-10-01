import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Collection,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";

const db = vi.hoisted(() => ({
  getBountySettings: vi.fn(),
  getBountyPoints: vi.fn(),
  applyBountyPoints: vi.fn(),
  setBountyVcRate: vi.fn(),
  setBountyMonthlyRate: vi.fn(),
  listPendingBountyAudits: vi.fn(),
  listPendingBountyMonthlyApprovalAudits: vi.fn(),
}));
vi.mock("@workspace/db", () => db);

import {
  BOUNTY_GUILD_ID, bountyCommand, handleBountyButton, handleBountyChannelSelect,
  handleBountyModalSubmit, handleBountyRoleSelect, handleBountyUserSelect,
} from "../commands/bounty";

const targetId = "123456789012345678";
function makeInteraction(customId: string, options: {
  staff?: boolean; roleName?: string; roleIds?: string[]; cachedMember?: boolean; guildId?: string;
} = {}) {
  const roleIds = options.roleIds ?? ["public-relations"];
  const send = vi.fn();
  const interaction = {
    id: "interaction-id", customId,
    deferred: false,
    guildId: options.guildId ?? BOUNTY_GUILD_ID,
    guild: {
      id: BOUNTY_GUILD_ID,
      roles: { cache: new Collection([
        ["public-relations", { name: options.roleName ?? "広報部" }],
        ["crew-impostor", { name: "本船員" }],
      ]) },
      members: { fetch: vi.fn(async () => ({ roles: { cache: new Collection([["crew", {}]]) } })) },
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) },
    },
    user: { id: "operator" },
    member: { roles: options.cachedMember ? { cache: new Collection(roleIds.map((id) => [id, {}])) } : roleIds },
    memberPermissions: { has: () => options.staff ?? false },
    users: { first: () => ({ id: targetId }) },
    values: [targetId],
    fields: { getTextInputValue: (field: string) => field === "reason" ? "調整理由" : "10" },
    options: { getSubcommand: () => customId, getUser: () => ({ id: "other" }) },
    reply: vi.fn(), editReply: vi.fn(), deferReply: vi.fn(), showModal: vi.fn(),
    send,
  };
  interaction.deferReply.mockImplementation(async () => { interaction.deferred = true; });
  return interaction;
}
type MockInteraction = ReturnType<typeof makeInteraction>;
const panelSteps = [
  { id: "bounty:manual:user", run: (i: MockInteraction) => handleBountyUserSelect(i as unknown as UserSelectMenuInteraction) },
  { id: `bounty:manual:sign:+:${targetId}`, run: (i: MockInteraction) => handleBountyButton(i as unknown as ButtonInteraction) },
  { id: "bounty:vc:channel", run: (i: MockInteraction) => handleBountyChannelSelect(i as unknown as ChannelSelectMenuInteraction) },
  { id: "bounty:monthly:role", run: (i: MockInteraction) => handleBountyRoleSelect(i as unknown as RoleSelectMenuInteraction) },
];
const modalIds = [
  `bounty:manual:modal:+:${targetId}`,
  `bounty:manual:modal:-:${targetId}`,
  `bounty:vc:modal:${targetId}`,
  `bounty:monthly:modal:${targetId}`,
];

beforeEach(() => {
  vi.resetAllMocks();
  db.getBountySettings.mockResolvedValue({ crewRoleId: "crew", tierRoleIds: [] });
  db.getBountyPoints.mockResolvedValue(100);
  db.applyBountyPoints.mockResolvedValue({ applied: true, before: 100, after: 110 });
  db.setBountyVcRate.mockResolvedValue([]);
  db.setBountyMonthlyRate.mockResolvedValue([]);
  db.listPendingBountyAudits.mockResolvedValue([]);
  db.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([]);
});

describe("bounty settings panel permissions", () => {
  it.each(panelSteps)("allows 広報部 and configured crew through $id with raw and cached member roles", async ({ id, run }) => {
    for (const options of [
      { cachedMember: false, roleIds: ["public-relations"] },
      { cachedMember: true, roleIds: ["public-relations"] },
      { cachedMember: false, roleIds: ["crew"] },
      { cachedMember: true, roleIds: ["crew"] },
    ]) {
      const interaction = makeInteraction(id, options);
      expect(await run(interaction)).toBe(true);
      expect(db.getBountySettings).toHaveBeenCalled();
      if (id === "bounty:manual:user") {
        expect(interaction.reply.mock.calls[0][0].components).toHaveLength(1);
      } else {
        expect(interaction.showModal).toHaveBeenCalledOnce();
      }
    }
  });

  it.each(modalIds.flatMap((id) => ["public-relations", "crew"].map((role) => ({ id, role }))))(
    "allows $role to save $id, retaining audit behavior", async ({ id, role }) => {
    const interaction = makeInteraction(id, { roleIds: [role] });
    await handleBountyModalSubmit(interaction as unknown as ModalSubmitInteraction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    if (id.startsWith("bounty:manual:")) {
      const delta = id.includes(":-:") ? -10 : 10;
      expect(db.applyBountyPoints).toHaveBeenCalledWith(
        BOUNTY_GUILD_ID, targetId, delta, "調整理由", "operator", "interaction-id",
      );
      expect(db.listPendingBountyAudits).toHaveBeenCalled();
    } else {
      expect(id.startsWith("bounty:vc:") ? db.setBountyVcRate : db.setBountyMonthlyRate)
        .toHaveBeenCalledWith(BOUNTY_GUILD_ID, targetId, 10);
      expect(interaction.send).toHaveBeenCalledOnce();
    }
    expect(interaction.editReply.mock.calls[0][0].content).not.toContain("失敗");
  });

  it("denies nonmembers, similarly named roles, and other guilds at every stage", async () => {
    for (const opts of [
      { roleIds: [] }, { roleName: "広報部補佐" }, { roleIds: ["crew-impostor"] },
      { guildId: "other-guild" }, { guildId: "other-guild", roleIds: ["crew"] },
    ]) {
      for (const { id, run } of panelSteps) {
        const interaction = makeInteraction(id, opts);
        await run(interaction);
        expect(interaction.showModal).not.toHaveBeenCalled();
        expect(interaction.reply.mock.calls[0][0].ephemeral).toBe(true);
      }
      for (const id of modalIds) {
        const interaction = makeInteraction(id, opts);
        await handleBountyModalSubmit(interaction as unknown as ModalSubmitInteraction);
        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(interaction.reply.mock.calls[0][0].ephemeral).toBe(true);
      }
    }
    expect(db.applyBountyPoints).not.toHaveBeenCalled();
    expect(db.setBountyVcRate).not.toHaveBeenCalled();
    expect(db.setBountyMonthlyRate).not.toHaveBeenCalled();
  });

  it.each(["public-relations", "crew"])("rechecks authorization when %s is removed before modal submission", async (role) => {
    const select = makeInteraction("bounty:vc:channel", { roleIds: [role] });
    await handleBountyChannelSelect(select as unknown as ChannelSelectMenuInteraction);
    expect(select.showModal).toHaveBeenCalledOnce();
    const submit = makeInteraction(`bounty:vc:modal:${targetId}`, { roleIds: [] });
    await handleBountyModalSubmit(submit as unknown as ModalSubmitInteraction);
    expect(db.setBountyVcRate).not.toHaveBeenCalled();
    expect(submit.reply.mock.calls[0][0].content).toContain("広報部");
  });

  it("retains administrator access without the 広報部 role", async () => {
    for (const { id, run } of panelSteps) {
      const interaction = makeInteraction(id, { staff: true, roleIds: [] });
      await run(interaction);
      expect(interaction.reply.mock.calls[0]?.[0].content ?? "").not.toContain("必要です");
      if (id !== "bounty:manual:user") expect(interaction.showModal).toHaveBeenCalledOnce();
    }
    for (const id of modalIds) {
      const interaction = makeInteraction(id, { staff: true, roleIds: [] });
      await handleBountyModalSubmit(interaction as unknown as ModalSubmitInteraction);
      expect(interaction.deferReply).toHaveBeenCalledOnce();
    }
  });

  it.each(["public-relations", "crew"])("does not extend management operations to %s", async (role) => {
    for (const command of ["setup", "panels", "review-status", "review-confirm", "review-import", "balance"]) {
      const interaction = makeInteraction(command, { roleIds: [role] });
      await bountyCommand.execute(interaction as unknown as ChatInputCommandInteraction);
      expect(interaction.reply.mock.calls[0][0].content).toContain("ManageGuild");
    }
    for (const id of ["bounty:review:confirm:2026-09:operator:hash", "bounty:review:import:token"]) {
      const interaction = makeInteraction(id, { roleIds: [role] });
      await handleBountyButton(interaction as unknown as ButtonInteraction);
      expect(interaction.reply.mock.calls[0][0].content).toContain("ManageGuild");
    }
    expect(db.getBountySettings).not.toHaveBeenCalled();
  });

  it("uses the configured crew role ID rather than an unrelated role with the same name", async () => {
    db.getBountySettings.mockResolvedValue({ crewRoleId: "new-crew", tierRoleIds: [] });
    const oldRole = makeInteraction("bounty:vc:channel", { roleIds: ["crew"] });
    await handleBountyChannelSelect(oldRole as unknown as ChannelSelectMenuInteraction);
    expect(oldRole.showModal).not.toHaveBeenCalled();
    const configuredRole = makeInteraction("bounty:vc:channel", { roleIds: ["new-crew"] });
    await handleBountyChannelSelect(configuredRole as unknown as ChannelSelectMenuInteraction);
    expect(configuredRole.showModal).toHaveBeenCalledOnce();
  });
});