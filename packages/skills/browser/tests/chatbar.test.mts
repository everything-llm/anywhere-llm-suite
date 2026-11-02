// What the chat bar on a chat's tab reads from its state: the elements in view with the refs the
// agent's read gives them (`targets`, which a tap resolves to), and the chat the tab belongs to
// (`thread`, the AnythingLLM thread's slug, and its name), read from AnythingLLM's thread model by
// the id the invocation gave. The user's own tabs have neither, and the tabs sheet tells them apart.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { call, post, publicDir, site, tabConfig, tabState } from "./harness.mts";

const BANK = "https://bank.example/";
site(BANK, {
  title: "Example Bank",
  text: "Statements",
  fields: {
    e1: { type: "text", name: "Email", box: { x: 20, y: 100, w: 300, h: 40 } },
    e2: { type: "password", name: "Password", box: { x: 20, y: 160, w: 300, h: 40 } },
    e3: { kind: "button", name: "Sign in", box: { x: 20, y: 220, w: 120, h: 44 } },
  },
});

// A stand-in for AnythingLLM's server folder, with its thread model: thread 42 is "Export my statements".
const server = fs.mkdtempSync(path.join(os.tmpdir(), "browser-lean-server-"));
after(() => fs.rmSync(server, { recursive: true, force: true }));
fs.mkdirSync(path.join(server, "models"));
fs.writeFileSync(path.join(server, "models", "workspaceThread.js"), `const asked = (globalThis.threadsAsked = []);
module.exports.WorkspaceThread = { get: async ({ id }) => (asked.push(id), id === 42 ? { id, slug: "export-my-statements", name: "Export my statements", workspace_id: 1 } : null) };\n`);

test("a chat's tab: the elements in view by their refs, and its chat, from AnythingLLM's thread model", async () => {
  const was = process.env.ANYTHINGLLM_SERVER_DIR;
  process.env.ANYTHINGLLM_SERVER_DIR = server;
  try {
    const read = await call({ action: "open", url: BANK }, { workspace: "talk", thread: 42 });
    const state = tabState("talk", "42");
    assert.deepEqual(state.targets, [
      { ref: "e1", role: "input[text]", text: "Email", x: 20, y: 100, w: 300, h: 40 },
      { ref: "e2", role: "input[password]", text: "Password", x: 20, y: 160, w: 300, h: 40 },
      { ref: "e3", role: "button", text: "Sign in", x: 20, y: 220, w: 120, h: 44 },
    ]);
    for (const t of state.targets) assert.ok(read.includes(`[${t.ref}] ${t.role} "${t.text}"`), `the read names ${t.ref} as the chat bar does`);
    assert.deepEqual([state.thread, state.chat], ["export-my-statements", "Export my statements"]);
    // The name is kept a while: the next draw doesn't ask again.
    const asked = (globalThis as unknown as { threadsAsked: number[] }).threadsAsked.length;
    await call({ action: "read" }, { workspace: "talk", thread: 42 });
    assert.equal((globalThis as unknown as { threadsAsked: number[] }).threadsAsked.length, asked);

    // A thread AnythingLLM doesn't know, and a chat with no thread (the developer API's): no chat to name.
    await call({ action: "open", url: BANK }, { workspace: "talk", thread: 7 });
    assert.deepEqual([tabState("talk", "7").thread, tabState("talk", "7").chat], [null, null]);
    await call({ action: "open", url: BANK }, { workspace: "talk", thread: null });
    assert.deepEqual([tabState("talk", "_").thread, tabState("talk", "_").chat], [null, null]);
    assert.equal(tabState("talk", "_").targets.length, 3, "its targets all the same");
  } finally {
    if (was === undefined) delete process.env.ANYTHINGLLM_SERVER_DIR;
    else process.env.ANYTHINGLLM_SERVER_DIR = was;
  }
});

test("outside AnythingLLM there's no thread model: no chat named, and the page still draws", async () => {
  await call({ action: "open", url: BANK }, { workspace: "alone", thread: 43 });
  assert.deepEqual([tabState("alone", "43").thread, tabState("alone", "43").chat], [null, null]);
});

test("the user's own tab has no targets and no chat, and the tabs sheet tells the chats' tabs from the user's", async () => {
  await call({ action: "open", url: BANK }, { workspace: "mixed" });
  post({ ev: "new", q: "bank.example", made: "own-1" }, { workspace: "mixed" });
  await call({ action: "guide" }, { workspace: "mixed" });
  const chat = tabState("mixed");
  const own = chat.tabs.find((t: { made: string | null }) => t.made === "own-1");
  assert.ok(own, `the user's tab is listed: ${JSON.stringify(chat.tabs)}`);
  assert.deepEqual(chat.tabs.map((t: { mine: boolean }) => t.mine), [false, true]);
  const mine = tabState("mixed", "you-1");
  assert.equal(mine.mine, true);
  assert.deepEqual([mine.targets, mine.thread, mine.chat], [[], null, null]);
});

test("the tab's page as written carries the composer its chat bar shares with Apps' Comment", async () => {
  await call({ action: "open", url: BANK }, { workspace: "page" });
  const html = fs.readFileSync(path.join(publicDir, "browser-lean", `${tabConfig("page").token}.html`), "utf8");
  assert.ok(!html.includes("/*COMPOSER*/"), "the placeholder is filled");
  assert.ok(html.indexOf("var AnywhereComposer") > 0 && html.indexOf("var AnywhereComposer") < html.indexOf("const cfg = "), "ahead of the page's own script");
  assert.equal(html.split("</script>").length - 1, 2, "no inlined text ends a script early");
});
