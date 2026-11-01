// A tab that closed keeps its page's frame: its state says it closed, with the workspace's open tabs
// and its sites, and for a while its page may ask for one thing, a tab of the user's own, as an open
// tab's page does; the browser is launched again for it if it closed too. These tests hold what such
// a page may not do: anything else, with another tab's key or another secret, once its time is up, or
// once its chat's thread opened a tab again.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { postEvent } from "#shared/test-helpers";
import { call as called, post, publicDir, site, storage, tabConfig, tabState } from "./harness.mts";

const CHAT = "https://chat.example/";
site(CHAT, { title: "The chat's page", text: "What the agent opened" });
const OTHER = "https://other.example/";
site(OTHER, { title: "Another chat's page", text: "Elsewhere" });
site("https://mine.example/", { title: "Mine", text: "The user's own page" });

const HOURS_2 = 2 * 60 * 60 * 1000;
const file = (token: string, ending: string) => path.join(publicDir, "browser-lean", `${token}${ending}`);
const stateAt = (token: string): Record<string, any> => JSON.parse(fs.readFileSync(file(token, ".json"), "utf8"));
const tabsOf = (workspace: string): Record<string, { token: string }> => JSON.parse(fs.readFileSync(path.join(storage, "browser-lean", workspace, "tabs.json"), "utf8"));
const browsers = () =>
  (globalThis as unknown as Record<symbol, { browsers: Map<string, { yours: Map<string, unknown>; timer: NodeJS.Timeout | null }> }>)[Symbol.for("anywherellm-suite.browser-lean.state")].browsers;
type Cfg = ReturnType<typeof tabConfig>;
/** What a page posts with its settings `cfg`, kept from before its tab closed (harness post reads them
 *  from tabs.json, which no longer has them). */
const postAs = (cfg: Cfg, event: Record<string, unknown>) => postEvent(storage, "browser-lean-event", { browser_lean_event: 1, workspace: cfg.workspace, tab: cfg.tab, secret: cfg.secret, ...event });
/** A search or an address asked for on a tab's page, now by AnythingLLM's clock. */
const asked = (q: string, made: string) => ({ ev: "new", q, made, at: Date.now() });
const made = (st: Record<string, any>) => (st.tabs as { made: string | null }[]).map((t) => t.made);

test("a chat's tab closed from its page keeps its frame, and its page opens a tab of the user's own and nothing else", async () => {
  const call = (args: Record<string, unknown>, thread = 2) => called(args, { workspace: "shut", thread });
  await call({ action: "open", url: CHAT }, 1);
  await call({ action: "open", url: OTHER });
  const one = tabConfig("shut", "1");
  const two = tabConfig("shut", "2");
  post({ ev: "close" }, { workspace: "shut", tab: "1" });
  await call({ action: "guide" });

  const closed = stateAt(one.token);
  assert.equal(closed.closed, true);
  assert.ok(closed.until > Date.now() + HOURS_2 - 60_000 && closed.until <= Date.now() + HOURS_2, "its page may ask for two hours");
  assert.deepEqual(closed.tabs.map((t: { path: string; agent: boolean }) => [t.path, t.agent]), [[`${two.token}.html`, true]], "the other chat's tab along the top");
  assert.ok(closed.sites.includes("chat.example") && closed.sites.includes("other.example"), "Your sites: its own, and the open tabs'");
  assert.equal(typeof closed.vault, "string", "the Vault's link, for Logins");
  assert.equal(closed.msg, null);
  assert.ok(fs.existsSync(file(one.token, ".html")), "its page stays, so it opens again with its frame");
  assert.ok(!fs.existsSync(file(one.token, ".jpg")) && !fs.existsSync(file(one.token, "-card.jpg")), "its pictures are gone");
  assert.equal(tabsOf("shut")["1"], undefined, "its names are dropped: the next tab gets new ones");

  // Nothing but `new`: with another tab's key, the closed page's secret closes nothing.
  postAs({ ...one, tab: "2" }, { ev: "close" });
  postAs(one, { ev: "close" });
  postAs(one, { ev: "take" });
  // Another secret, a request from before a restart (or none said when), another tab's key: no tab.
  postAs({ ...one, secret: "x".repeat(one.secret.length) }, asked("mine.example", "c-forged"));
  postAs(one, { ...asked("mine.example", "c-stale"), at: Date.now() - 5 * 60 * 1000 });
  postAs(one, { ev: "new", q: "mine.example", made: "c-untimed" });
  postAs({ ...one, tab: "2" }, asked("mine.example", "c-other"));
  await call({ action: "guide" });
  assert.equal(tabState("shut", "2").url, OTHER, "the other chat's tab is open still");
  assert.equal(browsers().get("shut")!.yours.size, 0, "no tab of the user's own");

  postAs(one, asked("mine.example", "c-1"));
  await call({ action: "guide" });
  assert.deepEqual(made(stateAt(one.token)), [null, "c-1"], "the closed page finds its tab along the top by the id it gave");
  assert.deepEqual(made(tabState("shut", "2")), [null, "c-1"], "on every page of the workspace");
  const mine = tabState("shut", "you-1");
  assert.equal(mine.url, "https://mine.example/");
  assert.equal(mine.mine, true);

  // What can't be opened is said on the closed page that asked.
  postAs(one, asked("http://10.1.2.3/", "c-fenced"));
  await call({ action: "guide" });
  assert.match(stateAt(one.token).msg.text, /^http:\/\/10\.1\.2\.3 isn’t let through\. Allow it in the Vault, under Addresses/);
  assert.deepEqual(made(stateAt(one.token)), [null, "c-1"], "nothing opened");

  // Its chat's thread opens a tab again: the page is replaced, and the old one asks for nothing.
  await call({ action: "open", url: CHAT }, 1);
  assert.notEqual(tabConfig("shut", "1").token, one.token, "new names");
  assert.deepEqual(stateAt(one.token), { closed: true }, "the old page's state says only that it closed");
  assert.ok(!fs.existsSync(file(one.token, ".html")), "and its page is gone");
  postAs(one, asked("mine.example", "c-replaced"));
  await call({ action: "guide" });
  assert.ok(!made(tabState("shut", "2")).includes("c-replaced"));
});

