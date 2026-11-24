import { computed, InjectionToken, signal } from "@angular/core";
import { isOperationId } from "../operation-id";

/** Browser access to retained records from a single owner session. */
type AccessStatus =
  | "signed-out"
  | "invalid"
  | "unverified"
  | "verified"
  | "unauthorized"
  | "forbidden";

/** An outcome safe to hand to the feature that issued the read. */
export type OwnerRead<T> =
  | { kind: "success"; value: T }
  | { kind: "missing" | "unavailable" | "discarded" };

const historyDetail = "/api/history/";

/** Accept only canonical relative paths to the same-origin protected reads. */
function protectedPath(path: string) {
  const { pathname, search } = new URL(path, "https://berth.invalid");
  return (
    pathname + search === path &&
    (pathname === "/api/history" ||
      pathname === "/api/inventory" ||
      (pathname.startsWith(historyDetail) &&
        !search &&
        isOperationId(pathname.slice(historyDetail.length))))
  );
}

/** Shell-owned credentials and invalidation for protected reads in one tab. */
export function createOwnerSession(
  send: typeof fetch = (input, init) => fetch(input, init),
) {
  let token: string | null = null;
  let generation = 0;
  const state = signal<AccessStatus>("signed-out");
  const clearListeners = new Set<() => void>();
  const status = state.asReadonly();
  const canRead = computed(
    () => status() === "unverified" || status() === "verified",
  );

  /** Admit a locally valid token without treating it as server-verified. */
  function connect(value: string) {
    if (token !== null || status() === "forbidden") {
      return false;
    }
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
      state.set("invalid");
      return false;
    }
    token = value;
    state.set("unverified");
    return true;
  }

  /** Clear this token and every consumer's protected state. */
  function disconnect() {
    clear("signed-out");
  }

  /** Register a synchronous consumer reset and return its unsubscribe function. */
  function onClear(reset: () => void) {
    clearListeners.add(reset);
    return () => {
      clearListeners.delete(reset);
    };
  }

  /** Keep denials session-wide and discard obsolete data before verification.
   * Consumers invalidate their pending identities in onClear and recheck their
   * request identity before applying the returned result.
   */
  async function read<T>(
    path: string,
    decode: (body: unknown) => T,
    isCurrent: () => boolean,
  ): Promise<OwnerRead<T>> {
    const readToken = token;
    const epoch = generation;
    const current = () => epoch === generation && isCurrent();
    if (readToken === null || !current()) {
      return { kind: "discarded" };
    }

    try {
      if (!protectedPath(path)) {
        return { kind: "unavailable" };
      }
      const response = await send(path, {
        method: "GET",
        headers: { authorization: `Bearer ${readToken}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (
        epoch === generation &&
        (response.status === 401 || response.status === 403)
      ) {
        clear(response.status === 401 ? "unauthorized" : "forbidden");
      }
      if (!current() || !response.ok) {
        void response.body?.cancel().catch(() => {});
        if (!current()) {
          return { kind: "discarded" };
        }
        return { kind: response.status === 404 ? "missing" : "unavailable" };
      }

      const body: unknown = await response.json();
      if (!current()) {
        return { kind: "discarded" };
      }
      const value = decode(body);
      if (!current()) {
        return { kind: "discarded" };
      }
      state.set("verified");
      return { kind: "success", value };
    } catch {
      return { kind: current() ? "unavailable" : "discarded" };
    }
  }

  /** Invalidate credentials before clearing request identities and snapshots. */
  function clear(status: "signed-out" | "unauthorized" | "forbidden") {
    generation++;
    token = null;
    state.set(status);
    for (const reset of clearListeners) {
      try {
        reset();
      } catch {
        // Continue clearing the remaining consumers after a reset failure.
      }
    }
  }

  return { status, canRead, connect, disconnect, onClear, read };
}

/** One owner session is provided by the shell for its routed features. */
export const OWNER_SESSION = new InjectionToken<
  ReturnType<typeof createOwnerSession>
>("Owner session");
