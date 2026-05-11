const IV_LENGTH = 16;
const KEY_LENGTH = 32;

const getEncryptionKey = (): ArrayBuffer => {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("Missing env var CREDENTIALS_ENCRYPTION_KEY");
  }
  const buffer = new Uint8Array(KEY_LENGTH);
  const encoded = new TextEncoder().encode(key);
  buffer.set(encoded.subarray(0, KEY_LENGTH));
  return buffer.buffer;
};

/**
 * Encrypt a plain object into a hex-encoded string (iv:ciphertext).
 */
export const encryptCredentialData = async (
  data: Record<string, unknown>,
): Promise<string> => {
  const key = getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );

  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: iv.buffer },
    cryptoKey,
    plaintext,
  );

  const ivHex = Buffer.from(iv).toString("hex");
  const dataHex = Buffer.from(encrypted).toString("hex");
  return `${ivHex}:${dataHex}`;
};

/**
 * Decrypt a hex-encoded string (iv:ciphertext) back to a plain object.
 */
export const decryptCredentialData = async (
  encrypted: string,
): Promise<Record<string, unknown>> => {
  const key = getEncryptionKey();
  const [ivHex, dataHex] = encrypted.split(":");
  if (!ivHex || !dataHex) {
    throw new Error("Invalid encrypted credential data format");
  }

  const iv = Buffer.from(ivHex, "hex");
  const encryptedData = Buffer.from(dataHex, "hex");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: iv.buffer },
    cryptoKey,
    encryptedData.buffer,
  );

  return JSON.parse(new TextDecoder().decode(decrypted)) as Record<
    string,
    unknown
  >;
};
