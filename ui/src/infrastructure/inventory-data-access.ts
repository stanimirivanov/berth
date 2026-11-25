import { validTimestamp } from "../observation-time";
import { isOperationId } from "../operation-id";
import type { createOwnerSession } from "../owner-access/owner-session";
import type { InventoryInstance, InventoryPage } from "./inventory-model";
import type { InventoryReader } from "./inventory-reader";

const cursor = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const pageSize = 20;

/** Require a JSON record before reading fields. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error();
  }
  return value as Record<string, unknown>;
}

/** Decode the public identity, observation and presence fields together. */
function instance(value: unknown): InventoryInstance {
  const {
    instance,
    operation,
    displayName,
    region,
    presence,
    observedAt,
    lastVerifiedAt,
    uncertainty,
  } = record(value);
  if (
    typeof instance !== "string" ||
    !cursor.test(instance) ||
    typeof operation !== "string" ||
    !isOperationId(operation) ||
    typeof displayName !== "string" ||
    typeof region !== "string" ||
    !validTimestamp(observedAt)
  ) {
    throw Error();
  }
  const identity = { instance, operation, displayName, region, observedAt };
  if (
    presence === "verified-present" &&
    validTimestamp(lastVerifiedAt) &&
    uncertainty === null
  ) {
    return { ...identity, presence, lastVerifiedAt, uncertainty };
  }
  if (
    presence === "uncertain" &&
    (lastVerifiedAt === null || validTimestamp(lastVerifiedAt)) &&
    (uncertainty === "create-unresolved" || uncertainty === "delete-unresolved")
  ) {
    return { ...identity, presence, lastVerifiedAt, uncertainty };
  }
  throw Error();
}

/** Check page navigation and coverage before the session can become verified. */
function decodePage(value: unknown, after: string | null): InventoryPage {
  const { offering, coverage, items, next } = record(value);
  if (
    offering !== "oci-object-storage-bucket" ||
    (coverage !== "complete" && coverage !== "incomplete") ||
    !Array.isArray(items) ||
    items.length > pageSize ||
    (next !== null &&
      (typeof next !== "string" ||
        !cursor.test(next) ||
        next === after ||
        !items.length))
  ) {
    throw Error();
  }
  return { offering, coverage, items: items.map(instance), next };
}

/** Construct a bounded read without taking ownership of the browser credential. */
export function createInventoryReader(
  owner: Pick<ReturnType<typeof createOwnerSession>, "read">,
): InventoryReader {
  return {
    page(after, isCurrent) {
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (after !== null) {
        query.set("after", after);
      }
      return owner.read(
        `/api/inventory?${query}`,
        (value) => decodePage(value, after),
        isCurrent,
      );
    },
  };
}
