/** Parameterized connection supplied by the host with the capability's dedicated database role. */
export interface RetainedTrialDatabase {
  query(
    text: string,
    parameters?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The installed ledger returns a single result, including explicit null for a missing record. */
export async function retainedTrialResult(
  db: RetainedTrialDatabase,
  text: string,
  parameters: unknown[],
): Promise<unknown> {
  const { rows } = await db.query(text, parameters);
  if (rows.length !== 1 || !rows[0] || !Object.hasOwn(rows[0], "result"))
    throw Error("Retained trial result unavailable");
  return rows[0].result;
}
