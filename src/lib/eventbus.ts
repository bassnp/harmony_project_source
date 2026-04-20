/**
 * EventBus — In-process pub/sub with per-subscriber ring buffers.
 *
 * Singleton hung off `globalThis.__hcdBus` so it survives Next.js HMR reloads.
 * Synchronous publish, O(subscribers) fan-out, bounded memory per subscriber.
 *
 * Design ref: references/research/ORCHESTRATION_HIGH_QUALITY_REFERENCE.md §5
 */

import { ulid } from "ulid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Channels partition events for SSE `event:` field routing. */
export type EventChannel = "agent" | "run" | "bus";

/** Base envelope every published event carries. */
export interface BusEvent {
  /** ULID, also used as SSE `id:` field. */
  readonly id: string;
  /** Monotonically increasing process-local publish sequence. */
  readonly seq: number;
  /** ISO 8601 timestamp. */
  readonly ts: string;
  /** Top-level routing key for SSE `event:` field. */
  readonly channel: EventChannel;
  /** More specific discriminator within the channel. */
  readonly type: string;
  /** Run scoping — subscribers can filter by this. */
  readonly runId?: string;
  /** Arbitrary JSON-serializable payload. */
  readonly payload?: unknown;
}

/** Input to `bus.publish()` — id/seq/ts are stamped automatically. */
export interface PublishInput {
  channel: EventChannel;
  type: string;
  runId?: string;
  payload?: unknown;
}

/** Filter criteria for a subscription. */
export interface SubscriptionFilter {
  /** If set, only events with this runId (or no runId) are delivered. */
  runId?: string;
}

/** Public handle returned by `bus.subscribe()`. */
export interface Subscription {
  readonly id: string;
  /** Non-blocking dequeue. Returns `undefined` when buffer is empty. */
  pull(): BusEvent | undefined;
  /** Resolves with next event, or `null` when subscription is closed. */
  waitForNext(): Promise<BusEvent | null>;
  /** Remove this subscriber from the bus and resolve any pending waiter. */
  close(): void;
}

// ---------------------------------------------------------------------------
// RingQueue — fixed-capacity FIFO, drop-oldest on overflow
// ---------------------------------------------------------------------------

class RingQueue<T> {
  private readonly slots: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private _length = 0;

  constructor(readonly capacity: number) {
    this.slots = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this._length;
  }

  /** Dequeue head. Returns `undefined` when empty. */
  shift(): T | undefined {
    if (this._length === 0) return undefined;
    const value = this.slots[this.head];
    this.slots[this.head] = undefined; // GC-friendly
    this.head = (this.head + 1) % this.capacity;
    this._length -= 1;
    return value;
  }

  /** Enqueue tail. Returns dropped (oldest) element if overflow, else `undefined`. */
  push(value: T): T | undefined {
    let dropped: T | undefined;
    if (this._length === this.capacity) {
      dropped = this.shift();
    }
    this.slots[this.tail] = value;
    this.tail = (this.tail + 1) % this.capacity;
    this._length += 1;
    return dropped;
  }
}

// ---------------------------------------------------------------------------
// Internal subscriber state
// ---------------------------------------------------------------------------

interface SubscriberState {
  readonly id: string;
  readonly filter: SubscriptionFilter;
  readonly queue: RingQueue<BusEvent>;
  /** Pending waiter resolve — set by `waitForNext()`, cleared on delivery. */
  waiter: ((event: BusEvent | null) => void) | null;
  closed: boolean;
  droppedCount: number;
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

/** Default ring-buffer capacity per subscriber. */
const DEFAULT_BUFFER_CAPACITY = 256;

/** Global event log capacity for Last-Event-ID replay support. */
const REPLAY_LOG_CAPACITY = 512;

export class EventBus {
  private publishSeq = 0;
  private readonly subscribers = new Map<string, SubscriberState>();
  /** Global ring buffer of recent events for Last-Event-ID replay. */
  private readonly recentEvents = new RingQueue<BusEvent>(REPLAY_LOG_CAPACITY);

