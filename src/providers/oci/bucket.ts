import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  type BucketClient,
  BucketFailure,
  type BucketIntent,
  createProposal,
  type ObservedBucket,
} from "./client.js";

/** Minimal persisted identity, tied to the immutable saved operation and marker. */
export interface BucketAttributes {
  id: string;
  etag: string;
  operation: string;
  marker: string;
}
/** One fixed bucket per saved trial. No update, replacement or arbitrary names. */
interface BucketResource
  extends ResourceLike<
    "Berth.OCI.Bucket",
    { operation: string },
    BucketAttributes,
    never,
    undefined,
    never
  > {}
/** Public Alchemy resource constructor used by the caller's plan/apply lifecycle. */
export const OciBucket = Resource<BucketResource>("Berth.OCI.Bucket");

/** Validate and capture immutable intent before any SDK call; no settings are caller-selectable. */
export function makeBucket(saved: BucketIntent, client: BucketClient) {
  const i = Object.freeze({ ...saved });
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    !uuid.test(i.operation) ||
    !uuid.test(i.marker) ||
    i.bucket !== `berth-${i.operation.replaceAll("-", "")}` ||
    !/^ocid1[.]compartment[.]oc1[.][.][A-Za-z0-9]{1,128}$/.test(
      i.compartment,
    ) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(i.namespace) ||
    i.region !== client.region
  )
    throw new BucketFailure("invalid-intent");
  /** Compare provider identity and every supported security setting, not just name or marker. */
  function verify(
    b: ObservedBucket,
    etag: string,
    known?: BucketAttributes,
  ): BucketAttributes {
    if (
      b.namespace !== i.namespace ||
      b.name !== i.bucket ||
      b.compartmentId !== i.compartment ||
      b.freeformTags?.["berth-operation"] !== i.operation ||
      b.freeformTags?.["berth-marker"] !== i.marker
    )
      throw new BucketFailure("ownership");
    if (!b.id || !/^ocid1[.]bucket[.]/.test(b.id) || !etag || b.etag !== etag)
      throw new BucketFailure("revision");
    if (
      known &&
      (known.id !== b.id ||
        known.operation !== i.operation ||
        known.marker !== i.marker)
    )
      throw new BucketFailure("ownership");
    if (
      b.publicAccessType !== "NoPublicAccess" ||
      b.storageTier !== "Standard" ||
      b.versioning !== "Disabled" ||
      b.autoTiering !== "Disabled" ||
      b.objectEventsEnabled !== false ||
      b.replicationEnabled !== false ||
      b.isReadOnly !== false ||
      b.kmsKeyId ||
      b.isBucketKeyEnabled === true ||
      b.objectLifecyclePolicyEtag
    )
      throw new BucketFailure("configuration");
    return { id: b.id, etag, operation: i.operation, marker: i.marker };
  }
  /** Complete bounded listing is the only absence proof; HTTP errors never mean absent. */
  async function exists(cleanup: boolean) {
    const r = await client.list(i, cleanup);
    if (
      r.opcNextPage ||
      r.items.length > 1 ||
      r.items.some(
        (b) =>
          b.name !== i.bucket ||
          b.namespace !== i.namespace ||
          b.compartmentId !== i.compartment,
      )
    )
      throw new BucketFailure("collision");
    return r.items.length === 1;
  }
  /** Separate retention rules and access grants must be empty, without hidden pagination. */
  async function restrictions(cleanup: boolean) {
    const r = await client.retention(i, cleanup),
      g = await client.grants(i, cleanup);
    if (
      r.opcNextPage ||
      r.retentionRuleCollection.items.length ||
      g.opcNextPage ||
      g.items.length
    )
      throw new BucketFailure("configuration");
  }
  /** Read may establish absence, but never adopts an existing name without saved identity. */
  async function read(known?: BucketAttributes, cleanup = false) {
    if (!(await exists(cleanup))) return undefined;
    const r = await client.get(i, cleanup);
    const value = verify(r.bucket, r.eTag, known);
    if (!known) throw new BucketFailure("identity-unrecorded");
    await restrictions(cleanup);
    return value;
  }
  return {
    /** Pure exact proposal; IAM alone does not enforce private settings or resource count. */
    plan: () => createProposal(i),
    read,
    /** A collision or ambiguous prior create stops here; no automatic adoption or replay. */
    async create() {
      if (await read()) throw new BucketFailure("collision");
      const r = await client.create(i);
      const value = verify(r.bucket, r.eTag);
      await restrictions(false);
      return value;
    },
    /** Delete only a newly inspected empty owned bucket at its unchanged revision. */
    async remove(known: BucketAttributes) {
      const before = await read(known, true);
      if (!before) return;
      const objects = (await client.objects(i)).listObjects;
      const uploads = await client.uploads(i);
      if (
        objects.objects.length ||
        objects.prefixes?.length ||
        objects.nextStartWith ||
        uploads.items.length ||
        uploads.opcNextPage
      )
        throw new BucketFailure("not-empty");
      const latest = await client.get(i, true);
      const current = verify(latest.bucket, latest.eTag, known);
      if (current.etag !== before.etag) throw new BucketFailure("revision");
      await client.remove(i, current.etag);
      if (await exists(true)) throw new BucketFailure("unknown-outcome");
    },
  };
}
/**
 * Public provider API; immutable intent is injected, never read from arbitrary props.
 * Set cleanup for destroy planning/apply: reads use the protected cleanup reserve
 * and reconciliation refuses creation. Ordinary mode never recreates missing state.
 */
export function bucketProvider(
  saved: BucketIntent,
  client: BucketClient,
  cleanup = false,
) {
  const intent = Object.freeze({ ...saved });
  const bucket = makeBucket(intent, client);
  /** Preserve typed safe diagnostics across the Effect boundary. */
  const run = <T>(work: () => Promise<T>) =>
    Effect.tryPromise({
      try: work,
      catch: (error) =>
        error instanceof BucketFailure
          ? error
          : new BucketFailure("unknown-outcome"),
    });
  /** Refuse updates or a different operation before any cloud access. */
  const check = (operation: string) => {
    if (operation !== intent.operation)
      throw new BucketFailure("invalid-intent");
  };
  return Provider.succeed(OciBucket, {
    version: 1,
    read: ({ olds, output }) =>
      run(async () => {
        check(olds.operation);
        const value = await bucket.read(output, cleanup);
        if (output && !value && !cleanup) throw new BucketFailure("ownership");
        return value;
      }),
    reconcile: ({ news, output }) =>
      run(async () => {
        check(news.operation);
        if (cleanup) throw new BucketFailure("invalid-intent");
        if (output) {
          const value = await bucket.read(output);
          if (!value) throw new BucketFailure("ownership");
          return value;
        }
        return bucket.create();
      }),
    delete: ({ olds, output, force }) =>
      run(async () => {
        check(olds.operation);
        if (force) throw new BucketFailure("invalid-intent");
        await bucket.remove(output);
      }),
  });
}
