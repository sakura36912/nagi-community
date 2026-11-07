import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Routes } from "discord.js";
import { removeRetiredBankCommands, RETIRED_BANK_COMMAND_NAMES } from "../lib/retiredBankCommands";

function fixture() {
  const routes = [Routes.applicationCommands("bank"), Routes.applicationGuildCommands("bank", "guild")];
  const definitions = new Map<string, { id: string; name: string; type: number }[]>(routes.map(route => [route, [
    ...RETIRED_BANK_COMMAND_NAMES.map(name => ({ id: name, name, type: 1 })),
    { id: "give-slash", name: "give", type: 1 },
    { id: "shop", name: "shop", type: 1 }, { id: "casino", name: "casino", type: 1 },
    { id: "context", name: "give", type: 2 }, { id: "similar", name: "giveaway", type: 1 },
  ]]));
  const rest = {
    get: vi.fn(async (route: string): Promise<unknown> => {
      if (route === Routes.oauth2CurrentApplication()) return { id: "bank" };
      if (!definitions.has(route)) throw new Error("unexpected scope");
      return definitions.get(route)!.map(c => ({ ...c }));
    }),
    delete: vi.fn(async (route: string) => {
      const parent = route.slice(0, route.lastIndexOf("/")) as typeof routes[number];
      const id = route.slice(route.lastIndexOf("/") + 1);
      definitions.set(parent, definitions.get(parent)!.filter(c => c.id !== id));
    }),
  };
  return { routes, definitions, rest };
}
describe("explicitly retired bank slash commands", () => {
  it("removes the three retired names but preserves the restored give in both scopes", async () => {
    const s = fixture();
    const result = await removeRetiredBankCommands(s.rest, "bank", ["guild", "guild"]);
    expect(result.removed).toHaveLength(6);
    expect(result.failed).toEqual([]);
    expect(s.rest.delete).toHaveBeenCalledTimes(6);
    for (const route of s.routes) {
      expect(s.rest.get.mock.calls.filter(([path]) => path === route)).toHaveLength(2);
      expect(s.definitions.get(route)!.map(c => c.id)).toEqual(["give-slash", "shop", "casino", "context", "similar"]);
    }
  });
  it("is idempotent and does not delete other scopes or applications", async () => {
    const s = fixture();
    await removeRetiredBankCommands(s.rest, "bank", ["guild"]);
    s.rest.delete.mockClear();
    expect(await removeRetiredBankCommands(s.rest, "bank", ["guild"])).toEqual({ removed: [], failed: [] });
    expect(s.rest.delete).not.toHaveBeenCalled();
    expect(s.rest.get.mock.calls.every(([p]) => p === Routes.oauth2CurrentApplication() || s.routes.includes(p as never))).toBe(true);
  });
  it("refuses an unexpected application before deleting anything", async () => {
    const s = fixture();
    await expect(removeRetiredBankCommands(s.rest, "community", ["guild"])).rejects.toThrow("identity mismatch");
    expect(s.rest.delete).not.toHaveBeenCalled();
  });
  it("reports failures but still cleans the remaining scopes", async () => {
    const s = fixture();
    const original = s.rest.delete.getMockImplementation()!;
    s.rest.delete.mockImplementation(async route => {
      if (route.startsWith(`${s.routes[0]}/`)) throw new Error("permission denied");
      return original(route);
    });
    const result = await removeRetiredBankCommands(s.rest, "bank", ["guild"]);
    expect(result.failed).toEqual(["global"]);
    expect(result.removed).toHaveLength(3);
    expect(s.definitions.get(s.routes[1]!)!.map(c => c.id)).toEqual(["give-slash", "shop", "casino", "context", "similar"]);
  });
  it("does not report success when verification still finds a retired name", async () => {
    const s = fixture();
    s.rest.delete.mockImplementation(async () => undefined);
    expect((await removeRetiredBankCommands(s.rest, "bank", [])).failed).toEqual(["global"]);
  });
  it("excludes retired commands but includes give in the shared registration and dispatch list", () => {
    const source = readFileSync(new URL("../commands/index.ts", import.meta.url), "utf8");
    const list = source.split("export const commands: Command[] = [")[1]!.split("];")[0]!;
    for (const name of RETIRED_BANK_COMMAND_NAMES) {
      expect(list).not.toMatch(new RegExp(`\\b${name}Command\\b`));
    }
    for (const name of ["give", "shop", "casino", "returnlog"]) expect(list).toContain(`${name}Command`);
  });
  it("wires cleanup into startup and manual deployment without full-scope replacement", () => {
    const startup = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const deploy = readFileSync(new URL("../deploy-commands.ts", import.meta.url), "utf8");
    expect(startup).toContain("startRetiredBankCommandCleanup(readyClient)");
    expect(deploy).toContain("await removeRetiredBankCommands(");
    expect(deploy).not.toMatch(/rest\.put\(/);
  });
});
