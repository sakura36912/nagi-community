import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type Client } from "discord.js";
import { stat } from "node:fs/promises";

const mocks = vi.hoisted(() => ({ exportBackup: vi.fn() }));
vi.mock("@workspace/db", () => ({ exportCurrentDatabaseJsonBackup: mocks.exportBackup }));
import { backupCommand, handleBackupButton, isBackupOwner } from "../commands/backup";

const result = () => ({
  directory: "/not-read-by-mocked-discord",
  files: ["manifest.json", "data-0001.json", "data-0002.json", "data-0003.json"],
  manifest: { tableCount: 2, totalRows: 5, parts: [{}, {}, {}] },
});
function fixture(userId = "owner") {
  return {
    customId: "database-backup:confirm:owner", user: { id: userId },
    client: { application: { fetch: vi.fn(async () => ({ owner: { id: "owner" } })) } },
    memberPermissions: { has: () => true },
    deferReply: vi.fn().mockResolvedValue(undefined), deferUpdate: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined), channel: { send: vi.fn() },
  };
}
beforeEach(() => { vi.clearAllMocks(); mocks.exportBackup.mockResolvedValue(result()); });
describe("owner-only database backup command", () => {
  it("denies an ordinary server administrator and acknowledges before checking ownership", async () => {
    const interaction = fixture("server-admin");
    await backupCommand.execute(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(interaction.client.application.fetch.mock.invocationCallOrder[0]);
    expect(interaction.editReply.mock.calls[0][0]).toContain("所有者専用");
    expect(mocks.exportBackup).not.toHaveBeenCalled();
  });
  it("asks the owner to confirm a cross-server sensitive export, without starting one", async () => {
    const interaction = fixture();
    await backupCommand.execute(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.editReply.mock.calls[0][0]).toMatchObject({ content: expect.stringContaining("全サーバー・全ユーザー"), components: expect.any(Array) });
    expect(mocks.exportBackup).not.toHaveBeenCalled();
  });
  it("accepts only the team owner, not an arbitrary team member", async () => {
    const client = { application: { fetch: async () => ({ owner: { id: "team", ownerId: "team-owner" } }) } } as unknown as Client;
    expect(await isBackupOwner(client, "team-owner")).toBe(true);
    expect(await isBackupOwner(client, "team")).toBe(false);
    expect(await isBackupOwner(client, "team-member")).toBe(false);
  });
  it("rejects another actor before reading the DB", async () => {
    const interaction = fixture("other");
    await handleBackupButton(interaction as unknown as ButtonInteraction);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(interaction.client.application.fetch).not.toHaveBeenCalled();
    expect(mocks.exportBackup).not.toHaveBeenCalled();
  });
  it("rechecks ownership at confirmation and fails closed on lookup errors", async () => {
    const interaction = fixture();
    interaction.client.application.fetch.mockRejectedValueOnce(new Error("Discord unavailable"));
    await handleBackupButton(interaction as unknown as ButtonInteraction);
    expect(mocks.exportBackup).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls.at(-1)?.[0].content).toContain("失敗");
  });
  it("does not export after ownership has changed since opening the confirmation", async () => {
    const interaction = fixture();
    interaction.client.application.fetch.mockResolvedValueOnce({ owner: { id: "new-owner" } });
    await handleBackupButton(interaction as unknown as ButtonInteraction);
    expect(mocks.exportBackup).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls.at(-1)?.[0].content).toContain("所有者権限");
  });
  it("uploads every part privately and removes local copies after delivery", async () => {
    const interaction = fixture();
    await handleBackupButton(interaction as unknown as ButtonInteraction);
    expect(mocks.exportBackup).toHaveBeenCalledWith(expect.objectContaining({ source: "bot-runtime", maxPartBytes: 7 * 1024 * 1024 }));
    expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral, files: expect.any(Array) }));
    expect(interaction.channel.send).not.toHaveBeenCalled();
    const uploaded = [...interaction.editReply.mock.calls, ...interaction.followUp.mock.calls]
      .flatMap(([payload]) => payload.files ?? []).map((file) => file.name).sort();
    expect(uploaded).toEqual(result().files.sort());
    expect(interaction.editReply.mock.calls.at(-1)?.[0].content).toContain("バックアップ完了");
    await expect(stat(mocks.exportBackup.mock.calls[0][0].outputRoot)).rejects.toThrow();
  });
  it("never claims success if only some attachments were delivered", async () => {
    const interaction = fixture();
    interaction.followUp.mockRejectedValueOnce(new Error("Upload failed"));
    await handleBackupButton(interaction as unknown as ButtonInteraction);
    expect(interaction.editReply.mock.calls.at(-1)?.[0].content).toContain("完全なバックアップではありません");
    expect(interaction.editReply.mock.calls.some(([payload]) => payload.content?.includes("✅"))).toBe(false);
    await expect(stat(mocks.exportBackup.mock.calls[0][0].outputRoot)).rejects.toThrow();
  });
  it("blocks overlapping exports without unlocking the job that is still running", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    mocks.exportBackup.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = handleBackupButton(fixture() as unknown as ButtonInteraction);
    await vi.waitFor(() => expect(mocks.exportBackup).toHaveBeenCalledOnce());
    const second = fixture();
    await handleBackupButton(second as unknown as ButtonInteraction);
    expect(mocks.exportBackup).toHaveBeenCalledOnce();
    expect(second.editReply.mock.calls.at(-1)?.[0].content).toContain("作成中");
    finish(result());
    await first;
  });
  it("cancels without touching the database", async () => {
    const interaction = fixture();
    interaction.customId = "database-backup:cancel:owner";
    await handleBackupButton(interaction as unknown as ButtonInteraction);
    expect(mocks.exportBackup).not.toHaveBeenCalled();
  });
});
