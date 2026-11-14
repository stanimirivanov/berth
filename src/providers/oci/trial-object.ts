import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { type BucketAttributes, makeBucket } from "./bucket.js";
import {
  BucketFailure,
  type BucketIntent,
  type ObjectClient,
  type ObjectObservation,
} from "./client.js";

/** Public precommitted intent; never accepts arbitrary names, bytes or digests. */
export interface ProbeIntent extends BucketIntent {
  objectName: "trial.bin";
  digest: string;
}
/** Persisted provider revision and intended digest; checksum success still requires read(). */
export interface ProbeReceipt {
  bucketId: string;
  etag: string;
  digest: string;
}
/** Durable owner stores intent before upload and every observed provider revision. */
export interface ProbeJournal {
  /** Commit immutable intent before dispatch; failed persistence must prevent upload. */
  saveIntent(intent: ProbeIntent): Promise<void>;
  /** Commit PUT identity before GET and verified reads before success; must be fenced/idempotent. */
  saveReceipt(receipt: ProbeReceipt): Promise<void>;
}
/** Rehydrated evidence from durable storage; pending denotes a previously committed upload intent. */
export interface ProbeRecord {
  intent: ProbeIntent;
  bucket: BucketAttributes;
  pending?: boolean;
  receipt?: ProbeReceipt;
}
/** Exactly 1 MiB, each byte is its offset modulo 256; returns a fresh buffer. */
export function probeContent(): Uint8Array {
  return Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 256);
}
/** Produce the intent to persist; no cloud access or caller-defined payload. */
export function probeIntent(bucket: BucketIntent): ProbeIntent {
  return {
    ...bucket,
    objectName: "trial.bin",
    digest: createHash("sha256").update(probeContent()).digest("hex"),
  };
}
/**
 * Bounded fixed-object lifecycle. Journal and dispatcher must be durable/fenced;
 * a pending absent upload is never replayed. All failures stop for reconciliation.
 */
