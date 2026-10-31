// The tabs the user opens themselves, from a tab's page (its home, or +): a search or an address
// opens one, shown along the top of every page of the workspace, used as a taken-over tab is, and
// closed from its page. The boundary these tests hold: no action of the agent's reaches such a tab,
// nothing done in it is told to the agent, its cookies aren't the chats', and it's never handed to
// the agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as logins from "#shared/logins";
import { call as called, post, publicDir, seal, site, storage, tabConfig, tabState, vaultAddresses, world } from "./harness.mts";

const CHAT = "https://chat.example/";
site(CHAT, { title: "The chat's page", text: "What the agent opened" });
const MINE = "https://mine.example/";
site(MINE, {
  title: "Mine",
  text: "The user's own page: balance 1,234.56",
  fields: { e1: { type: "text", name: "Email", box: { x: 20, y: 100, w: 300, h: 40 } }, e2: { type: "password", name: "Password", box: { x: 20, y: 160, w: 300, h: 40 } } },
  onenter: "https://mine.example/home",
});
site("https://mine.example/home", { title: "Mine, signed in", text: "Signed in" });
site("https://html.duckduckgo.com/html/?q=export%20statements", { title: "DuckDuckGo", text: "Results" });
site("https://search.example/?q=export%20statements", { title: "Search", text: "Results" });

const tabsOf = (workspace: string): Record<string, { token: string }> => JSON.parse(fs.readFileSync(path.join(storage, "browser-lean", workspace, "tabs.json"), "utf8"));
const browserState = () =>
  (globalThis as unknown as Record<symbol, { browsers: Map<string, { holds: Map<string, { last: number }>; yours: Map<string, unknown>; tabs: Map<string, unknown> }> }>)[Symbol.for("anywherellm-suite.browser-lean.state")];
const pageAt = (url: string) => world.pages.filter((p) => p.url() === url).at(-1)! as unknown as { url(): string; fields: Record<string, { value?: string }>; context?: unknown; navs: string[] };

test("a search or an address on a tab's page opens a tab of the user's own, listed on every page, which the agent never reaches", async () => {
  const call = (args: Record<string, unknown>, thread: number | null = 1) => called(args, { workspace: "own", thread });
  await call({ action: "open", url: CHAT });
  post({ ev: "new", q: "mine.example", made: "m-1" }, { workspace: "own" });
  await call({ action: "guide" });

  const yours = tabsOf("own")["you-1"];
  assert.ok(yours, "the user's tab is named you-1, a name no chat's thread has");
  const chat = tabState("own");
  assert.deepEqual(
    chat.tabs.map((t: Record<string, unknown>) => [t.mine, t.agent, t.here, t.made, t.title]),
    [[false, true, true, null, "The chat's page"], [true, false, false, "m-1", "Mine"]],
    "the chat's tab, the agent's, then the user's own, found by the id its page gave",
  );
  assert.equal(chat.tabs[1].path, `${yours.token}.html`, "its page, beside this one");
  assert.equal(chat.mine, false);
  const mine = tabState("own", "you-1");
  assert.equal(mine.mine, true);
  assert.equal(mine.who, "user", "always the user's");
  assert.equal(mine.url, MINE, "a bare host opens over https");
  assert.equal(mine.need, null);
  assert.deepEqual(mine.tabs.map((t: { here: boolean }) => t.here), [false, true]);
  assert.ok(mine.sites.includes("mine.example") && mine.sites.includes("chat.example"), "Your sites: the open tabs' hosts");

  // Its own cookies: a context of its own, apart from the chats' tabs.
  assert.ok(pageAt(MINE).context, "in a browser context of its own");
  assert.equal(pageAt(CHAT).context, undefined, "the chat's tab in the browser's own");

  // Nothing of it reaches the agent: not its page, its name or its token.
  const read = await call({ action: "read" });
  assert.match(read, /What the agent opened/);
  assert.doesNotMatch(read, /mine\.example|balance|you-1/);
  assert.ok(!read.includes(yours.token), "no answer carries its token");
  // A thread that spells its name is a chat's thread like any other: it gets a tab of its own.
  const spelled = await called({ action: "open", url: CHAT }, { workspace: "own", thread: "you-1" as unknown as number });
  assert.match(spelled, /^Opened https:\/\/chat\.example\/ in this chat's tab\./);
  assert.equal(tabState("own", "you-1").url, MINE, "the user's tab is where it was");
  assert.equal(browserState().browsers.get("own")!.tabs.has("you-1"), false, "never among the chats' tabs");

  // The user uses it as a taken-over tab: types (a password sealed), and is offered to save the login.
  const opts = { workspace: "own", tab: "you-1" };
  post({ ev: "type", ref: "e1", text: "ada" }, opts);
  post({ ev: "type", ref: "e2", sealed: seal("pw-own-1", tabConfig("own", "you-1").pub), then: "Enter" }, opts);
  await call({ action: "guide" });
  assert.equal(tabState("own", "you-1").url, "https://mine.example/home", "typed into its page, Enter pressed");
  assert.deepEqual(tabState("own", "you-1").offer, { kind: "password", site: "mine.example", user: "ada" });
  post({ ev: "offer", save: true }, opts);
  await call({ action: "guide" });
  assert.ok(logins.list().some((l) => l.site === "mine.example" && l.user === "ada"));
  assert.equal(tabState("own").sites[0], "mine.example", "Your sites: a site with a saved login first");

  // Never handed to the agent, and its hold never lapses; nothing of it is noted for the agent.
  post({ ev: "give" }, opts);
  browserState().browsers.get("own")!.holds.get("you-1")!.last = 0;
  const after = await call({ action: "read" });
  assert.doesNotMatch(after, /handed it back|10 minutes|you-1|mine\.example/);
  assert.equal(tabState("own", "you-1").who, "user");

  // Closed from its page: gone from every page's tabs.
  post({ ev: "close" }, opts);
  await call({ action: "guide" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(publicDir, "browser-lean", `${yours.token}.json`), "utf8")), { closed: true });
  assert.deepEqual(tabState("own").tabs.map((t: { mine: boolean }) => t.mine), [false, false], "the two chats' tabs left");
  assert.equal(browserState().browsers.get("own")!.yours.size, 0);
});

