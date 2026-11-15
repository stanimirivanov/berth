import assert from "node:assert/strict";
import test from "node:test";
import { recoverySites } from "./fakes/recovery-shard.js";

test("recovery shards form a deterministic disjoint complete partition", () => {
  const sites = Array.from({ length: 173 }, (_, n) => `boundary-${n}`);
  const shards = [1, 2, 3, 4].map((n) => recoverySites(sites, `${n}/4`));
  assert.deepEqual(shards.flat().sort(), [...sites].sort());
  assert.equal(new Set(shards.flat()).size, sites.length);
  assert.ok(
    Math.max(...shards.map((s) => s.length)) -
      Math.min(...shards.map((s) => s.length)) <=
      1,
  );
  assert.deepEqual(recoverySites([...sites].reverse(), "2/4"), shards[1]);
  assert.deepEqual(recoverySites(sites, undefined), sites);
});

test("recovery selection refuses invalid or empty shards and CI point filters", () => {
  for (const value of ["", "0/4", "5/4", "1/0", "1/5", "01/4", "1", "1/4 "])
    assert.throws(() => recoverySites(["a", "b", "c", "d"], value));
  assert.throws(() => recoverySites(["a"], "2/4"));
  assert.throws(() => recoverySites(["a", "a"], "1/4"));
  assert.throws(() => recoverySites(["a"], undefined, "missing"));
  assert.throws(() => recoverySites(["a"], "1/4", "a"));
  assert.throws(() => recoverySites(["a"], undefined, "a", true));
  assert.deepEqual(recoverySites(["a", "b"], undefined, "b"), ["b"]);
});
