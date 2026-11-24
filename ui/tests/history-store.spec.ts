import "@angular/compiler";
import { Injector } from "@angular/core";
import { expect, test } from "@playwright/test";
import {
  HISTORY_READER,
  type HistoryReader,
} from "../src/operation-history/history-reader";
import { HistoryStore } from "../src/operation-history/history-store";
import {
  createOwnerSession,
  OWNER_SESSION,
} from "../src/owner-access/owner-session";
import { first, item, second } from "./history-fixture";

/** Create the feature store with a replaceable reader and a real owner session. */
function historyStore(reader: HistoryReader) {
  const owner = createOwnerSession(async () => Response.error());
  owner.connect("h".repeat(40));
  const injector = Injector.create({
    providers: [
      HistoryStore,
      { provide: OWNER_SESSION, useValue: owner },
      { provide: HISTORY_READER, useValue: reader },
    ],
  });
  return { injector, owner, store: injector.get(HistoryStore) };
}

test("history store dispatches one read at a time and prioritizes the latest detail", async () => {
  const pending = Promise.withResolvers<void>();
  const replacement = Promise.withResolvers<void>();
  const latest = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const calls: string[] = [];
  const { injector, store } = historyStore({
    async list() {
      calls.push("list");
      return { kind: "success", value: { items: [item(first)], next: null } };
    },
    async detail(operation) {
      calls.push(operation);
      if (operation === first) {
        await pending.promise;
      }
      if (operation === latest) {
        await replacement.promise;
      }
      return { kind: "success", value: item(operation) };
    },
  });

  try {
    store.open(first);
    store.select(second);
    store.select(latest);
    expect(calls).toEqual([first]);
    expect(store.detail()).toBeNull();
    pending.resolve();
    await expect.poll(() => calls).toEqual([first, latest]);
    expect(store.detail()).toBeNull();
    replacement.resolve();
    await expect.poll(() => store.list()?.items).toEqual([item(first)]);
    expect(calls).toEqual([first, latest, "list"]);
    expect(store.detail()?.record).toEqual(item(latest));
  } finally {
    injector.destroy();
  }
});

test("history store retains a stale page, retries its cursor and clears late data on disconnect", async () => {
  const late = Promise.withResolvers<void>();
  const reconnected = Promise.withResolvers<void>();
  const cursors: (string | null)[] = [];
  const { injector, owner, store } = historyStore({
    async list(before) {
      cursors.push(before);
      switch (cursors.length) {
        case 1:
          return {
            kind: "success",
            value: { items: [item(first)], next: second },
          };
        case 2:
          return { kind: "unavailable" };
        case 4:
          await late.promise;
          break;
        case 5:
          await reconnected.promise;
          return {
            kind: "success",
            value: { items: [item(first)], next: null },
          };
      }
      return { kind: "success", value: { items: [item(second)], next: null } };
    },
    async detail() {
      return { kind: "missing" };
    },
  });

  try {
    store.open(null);
    await expect.poll(() => store.listLoading()).toBe(false);
    const original = store.list();
    expect(original?.items).toEqual([item(first)]);
    expect(typeof original?.fetchedAt).toBe("string");

    store.older();
    await expect.poll(() => store.listFailure()).toEqual({ before: second });
    expect(store.list()).toEqual(original);

    store.retryList();
    await expect.poll(() => store.list()?.before).toBe(second);
    expect(store.list()?.items).toEqual([item(second)]);

    store.refreshList();
    expect(cursors).toEqual([null, second, second, second]);
    owner.disconnect();
    expect(store.list()).toBeNull();
    expect(store.listLoading()).toBe(false);
    owner.connect("i".repeat(40));
    store.open(null);
    late.resolve();
    await expect
      .poll(() => cursors)
      .toEqual([null, second, second, second, null]);
    expect(store.list()).toBeNull();
    reconnected.resolve();
    await expect.poll(() => store.list()?.items).toEqual([item(first)]);
  } finally {
    injector.destroy();
  }
});
