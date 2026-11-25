import { computed, DestroyRef, inject } from "@angular/core";
import {
  patchState,
  signalStore,
  withComputed,
  withMethods,
  withState,
} from "@ngrx/signals";
import { OWNER_SESSION } from "../owner-access/owner-session";
import type { InventoryInstance, InventoryPage } from "./inventory-model";
import { INVENTORY_READER } from "./inventory-reader";

/** A successful browser read includes a fetch time separate from the evidence. */
interface Snapshot extends InventoryPage {
  fetchedAt: string;
  unrefreshed: InventoryInstance[];
}

/** A refresh replaces the snapshot and pagination extends it. */
type ReadKind = "refresh" | "more";

/** The current read retains the exact cursor needed for a retry. */
interface Read {
  kind: ReadKind;
  after: string | null;
}

/** Keep successful data available independently of the next read's outcome. */
interface State {
  snapshot: Snapshot | null;
  loading: ReadKind | null;
  failure: Read | null;
}

const initial: State = { snapshot: null, loading: null, failure: null };

/** Put uncertain instances first and keep the remaining ordering deterministic. */
function compare(left: InventoryInstance, right: InventoryInstance): number {
  if (left.presence !== right.presence) {
    return left.presence === "uncertain" ? -1 : 1;
  }
  return (
    left.displayName.localeCompare(right.displayName, "en") ||
    left.instance.localeCompare(right.instance)
  );
}

/** Keep rows outside a partial refresh until the reader reaches the end of the offering. */
function merge(
  previous: Snapshot | null,
  page: InventoryPage,
  kind: ReadKind,
): Snapshot {
  const earlier = kind === "more" ? previous?.items : undefined;
  const rows = new Map(earlier?.map((row) => [row.instance, row]));
  for (const row of page.items) {
    rows.set(row.instance, row);
  }
  const retained =
    kind === "more"
      ? (previous?.unrefreshed ?? [])
      : [...(previous?.items ?? []), ...(previous?.unrefreshed ?? [])];
  return {
    ...page,
    items: [...rows.values()],
    unrefreshed: page.next
      ? retained.filter((row) => !rows.has(row.instance))
      : [],
    coverage:
      kind === "more" && previous?.coverage === "incomplete"
        ? "incomplete"
        : page.coverage,
    fetchedAt:
      kind === "more" && previous
        ? previous.fetchedAt
        : new Date().toISOString(),
  };
}

/** Keep read progress and retained browser snapshots private to Infrastructure. */
export const InventoryStore = signalStore(
  withState(initial),
  withComputed(({ snapshot }) => ({
    rows: computed(() => {
      const value = snapshot();
      return value ? [...value.items, ...value.unrefreshed].sort(compare) : [];
    }),
  })),
  withMethods((store) => {
    const owner = inject(OWNER_SESSION);
    const reader = inject(INVENTORY_READER);
    let current: Read | null = null;
    let pending: Read | null = null;
    let active = false;

    const unsubscribe = owner.onClear(() => {
      current = null;
      pending = null;
      patchState(store, initial);
    });
    inject(DestroyRef).onDestroy(unsubscribe);

    /** Finish a dispatched read before starting work from a reconnected session. */
    async function read(job: Read) {
      if (active) {
        pending = job;
        return;
      }
      active = true;
      const isCurrent = () => current === job;
      try {
        const result = await reader.page(job.after, isCurrent);
        if (!isCurrent() || result.kind === "discarded") {
          return;
        }
        if (result.kind === "success") {
          patchState(store, {
            snapshot: merge(store.snapshot(), result.value, job.kind),
          });
        } else {
          patchState(store, { failure: job });
        }
      } catch {
        if (isCurrent()) {
          patchState(store, { failure: job });
        }
      } finally {
        if (isCurrent()) {
          current = null;
          patchState(store, { loading: null });
        }
        active = false;
        const next = pending;
        pending = null;
        if (next) {
          void read(next);
        }
      }
    }

    /** Issue one explicit read for the authorized session. */
    function start(job: Read) {
      if (!owner.canRead() || store.loading()) {
        return;
      }
      current = job;
      patchState(store, { loading: job.kind, failure: null });
      void read(job);
    }

    return {
      open() {
        if (!store.snapshot() && !store.failure()) {
          start({ kind: "refresh", after: null });
        }
      },
      refresh: () => start({ kind: "refresh", after: null }),
      more() {
        const after = store.snapshot()?.next;
        if (after) {
          start({ kind: "more", after });
        }
      },
      retry() {
        const failure = store.failure();
        if (failure) {
          start(failure);
        }
      },
    };
  }),
);
