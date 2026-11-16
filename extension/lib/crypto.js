// Optional end-to-end encryption for everything stored on the WebDAV server.
// AES-256-GCM, key derived from a passphrase with PBKDF2-SHA256 (600k iterations).
// A random salt + a known-plaintext check value live in keyinfo.json on the server,
// so every browser derives the same key and a wrong passphrase is detected.
import { b64encode, b64decode } from './util.js';

const MAGIC = new TextEncoder().encode('DDE1');
const ITER = 600000;
const CHECK = 'dialdeck-key-check';

export async function deriveKey(passphrase, saltB64, iterations = ITER) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64decode(saltB64), iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function isEncrypted(buf) {
  const b = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf);
  return b.length > 4 && MAGIC.every((m, i) => b[i] === m);
}

export async function encrypt(key, data) {
  const plain = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(4 + 12 + ct.length);
  out.set(MAGIC, 0); out.set(iv, 4); out.set(ct, 16);
  return out.buffer;
}

export async function decrypt(key, buf) {
  const b = new Uint8Array(buf);
  if (!isEncrypted(b)) throw new Error('Data is not encrypted');
  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(4, 16) }, key, b.slice(16));
  } catch {
    throw new Error('Decryption failed — wrong passphrase?');
  }
}

export async function newKeyInfo(passphrase) {
  const salt = b64encode(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(passphrase, salt);
  const check = b64encode(await encrypt(key, CHECK));
  return { info: { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt, check }, key };
}

export async function keyFromInfo(passphrase, info) {
  const key = await deriveKey(passphrase, info.salt, info.iter || ITER);
  const plain = new TextDecoder().decode(await decrypt(key, b64decode(info.check).buffer));
  if (plain !== CHECK) throw new Error('Wrong passphrase');
  return key;
}
