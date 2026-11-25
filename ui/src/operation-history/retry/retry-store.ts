import { DestroyRef, inject } from "@angular/core";
import { patchState, signalStore, withMethods, withState } from "@ngrx/signals";
import { OWNER_SESSION } from "../../owner-access/owner-session";
import {
  canCheckProvider,
  continuationProcedure,
  type RetryStatus,
  reconciliationStop,
  retryStatus,
} from "./retry-contract";
import {
  retryRequest,
  retrySession,
  validRetryCredential,
} from "./retry-data-access";

type Notice =
  | "invalid"
  | "denied"
  | "forbidden"
  | "session-expired"
  | "unavailable"
  | "result-unknown"
  | "proposal-changed";
const initial = {
  opened: false,
  authenticated: false,
  busy: null as "reading" | "checking" | "approving" | null,
  notice: null as Notice | null,
  snapshot: null as RetryStatus | null,
};

/** One panel owns the short-lived action session, one request at a time, and the latest validated status. */
export const RetryStore = signalStore(
  withState(initial),
  withMethods((store) => {
    let session: ReturnType<typeof retrySession> | undefined;
    let active: AbortController | undefined;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let proposalTimer: ReturnType<typeof setTimeout> | undefined;

    /** Drop the session and invalidate in-flight responses synchronously. */
    function clear(notice: Notice | null = null) {
      active?.abort();
      active = undefined;
      session = undefined;
      clearTimeout(sessionTimer);
      clearTimeout(proposalTimer);
      patchState(store, { ...initial, opened: notice !== null, notice });
    }

    const unsubscribe = inject(OWNER_SESSION).onClear(() => clear());
    inject(DestroyRef).onDestroy(() => {
      unsubscribe();
      clear();
    });

    /** Expiry removes authorization controls while keeping a clear status and guidance. */
    function expireProposal(operation: string) {
      patchState(store, {
        snapshot: {
          operation,
          stage: "needs-attention",
          reason: "proposal-expired",
          ownerProcedure: continuationProcedure,
        },
      });
    }

    /** Keep an unapproved proposal visible only while its displayed deadline is current. */
    function publish(snapshot: RetryStatus) {
      clearTimeout(proposalTimer);
      if (snapshot.stage === "waiting-for-approval") {
        const delay = Date.parse(snapshot.approveBy) - Date.now();
        if (delay <= 0) {
          expireProposal(snapshot.operation);
          return;
        }
        proposalTimer = setTimeout(() => {
          expireProposal(snapshot.operation);
        }, delay);
      }
      patchState(store, { snapshot });
    }

    /** Run one action or read. Ambiguous writes always leave only the read recovery control. */
    async function run(
      busy: NonNullable<typeof initial.busy>,
      work: (request: AbortController) => Promise<void>,
    ) {
      if (active) {
        return;
      }
      const request = new AbortController();
      active = request;
      clearTimeout(proposalTimer);
      patchState(store, { busy, snapshot: null, notice: null });
      try {
        await work(request);
      } catch {
        if (active === request) {
          patchState(store, {
            snapshot: null,
            notice: busy === "reading" ? "unavailable" : "result-unknown",
          });
        }
      } finally {
        if (active === request) {
          active = undefined;
          patchState(store, { busy: null });
        }
      }
    }

    /** Follow only the current leased browser request, clearing action data on either denial. */
    async function send(
      request: AbortController,
      action: Parameters<typeof retryRequest>[0],
      operation: string,
      credential: string,
      proposal?: string,
    ) {
      const response = await retryRequest(
        action,
        credential,
        request.signal,
        operation,
        proposal,
      );
      if (active !== request) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        clear(response.status === 403 ? "forbidden" : "denied");
        return null;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
      }
      return response;
    }

    /** Get retained continuation first, then the reason from the provider check if needed. */
    async function read(
      request: AbortController,
      operation: string,
      token: string,
    ) {
      const response = await send(request, "status", operation, token);
      if (!response) {
        return;
      }
      if (!response.ok) {
        throw Error();
      }
      const snapshot = retryStatus(await response.json(), operation);
      if (active !== request) {
        return;
      }
      if (
        "reason" in snapshot &&
        snapshot.reason === "reconciliation-stopped"
      ) {
        const detail = await send(request, "reconciliation", operation, token);
        if (!detail) {
          return;
        }
        if (!detail.ok) {
          throw Error();
        }
        const checked = reconciliationStop(await detail.json(), operation);
        if (active === request) {
          publish(checked ?? snapshot);
        }
      } else {
        publish(snapshot);
      }
    }

    /** The timer is a UI aid. Check the session again before every request. */
    function liveToken() {
      if (!session) {
        return null;
      }
      if (session.expires <= performance.now()) {
        clear("session-expired");
        return null;
      }
      return session.token;
    }

    return {
      open() {
        patchState(store, { opened: true });
      },
      close() {
        clear();
      },
      async connect(operation: string, credential: string) {
        if (active || session) {
          return;
        }
        if (!validRetryCredential(credential)) {
          patchState(store, { notice: "invalid" });
          return;
        }
        await run("reading", async (request) => {
          const response = await send(
            request,
            "sign-in",
            operation,
            credential,
          );
          if (!response) {
            return;
          }
          if (!response.ok) {
            throw Error();
          }
          const accepted = retrySession(await response.json());
          if (active !== request) {
            return;
          }
          session = accepted;
          sessionTimer = setTimeout(
            () => clear("session-expired"),
            accepted.expires - performance.now(),
          );
          patchState(store, { authenticated: true });
          await read(request, operation, accepted.token);
        });
      },
      async refresh(operation: string) {
        const token = liveToken();
        if (token) {
          await run("reading", (request) => read(request, operation, token));
        }
      },
      async check(operation: string, originalExpired: boolean) {
        const current = store.snapshot();
        const token = liveToken();
        if (!token || !canCheckProvider(current, originalExpired)) {
          return;
        }
        await run("checking", async (request) => {
          const response = await send(request, "start", operation, token);
          if (!response) {
            return;
          }
          if (!response.ok) {
            throw Error();
          }
          const stopped = reconciliationStop(await response.json(), operation);
          if (active !== request) {
            return;
          }
          if (stopped) {
            publish(stopped);
          } else {
            await read(request, operation, token);
          }
        });
      },
      async approve(operation: string) {
        const current = store.snapshot();
        const token = liveToken();
        if (!token || current?.stage !== "waiting-for-approval") {
          return;
        }
        if (Date.parse(current.approveBy) <= Date.now()) {
          expireProposal(current.operation);
          return;
        }
        await run("approving", async (request) => {
          const response = await send(
            request,
            "approve",
            operation,
            token,
            current.proposal,
          );
          if (!response) {
            return;
          }
          if (response.status === 409) {
            void response.body?.cancel().catch(() => {});
            await read(request, operation, token);
            if (active === request) {
              patchState(store, { notice: "proposal-changed" });
            }
            return;
          }
          if (!response.ok) {
            throw Error();
          }
          const accepted = retryStatus(
            await response.json(),
            operation,
            current.proposal,
          );
          if (active === request) {
            publish(accepted);
          }
        });
      },
    };
  }),
);
