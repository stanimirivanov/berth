import { DestroyRef, inject } from "@angular/core";
import { patchState, signalStore, withMethods, withState } from "@ngrx/signals";
import { isOperationId } from "../operation-id";
import { OWNER_SESSION } from "../owner-access/owner-session";

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
/** The last successful page and the cursor needed to refresh that same view. */
interface ListResult {
  items: Operation[];
  next: string | null;
  before: string | null;
  fetchedAt: string;
}

/** The last successful read for the selected operation. */
interface DetailResult {
  record: Operation;
  fetchedAt: string;
}

/** Pane results and failures that must be cleared together on access denial. */
interface State {
  list: ListResult | null;
  detail: DetailResult | null;
  operation: string | null;
  listLoading: boolean;
  detailLoading: boolean;
  listFailure: { before: string | null } | null;
  detailFailure: "missing" | "unavailable" | null;
}

/** The request identity and target shared by the queue and reply checks. */
type Read =
  | { pane: "list"; before: string | null }
  | { pane: "detail"; operation: string };

const initial: State = {
  list: null,
  detail: null,
  operation: null,
  listLoading: false,
  detailLoading: false,
  listFailure: null,
  detailFailure: null,
};
const timestamp =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Accept the timestamp strings serialized by PostgreSQL, including UTC offsets. */
function validTimestamp(value: unknown): value is string {
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
      !Number.isInteger(meter.used) ||
      !Number.isInteger(meter.limit) ||
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
      (count) => !Number.isInteger(count) || count < 0,
    ) ||
    item.unresolved.mutations > item.unresolved.requests
  ) {
    throw Error();
  }
  return item;
}

/** Keep the last successful page independently of pending and failed reads. */
function listResult(value: unknown, before: string | null): ListResult {
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
  return {
    items: items.map(record),
    next,
    before,
    fetchedAt: new Date().toISOString(),
  };
}

/** Own history snapshots and serialize reads for the single-reader service. */
export const HistoryStore = signalStore(
  withState(initial),
  withMethods((store) => {
    const owner = inject(OWNER_SESSION);
    let active = false;
    let inboxPage: ListResult | null = null;
    const pending: Partial<Record<Read["pane"], Read>> = {};
    const latest: Partial<Record<Read["pane"], Read>> = {};

    /** Drop queued reads and make results from dispatched reads obsolete. */
    const discardReads = () => {
      delete pending.list;
      delete pending.detail;
      delete latest.list;
      delete latest.detail;
    };
    const unsubscribe = owner.onClear(() => {
      inboxPage = null;
      discardReads();
      patchState(store, initial);
    });
    inject(DestroyRef).onDestroy(unsubscribe);

    /** Decode and apply only the latest read for the requested history pane. */
    const read = async (job: Read) => {
      const current = () => latest[job.pane] === job;
      const path =
        job.pane === "detail"
          ? `/api/history/${job.operation}`
          : `/api/history${job.before ? `?before=${encodeURIComponent(job.before)}` : ""}`;
      try {
        const result = await owner.read(
          path,
          (body) => {
            if (job.pane === "list") {
              return { list: listResult(body, job.before) };
            }
            const selected = record(body);
            if (selected.operation !== job.operation) {
              throw Error();
            }
            return {
              detail: { record: selected, fetchedAt: new Date().toISOString() },
            };
          },
          current,
        );
        if (!current() || result.kind === "discarded") {
          return;
        }
        if (result.kind === "success") {
          patchState(store, result.value);
        } else if (job.pane === "detail" && result.kind === "missing") {
          patchState(store, { detail: null, detailFailure: "missing" });
        } else {
          patchState(
            store,
            job.pane === "list"
              ? { listFailure: { before: job.before } }
              : { detailFailure: "unavailable" },
          );
        }
      } finally {
        if (current()) {
          delete latest[job.pane];
          patchState(
            store,
            job.pane === "list"
              ? { listLoading: false }
              : { detailLoading: false },
          );
        }
      }
    };

    /** Finish the dispatched read before starting the newest queued detail or list. */
    const drain = async () => {
      if (active) {
        return;
      }
      active = true;
      try {
        let job = pending.detail ?? pending.list;
        while (job) {
          delete pending[job.pane];
          await read(job);
          job = pending.detail ?? pending.list;
        }
      } finally {
        active = false;
      }
    };

    /** Replace queued work for this pane, keeping the other pane's request. */
    const enqueue = (job: Read) => {
      if (!owner.canRead()) {
        return;
      }
      latest[job.pane] = job;
      pending[job.pane] = job;
      patchState(
        store,
        job.pane === "list"
          ? { listLoading: true, listFailure: null }
          : { detailLoading: true, detailFailure: null },
      );
      void drain();
    };

    /** Restore the page that opened the detail, preserving newer data for its cursor. */
    const restoreInbox = () => {
      const page = inboxPage;
      inboxPage = null;
      if (!page) {
        return;
      }
      const listRead = latest.list;
      if (listRead?.pane === "list" && listRead.before !== page.before) {
        delete pending.list;
        delete latest.list;
        patchState(store, { listLoading: false });
      }
      if (store.list()?.before !== page.before) {
        patchState(store, { list: page, listFailure: null });
      }
    };

    /** Retain detail data only while reading the same operation. */
    const select = (operation: string | null) => {
      if (operation === store.operation()) {
        if (
          operation &&
          !store.detail() &&
          !store.detailFailure() &&
          !store.detailLoading()
        ) {
          enqueue({ pane: "detail", operation });
        }
        return;
      }
      if (operation) {
        inboxPage = store.list();
      } else {
        restoreInbox();
      }
      delete pending.detail;
      delete latest.detail;
      patchState(store, {
        operation,
        detail: null,
        detailFailure: null,
        detailLoading: false,
      });
      if (operation) {
        enqueue({ pane: "detail", operation });
      }
    };

    /** Enter the saved detail first, then fill in the list if it has no result. */
    const open = (operation: string | null) => {
      if (!owner.canRead()) {
        return;
      }
      select(operation);
      if (!store.list() && !store.listFailure() && !store.listLoading()) {
        enqueue({ pane: "list", before: null });
      }
    };

    return {
      open,
      select,
      /** Preserve settled views while discarding work from the departed screen. */
      leave() {
        discardReads();
        patchState(store, { listLoading: false, detailLoading: false });
      },
      refreshList: () =>
        enqueue({ pane: "list", before: store.list()?.before ?? null }),
      newest: () => enqueue({ pane: "list", before: null }),
      older() {
        const before = store.list()?.next;
        if (before) {
          enqueue({ pane: "list", before });
        }
      },
      retryList() {
        const failure = store.listFailure();
        if (failure) {
          enqueue({ pane: "list", before: failure.before });
        }
      },
      /** Re-read the current selection without clearing its successful result. */
      refreshDetail() {
        const operation = store.operation();
        if (operation) {
          enqueue({ pane: "detail", operation });
        }
      },
    };
  }),
);