export function makeTrialObject(
  record: ProbeRecord,
  client: ObjectClient,
  journal: ProbeJournal,
) {
  const i = Object.freeze({ ...record.intent }),
    ownedBucket = Object.freeze({ ...record.bucket });
  const bucket = makeBucket(i, client.bucket);
  if (i.objectName !== "trial.bin" || i.digest !== probeIntent(i).digest)
    throw new BucketFailure("invalid-intent");
  let pending = record.pending === true,
    known = record.receipt ? { ...record.receipt } : undefined;
  if (
    known &&
    (known.bucketId !== ownedBucket.id ||
      known.digest !== i.digest ||
      !known.etag)
  )
    throw new BucketFailure("ownership");
  /** Complete authenticated inventories; absence never comes from a failed GET. */
  async function inventory(cleanup: boolean, checkBucket = true) {
    if (checkBucket && !(await bucket.read(ownedBucket, cleanup)))
      throw new BucketFailure("ownership");
    const listing = (await client.list(i, cleanup)).listObjects;
    if (
      listing.nextStartWith ||
      listing.prefixes?.length ||
      listing.objects.length > 1 ||
      listing.objects.some((o) => o.name !== i.objectName)
    )
      throw new BucketFailure("collision");
    const history = await client.versions(i, cleanup),
      uploads = await client.uploads(i, cleanup);
    if (
      history.opcNextPage ||
      history.objectVersionCollection.prefixes?.length ||
      history.objectVersionCollection.items.length > 1 ||
      history.objectVersionCollection.items.some(
        (v) =>
          v.name !== i.objectName || v.isDeleteMarker || v.versionId !== "null",
      ) ||
      uploads.items.length ||
      uploads.opcNextPage
    )
      throw new BucketFailure("configuration");
    if (!listing.objects.length && history.objectVersionCollection.items.length)
      throw new BucketFailure("configuration");
    return listing.objects.length === 1;
  }
  /** Metadata is necessary, never sufficient: the stream checksum is also required. */
  function validate(o: ObjectObservation, etag?: string) {
    if (
      !o.eTag ||
      (etag && o.eTag !== etag) ||
      (known && o.eTag !== known.etag)
    )
      throw new BucketFailure("revision");
    if (
      o.opcMeta?.["berth-operation"] !== i.operation ||
      o.opcMeta?.["berth-marker"] !== i.marker ||
      o.opcMeta?.["berth-sha256"] !== i.digest
    )
      throw new BucketFailure("ownership");
    if (
      o.contentLength !== 1048576 ||
      o.opcMultipartMd5 ||
      (o.versionId && o.versionId !== "null") ||
      o.storageTier !== "Standard"
    )
      throw new BucketFailure("configuration");
  }
  /** Consume at most 1 MiB; cancel both Node and Web streams on any failure. */
  async function observe(cleanup: boolean) {
    if (!pending && !known) throw new BucketFailure("identity-unrecorded");
    // A durable revision already pins cleanup GET; HEAD adds no identity evidence.
    // Normal reads retain HEAD, and uncertain uploads need it to discover a revision.
    let etag = cleanup ? known?.etag : undefined;
    if (!etag) {
      const head = await client.head(i, i.objectName, cleanup);
      validate(head);
      etag = head.eTag;
    }
    const response = await client
      .get(i, i.objectName, etag, cleanup)
      .catch((error: unknown) => {
        if (error instanceof BucketFailure && error.code === "precondition")
          throw new BucketFailure("revision");
        throw error;
      });
    const reader = (
      response.value instanceof Readable
        ? Readable.toWeb(response.value)
        : response.value
    ).getReader();
    try {
      validate(response, etag);
      let count = 0;
      const hash = createHash("sha256");
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array))
          throw new BucketFailure("checksum");
        count += chunk.value.length;
        if (count > 1048576) throw new BucketFailure("checksum");
        hash.update(chunk.value);
      }
      if (count !== 1048576 || hash.digest("hex") !== i.digest)
        throw new BucketFailure("checksum");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const receipt = {
      bucketId: ownedBucket.id,
      etag,
      digest: i.digest,
    };
    await journal.saveReceipt(receipt);
    known = receipt;
    return receipt;
  }
  /** Prevent raw journal/stream exceptions from escaping into receipts or logs. */
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof BucketFailure
        ? error
        : new BucketFailure("unknown-outcome");
    }
  }
  return {
    /** Persist before create-only PUT; repeated or pending attempts only observe. */
    upload: () =>
      safe(async () => {
        if (await inventory(false)) return observe(false);
        if (pending || known) throw new BucketFailure("unknown-outcome");
        await journal.saveIntent(i);
        pending = true;
        const result = await client.put(
          i,
          i.objectName,
          probeContent(),
          i.digest,
        );
        if (!result.eTag) throw new BucketFailure("revision");
        known = {
          bucketId: ownedBucket.id,
          etag: result.eTag,
          digest: i.digest,
        };
        await journal.saveReceipt(known);
        return observe(false);
      }),
    /** Read only an existing owned revision; never creates on missing or unauthorized reads. */
    read: () =>
      safe(async () => {
        if (!(await inventory(false)))
          throw new BucketFailure("unknown-outcome");
        return observe(false);
      }),
    /** Verify bytes, optionally settle a positively reconciled upload, then conditionally delete and prove absence. */
    remove: (beforeDelete?: (receipt: ProbeReceipt) => Promise<void>) =>
      safe(async () => {
        // Inventory and checksum are read-only. Defer the bucket identity/settings
        // check until after those reads and any reconciliation callback, immediately
        // before DELETE. Repeating it before GET spends recovery's cleanup reserve.
        // Empty inventories still require the saved bucket identity before returning.
        if (!(await inventory(true, false))) {
          if (!(await bucket.read(ownedBucket, true)))
            throw new BucketFailure("ownership");
          return;
        }
        const receipt = await observe(true);
        await beforeDelete?.(receipt);
        if (!(await inventory(true)))
          throw new BucketFailure("unknown-outcome");
        await client.remove(i, i.objectName, receipt.etag);
        // DELETE followed the full fresh ownership/configuration check above.
        // Prove object/version/upload absence here; bucket teardown independently
        // rechecks bucket ownership and restrictions before its own conditional DELETE.
        if (await inventory(true, false))
          throw new BucketFailure("unknown-outcome");
      }),
  };
}
