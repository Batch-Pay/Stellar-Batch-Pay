/**
 * Client-side durable reentrancy guard for Stellar & Soroban operations (#250, #744).
 *
 * Provides a cross-tab and cross-context lock mechanism keyed by (publicKey, operation).
 * Guards against duplicate transactions during build, wallet signing (Freighter/Ledger),
 * and on-chain submission/confirmation across multiple browser tabs, reloads, or rapid clicks.
 *
 * Synchronization strategy:
 * 1. Storage-backed persistence (localStorage with in-memory fallback for SSR/Node.js).
 * 2. BroadcastChannel cross-tab instant event propagation.
 * 3. Automatic TTL expiration (default: 120s) to prevent permanent lockouts on crashes.
 * 4. Same-holder reference counting to support nested lifecycle locks (outer UI lock + inner builder).
 */

export interface LockRecord {
  key: string;
  holderId: string;
  acquiredAt: number;
  expiresAt: number;
  operation: string;
  publicKey: string;
}

export interface AcquireGuardOptions {
  ttlMs?: number;
  holderId?: string;
}

export type GuardOperation = 'deposit' | 'claim' | 'revoke' | 'transfer' | 'bump' | string;

export class ReentrancyError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
  ) {
    super(message);
    this.name = 'ReentrancyError';
  }
}

const STORAGE_PREFIX = 'sbp_lock:';
const BROADCAST_CHANNEL_NAME = 'sbp_reentrancy_channel';
export const DEFAULT_LOCK_TTL_MS = 120_000; // 2 minutes

