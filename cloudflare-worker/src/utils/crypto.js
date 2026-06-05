export async function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const receivedHex = signatureHeader.slice("sha256=".length);

  if (receivedHex.length !== 64) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedBuffer = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = new Uint8Array(expectedBuffer);
  const received = hexToUint8Array(receivedHex);

  return timingSafeEqual(expected, received);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

function hexToUint8Array(hex) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

export function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

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

export async function createGitHubAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(appId),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem) {
  const der = pemToDer(privateKeyPem);

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

function wrapPkcs1RsaPrivateKeyAsPkcs8(pkcs1DerBuffer) {
  const pkcs1 = new Uint8Array(pkcs1DerBuffer);

  const version = new Uint8Array([0x02, 0x01, 0x00]);

  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);

  const privateKeyOctetString = concatBytes(
    new Uint8Array([0x04]),
    derLength(pkcs1.length),
    pkcs1
  );

  const privateKeyInfoBody = concatBytes(
    version,
    rsaAlgorithmIdentifier,
    privateKeyOctetString
  );

  return concatBytes(
    new Uint8Array([0x30]),
    derLength(privateKeyInfoBody.length),
    privateKeyInfoBody
  ).buffer;
}

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
