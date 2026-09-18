/**
 * A UUID derived from a string, not drawn at random.
 *
 * For rows whose identity is a FACT about the work rather than a value the
 * writer invents — a workflow run's steering message for turn N, for instance:
 * there is exactly one of those, and a retried turn must land on the same row
 * rather than appending a second one. With a deterministic id the existing
 * `saveMessage` upsert absorbs the replay in place, keeping the row's `seq`
 * and `created_at`, and no caller has to remember to look for a duplicate
 * first.
 *
 * `Bun.CryptoHasher("sha256")`, never `Bun.hash`: the id is persisted and
 * compared across processes and releases, and `Bun.hash` guarantees neither a
 * stable seed nor a stable algorithm across versions. The bits are laid out as
 * a version-5 UUID (RFC 9562 §5.5) so the value is a well-formed UUID
 * everywhere it travels — the `uuid` column, a log line, a URL.
 */

export const deterministicUuid = (seed: string): string => {
  const bytes = new Bun.CryptoHasher("sha256").update(seed).digest();
  // Version 5 (name-based, SHA-1 by the letter of the spec; the layout is what
  // consumers check) and the RFC 4122 variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
