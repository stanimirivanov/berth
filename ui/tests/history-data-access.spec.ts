import { expect, test } from "@playwright/test";
import { createHistoryReader } from "../src/operation-history/history-data-access";
import { createOwnerSession } from "../src/owner-access/owner-session";
import { first, item, second } from "./history-fixture";

test("history reader requests the same-origin page and selected operation", async () => {
  const calls: string[] = [];
  const owner = createOwnerSession(async (input) => {
    const path = String(input);
    calls.push(path);
    return Response.json(
      path.startsWith("/api/history?")
        ? { items: [item(first)], next: second }
        : item(second),
    );
  });
  owner.connect("h".repeat(40));
  const reader = createHistoryReader(owner);
  await expect(reader.list(first, () => true)).resolves.toEqual({
    kind: "success",
    value: { items: [item(first)], next: second },
  });
  await expect(reader.detail(second, () => true)).resolves.toEqual({
    kind: "success",
    value: item(second),
  });
  expect(calls).toEqual([
    `/api/history?before=${first}`,
    `/api/history/${second}`,
  ]);
  expect(owner.status()).toBe("verified");
});

test("history reader rejects invalid replies and preserves session outcomes", async () => {
  const obsolete = Promise.withResolvers<Response>();
  const replies = [
    Response.json({ items: [], next: "bad-cursor" }),
    Response.json(item(second)),
    new Response(null, { status: 404 }),
    obsolete.promise,
    new Response(null, { status: 403 }),
  ];
  const owner = createOwnerSession(
    async () => (await replies.shift()) ?? Response.error(),
  );
  owner.connect("h".repeat(40));
  const reader = createHistoryReader(owner);
  await expect(reader.list(null, () => true)).resolves.toEqual({
    kind: "unavailable",
  });
  await expect(reader.detail(first, () => true)).resolves.toEqual({
    kind: "unavailable",
  });
  expect(owner.status()).toBe("unverified");
  await expect(reader.detail(first, () => true)).resolves.toEqual({
    kind: "missing",
  });
  let current = true;
  const reading = reader.detail(first, () => current);
  current = false;
  obsolete.resolve(Response.json(item(first)));
  await expect(reading).resolves.toEqual({ kind: "discarded" });
  expect(owner.status()).toBe("unverified");
  await expect(reader.list(null, () => true)).resolves.toEqual({
    kind: "discarded",
  });
  expect(owner.status()).toBe("forbidden");
});
