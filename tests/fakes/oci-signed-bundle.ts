// The live root remains intact; named exports expose its production boundary only to offline tests.

export {
  DefaultRequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
export { makeBucket } from "../../src/providers/oci/bucket.ts";
export {
  boundedObjectSdk,
  objectClient,
} from "../../src/providers/oci/client.ts";
export {
  makeTrialObject,
  probeIntent,
} from "../../src/providers/oci/trial-object.ts";
export { default } from "../../src/trial/live-index.ts";
