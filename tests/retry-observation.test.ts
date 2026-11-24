import assert from "node:assert/strict";
import test from "node:test";
import { retryObserver } from "../src/providers/oci/retry-observation.ts";

const scope = {
  region: "eu-frankfurt-1",
  namespace: "retryfixture",
  compartment: "ocid1.compartment.oc1..fixture",
};
const target = { ...scope, bucket: `berth-${"a".repeat(32)}` };

test("a stalled signer never dispatches and a stalled response is cancelled", async () => {
  const keepProcessAlive = setTimeout(() => {}, 1000);
  try {
    const signing = Promise.withResolvers<void>();
    let sends = 0;
    const stalledSigning = retryObserver(
      scope,
      {
        signHttpRequest: () => signing.promise,
      },
      async () => {
        sends++;
        return Response.json([]);
      },
    );
    await assert.rejects(
      stalledSigning.observe(target, "bucket", Date.now() + 50),
    );
    signing.resolve();
    assert.equal(sends, 0);

    let cancelled = false;
    const stalledBody = retryObserver(
      scope,
      { async signHttpRequest() {} },
      async () =>
        new Response(
          new ReadableStream({
            pull() {},
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    await assert.rejects(stalledBody.observe(target, "list", Date.now() + 50));
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(keepProcessAlive);
  }
});

test("read diagnostics distinguish denied access, absent ownership, and malformed configuration", async () => {
  const bucket = {
    id: "ocid1.bucket.oc1..fixture",
    name: target.bucket,
    namespace: target.namespace,
    compartmentId: target.compartment,
    etag: "fixture-tag",
    freeformTags: {
      "berth-operation": "fixture-operation",
      "berth-marker": "fixture-marker",
    },
    publicAccessType: "NoPublicAccess",
    storageTier: "Standard",
    versioning: "Disabled",
    autoTiering: "Disabled",
    objectEventsEnabled: false,
    replicationEnabled: false,
    isReadOnly: false,
  };
  const headers = {
    date: new Date().toUTCString(),
    etag: bucket.etag,
    "opc-request-id": "fixture-read",
  };
  const probe = (response: Response) =>
    retryObserver(
      scope,
      { async signHttpRequest() {} },
      async () => response,
    ).observe(target, "bucket", Date.now() + 1000);
  assert.equal(
    (await probe(new Response(null, { status: 403 }))).kind,
    "read-access-unavailable",
  );
  assert.equal(
    (await probe(Response.json({ ...bucket, freeformTags: {} }, { headers })))
      .kind,
    "ownership-conflict",
  );
  const missingConfiguration = await probe(
    Response.json({ ...bucket, isReadOnly: undefined }, { headers }),
  );
  assert.equal(missingConfiguration.kind, "present");
  if (missingConfiguration.kind === "present")
    assert.equal(missingConfiguration.configurationMatches, false);
  for (const bad of [
    { isBucketKeyEnabled: "true" },
    { kmsKeyId: false },
    { objectLifecyclePolicyEtag: 0 },
  ]) {
    assert.equal(
      (await probe(Response.json({ ...bucket, ...bad }, { headers }))).kind,
      "inconclusive",
    );
  }
});

test("the OCI SDK signature binds the exact method and query on each retry GET", async () => {
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { DefaultRequestSigner, SimpleAuthenticationDetailsProvider } =
    await import("oci-common");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const signer = new DefaultRequestSigner(
    new SimpleAuthenticationDetailsProvider(
      "ocid1.tenancy.oc1..fixture",
      "ocid1.user.oc1..fixture",
      "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      null,
    ),
  );
  const paths: string[] = [];
  const provider = retryObserver(scope, signer, async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    paths.push(path);
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    const signedHeaders = /headers="([^"]+)"/.exec(authorization)?.[1];
    const signature = /signature="([^"]+)"/.exec(authorization)?.[1];
    assert.ok(signedHeaders && signature);
    const signingString = signedHeaders
      .split(" ")
      .map((key) =>
        key === "(request-target)"
          ? `(request-target): get ${path}`
          : `${key}: ${headers.get(key)}`,
      )
      .join("\n");
    assert.ok(
      verify(
        "RSA-SHA256",
        Buffer.from(signingString),
        publicKey,
        Buffer.from(signature, "base64"),
      ),
    );
    return new Response(null, { status: 404 });
  });
  await provider.observe(target, "bucket", Date.now() + 2000);
  await provider.observe(target, "list", Date.now() + 2000);
  assert.deepEqual(paths, [
    `/n/${scope.namespace}/b/${target.bucket}?fields=autoTiering`,
    `/n/${scope.namespace}/b?compartmentId=${scope.compartment}&limit=2`,
  ]);
});
