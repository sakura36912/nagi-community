import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
const m = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), settle: vi.fn() }));
vi.mock("@workspace/db", async importOriginal => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return { ...actual, createPetTreatment: m.create, getPetTreatment: m.get, settlePetTreatment: m.settle };
});
import { requirePetVet, proposePetTreatment, handlePetTreatment } from "../lib/petClinic";

function guild(vet = true, duplicate = false) {
  const roles = new Collection([["vet-role", { id: "vet-role", name: "獣医" }]]);
  if (duplicate) roles.set("other-vet-role", { id: "other-vet-role", name: "獣医" });
  const member = { roles: { cache: new Collection(vet ? [["vet-role", {}]] : []) }, permissions: { has: () => true } };
  return { id: "guild", roles: { fetch: vi.fn(async () => roles) },
    members: { fetch: vi.fn(async () => member), fetchMe: vi.fn(async () => ({})) } };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.create.mockResolvedValue({ id: "request", price: 300, hunger: 20 });
  m.get.mockResolvedValue({ id: "request", ownerId: "owner", vetId: "vet" });
  m.settle.mockResolvedValue("治療しました");
});
describe("veterinary role and owner consent", () => {
  it("permits a vet based on a freshly fetched role", async () => {
    const g = guild();
    await requirePetVet(g as never, "vet");
    expect(g.members.fetch).toHaveBeenCalledWith({ user: "vet", force: true });
    expect(g.roles.fetch).toHaveBeenCalledOnce();
  });
  it("does not let Administrator alone replace the veterinary role", async () => {
    await expect(requirePetVet(guild(false) as never, "admin")).rejects.toThrow("獣医");
  });
  it("fails closed for duplicate or unavailable veterinary roles", async () => {
    await expect(requirePetVet(guild(true, true) as never, "vet")).rejects.toThrow("1つ");
    const g = guild();
    g.roles.fetch.mockRejectedValue(new Error("fetch failed"));
    await expect(requirePetVet(g as never, "vet")).rejects.toThrow();
  });
  it("creates a public owner-approval card without charging", async () => {
    const g = guild();
    const i = { id: "request", guild: g, user: { id: "vet" }, options: { getUser: () => ({ id: "owner", bot: false }) },
      channel: { send: vi.fn(), permissionsFor: () => ({ has: () => true }), isThread: () => false }, editReply: vi.fn() };
    await proposePetTreatment(i as never);
    expect(m.create).toHaveBeenCalledWith("request", "guild", "owner", "vet");
    expect(m.settle).not.toHaveBeenCalled();
    const card = i.channel.send.mock.calls[0]![0];
    expect(card.content).toBe("<@owner>");
    expect(card.components[0].components[0].data.custom_id).toBe("pet:treat:request");
    expect(card.embeds[0].data.description).toContain("$300");
  });
  it("stops an unqualified initiator before creating any request", async () => {
    const i = { guild: guild(false), user: { id: "admin" } };
    await expect(proposePetTreatment(i as never)).rejects.toThrow("獣医");
    expect(m.create).not.toHaveBeenCalled();
  });
  it("rechecks the named vet's role at owner payment approval", async () => {
    const i = { guild: guild(), user: { id: "owner" }, customId: "pet:treat:request",
      editReply: vi.fn(), message: { edit: vi.fn() } };
    await handlePetTreatment(i as never);
    expect(m.get).toHaveBeenCalledWith("request", "guild", "owner");
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "vet", force: true });
    expect(m.settle).toHaveBeenCalledWith("request", "guild", "owner", false);
    expect(i.message.edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });
  it("keeps a successful treatment result when confirmation-card cleanup fails", async () => {
    const i = { guild: guild(), user: { id: "owner" }, customId: "pet:treat:request",
      editReply: vi.fn(), message: { edit: vi.fn().mockRejectedValue(new Error("cleanup failed")) } };
    await expect(handlePetTreatment(i as never)).resolves.toBeUndefined();
    expect(m.settle).toHaveBeenCalledWith("request", "guild", "owner", false);
    expect(i.editReply).toHaveBeenCalledWith({ content: "治療しました", allowedMentions: { parse: [] } });
  });
  it("refuses payment after the vet's role is revoked", async () => {
    const i = { guild: guild(false), user: { id: "owner" }, customId: "pet:treat:request" };
    await expect(handlePetTreatment(i as never)).rejects.toThrow("獣医");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("refuses non-owner approval before checking the vet or charging", async () => {
    m.get.mockRejectedValue(new Error("owner mismatch"));
    const i = { guild: guild(), user: { id: "outsider" }, customId: "pet:treat:request" };
    await expect(handlePetTreatment(i as never)).rejects.toThrow("owner mismatch");
    expect(i.guild.members.fetch).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("allows the owner to cancel even if the vet has lost their role", async () => {
    const i = { guild: guild(false), user: { id: "owner" }, customId: "pet:canceltreat:request",
      editReply: vi.fn(), message: { edit: vi.fn() } };
    await handlePetTreatment(i as never);
    expect(i.guild.members.fetch).not.toHaveBeenCalled();
    expect(m.settle).toHaveBeenCalledWith("request", "guild", "owner", true);
  });
});
