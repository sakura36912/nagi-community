import { describe, expect, it } from "vitest";
import type { ZombieGame, ZombieJob } from "@workspace/db";
import { zombieAuditEmbed } from "../lib/zombieAudit.js";

function game(type: "heal" | "infect" = "heal", misheal = false) {
  return {
    id: "event", players: { actor: { name: "実行者", id: "actor" }, target: { name: "対象者", id: "target" } },
    requests: { request: { id: "request", actor: "actor", target: "target", channel: "vc",
      type, misheal, status: "accepted", seconds: 1263, decidedBy: "system" } },
  } as unknown as ZombieGame;
}
function render(g: ZombieGame, kind = "decision", text = "") {
  return zombieAuditEmbed(g, `event:${kind}:request`, { kind: "audit", text } as ZombieJob, () => "大酒場").toJSON();
}

describe("zombie private audit cards", () => {
  it("shows a cure with names, IDs, VC and minutes rather than raw status strings", () => {
    const card = render(game());
    expect(card.title).toBe("治療：成立");
    expect(card.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "実行者", value: "実行者\nID：actor" }),
      expect.objectContaining({ name: "対象者", value: "対象者\nID：target" }),
      expect.objectContaining({ name: "同席VC", value: "大酒場\nID：vc" }),
      expect.objectContaining({ name: "連続同席時間", value: "21分3秒" }),
    ]));
    expect(JSON.stringify(card)).toContain("60秒の治療クールタイム");
    expect(card.footer?.text).toContain("操作ID：request");
  });
  it("uses a different title and colour for infection", () => {
    expect(render(game("infect")).title).toBe("感染：成立");
    expect(render(game("infect")).color).not.toBe(render(game()).color);
  });
  it("clearly distinguishes mishealing from a successful cure", () => {
    const card = render(game("heal", true));
    expect(card.title).toBe("誤治療：成立");
    expect(JSON.stringify(card)).toContain("感染状態は変わりません");
    expect(JSON.stringify(card)).not.toContain("対象者を人間に戻しました");
  });
  it.each(["rejected", "stale"] as const)("does not display %s requests as successful", status => {
    const g = game();
    g.requests.request!.status = status;
    g.requests.request!.decidedBy = "admin";
    const card = render(g);
    expect(card.title).not.toBe("治療：成立");
    expect(JSON.stringify(card)).toContain("感染・治療は成立していません");
    expect(JSON.stringify(card)).toContain("管理者ID：admin");
  });
  it("distinguishes timed expiry and event-end release", () => {
    expect(render(game(), "misheal-expired").description).toContain("60秒");
    expect(render(game(), "misheal-expired", "イベント終了によりVC移動制限を解除").description).toContain("イベント終了");
  });
  it("shows actionable movement failure details", () => {
    const card = render(game(), "move-failed");
    expect(card.title).toBe("VC引き戻し：失敗");
    expect(card.description).toContain("再試行");
  });
  it("keeps a VC ID visible even when its name cannot be resolved", () => {
    const card = zombieAuditEmbed(game(), "event:decision:request", { kind: "audit" } as ZombieJob).toJSON();
    expect(card.fields?.find(f => f.name === "同席VC")?.value).toContain("ID：vc");
    expect(JSON.stringify(card)).not.toContain("<#vc>");
  });
  it("falls back safely for older or unknown logs, with Discord size limits", () => {
    const card = zombieAuditEmbed(game(), "event:unknown", { kind: "audit", text: "*".repeat(10000) } as ZombieJob).toJSON();
    expect(card.description!.length).toBeLessThanOrEqual(4096);
    expect(card.title).toBe("イベント管理ログ");
  });
});
