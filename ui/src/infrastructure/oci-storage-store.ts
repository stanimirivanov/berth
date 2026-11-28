import { computed, DestroyRef, effect, inject } from "@angular/core";
import {
  patchState,
  signalStore,
  withComputed,
  withMethods,
  withState,
} from "@ngrx/signals";
import type { StorageSnapshot } from "../../contracts/oci-storage";
import { OWNER_SESSION } from "../owner-access/owner-session";
import { type CollectionView, monthlyMeterView } from "./oci-allowance-model";
import { readOciStorage } from "./oci-storage-data-access";

/** Storage evidence belongs to the current Infrastructure visit and owner session. */
interface State {
  snapshot: StorageSnapshot | null;
  loading: boolean;
  unavailable: boolean;
  _clock: number;
}

const initial: State = {
  snapshot: null,
  loading: false,
  unavailable: false,
  _clock: 0,
};

/** Let Infrastructure read storage without changing the inventory list or hosting usage. */
export const OciStorageStore = signalStore(
  withState(initial),
  withComputed(({ snapshot, _clock, unavailable }) => {
    const expiry = computed(() => {
      const stamp = snapshot()?.reading?.expiresAt;
      return stamp ? Date.parse(stamp) : Infinity;
    });
    const pendingDeadline = computed(() => {
      const stamp = snapshot()?.provenance?.pending?.overdueAt;
      return stamp ? Date.parse(stamp) : Infinity;
    });
    const collection = computed<CollectionView | null>(() => {
      const attempt = snapshot()?.provenance?.pending;
      if (!attempt) {
        return null;
      }
      if (attempt.startedAt === null) {
        return { status: "unknown", previousObservationStale: true };
      }
      if (_clock() >= pendingDeadline()) {
        return { status: "overdue", previousObservationStale: true };
      }
      return {
        status: "pending",
        previousObservationStale: attempt.previousObservationStale === true,
      };
    });
    return {
      expired: computed(() => _clock() >= expiry()),
      collection,
      monthly: computed(() => {
        const evidence = snapshot()?.monthly;
        const context = {
          now: _clock(),
          unavailable: unavailable(),
          previousObservationStale:
            collection()?.previousObservationStale === true,
        };
        return {
          requests: monthlyMeterView("requests", evidence?.requests, context),
          outbound: monthlyMeterView("outbound", evidence?.outbound, context),
        };
      }),
      nextDeadline: computed(() =>
        Math.min(
          ...[
            expiry(),
            pendingDeadline(),
            Date.parse(snapshot()?.monthly?.requests.reading?.expiresAt ?? ""),
            Date.parse(snapshot()?.monthly?.outbound.reading?.expiresAt ?? ""),
          ].filter((value) => value > _clock()),
        ),
      ),
    };
  }),
  withMethods((store) => {
    const owner = inject(OWNER_SESSION);
    let generation = 0;

    const unsubscribe = owner.onClear(() => {
      generation++;
      patchState(store, initial);
    });
    inject(DestroyRef).onDestroy(() => {
      generation++;
      unsubscribe();
    });

    effect((onCleanup) => {
      const deadline = store.nextDeadline();
      if (!Number.isFinite(deadline)) {
        return;
      }
      let timer: ReturnType<typeof setTimeout>;

      /** Re-arm the same deadline when a bounded delay or clock change wakes the timer early. */
      function schedule(now: number) {
        const delay = Math.min(2_147_483_647, Math.max(0, deadline - now));
        timer = setTimeout(() => {
          const clock = Date.now();
          patchState(store, { _clock: clock });
          if (clock < deadline) {
            schedule(clock);
          }
        }, delay);
      }

      schedule(Date.now());
      onCleanup(() => clearTimeout(timer));
    });

    return {
      /** Read saved evidence and ignore responses from an obsolete session or visit. */
      async refresh() {
        if (!owner.canRead() || store.loading()) {
          return;
        }
        const attempt = ++generation;
        const isCurrent = () => attempt === generation;
        patchState(store, { loading: true });
        const result = await readOciStorage(owner, isCurrent);
        if (isCurrent()) {
          patchState(store, {
            snapshot:
              result.kind === "success" ? result.value : store.snapshot(),
            unavailable: result.kind !== "success",
            loading: false,
            _clock: Date.now(),
          });
        }
      },
    };
  }),
);
