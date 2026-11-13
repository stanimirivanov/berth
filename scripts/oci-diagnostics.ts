import { open } from "node:fs/promises";
import { join } from "node:path";
import { OciSetupError } from "./oci-access.js";

export class OciUserRejection extends OciSetupError {
  constructor(
    readonly diagnostic: {
      httpStatus: number;
      body: string;
      truncated: boolean;
    },
  ) {
    super(
      "CreateUser (HTTP 400) was rejected. No retry. Keep the journal and inspect create-user-error.json privately if saved; never post the full diagnostic.",
    );
  }
}

/** Retain only a bounded body, with no response/request headers or credentials. */
export async function captureUserRejection(
  response: Response,
): Promise<OciUserRejection> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.byteLength, 16384 - size);
        chunks.push(value.subarray(0, take));
        size += take;
        if (size === 16384) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    // Fatal decoding rejects malformed UTF-8; streaming drops a truncated final character.
    const body = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
      { stream: true },
    );
    return new OciUserRejection({ httpStatus: 400, body, truncated });
  } catch {
    return new OciUserRejection({
      httpStatus: 400,
      body: "[response body unavailable]",
      truncated: true,
    });
  } finally {
    reader?.releaseLock();
  }
}

/** Caller supplies an already validated, private bootstrap directory. Never overwrite evidence. */
export async function saveUserRejection(
  output: string,
  error: unknown,
): Promise<void> {
  if (!(error instanceof OciUserRejection)) return;
  const file = await open(join(output, "create-user-error.json"), "wx", 0o600);
  try {
    await file.writeFile(
      `${JSON.stringify({ capturedAt: new Date().toISOString(), ...error.diagnostic }, null, 2)}\n`,
    );
    await file.sync();
  } finally {
    await file.close();
  }
  const dir = await open(output, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
