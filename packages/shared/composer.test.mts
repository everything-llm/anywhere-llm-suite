// The composer Apps' Comment and the browser's chat bar share (composer.js): the message the agent
// reads, with and without picks; what a tap does to the picks (at most 5, a password field refused);
// what goes on AnywhereLLM's channel and what it answers; and the composer itself, expanded and
// collapsed, on a stand-in document. Both pages carry this same file (build.mjs's PAGE_LIBRARIES).

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { houseBlock, staticFiles } from "../build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const C = createRequire(import.meta.url)("./composer.js");
const source = fs.readFileSync(path.join(here, "composer.js"), "utf8");

const pick = (n: number, more: Record<string, unknown> = {}) => ({ key: `e${n}`, chip: `button “B${n}”`, line: `[e${n}] button "B${n}"`, ...more });

test("the message: the line naming the page, a numbered line per pick, then the words; without picks, the line and the words", () => {
  assert.equal(C.message("About the browser tab Example Bank (examplebank.com):", [pick(12), pick(30)], "  Which one exports them?  "), 'About the browser tab Example Bank (examplebank.com):\n1. [e12] button "B12"\n2. [e30] button "B30"\n\nWhich one exports them?');
  assert.equal(C.message("Comment on my Reading app's page (apps-lean app `reading`):", [], "Make it bigger"), "Comment on my Reading app's page (apps-lean app `reading`):\n\nMake it bigger");
});

test("picks: up to 5, a pick tapped again unpicked and the rest numbered on, a sixth refused, a password field refused", () => {
  let picks: unknown[] = [];
  for (const n of [1, 2, 3, 4, 5]) ({ picks } = C.toggle(picks, pick(n)));
  assert.equal(picks.length, 5);
  const sixth = C.toggle(picks, pick(6));
  assert.equal(sixth.picks, picks, "a sixth changes nothing");
  assert.match(sixth.refused, /5 already/);
  const unpicked = C.toggle(picks, pick(2));
  assert.equal(unpicked.refused, null);
  assert.deepEqual(unpicked.picks.map((p: { key: string }) => p.key), ["e1", "e3", "e4", "e5"]);
  const secret = C.toggle([], pick(9, { secret: true }));
  assert.deepEqual([secret.picks, secret.refused], [[], "A password field can’t be picked."]);
  assert.equal(C.MAX, 5);
  assert.equal(C.LIMIT, 1000);
});

test("the channel: a comment for the chat open, or for a thread; opening a chat; nothing more, as Lite parses strictly", () => {
  assert.deepEqual(JSON.parse(C.payload("home", "Hi")), { comment: { workspace: "home", message: "Hi" } }, "Apps: no thread, the chat AnywhereLLM has open");
  assert.equal(C.payload("home", "Hi", "export-my-statements"), '{"comment":{"workspace":"home","thread":"export-my-statements","message":"Hi"}}');
  assert.equal(C.payload("home", "Hi", null), '{"comment":{"workspace":"home","message":"Hi"}}', "a tab with no thread: no thread, never a null one");
  assert.equal(C.opening("home", "t1"), '{"open":{"workspace":"home","thread":"t1"}}');
  assert.equal(C.opening("home", null), '{"open":{"workspace":"home"}}', "no thread: the main chat");
});

/** A window with AnywhereLLM's channel as Lite gives it (an androidx WebMessageListener: postMessage,
 *  and its reply as a message event on the channel), which answers each message with `answer` (a
 *  JSON string; none: silence). `older`: replies the way an older AnywhereLLM did, on the window. */
function stand(answer: string | null, { older = false, onmessage = false } = {}) {
  const on = (bag: Map<string, Set<(e: unknown) => void>>) => ({
    addEventListener: (type: string, fn: (e: unknown) => void) => void bag.set(type, (bag.get(type) ?? new Set()).add(fn)),
    removeEventListener: (type: string, fn: (e: unknown) => void) => void bag.get(type)?.delete(fn),
  });
  const own = new Map<string, Set<(e: unknown) => void>>(), windows = new Map<string, Set<(e: unknown) => void>>();
  const posted: string[] = [];
  const channel: Record<string, any> = {
    postMessage(m: string) {
      posted.push(m);
      if (answer === null) return;
      setTimeout(() => {
        if (older) [...(windows.get("anywherellm-comment") ?? [])].forEach((fn) => fn({ detail: JSON.parse(answer) }));
        else if (onmessage) channel.onmessage?.({ data: answer });
        else {
          [...(own.get("message") ?? [])].forEach((fn) => fn({ data: "not a reply" }));
          [...(own.get("message") ?? [])].forEach((fn) => fn({ data: answer }));
        }
      }, 5);
    },
    ...(onmessage ? {} : on(own)),
  };
  const win = { AnywhereLLMApps: channel, ...on(windows) };
  return { win, posted, listening: () => (own.get("message")?.size ?? 0) + (windows.get("anywherellm-comment")?.size ?? 0) + (channel.onmessage ? 1 : 0) };
}

