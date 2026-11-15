/** Select a complete, stable slice of discovered semantic labels, never silently an empty one.
 * Unsharded local runs preserve discovery order. A point filter remains available only
 * for local diagnosis; combining it with a shard or using it in CI would hide coverage.
 * Sorting before modulo assignment makes ownership independent of discovery order.
 */
export function recoverySites(
  labels: string[],
  shard: string | undefined,
  point?: string,
  ci = false,
): string[] {
  if (new Set(labels).size !== labels.length || labels.length === 0)
    throw Error("Expected nonempty unique recovery labels");
  if (point !== undefined) {
    if (ci || shard !== undefined || !labels.includes(point))
      throw Error("Invalid or CI-forbidden recovery point filter");
    return [point];
  }
  if (shard === undefined) return labels;
  const match = /^([1-4])\/([1-4])$/.exec(shard);
  if (!match)
    throw Error("Expected recovery shard index/count, each 1 through 4");
  const index = Number(match[1]),
    count = Number(match[2]);
  if (index > count) throw Error("Recovery shard index exceeds count");
  const selected = [...labels].sort().filter((_, n) => n % count === index - 1);
  if (!selected.length) throw Error("Empty recovery shard");
  return selected;
}
