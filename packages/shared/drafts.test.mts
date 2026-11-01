// The pages' drafts: what's typed into a page's form is kept on the device for a day, so a phone's
// browser that drops the page while another app is open (and loads it again) loses nothing typed but
// secrets. Every page carries the same block, as shared/vault.html has it, and each page says which
// of its fields it keeps. The block runs here on a stand-in localStorage and stand-in fields.

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const PAGES = ["./vault.html", "../skills/apps/static/pages/manager.html", "../skills/browser/static/pages/tab.html", "../skills/library/static/pages/library.html"];
const read = (page: string): string => fs.readFileSync(fileURLToPath(new URL(page, import.meta.url)), "utf8");
const drafts = (html: string): string => /  \/\* page drafts:[\s\S]*?\/\* end of page drafts \*\//.exec(html)?.[0] ?? "";
const BLOCK = drafts(read(PAGES[0]));
const TOKEN = "Zq3token-of-the-page-0123";
const DAY = 24 * 60 * 60 * 1000;

for (const page of PAGES) {
  test(`${page.split("/").pop()}: the drafts block is vault.html's, inside the page's script`, () => {
    const html = read(page);
    assert.equal(drafts(html), BLOCK, "the same block as vault.html");
    const script = html.slice(html.lastIndexOf("<script>"), html.lastIndexOf("</script>"));
    assert.ok(script.includes(BLOCK), "in the page's own script");
    assert.ok(!/localStorage|sessionStorage/.test(html.replace(BLOCK, "")), "the block is the page's only use of storage");
  });
}

