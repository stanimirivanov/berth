import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureUserRejection,
  saveUserRejection,
} from "../scripts/oci-diagnostics.js";

test("rejected-user detail is bounded and private, never part of the printable error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-rejection-"));
  try {
    const body = JSON.stringify({
      detail: "private-provider-detail",
      scimType: "invalidValue",
    });
    const error = await captureUserRejection(
      new Response(body, { status: 400 }),
    );
    assert.ok(!error.message.includes("private-provider-detail"));
    await saveUserRejection(dir, error);
    const file = join(dir, "create-user-error.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    assert.equal(data.body, body);
    assert.equal(data.httpStatus, 400);
    assert.equal(data.truncated, false);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(saveUserRejection(dir, error));
    assert.equal(JSON.parse(await readFile(file, "utf8")).body, body);
    const huge = await captureUserRejection(
      new Response("x".repeat(20000), { status: 400 }),
    );
    assert.equal(huge.diagnostic.truncated, true);
    assert.ok(Buffer.byteLength(huge.diagnostic.body) <= 16384);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("diagnostic read failure preserves safe rejection and never exposes transport errors", async () => {
  const stream = new ReadableStream({
    pull() {
      throw new Error("private-stream-error");
    },
  });
  const error = await captureUserRejection(
    new Response(stream, { status: 400 }),
  );
  assert.equal(error.diagnostic.body, "[response body unavailable]");
  assert.ok(!error.message.includes("private-stream-error"));
});
