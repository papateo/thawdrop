// Password-protects a share by encrypting the actual file bytes client-side
// (AES-GCM, key derived from the password via PBKDF2) before they're ever
// seeded over WebTorrent. This matters because the share link is a public
// magnet URI: without real encryption, "password protection" would only be
// a UI gate that anyone pulling the magnet with a plain torrent client could
// skip entirely. The password itself must be communicated out-of-band (it is
// never part of the link/QR) — only the salt and IV, which aren't secret,
// travel inside the encrypted container.
//
// Container layout (all multi-byte integers little-endian):
//   [4 bytes]  magic "ICE1"
//   [16 bytes] PBKDF2 salt
//   [12 bytes] AES-GCM IV
//   [...]      AES-GCM ciphertext (includes its 16-byte auth tag) of:
//                [4 bytes]  header length
//                [N bytes]  JSON header: { files: [{ name, type, size }] }
//                [...]      concatenated raw file bytes, in header order

const MAGIC = new Uint8Array([0x49, 0x43, 0x45, 0x31]); // "ICE1"
const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 250_000;

async function deriveKey(password, salt, usage) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

/**
 * Bundles `files` (an array of File/Blob-like objects with .name, .type,
 * .arrayBuffer()) into a single encrypted container File, named `share.icenet`.
 * Whatever container name/type the network sees, only the password can
 * recover the real file names and bytes.
 */
export async function encryptFiles(files, password) {
  const fileBuffers = await Promise.all(files.map((f) => f.arrayBuffer()));

  const header = JSON.stringify({
    files: files.map((f, i) => ({
      name: f.name,
      type: f.type || 'application/octet-stream',
      size: fileBuffers[i].byteLength,
    })),
  });
  const headerBytes = new TextEncoder().encode(header);

  const plain = new Uint8Array(4 + headerBytes.byteLength + fileBuffers.reduce((sum, b) => sum + b.byteLength, 0));
  new DataView(plain.buffer).setUint32(0, headerBytes.byteLength, true);
  plain.set(headerBytes, 4);
  let offset = 4 + headerBytes.byteLength;
  for (const buf of fileBuffers) {
    plain.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt, 'encrypt');
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));

  const out = new Uint8Array(MAGIC.length + SALT_LEN + IV_LEN + cipher.byteLength);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.length);
  out.set(iv, MAGIC.length + SALT_LEN);
  out.set(cipher, MAGIC.length + SALT_LEN + IV_LEN);

  return new File([out], 'share.icenet', { type: 'application/octet-stream' });
}

/** Cheap check (no password needed) for whether a downloaded blob is one of our encrypted containers. */
export async function isEncryptedContainer(blob) {
  if (blob.size < MAGIC.length) return false;
  const head = new Uint8Array(await blob.slice(0, MAGIC.length).arrayBuffer());
  return MAGIC.every((b, i) => head[i] === b);
}

/**
 * Reverses `encryptFiles`. Throws (with a message safe to show the user) if
 * the password is wrong or the container is corrupt.
 */
export async function decryptFiles(blob, password) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let offset = MAGIC.length;
  const salt = bytes.slice(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = bytes.slice(offset, offset + IV_LEN);
  offset += IV_LEN;
  const cipher = bytes.slice(offset);

  const key = await deriveKey(password, salt, 'decrypt');
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher));
  } catch {
    throw new Error('Incorrect password.');
  }

  const headerLen = new DataView(plain.buffer, plain.byteOffset, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(plain.slice(4, 4 + headerLen)));

  let pos = 4 + headerLen;
  return header.files.map((meta) => {
    const data = plain.slice(pos, pos + meta.size);
    pos += meta.size;
    return new File([data], meta.name, { type: meta.type });
  });
}
