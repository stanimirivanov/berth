import { validTimestamp } from "../observation-time";
import { isOperationId } from "../operation-id";
import type { createOwnerSession } from "../owner-access/owner-session";
import type { HistoryPage, HistoryReader, Operation } from "./history-reader";

/** Deny malformed responses before render; Angular still escapes all text. */
function record(value: unknown): Operation {
  if (!value || typeof value !== "object") {
    throw Error();
  }
  const item = value as Operation;
  if (
    typeof item.operation !== "string" ||
    !isOperationId(item.operation) ||
    item.verdict !== "partial" ||
    !["active", "needs-reconciliation", "succeeded", "failed"].includes(
      item.outcome,
    ) ||
    ![null, "bucket", "object", "observe", "cleanup"].includes(item.phase) ||
    !validTimestamp(item.startedAt) ||
    !validTimestamp(item.expiresAt) ||
    [item.pendingUpload, item.cleanupRequested, item.objectRemoved].some(
      (flag) => typeof flag !== "boolean",
    )
  ) {
    throw Error();
  }
  for (const key of ["normal", "cleanup", "monitoring", "neon"] as const) {
    const meter = item.budgets?.[key];
    if (
      !meter ||
      !Number.isSafeInteger(meter.used) ||
      !Number.isSafeInteger(meter.limit) ||
      meter.used < 0 ||
      meter.limit < 1 ||
      meter.used > meter.limit
    ) {
      throw Error();
    }
  }
  if (
    !item.unresolved ||
    [item.unresolved.requests, item.unresolved.mutations].some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    ) ||
    item.unresolved.mutations > item.unresolved.requests
  ) {
    throw Error();
  }
  return item;
}

/** Decode an opaque page cursor and each item before handing them to the store. */
function page(value: unknown): HistoryPage {
  if (!value || typeof value !== "object") {
    throw Error();
  }
  const { items, next } = value as { items?: unknown; next?: unknown };
  if (
    !Array.isArray(items) ||
    items.length > 50 ||
    !(next === null || (typeof next === "string" && isOperationId(next)))
  ) {
    throw Error();
  }
  return { items: items.map(record), next };
}

/** Translate History reads into same-origin requests and checked responses. */
export function createHistoryReader(
  owner: Pick<ReturnType<typeof createOwnerSession>, "read">,
): HistoryReader {
  return {
    list(before, isCurrent) {
      const query = before ? `?before=${encodeURIComponent(before)}` : "";
      return owner.read(`/api/history${query}`, page, isCurrent);
    },
    detail(operation, isCurrent) {
      return owner.read(
        `/api/history/${operation}`,
        (body) => {
          const selected = record(body);
          if (selected.operation !== operation) {
            throw Error();
          }
          return selected;
        },
        isCurrent,
      );
    },
  };
}
