import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  X509Certificate,
} from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";

export const fixtureHost = "ep-fixture.aws.neon.tech";
export const fixturePassword = "disposable-test-password";
export type Authentication =
  | "plain-scram"
  | "stalled-termination"
  | "scram-plus"
  | "incomplete-plus"
  | "unsolicited-sasl-challenge"
  | "invalid-plus"
  | "trust"
  | "cleartext"
  | "md5";

const salt = Buffer.from("berth SCRAM test salt");
const iterations = 4096;

/** Generate a short-lived synthetic identity for the exact hostname used by the adapters. */
export function fixtureIdentity() {
  const directory = mkdtempSync(join(tmpdir(), "berth-scram-"));

  try {
    const cert = join(directory, "certificate");
    const key = join(directory, "key");

    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-noenc",
          "-sha256",
          "-days",
          "1",
          "-subj",
          "/CN=Berth test",
          "-addext",
          `subjectAltName=DNS:${fixtureHost}`,
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { stdio: "ignore" },
      );
    } catch {
      throw Error(
        "PostgreSQL authentication fixture needs OpenSSL 3 on PATH to generate its TLS identity",
      );
    }

    return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function int32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function message(tag: string, payload: Buffer) {
  return Buffer.concat([Buffer.from(tag), int32(payload.length + 4), payload]);
}

function auth(code: number, data = Buffer.alloc(0)) {
  return message("R", Buffer.concat([int32(code), data]));
}

const ready = Buffer.concat([auth(0), message("Z", Buffer.from("I"))]);
const firstQueryError = message(
  "E",
  Buffer.from("SERROR\0C42501\0Mfixture stopped the first SQL statement\0\0"),
);

/** Verify the client's TLS certificate binding and SCRAM proof before returning a server signature. */
function serverSignature(
  initial: string,
  challenge: string,
  response: string,
  expectedBinding: Buffer,
) {
  const fields = Object.fromEntries(
    response.split(",").map((field) => [field[0], field.slice(2)]),
  );
  assert.equal(fields.c, expectedBinding.toString("base64"));
  assert.equal(fields.r, challenge.split(",")[0]?.slice(2));

  const transcript = `${initial},${challenge},${response.split(",p=")[0]}`;
  const salted = pbkdf2Sync(fixturePassword, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const signature = createHmac("sha256", storedKey).update(transcript).digest();
  const expectedProof = Buffer.from(
    clientKey.map((byte, i) => byte ^ (signature[i] ?? 0)),
  );
  assert.equal(fields.p, expectedProof.toString("base64"));

  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return createHmac("sha256", serverKey).update(transcript).digest("base64");
}

/** Serve only the startup protocol and record any attempted SQL on a bound loopback port. */
export async function postgresAuthenticationFixture(
  identity: ReturnType<typeof fixtureIdentity>,
  mode: Authentication,
) {
  const context = createSecureContext(identity);
  const certificate = new X509Certificate(identity.cert);
  const fingerprint = createHash("sha256").update(certificate.raw).digest();
  const mechanisms: string[] = [];
  const sql: string[] = [];
  let replies = 0;
  const connections = new Set<Socket>();
  const stallTermination = mode === "stalled-termination";
  const server = createServer({ allowHalfOpen: stallTermination }, (raw) => {
    connections.add(raw);
    raw.once("close", () => connections.delete(raw));
    raw.on("readable", function readSslRequest() {
      const sslRequest = raw.read(8);
      if (sslRequest === null) return;
      raw.off("readable", readSslRequest);
      assert.deepEqual(sslRequest, Buffer.concat([int32(8), int32(80877103)]));
      assert.equal(raw.readableLength, 0);
      raw.write("S");
      const socket = new TLSSocket(raw, {
        isServer: true,
        secureContext: context,
      });
      socket.allowHalfOpen = stallTermination;
      socket.on("error", () => socket.destroy());

      let startup = true;
      let pending: Buffer = Buffer.alloc(0);
      let initial = "";
      let challenge = "";
      let binding: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= (startup ? 4 : 5)) {
          const length =
            pending.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
          if (pending.length < length) return;
          const packet = pending.subarray(0, length);
          pending = pending.subarray(length);

          if (startup) {
            startup = false;
            if (mode === "trust") socket.write(ready);
            else if (mode === "cleartext") socket.write(auth(3));
            else if (mode === "md5") socket.write(auth(5, Buffer.alloc(4, 1)));
            else if (mode === "unsolicited-sasl-challenge")
              socket.write(
                auth(11, Buffer.from("r=fixture,s=Zml4dHVyZQ==,i=4096")),
              );
            else
              socket.write(
                auth(
                  10,
                  Buffer.from(
                    mode === "plain-scram" || stallTermination
                      ? "SCRAM-SHA-256\0\0"
                      : "SCRAM-SHA-256\0SCRAM-SHA-256-PLUS\0\0",
                  ),
                ),
              );
            continue;
          }

          const tag = String.fromCharCode(packet[0] ?? 0);
          const data = packet.subarray(5);
          if (tag === "p") {
            replies++;
            if (mode === "cleartext" || mode === "md5") {
              socket.write(ready);
            } else if (!challenge) {
              const separator = data.indexOf(0);
              const mechanism = data.toString("utf8", 0, separator);
              mechanisms.push(mechanism);

              const plus = mechanism === "SCRAM-SHA-256-PLUS";
              const header = plus ? "p=tls-server-end-point,," : "y,,";
              const first = data.toString("utf8", separator + 5);
              assert.ok(first.startsWith(header));
              initial = first.slice(header.length);
              assert.match(initial, /^n=\*,r=.+$/);
              binding = plus
                ? Buffer.concat([Buffer.from(header), fingerprint])
                : Buffer.from(header);
              challenge = `r=${initial.slice(6)}server-nonce,s=${salt.toString("base64")},i=${iterations}`;
              socket.write(auth(11, Buffer.from(challenge)));
            } else {
              const signature = serverSignature(
                initial,
                challenge,
                data.toString(),
                binding,
              );
              const final = auth(
                12,
                Buffer.from(
                  `v=${mode === "invalid-plus" ? "d3Jvbmc=" : signature}`,
                ),
              );
              socket.write(
                mode === "incomplete-plus"
                  ? ready
                  : Buffer.concat([final, ready]),
              );
            }
          } else if (tag === "X") {
            if (!stallTermination) socket.end();
          } else {
            sql.push(data.subarray(0, -1).toString());
            socket.write(firstQueryError);
          }
        }
      });
    });
  }).listen(0, "127.0.0.1");

  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    mechanisms,
    sql,
    get replies() {
      return replies;
    },
    close: () => {
      for (const connection of connections) connection.destroy();
      return server[Symbol.asyncDispose]();
    },
  };
}
