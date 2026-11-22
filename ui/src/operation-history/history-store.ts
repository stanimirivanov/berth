import { patchState, signalStore, withMethods, withState } from "@ngrx/signals";
import { Effect } from "effect";

/** Browser-only allowlist; app counters are never provider allowances. */
export interface Operation {
  operation: string;
  startedAt: string;
  expiresAt: string;
  outcome: string;
  phase: string | null;
  pendingUpload: boolean;
  cleanupRequested: boolean;
  objectRemoved: boolean;
  verdict: "partial";
  budgets: Record<
    "normal" | "cleanup" | "monitoring" | "neon",
    { used: number; limit: number }
  >;
  unresolved: { requests: number; mutations: number };
}
interface State {
  items: Operation[];
  selected: Operation | null;
  next: string | null;
  loading: boolean;
  connected: boolean;
  loaded: boolean;
  error: string;
}
const initial: State = {
  items: [],
  selected: null,
  next: null,
  loading: false,
  connected: false,
  loaded: false,
  error: "",
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Deny malformed responses before render; Angular still escapes all text. */
function record(value: unknown): Operation {
  if (!value || typeof value !== "object") throw Error();
  const item = value as Operation;
  if (
    !uuid.test(item.operation) ||
    item.verdict !== "partial" ||
    !["active", "needs-reconciliation", "succeeded", "failed"].includes(
      item.outcome,
    ) ||
    ![null, "bucket", "object", "observe", "cleanup"].includes(item.phase) ||
    !Number.isFinite(Date.parse(item.startedAt)) ||
    !Number.isFinite(Date.parse(item.expiresAt)) ||
    [item.pendingUpload, item.cleanupRequested, item.objectRemoved].some(
      (flag) => typeof flag !== "boolean",
    )
  )
    throw Error();
  for (const key of ["normal", "cleanup", "monitoring", "neon"] as const) {
    const meter = item.budgets?.[key];
    if (
      !meter ||
      !Number.isInteger(meter.used) ||
      !Number.isInteger(meter.limit) ||
      meter.used < 0 ||
      meter.limit < 1 ||
      meter.used > meter.limit
    )
      throw Error();
  }
  if (
    !item.unresolved ||
    [item.unresolved.requests, item.unresolved.mutations].some(
      (count) => !Number.isInteger(count) || count < 0,
    ) ||
    item.unresolved.mutations > item.unresolved.requests
  )
    throw Error();
  return item;
}

/** Tab memory only. Disconnect clears credentials and invalidates outstanding replies. */
export const HistoryStore = signalStore(
  withState(initial),
  withMethods((store) => {
    let token = "";
    let generation = 0;
    const request = async (path: string) => {
      const response = await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            fetch(path, {
              headers: { authorization: `Bearer ${token}` },
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(5000),
            }),
          catch: () => new Error("unavailable"),
        }),
      );
      if (!response.ok)
        throw Error(response.status === 401 ? "unauthorized" : "unavailable");
      return response.json();
    };
    const load = async (
      before: string | null,
      operation: string | null = null,
    ) => {
      if (store.loading()) return;
      const epoch = ++generation;
      patchState(store, {
        loading: true,
        error: "",
        ...(operation ? {} : { selected: null, items: [], next: null }),
      });
      try {
        const result = await request(
          operation
            ? `/api/history/${operation}`
            : `/api/history${before ? `?before=${encodeURIComponent(before)}` : ""}`,
        );
        if (epoch !== generation) return;
        if (operation) {
          const selected = record(result);
          if (selected.operation !== operation) throw Error();
          patchState(store, { selected });
        } else {
          if (
            !Array.isArray(result.items) ||
            result.items.length > 50 ||
            (result.next !== null && !uuid.test(result.next))
          )
            throw Error();
          const items = result.items.map(record);
          patchState(store, { items, next: result.next, loaded: true });
        }
      } catch (error) {
        if (epoch === generation)
          patchState(store, {
            selected: null,
            error:
              error instanceof Error && error.message === "unauthorized"
                ? "Access denied. Enter a valid history token."
                : "History is unavailable. Retry when the read service is available.",
          });
      } finally {
        if (epoch === generation) patchState(store, { loading: false });
      }
    };
    return {
      connect(value: string, operation: string | null = null) {
        if (operation !== null && !uuid.test(operation)) {
          patchState(store, { error: "Invalid operation link." });
          return;
        }
        if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
          patchState(store, { error: "Enter a valid history token." });
          return;
        }
        token = value;
        patchState(store, { connected: true });
        void load(null, operation);
      },
      disconnect() {
        generation++;
        token = "";
        patchState(store, initial);
      },
      refresh() {
        void load(null);
      },
      older() {
        if (store.next()) void load(store.next());
      },
      select(operation: string) {
        if (uuid.test(operation)) void load(null, operation);
      },
    };
  }),
);
