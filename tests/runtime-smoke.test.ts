import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { inMemoryState } from "alchemy";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import {
  DefaultRequestSigner,
  type HttpRequest,
  Region,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import { ObjectStorageClient } from "oci-objectstorage";

test("requires the pinned Node 24 runtime", () => {
  assert.equal(process.versions.node, "24.22.3");
});

test("Alchemy's public state layer runs with the pinned Effect runtime", async () => {
  const program = Effect.gen(function* () {
    const state = yield* yield* State;
    const target = { stack: "berth-smoke", stage: "test" };
    assert.equal(yield* state.getOutput(target), undefined);
    yield* state.setOutput({ ...target, value: { marker: "offline-only" } });
    assert.deepEqual(yield* state.getOutput(target), {
      marker: "offline-only",
    });
    yield* state.deleteStack(target);
    assert.equal(yield* state.getOutput(target), undefined);
  });
  await Effect.runPromise(program.pipe(Effect.provide(inMemoryState())));
});

test("OCI loads and signs an Object Storage request without account credentials", async () => {
  // Ephemeral test identity only: no ambient OCI configuration or network calls.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const provider = new SimpleAuthenticationDetailsProvider(
    "test-tenancy",
    "test-user",
    "test-fingerprint",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    null,
    Region.EU_FRANKFURT_1,
  );
  const client = new ObjectStorageClient({
    authenticationDetailsProvider: provider,
  });
  try {
    // Set an explicit endpoint: region-derived SDK endpoints are templates
    // resolved by the transport, which this offline test deliberately never calls.
    client.endpoint = "https://objectstorage.eu-frankfurt-1.oraclecloud.com";
    const request: HttpRequest = {
      method: "GET",
      uri: `${client.endpoint}/n/berth-test-namespace`,
      headers: new Headers({ date: "Thu, 12 Nov 2026 12:00:00 GMT" }),
    };
    await new DefaultRequestSigner(provider).signHttpRequest(request);
    const authorization = request.headers.get("authorization");
    assert.ok(authorization);
    const signature = /signature="([^"]+)"/.exec(authorization)?.[1];
    assert.ok(signature);
    const signedHeaders = /headers="([^"]+)"/.exec(authorization)?.[1];
    assert.ok(signedHeaders);
    const signingString = signedHeaders
      .split(" ")
      .map((name) =>
        name === "(request-target)"
          ? "(request-target): get /n/berth-test-namespace"
          : `${name}: ${request.headers.get(name)}`,
      )
      .join("\n");
    assert.equal(
      verify(
        "RSA-SHA256",
        Buffer.from(signingString),
        publicKey,
        Buffer.from(signature, "base64"),
      ),
      true,
    );
  } finally {
    client.close();
  }
});
