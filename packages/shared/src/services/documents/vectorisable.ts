/**
 * Should this document be indexed for retrieval at all?
 *
 * Almost always yes, and the guard is deliberately narrow because of it. The
 * extraction writes a usable summary for nearly everything it touches —
 * including spreadsheets of bare numbers, which it describes even when it
 * cannot read meaning into them. The documents worth skipping are the ones it
 * could make NOTHING of: a scan that failed, a blank page, an encrypted file
 * that yielded no text.
 *
 * DELIBERATELY NOT A MODEL CALL. The only signal that separates those cases
 * is the length of the summary the pipeline already produced, and a length is
 * a length — asking a decision model would be paying for a verdict an `if`
 * already renders, and adding a timeout, a fail-open path and a journal line
 * to a question that has none of the ambiguity those exist for.
 *
 * Skipping matters twice over: an unreadable document in the index is a row
 * the semantic arm can return instead of a real answer, and every chunk of it
 * is an embedding paid for.
 */

/**
 * Below this, the extraction found nothing to say. Well under the
 * pre-extract prompt's own target (3-5 sentences, under 500 characters), so
 * only a summary that failed rather than one that was terse lands here.
 */
const MIN_SUMMARY_CHARS = 40;

/**
 * And below this, it did not trust what it found. Self-assessed, nullable,
 * and `null` means "would not assess" — which is NOT low confidence and must
 * never be read as it, the same rule the model registry applies to an absent
 * signal.
 */
const MIN_CONFIDENCE = 0.1;

export interface VectorisabilityInput {
  /**
   * Required, and the asymmetry with the field below is deliberate: omitting
   * the summary would skip EVERY document, so it has to be impossible to
   * forget. Omitting the confidence only makes the guard more lenient, which
   * is the direction a mistake should fall.
   */
  documentSummary: string | null | undefined;
  confidenceScore?: number | null | undefined;
}

/** Why a document was not indexed, or null when it was. */
export const vectorisationSkipReason = (
  input: VectorisabilityInput,
): string | null => {
  const summary = input.documentSummary?.trim() ?? "";
  if (summary.length < MIN_SUMMARY_CHARS) {
    return `extraction produced no usable summary (${summary.length.toString()} chars)`;
  }
  if (
    input.confidenceScore !== null &&
    input.confidenceScore !== undefined &&
    input.confidenceScore < MIN_CONFIDENCE
  ) {
    return `extraction confidence ${input.confidenceScore.toFixed(2)} is below ${MIN_CONFIDENCE.toString()}`;
  }
  return null;
};
