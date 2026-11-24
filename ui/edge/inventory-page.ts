const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** JSON records are the only valid containers for a page or instance. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error();
  return value as Record<string, unknown>;
}

/** Timestamps describe dated observations and must be usable by the browser. */
function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Validate presence together with its evidence fields and return only public instance data. */
function projectInstance(value: unknown) {
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
    !uuid.test(instance) ||
    typeof operation !== "string" ||
    !uuid.test(operation) ||
    typeof displayName !== "string" ||
    typeof region !== "string" ||
    !timestamp(observedAt) ||
    (presence === "verified-present"
      ? !timestamp(lastVerifiedAt) || uncertainty !== null
      : presence !== "uncertain" ||
        (lastVerifiedAt !== null && !timestamp(lastVerifiedAt)) ||
        (uncertainty !== "create-unresolved" &&
          uncertainty !== "delete-unresolved"))
  )
    throw Error();
  return {
    instance,
    operation,
    displayName,
    region,
    presence,
    observedAt,
    lastVerifiedAt,
    uncertainty,
  };
}

/** Accept only a bounded public Inventory projection from the hosted upstream. */
export function projectInventoryPage(value: unknown, limit: number) {
  const { offering, coverage, items, next } = record(value);
  if (
    offering !== "oci-object-storage-bucket" ||
    (coverage !== "complete" && coverage !== "incomplete") ||
    !Array.isArray(items) ||
    items.length > limit ||
    (next !== null && (typeof next !== "string" || !uuid.test(next)))
  )
    throw Error();
  return { offering, coverage, items: items.map(projectInstance), next };
}
