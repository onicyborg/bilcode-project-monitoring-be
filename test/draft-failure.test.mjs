import { test } from "node:test";
import assert from "node:assert/strict";
import { draftFailure } from "../dist/draft-failure.js";
import { UpstreamError } from "../dist/upstream.js";
test("draft failures distinguish causes without exposing raw errors", () => {
  const cases = [
    [
      new Error("Waktu pengerjaan tersisa kurang dari satu hari."),
      "DEADLINE_TOO_CLOSE",
    ],
    [
      new Error(
        "Deadline proyek belum jelas; pengajuan otomatis tidak tersedia.",
      ),
      "DEADLINE_INVALID",
    ],
    [new DOMException("secret", "TimeoutError"), "AI_TIMEOUT"],
    [new DOMException("secret", "AbortError"), "DRAFT_CANCELLED"],
    [new SyntaxError("secret"), "AI_OUTPUT_INVALID"],
    [new Error("Invalid AI duration"), "AI_OUTPUT_INVALID"],
    [new Error("Invalid AI classification"), "AI_OUTPUT_INVALID"],
    [new TypeError("fetch failed"), "AI_CONNECTION_FAILED"],
    [new Error("AI key missing"), "AI_NOT_CONFIGURED"],
    [
      new UpstreamError("secret", false, 401, "AI_REQUEST_FAILED"),
      "AI_AUTH_FAILED",
    ],
    [
      new UpstreamError("secret", false, 429, "AI_REQUEST_FAILED"),
      "AI_RATE_LIMITED",
    ],
    [
      new UpstreamError("secret", false, 503, "AI_REQUEST_FAILED"),
      "AI_REQUEST_FAILED",
    ],
    [new Error("secret"), "DRAFT_FAILED"],
  ];
  for (const [error, code] of cases) {
    const result = draftFailure(error);
    assert.ok(result.startsWith(`[${code}]`), result);
    assert.ok(!result.includes("secret"));
  }
  assert.match(draftFailure(new Error("secret"), true), /DRAFT_CANCELLED/);
});

test("prepare persists safe failure guidance and discovery does not retry a failed draft", async () => {
  const { Bids } = await import("../dist/bids.js");
  let draft;
  let calls = 0;
  const db = {
    bidProject: {
      findUniqueOrThrow: async () => ({ projectId: 1, payload: { id: 1 } }),
    },
    bidDraft: {
      findUnique: async () => draft,
      upsert: async ({ create }) => {
        draft = { ...create };
        return draft;
      },
      update: async ({ data }) => {
        Object.assign(draft, data);
        return draft;
      },
    },
  };
  const bids = new Bids(db, {}, {});
  bids.generate = async () => {
    calls++;
    throw new DOMException("private provider response", "TimeoutError");
  };
  const signal = new AbortController().signal;
  await assert.rejects(bids.prepare(1, signal));
  assert.equal(draft.state, "FAILED");
  assert.match(draft.lastError, /AI_TIMEOUT/);
  assert.ok(!draft.lastError.includes("private provider response"));
  await bids.prepare(1, signal);
  assert.equal(calls, 1);
});
