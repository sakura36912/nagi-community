import { and, eq } from "drizzle-orm";
import { db } from "./index";
import { shopForumPanelsTable, type ShopForumPanel } from "./schema/shopForumPanel";
import { shopItemsTable, type ShopItem } from "./schema/economy";

export type ShopForumPanelConfig = {
  name: string;
  price: number;
  description: string | null;
  effectType: string | null;
  targetRoleId: string | null;
};

export async function getShopForumPanel(
  guildId: string,
  channelId: string,
): Promise<ShopForumPanel | undefined> {
  const [panel] = await db
    .select()
    .from(shopForumPanelsTable)
    .where(
      and(
        eq(shopForumPanelsTable.guildId, guildId),
        eq(shopForumPanelsTable.channelId, channelId),
      ),
    );
  return panel;
}

/**
 * Creates or updates the product attached to a forum post.
 *
 * The forum post keeps the same shop item ID when it is reconfigured, so
 * existing purchase records remain valid and the panel can be edited in place.
 */
export async function upsertShopForumPanel(
  guildId: string,
  channelId: string,
  panelMessageId: string | null,
  config: ShopForumPanelConfig,
): Promise<{ panel: ShopForumPanel; item: ShopItem }> {
  return db.transaction(async (tx) => {
    const [existingPanel] = await tx
      .select()
      .from(shopForumPanelsTable)
      .where(
        and(
          eq(shopForumPanelsTable.guildId, guildId),
          eq(shopForumPanelsTable.channelId, channelId),
        ),
      );

    let item: ShopItem | undefined;
    if (existingPanel) {
      [item] = await tx
        .update(shopItemsTable)
        .set({
          name: config.name,
          price: config.price,
          description: config.description,
          effectType: config.effectType,
          targetRoleId: config.targetRoleId,
          category: "forum",
        })
        .where(
          and(
            eq(shopItemsTable.guildId, guildId),
            eq(shopItemsTable.id, existingPanel.shopItemId),
          ),
        )
        .returning();
    }

    if (!item) {
      [item] = await tx
        .insert(shopItemsTable)
        .values({
          guildId,
          name: config.name,
          price: config.price,
          description: config.description,
          effectType: config.effectType,
          targetRoleId: config.targetRoleId,
          category: "forum",
        })
        .returning();
    }

    if (!item) {
      throw new Error("Failed to create the forum shop item");
    }

    const [panel] = await tx
      .insert(shopForumPanelsTable)
      .values({
        guildId,
        channelId,
        shopItemId: item.id,
        panelMessageId,
      })
      .onConflictDoUpdate({
        target: [shopForumPanelsTable.guildId, shopForumPanelsTable.channelId],
        set: {
          shopItemId: item.id,
          panelMessageId,
        },
      })
      .returning();

    if (!panel) {
      throw new Error("Failed to save the forum shop panel");
    }

    return { panel, item };
  });
}

export async function setShopForumPanelMessage(
  guildId: string,
  channelId: string,
  panelMessageId: string,
): Promise<ShopForumPanel | undefined> {
  const [panel] = await db
    .update(shopForumPanelsTable)
    .set({ panelMessageId })
    .where(
      and(
        eq(shopForumPanelsTable.guildId, guildId),
        eq(shopForumPanelsTable.channelId, channelId),
      ),
    )
    .returning();
  return panel;
}