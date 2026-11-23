import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import dotenv from "dotenv";
import { JwtService } from "@nestjs/jwt";
import pg from "pg";
import { safeResponse } from "../dist/bid-response.js";

const base = "http://127.0.0.1:4101/api";
const origin = "http://localhost:3100";
const password = "integration-test-password-2026";
const key = "17".repeat(32);
const config = dotenv.parse(readFileSync(".env"));
const databaseUrl = new URL(config.DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)) {
  throw new Error(
    "Integration tests require local PostgreSQL, never the Neon application database.",
  );
}
databaseUrl.pathname = "/bilcode_monitoring_integration_test";
const testUrl = databaseUrl.toString();
let pool;
let processApi;
let output = "";
let cookie;
let accessToken;
const jwt = new JwtService();
const accessSecret = "31".repeat(32);
const refreshSecret = "41".repeat(32);
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
    bids: [],
    bidPosts: [],
    aiCalls: 0,
    malformedAi: false,
    ambiguousBid: false,
    malformedBids: false,
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
      ...(withAuth && accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : {}),
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
      DIRECT_DATABASE_URL: testUrl,
      API_PORT: "4101",
      APP_ORIGIN: origin,
      ADMIN_USERNAME: "test-operator",
      ADMIN_PASSWORD: password,
      ENCRYPTION_KEY: key,
      JWT_ACCESS_SECRET: accessSecret,
      JWT_REFRESH_SECRET: refreshSecret,
      INITIAL_GOWA_PASSWORD: "mock-gowa-secret",
      BILCODE_API_URL: `http://127.0.0.1:${upstreamPort}/api`,
      GOWA_ALLOWED_HOSTS: "127.0.0.1",
      ALLOW_LOCAL_UPSTREAM: "true",
      NODE_ENV: "test",
      VIKEY_API_KEY: "mock-ai-secret",
      TEST_VIKEY_URL: `http://127.0.0.1:${upstreamPort}/v1`,
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
        if (
          ["/api/auth/send-otp-email", "/api/auth/verify-otp-email"].includes(
            url.pathname,
          )
        ) {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          if (body.email !== "operator@example.com")
            return json(res, 400, {
              message: "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
            });
          if (url.pathname.endsWith("send-otp-email"))
            return json(res, 200, { message: "Sent" });
          if (body.code !== "123456")
            return json(res, 422, {
              message: "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
            });
          if (mock.noOtpCookie)
            return json(res, 200, { access_token: mock.access });
          return json(
            res,
            200,
            { access_token: mock.access },
            {
              "set-cookie": `bilcode_refresh_token=${mock.refresh}; Path=/; HttpOnly`,
            },
          );
        }
        if (url.pathname === "/v1/chat/completions") {
          mock.aiCalls++;
          if (mock.aiStatus)
            return json(res, mock.aiStatus, {
              message: "Model API key invalid. Bearer mock-ai-secret",
            });
          if (mock.slowAi) {
            const timer = setTimeout(() => json(res, 503, {}), 4000);
            res.on("close", () => clearTimeout(timer));
            return;
          }
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          assert.equal(body.model, "deepseek/deepseek-v4.1-flash-1017");
          assert.equal(body.messages.length, 2);
          assert.equal(body.messages[0].role, "system");
          assert.match(
            body.messages[0].content,
            /Humanizer-zh, adaptasi bahasa Indonesia/,
          );
          assert.match(
            body.messages[0].content,
            /Kontrak JSON.*lebih tinggi daripada aturan gaya/,
          );
          assert.match(
            body.messages[0].content,
            /Pertahankan setiap kebutuhan yang berbeda/,
          );
          assert.equal(body.messages[1].role, "user");
          assert.equal(req.headers.authorization, "Bearer mock-ai-secret");
          assert.ok(!raw.includes(mock.refresh));
          const proposal = {
            proposed_amount: 999999,
            estimated_days: 2,
            proposal:
              "Saya siap membantu mengembangkan lingkup yang dijelaskan dan menguji hasilnya.",
            worker_analysis: {
              features: ["Landing Page — Profil usaha"],
              tech_stack: ["React"],
              estimated_days: 2,
              technical_notes: "Integrasi mengikuti API yang tersedia.",
              client_clarifications: "Mohon konfirmasi desain dan konten.",
              additional_notes: "Tidak termasuk fitur di luar lingkup.",
            },
          };
          return json(res, 200, {
            choices: [
              {
                message: {
                  content: mock.malformedAi
                    ? "invalid-json"
                    : JSON.stringify(proposal),
                },
              },
            ],
          });
        }
        if (url.pathname === "/api/worker/my-bids") {
          if (mock.forbiddenBids)
            return json(res, 403, {
              message: "Riwayat bid tidak dapat diakses.",
            });
          if (
            mock.authRejected ||
            req.headers.authorization !== `Bearer ${mock.access}`
          )
            return json(res, 401, {});
          if (mock.malformedBids)
            return json(res, 200, { bids: { data: [], last_page: "invalid" } });
          const page = Number(url.searchParams.get("page"));
          return json(res, 200, {
            bids: {
              data: mock.bids.slice((page - 1) * 15, page * 15),
              last_page: Math.max(1, Math.ceil(mock.bids.length / 15)),
            },
          });
        }
        const bidMatch = /^\/api\/worker\/projects\/(\d+)\/bid$/.exec(
          url.pathname,
        );
        if (bidMatch) {
          if (
            mock.authRejected ||
            req.headers.authorization !== `Bearer ${mock.access}`
          )
            return json(res, 401, {});
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const payload = JSON.parse(raw);
          mock.bidPosts.push(payload);
          assert.equal(req.headers.accept, "application/json");
          if (mock.rejectBidStatus)
            return json(res, mock.rejectBidStatus, {
              code: mock.omitBidErrorCode ? undefined : "BID_REQUEST_REJECTED",
              message:
                mock.bidErrorMessage || "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
              errors: {
                "worker_analysis.tech_stack.0": [
                  mock.bidFieldMessage ||
                    "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
                ],
                secret: [mock.refresh],
              },
            });
          if (mock.unknownBid) {
            res.destroy();
            return;
          }
          const project = mock.projects.find(
            (p) => p.id === Number(bidMatch[1]),
          );
          mock.bids.push({
            id: 310 + mock.bids.length,
            project_id: Number(bidMatch[1]),
            status: "applied",
            project: { id: Number(bidMatch[1]), title: project.title },
          });
          project.has_applied = true;
          if (mock.ambiguousBid) {
            res.destroy();
            return;
          }
          return json(res, 200, { message: "Success" });
        }
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
        {
          env: {
            ...process.env,
            DATABASE_URL: testUrl,
            DIRECT_DATABASE_URL: testUrl,
          },
          encoding: "utf8",
        },
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
      accessToken = login.data.access_token;
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
      await pool.query(
        'TRUNCATE "BidAttempt", "BidStatusEvent", "BidApplication", "BidProject", "BidSyncState", "Notification", "CheckRun", "EventLog"',
      );
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
    test("issues 15-minute access JWTs and rejects expired, tampered and refresh tokens as bearer", async () => {
      const claims = jwt.verify(accessToken, { secret: accessSecret });
      assert.equal(claims.exp - claims.iat, 900);
      const original = accessToken;
      const payload = { sid: claims.sid, purpose: "access" };
      accessToken = jwt.sign(payload, {
        secret: accessSecret,
        issuer: "bilcode-project-monitoring",
        audience: "monitor-access",
        subject: "test-operator",
        expiresIn: -1,
      });
      assert.equal((await request("/auth/me")).status, 401);
      accessToken = original.slice(0, -8) + "tampered";
      assert.equal((await request("/auth/me")).status, 401);
      accessToken = cookie.split("=")[1];
      assert.equal((await request("/auth/me")).status, 401);
      accessToken = original;
      assert.equal((await request("/auth/me")).status, 200);
    });
    test("rotates refresh tokens once, stores hashes and survives an expired access token", async () => {
      const oldCookie = cookie;
      const oldAccess = accessToken;
      accessToken = "expired";
      const refreshed = await request("/auth/refresh", "POST");
      assert.equal(refreshed.status, 201);
      assert.equal(refreshed.data.expires_in, 900);
      assert.match(refreshed.headers.get("cache-control"), /no-store/);
      const header = refreshed.headers.get("set-cookie");
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=Strict/i);
      assert.match(header, /Path=\/api\/auth/i);
      const newCookie = header.split(";")[0];
      assert.notEqual(newCookie, oldCookie);
      assert.equal((await request("/auth/refresh", "POST")).status, 401);
      cookie = newCookie;
      accessToken = refreshed.data.access_token;
      assert.equal((await request("/auth/me")).status, 200);
      const claims = jwt.verify(accessToken, { secret: accessSecret });
      const session = await pool.query(
        'SELECT * FROM "AdminRefreshSession" WHERE "id"=$1',
        [claims.sid],
      );
      assert.match(session.rows[0].tokenHash, /^[a-f0-9]{64}$/);
      assert.ok(
        !JSON.stringify(session.rows).includes(newCookie.split("=")[1]),
      );
      assert.equal(jwt.decode(oldAccess).sid, claims.sid);
    });
    test("allows independent panel logins, atomic refresh and immediate logout revocation", async () => {
      const other = await request(
        "/auth/login",
        "POST",
        { username: "test-operator", password },
        false,
      );
      assert.equal(other.status, 201);
      assert.equal((await request("/auth/me")).status, 200);
      const otherCookie = other.headers.get("set-cookie").split(";")[0];
      const responses = await Promise.all(
        [1, 2].map(() =>
          fetch(base + "/auth/refresh", {
            method: "POST",
            headers: { Origin: origin, Cookie: otherCookie },
          }),
        ),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 401]);
      const winner = responses.find((r) => r.status === 201);
      const nextCookie = winner.headers.get("set-cookie").split(";")[0];
      const nextTokens = await winner.json();
      const logout = await fetch(base + "/auth/logout", {
        method: "POST",
        headers: { Origin: origin, Cookie: nextCookie },
      });
      assert.equal(logout.status, 201);
      const denied = await fetch(base + "/auth/me", {
        headers: { Authorization: `Bearer ${nextTokens.access_token}` },
      });
      assert.equal(denied.status, 401);
      const deniedRefresh = await fetch(base + "/auth/refresh", {
        method: "POST",
        headers: { Origin: origin, Cookie: nextCookie },
      });
      assert.equal(deniedRefresh.status, 401);
      assert.equal((await request("/auth/me")).status, 200);
      assert.equal(
        (
          await request(
            "/auth/refresh",
            "POST",
            undefined,
            true,
            "https://other.example",
          )
        ).status,
        403,
      );
    });
    test("rejects an expired refresh session even with a valid signed refresh JWT", async () => {
      const other = await request(
        "/auth/login",
        "POST",
        { username: "test-operator", password },
        false,
      );
      const sid = jwt.decode(other.data.access_token).sid;
      await pool.query(
        'UPDATE "AdminRefreshSession" SET "expiresAt"=NOW() - INTERVAL \'1 second\' WHERE "id"=$1',
        [sid],
      );
      const denied = await fetch(base + "/auth/refresh", {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: other.headers.get("set-cookie").split(";")[0],
        },
      });
      assert.equal(denied.status, 401);
    });
    test("email OTP login protects existing sessions, validates inputs, encrypts credentials and never sends projects", async () => {
      assert.equal(
        (await request("/session/otp/request", "POST", { email: "invalid" }))
          .status,
        400,
      );
      assert.equal(
        (
          await request(
            "/session/otp/request",
            "POST",
            { email: "operator@example.com" },
            false,
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await request("/session/otp/verify", "POST", {
            email: "operator@example.com",
            code: "123456",
          })
        ).status,
        400,
      );
      await importAndValidate();
      await request("/monitor/start", "POST");
      assert.equal(
        (
          await request("/session/otp/request", "POST", {
            email: "operator@example.com",
          })
        ).status,
        409,
      );
      await request("/monitor/stop", "POST");
      const old = (
        await pool.query('SELECT "refreshTokenEncrypted" FROM "BilcodeSession"')
      ).rows[0].refreshTokenEncrypted;
      assert.equal(
        (
          await request("/session/otp/request", "POST", {
            email: "operator@example.com",
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await request("/session/otp/request", "POST", {
            email: "operator@example.com",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/session/otp/verify", "POST", {
            email: "another@example.com",
            code: "123456",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/session/otp/verify", "POST", {
            email: "operator@example.com",
            code: "000000",
          })
        ).status,
        400,
      );
      mock.noOtpCookie = true;
      assert.equal(
        (
          await request("/session/otp/verify", "POST", {
            email: "operator@example.com",
            code: "123456",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT "refreshTokenEncrypted" FROM "BilcodeSession"',
          )
        ).rows[0].refreshTokenEncrypted,
        old,
      );
      mock.noOtpCookie = false;
      assert.equal(
        (
          await request("/session/otp/verify", "POST", {
            email: "operator@example.com",
            code: "123456",
          })
        ).status,
        201,
      );
      const saved = (await pool.query('SELECT * FROM "BilcodeSession"'))
        .rows[0];
      assert.equal(saved.authStatus, "UNVERIFIED");
      assert.equal(decrypt(saved.refreshTokenEncrypted), mock.refresh);
      assert.equal(
        (
          await request("/session/otp/verify", "POST", {
            email: "operator@example.com",
            code: "123456",
          })
        ).status,
        400,
      );
      assert.equal((await request("/monitor/start", "POST")).status, 400);
      assert.equal((await request("/session/validate", "POST")).status, 201);
      assert.equal(mock.messages.length, 0);
      const logs = JSON.stringify(
        (await pool.query('SELECT * FROM "EventLog"')).rows,
      );
      for (const secret of [
        "operator@example.com",
        "123456",
        mock.refresh,
        "PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK",
      ])
        assert.ok(!logs.includes(secret));
    });
    test("limits OTP attempts and requires a new request after a backend restart", async () => {
      await stopApi();
      await startApi();
      assert.equal(
        (
          await request("/session/otp/request", "POST", {
            email: "operator@example.com",
          })
        ).status,
        201,
      );
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await request("/session/otp/verify", "POST", {
              email: "operator@example.com",
              code: "000000",
            })
          ).status,
          400,
        );
      assert.equal(
        (
          await request("/session/otp/verify", "POST", {
            email: "operator@example.com",
            code: "123456",
          })
        ).status,
        400,
      );
      assert.equal(
        (await request("/monitor/summary")).data.session.hasCookie,
        false,
      );
      await stopApi();
      await startApi();
      assert.equal(
        (
          await request("/session/otp/verify", "POST", {
            email: "operator@example.com",
            code: "123456",
          })
        ).status,
        400,
      );
    });
    const sampleProject = () => ({
      id: 611,
      title: "Website UMKM",
      description: "Landing page dan integrasi chatbot dari tim AI.",
      status: "published",
      has_applied: false,
      deadline: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
      client_id: 999,
      lead_source: "private-test-source",
    });
    async function prepareBid() {
      mock.projects = [sampleProject()];
      await importAndValidate();
      assert.equal((await request("/bids/refresh", "POST")).status, 201);
      return (await request("/bids")).data.projects.find(
        (p) => p.projectId === 611,
      );
    }
    test("bid discovery requires authentication and never generates or submits without confirmation", async () => {
      const p = await prepareBid();
      assert.equal(
        (await request("/bids", "GET", undefined, false)).status,
        401,
      );
      assert.equal(mock.aiCalls, 0);
      assert.equal(mock.bidPosts.length, 0);
      assert.equal(
        (
          await request("/bids/projects/611/submit", "POST", {
            version: p.version,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/bids/projects/611/submit", "POST", {
            version: p.version,
            confirmed: false,
          })
        ).status,
        400,
      );
      mock.projects[0].description = "Lingkup baru";
      assert.equal(
        (
          await request("/bids/projects/611/submit", "POST", {
            version: p.version,
            confirmed: true,
          })
        ).status,
        409,
      );
      assert.equal(mock.aiCalls, 0);
    });
    test("one confirmation generates a validated AI proposal and submits only once", async () => {
      const p = await prepareBid();
      const result = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(result.status, 201);
      assert.equal(result.data.state, "CONFIRMED");
      assert.equal(result.data.status, "applied");
      assert.equal(mock.aiCalls, 1);
      assert.equal(mock.bidPosts.length, 1);
      assert.equal(mock.bidPosts[0].proposed_amount, 0);
      assert.equal(
        mock.bidPosts[0].estimated_days,
        mock.bidPosts[0].worker_analysis.estimated_days,
      );
      assert.equal(
        (
          await request("/bids/projects/611/submit", "POST", {
            version: p.version,
            confirmed: true,
          })
        ).status,
        409,
      );
      assert.equal(mock.bidPosts.length, 1);
      assert.equal(mock.messages.length, 1);
      await request("/bids/refresh", "POST");
      assert.equal(mock.messages.length, 1);
      const text = JSON.stringify(
        (await pool.query('SELECT * FROM "EventLog"')).rows,
      );
      assert.ok(!text.includes("mock-ai-secret"));
      assert.ok(!text.includes("Saya siap membantu"));
    });
    test("invalid AI output never sends a bid and requires a fresh explicit confirmation to retry", async () => {
      const p = await prepareBid();
      mock.malformedAi = true;
      const failed = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(failed.data.state, "FAILED");
      assert.equal(mock.bidPosts.length, 0);
      mock.malformedAi = false;
      const success = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(success.data.state, "CONFIRMED");
      assert.equal(mock.bidPosts.length, 1);
    });
    test("a lost bid response reconciles using my-bids without sending another POST", async () => {
      const p = await prepareBid();
      mock.ambiguousBid = true;
      const result = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(result.data.state, "CONFIRMED");
      assert.equal(mock.bidPosts.length, 1);
      await stopApi();
      await startApi();
      await request("/bids/refresh", "POST");
      assert.equal(mock.bidPosts.length, 1);
      assert.equal(
        (await request("/bids")).data.applications[0].status,
        "applied",
      );
    });
    test("a forbidden bid is recorded as rejected without refreshing or logging out a valid Bilcode session", async () => {
      const p = await prepareBid();
      const rotations = mock.refreshCount;
      mock.rejectBidStatus = 403;
      const r = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(r.status, 201);
      assert.equal(r.data.state, "FAILED");
      assert.equal(r.data.upstreamId, null);
      assert.match(r.data.lastError, /POST_BID.*HTTP 403/);
      assert.equal(mock.refreshCount, rotations);
      assert.equal(mock.bidPosts.length, 1);
      assert.equal(mock.bids.length, 0);
      assert.equal(
        (await request("/monitor/summary")).data.session.authStatus,
        "VALID",
      );
      assert.equal(mock.messages.length, 0);
      const log = JSON.stringify((await request("/logs/events")).data);
      assert.ok(log.includes("BID_REJECTED"));
      assert.ok(log.includes("HTTP 403"));
      assert.ok(!log.includes("PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK"));
      assert.ok(!log.includes(mock.refresh));
    });
    test("Bilcode skill mismatch is explained without expiring the session or changing the worker profile", async () => {
      const p = await prepareBid();
      mock.rejectBidStatus = 403;
      mock.omitBidErrorCode = true;
      mock.bidErrorMessage =
        "Bidang keahlian Anda tidak sesuai dengan kebutuhan proyek ini (Diagram & Sistem).";
      const rotations = mock.refreshCount;
      const r = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(r.data.state, "FAILED");
      assert.ok(
        r.data.lastError.includes("Bidang keahlian akun Bilcode tidak sesuai"),
      );
      assert.ok(r.data.lastError.includes("BID_SKILL_MISMATCH"));
      assert.ok(!r.data.lastError.includes("Diagram & Sistem"));
      assert.equal(mock.refreshCount, rotations);
      assert.equal(mock.bidPosts.length, 1);
      assert.equal(mock.bids.length, 0);
      assert.equal(
        (await request("/monitor/summary")).data.session.authStatus,
        "VALID",
      );
    });
    test("bid responses retain actionable validation with redacted credentials and keep failed attempts after a successful retry", async () => {
      const p = await prepareBid();
      mock.rejectBidStatus = 422;
      mock.bidErrorMessage = `Teknologi tidak tersedia. Bearer ${mock.access}; bilcode_refresh_token=${mock.refresh}; password=private-password-123`;
      mock.bidFieldMessage = `Pilih teknologi dari daftar. ${mock.access}`;
      await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      const first = await request("/bids/projects/611/attempts?page=1&limit=1");
      assert.equal(first.status, 200);
      assert.equal(first.data.total, 1);
      const result = first.data.items[0];
      assert.equal(result.outcome, "FAILED");
      assert.equal(result.phase, "POST_BID");
      assert.equal(result.httpStatus, 422);
      assert.equal(result.postHttpStatus, 422);
      assert.ok(result.message.includes("Teknologi tidak tersedia"));
      assert.ok(
        result.response.errors["worker_analysis.tech_stack.0"][0].includes(
          "Pilih teknologi",
        ),
      );
      assert.ok(result.action.includes("field"));
      const serialized = JSON.stringify(first.data);
      for (const secret of [mock.access, mock.refresh, "private-password-123"])
        assert.ok(!serialized.includes(secret));
      assert.ok(!Object.hasOwn(result.response.errors, "secret"));
      mock.rejectBidStatus = 0;
      await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      const latest = (
        await request("/bids/projects/611/attempts?page=1&limit=1")
      ).data;
      assert.equal(latest.total, 2);
      assert.equal(latest.pages, 2);
      assert.equal(latest.items[0].outcome, "CONFIRMED");
      assert.equal(latest.items[0].httpStatus, 200);
      assert.equal(latest.items[0].response.message, "Success");
      await stopApi();
      await startApi();
      const old = (await request("/bids/projects/611/attempts?page=2&limit=1"))
        .data;
      assert.equal(old.items[0].id, result.id);
      assert.equal(old.items[0].outcome, "FAILED");
      const dashboard = (await request("/bids")).data.applications[0];
      assert.equal(dashboard._count.attempts, 2);
      assert.equal(dashboard.attempts.length, 1);
      const before = mock.calls;
      await request("/bids/projects/611/attempts?page=1&limit=5");
      assert.equal(mock.calls, before);
      assert.equal(
        (await request("/bids/projects/611/attempts", "GET", undefined, false))
          .status,
        401,
      );
      assert.equal((await request("/bids/projects/nope/attempts")).status, 400);
    });
    test("a failed precheck is saved with guidance and never calls AI or submits a bid", async () => {
      const p = await prepareBid();
      mock.forbiddenBids = true;
      const r = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(r.status, 400);
      const history = (await request("/bids/projects/611/attempts")).data;
      assert.equal(history.total, 1);
      assert.equal(history.items[0].phase, "PRECHECK");
      assert.equal(history.items[0].httpStatus, 403);
      assert.equal(history.items[0].postHttpStatus, null);
      assert.equal(mock.aiCalls, 0);
      assert.equal(mock.bidPosts.length, 0);
      assert.equal(
        (await request("/monitor/summary")).data.session.authStatus,
        "VALID",
      );
    });
    test("an AI provider auth failure has AI guidance and never invalidates the Bilcode session", async () => {
      const p = await prepareBid();
      mock.aiStatus = 401;
      const r = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(r.data.state, "FAILED");
      const result = (await request("/bids/projects/611/attempts")).data
        .items[0];
      assert.equal(result.phase, "AI");
      assert.equal(result.httpStatus, 401);
      assert.equal(result.code, "AI_REQUEST_FAILED");
      assert.ok(result.action.includes("AI"));
      assert.ok(!result.action.includes("OTP"));
      assert.ok(!JSON.stringify(result).includes("mock-ai-secret"));
      assert.equal(mock.bidPosts.length, 0);
      assert.equal(
        (await request("/monitor/summary")).data.session.authStatus,
        "VALID",
      );
    });
    test("response sanitization ignores arbitrary data, bounds messages, and masks request and environment secrets", () => {
      const original = process.env.VIKEY_API_KEY;
      process.env.VIKEY_API_KEY = "test-provider-private-key-123";
      try {
        const body = {
          message: `Cek profil. test-provider-private-key-123 access-cookie-123 basic-password-123 ${"a".repeat(80)} eyJabc.def.ghi`,
          errors: {
            proposal: ["Perbaiki proposal.", true, { token: "leak" }],
            password: ["ignore"],
          },
          data: { token: "ignore" },
          stack: "ignore",
        };
        const result = safeResponse(body, {
          headers: {
            Cookie: "session=access-cookie-123",
            Authorization:
              "Basic " +
              Buffer.from("user:basic-password-123").toString("base64"),
          },
        });
        const serialized = JSON.stringify(result);
        assert.ok(result.message.includes("Cek profil"));
        for (const secret of [
          "test-provider-private-key-123",
          "access-cookie-123",
          "basic-password-123",
          "a".repeat(80),
          "eyJabc.def.ghi",
        ])
          assert.ok(!serialized.includes(secret));
        assert.deepEqual(Object.keys(result).sort(), ["errors", "message"]);
        assert.deepEqual(result.errors.proposal, ["Perbaiki proposal."]);
        assert.ok(
          safeResponse({ message: "x".repeat(3000) }, {}).message.length <=
            1000,
        );
        assert.deepEqual(safeResponse("<html>secret</html>", {}), {});
      } finally {
        if (original === undefined) delete process.env.VIKEY_API_KEY;
        else process.env.VIKEY_API_KEY = original;
      }
    });
    test("invalid bid fields are reported without exposing upstream bodies and require a new confirmation", async () => {
      const p = await prepareBid();
      mock.rejectBidStatus = 422;
      const r = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(r.data.state, "FAILED");
      assert.match(r.data.lastError, /HTTP 422/);
      assert.ok(r.data.lastError.includes("worker_analysis.tech_stack.0"));
      assert.ok(
        !r.data.lastError.includes("PRIVATE_UPSTREAM_DETAIL_MUST_NOT_LEAK"),
      );
      assert.ok(!r.data.lastError.includes("secret"));
      assert.equal(mock.bidPosts.length, 1);
      await request("/bids/refresh", "POST");
      assert.equal(mock.bidPosts.length, 1);
      assert.equal(
        (await request("/monitor/summary")).data.session.authStatus,
        "VALID",
      );
    });
    test("an actual unauthorized bid still refreshes once and marks the upstream session invalid", async () => {
      const p = await prepareBid();
      const rotations = mock.refreshCount;
      mock.rejectBidStatus = 401;
      const r = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(r.status, 400);
      assert.equal(mock.refreshCount, rotations + 1);
      assert.equal(mock.bids.length, 0);
      assert.equal(
        (await request("/monitor/summary")).data.session.authStatus,
        "INVALID",
      );
      assert.equal(
        (await request("/bids")).data.applications[0].state,
        "FAILED",
      );
    });
    test("existing manual bids are baselined across every page and status notifications survive gateway failure and restart", async () => {
      await importAndValidate();
      mock.bids = Array.from({ length: 16 }, (_, i) => ({
        id: 100 + i,
        project_id: 1000 + i,
        status: "applied",
        project: { title: "Manual " + i },
      }));
      assert.equal((await request("/bids/refresh", "POST")).status, 201);
      assert.equal((await request("/bids")).data.applicationTotal, 16);
      assert.equal(mock.messages.length, 0);
      mock.bids[15].status = "accepted";
      mock.failGowa = true;
      assert.equal((await request("/bids/refresh", "POST")).status, 201);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM "BidStatusEvent" WHERE "sentAt" IS NULL',
          )
        ).rows[0].n,
        1,
      );
      await stopApi();
      await startApi();
      mock.failGowa = false;
      await request("/bids/refresh", "POST");
      assert.equal(mock.messages.length, 1);
      assert.ok(mock.messages[0].message.includes("accepted"));
      assert.ok(mock.messages[0].message.includes("applied"));
      await request("/bids/refresh", "POST");
      assert.equal(mock.messages.length, 1);
      mock.bids = [];
      await request("/bids/refresh", "POST");
      assert.equal((await request("/bids")).data.applicationTotal, 16);
      assert.equal(mock.messages.length, 1);
    });
    test("an unresolved POST stays blocked across restart until my-bids confirms it", async () => {
      const p = await prepareBid();
      mock.unknownBid = true;
      const result = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(result.data.state, "UNKNOWN");
      await stopApi();
      await startApi();
      const retry = await request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      assert.equal(retry.status, 409);
      assert.equal(mock.bidPosts.length, 1);
      assert.equal(mock.aiCalls, 1);
      mock.bids = [
        {
          id: 310,
          project_id: 611,
          status: "applied",
          project: { title: "Website UMKM" },
        },
      ];
      await request("/bids/refresh", "POST");
      assert.equal(
        (await request("/bids")).data.applications[0].state,
        "CONFIRMED",
      );
      assert.equal(mock.bidPosts.length, 1);
    });
    test("stop cancels AI generation before any bid POST", async () => {
      const p = await prepareBid();
      mock.slowAi = true;
      const submission = request("/bids/projects/611/submit", "POST", {
        version: p.version,
        confirmed: true,
      });
      await waitFor(() => mock.aiCalls === 1, "AI not started");
      await request("/monitor/stop", "POST");
      assert.equal((await submission).data.state, "FAILED");
      assert.equal(mock.bidPosts.length, 0);
      const history = (await request("/bids/projects/611/attempts")).data;
      assert.equal(history.items[0].code, "OPERATION_CANCELLED");
      assert.ok(
        history.items[0].action.includes("dihentikan sebelum pengiriman"),
      );
      assert.equal(
        (await request("/monitor/summary")).data.state.desiredRunning,
        false,
      );
    });
    test("monitoring checks bid changes even when no new projects exist", async () => {
      await importAndValidate();
      mock.bids = [
        {
          id: 310,
          project_id: 611,
          status: "applied",
          project: { title: "Website UMKM" },
        },
      ];
      await request("/bids/refresh", "POST");
      mock.bids[0].status = "rejected";
      assert.equal((await request("/monitor/start", "POST")).status, 201);
      await waitFor(
        () => mock.messages.length === 1,
        "No bid status notification",
      );
      await request("/monitor/stop", "POST");
      assert.ok(mock.messages[0].message.includes("rejected"));
      assert.equal(mock.aiCalls, 0);
      assert.equal(mock.bidPosts.length, 0);
    });
    test("malformed bid listings preserve the last known status and do not produce a change notification", async () => {
      await importAndValidate();
      mock.bids = [
        {
          id: 1,
          project_id: 611,
          status: "applied",
          project: { title: "Website" },
        },
      ];
      await request("/bids/refresh", "POST");
      mock.malformedBids = true;
      assert.equal((await request("/bids/refresh", "POST")).status, 400);
      const d = (await request("/bids")).data;
      assert.equal(d.applications[0].status, "applied");
      assert.ok(d.sync.lastError);
      assert.equal(mock.messages.length, 0);
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
    test("a stop after an acknowledged start clears polling and persisted running state", async () => {
      await importAndValidate();
      assert.equal((await request("/monitor/start", "POST")).status, 201);
      assert.equal((await request("/monitor/stop", "POST")).status, 201);
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
