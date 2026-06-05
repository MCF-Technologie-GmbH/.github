/**
 * Verifies that a GitHub webhook payload is authentic by checking its HMAC-SHA256 signature.
 *
 * @param {ArrayBuffer} rawBody - The raw binary body of the webhook request.
 * @param {string} signatureHeader - The value of the 'X-Hub-Signature-256' header (e.g. 'sha256=...').
 * @param {string} secret - The GitHub Webhook Secret configured in the GitHub App settings.
 * @returns {Promise<boolean>} Resolves to true if the signature is valid, false otherwise.
 */
export async function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const receivedHex = signatureHeader.slice("sha256=".length);

  // SHA-256 hex signature must be exactly 64 characters long
  if (receivedHex.length !== 64) {
    return false;
  }

  // Import the Webhook secret as an HMAC key
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // Compute the expected HMAC-SHA256 signature over the raw body
  const expectedBuffer = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = new Uint8Array(expectedBuffer);
  const received = hexToUint8Array(receivedHex);

  // Compare using a timing-safe equality check to prevent side-channel attacks
  return timingSafeEqual(expected, received);
}

/**
 * Compares two Uint8Array byte arrays in constant time to prevent timing attacks.
 *
 * @param {Uint8Array} a - First byte array.
 * @param {Uint8Array} b - Second byte array.
 * @returns {boolean} True if they are identical, false otherwise.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i += 1) {
    // Bitwise OR of the XOR difference of each byte.
    // If any byte differs, diff will be non-zero.
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

/**
 * Converts a hexadecimal string into a Uint8Array byte array.
 *
 * @param {string} hex - Hexadecimal string.
 * @returns {Uint8Array} Decoded bytes.
 */
function hexToUint8Array(hex) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

/**
 * Encodes a string value to Base64URL (RFC 4648).
 *
 * @param {string} value - The input string.
 * @returns {string} Base64URL encoded string.
 */
export function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

/**
 * Encodes a Uint8Array of bytes into a Base64URL string.
 * Strips padding '=' characters and replaces '+' with '-' and '/' with '_'.
 *
 * @param {Uint8Array} bytes - The input bytes.
 * @returns {string} Base64URL encoded string.
 */
export function base64UrlEncodeBytes(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Generates a signed JSON Web Token (JWT) for GitHub App authentication.
 * The token has an issuance time (iat) shifted 60s in the past to account for clock drift,
 * and expires in 9 minutes (GitHub App limit is 10 minutes).
 *
 * @param {string|number} appId - The GitHub App ID.
 * @param {string} privateKeyPem - The PEM-formatted RSA private key.
 * @returns {Promise<string>} The signed RS256 JWT.
 */
export async function createGitHubAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: now - 60, // 60 seconds leeway for clock skew
    exp: now + 9 * 60, // Expire in 9 minutes
    iss: String(appId), // Issuer is the GitHub App ID
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importPrivateKey(privateKeyPem);

  // Sign the header + payload using RSASSA-PKCS1-v1_5 (SHA-256)
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

/**
 * Imports a PEM private key into a Web Crypto API CryptoKey object.
 * Automatically handles PKCS#1 keys by wrapping them in a PKCS#8 ASN.1 envelope.
 *
 * @param {string} privateKeyPem - PEM string (PKCS#1 or PKCS#8).
 * @returns {Promise<CryptoKey>} The imported private key for signing.
 */
async function importPrivateKey(privateKeyPem) {
  const der = pemToDer(privateKeyPem);

  // If the PEM starts with "BEGIN RSA PRIVATE KEY", it is in PKCS#1 format.
  // Web Crypto API requires PKCS#8 format for importing private keys.
  const pkcs8Der = privateKeyPem.includes("BEGIN RSA PRIVATE KEY")
    ? wrapPkcs1RsaPrivateKeyAsPkcs8(der)
    : der;

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
}

/**
 * Decodes a PEM-encoded string into a binary DER ArrayBuffer.
 * Removes headers, footers, whitespace, and base64-decodes the payload.
 *
 * @param {string} pem - The PEM-encoded key content.
 * @returns {ArrayBuffer} The raw binary DER.
 */
function pemToDer(pem) {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

/**
 * Wraps a raw PKCS#1 RSA private key DER buffer inside a PKCS#8 ASN.1 structure.
 * This is required because Web Crypto API's importKey only supports PKCS#8 formats.
 *
 * PKCS#8 structure layout:
 * Sequence [
 *   Version (0),
 *   AlgorithmIdentifier [ rsaEncryption (1.2.840.113549.1.1.1), NULL ],
 *   PrivateKey (Octet String containing the PKCS#1 RSA private key)
 * ]
 *
 * @param {ArrayBuffer} pkcs1DerBuffer - Binary PKCS#1 DER bytes.
 * @returns {ArrayBuffer} Binary PKCS#8 DER bytes.
 */
function wrapPkcs1RsaPrivateKeyAsPkcs8(pkcs1DerBuffer) {
  const pkcs1 = new Uint8Array(pkcs1DerBuffer);

  // Version 0
  const version = new Uint8Array([0x02, 0x01, 0x00]);

  // Object Identifier (OID) for rsaEncryption: 1.2.840.113549.1.1.1
  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);

  // Wrap PKCS#1 private key as an ASN.1 Octet String (0x04)
  const privateKeyOctetString = concatBytes(
    new Uint8Array([0x04]),
    derLength(pkcs1.length),
    pkcs1
  );

  // Combine Version, AlgorithmIdentifier, and PrivateKey
  const privateKeyInfoBody = concatBytes(
    version,
    rsaAlgorithmIdentifier,
    privateKeyOctetString
  );

  // Wrap the combined body inside an ASN.1 Sequence (0x30)
  return concatBytes(
    new Uint8Array([0x30]),
    derLength(privateKeyInfoBody.length),
    privateKeyInfoBody
  ).buffer;
}

/**
 * Encodes a length integer into ASN.1 DER length octets.
 * Supports short-form (<= 127 bytes) and long-form lengths.
 *
 * @param {number} length - The length to encode.
 * @returns {Uint8Array} Encoded length bytes.
 */
function derLength(length) {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }

  const bytes = [];
  let value = length;

  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/**
 * Concatenates multiple Uint8Array arrays into a single Uint8Array.
 *
 * @param {...Uint8Array} arrays - The arrays to concatenate.
 * @returns {Uint8Array} The combined array.
 */
function concatBytes(...arrays) {
  const length = arrays.reduce((total, item) => total + item.length, 0);
  const output = new Uint8Array(length);

  let offset = 0;

  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }

  return output;
}
