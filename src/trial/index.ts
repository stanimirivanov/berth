import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import {
  DefaultRequestSigner,
  type HttpRequest,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import { ObjectStorageClient } from "oci-objectstorage";
import { Client } from "pg";
import { makeProbe, ProbeFailure, type ProbeStage } from "./runtime-probe.js";
import { runSyntheticLifecycle } from "./synthetic-lifecycle.js";

const bootId = randomUUID();
let invocations = 0;
async function run() {
  const started = performance.now();
  let stage: ProbeStage = "runtime";
  try {
    if (process.versions.node.split(".")[0] !== "24")
      throw new Error("Unsupported runtime");
    stage = "admin-credential";
    if (
      ["NEON_API_KEY", "OCI_PRIVATE_KEY", "OCI_ADMIN_KEY"].some((key) =>
        Boolean(process.env[key]),
      )
    )
      throw new Error("Unexpected credential");
    stage = "service-credential";
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "NEON_AI_GATEWAY_TOKEN",
    ]) {
      if (process.env[key] && process.env[key] !== "disabled-for-berth-probe")
        throw new Error("Unexpected service credential");
    }
    stage = "database-url";
    for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
      const url = new URL(process.env[key] ?? "");
      if (url.username !== "berth_runtime" || url.pathname !== "/neondb")
        throw new Error("Owner connection present");
    }
    stage = "database";
    const db = new Client({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    let roleVerified = false;
    try {
      await db.connect();
      const result = await db.query(
        "select current_user = 'berth_runtime' as restricted",
      );
      roleVerified = result.rows[0]?.restricted === true;
    } finally {
      await db.end();
    }
    if (!roleVerified) throw new Error("Wrong DB identity");
    stage = "alchemy";
    const lifecycle = await runSyntheticLifecycle();
    stage = "signing";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const provider = new SimpleAuthenticationDetailsProvider(
      "synthetic-tenancy",
      "synthetic-user",
      "synthetic-fingerprint",
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      null,
    );
    const client = new ObjectStorageClient({
      authenticationDetailsProvider: provider,
    });
    let signingVerified = false;
    try {
      client.endpoint = "https://objectstorage.eu-frankfurt-1.oraclecloud.com";
      const request: HttpRequest = {
        method: "GET",
        uri: `${client.endpoint}/n/`,
        headers: new Headers(),
      };
      await new DefaultRequestSigner(provider).signHttpRequest(request);
      const auth = request.headers.get("authorization") ?? "";
      const signature = /signature="([^"]+)"/.exec(auth)?.[1];
      const headers = /headers="([^"]+)"/.exec(auth)?.[1];
      if (signature && headers) {
        const signed = headers
          .split(" ")
          .map((name) =>
            name === "(request-target)"
              ? "(request-target): get /n/"
              : `${name}: ${request.headers.get(name)}`,
          )
          .join("\n");
        signingVerified = verify(
          "RSA-SHA256",
          Buffer.from(signed),
          publicKey,
          Buffer.from(signature, "base64"),
        );
      }
    } finally {
      client.close();
    }
    return {
      node: process.versions.node,
      alchemy: "2.0.0-beta.86",
      effect: "4.1.4",
      oci: "2.146.0",
      buildDigest: process.env.BERTH_BUILD_DIGEST,
      bootId,
      invocation: ++invocations,
      lifecycle,
      signingVerified,
      roleVerified,
      dbQueries: 1,
      elapsedMs: Math.round(performance.now() - started),
      memoryBytes: process.memoryUsage().rss,
    };
  } catch {
    throw new ProbeFailure(stage);
  }
}
export default makeProbe({
  token: process.env.BERTH_TRIAL_TOKEN ?? "",
  expiresAt: Number(process.env.BERTH_PROBE_EXPIRES_AT),
  run,
});
