import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("owner receipt CLI reads private paths and redacts rejected credentials and receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "berth-receipt-"));
  try {
    const receipt = join(directory, "receipt.json");
    const url = join(directory, "recorder-url");
    await writeFile(receipt, '{"reference":"fixture-receipt-canary"}', {
      mode: 0o600,
    });
    await writeFile(
      url,
      "postgresql://neondb_owner:fixture-password-canary@127.0.0.1/neondb",
      { mode: 0o600 },
    );
    const result = spawnSync(
      process.execPath,
      [
        "dist/scripts/inventory-owner-receipt.js",
        "--database-url-file",
        url,
        "--receipt-file",
        receipt,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Inventory receipt submission stopped\./);
    assert.doesNotMatch(result.stderr, /fixture-(receipt|password)-canary/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
