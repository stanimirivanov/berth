import { computed, DestroyRef, DOCUMENT, effect, inject } from "@angular/core";
import {
  patchState,
  signalStore,
  withComputed,
  withMethods,
  withProps,
  withState,
} from "@ngrx/signals";
import { OWNER_SESSION } from "../owner-access/owner-session";
import {
  readUsageSnapshot,
  usageFileLimit,
  usageTargetFingerprint,
} from "./hosting-usage-contract";
import type { UsageState } from "./hosting-usage-model";
import {
  applyUsageSnapshot,
  failedUsageImport,
  hostingUsageRows,
  usageExpiresAt,
} from "./hosting-usage-model";

/** State owned by the verified tab, with a clock for reading expiry. */
interface State {
  snapshot: UsageState | null;
  clock: number;
  status: "idle" | "loading" | "loaded" | "failed";
}

/** Keep imports and expiry independent of the History and Inventory workflows. */
export const UsageStore = signalStore(
  withState<State>({ snapshot: null, clock: 0, status: "idle" }),
  withProps(() => {
    const tags = inject(DOCUMENT).head.querySelectorAll<HTMLMetaElement>(
      'meta[name="berth-usage-target"]',
    );
    const target = tags.item(0)?.content;
    const expectedTarget =
      tags.length === 1 && usageTargetFingerprint(target) ? target : null;
    return {
      _expectedTarget: expectedTarget,
      targetConfigured: expectedTarget !== null,
    };
  }),
  withComputed(({ snapshot, clock }) => ({
    rows: computed(() => hostingUsageRows(snapshot(), clock())),
  })),
  withMethods((store) => {
    const owner = inject(OWNER_SESSION);
    const document = inject(DOCUMENT);
    let attempt = 0;

    const unsubscribe = owner.onClear(() => {
      attempt++;
      patchState(store, { snapshot: null, clock: 0, status: "idle" });
    });
    inject(DestroyRef).onDestroy(unsubscribe);

    effect((onCleanup) => {
      const expiries = store
        .rows()
        .flatMap((row) =>
          row.status === "Current" && row.reading
            ? [usageExpiresAt(row.reading)]
            : [],
        );
      if (!expiries.length) {
        return;
      }
      const timer = setTimeout(
        () => patchState(store, { clock: Date.now() }),
        Math.max(0, Math.min(...expiries) - Date.now()),
      );
      onCleanup(() => clearTimeout(timer));
    });

    return {
      async refresh(file: File) {
        if (
          !store._expectedTarget ||
          owner.status() !== "verified" ||
          store.status() === "loading"
        ) {
          return;
        }
        const job = ++attempt;
        patchState(store, { status: "loading" });
        try {
          if (file.size > usageFileLimit) {
            throw Error();
          }
          const body: unknown = JSON.parse(await file.text());
          if (job !== attempt) {
            return;
          }
          const clock = Date.now();
          const snapshot = readUsageSnapshot(
            body,
            document.location.origin,
            clock,
          );
          if (snapshot.target !== store._expectedTarget) {
            throw Error();
          }
          patchState(store, {
            snapshot: applyUsageSnapshot(store.snapshot(), snapshot),
            clock,
            status: "loaded",
          });
        } catch {
          if (job === attempt) {
            patchState(store, {
              snapshot: failedUsageImport(store.snapshot()),
              clock: Date.now(),
              status: "failed",
            });
          }
        }
      },
    };
  }),
);
