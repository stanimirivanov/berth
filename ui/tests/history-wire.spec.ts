import { expect, test } from "@playwright/test";
import { historyRecord } from "../../tests/fixtures/history-record";
import {
  acceptedHistoryDetails,
  acceptedHistoryPages,
  rejectedHistoryDetails,
  rejectedHistoryPages,
} from "../../tests/fixtures/history-wire";
import { createHistoryReader } from "../src/operation-history/history-data-access";
import { createOwnerSession } from "../src/owner-access/owner-session";

/** Exercise the same-origin History reader through the Owner access boundary. */
function historyReader(body: unknown) {
  const owner = createOwnerSession(async () => Response.json(body));
  owner.connect("h".repeat(40));
  return { owner, reader: createHistoryReader(owner) };
}

test("History reader accepts shared wire controls and rejects malformed details and pages", async () => {
  const current = () => true;
  for (const body of acceptedHistoryDetails) {
    const { reader } = historyReader(body);
    expect(await reader.detail(body.operation, current)).toEqual({
      kind: "success",
      value: body,
    });
  }
  for (const body of acceptedHistoryPages) {
    const { reader } = historyReader(body);
    expect(await reader.list(null, current)).toEqual({
      kind: "success",
      value: body,
    });
  }
  for (const [reason, body] of Object.entries(rejectedHistoryDetails)) {
    const { owner, reader } = historyReader(body);
    expect(
      await reader.detail(historyRecord.operation, current),
      reason,
    ).toEqual({
      kind: "unavailable",
    });
    expect(owner.status(), reason).toBe("unverified");
    const list = historyReader({ items: [body], next: null });
    expect(await list.reader.list(null, current), reason).toEqual({
      kind: "unavailable",
    });
    expect(list.owner.status(), reason).toBe("unverified");
  }
  for (const [reason, body] of Object.entries(rejectedHistoryPages)) {
    const { owner, reader } = historyReader(body);
    expect(await reader.list(null, current), reason).toEqual({
      kind: "unavailable",
    });
    expect(owner.status(), reason).toBe("unverified");
  }
});
