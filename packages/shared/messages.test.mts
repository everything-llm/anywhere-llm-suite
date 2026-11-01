// The pages' messages: a toast says what was just done, for 6 s or 2 s and 0.7 s a word, and one with
// Undo stays until it's acted on; an error, or what to do about one, is a banner near the top that
// stays until it's closed. Every page carries the same block, script and style, as shared/vault.html
// has them. The script runs here on a stand-in document and a stand-in clock.

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const PAGES = ["./vault.html", "../skills/apps/static/pages/manager.html", "../skills/browser/static/pages/tab.html", "../skills/library/static/pages/library.html"];
const read = (page: string): string => fs.readFileSync(fileURLToPath(new URL(page, import.meta.url)), "utf8");
const script = (html: string): string => /  \/\* page messages:[\s\S]*?\/\* end of page messages \*\//.exec(html)?.[0] ?? "";
const style = (html: string): string => /\/\* page messages:[^\n]*\n[^\n]*\*\/\n#toast[\s\S]*?\/\* end of page messages \*\//.exec(html)?.[0] ?? "";
const BLOCK = script(read(PAGES[0]));
const STYLE = style(read(PAGES[0]));

test("vault.html has both blocks", () => {
  assert.ok(BLOCK.includes("function toast(") && BLOCK.includes("function banner("));
  assert.ok(STYLE.includes("#toast:empty") && STYLE.includes("#banners>div"));
});