/** A stand-in for the browser's localStorage; `broken` makes each use of it throw, as blocked storage does. */
class Store {
  map = new Map<string, string>();
  broken = false;
  full = false;
  get length() { this.check(); return this.map.size; }
  key(i: number) { this.check(); return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { this.check(); return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.check(); if (this.full) throw new Error("QuotaExceededError"); this.map.set(k, String(v)); }
  removeItem(k: string) { this.check(); this.map.delete(k); }
  check() { if (this.broken) throw new Error("SecurityError"); }
}

/** A stand-in for a field: its value, type, autocomplete and data-*, and its input listeners. */
class Field {
  value: string;
  type: string;
  autocomplete: string;
  dataset: Record<string, string>;
  listeners: (() => void)[] = [];
  constructor({ value = "", type = "text", autocomplete = "off", dataset = {} as Record<string, string> } = {}) {
    this.value = value;
    this.type = type;
    this.autocomplete = autocomplete;
    this.dataset = { ...dataset };
  }
  addEventListener(ev: string, fn: () => void) { if (ev === "input") this.listeners.push(fn); }
  removeEventListener(ev: string, fn: () => void) { this.listeners = this.listeners.filter((f) => f !== fn); }
  type_(text: string) { this.value = text; for (const fn of this.listeners) fn(); }
}

type Draft = { has(): boolean; keep(input: Field | undefined, field: string): () => void; clear(): void };

/** The block, run as a page runs it (a load of the page): its draft(form, key). */
function load(store: Store | null, now = Date.now()): (form: string, key: string) => Draft {
  const window = store ? { localStorage: store } : Object.defineProperty({}, "localStorage", { get() { throw new Error("SecurityError"); } });
  const ctx = vm.createContext({ window, Date: { now: () => now } });
  return vm.runInContext(`(() => {\n${BLOCK}\nreturn draft;\n})()`, ctx);
}

test("what's typed comes back when the page loads again, for the same form of the same page only", () => {
  const store = new Store();
  const name = new Field(), host = new Field();
  const d = load(store)("add", TOKEN);
  d.keep(name, "label");
  d.keep(host, "host");
  name.type_("pi");
  host.type_("192.168.1.20:2222");
  assert.equal("draft" in name.dataset, true, "marked as kept");

  const again = load(store);
  const name2 = new Field(), host2 = new Field();
  again("add", TOKEN).keep(name2, "label");
  again("add", TOKEN).keep(host2, "host");
  assert.deepEqual([name2.value, host2.value], ["pi", "192.168.1.20:2222"]);
  assert.equal(again("add", TOKEN).has(), true);
  const other = new Field(), elsewhere = new Field();
  again("add/pi", TOKEN).keep(other, "label");
  again("add", "another-page-token").keep(elsewhere, "label");
  assert.deepEqual([other.value, elsewhere.value], ["", ""], "another form, another page: nothing of this one's");
});

test("the page's token is never in the storage, only a hash of it", () => {
  const store = new Store();
  const f = new Field();
  load(store)("rename/x", TOKEN).keep(f, "name");
  f.type_("Home lab");
  const all = JSON.stringify([...store.map]);
  assert.ok(!all.includes(TOKEN) && !all.includes(TOKEN.slice(0, 12)), all);
  assert.match([...store.map.keys()][0], /^anywherellm-suite\.draft:[0-9a-z]+:rename\/x$/);
});

test("only what was typed over the page's own value is kept: the page's value, or typed back to it, keeps nothing", () => {
  const store = new Store();
  const d = load(store)("again/pi", TOKEN);
  const host = new Field({ value: "10.0.0.5" });
  d.keep(host, "host");
  assert.equal(host.value, "10.0.0.5");
  host.type_("10.0.0.6");
  assert.equal(d.has(), true);
  host.type_("10.0.0.5");
  assert.equal(d.has(), false, "typed back to the page's value");
  assert.equal(store.map.size, 0);
  host.type_("10.0.0.7");
  const next = new Field({ value: "10.0.0.5" });
  load(store)("again/pi", TOKEN).keep(next, "host");
  assert.equal(next.value, "10.0.0.7", "the page's value gives way to what was typed over it");
});

test("a password field, a code, a field marked secret: nothing is kept, and they aren't marked as kept", () => {
  const store = new Store();
  const d = load(store)("key-add", TOKEN);
  const fields = [new Field({ type: "password" }), new Field({ autocomplete: "new-password" }), new Field({ autocomplete: "one-time-code" }), new Field({ dataset: { secret: "" } })];
  fields.forEach((f, i) => d.keep(f, `f${i}`));
  fields.forEach((f) => f.type_("hunter2-secret"));
  assert.equal(store.map.size, 0);
  assert.ok(fields.every((f) => !("draft" in f.dataset)));
  // A field shown as text after it was kept (Show), then a password again: what it holds then goes.
  const shown = new Field();
  d.keep(shown, "name");
  shown.type_("visible");
  shown.type = "password";
  shown.type_("hidden-secret");
  assert.ok(!JSON.stringify([...store.map]).includes("secret"));
});

test("clear drops the form's draft; stop() stops saving", () => {
  const store = new Store();
  const d = load(store)("signing-add", TOKEN);
  const f = new Field();
  const stop = d.keep(f, "label");
  f.type_("muse");
  d.clear();
  assert.equal(d.has(), false);
  stop();
  f.type_("again");
  assert.equal(store.map.size, 0);
});

test("a draft past its day isn't put back, and any page's load sweeps it", () => {
  const store = new Store();
  const now = Date.now();
  const f = new Field();
  load(store, now)("add", TOKEN).keep(f, "label");
  f.type_("pi");
  store.setItem("anywherellm-suite.draft:other:add", "not json");
  store.setItem("someone-else", "kept");
  const later = load(store, now + DAY + 1000);
  assert.deepEqual([...store.map.keys()], ["someone-else"], "swept: the old draft and the unreadable one, not another's key");
  const g = new Field();
  later("add", TOKEN).keep(g, "label");
  assert.equal(g.value, "");

  const store2 = new Store();
  const typed = new Field();
  load(store2, now)("add", TOKEN).keep(typed, "label");
  typed.type_("pi");
  const soon = new Field();
  load(store2, now + DAY - 60_000)("add", TOKEN).keep(soon, "label");
  assert.equal(soon.value, "pi", "within the day it comes back");
});

test("storage blocked or full never breaks the page: nothing is kept, and the field isn't marked as kept", () => {
  for (const store of [null, Object.assign(new Store(), { broken: true })]) {
    const d = load(store)("add", TOKEN);
    const f = new Field({ value: "start" });
    assert.doesNotThrow(() => d.keep(f, "label"));
    assert.doesNotThrow(() => f.type_("typed"));
    assert.doesNotThrow(() => d.clear());
    assert.equal(d.has(), false);
    assert.equal(f.value, "typed");
    assert.ok(!("draft" in f.dataset));
  }
  const store = new Store();
  const d = load(store)("add", TOKEN);
  const f = new Field();
  d.keep(f, "label");
  assert.ok("draft" in f.dataset);
  store.full = true;
  f.type_("too much");
  assert.ok(!("draft" in f.dataset), "a write that failed: the page must not draw the field again");
});

test("which fields each page keeps, and which it never does", () => {
  const library = read("../skills/library/static/pages/library.html");
  assert.match(library, /for \(const name of \["label", "host", "login", "fingerprint"\]\) kept\.keep\(inputs\[name\], name\);/, "the add form's name, address, account and printed line");
  assert.match(library, /field\("key", "Private key", \{[^}]*secret: true/, "the private key is marked secret");
  assert.match(library, /"data-secret": secret/);
  assert.match(library, /draft\(at\.again \? `again\/\$\{at\.again\}` : at\.need \? `add\/\$\{at\.need\}` : "add", cfg\.token\)/, "a form of its own for each request, and for set up again");
  assert.match(library, /stop: kept\?\.keep\(\$\("sheet-in"\), "name"\)/, "the rename sheet's name");

  const vault = read("./vault.html");
  assert.match(vault, /if \(kept\) for \(const \[name, , type\] of fields\) if \(type !== "password"\) kept\.keep\(inputs\[name\], name\);/, "a form keeps its fields but a password field");
  for (const [form, kept] of [["key-add", "keyDraft"], ["signing-add", "signingDraft"]]) {
    assert.match(vault, new RegExp(`const ${kept} = draft\\("${form}", cfg\\.token\\)`));
    assert.match(vault, new RegExp(`\\{ kept: ${kept} \\}\\)`));
  }
  assert.match(vault, /\["value", "Key", "password"/, "the key's value is a password field");
  assert.match(vault, /\["seed", "Seed to import, if you have one", "password"/, "the seed is a password field");

  const manager = read("../skills/apps/static/pages/manager.html");
  assert.match(manager, /kept\.keep\(input, "title"\)/);
  const tab = read("../skills/browser/static/pages/tab.html");
  assert.match(tab, /needDraft\.keep\(user, "user"\)/, "the user name asked for a sign-in");
  assert.match(tab, /searchDraft\.keep\(\$\("q"\), "q"\)/);
  assert.equal((tab.match(/\.keep\(/g) ?? []).length, 2, "nothing else on the tab's page: not the field over the remote page, not the password or the code");
});
