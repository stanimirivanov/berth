// The live root remains intact; named exports expose its production boundary only to offline tests.

export {
  DefaultRequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
export { makeBucket } from "../../src/providers/oci/bucket.js";
export {
  boundedObjectSdk,
  objectClient,
} from "../../src/providers/oci/client.js";
export {
  makeTrialObject,
  probeIntent,
} from "../../src/providers/oci/trial-object.js";
export { default } from "../../src/trial/live-index.js";