test("delivering: posted on the channel, its reply awaited (chat or error); silence and a message past 8 KB are failures that say why", async () => {
  const ok = stand('{"ok":true,"chat":"Export my statements"}');
  assert.deepEqual(await C.deliver(ok.win, '{"comment":{}}'), { ok: true, chat: "Export my statements" });
  assert.deepEqual(ok.posted, ['{"comment":{}}']);
  assert.equal(ok.listening(), 0, "it stops listening");
  assert.deepEqual(await C.deliver(stand('{"ok":false,"error":"That chat is gone."}').win, "{}"), { ok: false, why: "That chat is gone." });
  const onmessage = stand('{"ok":true,"chat":"Main"}', { onmessage: true });
  assert.deepEqual(await C.deliver(onmessage.win, "{}"), { ok: true, chat: "Main" }, "a channel with onmessage alone");
  assert.equal(onmessage.listening(), 0, "its onmessage put back");
  assert.deepEqual(await C.deliver(stand('{"ok":true}', { older: true }).win, "{}"), { ok: true, chat: undefined }, "an older AnywhereLLM's word, on the window");
  const silent = stand(null);
  assert.deepEqual(await C.deliver(silent.win, "{}", 20), { ok: false, why: "AnywhereLLM didn’t answer. Try again in a moment." });
  assert.equal(silent.listening(), 0);
  const big = stand('{"ok":true}');
  assert.deepEqual(await C.deliver(big.win, "x".repeat(C.MAX_BYTES + 1)), { ok: false, why: "It’s too long to send. Make it shorter." });
  assert.deepEqual(big.posted, [], "not posted");
  assert.equal(C.channel({}), null, "a page opened outside AnywhereLLM has none");
  assert.equal(C.channel(ok.win), ok.win.AnywhereLLMApps);
  assert.equal((await C.deliver({}, "{}")).ok, false);
  // The most a message holds still fits: 1000 characters of words and 5 picks.
  const longest = C.payload("w".repeat(60), C.message("About the browser tab " + "t".repeat(200) + " (" + "h".repeat(300) + "):", [1, 2, 3, 4, 5].map((n) => pick(n, { line: `[e${n}] input[email] "${"n".repeat(80)}"` })), "é".repeat(1000)), "s".repeat(60));
  assert.ok(new TextEncoder().encode(longest).length < C.MAX_BYTES, "under 8 KB");
});

// ---- A stand-in document: elements with children, text, attributes, events that bubble, and focus.
class Node {
  parentNode: El | null = null;
  text: string;
  constructor(text = "") { this.text = text; }
  get textContent() { return this.text; }
}
class El extends Node {
  tagName: string;
  kids: Node[] = [];
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  value = "";
  html = "";
  scrollHeight = 0;
  listeners = new Map<string, ((e: unknown) => void)[]>();
  [key: string]: any;
  doc: Doc;
  constructor(doc: Doc, tag: string) {
    super();
    this.doc = doc;
    this.tagName = tag.toUpperCase();
  }
  get ownerDocument() { return this.doc; }
  get hidden() { return this.attrs.has("hidden"); }
  set hidden(on: boolean) { on ? this.attrs.set("hidden", "") : this.attrs.delete("hidden"); }
  get disabled() { return this.attrs.has("disabled"); }
  set disabled(on: boolean) { on ? this.attrs.set("disabled", "") : this.attrs.delete("disabled"); }
  get placeholder() { return this.attrs.get("placeholder") ?? ""; }
  set innerHTML(markup: string) { this.html = markup; this.kids = []; }
  get innerHTML() { return this.html; }
  get textContent(): string { return this.kids.map((k) => k.textContent).join(""); }
  set textContent(t: string) { this.kids = []; this.append(t); }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  append(...kids: (Node | string)[]) {
    for (const k of kids) {
      const n = typeof k === "string" ? new Node(k) : k;
      n.parentNode = this;
      this.kids.push(n);
    }
  }
  replaceChildren(...kids: (Node | string)[]) { this.kids = []; this.append(...kids); }
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  find(test: (el: El) => boolean): El[] { return this.all().filter(test); }
  addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  dispatch(type: string, extra: Record<string, unknown> = {}) {
    const e = { type, target: this, preventDefault() {}, ...extra };
    for (let at: El | null = this; at; at = at.parentNode) for (const fn of at.listeners.get(type) ?? []) fn(e);
  }
  click() { if (!this.disabled) this.dispatch("click"); }
  focus() { this.doc.activeElement = this; this.dispatch("focus"); }
  setSelectionRange() {}
  /** Shown: neither it nor any element it's in is hidden. */
  get shown(): boolean { for (let at: El | null = this; at; at = at.parentNode) if (at.hidden) return false; return true; }
}
class Doc {
  activeElement: El | null = null;
  createElement(tag: string) { return new El(this, tag); }
}
const words = (el: El): string => (el.tagName === "DIV" ? el.children.map(words).join(" ") : el.textContent.replace(/\s+/g, " ").trim());
const byClass = (root: El, name: string) => root.find((e) => (e.getAttribute("class") ?? "").split(" ").includes(name));
const byAct = (root: El, act: string) => root.find((e) => e.getAttribute("data-a") === act);
const shownOf = (els: El[]) => els.filter((e) => e.shown);
const type = (field: El, text: string) => ((field.value = text), field.dispatch("input"));

