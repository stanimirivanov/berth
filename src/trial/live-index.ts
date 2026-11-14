import { makeLiveHandler } from "./live-hosted.js";
import { executeLive } from "./live-runtime.js";

/** Separate live root: imports perform no SQL, signing, deployment or provider requests. */
export default makeLiveHandler(process.env, executeLive);
