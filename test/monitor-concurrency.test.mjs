import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Monitor } from "../dist/monitor.js";

const deferred = () => Promise.withResolvers();
function harness(hooks = {}) {
  const state = { desiredRunning: false, nextCheckAt: null };
  const actions = [];
  let cycles = 0;
  const db = {
    monitorState: {
      async findUniqueOrThrow() {
        await hooks.readState?.();
        return { ...state };
      },
      async update({ data }) {
        await hooks.updateState?.(data);
        Object.assign(state, data);
        return { ...state };
      },
    },
    bilcodeSession: {
      async findUniqueOrThrow() {
        return { authStatus: "VALID", refreshTokenEncrypted: "test" };
      },
    },
    configuration: {
      async findUniqueOrThrow() {
        await hooks.readConfig?.();
        return { gowaPasswordEncrypted: "test", intervalSeconds: 60 };
      },
    },
  };
  const monitor = new Monitor(
    db,
    {},
    {},
    {
      async record(action) {
        actions.push(action);
      },
    },
    {},
  );
  monitor.leaseHealthy = true;
  monitor.summary = async () => ({ state: { ...state } });
  monitor.cycle = async () => {
    cycles++;
    await hooks.cycle?.(cycles);
  };
  return { monitor, state, actions, cycles: () => cycles };
}

test(
  "stop queued behind an in-progress start cancels its timer and persisted running state",
  { timeout: 3000 },
  async (t) => {
    const entered = deferred();
    const release = deferred();
    const h = harness({
      async readState() {
        entered.resolve();
        await release.promise;
      },
    });
    t.after(() => h.monitor.onModuleDestroy());
    const starting = h.monitor.start();
    await entered.promise;
    const stopping = h.monitor.stop();
    release.resolve();
    await Promise.all([starting, stopping]);
    assert.deepEqual(h.actions, ["MONITOR_STARTED", "MONITOR_STOPPED"]);
    assert.equal(h.state.desiredRunning, false);
    assert.equal(h.state.nextCheckAt, null);
    assert.equal(h.monitor.pauseRequested, true);
    await delay(25);
    assert.equal(h.cycles(), 0);
  },
);

test(
  "an explicit start queued after stop may legitimately leave monitoring running",
  { timeout: 3000 },
  async (t) => {
    const entered = deferred();
    const release = deferred();
    const h = harness({
      async updateState(data) {
        if (data.desiredRunning === false) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    t.after(() => h.monitor.onModuleDestroy());
    const stopping = h.monitor.stop();
    await entered.promise;
    const starting = h.monitor.start();
    release.resolve();
    await Promise.all([stopping, starting]);
    assert.deepEqual(h.actions, ["MONITOR_STOPPED", "MONITOR_STARTED"]);
    assert.equal(h.state.desiredRunning, true);
    assert.equal(h.monitor.pauseRequested, false);
  },
);

test(
  "a retired cycle cannot replace the timer created by stop followed by start",
  { timeout: 3000 },
  async (t) => {
    const firstCycle = deferred();
    const release = deferred();
    const nextCycle = deferred();
    const h = harness({
      async cycle(count) {
        if (count === 1) {
          firstCycle.resolve();
          await release.promise;
        }
        if (count === 2) nextCycle.resolve();
      },
    });
    t.after(() => h.monitor.onModuleDestroy());
    h.state.desiredRunning = true;
    h.monitor.pauseRequested = false;
    h.monitor.schedule(0);
    await firstCycle.promise;
    const stopping = h.monitor.stop();
    const starting = h.monitor.start();
    release.resolve();
    await Promise.all([stopping, starting]);
    await nextCycle.promise;
    assert.equal(h.state.desiredRunning, true);
    assert.equal(h.monitor.pauseRequested, false);
    assert.equal(h.cycles(), 2);
  },
);

test(
  "scheduler cleanup cannot restore nextCheckAt after stop while configuration is loading",
  { timeout: 3000 },
  async (t) => {
    const entered = deferred();
    const release = deferred();
    const h = harness({
      async readConfig() {
        entered.resolve();
        await release.promise;
      },
    });
    t.after(() => h.monitor.onModuleDestroy());
    h.state.desiredRunning = true;
    h.monitor.pauseRequested = false;
    h.monitor.schedule(0);
    await entered.promise;
    const stopping = h.monitor.stop();
    release.resolve();
    await stopping;
    await h.monitor.exclusive(async () => {});
    assert.equal(h.cycles(), 1);
    assert.equal(h.state.desiredRunning, false);
    assert.equal(h.state.nextCheckAt, null);
    assert.equal(h.monitor.pauseRequested, true);
  },
);
