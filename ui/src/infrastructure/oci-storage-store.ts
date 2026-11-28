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
import { readOciStorage } from "./oci-storage-data-access";

/** Storage evidence belongs to the current Infrastructure visit and owner session. */
interface State {
  snapshot: StorageSnapshot | null;
  loading: boolean;
  unavailable: boolean;
  clock: number;
}

const initial: State = {
  snapshot: null,
  loading: false,
  unavailable: false,
  clock: 0,
};

/** Let Infrastructure read storage without changing the inventory list or hosting usage. */
export const OciStorageStore = signalStore(
  withState(initial),
  withComputed(({ snapshot, clock }) => {
    const expiry = computed(() => {
      const reading = snapshot()?.reading;
      return reading ? Date.parse(reading.expiresAt) : null;
    });
    return {
      expiry,
      expired: computed(() => {
        const deadline = expiry();
        return deadline !== null && clock() >= deadline;
      }),
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
      const expiry = store.expiry();
      if (expiry === null || store.clock() >= expiry) {
        return;
      }
      const delay = Math.min(2_147_483_647, Math.max(0, expiry - Date.now()));
      const timer = setTimeout(
        () => patchState(store, { clock: Date.now() }),
        delay,
      );
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
            clock: Date.now(),
          });
        }
      },
    };
  }),
);