for (const page of PAGES) {
  test(`${page.split("/").pop()}: the messages blocks are vault.html's, and the toast is never hidden`, () => {
    const html = read(page);
    assert.equal(script(html), BLOCK, "the same script as vault.html");
    assert.equal(style(html), STYLE, "the same style as vault.html");
    const own = html.slice(html.lastIndexOf("<script>"), html.lastIndexOf("</script>"));
    assert.ok(own.includes(BLOCK), "in the page's own script");
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    assert.ok(css.includes(STYLE), "in the page's own style");
    assert.equal(html.match(/<div id="toast"[^>]*>/g)?.join(), '<div id="toast" role="status">', "one toast, a live region in the page from the start, never hidden");
    assert.equal(html.match(/<div id="banners"[^>]*>/g)?.length, 1, "a place for banners");
    const rest = html.replace(BLOCK, "").replace(STYLE, "");
    assert.doesNotMatch(rest, /function toast\(|toast"\)\.hidden|toastBox|#toast\{/, "no toast of the page's own");
    // An error is a banner: a toast only says what was done.
    for (const [, said] of rest.matchAll(/\btoast\(([^;]*)/g)) assert.doesNotMatch(said, /refused|reach|answered|replaced|first|Give|Fill|Write|Paste|copy|didn’t|ago\./i, `a banner, not a toast: ${said.slice(0, 80)}`);
    for (const refusal of ["refused th", "Can’t reach AnythingLLM"]) assert.ok(new RegExp(`banner\\("[^"]*${refusal}`).test(rest) || new RegExp(`banner\\(res\\.status === 403 \\? "AnythingLLM ${refusal}|banner\\(r\\.status === 403 \\? "AnythingLLM ${refusal}`).test(rest), `${refusal}: a banner`);
  });
}

test("the link replaced stays: a banner on the Vault and the Library, a card on the apps manager", () => {
  for (const page of [PAGES[0], PAGES[3]]) assert.match(read(page), /banner\("This link was replaced\. Open the page again from where you got it: the agent, AnywhereLLM Lite, or anywherellm-suite pages\.", \{ kind: "warning", key: "gone" \}\)/);
  assert.match(read(PAGES[1]), /className: "card solo gone", role: "status" \}, el\("b", \{ style: "font-weight:600", textContent: "This link was replaced" \}\)/);
});

// ---- A stand-in document: elements with children, text, attributes, a dataset and focus.
class El {
  tagName: string;
  kids: El[] = [];
  parent: El | null = null;
  own = "";
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  type = "";
  disabled = false;
  html = "";
  onclick: (() => void) | null = null;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get children() { return this.kids; }
  get textContent(): string { return this.own + this.kids.map((k) => k.textContent).join(""); }
  set textContent(v: string) { this.kids = []; this.own = String(v); }
  get innerHTML() { return this.html; }
  set innerHTML(v: string) { this.kids = []; this.own = ""; this.html = v; this.append(new El("svg")); }
  adopt(k: El) { k.parent?.drop(k); k.parent = this; return k; }
  drop(k: El) { this.kids = this.kids.filter((x) => x !== k); k.parent = null; }
  append(...ks: El[]) { for (const k of ks) this.kids.push(this.adopt(k)); }
  prepend(...ks: El[]) { this.kids.unshift(...ks.map((k) => this.adopt(k))); }
  replaceChildren(...ks: El[]) { for (const k of this.kids) k.parent = null; this.kids = []; this.own = ""; this.append(...ks); }
  remove() { this.parent?.drop(this); }
  replaceWith(n: El) { const p = this.parent!; const i = p.kids.indexOf(this); p.drop(this); p.kids.splice(i, 0, p.adopt(n)); }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  querySelector(sel: string): El | null {
    for (const k of this.kids) {
      if (sel.startsWith(".") && k.className.split(" ").includes(sel.slice(1))) return k;
      const deeper = k.querySelector(sel);
      if (deeper) return deeper;
    }
    return null;
  }
  focus() { doc.activeElement = this; }
  click() { this.onclick?.(); }
  getClientRects() { return [{}]; }
  compareDocumentPosition(other: El) { return other === next ? 4 : 2; }
}
let doc: { activeElement: El | null; hidden: boolean };
let next: El;

/** The block, run as a page runs it: its toast, banner and unbanner, the toast and the banners' box,
 *  the page's events, and the clock. */
function load() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let ids = 0;
  const listeners: Record<string, (() => void)[]> = {};
  const on = (type: string, fn: () => void) => (listeners[type] ??= []).push(fn);
  const box = new El("div"), list = new El("div");
  next = new El("button");
  const document = {
    activeElement: null as El | null,
    hidden: false,
    getElementById: (id: string) => ({ toast: box, banners: list })[id] ?? null,
    createElement: (tag: string) => new El(tag),
    addEventListener: on,
    querySelectorAll: () => [list, next],
  };
  doc = document;
  const ctx = vm.createContext({
    document,
    addEventListener: on,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    setTimeout: (fn: () => void, ms: number) => (timers.set(++ids, { at: now + ms, fn }), ids),
    clearTimeout: (id: number) => timers.delete(id),
  });
  const api = vm.runInContext(`(() => {\n${BLOCK}\nreturn { toast, banner, unbanner };\n})()`, ctx) as {
    toast(text: string, undo?: { undo(): void; send(): void } | null): El;
    banner(text: string, how?: { kind?: string; key?: string }): El;
    unbanner(key: string): void;
  };
  const wait = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) timers.delete(id), t.fn();
  };
  const fire = (type: string) => { for (const fn of listeners[type] ?? []) fn(); };
  return { ...api, box, list, wait, fire, document };
}

test("a toast says what was done for 6 s, or 2 s and 0.7 s a word when that is longer, then it's emptied, not hidden", () => {
  const { toast, box, wait } = load();
  assert.equal(toast("Sent"), null);
  assert.equal(box.textContent, "Sent");
  wait(5999);
  assert.equal(box.textContent, "Sent", "still there at 5.999 s");
  wait(1);
  assert.equal(box.textContent, "", "gone at 6 s");
  assert.equal(box.kids.length, 0, "emptied: the region stays in the page");
  const long = "This one has quite a few more words in it, so that it takes longer to read than six seconds do.";
  toast(long);
  const words = long.split(" ").length;
  wait(2000 + 700 * words - 1);
  assert.equal(box.textContent, long);
  wait(1);
  assert.equal(box.textContent, "");
});