test("past its time, a closed tab's page asks for nothing, and its state says only that it closed", async () => {
  const call = (args: Record<string, unknown>, thread = 2) => called(args, { workspace: "shut-late", thread });
  await call({ action: "open", url: CHAT }, 1);
  await call({ action: "open", url: OTHER });
  const one = tabConfig("shut-late", "1");
  post({ ev: "close" }, { workspace: "shut-late", tab: "1" });
  await call({ action: "guide" });
  const kept = path.join(storage, "browser-lean", "shut-late", "closed.json");
  const closed = JSON.parse(fs.readFileSync(kept, "utf8"));
  assert.deepEqual(Object.keys(closed), [one.token]);
  assert.equal(closed[one.token].secret, one.secret, "its secret kept in the storage, as tabs.json keeps an open tab's");
  closed[one.token].until = Date.now() - 1; // two hours on
  fs.writeFileSync(kept, JSON.stringify(closed));
  postAs(one, asked("mine.example", "l-1"));
  await call({ action: "read" });
  assert.deepEqual(stateAt(one.token), { closed: true });
  assert.ok(!fs.existsSync(file(one.token, ".html")));
  assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")), {}, "forgotten");
  assert.equal(browsers().get("shut-late")!.yours.size, 0);
});

test("a tab whose browser closed, past its idle time or as AnythingLLM restarted, opens one with the browser launched again", async () => {
  await called({ action: "open", url: CHAT }, { workspace: "idle" });
  const idle = tabConfig("idle", "1");
  for (const other of ["idle-2", "idle-3", "idle-4"]) await called({ action: "open", url: OTHER }, { workspace: other }); // past 3 browsers, the oldest closes
  assert.equal(browsers().has("idle"), false, "its browser closed");
  const closed = stateAt(idle.token);
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.tabs, [], "no tab left along the top");
  assert.ok(closed.sites.includes("chat.example"), "its own site, to go back to");
  postAs(idle, asked("mine.example", "i-1"));
  await called({ action: "guide" }, { workspace: "idle-4" });
  assert.equal(browsers().get("idle")?.yours.size, 1, "the browser launched again, with the user's tab");
  assert.deepEqual(made(stateAt(idle.token)), ["i-1"]);

  // AnythingLLM restarted: no browser, nothing written, the names still kept and the state as it was.
  await called({ action: "open", url: CHAT }, { workspace: "restart" });
  const gone = tabConfig("restart", "1");
  const forget = () => {
    const entry = browsers().get("restart")!;
    clearTimeout(entry.timer ?? undefined);
    browsers().delete("restart");
  };
  forget();
  // Its time isn't out: a tab that may be another process's (a scheduled job's) is left as it is.
  postAs(gone, asked("mine.example", "r-early"));
  await called({ action: "guide" }, { workspace: "idle-4" });
  assert.equal(tabsOf("restart")["1"].token, gone.token, "its names kept");
  assert.equal(stateAt(gone.token).closed, undefined);
  assert.equal(browsers().has("restart"), false, "no browser launched");
  // Its time out, as a restart leaves it: taken for closed then, and its page opens a tab.
  const until = Date.now() - 60_000;
  fs.writeFileSync(file(gone.token, ".json"), JSON.stringify({ ...stateAt(gone.token), until }));
  postAs(gone, asked("mine.example", "r-1"));
  await called({ action: "guide" }, { workspace: "idle-4" });
  const now = stateAt(gone.token);
  assert.equal(now.closed, true);
  assert.equal(now.until, until + HOURS_2, "two hours from when its browser would have closed");
  assert.deepEqual(made(now), ["r-1"]);
  assert.equal(tabsOf("restart")["1"], undefined, "its names dropped");
});
