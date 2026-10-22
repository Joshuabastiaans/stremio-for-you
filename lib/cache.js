// Tiny in-memory TTL cache. Also de-duplicates concurrent loads of the same key.
export class TTLCache {
  constructor(ttlMs, maxEntries = 5000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.maxEntries) {
      // Drop the oldest entry (Map keeps insertion order).
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  // Returns the cached value, or runs loader() once and caches its promise.
  // Failed loads are not cached.
  wrap(key, loader, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const promise = Promise.resolve()
      .then(loader)
      .catch((err) => {
        this.map.delete(key);
        throw err;
      });
    this.set(key, promise, ttlMs);
    return promise;
  }
}

// Runs fn over items with at most `limit` in flight at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
