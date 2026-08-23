import { describe, expect, it } from "vitest";
import {
  consumeAdviceRoleGrantFromPurchase,
  markAdviceRoleGrantFromPurchase,
} from "../commands/advice.js";

describe("advice role grant purchase deduplication", () => {
  it("consumes a matching shop-grant marker only once", () => {
    markAdviceRoleGrantFromPurchase("guild-1", "user-1", "role-1");

    expect(consumeAdviceRoleGrantFromPurchase("guild-1", "user-1", "role-1")).toBe(true);
    expect(consumeAdviceRoleGrantFromPurchase("guild-1", "user-1", "role-1")).toBe(false);
  });

  it("does not suppress a role grant for a different member or role", () => {
    markAdviceRoleGrantFromPurchase("guild-1", "user-1", "role-1");

    expect(consumeAdviceRoleGrantFromPurchase("guild-1", "user-2", "role-1")).toBe(false);
    expect(consumeAdviceRoleGrantFromPurchase("guild-1", "user-1", "role-2")).toBe(false);
    expect(consumeAdviceRoleGrantFromPurchase("guild-1", "user-1", "role-1")).toBe(true);
  });
});