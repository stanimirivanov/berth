import { type HttpClient, NoRetryConfigurationDetails } from "oci-common";
import {
  models as model,
  ObjectStorageClient,
  type requests,
} from "oci-objectstorage";

/** Saved public intent; credentials and owner/admin identities never enter resource state. */
export interface BucketIntent {
  operation: string;
  marker: string;
  bucket: string;
  compartment: string;
  namespace: string;
  region: string;
}
/** Only these ledger actions may be charged by this provider. */
export type BucketAction =
  | "inspect"
  | "inspect_cleanup"
  | "create_bucket"
  | "delete_bucket";
/**
 * Integration contract: reserve and commit before invoking send exactly once.
 * A missing/duplicate reservation must not invoke send. Keep ambiguous mutations
 * unresolved; disable transport retries and persist definite outcomes separately.
 */
export interface BudgetedDispatcher {
  /** One callback invocation is one underlying SDK request, never a pagination loop. */
  dispatch<T>(action: BucketAction, send: () => Promise<T>): Promise<T>;
}
/** Structural subset of the pinned SDK, injectable without cloud credentials. */
export interface BucketSdk {
  endpoint: string;
  /** One bounded compartment page; an incomplete inventory is rejected. */
  listBuckets(request: requests.ListBucketsRequest): Promise<{
    items: Pick<model.BucketSummary, "name" | "namespace" | "compartmentId">[];
    opcNextPage?: string;
  }>;
  /** Metadata and response revision must agree. */
  getBucket(
    request: requests.GetBucketRequest,
  ): Promise<{ bucket: model.Bucket; eTag: string }>;
  /** Create returns a provider identity; no update/adoption API is exposed. */
  createBucket(
    request: requests.CreateBucketRequest,
  ): Promise<{ bucket: model.Bucket; eTag: string }>;
  /** Revision-bound deletion; the service must reject a nonempty bucket. */
  deleteBucket(request: requests.DeleteBucketRequest): Promise<unknown>;
  /** Retention is a separate resource, not inferred from bucket defaults. */
  listRetentionRules(request: requests.ListRetentionRulesRequest): Promise<{
    retentionRuleCollection: { items: unknown[] };
    opcNextPage?: string;
  }>;
  /** A single object is enough to forbid deletion; no bulk deletion exists. */
  listObjects(request: requests.ListObjectsRequest): Promise<{
    listObjects: {
      objects: unknown[];
      prefixes?: string[];
      nextStartWith?: string;
    };
  }>;
  /** Outstanding multipart work also forbids deletion. */
  listMultipartUploads(
    request: requests.ListMultipartUploadsRequest,
  ): Promise<{ items: unknown[]; opcNextPage?: string }>;
  /** Preauthenticated grants are unexpected even on a private bucket. */
  listPreauthenticatedRequests(
    request: requests.ListPreauthenticatedRequestsRequest,
  ): Promise<{ items: unknown[]; opcNextPage?: string }>;
}
/** Safe categories only; never carry SDK response bodies, URLs or credentials. */
export type BucketFailureCode =
  | "invalid-intent"
  | "forbidden"
  | "unavailable"
  | "precondition"
  | "collision"
  | "ownership"
  | "configuration"
  | "identity-unrecorded"
  | "not-empty"
  | "revision"
  | "unknown-outcome"
  | "budget";
