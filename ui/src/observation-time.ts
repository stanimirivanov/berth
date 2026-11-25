const timestamp =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Accept the timestamp strings serialized by PostgreSQL, including UTC offsets. */
export function validTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !timestamp.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  const date = value.slice(0, 10);
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
