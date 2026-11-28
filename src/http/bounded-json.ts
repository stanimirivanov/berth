/** Race a single asynchronous step with the encompassing deadline and release its listener. */
export async function untilAborted<T>(
  signal: AbortSignal,
  action: () => T | Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([action(), cancelled]);
  } finally {
    if (stop) signal.removeEventListener("abort", stop);
  }
}

/** Parse a small JSON stream under its caller's deadline. Cancel incomplete streams without waiting. */
export async function boundedJson(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  if (!body) throw Error("JSON body required");
  const reader = body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let offset = 0;
  try {
    for (let chunks = 0; chunks < 128; chunks++) {
      const part = await untilAborted(signal, () => reader.read());
      if (part.done)
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, offset),
          ),
        );
      if (part.value.byteLength > bytes.length - offset)
        throw Error("JSON body exceeds limit");
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    throw Error("JSON body exceeds chunk limit");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