/** Compatible with Alchemy's public ProviderError contract. */
export class BucketFailure extends Error {
  readonly _tag = "BucketFailure";
  /** Fixed code is both the public diagnostic and log-safe message. */
  constructor(readonly code: BucketFailureCode) {
    super(code);
  }
}
/** Exact private Standard proposal; absence of a KMS key selects Oracle-managed encryption. */
export function createProposal(i: BucketIntent): requests.CreateBucketRequest {
  return {
    namespaceName: i.namespace,
    createBucketDetails: {
      compartmentId: i.compartment,
      name: i.bucket,
      publicAccessType:
        model.CreateBucketDetails.PublicAccessType.NoPublicAccess,
      storageTier: model.CreateBucketDetails.StorageTier.Standard,
      versioning: model.CreateBucketDetails.Versioning.Disabled,
      autoTiering: "Disabled",
      objectEventsEnabled: false,
      freeformTags: {
        "berth-operation": i.operation,
        "berth-marker": i.marker,
      },
    },
  };
}
/** All network entry points pass through a mandatory dispatcher and per-request no-retry configuration. */
export function bucketClient(
  sdk: BucketSdk,
  dispatcher: BudgetedDispatcher,
  homeRegion: string,
) {
  if (!/^[a-z]{2}-[a-z]+-[1-9]$/.test(homeRegion))
    throw new BucketFailure("invalid-intent");
  const endpoint = `https://objectstorage.${homeRegion}.oraclecloud.com`;
  sdk.endpoint = endpoint;
  /** Catch only after the dispatcher has observed the original transport result for its journal. */
  async function send<T>(
    action: BucketAction,
    work: () => Promise<T>,
  ): Promise<T> {
    let invoked = false;
    try {
      return await dispatcher.dispatch(action, async () => {
        if (invoked || sdk.endpoint !== endpoint)
          throw new BucketFailure("budget");
        invoked = true;
        return work();
      });
    } catch (error) {
      if (error instanceof BucketFailure) throw error;
      const status =
        error && typeof error === "object" && "statusCode" in error
          ? error.statusCode
          : undefined;
      throw new BucketFailure(
        status === 403 || status === 401
          ? "forbidden"
          : status === 412
            ? "precondition"
            : status === 409
              ? "collision"
              : action === "create_bucket" || action === "delete_bucket"
                ? "unknown-outcome"
                : "unavailable",
      );
    }
  }
  const retryConfiguration = NoRetryConfigurationDetails;
  return {
    region: homeRegion,
    /** Never use an automatic SDK paginator: each request needs its own reservation. */
    list: (i: BucketIntent, cleanup = false) =>
      send(cleanup ? "inspect_cleanup" : "inspect", () =>
        sdk.listBuckets({
          namespaceName: i.namespace,
          compartmentId: i.compartment,
          limit: 2,
          retryConfiguration,
        }),
      ),
    /** Fetch one revision in the pinned namespace. */
    get: (i: BucketIntent, cleanup = false) =>
      send(cleanup ? "inspect_cleanup" : "inspect", () =>
        sdk.getBucket({
          namespaceName: i.namespace,
          bucketName: i.bucket,
          retryConfiguration,
        }),
      ),
    /** Read at most one rules response; any rule or continuation blocks the trial. */
    retention: (i: BucketIntent, cleanup = false) =>
      send(cleanup ? "inspect_cleanup" : "inspect", () =>
        sdk.listRetentionRules({
          namespaceName: i.namespace,
          bucketName: i.bucket,
          retryConfiguration,
        }),
      ),
    /** Reject any object instead of sweeping unexpected contents. */
    objects: (i: BucketIntent) =>
      send("inspect_cleanup", () =>
        sdk.listObjects({
          namespaceName: i.namespace,
          bucketName: i.bucket,
          limit: 1,
          retryConfiguration,
        }),
      ),
    /** Outstanding uploads must be reconciled outside this provider. */
    uploads: (i: BucketIntent) =>
      send("inspect_cleanup", () =>
        sdk.listMultipartUploads({
          namespaceName: i.namespace,
          bucketName: i.bucket,
          limit: 1,
          retryConfiguration,
        }),
      ),
    /** Grants are checked without attempting their removal. */
    grants: (i: BucketIntent, cleanup = false) =>
      send(cleanup ? "inspect_cleanup" : "inspect", () =>
        sdk.listPreauthenticatedRequests({
          namespaceName: i.namespace,
          bucketName: i.bucket,
          limit: 1,
          retryConfiguration,
        }),
      ),
    /** Create carries the saved marker; the caller must preserve uncertain completion. */
    create: (i: BucketIntent) =>
      send("create_bucket", () =>
        sdk.createBucket({ ...createProposal(i), retryConfiguration }),
      ),
    /** The inspected ETag is mandatory; never retry without it. */
    async remove(i: BucketIntent, etag: string) {
      if (!etag.trim()) throw new BucketFailure("revision");
      return send("delete_bucket", () =>
        sdk.deleteBucket({
          namespaceName: i.namespace,
          bucketName: i.bucket,
          ifMatch: etag,
          retryConfiguration,
        }),
      );
    },
  };
}
/** Budgeted client port shared with the pure lifecycle owner. */
export type BucketClient = ReturnType<typeof bucketClient>;
/** Pinned SDK's observed bucket shape, never a credential container. */
export type ObservedBucket = model.Bucket;

/**
 * Construct the production SDK with an injected single-send signed transport.
 * Strip error bodies before the SDK retrier can log them. The caller owns closing
 * the client, must disable transport retries and must not install OCI debug loggers.
 * Transport failures remain ambiguous; no original exception or response is logged.
 */
export function safeBucketSdk(transport: HttpClient): ObjectStorageClient {
  return new ObjectStorageClient(
    {
      httpClient: {
        /** Strip rejected response details before SDK error construction; never replay. */
        async send(...args) {
          try {
            const response = await transport.send(...args);
            if (response.ok) return response;
            await response.body?.cancel();
            return new Response(
              JSON.stringify({
                code: "ProviderRejected",
                message: "OCI request failed",
              }),
              {
                status: response.status,
                headers: { "content-type": "application/json" },
              },
            );
          } catch {
            throw new Error("OCI transport failed");
          }
        },
      },
    },
    { retryConfiguration: NoRetryConfigurationDetails },
  );
}