test("a toast with Undo has no timer: Undo undoes, Close sends; another toast or leaving the page sends what it held", () => {
  const { toast, box, wait, fire, document } = load();
  const done: string[] = [];
  const held = (name: string) => ({ undo: () => done.push(`undo ${name}`), send: () => done.push(`send ${name}`) });
  const undo = toast("Dropped the request for vm", held("vm"));
  assert.equal(box.textContent, "Dropped the request for vmUndo", "its words, Undo and a Close");
  assert.equal(undo.textContent, "Undo");
  assert.equal(box.querySelector(".shut")?.getAttribute("aria-label"), "Close");
  wait(10 * 60_000);
  assert.equal(box.textContent, "Dropped the request for vmUndo", "still there ten minutes on");
  undo.click();
  assert.deepEqual(done, ["undo vm"]);
  assert.equal(box.textContent, "");

  toast("Dropped the request for owen", held("owen"));
  box.querySelector(".shut")!.click();
  assert.deepEqual(done, ["undo vm", "send owen"], "Close sends it");
  assert.equal(box.textContent, "");

  toast("Taken back: tick Milk", held("milk"));
  toast("Sent");
  assert.deepEqual(done.slice(2), ["send milk"], "another toast in its place sends it");

  toast("Taken back: tick Bread", held("bread"));
  fire("visibilitychange");
  assert.deepEqual(done.slice(3), [], "the page still shown: nothing");
  document.hidden = true;
  fire("visibilitychange");
  assert.deepEqual(done.slice(3), ["send bread"], "the page hidden (another app): sent");
  toast("Dropped the request for box", held("box"));
  fire("pagehide");
  assert.deepEqual(done.slice(4), ["send box"], "the page left: sent");
  assert.equal(box.textContent, "");
  fire("pagehide");
  assert.equal(done.length, 5, "sent once");
});

test("a banner stays until it's closed, with its icon, its words and a Close; Close gives the focus on", () => {
  const { banner, list, wait } = load();
  const refused = banner("AnythingLLM refused this page’s key. Make a new one in Settings › Browser Extension, paste it into a suite skill’s PAGE_KEY, then reload this page.", { key: "post" });
  assert.equal(refused.getAttribute("role"), "alert");
  assert.equal(refused.className, "danger");
  assert.deepEqual(refused.kids.map((k) => k.tagName), ["SVG", "P", "BUTTON"], "an icon, the words, a Close");
  assert.equal(refused.querySelector(".shut")?.getAttribute("aria-label"), "Close");
  wait(10 * 60_000);
  assert.deepEqual(list.kids, [refused], "still there ten minutes on");
  const gone = banner("This link was replaced. Open the page again from where you got it.", { kind: "warning", key: "gone" });
  assert.deepEqual(list.kids, [gone, refused], "the newest on top");
  assert.equal(gone.className, "warning");
  assert.equal(banner("Can’t copy here.", { kind: "info" }).getAttribute("role"), "status", "information is a status, not an alert");
  list.kids[0].querySelector(".shut")!.click();
  assert.deepEqual(list.kids, [gone, refused]);
  assert.equal(doc.activeElement, gone.querySelector(".shut"), "the focus goes to the next banner's Close");
  gone.querySelector(".shut")!.click();
  refused.querySelector(".shut")!.click();
  assert.deepEqual(list.kids, []);
  assert.equal(doc.activeElement, next, "the last one closed, to the first control after the banners");
});

test("a banner of the same key takes the place of the one before; the same words are said once; unbanner takes it away", () => {
  const { banner, unbanner, list } = load();
  const first = banner("Can’t reach AnythingLLM. Try again in a moment.", { key: "reach" });
  assert.equal(banner("Can’t reach AnythingLLM. Try again in a moment.", { key: "reach" }), first, "the poll saying it again adds nothing");
  const other = banner("AnythingLLM answered 502. Try again in a moment.", { key: "post" });
  const second = banner("AnythingLLM answered 503. Try again in a moment.", { key: "post" });
  assert.deepEqual(list.kids, [second, first], "the post's newest in the place of its last");
  assert.equal(other.parent, null);
  banner("http://localhost:8080 is AnythingLLM’s own machine.");
  banner("http://localhost:8080 is AnythingLLM’s own machine.");
  assert.equal(list.kids.length, 3, "keyed by its words when it has no key");
  unbanner("reach");
  unbanner("nothing");
  assert.deepEqual(list.kids.map((b) => b.dataset.key), ["http://localhost:8080 is AnythingLLM’s own machine.", "post"]);
});
