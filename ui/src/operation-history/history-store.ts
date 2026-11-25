import { DestroyRef, inject } from "@angular/core";
import { patchState, signalStore, withMethods, withState } from "@ngrx/signals";
import { OWNER_SESSION } from "../owner-access/owner-session";
import {
  HISTORY_READER,
  type HistoryPage,
  type Operation,
} from "./history-reader";

/** The last successful page and the cursor needed to refresh that same view. */
interface ListResult extends HistoryPage {
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
  listReadSucceeded: boolean;
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
  listReadSucceeded: false,
  detailLoading: false,
  listFailure: null,
  detailFailure: null,
};

/** Own history snapshots and serialize reads for the single-reader service. */
export const HistoryStore = signalStore(
  withState(initial),
  withMethods((store) => {
    const owner = inject(OWNER_SESSION);
    const reader = inject(HISTORY_READER);
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

    /** Apply only the latest read for the requested pane and timestamp a successful snapshot. */
    const read = async (job: Read) => {
      const current = () => latest[job.pane] === job;
      try {
        if (job.pane === "list") {
          const result = await reader.list(job.before, current);
          if (!current() || result.kind === "discarded") {
            return;
          }
          patchState(
            store,
            result.kind === "success"
              ? {
                  listReadSucceeded: true,
                  list: {
                    ...result.value,
                    before: job.before,
                    fetchedAt: new Date().toISOString(),
                  },
                }
              : { listFailure: { before: job.before } },
          );
          return;
        }

        const result = await reader.detail(job.operation, current);
        if (!current() || result.kind === "discarded") {
          return;
        }
        if (result.kind === "success") {
          patchState(store, {
            detail: {
              record: result.value,
              fetchedAt: new Date().toISOString(),
            },
          });
        } else if (result.kind === "missing") {
          patchState(store, { detail: null, detailFailure: "missing" });
        } else {
          patchState(store, { detailFailure: "unavailable" });
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
          ? { listLoading: true, listReadSucceeded: false, listFailure: null }
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
        patchState(store, {
          list: page,
          listReadSucceeded: false,
          listFailure: null,
        });
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
        patchState(store, {
          listLoading: false,
          listReadSucceeded: false,
          detailLoading: false,
        });
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
