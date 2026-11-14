import assert from "node:assert/strict";
import test from "node:test";
import { readinessTransport } from "../src/providers/oci/readiness.js";

test("readiness sends exactly one bounded signed GET and rejects pagination or ambiguous target evidence", async () => {
  let calls = 0;
  const check = readinessTransport(
    "eu-frankfurt-1",
    "fixture",
    "ocid1.compartment.oc1..fixture",
    {
      signHttpRequest(request) {
        request.headers.set("authorization", "fixture-signature");
      },
    },
    async (url, init) => {
      calls++;
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "fixture-signature",
      );
      return Response.json(String(url).endsWith("/n/") ? "fixture" : []);
    },
  );
  assert.equal(await check("namespace"), true);
  assert.equal(await check("empty"), true);
  assert.equal(calls, 2);
  for (const response of [
    Response.json("wrong"),
    Response.json([], { headers: { "opc-next-page": "next" } }),
    Response.json([{}]),
    new Response("x".repeat(4097)),
  ]) {
    const bad = readinessTransport(
      "eu-frankfurt-1",
      "fixture",
      "ocid1.compartment.oc1..fixture",
      { signHttpRequest() {} },
      async () => response,
    );
    assert.notEqual(await bad("empty").catch(() => false), true);
  }
});

test("readiness refuses endpoint injection before signer or transport access", () => {
  assert.throws(
    () =>
      readinessTransport(
        "attacker.invalid/path",
        "fixture",
        "ocid1.compartment.oc1..fixture",
        {
          signHttpRequest() {
            throw Error("not called");
          },
        },
      ),
    /target/,
  );
});
