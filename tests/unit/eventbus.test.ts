/**
 * Unit tests for src/lib/eventbus.ts
 *
 * Coverage:
 *   - Happy path: publish → pull
 *   - Async waiter: waitForNext resolves on publish
 *   - Ring buffer overflow: drop-oldest semantics
 *   - Filter: runId scoping
 *   - Close: pending waiter resolves null, subscriber removed
 *   - Singleton: getEventBus returns same instance
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventBus, getEventBus, type BusEvent } from "@/lib/eventbus";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ---- Happy path ---------------------------------------------------------

  it("publish + pull delivers event to subscriber", () => {
    const sub = bus.subscribe();
    bus.publish({ channel: "agent", type: "agent.stdout", payload: "hello" });
    const event = sub.pull();

    expect(event).toBeDefined();
    expect(event!.channel).toBe("agent");
    expect(event!.type).toBe("agent.stdout");
    expect(event!.payload).toBe("hello");
    expect(event!.seq).toBe(1);
    expect(event!.id).toBeTruthy();
    expect(event!.ts).toBeTruthy();

    sub.close();
  });

  it("pull returns undefined when buffer is empty", () => {
    const sub = bus.subscribe();
    expect(sub.pull()).toBeUndefined();
    sub.close();
  });

  // ---- Async waiter -------------------------------------------------------

  it("waitForNext resolves when event is published", async () => {
    const sub = bus.subscribe();

    // Start waiting before publish
    const promise = sub.waitForNext();

    // Publish after a microtask
    queueMicrotask(() => {
      bus.publish({ channel: "run", type: "run.started", payload: { id: 1 } });
    });

    const event = await promise;
    expect(event).not.toBeNull();
    expect(event!.type).toBe("run.started");

    sub.close();
  });

  it("waitForNext returns buffered event immediately", async () => {
    const sub = bus.subscribe();
    bus.publish({ channel: "agent", type: "agent.stdout", payload: "a" });

    const event = await sub.waitForNext();
    expect(event).not.toBeNull();
    expect(event!.payload).toBe("a");

    sub.close();
  });

  // ---- Ring buffer overflow -----------------------------------------------

  it("drops oldest events when buffer overflows", () => {
    const sub = bus.subscribe({}, 3); // capacity = 3

    bus.publish({ channel: "agent", type: "t", payload: 1 });
    bus.publish({ channel: "agent", type: "t", payload: 2 });
    bus.publish({ channel: "agent", type: "t", payload: 3 });
    bus.publish({ channel: "agent", type: "t", payload: 4 }); // drops payload=1

    const e1 = sub.pull();
    const e2 = sub.pull();
    const e3 = sub.pull();
    const e4 = sub.pull();

    expect(e1!.payload).toBe(2); // oldest surviving
    expect(e2!.payload).toBe(3);
    expect(e3!.payload).toBe(4);
    expect(e4).toBeUndefined();

    sub.close();
  });

  // ---- Filter by runId ----------------------------------------------------

  it("filters events by runId, but broadcasts (no runId) pass through", () => {
    const sub = bus.subscribe({ runId: "run-A" });

    bus.publish({ channel: "agent", type: "t", runId: "run-A", payload: "yes" });
    bus.publish({ channel: "agent", type: "t", runId: "run-B", payload: "no" });
    bus.publish({ channel: "agent", type: "t", payload: "broadcast" });

    const e1 = sub.pull();
    const e2 = sub.pull();
    const e3 = sub.pull();

    expect(e1!.payload).toBe("yes");       // run-A matches
    expect(e2!.payload).toBe("broadcast"); // no runId = broadcast
    expect(e3).toBeUndefined();            // run-B filtered out

    sub.close();
  });

  // ---- Close semantics ----------------------------------------------------

  it("close resolves pending waiter with null", async () => {
    const sub = bus.subscribe();
    const promise = sub.waitForNext();

    sub.close();

    const result = await promise;
    expect(result).toBeNull();
  });

  it("waitForNext returns null after close", async () => {
    const sub = bus.subscribe();
    sub.close();

    const result = await sub.waitForNext();
    expect(result).toBeNull();
  });

  it("close removes subscriber from bus", () => {
    const sub = bus.subscribe();
    expect(bus.subscriberCount).toBe(1);

    sub.close();
    expect(bus.subscriberCount).toBe(0);
  });

  it("double close is idempotent", () => {
    const sub = bus.subscribe();
    sub.close();
    sub.close(); // should not throw
    expect(bus.subscriberCount).toBe(0);
  });

  // ---- Multiple subscribers -----------------------------------------------

  it("fans out to multiple subscribers", () => {
    const sub1 = bus.subscribe();
    const sub2 = bus.subscribe();

    bus.publish({ channel: "run", type: "run.started" });

    expect(sub1.pull()).toBeDefined();
    expect(sub2.pull()).toBeDefined();

    sub1.close();
    sub2.close();
  });

  // ---- Sequence numbering -------------------------------------------------

  it("assigns monotonically increasing seq numbers", () => {
    const sub = bus.subscribe();

    bus.publish({ channel: "agent", type: "t" });
    bus.publish({ channel: "agent", type: "t" });
    bus.publish({ channel: "agent", type: "t" });

    const events: BusEvent[] = [];
    let e = sub.pull();
    while (e) {
      events.push(e);
      e = sub.pull();
    }

    expect(events.map((ev) => ev.seq)).toEqual([1, 2, 3]);

    sub.close();
  });

  // ---- Edge cases ---------------------------------------------------------

  it("publish to closed subscriber does not throw", () => {
    const sub = bus.subscribe();
    sub.close();
    // Publishing after subscriber is closed should be silent (no crash)
    expect(() => {
      bus.publish({ channel: "agent", type: "t", payload: "after close" });
    }).not.toThrow();
  });

  it("pull after close drains remaining buffered events then returns undefined", () => {
    const sub = bus.subscribe();
    bus.publish({ channel: "agent", type: "t" });
    sub.close();
    // Buffered events are still drainable after close
    const e = sub.pull();
    expect(e).toBeDefined();
    // But no new events will be delivered since the subscriber is removed
    expect(sub.pull()).toBeUndefined();
  });

  it("high-volume publish does not lose events within capacity", () => {
    const sub = bus.subscribe({}, 100);
    for (let i = 0; i < 100; i++) {
      bus.publish({ channel: "agent", type: "t", payload: i });
    }
    const events: BusEvent[] = [];
    let e = sub.pull();
    while (e) {
      events.push(e);
      e = sub.pull();
    }
    expect(events).toHaveLength(100);
    expect(events[0]!.payload).toBe(0);
    expect(events[99]!.payload).toBe(99);
    sub.close();
  });

  it("concurrent waitForNext calls resolve in order", async () => {
    const sub = bus.subscribe();
    // Start two waiters — the first should be auto-resolved with null
    // when the second parks, since only one waiter is supported at a time.
    const p1 = sub.waitForNext();
    const p2 = sub.waitForNext();

    // p1 was displaced and should resolve with null
    const r1 = await p1;
    expect(r1).toBeNull();

    // p2 gets the actual event
    bus.publish({ channel: "agent", type: "t", payload: "delivered" });
    const r2 = await p2;
    expect(r2).not.toBeNull();
    expect(r2!.payload).toBe("delivered");
    sub.close();
  });

  // ---- replayFrom (Last-Event-ID support) ---------------------------------

  it("replayFrom returns events after the given seq", () => {
    bus.publish({ channel: "agent", type: "t", payload: "a" });
    bus.publish({ channel: "agent", type: "t", payload: "b" });
    bus.publish({ channel: "agent", type: "t", payload: "c" });

    const replayed = bus.replayFrom(1);
    expect(replayed).toHaveLength(2);
    expect(replayed[0]!.payload).toBe("b");
    expect(replayed[1]!.payload).toBe("c");
  });

  it("replayFrom with seq 0 returns all events", () => {
    bus.publish({ channel: "run", type: "run.started", payload: 1 });
    bus.publish({ channel: "run", type: "run.done", payload: 2 });

    const replayed = bus.replayFrom(0);
    expect(replayed).toHaveLength(2);
  });

  it("replayFrom with seq >= currentSeq returns empty", () => {
    bus.publish({ channel: "agent", type: "t" });
    const replayed = bus.replayFrom(999);
    expect(replayed).toHaveLength(0);
  });

  it("replayFrom respects runId filter", () => {
    bus.publish({ channel: "agent", type: "t", runId: "run-A", payload: "a" });
    bus.publish({ channel: "agent", type: "t", runId: "run-B", payload: "b" });
    bus.publish({ channel: "agent", type: "t", runId: "run-A", payload: "c" });

    const replayed = bus.replayFrom(0, { runId: "run-A" });
    expect(replayed).toHaveLength(2);
    expect(replayed[0]!.payload).toBe("a");
    expect(replayed[1]!.payload).toBe("c");
  });

  it("replayFrom does not consume events (idempotent)", () => {
    bus.publish({ channel: "agent", type: "t", payload: "x" });

    const first = bus.replayFrom(0);
    const second = bus.replayFrom(0);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.payload).toBe("x");
    expect(second[0]!.payload).toBe("x");
  });

  it("currentSeq returns the latest publish sequence", () => {
    expect(bus.currentSeq).toBe(0);
    bus.publish({ channel: "agent", type: "t" });
    expect(bus.currentSeq).toBe(1);
    bus.publish({ channel: "agent", type: "t" });
    expect(bus.currentSeq).toBe(2);
  });
});

// ---- Singleton accessor ---------------------------------------------------

describe("getEventBus", () => {
  afterEach(() => {
    // Reset singleton between tests
    globalThis.__hcdBus = undefined;
  });

  it("returns the same instance on repeated calls", () => {
    const a = getEventBus();
    const b = getEventBus();
    expect(a).toBe(b);
  });

  it("creates instance on first call", () => {
    globalThis.__hcdBus = undefined;
    const bus = getEventBus();
    expect(bus).toBeInstanceOf(EventBus);
  });
});
