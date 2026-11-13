import { describe, expect, it } from "vitest";
import type { DealerCasinoGame } from "@workspace/db";
import { DEALER_CASINO_PREFIX, gameComponents } from "../commands/dealerCasino";

function game(state: string): DealerCasinoGame {
  return {
    id: 42,
    gameType: "chohan",
    state,
    result: null,
  } as unknown as DealerCasinoGame;
}

function customIds(state: string): string[] {
  return gameComponents(game(state)).flatMap(row =>
    row.toJSON().components.map(component => "custom_id" in component ? component.custom_id : ""),
  );
}

describe("丁半の進行ボタン", () => {
  it("受付中カードに参加ボタンと受付終了ボタンを出す", () => {
    const ids = customIds("RECRUITING");
    expect(ids).toContain(`${DEALER_CASINO_PREFIX}bet:42:cho`);
    expect(ids).toContain(`${DEALER_CASINO_PREFIX}bet:42:han`);
    expect(ids).toContain(`${DEALER_CASINO_PREFIX}dealer-close:42`);
    expect(ids).toHaveLength(5);
  });

  it("受付終了後カードに抽選・精算ボタンを出す", () => {
    const ids = customIds("CLOSED");
    expect(ids).toEqual([`${DEALER_CASINO_PREFIX}dealer-roll:42`]);
  });
});