// Unique ID for the current tab / execution context
const LOCAL_HOLDER_ID: string = (() => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `holder_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
})();

// In-memory fallback and fast-path cache
const memoryLockStore = new Map<string, LockRecord>();
const localRefCounts = new Map<string, number>();
const webLockReleases = new Map<string, () => void>();

// Safe storage access helpers
function isStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function getStorageItem(key: string): string | null {
  if (!isStorageAvailable()) {
    return null;
  }
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  } catch {
    return null;
  }
}

function setStorageItem(key: string, value: string): void {
  if (!isStorageAvailable()) {
    return;
  }
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
  } catch {
    // Ignore storage quota or access errors in restricted browser contexts
  }
}

function removeStorageItem(key: string): void {
  if (!isStorageAvailable()) {
    return;
  }
  try {
    window.localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
  } catch {
    // Ignore storage errors
  }
}

// BroadcastChannel instance for cross-tab messaging
let broadcastChannel: BroadcastChannel | null = null;
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    broadcastChannel.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'LOCK_ACQUIRED' && data.record) {
        memoryLockStore.set(data.record.key, data.record);
      } else if (data.type === 'LOCK_RELEASED' && data.key) {
        memoryLockStore.delete(data.key);
      } else if (data.type === 'CLEAR_ALL') {
        memoryLockStore.clear();
      }
    };
  } catch {
    broadcastChannel = null;
  }
}

// Storage event listener for cross-tab synchronization
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (event) => {
      if (!event.key || !event.key.startsWith(STORAGE_PREFIX)) return;
      const lockKey = event.key.substring(STORAGE_PREFIX.length);
      if (event.newValue === null) {
        memoryLockStore.delete(lockKey);
      } else {
        try {
          const record = JSON.parse(event.newValue) as LockRecord;
          memoryLockStore.set(lockKey, record);
        } catch {
          memoryLockStore.delete(lockKey);
        }
      }
    });
  } catch {
    // Ignore window listener failure in non-standard environments
  }
}

function broadcast(message: unknown): void {
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(message);
    } catch {
      // Ignore broadcast errors
    }
  }
}

export function makeGuardKey(publicKey: string, operation: GuardOperation): string {
  return `${publicKey}:${operation}`;
}

export function getHolderId(): string {
  return LOCAL_HOLDER_ID;
}

/**
 * Retrieve the active, unexpired lock record for the key, if any.
 */
export function getActiveLock(key: string): LockRecord | null {
  const now = Date.now();

  // Check persistent storage first
  const stored = getStorageItem(key);
  if (stored) {
    try {
      const record = JSON.parse(stored) as LockRecord;
      if (record && record.expiresAt > now) {
        memoryLockStore.set(key, record);
        return record;
      }
      // Expired record
      removeStorageItem(key);
      memoryLockStore.delete(key);
    } catch {
      removeStorageItem(key);
      memoryLockStore.delete(key);
    }
  }

  // Check memory store
  const memRecord = memoryLockStore.get(key);
  if (memRecord) {
    if (memRecord.expiresAt > now) {
      return memRecord;
    }
    memoryLockStore.delete(key);
  }

  return null;
}

/**
 * Check whether a lock is currently active for the given account + operation.
 */
export function isLocked(publicKey: string, operation: GuardOperation): boolean {
  const key = makeGuardKey(publicKey, operation);
  return getActiveLock(key) !== null;
}

/**
 * Acquire an exclusive client-side lock across browser tabs and execution contexts.
 *
 * @param publicKey Stellar public key
 * @param operation Operation name ('deposit' | 'claim' | 'revoke' | etc.)
 * @param options Optional TTL (ms) and custom holder ID
 * @returns A release function that must be called when the full transaction flow finishes.
 * @throws {ReentrancyError} If another tab or context holds the active lock.
 */
export async function acquireGuard(
  publicKey: string,
  operation: GuardOperation,
  options?: AcquireGuardOptions,
): Promise<() => void> {
  const key = makeGuardKey(publicKey, operation);
  const holderId = options?.holderId ?? LOCAL_HOLDER_ID;
  const ttlMs = options?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const now = Date.now();

  const existingLock = getActiveLock(key);

  if (existingLock) {
    // If the active lock is held by the same holder ID, increment local reentrancy ref count
    if (existingLock.holderId === holderId) {
      const currentRef = localRefCounts.get(key) ?? 1;
      localRefCounts.set(key, currentRef + 1);

      return function releaseNested() {
        releaseGuard(publicKey, operation, holderId);
      };
    }

    throw new ReentrancyError(
      `A ${operation} call for ${publicKey} is already in progress in another tab or action. ` +
        'Please wait for it to confirm or complete before submitting another.',
      operation,
    );
  }

  // Web Locks provides an actual browser-level mutex. This closes the
  // read/write race that localStorage alone cannot solve.
  if (typeof navigator !== "undefined" && navigator.locks) {
    const acquiredPromise = new Promise<boolean>((resolve) => {
      void navigator.locks.request(`sbp:${key}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        return new Promise<void>((release) => {
          webLockReleases.set(key, release);
        });
      }).catch(() => resolve(false));
    });
    const acquired = await acquiredPromise;
    if (!acquired) {
      throw new ReentrancyError(`A ${operation} call for ${publicKey} is already in progress in another tab or action. Please wait for it to confirm or complete before submitting another.`, operation);
    }
  }

  // Re-check storage after obtaining the mutex, since another context may
  // have published its durable record while this request was queued.
  const afterMutex = getActiveLock(key);
  if (afterMutex && afterMutex.holderId !== holderId) {
    webLockReleases.get(key)?.();
    webLockReleases.delete(key);
    throw new ReentrancyError(`A ${operation} call for ${publicKey} is already in progress in another tab or action. Please wait for it to confirm or complete before submitting another.`, operation);
  }

  const record: LockRecord = {
    key,
    holderId,
    acquiredAt: now,
    expiresAt: now + ttlMs,
    operation,
    publicKey,
  };

  // Write to memory and storage
  memoryLockStore.set(key, record);
  localRefCounts.set(key, 1);
  setStorageItem(key, JSON.stringify(record));
  broadcast({ type: 'LOCK_ACQUIRED', record });

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    releaseGuard(publicKey, operation, holderId);
  };
}

/**
 * Explicitly release a held lock.
 */
export function releaseGuard(
  publicKey: string,
  operation: GuardOperation,
  holderId: string = LOCAL_HOLDER_ID,
): void {
  const key = makeGuardKey(publicKey, operation);
  const currentRef = localRefCounts.get(key);

  if (currentRef !== undefined && currentRef > 1) {
    localRefCounts.set(key, currentRef - 1);
    return;
  }

  localRefCounts.delete(key);

  const existing = getActiveLock(key);
  if (existing && existing.holderId === holderId) {
    memoryLockStore.delete(key);
    removeStorageItem(key);
    broadcast({ type: 'LOCK_RELEASED', key, holderId });
    const webRelease = webLockReleases.get(key);
    if (webRelease) {
      webLockReleases.delete(key);
      webRelease();
    }
  } else if (!existing) {
    memoryLockStore.delete(key);
    removeStorageItem(key);
    broadcast({ type: 'LOCK_RELEASED', key, holderId });
  }
}

/**
 * Clear all locks in memory and storage (for testing or reset purposes).
 */
export function clearAllGuards(): void {
  for (const release of webLockReleases.values()) {
    release();
  }
  webLockReleases.clear();
  memoryLockStore.clear();
  localRefCounts.clear();
  if (isStorageAvailable()) {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        window.localStorage.removeItem(k);
      }
    } catch {
      // Ignore storage cleanup errors
    }
  }
  broadcast({ type: 'CLEAR_ALL' });
}
