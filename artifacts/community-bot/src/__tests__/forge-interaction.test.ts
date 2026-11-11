import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection, PermissionFlagsBits, type ChatInputCommandInteraction, type ButtonInteraction } from "discord.js";

const m = vi.hoisted(() => ({
  select: vi.fn(), getWeapon: vi.fn(), getSetting: vi.fn(), create: vi.fn(), settle: vi.fn(),
  cancel: vi.fn(), admin: vi.fn(), configure: vi.fn(), reset: vi.fn(), list: vi.fn(),
  error: vi.fn(), warn: vi.fn(),
}));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(),
  selectForgeWeapon: m.select, getForgeWeapon: m.getWeapon, getForgeSetting: m.getSetting,
  createForgeUpgradeRequest: m.create, settleForgeUpgrade: m.settle, cancelForgeUpgrade: m.cancel,
  adminForgeWeapon: m.admin, configureForgeSetting: m.configure,
  resetForgeSettings: m.reset, listForgeSettings: m.list,
}));
vi.mock("../lib/logger", () => ({ logger: { error: m.error, warn: m.warn, info: vi.fn() } }));
vi.mock("../lib/rpgCards", async original => ({
  ...await original<typeof import("../lib/rpgCards")>(), runRpgCards: vi.fn().mockResolvedValue(undefined),
}));
import { ForgeError } from "@workspace/db";
import { executeForgeCommand, forgeCommands, handleForgeButton } from "../commands/forge";
import { syncForgeCommandRegistration } from "../lib/forgeCommandRegistration";

function fixture(name = "武器") {
  const flags = { admin: false, crew: true, card: true };
  const roles = new Collection([["crew", { id: "crew", name: "本船員" }]]);
  const options: Record<string, unknown> = {};
  return {
    flags, roles, values: options,
    id: "1234567890123456789", commandName: name, customId: "forge:confirm:1234567890123456789",
    guild: { id: "guild", roles: { fetch: vi.fn(async () => roles) },
      members: { me: {}, fetch: vi.fn(async () => ({
        permissions: { has: () => flags.admin },
        roles: { cache: { has: () => flags.crew } },
      })) } },
    user: { id: "user" },
    client: {},
    channel: { id: "channel", isDMBased: () => false, isTextBased: () => true, isThread: () => false,
      send: vi.fn(), permissionsFor: () => ({ has: () => flags.card }) },
    options: {
      getString: (key: string) => options[key] ?? null,
      getInteger: (key: string) => options[key] ?? null,
      getBoolean: (key: string) => options[key] ?? null,
      getUser: (key: string) => options[key] ?? null,
    },
    message: { edit: vi.fn().mockResolvedValue(undefined) },
    deferReply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
  };
}
const run = (i: ReturnType<typeof fixture>) => executeForgeCommand(i as unknown as ChatInputCommandInteraction);
const click = (i: ReturnType<typeof fixture>) => handleForgeButton(i as unknown as ButtonInteraction);
beforeEach(() => {
  vi.clearAllMocks();
  m.getWeapon.mockResolvedValue({ weaponType: "bow", weaponLevel: 1, attack: 9999, defense: 8888 });
  m.getSetting.mockResolvedValue({ level: 1, cost: 1000, successRate: 100 });
  m.create.mockResolvedValue({ id: "1234567890123456789", weaponType: "bow", weaponLevel: 1, cost: 1000, successRate: 100 });
  m.settle.mockResolvedValue({ action: "upgrade", weaponType: "bow", level: 2, success: true, cost: 1000, balance: 9000 });
  m.admin.mockResolvedValue({ level: 4 });
  m.list.mockResolvedValue([{ level: 1, cost: 1000, successRate: 100 }]);
});

