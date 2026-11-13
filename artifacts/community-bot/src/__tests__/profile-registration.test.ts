import { ApplicationCommandType, Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { profileCommands } from "../commands/profile";
import { syncProfileCommandRegistration } from "../lib/profileCommandRegistration";

describe("profile command registration", () => {
  it("updates the existing profile commands and adds missing ones without replacing unrelated commands", async () => {
    const unrelated = { id: "other", name: "other", type: ApplicationCommandType.ChatInput };
    const profile = { id: "profile", name: "プロフィール", type: ApplicationCommandType.ChatInput };
    const rows = new Collection([[unrelated.id, unrelated], [profile.id, profile]]);
    const edit = vi.fn(async (id: string, body: { name: string }) => {
      const saved = { ...rows.get(id)!, ...body };
      rows.set(id, saved);
      return saved;
    });
    const create = vi.fn(async (body: { name: string }) => {
      const saved = { id: `new-${body.name}`, ...body, type: ApplicationCommandType.ChatInput };
      rows.set(saved.id, saved);
      return saved;
    });
    const fetch = vi.fn(async () => new Collection(rows));
    const client = { application: { commands: { fetch, edit, create } } };
    await syncProfileCommandRegistration(client as never);
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]![0]).toBe("profile");
    expect(create).toHaveBeenCalledOnce();
    expect(rows.has(unrelated.id)).toBe(true);
    expect(profileCommands.every(command => [...rows.values()].some(row => row.name === command.data.name))).toBe(true);
  });
});
