import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";

const base = "http://127.0.0.1:4101/api";
const origin = "http://localhost:3100";
const password = "integration-test-password-2026";
const key = "17".repeat(32);
const config = dotenv.parse(readFileSync(".env"));
const databaseUrl = new URL(config.DATABASE_URL);
databaseUrl.pathname = "/bilcode_monitoring_integration_test";
const testUrl = databaseUrl.toString();
let pool;
let processApi;
let output = "";
let cookie;
let mock;
let server;
let upstreamPort;

function resetMock() {
  mock = {
    refresh: "refresh-credential-integration-0001",
    access: "access-integration-0001",
    refreshCount: 0,
    projectsCount: 0,
    projects: [],
    pages: 1,
    authRejected: false,
    failProjects: false,
    failGowa: false,
    slow: false,
    messages: [],
    calls: 0,
  };
}
function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}
async function request(
  path,
  method = "GET",
  body,
  withAuth = true,
  suppliedOrigin = origin,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(withAuth && cookie ? { Cookie: cookie } : {}),
      ...(suppliedOrigin ? { Origin: suppliedOrigin } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    data: await response.json(),
    headers: response.headers,
  };
}
async function waitFor(predicate, message, timeout = 7000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  assert.fail(message + "\n" + output.slice(-2500));
}
async function startApi() {
  processApi = spawn(process.execPath, ["dist/main.js"], {
    env: {
      ...process.env,
      DATABASE_URL: testUrl,
      API_PORT: "4101",
      APP_ORIGIN: origin,
      ADMIN_USERNAME: "test-operator",
      ADMIN_PASSWORD: password,
      ENCRYPTION_KEY: key,
      INITIAL_GOWA_PASSWORD: "mock-gowa-secret",
      BILCODE_API_URL: `http://127.0.0.1:${upstreamPort}/api`,
      GOWA_ALLOWED_HOSTS: "127.0.0.1",
      ALLOW_LOCAL_UPSTREAM: "true",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processApi.stdout.on("data", (chunk) => {
    output += chunk;
  });
  processApi.stderr.on("data", (chunk) => {
    output += chunk;
  });
  await waitFor(async () => {
    try {
      return (await fetch(base + "/health")).ok;
    } catch {
      return false;
    }
  }, "API failed to start");
}
async function stopApi() {
  if (!processApi || processApi.exitCode !== null) return;
  const child = processApi;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  processApi = undefined;
}
function cookieExport(token = mock.refresh) {
  return JSON.stringify([
    {
      name: "bilcode_refresh_token",
      value: token,
      domain: ".bilcode.id",
      path: "/",
    },
  ]);
}
async function importAndValidate() {
  assert.equal(
    (await request("/session/cookie", "PUT", { cookieJson: cookieExport() }))
      .status,
    200,
  );
  assert.equal((await request("/session/validate", "POST")).status, 201);
}
function decrypt(value) {
  const [iv, tag, data] = value
    .split(".")
    .map((item) => Buffer.from(item, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}

describe(
  "Monitoring integration against PostgreSQL and mock Bilcode/GOWA",
  { concurrency: false },
  () => {
    before(async () => {
      resetMock();
      server = createServer(async (req, res) => {
        mock.calls++;
        const url = new URL(req.url, "http://local");
        if (url.pathname === "/api/auth/refresh") {
          mock.refreshCount++;
          if (
            mock.authRejected ||
            req.headers.cookie !== `bilcode_refresh_token=${mock.refresh}`
          )
            return json(res, 401, {
              message: "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
            });
          mock.refresh = `refresh-credential-integration-${mock.refreshCount + 1}`;
          mock.access = `access-integration-${mock.refreshCount + 1}`;
          return json(
            res,
            200,
            { access_token: mock.access, token_type: "Bearer" },
            {
              "set-cookie": `bilcode_refresh_token=${mock.refresh}; Path=/; HttpOnly`,
            },
          );
        }
        if (url.pathname === "/api/worker/projects/available") {
          mock.projectsCount++;
          if (
            mock.authRejected ||
            req.headers.authorization !== `Bearer ${mock.access}`
          )
            return json(res, 401, {
              message: "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
            });
          if (mock.failProjects)
            return json(res, 500, {
              message: "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
            });
          const page = Number(url.searchParams.get("page"));
          const reply = () =>
            json(res, 200, {
              projects: {
                data:
                  mock.pages === 1
                    ? mock.projects
                    : mock.projects.slice(page - 1, page),
                last_page: mock.pages,
              },
            });
          if (mock.slow) {
            const timer = setTimeout(reply, 4000);
            res.on("close", () => clearTimeout(timer));
            return;
          }
          return reply();
        }
        if (url.pathname.includes("/devices/"))
          return json(res, 200, {
            results: { is_connected: true, is_logged_in: true },
          });
        if (url.pathname === "/send/message") {
          if (mock.failGowa)
            return json(res, 503, { message: "Mock gateway unavailable" });
          let text = "";
          for await (const chunk of req) text += chunk;
          mock.messages.push(JSON.parse(text));
          return json(res, 200, {
            code: "SUCCESS",
            results: { message_id: `message-${mock.messages.length}` },
          });
        }
        return json(res, 404, {});
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      upstreamPort = server.address().port;
      const adminUrl = new URL(config.DATABASE_URL);
      adminUrl.pathname = "/postgres";
      const admin = new pg.Client({ connectionString: adminUrl.toString() });
      await admin.connect();
      await admin.query(
        "DROP DATABASE IF EXISTS bilcode_monitoring_integration_test WITH (FORCE)",
      );
      await admin.query("CREATE DATABASE bilcode_monitoring_integration_test");
      await admin.end();
      const migration = spawnSync(
        process.execPath,
        ["node_modules/prisma/build/index.js", "migrate", "deploy"],
        { env: { ...process.env, DATABASE_URL: testUrl }, encoding: "utf8" },
      );
      assert.equal(migration.status, 0, migration.stderr);
      pool = new pg.Pool({ connectionString: testUrl });
      await startApi();
      const login = await request(
        "/auth/login",
        "POST",
        { username: "test-operator", password },
        false,
      );
      assert.equal(login.status, 201);
      assert.match(login.headers.get("set-cookie"), /HttpOnly/i);
      cookie = login.headers.get("set-cookie").split(";")[0];
    });
    after(async () => {
      await stopApi();
      await pool?.end();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
    beforeEach(async () => {
      await request("/monitor/stop", "POST");
      await pool.query('TRUNCATE "Notification", "CheckRun", "EventLog"');
      await pool.query(
        'UPDATE "MonitorState" SET "authAlerted"=false, "lastError"=NULL, "lastCheckAt"=NULL, "lastSuccessAt"=NULL',
      );
      resetMock();
      const settings = await request("/settings", "PUT", {
        intervalSeconds: 300,
        phone: "6281347890520",
        gowaUrl: `http://127.0.0.1:${upstreamPort}`,
        gowaUsername: "test",
        gowaPassword: "mock-gowa-secret",
        deviceId: "personal",
        authAlerts: true,
      });
      assert.equal(settings.status, 200);
      await request("/session/cookie", "DELETE");
    });

    test("requires panel login and rejects mutations from other origins", async () => {
      assert.equal(
        (await request("/monitor/summary", "GET", undefined, false)).status,
        401,
      );
      assert.equal(
        (
          await request(
            "/monitor/stop",
            "POST",
            undefined,
            true,
            "https://other.example",
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            "/auth/login",
            "POST",
            { username: "test-operator", password: "wrong" },
            false,
          )
        ).status,
        401,
      );
    });
    test("a new stopped installation makes no upstream requests", async () => {
      const summary = await request("/monitor/summary");
      assert.equal(summary.data.state.desiredRunning, false);
      assert.equal(summary.data.session.authStatus, "MISSING");
      assert.equal((await request("/monitor/start", "POST")).status, 400);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(mock.calls, 0);
    });
    test("validates cookie domain and stores only encrypted secrets", async () => {
      assert.equal(
        (await request("/session/cookie", "PUT", { cookieJson: "{" })).status,
        400,
      );
      assert.equal(
        (
          await request("/session/cookie", "PUT", {
            cookieJson: JSON.stringify([
              {
                name: "bilcode_refresh_token",
                value: mock.refresh,
                domain: ".other.example",
              },
            ]),
          })
        ).status,
        400,
      );
      await importAndValidate();
      const session = await pool.query(
        'SELECT "refreshTokenEncrypted" FROM "BilcodeSession"',
      );
      assert.notEqual(session.rows[0].refreshTokenEncrypted, mock.refresh);
      assert.equal(
        decrypt(session.rows[0].refreshTokenEncrypted),
        mock.refresh,
      );
      const summary = JSON.stringify((await request("/monitor/summary")).data);
      assert.ok(!summary.includes(mock.refresh));
      assert.ok(!summary.includes("mock-gowa-secret"));
      assert.ok(!summary.includes("Encrypted"));
    });
    test("persists refresh rotation even when the project API subsequently fails", async () => {
      await request("/session/cookie", "PUT", { cookieJson: cookieExport() });
      mock.failProjects = true;
      assert.equal((await request("/session/validate", "POST")).status, 400);
      const row = await pool.query(
        'SELECT "refreshTokenEncrypted" FROM "BilcodeSession"',
      );
      assert.equal(decrypt(row.rows[0].refreshTokenEncrypted), mock.refresh);
      mock.failProjects = false;
      assert.equal((await request("/session/validate", "POST")).status, 201);
    });
    test("reads all pages and sends each new project once as JSON text", async () => {
      mock.projects = [
        { id: 101, title: "Dummy A", description: "Teks ``` contoh" },
        { id: 102, title: "Dummy B" },
      ];
      mock.pages = 2;
      await importAndValidate();
      assert.equal(mock.messages.length, 0);
      let result = await request("/monitor/check", "POST");
      assert.equal(result.status, 201);
      assert.equal(result.data.latestChecks[0].available, 2);
      assert.equal(mock.messages.length, 2);
      for (const item of mock.messages) {
        assert.equal(item.phone, "6281347890520");
        assert.ok(item.message.includes("```"));
      }
      const parsed = JSON.parse(
        mock.messages[0].message.split("```\n")[1].split("\n```")[0],
      );
      assert.equal(parsed.description, "Teks ``` contoh");
      await request("/monitor/check", "POST");
      assert.equal(mock.messages.length, 2);
    });
    test("failed delivery stays pending and succeeds on the next check", async () => {
      mock.projects = [{ id: 201, title: "Dummy retry" }];
      await importAndValidate();
      mock.failGowa = true;
      let check = await request("/monitor/check", "POST");
      assert.equal(check.data.latestChecks[0].status, "ERROR");
      assert.equal(check.data.latestChecks[0].available, 1);
      assert.equal(check.data.latestChecks[0].newProjects, 1);
      assert.equal(
        (await request("/logs/notifications")).data.items[0].status,
        "FAILED",
      );
      mock.failGowa = false;
      await request("/monitor/check", "POST");
      assert.equal(mock.messages.length, 1);
      assert.equal(
        (await request("/logs/notifications")).data.items[0].status,
        "SENT",
      );
    });
    test("an expired access token refreshes successfully without a false alarm", async () => {
      await importAndValidate();
      const refreshCount = mock.refreshCount;
      mock.access = "force-new-access-token";
      const result = await request("/monitor/check", "POST");
      assert.equal(result.data.latestChecks[0].status, "SUCCESS");
      assert.equal(mock.refreshCount, refreshCount + 1);
      assert.equal(mock.messages.length, 0);
    });
    test("stop cancels an in-flight request and remains stopped after backend restart", async () => {
      await importAndValidate();
      mock.slow = true;
      const count = mock.projectsCount;
      assert.equal((await request("/monitor/start", "POST")).status, 201);
      await waitFor(
        () => mock.projectsCount > count,
        "Scheduled request did not start",
      );
      const replacement = request("/session/cookie", "PUT", {
        cookieJson: cookieExport(),
      });
      await new Promise((resolve) => setTimeout(resolve, 35));
      const started = Date.now();
      const stopped = await request("/monitor/stop", "POST");
      assert.equal(stopped.status, 201);
      assert.ok(Date.now() - started < 2000);
      assert.equal(stopped.data.state.desiredRunning, false);
      assert.equal(stopped.data.state.busy, false);
      assert.equal((await replacement).status, 409);
      assert.equal(stopped.data.latestChecks[0].status, "CANCELLED");
      const before = mock.calls;
      await stopApi();
      await startApi();
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(mock.calls, before);
      assert.equal(
        (await request("/monitor/summary")).data.state.desiredRunning,
        false,
      );
    });
    test("a concurrent start and stop cannot leave a polling timer alive", async () => {
      await importAndValidate();
      const starting = request("/monitor/start", "POST");
      const stopping = request("/monitor/stop", "POST");
      assert.equal((await starting).status, 201);
      assert.equal((await stopping).status, 201);
      const before = mock.calls;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const summary = (await request("/monitor/summary")).data;
      assert.equal(summary.state.desiredRunning, false);
      assert.equal(summary.state.busy, false);
      assert.equal(summary.state.nextCheckAt, null);
      assert.equal(mock.calls, before);
    });
    test("auth outage alerts persist across restart and recovery is sent once", async () => {
      await importAndValidate();
      mock.authRejected = true;
      await request("/monitor/start", "POST");
      await waitFor(
        () => mock.messages.length === 1,
        "Auth alert was not sent",
      );
      assert.ok(mock.messages[0].message.includes("authentication_failed"));
      await stopApi();
      await startApi();
      await waitFor(
        async () =>
          (await request("/monitor/summary")).data.session.authStatus ===
          "INVALID",
        "Expected failed auth after restart",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(mock.messages.length, 1);
      await request("/monitor/stop", "POST");
      mock.authRejected = false;
      await request("/session/validate", "POST");
      await request("/monitor/check", "POST");
      await request("/monitor/check", "POST");
      assert.equal(mock.messages.length, 2);
      assert.ok(mock.messages[1].message.includes("authentication_recovered"));
    });
    test("configuration is validated, private URL targets rejected, and unknown fields refused", async () => {
      const malformed = await fetch(base + "/settings", {
        method: "PUT",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "content-type": "application/json",
        },
        body: "{",
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).message, "Body JSON tidak valid.");
      const settings = (await request("/monitor/summary")).data.config;
      const valid = {
        intervalSeconds: settings.intervalSeconds,
        phone: settings.phone,
        gowaUrl: settings.gowaUrl,
        gowaUsername: settings.gowaUsername,
        deviceId: settings.deviceId,
        authAlerts: true,
      };
      assert.equal(
        (await request("/settings", "PUT", { ...valid, intervalSeconds: 2 }))
          .status,
        400,
      );
      assert.equal(
        (
          await request("/settings", "PUT", {
            ...valid,
            gowaUrl: "http://169.254.169.254",
          })
        ).status,
        400,
      );
      assert.equal(
        (await request("/settings", "PUT", { ...valid, extra: "unknown" }))
          .status,
        400,
      );
      assert.equal((await request("/logs/checks?page=0")).status, 400);
    });
    test("connection checks and explicit test messages use saved GOWA configuration", async () => {
      assert.equal(
        (await request("/settings/gowa/check", "POST")).data.connected,
        true,
      );
      assert.equal(
        (await request("/settings/gowa/test-message", "POST")).status,
        201,
      );
      assert.equal(mock.messages.length, 1);
      assert.equal(mock.messages[0].phone, "6281347890520");
      assert.ok(mock.messages[0].message.includes('"dummy": true'));
    });
    test("audit logs exclude cookie, password, and upstream error bodies", async () => {
      await importAndValidate();
      mock.authRejected = true;
      await request("/monitor/check", "POST");
      const logs = JSON.stringify(
        (await pool.query('SELECT * FROM "EventLog"')).rows,
      );
      for (const secret of [
        mock.refresh,
        "mock-gowa-secret",
        password,
        "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
      ])
        assert.ok(!logs.includes(secret));
      assert.ok(logs.includes("TOKEN_REFRESHED"));
      assert.ok(logs.includes("HTTP_REQUEST"));
    });
  },
);