describe("forge command permissions and UI", () => {
  it("opens a fresh private payment confirmation from the owner's repeat button without charging", async () => {
    const i = fixture(); i.customId = "forge:upgrade:user";
    await click(i);
    expect(m.create).toHaveBeenCalledWith(i.id, "guild", "user");
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.message.edit).not.toHaveBeenCalled();
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("支払って強化");
  });
  it("rejects another member pressing the public repeat-upgrade button", async () => {
    const i = fixture(); i.customId = "forge:upgrade:another-user";
    await click(i);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("本人のみ");
    expect(i.message.edit).not.toHaveBeenCalled();
  });
  it("defines eleven Japanese slash commands, with admin defaults only on admin commands", () => {
    expect(forgeCommands).toHaveLength(11);
    const names = forgeCommands.map(c => c.data.name);
    expect(new Set(names).size).toBe(11);
    expect(names).not.toContain("baccarat");
    expect(names).not.toContain("calendar");
    expect(forgeCommands.find(c => c.data.name === "武器確認")?.data.toJSON().default_member_permissions)
      .toBe(PermissionFlagsBits.Administrator.toString());
    expect(forgeCommands.find(c => c.data.name === "武器")?.data.toJSON().default_member_permissions).toBeUndefined();
  });
  it("rejects non-crew even if administrator; checks live membership", async () => {
    const i = fixture(); i.flags.crew = false; i.flags.admin = true;
    await run(i);
    expect(m.getWeapon).not.toHaveBeenCalled();
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "user", force: true });
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("本船員") }));
  });
  it("rejects missing or ambiguous crew roles before touching weapon data", async () => {
    const i = fixture(); i.roles.clear();
    await run(i);
    expect(m.getWeapon).not.toHaveBeenCalled();
    i.roles.set("one", { id: "one", name: "本船員" }); i.roles.set("two", { id: "two", name: "本船員" });
    await run(i);
    expect(m.getWeapon).not.toHaveBeenCalled();
  });
  it("rejects DMs", async () => {
    const i = fixture();
    await executeForgeCommand({ ...i, guild: null } as unknown as ChatInputCommandInteraction);
    expect(m.getWeapon).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("サーバー内") }));
  });
  it("allows crew to select exactly one of the six types", async () => {
    const i = fixture("武器選択"); i.values["種類"] = "staff";
    await run(i);
    expect(m.select).toHaveBeenCalledWith(i.id, "guild", "user", "staff", "channel");
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("杖"));
  });
  it("shows only public information for /武器", async () => {
    const i = fixture();
    await run(i);
    const output = JSON.stringify(i.editReply.mock.calls);
    expect(output).toContain("貫通矢");
    expect(output).not.toMatch(/9999|8888|内部攻撃力|内部防御力/);
  });
  it("requires administrator permissions for internal stats and changes", async () => {
    for (const name of ["武器確認", "武器変更", "武器リセット", "強化費用設定", "強化成功率設定"]) {
      const i = fixture(name);
      await run(i);
      expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("管理者のみ") }));
    }
    expect(m.admin).not.toHaveBeenCalled();
    expect(m.configure).not.toHaveBeenCalled();
    expect(m.getWeapon).not.toHaveBeenCalled();
  });
  it("shows internal stats only in administrator /武器確認", async () => {
    const i = fixture("武器確認"); i.flags.admin = true; i.flags.crew = false;
    i.values["ユーザー"] = { id: "target" };
    await run(i);
    expect(m.getWeapon).toHaveBeenCalledWith("guild", "target");
    expect(JSON.stringify(i.editReply.mock.calls)).toMatch(/内部攻撃力.*9999/);
  });
  it("shows cost, chance and loss warning without charging until confirmation", async () => {
    const i = fixture("強化");
    await run(i);
    expect(m.create).toHaveBeenCalledWith(i.id, "guild", "user");
    expect(m.settle).not.toHaveBeenCalled();
    const output = JSON.stringify(i.editReply.mock.calls);
    expect(output).toContain("失敗した場合も費用を消費");
    expect(output).toContain("支払って強化");
    expect(output).toContain("100%");
    expect(output).not.toMatch(/attack|defense|内部攻撃力/);
  });
  it("handles confirmation and disables the paid panel", async () => {
    const i = fixture();
    await click(i);
    expect(m.settle).toHaveBeenCalledWith(i.id, "guild", "user", undefined, "channel");
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("強化成功"), components: expect.any(Array) }));
    expect(i.message.edit).toHaveBeenCalledWith({ components: [] });
  });
  it("supports cancelling without settling", async () => {
    const i = fixture(); i.customId = `forge:cancel:${i.id}`;
    await click(i);
    expect(m.cancel).toHaveBeenCalledWith(i.id, "guild", "user");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("refuses selection or paid upgrades before mutation when public card permissions are missing", async () => {
    const i = fixture("武器選択"); i.values["種類"] = "bow"; i.flags.card = false;
    await run(i);
    expect(m.select).not.toHaveBeenCalled();
    await click(i);
    expect(m.settle).not.toHaveBeenCalled();
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("埋め込みリンク");
  });
  it("does not settle after crew role revocation", async () => {
    const i = fixture(); i.flags.crew = false;
    await click(i);
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.message.edit).not.toHaveBeenCalled();
  });
  it("surfaces insufficient funds and cross-user/stale errors without changing the source panel", async () => {
    const i = fixture();
    m.settle.mockRejectedValue(new ForgeError("残高が不足しています。"));
    await click(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "残高が不足しています。" }));
    expect(i.message.edit).not.toHaveBeenCalled();
  });
  it("reports a replay as already paid, and failures as charged with no level loss", async () => {
    const i = fixture();
    m.settle.mockResolvedValue({ action: "upgrade", weaponType: "bow", level: 2, success: false, cost: 3000, balance: 6000, repeated: true });
    await click(i);
    const output = JSON.stringify(i.editReply.mock.calls);
    expect(output).toContain("再度の引き落としはありません");
    expect(output).toContain("強化失敗");
    expect(output).toContain("$3,000");
    expect(output).toContain("レベル低下・破壊はありません");
  });
  it("requires explicit confirmation for destructive admin actions", async () => {
    const i = fixture("武器リセット"); i.flags.admin = true;
    i.values["ユーザー"] = { id: "target" }; i.values["確認"] = false;
    await run(i);
    expect(m.admin).not.toHaveBeenCalled();
    i.values["確認"] = true;
    await run(i);
    expect(m.admin).toHaveBeenCalledWith(i.id, "guild", "target", "user", null);
  });
  it("accepts zero cost and does not change chance at the same time", async () => {
    const i = fixture("強化費用設定"); i.flags.admin = true;
    i.values["レベル"] = 5; i.values["金額"] = 0;
    await run(i);
    expect(m.configure).toHaveBeenCalledWith(i.id, "guild", "user", 5, { cost: 0 });
  });
  it("resets only the chosen field, with confirmation", async () => {
    const i = fixture("強化成功率リセット"); i.flags.admin = true; i.values["確認"] = true;
    await run(i);
    expect(m.reset).toHaveBeenCalledWith(i.id, "guild", "user", "successRate");
  });
  it("registers commands individually and force-verifies; never bulk-replaces or deletes commands", async () => {
    const definitions = new Map<string, unknown>();
    const manager = {
      fetch: vi.fn(async (arg: unknown) => typeof arg === "string"
        ? definitions.get(arg) : new Collection([["existing", { id: "existing", name: "武器", type: 1 }]])),
      edit: vi.fn(async (id: string, def: { name: string }) => { definitions.set(id, def); return { id }; }),
      create: vi.fn(async (def: { name: string }) => { definitions.set(def.name, def); return { id: def.name }; }),
      set: vi.fn(), delete: vi.fn(),
    };
    await syncForgeCommandRegistration({ application: { commands: manager } } as never);
    expect(manager.edit).toHaveBeenCalledTimes(1);
    expect(manager.create).toHaveBeenCalledTimes(10);
    expect(manager.fetch).toHaveBeenCalledWith("existing", { force: true });
    expect(manager.set).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });
});
