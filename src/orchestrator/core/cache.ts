/**
 * @module core/cache
 * @description In-memory LRU cache with TTL expiration.
 * Used to cache normalized emails and AI enrichment results.
 */

import { logger } from '../utils/logger.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  accessedAt: number;
}

const cacheLogger = logger.child('cache');

export class LRUCache<T> {
  private readonly cache: Map<string, CacheEntry<T>>;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(maxEntries: number = 1000, ttlSeconds: number = 300) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlSeconds * 1000;
  }

  /**
   * Get a value from cache.
   * Returns undefined if not found or expired.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Update access time for LRU
    entry.accessedAt = Date.now();
    this.hits++;
    return entry.value;
  }

  /**
   * Set a value in cache with TTL.
   */
  set(key: string, value: T, customTtlMs?: number): void {
    // Evict if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (customTtlMs ?? this.ttlMs),
      accessedAt: Date.now(),
    });
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Delete a key from cache.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    cacheLogger.info('Cache cleared');
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; maxEntries: number; hitRate: number; hits: number; misses: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      hitRate: total > 0 ? this.hits / total : 0,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /**
   * Get multiple values by keys.
   */
  getMany(keys: readonly string[]): Map<string, T> {
    const results = new Map<string, T>();
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) {
        results.set(key, value);
      }
    }
    return results;
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.accessedAt < oldestAccess) {
        oldestAccess = entry.accessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      cacheLogger.debug('Evicted LRU entry', { key: oldestKey });
    }
  }

  /**
   * Remove all expired entries.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      cacheLogger.debug(`Pruned ${pruned} expired entries`);
    }
    return pruned;
  }
}
