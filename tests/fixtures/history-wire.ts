import { historyRecord } from "./history-record.ts";

const postgresRecord = {
  ...historyRecord,
  startedAt: "2020-01-01T02:00:00.123456+02:00",
  phase: null,
  budgets: {
    ...historyRecord.budgets,
    cleanup: { used: 40, limit: 40 },
  },
};
const pastBudget = {
  ...historyRecord.budgets,
  normal: { used: 161, limit: 160 },
};

/** Successful detail payloads shared by the History producer and browser tests. */
export const acceptedHistoryDetails = [historyRecord, postgresRecord];

/** Successful list payloads include the empty page and the maximum bounded size. */
export const acceptedHistoryPages = [
  { items: [], next: null },
  { items: [postgresRecord], next: null },
  {
    items: Array.from({ length: 50 }, (_, index) => ({
      ...historyRecord,
      operation: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    })),
    next: "aaaaaaaa-aaaa-4aaa-8aaa-000000000049",
  },
];

/** Malformed detail payloads that must also fail when read as list items. */
export const rejectedHistoryDetails = {
  "noncanonical operation": { ...historyRecord, operation: "not-a-uuid" },
  "wrong UUID version": {
    ...historyRecord,
    operation: "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
  },
  "impossible calendar date": {
    ...historyRecord,
    startedAt: "2020-02-31T00:00:00Z",
  },
  "missing timezone": { ...historyRecord, expiresAt: "2020-01-01T04:00:00" },
  "non-string timestamp": {
    ...historyRecord,
    startedAt: [historyRecord.startedAt],
  },
  "spent above limit": { ...historyRecord, budgets: pastBudget },
  "zero limit": {
    ...historyRecord,
    budgets: { ...pastBudget, normal: { used: 0, limit: 0 } },
  },
  "negative spend": {
    ...historyRecord,
    budgets: { ...pastBudget, normal: { used: -1, limit: 160 } },
  },
  "fractional spend": {
    ...historyRecord,
    budgets: { ...pastBudget, normal: { used: 1.5, limit: 160 } },
  },
  "negative unresolved count": {
    ...historyRecord,
    unresolved: { requests: -1, mutations: 0 },
  },
  "mutations exceed requests": {
    ...historyRecord,
    unresolved: { requests: 1, mutations: 2 },
  },
  "unsafe integer count": {
    ...historyRecord,
    unresolved: { requests: Number.MAX_SAFE_INTEGER + 1, mutations: 0 },
  },
  "unsafe budget limit": {
    ...historyRecord,
    budgets: {
      ...historyRecord.budgets,
      normal: { used: 0, limit: Number.MAX_SAFE_INTEGER + 1 },
    },
  },
};

/** Invalid page envelopes independently exercise cursor and size checks. */
export const rejectedHistoryPages = {
  "noncanonical cursor": { items: [historyRecord], next: "not-a-uuid" },
  "missing cursor": { items: [historyRecord] },
  "overlong page": {
    items: Array.from({ length: 51 }, () => historyRecord),
    next: null,
  },
};
