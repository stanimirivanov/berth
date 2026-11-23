import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  verify,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import {
  DefaultRequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import { liveFunction } from "../neon.ts";
import {
  BucketFailure,
  boundedObjectSdk,
  objectClient,
} from "../src/providers/oci/client.ts";
import type { ProbeReceipt } from "../src/providers/oci/trial-object.ts";
import { probeContent } from "../src/providers/oci/trial-object.ts";
import { dispatcher, intent } from "./fakes/oci.ts";
import { OciWire } from "./fakes/oci-wire.ts";

/** Verify signatures independently, including byte hashes whenever the SDK signs body headers. */
function verifyRequest(key: KeyObject, uri: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  const authorization = headers.get("authorization") ?? "";
  const names = /headers="([^"]+)"/.exec(authorization)?.[1]?.split(" ") ?? [];
  assert.ok(
    ["(request-target)", "host", "x-date"].every((name) =>
      names.includes(name),
    ),
  );
  const url = new URL(uri);
  const signed = names
    .map(
      (name) =>
        `${name.toLowerCase()}: ${name === "(request-target)" ? `${init.method?.toLowerCase()} ${url.pathname}${url.search}` : headers.get(name)}`,
    )
    .join("\n");
  const signature = /signature="([^"]+)"/.exec(authorization)?.[1] ?? "";
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(signed),
      key,
      Buffer.from(signature, "base64"),
    ),
    true,
  );
  if (names.includes("x-content-sha256")) {
    assert.ok(typeof init.body === "string" || init.body instanceof Uint8Array);
    assert.equal(
      headers.get("x-content-sha256"),
      createHash("sha256").update(init.body).digest("base64"),
    );
  }
}

test("production signed SDK sends the fixed one-MiB PUT once through the HTTP boundary", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = new DefaultRequestSigner(
    new SimpleAuthenticationDetailsProvider(
      "ocid1.tenancy.oc1..fixture",
      "ocid1.user.oc1..fixture",
      "11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11",
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      null,
    ),
  );
  let sends = 0;
  const body = probeContent();
  const sdk = boundedObjectSdk(
    signer,
    new AbortController().signal,
    async (url, init) => {
      sends++;
      assert.equal(init?.method, "PUT");
      assert.ok(init?.body instanceof Uint8Array);
      assert.deepEqual(init.body, body);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("content-length"), "1048576");
      verifyRequest(keys.publicKey, String(url), init);
      return new Response(null, {
        status: 200,
        headers: { etag: "object-rev-1" },
      });
    },
    5000,
    { creationDeadline: Date.now() + 60000 },
  );
  sdk.endpoint = "https://objectstorage.eu-frankfurt-1.oraclecloud.com";
  try {
    const result = await sdk.putObject({
      namespaceName: "fixture",
      bucketName: "berth-fixture",
      objectName: "trial.bin",
      putObjectBody: body,
      contentLength: body.length,
      ifNoneMatch: "*",
    });
    assert.equal(result.eTag, "object-rev-1");
    assert.equal(sends, 1);
  } finally {
    sdk.close();
  }
});

