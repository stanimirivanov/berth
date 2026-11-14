import type {
  BucketIntent,
  ObjectSdk,
  ObservedBucket,
} from "../providers/oci/client.js";
import { probeContent, probeIntent } from "../providers/oci/trial-object.js";
/** Two booleans model the proof's external service; no credentials or object bytes are stored. */
export interface SyntheticCloud {
  bucket: boolean;
  object: boolean;
}
/** Database-backed fake service for hosted qualification only; never reaches an OCI endpoint. */
export function syntheticSdk(
  intent: BucketIntent,
  access: (value?: SyntheticCloud) => Promise<SyntheticCloud>,
): ObjectSdk {
  if (
    intent.namespace !== "berthsynthetic" ||
    intent.compartment !== "ocid1.compartment.oc1..synthetic"
  )
    throw Error("Expected synthetic target");
  const metadata = {
    "opc-meta-berth-operation": intent.operation,
    "opc-meta-berth-marker": intent.marker,
    "opc-meta-berth-sha256": probeIntent(intent).digest,
  };
  /** Fixed service identity and private configuration, independently persisted from engine state. */
  const bucket = (): ObservedBucket =>
    ({
      namespace: intent.namespace,
      name: intent.bucket,
      compartmentId: intent.compartment,
      metadata: {},
      createdBy: "synthetic",
      timeCreated: new Date(0),
      id: `ocid1.bucket.oc1..${intent.operation.replaceAll("-", "")}`,
      etag: "synthetic-bucket-1",
      freeformTags: {
        "berth-operation": intent.operation,
        "berth-marker": intent.marker,
      },
      publicAccessType: "NoPublicAccess",
      storageTier: "Standard",
      versioning: "Disabled",
      autoTiering: "Disabled",
      objectEventsEnabled: false,
      replicationEnabled: false,
      isReadOnly: false,
    }) as ObservedBucket;
  /** Fixed headers exercise the real ownership/checksum validation. */
  const headers = () => ({
    eTag: "synthetic-object-1",
    opcMeta: metadata,
    contentLength: 1048576,
    storageTier: "Standard",
  });
  return {
    endpoint: "",
    /** Enumerate only the persisted synthetic bucket. */
    async listBuckets() {
      return { items: (await access()).bucket ? [bucket()] : [] };
    },
    /** Missing synthetic resources are ordinary provider 404s, never implicit absence. */
    async getBucket() {
      if (!(await access()).bucket) throw { statusCode: 404 };
      return { bucket: bucket(), eTag: "synthetic-bucket-1" };
    },
    /** Separate persistence models a provider commit before the caller's state update. */
    async createBucket() {
      const state = await access();
      if (state.bucket) throw { statusCode: 409 };
      await access({ ...state, bucket: true });
      return { bucket: bucket(), eTag: "synthetic-bucket-1" };
    },
    /** Conditional empty-only deletion, including the provider-side emptiness check. */
    async deleteBucket(r) {
      const state = await access();
      if (r.ifMatch !== "synthetic-bucket-1") throw { statusCode: 412 };
      if (state.object) throw { statusCode: 409 };
      await access({ bucket: false, object: false });
      return {};
    },
    /** The fixture has no retention capability. */
    async listRetentionRules() {
      return { retentionRuleCollection: { items: [] } };
    },
    /** Full inventory of the fixed object only. */
    async listObjects() {
      return {
        listObjects: {
          objects: (await access()).object ? [{ name: "trial.bin" }] : [],
        },
      };
    },
    /** No multipart writers are exposed. */
    async listMultipartUploads() {
      return { items: [] };
    },
    /** No preauthenticated grant capability is exposed. */
    async listPreauthenticatedRequests() {
      return { items: [] };
    },
    /** Versioning is always disabled in this fixture. */
    async listObjectVersions() {
      return { objectVersionCollection: { items: [] } };
    },
    /** Reject overwrite and incorrect fixed size before updating the service record. */
    async putObject(r) {
      const state = await access();
      if (!state.bucket || state.object || r.ifNoneMatch !== "*")
        throw { statusCode: 412 };
      if (r.contentLength !== 1048576) throw { statusCode: 400 };
      await access({ ...state, object: true });
      return { eTag: "synthetic-object-1" };
    },
    /** Metadata exactly matches the persisted operation's intent. */
    async headObject() {
      if (!(await access()).object) throw { statusCode: 404 };
      return headers();
    },
    /** Stream the real deterministic payload through the production checksum helper. */
    async getObject(r) {
      if (!(await access()).object) throw { statusCode: 404 };
      if (r.ifMatch !== "synthetic-object-1") throw { statusCode: 412 };
      return {
        ...headers(),
        value: new ReadableStream<Uint8Array>({
          /** Emit one finite deterministic buffer; never access a network service. */
          start(c) {
            c.enqueue(probeContent());
            c.close();
          },
        }),
      };
    },
    /** Revision-bound deletion without a bulk/force path. */
    async deleteObject(r) {
      if (r.ifMatch !== "synthetic-object-1") throw { statusCode: 412 };
      const state = await access();
      await access({ ...state, object: false });
      return {};
    },
  };
}
