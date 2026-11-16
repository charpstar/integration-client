import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Order } from "../src/platform.ts";
import { setup } from "./helpers.ts";
import { MockPlatform } from "./mockPlatform.ts";

const ORDER_ID = "4d3c2b1a-0000-4000-8000-000000000011";
let mock: MockPlatform;
let order: Order;
beforeEach(async () => {
  mock = await new MockPlatform().start();
  order = mock.fixture<Order>("orders/order.json");
  mock.orders.push(order);
});
afterEach(() => mock.stop());

describe("orders: GET /api/v1/orders and /api/v1/orders/{orderId}", () => {
  it("lists orders without their items and follows nextCursor until it is null", async () => {
    const { platform } = setup(mock);
    mock.orders.push({ ...order, id: "4d3c2b1a-0000-4000-8000-000000000012", status: "delivered" }, { ...order, id: "4d3c2b1a-0000-4000-8000-000000000013" });
    mock.pageSize = 2;
    const orders = await platform.listOrders();
    expect(orders.map((o) => o.id)).toEqual([ORDER_ID, "4d3c2b1a-0000-4000-8000-000000000012", "4d3c2b1a-0000-4000-8000-000000000013"]);
    expect(orders[0]).toEqual({ id: ORDER_ID, status: "in_production", source: "api", createdAt: "2026-10-20T09:31:00.000Z", counts: order.counts });
    const calls = mock.calls("GET", "/api/v1/orders");
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe("/api/v1/orders");
    expect(calls[1].path).toMatch(/^\/api\/v1\/orders\?cursor=[A-Za-z0-9_-]+$/);
  });

  it("filters by status, keeping the filter on every page", async () => {
    const { platform } = setup(mock);
    mock.orders.push({ ...order, id: "o2", status: "delivered" }, { ...order, id: "o3", status: "delivered" });
    mock.pageSize = 1;
    expect((await platform.listOrders("delivered")).map((o) => o.id)).toEqual(["o2", "o3"]);
    expect(mock.calls("GET", "/api/v1/orders").map((c) => c.path.replace(/cursor=.*/, "cursor="))).toEqual(["/api/v1/orders?status=delivered", "/api/v1/orders?status=delivered&cursor="]);
  });

  it("reads one order with the status of each item; an unknown order is null", async () => {
    const { platform } = setup(mock);
    const one = await platform.getOrder(ORDER_ID);
    expect(one?.items).toEqual([
      { articleId: "CH-1001", status: "in_production", deliveryDate: "2026-11-20", pendingChanges: null },
      { articleId: "CH-1002", status: "delivered", deliveryDate: "2026-11-01", pendingChanges: null },
    ]);
    expect(await platform.getOrder("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("the orders command logs each order with its status and item counts", async () => {
    const { client, logs } = setup(mock);
    await client.listOrders();
    expect(logs.filter((l) => l.msg === "orders.order").map((l) => l.fields)).toEqual([
      { order: ORDER_ID, status: "in_production", source: "api", createdAt: "2026-10-20T09:31:00.000Z", items: 6, counts: { received: 0, in_production: 3, in_review: 1, approved: 0, delivered: 2, cancelled: 0 } },
    ]);
    expect(logs.at(-1)).toMatchObject({ msg: "orders.done", fields: { orders: 1 } });
  });

  it("the orders command with an id logs the order, then every item with its status", async () => {
    const { client, logs } = setup(mock);
    expect((await client.showOrder(ORDER_ID))?.id).toBe(ORDER_ID);
    expect(logs.find((l) => l.msg === "order.status")?.fields).toMatchObject({ order: ORDER_ID, status: "in_production", items: 6 });
    expect(logs.filter((l) => l.msg === "order.item").map((l) => [l.fields?.article, l.fields?.status, l.fields?.deliveryDate])).toEqual([
      ["CH-1001", "in_production", "2026-11-20"],
      ["CH-1002", "delivered", "2026-11-01"],
    ]);
  });

  it("the orders command with an unknown id says so", async () => {
    const { client, logs } = setup(mock);
    expect(await client.showOrder("nope")).toBeNull();
    expect(logs.at(-1)).toMatchObject({ level: "error", msg: "order.not_found", fields: { order: "nope" } });
  });
});
