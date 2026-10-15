/**
 * RecipeCache — sessionStorage-backed cache with TTL.
 *
 * Keys are namespaced under "cookbook_cache:" to avoid collisions.
 * TTL is in seconds. Expired entries are pruned on get().
 */
export class RecipeCache {
  /** @param {number} defaultTtl seconds */
  constructor(defaultTtl = 300) {
    this._defaultTtl = defaultTtl;
    this._ns = 'cookbook_cache:';
  }

  /**
   * @param {string} key
   * @returns {any|null} cached value or null if missing/expired
   */
  get(key) {
    const raw = sessionStorage.getItem(this._ns + key);
    if (!raw) return null;

    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      sessionStorage.removeItem(this._ns + key);
      return null;
    }

    return entry.value;
  }

  /**
   * @param {string} key
   * @param {any}    value  — must be JSON-serialisable
   * @param {number} [ttl] seconds (default: constructor default)
   */
  set(key, value, ttl) {
    const entry = {
      value,
      expiresAt: Date.now() + (ttl ?? this._defaultTtl) * 1000,
    };
    try {
      sessionStorage.setItem(this._ns + key, JSON.stringify(entry));
    } catch {
      // sessionStorage quota exceeded — clear cookbook keys and retry once
      this.clear();
      try {
        sessionStorage.setItem(this._ns + key, JSON.stringify(entry));
      } catch {
        // silently drop if still failing
      }
    }
  }

  /** Remove a specific key. */
  delete(key) {
    sessionStorage.removeItem(this._ns + key);
  }

  /** Remove all cookbook cache keys. */
  clear() {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(this._ns)) sessionStorage.removeItem(k);
    }
  }
}
