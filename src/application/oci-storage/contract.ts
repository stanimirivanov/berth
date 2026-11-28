import type {
  StorageGap,
  StorageReading,
  StorageSnapshot,
} from "../../../ui/contracts/oci-storage.ts";

export type { StorageSnapshot } from "../../../ui/contracts/oci-storage.ts";
export { storageAllowance } from "../../../ui/contracts/oci-storage.ts";

/** One refresh returns qualified or provisional evidence, or an explicit gap. */
export type StorageEvidence =
  | { gap: null | "accounting-cutoff-unverified"; reading: StorageReading }
  | { gap: Exclude<StorageGap, "accounting-cutoff-unverified">; reading: null };

/** The storage adapter owns slot admission and monotonic result settlement. */
export interface StorageRepository {
  read(): Promise<StorageSnapshot>;
  claim(attemptedAt: string): Promise<boolean>;
  finish(attemptedAt: string, evidence: StorageEvidence): Promise<void>;
}

/** The scheduled collector obtains one bounded evidence outcome for the configured tenancy. */
export type StorageCollector = () => Promise<StorageEvidence>;