test("expanded: a label over the multi-line field, Point at the page and Send, off while nothing is written; the picks as numbered chips", async () => {
  const doc = new Doc();
  const root = doc.createElement("div");
  const sent: unknown[] = [];
  const told: unknown[] = [];
  const c = C.make(root, { label: "Comment on Reading", placeholder: "Ask a question or describe a change", state: "expanded", hint: "It goes to the chat as your message.", onPicks: (p: unknown[]) => told.push(p.length), onSend: async (text: string, picks: unknown[]) => (sent.push([text, picks.length]), { ok: true }) });
  assert.equal(root.children[0].tagName, "STYLE", "its look, once");
  C.make(root, { label: "Another" });
  assert.equal(root.children.filter((e) => e.tagName === "STYLE").length, 1, "one style for every composer in a root");
  const box = root.children[1];
  const area = byClass(box, "cp-area")[0];
  assert.equal(area.tagName, "TEXTAREA");
  assert.equal(area.getAttribute("rows"), "3");
  assert.equal(area.getAttribute("maxlength"), "1000");
  assert.equal(area.placeholder, "Ask a question or describe a change");
  assert.equal(words(byClass(box, "cp-label")[0]), "Comment on Reading");
  assert.equal(byClass(box, "cp-label")[0].getAttribute("for"), area.getAttribute("id"));
  assert.ok(area.shown && !byClass(box, "cp-row")[0].shown, "expanded: the multi-line field, not the one line");
  assert.deepEqual(shownOf(byAct(box, "point")).map(words), ["Point at the page"]);
  const send = shownOf(byAct(box, "send"))[0];
  assert.equal(words(send), "Send");
  assert.ok(send.disabled, "Send is off while the field is empty");
  assert.equal(words(byClass(box, "cp-said")[0]), "It goes to the chat as your message.");
  type(area, "   ");
  assert.ok(send.disabled, "and while it holds only spaces");
  type(area, "Make these bigger");
  assert.ok(!send.disabled);
  assert.equal(c.pick({ key: "a", chip: "counter “Pages today”", line: "`button`, part `counter`" }), null);
  assert.equal(c.pick({ key: "b", chip: "stat “5 day streak”", line: "`div`, part `stat`" }), null);
  assert.deepEqual(byClass(box, "cp-pick").map(words), ["1 · counter “Pages today”", "2 · stat “5 day streak”"]);
  assert.equal(byClass(box, "cp-picks")[0].getAttribute("aria-label"), "2 picked on the page");
  const removes = byAct(box, "remove");
  assert.deepEqual(removes.map((b) => b.getAttribute("aria-label")), ["Remove 1, counter Pages today", "Remove 2, stat 5 day streak"]);
  removes[0].click();
  assert.deepEqual(byClass(box, "cp-pick").map(words), ["1 · stat “5 day streak”"], "the numbers close up");
  assert.equal(doc.activeElement, byAct(box, "remove")[0], "the focus on the next chip's ×");
  send.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [["Make these bigger", 1]]);
  assert.equal(area.value, "", "sent: the field and the picks are cleared");
  assert.deepEqual([byClass(box, "cp-pick").length, told.at(-1)], [0, 0]);
});

