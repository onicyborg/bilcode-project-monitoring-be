import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { Database } from "../dist/database.js";
import { Monitor } from "../dist/monitor.js";
import { HealthController } from "../dist/controllers.js";

test("lost lease aborts work once and forces exit if graceful shutdown hangs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const killed = t.mock.method(process, "kill", () => true);
  const exited = t.mock.method(process, "exit", () => {});
  const logs = t.mock.method(console, "error", () => {});
  const monitor = new Monitor({}, {}, {}, {}, {});
  monitor.leaseHealthy = true;
  monitor.pauseRequested = false;
  const controller = new AbortController();
  monitor.controller = controller;
  monitor.leaseLost(
    Object.assign(new Error("PRIVATE_CONNECTION_DETAIL"), {
      code: "ECONNRESET",
    }),
  );
  monitor.leaseLost(new Error("second event"));
  assert.equal(monitor.isLeaseHealthy(), false);
  assert.equal(monitor.pauseRequested, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(killed.mock.callCount(), 1);
  assert.deepEqual(killed.mock.calls[0].arguments, [process.pid, "SIGTERM"]);
  assert.ok(logs.mock.calls[0].arguments[0].includes("ECONNRESET"));
  assert.ok(
    !logs.mock.calls[0].arguments[0].includes("PRIVATE_CONNECTION_DETAIL"),
  );
  t.mock.timers.tick(9999);
  assert.equal(exited.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(exited.mock.callCount(), 1);
  assert.deepEqual(exited.mock.calls[0].arguments, [1]);
});

test("health fails immediately after lease loss without querying the database", async () => {
  let calls = 0;
  const health = new HealthController(
    {
      $queryRaw: async () => {
        calls++;
      },
    },
    { isLeaseHealthy: () => false },
  );
  await assert.rejects(health.health(), (e) => e.getStatus() === 503);
  assert.equal(calls, 0);
});

test("a stalled database health probe returns 503 after three seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const health = new HealthController(
    { $queryRaw: () => new Promise(() => {}) },
    { isLeaseHealthy: () => true },
  );
  const pending = assert.rejects(health.health(), (e) => e.getStatus() === 503);
  t.mock.timers.tick(3000);
  await pending;
});

test("health reports a connected database and hides database error details", async () => {
  const ok = new HealthController(
    { $queryRaw: async () => [1] },
    { isLeaseHealthy: () => true },
  );
  assert.deepEqual(await ok.health(), { status: "ok", database: "connected" });
  const failed = new HealthController(
    {
      $queryRaw: async () => {
        throw new Error("PRIVATE_DATABASE_DETAIL");
      },
    },
    { isLeaseHealthy: () => true },
  );
  await assert.rejects(
    failed.health(),
    (e) =>
      e.getStatus() === 503 && !e.message.includes("PRIVATE_DATABASE_DETAIL"),
  );
});

test(
  "a TCP database connection that never completes its handshake is bounded",
  { timeout: 18000 },
  async () => {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `postgresql://test:test@127.0.0.1:${server.address().port}/test?sslmode=disable`;
    const db = new Database();
    const started = Date.now();
    try {
      await assert.rejects(db.$queryRaw`SELECT 1`);
      assert.ok(Date.now() - started < 15000);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      for (const socket of sockets) socket.destroy();
      await db.onModuleDestroy();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
