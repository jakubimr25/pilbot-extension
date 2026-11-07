/**
 * Encryption of the API key at rest, used by the background worker only
 * (provider.js; a trusted extension context: content scripts and pages never
 * import this).
 *
 * The API key is stored in chrome.storage.local only as AES-GCM (256-bit)
 * ciphertext. The key that encrypts it is a WebCrypto CryptoKey created here
 * as non-extractable and kept in this extension's own IndexedDB:
 * - no script can read its bytes (crypto.subtle.exportKey refuses), it can
 *   only be used to encrypt and decrypt inside this extension's origin;
 * - web pages and content scripts cannot open this IndexedDB (it belongs to
 *   chrome-extension://<id>), nor read chrome.storage.local (locked to
 *   trusted contexts by the background worker);
 * - the ciphertext alone, as it sits in chrome.storage.local (or in a copy of
 *   it), is useless.
 * Each ciphertext is bound to a context (additional authenticated data): the
 * origin of the endpoint it was saved for. Decrypting it for another origin
 * fails, so even a tampered endpoint in storage can never receive the key.
 *
 * What this does not do: protect against malware running as the user, which
 * can read the whole Chrome profile (IndexedDB included). Only an OS keychain
 * or a passphrase typed each session would, and neither is available to an
 * extension without a native helper or a worse everyday experience; see
 * DEVELOPMENT.md.
 */

const DATABASE_NAME = 'pilbot-secrets';
const DATABASE_VERSION = 1;
const STORE_NAME = 'keys';
/** The one key in the store: the one that encrypts the provider's API key. */
const KEY_ID = 'provider-api-key';
/** Version of the stored format, so a later change can tell old values apart. */
const FORMAT_VERSION = 1;
/** 96-bit IVs, as recommended for AES-GCM; a fresh random one for every encryption. */
const IV_BYTES = 12;
/** AES-GCM adds a 16-byte tag; anything far bigger than a key plus that is not a stored secret. */
const MAX_CIPHERTEXT_BYTES = 4096;

/**
 * An encrypted secret, as stored in chrome.storage.local.
 * @typedef {object} EncryptedSecret
 * @property {1} v
 * @property {string} iv Base64.
 * @property {string} data Base64 ciphertext with the GCM tag.
 */

/** @type {CryptoKey | null} The key once read or created, for as long as this worker runs. */
let cachedKey = null;
/** Bumped when the key is deleted, so a read that started before never caches the old key. */
let keyGeneration = 0;

const encoder = new TextEncoder();

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * @param {unknown} text
 * @param {number} maxBytes
 * @returns {Uint8Array | null} null when it is not base64 or too long.
 */
function fromBase64(text, maxBytes) {
  if (typeof text !== 'string' || text.length > Math.ceil(maxBytes / 3) * 4) {
    return null;
  }
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** @returns {Promise<IDBDatabase>} */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The key store is blocked.'));
  });
}

/**
 * Runs one transaction on the key store and resolves with what `run` set,
 * once the transaction has committed.
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore, setResult: (value: T) => void) => void} run
 * @returns {Promise<T | undefined>}
 */
async function withStore(mode, run) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      /** @type {T | undefined} */
      let result;
      run(transaction.objectStore(STORE_NAME), (value) => {
        result = value;
      });
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('The key store transaction was aborted.'));
    });
  } finally {
    database.close();
  }
}

/**
 * @param {unknown} value
 * @returns {value is CryptoKey} Whether it is a key this file made: AES-GCM, non-extractable.
 */
function isOurKey(value) {
  return (
    value instanceof CryptoKey &&
    value.algorithm.name === 'AES-GCM' &&
    !value.extractable &&
    value.usages.includes('encrypt') &&
    value.usages.includes('decrypt')
  );
}

/** @returns {Promise<CryptoKey | null>} The stored key, or null when there is none. */
async function readKey() {
  const key = await withStore('readonly', (store, setResult) => {
    const request = store.get(KEY_ID);
    request.onsuccess = () => setResult(isOurKey(request.result) ? request.result : null);
  });
  return key ?? null;
}

/**
 * The stored key, created first when there is none. Read and write happen in
 * one transaction, so two callers racing end up with the same key.
 * @returns {Promise<CryptoKey>}
 */
async function readOrCreateKey() {
  const existing = await readKey();
  if (existing !== null) {
    return existing;
  }
  const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const key = await withStore('readwrite', (store, setResult) => {
    const request = store.get(KEY_ID);
    request.onsuccess = () => {
      if (isOurKey(request.result)) {
        setResult(request.result);
      } else {
        store.put(created, KEY_ID);
        setResult(created);
      }
    };
  });
  if (key === undefined) {
    throw new Error('Could not create the encryption key.');
  }
  return key;
}

/**
 * @param {boolean} create Whether to create the key when there is none.
 * @returns {Promise<CryptoKey | null>}
 */
async function getKey(create) {
  if (cachedKey !== null) {
    return cachedKey;
  }
  const generation = keyGeneration;
  const key = create ? await readOrCreateKey() : await readKey();
  if (generation === keyGeneration) {
    cachedKey = key;
  }
  return key;
}

/**
 * Encrypts a secret for storage.
 * @param {string} plaintext
 * @param {string} context What the secret is bound to (e.g. the endpoint's origin); the same
 *   context is needed to decrypt it.
 * @returns {Promise<EncryptedSecret>}
 */
export async function encryptSecret(plaintext, context) {
  const key = await getKey(true);
  if (key === null) {
    throw new Error('No encryption key.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(plaintext),
  );
  return { v: FORMAT_VERSION, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

/**
 * Decrypts a stored secret. Never throws.
 * @param {unknown} value What is stored (EncryptedSecret).
 * @param {string} context The context it was encrypted for.
 * @returns {Promise<string | null>} null when it is missing, malformed, tampered with, bound
 *   to another context, or the key that encrypted it is gone.
 */
export async function decryptSecret(value, context) {
  try {
    if (typeof value !== 'object' || value === null || /** @type {{ v?: unknown }} */ (value).v !== FORMAT_VERSION) {
      return null;
    }
    const { iv: ivText, data: dataText } = /** @type {Record<string, unknown>} */ (value);
    const iv = fromBase64(ivText, IV_BYTES);
    const data = fromBase64(dataText, MAX_CIPHERTEXT_BYTES);
    if (iv === null || iv.length !== IV_BYTES || data === null || data.length <= 16) {
      return null;
    }
    const key = await getKey(false);
    if (key === null) {
      return null;
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      key,
      data,
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Deletes the encryption key (when the user removes the API key): anything
 * encrypted with it can never be decrypted again. The next save creates a new
 * one.
 * @returns {Promise<void>}
 */
export async function forgetEncryptionKey() {
  keyGeneration += 1;
  cachedKey = null;
  await withStore('readwrite', (store) => {
    store.delete(KEY_ID);
  });
  keyGeneration += 1;
  cachedKey = null;
}
