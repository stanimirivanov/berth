import { makeTrialApi, type TrialApiOptions } from "./api.js";
import { executorStore } from "./executor-store.js";
import { type LedgerDatabase, makeLedger } from "./ledger.js";
/** Compose admission with the same durable ledger and owned cleanup flag consumed by schedules. */
export function executorApi(
  db: LedgerDatabase,
  options: Omit<TrialApiOptions, "ledger" | "admitCleanup">,
) {
  const configuration = Object.freeze({ ...options.configuration }),
    store = executorStore(db);
  return makeTrialApi({
    ...options,
    configuration,
    ledger: makeLedger(db),
    admitCleanup: async (operation) => {
      const record = await store.report(operation);
      if (
        !record ||
        record.trial.compartment !== configuration.compartment ||
        record.trial.namespace !== configuration.namespace ||
        record.trial.region !== configuration.region
      )
        throw Error("Cleanup target rejected");
      return store.cleanup(operation);
    },
  });
}
