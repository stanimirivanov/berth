import { type BaseRequest, NoRetryConfigurationDetails } from "oci-common";
import { models as model, type requests } from "oci-objectstorage";
import type {
  BucketAction,
  BucketIntent,
  BucketSdk,
  BudgetedDispatcher,
  ObjectSdk,
} from "../../src/providers/oci/client.js";
export const intent: BucketIntent = {
  operation: "00000000-0000-4000-8000-000000000001",
  marker: "00000000-0000-4000-8000-000000000002",
  bucket: "berth-00000000000040008000000000000001",
  compartment: "ocid1.compartment.oc1..fixture",
  namespace: "fixture",
  region: "eu-frankfurt-1",
};
export function dispatcher() {
  const calls: BucketAction[] = [];
  return {
    calls,
    async dispatch<T>(
      action: BucketAction,
      send: () => Promise<T>,
    ): Promise<T> {
      calls.push(action);
      return send();
    },
  } satisfies BudgetedDispatcher & { calls: BucketAction[] };
}
export class FakeOci implements BucketSdk {
  endpoint = "";
  value: model.Bucket | undefined;
  creates = 0;
  deletes = 0;
  failure: number | undefined;
  deleteFailure: number | undefined;
  objects: string[] = [];
  retention: unknown[] = [];
  uploads: unknown[] = [];
  grants: unknown[] = [];
  page: string | undefined;
  changeDuringEmptyCheck = false;
  lastIfMatch: string | undefined;
  calls: { method: string; noRetry: boolean; input: unknown }[] = [];
  record(method: string, input: BaseRequest) {
    this.calls.push({
      method,
      noRetry: input.retryConfiguration === NoRetryConfigurationDetails,
      input,
    });
    if (this.failure)
      throw { statusCode: this.failure, message: "private-canary" };
  }
  async listBuckets(r: requests.ListBucketsRequest) {
    this.record("list", r);
    return {
      items: this.value ? [this.value] : [],
      ...(this.page ? { opcNextPage: this.page } : {}),
    };
  }
  async getBucket(r: requests.GetBucketRequest) {
    this.record("get", r);
    if (!this.value) throw { statusCode: 404 };
    return { bucket: structuredClone(this.value), eTag: this.value.etag };
  }
  async createBucket(r: requests.CreateBucketRequest) {
    this.record("create", r);
    this.creates++;
    this.value = {
      namespace: r.namespaceName,
      name: r.createBucketDetails.name,
      compartmentId: r.createBucketDetails.compartmentId,
      metadata: {},
      createdBy: "fixture",
      timeCreated: new Date("2026-01-01"),
      etag: "etag-1",
      id: "ocid1.bucket.oc1..fixture",
      publicAccessType: model.Bucket.PublicAccessType.NoPublicAccess,
      storageTier: model.Bucket.StorageTier.Standard,
      versioning: model.Bucket.Versioning.Disabled,
      autoTiering: model.Bucket.AutoTiering.Disabled,
      objectEventsEnabled: false,
      replicationEnabled: false,
      isReadOnly: false,
      freeformTags: r.createBucketDetails.freeformTags ?? {},
    };
    return { bucket: structuredClone(this.value), eTag: this.value.etag };
  }
  async deleteBucket(r: requests.DeleteBucketRequest) {
    this.record("delete", r);
    this.deletes++;
    this.lastIfMatch = r.ifMatch;
    if (this.deleteFailure)
      throw { statusCode: this.deleteFailure, message: "private-canary" };
    if (r.ifMatch !== this.value?.etag) throw { statusCode: 412 };
    if (this.objects.length) throw { statusCode: 409 };
    this.value = undefined;
    return {};
  }
  async listRetentionRules(r: requests.ListRetentionRulesRequest) {
    this.record("retention", r);
    return { retentionRuleCollection: { items: this.retention } };
  }
  async listObjects(
    r: requests.ListObjectsRequest,
  ): ReturnType<BucketSdk["listObjects"]> {
    this.record("objects", r);
    if (this.changeDuringEmptyCheck && this.value) this.value.etag = "etag-2";
    return { listObjects: { objects: this.objects } };
  }
  async listMultipartUploads(r: requests.ListMultipartUploadsRequest) {
    this.record("uploads", r);
    return { items: this.uploads };
  }
  async listPreauthenticatedRequests(
    r: requests.ListPreauthenticatedRequestsRequest,
  ) {
    this.record("grants", r);
    return { items: this.grants };
  }
}

export class FakeObjects extends FakeOci {
  object:
    | { meta: Record<string, string>; body: Uint8Array; etag: string }
    | undefined;
  puts = 0;
  objectDeletes = 0;
  losePut = false;
  replaceOnDelete = false;
  extra = false;
  versions = false;
  corrupt = false;
  oversized = false;
  beforePut: () => void = () => {};
  lastPut: requests.PutObjectRequest | undefined;
  lastDelete: requests.DeleteObjectRequest | undefined;
  override async listObjects(r: requests.ListObjectsRequest) {
    this.record("object-list", r);
    return {
      listObjects: {
        objects: [
          ...(this.object ? [{ name: "trial.bin" }] : []),
          ...(this.extra ? [{ name: "foreign" }] : []),
        ],
      },
    };
  }
  async listObjectVersions(r: requests.ListObjectVersionsRequest) {
    this.record("versions", r);
    return {
      objectVersionCollection: {
        items: this.versions
          ? [
              {
                name: "trial.bin",
                versionId: "historic",
                isDeleteMarker: false,
              },
            ]
          : [],
      },
    };
  }
  async putObject(r: requests.PutObjectRequest) {
    this.record("put", r);
    this.beforePut();
    this.puts++;
    this.lastPut = r;
    if (r.ifNoneMatch !== "*" || this.object) throw { statusCode: 412 };
    if (!(r.putObjectBody instanceof Uint8Array)) throw Error("fixture body");
    this.object = {
      body: Uint8Array.from(r.putObjectBody),
      meta: { ...r.opcMeta },
      etag: "object-1",
    };
    if (this.losePut) throw { statusCode: 500 };
    return { eTag: this.object.etag };
  }
  async headObject(r: requests.HeadObjectRequest) {
    this.record("head", r);
    if (!this.object) throw { statusCode: 404 };
    return {
      eTag: this.object.etag,
      opcMeta: Object.fromEntries(
        Object.entries(this.object.meta).map(([key, value]) => [
          `opc-meta-${key}`,
          value,
        ]),
      ),
      contentLength: 1048576,
      storageTier: "Standard",
    };
  }
  async getObject(
    r: requests.GetObjectRequest,
  ): ReturnType<ObjectSdk["getObject"]> {
    this.record("get-object", r);
    if (!this.object) throw { statusCode: 404 };
    if (r.ifMatch !== this.object.etag) throw { statusCode: 412 };
    const bytes = this.oversized
      ? new Uint8Array(1048577)
      : Uint8Array.from(this.object.body);
    if (this.corrupt) bytes[0] = 255;
    return {
      eTag: this.object.etag,
      opcMeta: Object.fromEntries(
        Object.entries(this.object.meta).map(([key, value]) => [
          `opc-meta-${key}`,
          value,
        ]),
      ),
      contentLength: 1048576,
      storageTier: "Standard",
      value: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }
  async deleteObject(r: requests.DeleteObjectRequest) {
    this.record("delete-object", r);
    this.objectDeletes++;
    this.lastDelete = r;
    if (this.replaceOnDelete && this.object) this.object.etag = "replacement";
    if (r.ifMatch !== this.object?.etag) throw { statusCode: 412 };
    this.object = undefined;
    return {};
  }
}
