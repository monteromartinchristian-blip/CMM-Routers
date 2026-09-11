/**
 * Bounded async hand-off queue.
 *
 * A provider-controlled producer must never grow an unbounded Array just
 * because the consumer is slower than the producer. Overflow is refused
 * explicitly (`tryPush` returns false) and the caller turns that into a
 * deterministic safe error; an already-queued item is never evicted.
 */
export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  constructor(readonly maxSize: number) {}

  /** Enqueue one item. Returns false when the queue is at capacity. */
  tryPush(value: T): boolean {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return true;
    }
    if (this.items.length >= this.maxSize) return false;
    this.items.push(value);
    return true;
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }

  size(): number {
    return this.items.length;
  }
}
