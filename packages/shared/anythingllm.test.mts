import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chatOf, perBuild, perProcess, serial } from "./anythingllm.mts";

// serial's order (one key at a time, other keys alongside, a failure not stopping the next) is
// tested through inTurn, which is built on it (pages.test.mts).

test("serial drops a key once its calls are done, so keys don't pile up", async () => {
  const queues = perProcess("serial", () => new Map<string, unknown>());
  const failed = serial("gone", () => Promise.reject(new Error("no")));
  const next = serial("gone", () => "ran");
  assert.ok(queues.has("gone"), "kept while calls wait");
  await assert.rejects(failed, /no/);
  assert.equal(await next, "ran");
  await sleep(0);
  assert.ok(!queues.has("gone"), "the key is gone");
});

test("a cache kept per build is one value for its build, apart from what perProcess keeps by that key", () => {
  const made = perBuild("test.cache", () => ({ n: 1 }));
  assert.equal(perBuild("test.cache", () => ({ n: 2 })), made, "made once in a build");
  assert.notEqual(perProcess("test.cache", () => ({ n: 3 })), made, "an earlier build's entry under the plain key isn't read");
  assert.equal(perProcess("test.cache source", () => ({ n: 4 })), made, "unbundled, the build is the sources'");
});

test("a call's chat is its workspace and thread, by AnythingLLM's invocation; shown by the workspace's name", () => {
  const at = (invocation: unknown) => chatOf({ super: { handlerProps: { invocation } } } as never);
  assert.deepEqual(at({ workspace: { slug: "home", name: "Household" }, thread_id: 7 }), { key: "home#7", where: "Household" }, "a thread of AnythingLLM's web UI");
  assert.deepEqual(at({ workspace: { slug: "home", name: "Household" }, thread_id: null }), { key: "home", where: "Household" }, "the workspace's default chat");
  assert.deepEqual(at({ workspace: { slug: "home", name: "Household" }, workspace_id: 1 }), { key: "home", where: "Household" }, "the developer API's agent: no thread");
  assert.deepEqual(at({ workspace: { slug: "home" }, thread_id: 2 }), { key: "home#2", where: "home" }, "no name: its slug");
  assert.deepEqual(at({ workspace: { slug: "home", name: "  Two\n words  " } }), { key: "home", where: "Two words" });
  assert.deepEqual(at({ workspace: null }), { key: "", where: "" }, "a scheduled job's");
  assert.deepEqual(chatOf(undefined), { key: "", where: "" });
});