  /**
   * Synchronously stamp and fan out an event to all matching subscribers.
   * Never does I/O — safe to call from any context.
   */
  publish(input: PublishInput): BusEvent {
    const event: BusEvent = {
      id: ulid(),
      seq: ++this.publishSeq,
      ts: new Date().toISOString(),
      channel: input.channel,
      type: input.type,
      runId: input.runId,
      payload: input.payload,
    };

    // Store in global replay log for Last-Event-ID reconnect support.
    this.recentEvents.push(event);

    for (const state of this.subscribers.values()) {
      if (state.closed) continue;
      if (!matchesFilter(state.filter, event)) continue;

      // If a waiter is pending, deliver directly (skip queue).
      if (state.waiter) {
        const resolve = state.waiter;
        state.waiter = null;
        resolve(event);
        continue;
      }

      const dropped = state.queue.push(event);
      if (dropped) {
        state.droppedCount += 1;
      }
    }

    return event;
  }

  /**
   * Create a subscription. Returns a `Subscription` handle with
   * `pull()`, `waitForNext()`, and `close()` methods.
   */
  subscribe(
    filter: SubscriptionFilter = {},
    bufferCapacity = DEFAULT_BUFFER_CAPACITY,
  ): Subscription {
    const id = ulid();
    const state: SubscriberState = {
      id,
      filter,
      queue: new RingQueue<BusEvent>(bufferCapacity),
      waiter: null,
      closed: false,
      droppedCount: 0,
    };
    this.subscribers.set(id, state);

    // Capture the Map reference (not `this`) to satisfy no-this-alias lint.
    const subscribers = this.subscribers;
    return {
      id,

      pull(): BusEvent | undefined {
        return state.queue.shift();
      },

      waitForNext(): Promise<BusEvent | null> {
        // Already closed — resolve immediately with null.
        if (state.closed) return Promise.resolve(null);

        // Buffered event available — resolve immediately.
        const queued = state.queue.shift();
        if (queued) return Promise.resolve(queued);

        // If a previous waiter is still pending, resolve it with null to
        // prevent orphaned promises. Only one waiter is supported at a time.
        if (state.waiter) {
          const prev = state.waiter;
          state.waiter = null;
          prev(null);
        }

        // Park a waiter — resolved by next `publish()` or `close()`.
        return new Promise<BusEvent | null>((resolve) => {
          state.waiter = resolve;
        });
      },

      close(): void {
        if (state.closed) return;
        state.closed = true;
        // Resolve any pending waiter with null (signals end-of-stream).
        if (state.waiter) {
          const resolve = state.waiter;
          state.waiter = null;
          resolve(null);
        }
        subscribers.delete(id);
      },
    };
  }

  /** Number of active subscribers (testing / diagnostics). */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Current monotonic publish sequence (testing / diagnostics). */
  get currentSeq(): number {
    return this.publishSeq;
  }

  /**
   * Replay events from the global log that have `seq > afterSeq` and
   * match the given filter. Returns events in order. Used for
   * `Last-Event-ID` SSE reconnect support.
   */
  replayFrom(afterSeq: number, filter: SubscriptionFilter = {}): BusEvent[] {
    const result: BusEvent[] = [];
    // Drain a snapshot of the ring buffer to scan.
    // We need to peek without consuming — use internal access pattern.
    const log = this.recentEvents;
    const snapshot: BusEvent[] = [];
    // Temporarily drain and refill to read all items.
    let item = log.shift();
    while (item) {
      snapshot.push(item);
      item = log.shift();
    }
    // Refill the ring buffer.
    for (const ev of snapshot) {
      log.push(ev);
    }
    // Filter and return events after the given seq.
    for (const ev of snapshot) {
      if (ev.seq > afterSeq && matchesFilter(filter, ev)) {
        result.push(ev);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Filter matching
// ---------------------------------------------------------------------------

function matchesFilter(filter: SubscriptionFilter, event: BusEvent): boolean {
  // If filter specifies a runId, only events with that runId (or broadcast
  // events with no runId) pass through.
  if (filter.runId && event.runId && event.runId !== filter.runId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Singleton accessor — survives Next.js HMR reloads
// ---------------------------------------------------------------------------

declare global {
  var __hcdBus: EventBus | undefined;
}

/** Get the process-wide EventBus singleton. */
export function getEventBus(): EventBus {
  globalThis.__hcdBus ??= new EventBus();
  return globalThis.__hcdBus;
}
