import { makeLiveHandler } from "./live-hosted.ts";
import { executeLive, executeLiveAdmission } from "./live-runtime.ts";

/** Separate live root: imports perform no SQL, signing, deployment or provider requests. */
export default makeLiveHandler(
  process.env,
  executeLive,
  Date.now,
  executeLiveAdmission,
);
