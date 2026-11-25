import type { HistoryDetail } from "../../src/application/history/contract.ts";

/** Synthetic retained record whose execution window has expired. */
export const historyRecord = {
  operation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  startedAt: "2020-01-01T00:00:00Z",
  expiresAt: "2020-01-01T04:00:00Z",
  outcome: "succeeded",
  phase: "cleanup",
  pendingUpload: false,
  cleanupRequested: true,
  objectRemoved: true,
  verdict: "partial",
  budgets: {
    normal: { used: 3, limit: 160 },
    cleanup: { used: 2, limit: 40 },
    monitoring: { used: 0, limit: 20 },
    neon: { used: 1, limit: 40 },
  },
  unresolved: { requests: 0, mutations: 0 },
} satisfies HistoryDetail;
