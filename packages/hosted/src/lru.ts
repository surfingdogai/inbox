/**
 * Least recently used, with a size cap: `set` past the cap hands back what fell out, for the caller
 * to close once nothing is using it any more.
 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("an LRU holds at least one entry");
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  /** Sets `key` as the most recent; returns the entries that fell out past the cap. */
  set(key: K, value: V): [K, V][] {
    this.map.delete(key);
    this.map.set(key, value);
    const out: [K, V][] = [];
    while (this.map.size > this.max) {
      const oldest = this.map.entries().next().value;
      if (!oldest) break;
      this.map.delete(oldest[0]);
      out.push(oldest);
    }
    return out;
  }

  delete(key: K): V | undefined {
    const value = this.map.get(key);
    this.map.delete(key);
    return value;
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }
}
