import assert from "node:assert/strict";
import type { HttpRequest } from "oci-common";

/** Independent offline HTTP model; never opens a socket or imports a Berth provider. */
export class OciWire {
  bucket: Record<string, unknown> | undefined;
  object:
    | { bytes: Uint8Array; metadata: Record<string, string>; etag: string }
    | undefined;
  requests: HttpRequest[] = [];
  corrupt = false;
  foreignMetadata = false;
  partialInventory = false;
  rejectDelete = false;
  /** One accepted object deletion loses its response; state survives a new SDK/executor. */
  loseDeleteResponse = false;
  beforePut: () => void = () => {};
  /** Model only the trial's HTTP routes, revisions and opt-in metadata; unknown sends fail without network fallback. */
  async send(request: HttpRequest): Promise<Response> {
    this.requests.push(request);
    const url = new URL(request.uri),
      path = url.pathname;
    assert.equal(
      url.origin,
      "https://objectstorage.eu-frankfurt-1.oraclecloud.com",
    );
    const root = "/n/fixture/b",
      bucketPath = `${root}/berth-00000000000040008000000000000001`;
    if (path === root) {
      if (request.method === "GET")
        return Response.json(this.bucket ? [this.bucket] : []);
      assert.equal(request.method, "POST");
      assert.equal(this.bucket, undefined);
      const body = JSON.parse(String(request.body));
      assert.equal(body.name, "berth-00000000000040008000000000000001");
      assert.equal(body.compartmentId, "ocid1.compartment.oc1..fixture");
      this.bucket = {
        ...body,
        namespace: "fixture",
        id: "ocid1.bucket.oc1..wire",
        etag: "bucket-1",
        metadata: {},
        createdBy: "fixture",
        timeCreated: "2026-01-01T00:00:00Z",
        replicationEnabled: false,
        isReadOnly: false,
      };
      return Response.json(this.bucket, { headers: { etag: "bucket-1" } });
    }
    assert.ok(this.bucket, "A bucket route requires an existing bucket");
    if (path === bucketPath) {
      if (request.method === "DELETE") {
        assert.equal(this.object, undefined);
        assert.equal(request.headers.get("if-match"), this.bucket.etag);
        this.bucket = undefined;
        return new Response(null, { status: 204 });
      }
      assert.equal(request.method, "GET");
      const body = { ...this.bucket };
      if (!url.searchParams.get("fields")?.split(",").includes("autoTiering"))
        delete body.autoTiering;
      return Response.json(body, {
        headers: { etag: String(this.bucket.etag) },
      });
    }
    if (path === `${bucketPath}/o/trial.bin`) {
      if (request.method === "PUT") {
        this.beforePut();
        assert.equal(this.object, undefined);
        assert.equal(request.headers.get("if-none-match"), "*");
        assert.equal(request.headers.get("content-length"), "1048576");
        assert.ok(request.body instanceof Uint8Array);
        assert.equal(request.body.length, 1048576);
        const metadata: Record<string, string> = {};
        request.headers.forEach((v, k) => {
          if (k.startsWith("opc-meta-")) metadata[k] = v;
        });
        this.object = {
          bytes: Uint8Array.from(request.body),
          metadata,
          etag: "object-1",
        };
        return new Response(null, { headers: { etag: "object-1" } });
      }
      assert.ok(this.object);
      if (
        request.method !== "HEAD" &&
        request.headers.get("if-match") !== this.object.etag
      )
        return new Response(null, { status: 412 });
      if (request.method === "DELETE") {
        if (this.rejectDelete) return new Response(null, { status: 412 });
        this.object = undefined;
        if (this.loseDeleteResponse) {
          this.loseDeleteResponse = false;
          throw Error("Offline accepted DELETE response lost");
        }
        return new Response(null, { status: 204 });
      }
      assert.ok(["HEAD", "GET"].includes(request.method));
      const headers = new Headers({
        ...this.object.metadata,
        etag: this.object.etag,
        "content-length": "1048576",
        "storage-tier": "Standard",
        "version-id": "null",
      });
      if (this.foreignMetadata) headers.set("opc-meta-berth-marker", "foreign");
      if (request.method === "HEAD") return new Response(null, { headers });
      const bytes = Uint8Array.from(this.object.bytes);
      if (this.corrupt) bytes[0] = 255;
      return new Response(bytes, { headers });
    }
    assert.equal(request.method, "GET");
    if (path === `${bucketPath}/o`)
      return Response.json({
        objects: this.object
          ? [{ name: "trial.bin", size: 1048576, etag: this.object.etag }]
          : [],
        ...(this.partialInventory ? { nextStartWith: "unseen" } : {}),
      });
    if (path === `${bucketPath}/objectversions`)
      return Response.json({
        items: this.object
          ? [{ name: "trial.bin", versionId: "null", isDeleteMarker: false }]
          : [],
      });
    if (path === `${bucketPath}/retentionRules`)
      return Response.json({ items: [] });
    assert.ok([`${bucketPath}/u`, `${bucketPath}/p`].includes(path));
    return Response.json([]);
  }
}
