import { validTimestamp } from "../../observation-time";
import { isOperationId } from "../../operation-id";

/** Retry credentials have a namespace distinct from retained History tokens. */
export function validRetryCredential(value: string): boolean {
  return /^berth-retry-owner-v1\.[A-Za-z0-9_-]{43,86}$/.test(value);
}

/** Keep signed action sessions in memory and require the advertised expiry to match the bearer. */
export function retrySession(raw: unknown): { token: string; expires: number } {
  if (typeof raw !== "object" || raw === null) {
    throw Error();
  }
  const { session, expiresAt } = raw as {
    session?: unknown;
    expiresAt?: unknown;
  };
  if (typeof session !== "string" || !validTimestamp(expiresAt)) {
    throw Error();
  }
  const match = /^brr1\.([0-9]{13})\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.exec(
    session,
  );
  if (!match || Date.parse(expiresAt) !== Number(match[1])) {
    throw Error();
  }
  // The server verifies signed expiry. Use a local monotonic cap so wall-clock
  // skew cannot prevent sign-in or extend how long the tab keeps credentials.
  return { token: session, expires: performance.now() + 300000 };
}

/** Send one bodyless same-origin request for a closed Retry action vocabulary. */
export function retryRequest(
  action: "sign-in" | "status" | "reconciliation" | "start" | "approve",
  credential: string,
  signal: AbortSignal,
  operation: string,
  proposal?: string,
): Promise<Response> {
  if (
    !isOperationId(operation) ||
    (action === "approve" && (!proposal || !isOperationId(proposal)))
  ) {
    throw Error();
  }
  const root = `/api/retry/operations/${operation}`;
  const path = {
    "sign-in": "/api/retry/session",
    status: `${root}/continuation`,
    reconciliation: root,
    start: root,
    approve: `${root}/proposals/${proposal}/approve`,
  }[action];
  return fetch(path, {
    method: action === "status" || action === "reconciliation" ? "GET" : "POST",
    headers: { authorization: `Bearer ${credential}` },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(32000)]),
  });
}