test("a search uses SEARCH_URL, else DuckDuckGo; an address the fence refuses opens nothing and is said where it was asked", async () => {
  const call = (args: Record<string, unknown>, settings: Record<string, string> = {}) => called(args, { workspace: "own-search", settings });
  const opts = { workspace: "own-search" };
  await call({ action: "open", url: CHAT });
  post({ ev: "new", q: "export statements", made: "s-1" }, opts);
  await call({ action: "guide" });
  assert.equal(tabState("own-search", "you-1").url, "https://html.duckduckgo.com/html/?q=export%20statements");
  post({ ev: "new", q: "export statements", made: "s-2" }, opts);
  await call({ action: "guide" }, { SEARCH_URL: "https://search.example/?q={q}" });
  assert.equal(tabState("own-search", "you-2").url, "https://search.example/?q=export%20statements");

  post({ ev: "new", q: "http://192.168.1.20:8123", made: "s-3" }, opts);
  await call({ action: "guide" });
  assert.equal(tabState("own-search").msg.text, "http://192.168.1.20:8123 isn’t let through. Allow it in the Vault, under Addresses, then try again.");
  assert.equal(tabsOf("own-search")["you-3"], undefined, "no tab opened");
  assert.ok(vaultAddresses().refused.some((r) => r.origin === "http://192.168.1.20:8123"), "offered on the Vault, to let through");
  post({ ev: "new", q: "nowhere.example", made: "s-4" }, opts);
  await call({ action: "guide" });
  assert.match(tabState("own-search", "you-3").msg.text, /^Couldn’t open nowhere\.example\. Check the address, then try again\.$/);
});

test("a chat's tab: back and forward take it over first on its page, and closing it leaves the agent no page", async () => {
  const call = (args: Record<string, unknown>) => called(args, { workspace: "own-nav" });
  const opts = { workspace: "own-nav" };
  await call({ action: "open", url: CHAT });
  assert.deepEqual([tabState("own-nav").back, tabState("own-nav").forward], [true, false]);
  post({ ev: "nav", do: "forward" }, opts);
  await call({ action: "guide" });
  assert.equal(tabState("own-nav").msg.text, "Take over the tab first");
  post({ ev: "take" }, opts);
  post({ ev: "nav", do: "forward" }, opts);
  post({ ev: "give" }, opts);
  await call({ action: "guide" });
  assert.deepEqual(pageAt(CHAT).navs, ["forward"]);
  post({ ev: "close" }, opts);
  await call({ action: "guide" });
  assert.match(await call({ action: "read" }), /^Browser: this chat has no page open: open an address first\.$/);
});

test("at most 8 tabs of the user's own in a workspace's browser", async () => {
  const call = (args: Record<string, unknown>) => called(args, { workspace: "own-many" });
  const opts = { workspace: "own-many" };
  await call({ action: "open", url: CHAT });
  for (let i = 0; i < 9; i++) post({ ev: "new", q: "mine.example", made: `n-${i}` }, opts);
  await call({ action: "guide" });
  assert.equal(browserState().browsers.get("own-many")!.yours.size, 8);
  assert.equal(tabState("own-many").msg.text, "You have 8 tabs of your own open. Close one, then try again.");
});
