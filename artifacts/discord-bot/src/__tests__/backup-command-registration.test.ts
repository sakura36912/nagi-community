import { ApplicationCommandType, Collection, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db", () => ({ exportCurrentDatabaseJsonBackup: vi.fn() }));
import { syncBackupCommandRegistration } from "../lib/backupCommandRegistration";

function fixture(existing: boolean, valid = true) {
  const command = { id: "backup-id", name: "backup", type: ApplicationCommandType.ChatInput,
    options: valid ? [{ name: "export" }] : [] };
  const manager = {
    fetch: vi.fn(async (id?: unknown) => typeof id === "string" ? command
      : new Collection(existing ? [["backup-id", command]] : [])),
    edit: vi.fn(async () => command), create: vi.fn(async () => command),
    set: vi.fn(), delete: vi.fn(),
  };
  return { manager, client: { application: { commands: manager } } as unknown as Client };
}
describe("backup command registration", () => {
  it.each([true, false])("individually upserts and verifies /backup without replacing other commands (existing=%s)", async (existing) => {
    const { client, manager } = fixture(existing);
    await syncBackupCommandRegistration(client);
    expect(existing ? manager.edit : manager.create).toHaveBeenCalledOnce();
    expect(manager.fetch).toHaveBeenCalledWith("backup-id", { force: true });
    expect(manager.set).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });
  it("fails explicitly if the fresh definition lacks export", async () => {
    await expect(syncBackupCommandRegistration(fixture(true, false).client)).rejects.toThrow("verification");
  });
});
