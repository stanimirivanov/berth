import type { Operation } from "../src/operation-history/history-reader";

/** Operation on the newest page of the synthetic History results. */
export const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Another operation for selection and cursor scenarios. */
export const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Build a representative retained record with unresolved work. */
export const item = (operation: string): Operation => ({
  operation,
  startedAt: "2026-11-20T06:50:00Z",
  expiresAt: "2026-11-20T10:50:00Z",
  outcome: "needs-reconciliation",
  phase: "cleanup",
  pendingUpload: true,
  cleanupRequested: true,
  objectRemoved: false,
  verdict: "partial",
  budgets: {
    normal: { used: 15, limit: 160 },
    cleanup: { used: 14, limit: 40 },
    monitoring: { used: 0, limit: 20 },
    neon: { used: 7, limit: 100 },
  },
  unresolved: { requests: 1, mutations: 1 },
});
