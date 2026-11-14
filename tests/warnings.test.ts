import assert from "node:assert/strict";
import test from "node:test";
import { thresholdWarning } from "../src/trial/warnings.js";

test("app threshold warns at equality without a provider-cap claim", () => {
  assert.equal(thresholdWarning({ status: "unknown", value: null }), false);
  assert.equal(thresholdWarning({ status: "known", value: 1048575 }), false);
  assert.equal(thresholdWarning({ status: "known", value: 1048576 }), true);
  assert.equal(thresholdWarning({ status: "known", value: 2097152 }), true);
});
