/**
 * Inspect authenticated controls for zero bytes, never trusting Content-Length.
 * Stop at the first payload byte, after eight reads, on abort, or after one second.
 * Rejected input is cancelled best-effort without awaiting an untrusted cancel hook;
 * read/lock failures deny admission and never expose their underlying error.
 */
export async function emptyControl(request: Request): Promise<boolean> {
  if (request.signal.aborted) return false;
  if (!request.body) return true;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  let empty = false;
  try {
    reader = request.body.getReader();
    const input = reader;
    const stopped = new Promise<false>((resolve) => {
      stop = () => resolve(false);
      timer = setTimeout(stop, 1000);
      request.signal.addEventListener("abort", stop, { once: true });
      if (request.signal.aborted) stop();
    });
    /** Stop on payload or the read-count cap; only EOF proves an empty stream. */
    const inspect = async () => {
      for (let reads = 0; reads < 8; reads++) {
        const chunk = await input.read();
        if (chunk.done) return true;
        if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > 0)
          return false;
      }
      return false;
    };
    empty = await Promise.race([inspect(), stopped]);
    return empty && !request.signal.aborted;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (stop) request.signal.removeEventListener("abort", stop);
    if (reader) {
      if (!empty) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
