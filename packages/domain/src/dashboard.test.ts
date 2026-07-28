import { describe, expect, it } from "vitest";

import {
  createAvailableDashboardSection,
  orderDashboardAttentionItems,
  type DashboardAttentionItem,
} from "./dashboard.js";

describe("dashboard summary contracts", () => {
  it("orders blocking and security work before manual and informational activity", () => {
    const items: DashboardAttentionItem[] = [
      item("information", "Recent sync completed"),
      item("manual_action", "Upload source video"),
      item("blocking", "Reconnect Instagram account"),
      item("security", "Review account permission"),
      item("manual_action", "Retry analysis"),
    ];

    expect(orderDashboardAttentionItems(items).map(({ title }) => title)).toEqual([
      "Reconnect Instagram account",
      "Review account permission",
      "Upload source video",
      "Retry analysis",
      "Recent sync completed",
    ]);
  });

  it("preserves equal-priority source order and marks old sections stale", () => {
    const items = [
      item("manual_action", "First manual action"),
      item("manual_action", "Second manual action"),
    ];

    expect(orderDashboardAttentionItems(items).map(({ title }) => title)).toEqual([
      "First manual action",
      "Second manual action",
    ]);
    expect(
      createAvailableDashboardSection(
        { value: 1 },
        new Date("2026-07-28T00:00:00.000Z"),
        new Date("2026-07-28T01:00:00.001Z"),
      ),
    ).toMatchObject({ isStale: true, state: "available" });
  });
});

function item(priority: DashboardAttentionItem["priority"], title: string): DashboardAttentionItem {
  return {
    detail: `${title} detail`,
    id: title.toLowerCase().replaceAll(" ", "-"),
    priority,
    title,
  };
}
