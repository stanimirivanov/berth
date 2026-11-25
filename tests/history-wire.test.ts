import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeHistoryDetail,
  decodeHistoryPage,
} from "../src/application/history/contract.ts";
import {
  acceptedHistoryDetails,
  acceptedHistoryPages,
  rejectedHistoryDetails,
  rejectedHistoryPages,
} from "./fixtures/history-wire.ts";

test("History projection accepts shared wire controls and rejects malformed details and pages", () => {
  for (const body of acceptedHistoryDetails)
    assert.deepEqual(decodeHistoryDetail(body), body);
  for (const body of acceptedHistoryPages)
    assert.deepEqual(decodeHistoryPage(body), body);

  for (const [reason, body] of Object.entries(rejectedHistoryDetails)) {
    assert.throws(() => decodeHistoryDetail(body), reason);
    assert.throws(
      () => decodeHistoryPage({ items: [body], next: null }),
      reason,
    );
  }
  for (const [reason, body] of Object.entries(rejectedHistoryPages))
    assert.throws(() => decodeHistoryPage(body), reason);
});
