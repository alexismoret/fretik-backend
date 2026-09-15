import { timingSafeEqual } from "node:crypto";

/**
 * Verify that a webhook body really came from our Nango instance.
 *
 * The route this guards is unauthenticated by necessity — Nango carries no
 * session and no API key of ours — so the signature IS the authentication.
 * Anyone who can reach the URL can otherwise claim any connection was
 * deleted, and the only thing that costs an attacker is the request.
 */

/**
 * The header we check, and the reason it is not the other one.
 *
 * Nango sends TWO signatures on every delivery. `X-Nango-Signature` is
 * `sha256(secret + payload)` — a bare hash of a concatenation, which its own
 * source comments call "vulnerable to length-extension attacks", because SHA-2
 * is a Merkle-Damgård construction and an attacker who has one valid
 * (payload, digest) pair can append to the payload and compute the new digest
 * without ever knowing the secret. `X-Nango-Hmac-Sha256` is a real HMAC and
 * has no such property. They are sent side by side for backwards
 * compatibility; there is no reason to accept the weak one.
 */
export const NANGO_HMAC_HEADER = "x-nango-hmac-sha256";

/**
 * The signing key, which is NOT `NANGO_SECRET_KEY`.
 *
 * Nango keeps them separate — Environment Settings → Webhooks → Signing key,
 * beside but distinct from the API secret key — and its docs call out the
 * confusion by name, because signing with the wrong one fails verification on
 * every environment where the two differ, which is all of them.
 *
 * Throwing rather than returning `undefined` is deliberate: a missing secret
 * must never degrade into "accept everything". The caller runs this per
 * request, so a misconfigured deployment refuses webhooks loudly instead of
 * trusting them silently.
 */
export const getNangoWebhookSecret = (): string => {
  const secret = Bun.env.NANGO_WEBHOOK_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("NANGO_WEBHOOK_SECRET env var must be set");
  }
  return secret;
};

/**
 * Is `signature` the HMAC-SHA256 of `rawBody` under `secret`?
 *
 * `rawBody` must be the bytes as received. Nango signs the output of its own
 * `stringifyStable`, so a body that has been parsed and re-serialised is a
 * different string — different key order, different whitespace — and will not
 * verify even though it holds the same data. The route therefore reads
 * `c.req.text()` and parses only after this returns true.
 */
export const verifyNangoWebhookSignature = (params: {
  rawBody: string;
  signature: string | undefined;
  secret: string;
}): boolean => {
  if (params.signature === undefined || params.signature === "") return false;

  const expected = new Bun.CryptoHasher("sha256", params.secret)
    .update(params.rawBody)
    .digest("hex");

  // `timingSafeEqual` THROWS on a length mismatch, which would leak length
  // through an exception and turn a malformed header into a 500. Compare
  // lengths first, then the bytes in constant time.
  const received = Buffer.from(params.signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (received.length !== computed.length) return false;
  return timingSafeEqual(received, computed);
};