test("official Neon bundle signs uploads and verifies one-MiB lifecycle across fresh SDK instances without network", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "berth-signed-bundle-"));
  const sdkClients: { close(): void }[] = [];
  try {
    const zip = await buildFunctionBundle({
      ...liveFunction,
      source: "./tests/fakes/oci-signed-bundle.ts",
    });
    const require = createRequire(
      import.meta.resolve("@neon/config-runtime/v1"),
    );
    const archive = require("fflate") as {
      unzipSync(data: Uint8Array): Record<string, Uint8Array>;
    };
    const entries = archive.unzipSync(zip);
    assert.ok(entries["index.mjs"]);
    const entry = join(directory, "index.mjs");
    await writeFile(entry, entries["index.mjs"]);
    const bundled: typeof import("./fakes/oci-signed-bundle.ts") = await import(
      pathToFileURL(entry).href
    );
    assert.equal(typeof bundled.default.fetch, "function");
    const wire = new OciWire(),
      budget = dispatcher();
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fingerprint =
      createHash("md5")
        .update(keys.publicKey.export({ type: "spki", format: "der" }))
        .digest("hex")
        .match(/../g)
        ?.join(":") ?? "";
    const signer = new bundled.DefaultRequestSigner(
      new bundled.SimpleAuthenticationDetailsProvider(
        "ocid1.tenancy.oc1..fixture",
        "ocid1.user.oc1..fixture",
        fingerprint,
        keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        null,
      ),
    );
    const createSdk = () => {
      const sdk = bundled.boundedObjectSdk(
        signer,
        new AbortController().signal,
        async (url, init) => {
          assert.equal(budget.calls.length, wire.requests.length + 1);
          assert.ok(init?.method);
          const headers = new Headers(init.headers);
          assert.match(
            headers.get("authorization") ?? "",
            /^Signature version="1"/,
          );
          verifyRequest(keys.publicKey, String(url), init);
          return wire.send({
            method: init.method as "GET" | "POST" | "PUT" | "DELETE" | "HEAD",
            uri: String(url),
            headers,
            ...(init.body === undefined ? {} : { body: init.body }),
          });
        },
        5000,
        { creationDeadline: Date.now() + 60000 },
      );
      sdkClients.push(sdk);
      return sdk;
    };
    const client = bundled.objectClient(createSdk(), budget, intent.region);
    const bucket = await bundled.makeBucket(intent, client.bucket).create();
    const saved = bundled.probeIntent(intent);
    let persisted = false,
      receipt: ProbeReceipt | undefined;
    const journal = {
      async saveIntent(value: typeof saved) {
        assert.deepEqual(value, saved);
        persisted = true;
      },
      async saveReceipt(value: ProbeReceipt) {
        receipt = value;
      },
    };
    wire.beforePut = () => assert.equal(persisted, true);
    const probe = bundled.makeTrialObject(
      { intent: saved, bucket },
      client,
      journal,
    );
    const uploaded = await probe.upload();
    assert.deepEqual(receipt, uploaded);
    assert.equal(
      uploaded.digest,
      "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83",
    );
    const restoredClient = bundled.objectClient(
      createSdk(),
      budget,
      intent.region,
    );
    const resumed = bundled.makeTrialObject(
      structuredClone({ intent: saved, bucket, receipt: uploaded }),
      restoredClient,
      journal,
    );
    await resumed.read();
    const start = budget.calls.length;
    await resumed.remove();
    await bundled.makeBucket(intent, restoredClient.bucket).remove(bucket);
    assert.equal(wire.object, undefined);
    assert.equal(wire.bucket, undefined);
    assert.equal(wire.requests.filter((r) => r.method === "PUT").length, 1);
    const deletions = wire.requests.filter((r) => r.method === "DELETE");
    assert.equal(deletions.length, 2);
    assert.equal(deletions[0]?.headers.get("if-match"), uploaded.etag);
    assert.equal(deletions[1]?.headers.get("if-match"), bucket.etag);
    assert.ok(start <= 160);
    assert.ok(budget.calls.length - start <= 40);
    assert.equal(budget.calls.length, wire.requests.length);
    t.diagnostic(
      `signed bundle: normal=${start}/160, cleanup=${budget.calls.length - start}/40`,
    );
  } finally {
    for (const sdk of sdkClients) sdk.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("signed SDK keeps JSON POST body hashes and required body headers in the signature", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = new DefaultRequestSigner(
    new SimpleAuthenticationDetailsProvider(
      "ocid1.tenancy.oc1..fixture",
      "ocid1.user.oc1..fixture",
      "11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11",
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      null,
    ),
  );
  let sends = 0;
  let observed: { uri: string; init: RequestInit } | undefined;
  const sdk = boundedObjectSdk(
    signer,
    new AbortController().signal,
    async (url, init) => {
      sends++;
      assert.ok(init);
      observed = { uri: String(url), init };
      return Response.json(
        { name: "fixture" },
        { headers: { etag: "bucket-rev" } },
      );
    },
    5000,
    { creationDeadline: Date.now() + 60000 },
  );
  sdk.endpoint = "https://objectstorage.eu-frankfurt-1.oraclecloud.com";
  try {
    await sdk.createBucket({
      namespaceName: "fixture",
      createBucketDetails: {
        name: "fixture",
        compartmentId: intent.compartment,
        freeformTags: { label: "UTF8-☃" },
      },
    });
    assert.equal(sends, 1);
    assert.ok(observed);
    verifyRequest(keys.publicKey, observed.uri, observed.init);
    const headers = new Headers(observed.init.headers);
    for (const name of ["content-type", "content-length", "x-content-sha256"])
      assert.ok(headers.get("authorization")?.toLowerCase().includes(name));
    assert.equal(
      headers.get("content-length"),
      String(Buffer.byteLength(String(observed.init.body))),
    );
  } finally {
    sdk.close();
  }
});

test("provider failure diagnostics identify preparation signing and attempted send without exposing secrets or changing ambiguity", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const secret = "private-value-never-log";
  for (const stage of ["prepare", "sign", "send", "sdk", "response"] as const) {
    let sends = 0;
    const sdk = boundedObjectSdk(
      {
        async signHttpRequest() {
          if (stage === "sign") throw Error(secret);
        },
      },
      new AbortController().signal,
      async () => {
        sends++;
        if (stage === "response")
          return Response.json({ message: secret }, { status: 403 });
        throw Error(secret);
      },
      5000,
      { creationDeadline: stage === "prepare" ? 0 : Date.now() + 60000 },
    );
    const budget = dispatcher();
    const client = objectClient(sdk, budget, intent.region);
    try {
      await assert.rejects(
        client.put(
          intent,
          stage === "sdk" ? "" : "trial.bin",
          probeContent(),
          "fixture-digest",
        ),
        (error) =>
          error instanceof BucketFailure &&
          error.code ===
            (stage === "response" ? "forbidden" : "unknown-outcome"),
      );
      assert.equal(sends, ["send", "response"].includes(stage) ? 1 : 0);
      assert.deepEqual(budget.calls, ["put_object"]);
      assert.deepEqual(warning.mock.calls.at(-1)?.arguments, [
        "berth.oci.request-failure",
        {
          action: "put_object",
          stage: ["sdk", "response"].includes(stage) ? "unknown" : stage,
        },
      ]);
      assert.equal(
        JSON.stringify(warning.mock.calls.map((c) => c.arguments)).includes(
          secret,
        ),
        false,
      );
    } finally {
      sdk.close();
    }
  }
});
