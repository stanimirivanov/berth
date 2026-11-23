import { expect, test } from "@playwright/test";
import { createOwnerSession } from "../src/owner-access/owner-session";

const firstToken = "h".repeat(40);
const secondToken = "i".repeat(40);
const history = "/api/history";
const inventory = "/api/inventory";
const historyDetail = `${history}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

/** Keep an independent snapshot and invalidate its request identity on session clear. */
function consumer(owner: ReturnType<typeof createOwnerSession>, path: string) {
  let snapshot: string | null = null;
  let version = 0;
  owner.onClear(() => {
    version++;
    snapshot = null;
  });

  return {
    snapshot: () => snapshot,
    /** Publish decoded data only while the request still owns this snapshot. */
    async refresh() {
      const request = ++version;
      const current = () => request === version;
      const outcome = await owner.read(
        path,
        (body) => {
          if (typeof body !== "string") {
            throw Error("invalid fixture response");
          }
          return body;
        },
        current,
      );
      if (current() && outcome.kind === "success") {
        snapshot = outcome.value;
      }
    },
  };
}

for (const status of [401, 403]) {
  test(`a superseded ${status} from one consumer clears both snapshots`, async () => {
    const responses = [
      Response.json("retained history"),
      Response.json("retained inventory"),
    ];
    const obsolete = Promise.withResolvers<Response>();
    const pending = Promise.withResolvers<Response>();
    const denials = [obsolete.promise, pending.promise];
    const sent: string[] = [];
    const owner = createOwnerSession(async (input, init) => {
      sent.push(String(input));
      expect(init).toMatchObject({
        method: "GET",
        headers: { authorization: `Bearer ${firstToken}` },
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
      return responses.shift() ?? (await denials.shift()) ?? Response.error();
    });
    const list = consumer(owner, history);
    const instances = consumer(owner, inventory);
    expect(owner.connect(firstToken)).toBe(true);
    expect(owner.status()).toBe("unverified");
    await list.refresh();
    await instances.refresh();
    expect(owner.status()).toBe("verified");
    expect(list.snapshot()).toBe("retained history");
    expect(instances.snapshot()).toBe("retained inventory");

    const deniedPath = status === 401 ? history : inventory;
    const requester = status === 401 ? list : instances;
    const denial = requester.refresh();
    const newer = requester.refresh();
    obsolete.resolve(Response.json({}, { status }));
    await denial;
    expect(owner.status()).toBe(status === 401 ? "unauthorized" : "forbidden");
    expect(list.snapshot()).toBeNull();
    expect(instances.snapshot()).toBeNull();
    pending.resolve(Response.json("late protected data"));
    await newer;
    expect(list.snapshot()).toBeNull();
    expect(instances.snapshot()).toBeNull();
    expect(sent).toEqual([history, inventory, deniedPath, deniedPath]);
  });
}

test("disconnect clears both consumers and ignores old success and denial after reconnect", async () => {
  const lateSuccess = Promise.withResolvers<Response>();
  const lateDenial = Promise.withResolvers<Response>();
  const responses = [
    Response.json("old history"),
    Response.json("old inventory"),
    lateSuccess.promise,
    lateDenial.promise,
    Response.json("new inventory"),
  ];
  const sent: string[] = [];
  const owner = createOwnerSession(async (input, init) => {
    sent.push(
      `${String(input)} ${new Headers(init?.headers).get("authorization")}`,
    );
    return (await responses.shift()) ?? Response.error();
  });
  const list = consumer(owner, history);
  const instances = consumer(owner, inventory);
  expect(owner.connect(firstToken)).toBe(true);
  await list.refresh();
  await instances.refresh();
  const oldHistory = list.refresh();
  const oldInventory = instances.refresh();
  owner.disconnect();
  expect(owner.status()).toBe("signed-out");
  expect(list.snapshot()).toBeNull();
  expect(instances.snapshot()).toBeNull();

  expect(owner.connect(secondToken)).toBe(true);
  await instances.refresh();
  lateSuccess.resolve(Response.json("stale protected data"));
  lateDenial.resolve(Response.json({}, { status: 403 }));
  await Promise.all([oldHistory, oldInventory]);
  expect(owner.status()).toBe("verified");
  expect(list.snapshot()).toBeNull();
  expect(instances.snapshot()).toBe("new inventory");
  expect(sent.at(-1)).toBe(`${inventory} Bearer ${secondToken}`);
  expect(Object.values(owner)).not.toContain(secondToken);
});

test("the tab credential is sent only to canonical protected reads", async () => {
  const urls: string[] = [];
  const owner = createOwnerSession(async (input) => {
    urls.push(String(input));
    return input === historyDetail
      ? Response.json({}, { status: 404 })
      : Response.json("retained history");
  });
  expect(owner.connect(firstToken)).toBe(true);
  for (const path of [
    "https://berth.invalid/api/history",
    "//elsewhere.invalid/api/inventory",
    "/api/history/../history",
    "/api/history#detail",
    "/api/other",
  ]) {
    expect(
      await owner.read(
        path,
        (body) => body,
        () => true,
      ),
    ).toEqual({
      kind: "unavailable",
    });
  }
  expect(owner.status()).toBe("unverified");
  expect(urls).toEqual([]);
  expect(
    await owner.read(
      historyDetail,
      (body) => body,
      () => true,
    ),
  ).toEqual({
    kind: "missing",
  });
  expect(owner.status()).toBe("unverified");
  expect(
    await owner.read(
      history,
      (body) => body,
      () => true,
    ),
  ).toEqual({
    kind: "success",
    value: "retained history",
  });
  expect(urls).toEqual([historyDetail, history]);
});

test("a failed reset does not leave the other consumer's snapshot visible", async () => {
  let deny = false;
  const owner = createOwnerSession(async () =>
    deny ? Response.json({}, { status: 401 }) : Response.json("inventory"),
  );
  owner.onClear(() => {
    throw Error("first consumer reset failed");
  });
  const instances = consumer(owner, inventory);
  expect(owner.connect(firstToken)).toBe(true);
  await instances.refresh();
  expect(instances.snapshot()).toBe("inventory");

  deny = true;
  await instances.refresh();
  expect(owner.status()).toBe("unauthorized");
  expect(instances.snapshot()).toBeNull();
});
