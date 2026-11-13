import type { PersistedState, StateService } from "alchemy/State/State";
import { StateStoreError } from "alchemy/State/State";
import * as Effect from "effect/Effect";

/** Minimal parameterized SQL port; caller owns connection and query timeouts. */
export interface StateDatabase {
  /** Executes one guarded statement; never logs credentials or provider errors. */
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
/** Immutable identity of one execution, not transferable to a fresh invocation. */
export interface StateClaim {
  readonly owner: string;
  readonly generation: string;
}
const stack = "berth-fenced-trial";
const stage = "probe";
/**
 * Explicit acquisition, never invoked by state operations or on their failure.
 * A fresh process must use a fresh UUID. Repeating its own uncertain acquisition
 * can observe the same active generation without extending its lifetime.
 */
export async function claimState(
  db: StateDatabase,
  owner: string,
  ttlSeconds = 30,
): Promise<StateClaim> {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      owner,
    ) ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 60
  )
    throw Error("Invalid state claim");
  try {
    const result = await db.query(
      "SELECT berth_state.claim($1::uuid,$2::integer) AS claim",
      [owner, ttlSeconds],
    );
    const claim = result.rows[0]?.claim;
    if (
      !claim ||
      typeof claim !== "object" ||
      !("owner" in claim) ||
      !("generation" in claim) ||
      claim.owner !== owner ||
      typeof claim.generation !== "string" ||
      !/^\d+$/.test(claim.generation)
    )
      throw Error();
    return Object.freeze({ owner, generation: claim.generation });
  } catch {
    throw Error("State claim unavailable; reconcile before a new execution");
  }
}
/** Reject unsupported stack/stage/FQN before dispatch; this adapter is trial-only. */
function target(request: { stack: string; stage?: string; fqn?: string }) {
  if (
    request.stack !== stack ||
    (request.stage !== undefined && request.stage !== stage) ||
    (request.fqn !== undefined && request.fqn !== "synthetic")
  )
    throw Error("Unsupported trial state target");
}
/**
 * Bind every read/write to a captured generation. No DDL, retries, lock session,
 * credential persistence or reacquisition. SQL performs the authoritative payload
 * checks and holds ownership through commit. Schema version is pinned by bootstrap.
 */
export function makeFencedState(db: StateDatabase, claim: StateClaim) {
  const owner = claim.owner;
  const generation = claim.generation;
  /** Map any SQL/transport failure to a fixed safe error; an unknown commit stays uncertain. */
  const call = (op: string, key: string | null = null, value: unknown = null) =>
    Effect.tryPromise({
      try: async () => {
        const result = await db.query(
          "SELECT berth_state.access($1::uuid,$2::bigint,$3::text,$4::text,$5::jsonb) AS result",
          [
            owner,
            generation,
            op,
            key,
            value === null ? null : JSON.stringify(value),
          ],
        );
        return result.rows[0]?.result;
      },
      catch: () =>
        new StateStoreError({
          message:
            "State operation rejected or outcome uncertain; reconcile without retry",
        }),
    });
  /** Read the bounded SQL snapshot under the same generation guard as writes. */
  const snapshot = () =>
    call("snapshot").pipe(
      Effect.map((result) => result as Record<string, PersistedState>),
    );
  /** Convert synchronous target/payload errors into the adapter's safe typed failure. */
  const checked = <A>(
    request: { stack: string; stage?: string; fqn?: string },
    work: () => Effect.Effect<A, StateStoreError>,
  ) =>
    Effect.suspend(() => {
      try {
        target(request);
        return work();
      } catch {
        return Effect.fail(
          new StateStoreError({ message: "Unsupported trial state target" }),
        );
      }
    });
  const state: StateService = {
    id: "berth-fenced-postgres",
    getVersion: () => Effect.succeed(1),
    listStacks: () =>
      snapshot().pipe(
        Effect.map((rows) => (Object.keys(rows).length ? [stack] : [])),
      ),
    listStages: (name) =>
      checked({ stack: name }, () =>
        snapshot().pipe(
          Effect.map((rows) => (Object.keys(rows).length ? [stage] : [])),
        ),
      ),
    get: (request) =>
      checked(request, () =>
        snapshot().pipe(Effect.map((rows) => rows[request.fqn])),
      ),
    getReplacedResources: (request) =>
      checked(request, () => snapshot().pipe(Effect.as([]))),
    set: (request) =>
      checked(request, () =>
        call("set", request.fqn, request.value).pipe(Effect.as(request.value)),
      ),
    delete: (request) =>
      checked(request, () => call("delete", request.fqn).pipe(Effect.asVoid)),
    deleteStack: (request) =>
      checked(request, () => call("clear").pipe(Effect.asVoid)),
    list: (request) =>
      checked(request, () =>
        snapshot().pipe(
          Effect.map((rows) =>
            Object.keys(rows).filter((key) => key !== "$output"),
          ),
        ),
      ),
    getOutput: (request) =>
      checked(request, () =>
        snapshot().pipe(Effect.map((rows) => rows.$output)),
      ),
    setOutput: (request) =>
      checked(request, () =>
        call("output", null, request.value).pipe(Effect.as(request.value)),
      ),
  };
  return {
    state,
    /** Extend only a still-live claim; expired claims remain permanently retired. */
    renew: () => call("renew").pipe(Effect.asVoid),
    /** Release execution ownership without deleting state or resetting generation history. */
    release: () => call("release").pipe(Effect.asVoid),
  };
}
