import assert from "node:assert/strict";
import { Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { inventoryReader } from "../src/application/retained-trial-ledger/inventory.ts";
import { retainedRetrySession } from "../src/application/retained-trial-ledger/retry.ts";
import {
  type Authentication,
  fixtureHost,
  fixtureIdentity,
  fixturePassword,
  postgresAuthenticationFixture,
} from "./fakes/postgres-channel-binding.ts";

const adapters = {
  Inventory: (url: string) =>
    inventoryReader({ BERTH_INVENTORY_DATABASE_URL: url }).page(),
  Retry: (url: string) =>
    retainedRetrySession({ BERTH_RETRY_DATABASE_URL: url })(async () =>
      assert.fail("Retry work must wait for the role check"),
    ),
};

const identity = fixtureIdentity();
const originalConnect = Socket.prototype.connect;

/** Route the hosted hostname to loopback while pg still verifies that hostname in TLS. */
async function runAdapter(
  t: TestContext,
  adapter: keyof typeof adapters,
  mode: Authentication,
  required: boolean,
  trusted = true,
) {
  const fixture = await postgresAuthenticationFixture(identity, mode);
  const authorities = getCACertificates("default");
  setDefaultCACertificates(trusted ? [identity.cert] : []);
  t.mock.method(
    Socket.prototype,
    "connect",
    function (this: Socket, ...args: unknown[]) {
      return Reflect.apply(
        originalConnect,
        this,
        args[0] === 5432 && args[1] === fixtureHost
          ? [fixture.port, "127.0.0.1"]
          : args,
      );
    },
  );

  const url = new URL(
    `postgresql://berth_${adapter.toLowerCase()}_runtime:${fixturePassword}@${fixtureHost}/neondb?sslmode=verify-full`,
  );
  if (required) url.searchParams.set("channel_binding", "require");

  const request = adapters[adapter](url.href).finally(async () => {
    setDefaultCACertificates(authorities);
    await fixture.close();
  });
  return { fixture, request };
}

for (const adapter of ["Inventory", "Retry"] as const) {
  for (const mode of ["plain-scram", "trust", "cleartext", "md5"] as const) {
    test(`${adapter} rejects ${mode} when channel binding is required before sending credentials or SQL`, async (t) => {
      const { fixture, request } = await runAdapter(t, adapter, mode, true);

      await assert.rejects(request, /requires SCRAM-SHA-256-PLUS/);
      assert.equal(fixture.replies, 0);
      assert.deepEqual(fixture.sql, []);
    });
  }

  for (const [mode, error] of [
    ["incomplete-plus", /requires SCRAM-SHA-256-PLUS/],
    ["invalid-plus", /server signature does not match/],
  ] as const) {
    test(`${adapter} rejects ${mode} before sending SQL`, async (t) => {
      const { fixture, request } = await runAdapter(t, adapter, mode, true);

      await assert.rejects(request, error);
      assert.deepEqual(fixture.mechanisms, ["SCRAM-SHA-256-PLUS"]);
      assert.deepEqual(fixture.sql, []);
    });
  }

  for (const [mode, required, mechanism] of [
    ["scram-plus", true, "SCRAM-SHA-256-PLUS"],
    ["scram-plus", false, "SCRAM-SHA-256-PLUS"],
    ["plain-scram", false, "SCRAM-SHA-256"],
  ] as const) {
    const binding = required ? "required" : "omitted";
    test(`${adapter} reaches its SQL boundary after ${mechanism} with channel binding ${binding}`, async (t) => {
      const { fixture, request } = await runAdapter(t, adapter, mode, required);

      await assert.rejects(request, /fixture stopped the first SQL statement/);
      assert.deepEqual(fixture.mechanisms, [mechanism]);
      assert.deepEqual(
        fixture.sql.map((sql) => sql.split("\n")[0]),
        [adapter === "Inventory" ? "BEGIN READ ONLY" : "SELECT"],
      );
    });
  }

  test(`${adapter} still rejects an untrusted server certificate with channel binding required`, async (t) => {
    const { fixture, request } = await runAdapter(
      t,
      adapter,
      "scram-plus",
      true,
      false,
    );

    await assert.rejects(request, { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    assert.equal(fixture.replies, 0);
    assert.deepEqual(fixture.sql, []);
  });
}