test("a send that fails keeps the words and the picks and says why; one at a time", async () => {
  const doc = new Doc();
  const root = doc.createElement("div");
  let answer = (_: unknown) => {};
  let calls = 0;
  const c = C.make(root, { label: "Comment on Reading", state: "expanded", hint: "It goes to the chat.", onSend: () => (calls++, new Promise((r) => (answer = r))) });
  const box = root.children[1];
  type(byClass(box, "cp-area")[0], "Hello");
  c.pick(pick(1));
  const send = shownOf(byAct(box, "send"))[0];
  send.click();
  assert.ok(send.disabled, "off while it's sending");
  send.click();
  await c.send();
  assert.equal(calls, 1, "one tap sends once");
  answer({ ok: false, why: "AnywhereLLM didn’t answer. Try again in a moment." });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(words(byClass(box, "cp-said")[0]), "Not sent: AnywhereLLM didn’t answer. Try again in a moment.");
  assert.equal(byClass(box, "cp-said")[0].getAttribute("role"), "alert");
  assert.deepEqual([c.text, c.picks.length], ["Hello", 1], "kept for another try");
  assert.ok(!send.disabled);
});

test("collapsed: Point, the one-line field and a round Send; pointing says how many of 5 with Done; a tray shows that line alone", () => {
  const doc = new Doc();
  const root = doc.createElement("div");
  const points: boolean[] = [];
  const expands: boolean[] = [];
  const c = C.make(root, { label: "Message the agent", placeholder: "Message the agent", state: "collapsed", onPoint: (on: boolean) => points.push(on), onExpand: (on: boolean) => expands.push(on) });
  const box = root.children[1];
  const input = byClass(box, "cp-input")[0];
  assert.ok(input.shown && !byClass(box, "cp-area")[0].shown && !byClass(box, "cp-actions")[0].shown);
  assert.equal(input.getAttribute("aria-label"), "Message the agent");
  const point = shownOf(byAct(box, "point"))[0];
  assert.equal(point.getAttribute("aria-label"), "Point at the page");
  assert.equal(point.getAttribute("aria-pressed"), "false");
  assert.equal(shownOf(byAct(box, "send"))[0].getAttribute("aria-label"), "Send");
  point.click();
  assert.deepEqual([c.pointing, points, point.getAttribute("aria-pressed")], [true, [true], "true"]);
  const mode = byClass(box, "cp-mode")[0];
  assert.ok(mode.shown);
  assert.equal(words(mode), "Tap up to 5 things on the page · 0 of 5 Done");
  for (const n of [1, 2]) c.pick(pick(n));
  assert.match(words(mode), /· 2 of 5/);
  assert.equal(c.pick(pick(3, { secret: true })), "A password field can’t be picked.");
  assert.match(words(mode), /^A password field can’t be picked\. 2 of 5/, "said where the user looks");
  assert.ok(input.shown, "the field stays in view while pointing");
  byAct(box, "done")[0].click();
  assert.deepEqual([c.pointing, points], [false, [true, false]]);
  input.focus();
  assert.deepEqual(expands, [true], "tapping into the field asks to expand it");
  c.expand(true, false);
  assert.ok(byClass(box, "cp-area")[0].shown && !input.shown);
  assert.equal(box.getAttribute("data-state"), "expanded");

  const tray = C.make(root, { label: "Comment on Reading", state: "expanded", tray: true });
  const sheet = root.children[2];
  tray.point(true);
  assert.deepEqual(shownOf(sheet.all()).map(words), ["Tap up to 5 things on the page · 0 of 5 Done", "Tap up to 5 things on the page · 0 of 5", "Done"], "in a tray, the mode line and Done alone");
  tray.point(false);
  assert.ok(byClass(sheet, "cp-area")[0].shown, "Done brings the composer back");
});

test("its look is House UI's tokens and buttons, and it's in both pages as this file", () => {
  const house = houseBlock(fs.readFileSync(path.join(here, "vault.html"), "utf8"));
  const defined = new Set(house.match(/--[a-z0-9-]+(?=:)/g));
  const used = [...C.CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m: RegExpMatchArray) => m[1]);
  assert.deepEqual([...new Set(used.filter((t: string) => !defined.has(t)))], [], "only House UI's tokens");
  assert.doesNotMatch(C.CSS, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i, "no colours of its own");
  assert.match(source, /hu-button hu-button--primary/);
  assert.match(source, /hu-button hu-button--secondary/);
  for (const skill of ["apps", "browser"]) assert.equal(staticFiles(path.join(here, "..", "skills", skill, "static"), skill)["composer.js"], source, `${skill}'s pages carry it`);
  assert.match(fs.readFileSync(path.join(here, "..", "skills", "browser", "static", "pages", "tab.html"), "utf8"), /<script>\/\*COMPOSER\*\/<\/script>\n<script>/, "the tab's page, ahead of its own script");
  assert.match(fs.readFileSync(path.join(here, "..", "skills", "apps", "src", "page.ts"), "utf8"), /HOST_SCRIPTS = \["composer\.js", "runtime-lean\.js"/, "an app's page, ahead of the runtime");
});
