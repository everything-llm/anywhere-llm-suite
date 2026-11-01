// The library's pages: the Vault's keys section and the Library page, written where AnythingLLM
// serves them, showing nothing secret, and what the user does on them (posted as AnythingLLM's
// collector writes it) applied and told to the agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { linksFile, readLinks } from "#shared/page-links";
import { call, giveKey, hideLinks, library, LIBRARY_CARD, pageConfig, pageState, post, postVault, publicDir, reset, seal, skillDir, storage, until, VAULT_CARD, vaultConfig, vaultState } from "./harness.mts";

const KEY = "page-key-0123456789";
test.beforeEach(reset);

const vaultFile = (name: string) => path.join(publicDir, "vault-lean", name);
/** What a page's requests ask for, without where and when. */
const askedFor = (needs: { label: string; site: string }[]) => needs.map(({ label, site }) => ({ label, site }));

test("library gives the Vault's card and the Library page's, each as a quote with its link: relative, or absolute with ANYTHINGLLM_URL", async () => {
  assert.match(await call({ action: "library" }), new RegExp(`The Vault and the Library page are the user's own pages\\. Give the user each card as it is, in its own quote, so they open it from your answer:\\n\\n${VAULT_CARD}\\n\\n${LIBRARY_CARD}$`));
  const said = await call({ action: "library" }, { base: "https://llm.example.com/" });
  const { token, key, secret } = pageConfig();
  assert.ok(said.includes(`**[The Library](https://llm.example.com/library-lean/${token}.html "library")**`));
  assert.ok(said.includes(`**[The Vault](https://llm.example.com/vault-lean/${vaultConfig().token}.html "vault")**`));
  assert.equal(key, "brx-test", "the page posts with the browser-extension key install keeps");
  assert.equal(vaultConfig().key, "brx-test");
  assert.ok(secret.length >= 20);
  assert.notEqual(vaultConfig().secret, secret, "the Vault has a secret of its own");
});

test("with the links kept from the agent the pages are still written, and the Library page's path is in the links file", async () => {
  hideLinks(true);
  await call({ action: "library" }, { base: "https://llm.example.com/" });
  const { token } = pageConfig();
  assert.ok(fs.existsSync(path.join(publicDir, "library-lean", `${token}.html`)), "the page is written");
  assert.equal(readLinks().library, `/library-lean/${token}.html`, "root-relative, whatever ANYTHINGLLM_URL is");
  assert.equal(fs.statSync(linksFile()).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(library, "page.json"), "utf8")).hidden, true, "made under the switch, so marked");
});

test("the Vault shows a saved key by name only, never its value, and only the library's section", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "library" });
  const state = vaultState();
  assert.deepEqual(state.secrets, [{ label: "ex", site: "api.example.com", shown: null }]);
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.ok(!fs.readFileSync(vaultFile(`${vaultConfig().token}.html`), "utf8").includes(KEY));
  assert.ok(!fs.existsSync(vaultFile(`${vaultConfig().token}-logins.json`)), "no logins section without the browser");
});

test("a key and a target asked for under one label are on their own pages, and one given doesn't meet the other", async () => {
  await call({ action: "secret", site: "api.example.com", label: "pi" });
  await call({ action: "secret", kind: "ssh", label: "pi" });
  assert.deepEqual(askedFor(vaultState().needs), [{ label: "pi", site: "api.example.com" }], "the key's need is on the Vault");
  assert.deepEqual(askedFor(pageState().needs), [{ label: "pi", site: "" }], "the target's is on the Library page");
  postVault({ ev: "key-save", label: "pi", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(vaultState().needs, [], "the key's need is met");
  assert.deepEqual(askedFor(pageState().needs), [{ label: "pi", site: "" }], "the target's is not");
});

test("a key is asked for on the Vault, given there, and the agent is told", async () => {
  const asked = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(asked, new RegExp(`on the Vault instead, at the top of Keys\\. If they ask for it, give them this card as it is, in its own quote:\\n\\n${VAULT_CARD}\\n\\n`));
  assert.deepEqual(askedFor(vaultState().needs), [{ label: "ex", site: "api.example.com" }]);
  postVault({ ev: "key-save", label: "ex", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(vaultState().needs, [], "the need is met");
  assert.deepEqual(vaultState().secrets, [{ label: "ex", site: "api.example.com", shown: null }]);
});

test("an event without the page's secret (an old link's, or a forgery) is dropped", async () => {
  await call({ action: "library" });
  postVault({ secret: "not-the-secret", ev: "key-save", label: "x", site: "api.example.com", sealed: seal(KEY) });
  postVault({ secret: pageConfig().secret, ev: "key-save", label: "y", site: "api.example.com", sealed: seal(KEY) }); // the Library page's, not the Vault's
  post({ secret: undefined, ev: "toolkit-delete", service: "x" });
  await call({ action: "library" });
  assert.deepEqual(vaultState().secrets, []);
});

test("the user deletes a key on the Vault, and a function or a toolkit on the Library page", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "save", service: "ex", function: { name: "two", description: "Two.", source: "async function main() { return 2; }" } });
  await call({ action: "library" });
  post({ ev: "fn-delete", fn: "ex.one" });
  postVault({ ev: "key-delete", label: "ex" });
  const said = await call({ action: "library", service: "ex" });
  assert.match(said, /Functions:\n- ex\.two\(\)/);
  assert.deepEqual(vaultState().secrets, []);
  post({ ev: "toolkit-delete", service: "ex" });
  assert.match(await call({ action: "library" }), /^The library is empty/);
});

test("a new Library page link replaces the old one, whose files are removed and whose secret no longer works", async () => {
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "library" });
  const old = pageConfig();
  post({ secret: old.secret, ev: "rotate" });
  await call({ action: "library" });
  const now = pageConfig();
  assert.notEqual(now.token, old.token);
  for (const ending of [".html", ".json"]) assert.ok(!fs.existsSync(path.join(publicDir, "library-lean", `${old.token}${ending}`)), ending);
  post({ secret: old.secret, ev: "fn-delete", fn: "ex.one" });
  assert.match(await call({ action: "library", service: "ex" }), /Functions:\n- ex\.one\(\)/, "the old secret deletes nothing");
});

test("a new Vault link moves every section's state to the new name, and the old secret no longer works", async () => {
  await call({ action: "library" });
  const old = vaultConfig();
  fs.writeFileSync(vaultFile(`${old.token}-logins.json`), JSON.stringify({ logins: [] })); // the browser's section, as it writes it
  postVault({ ev: "rotate" });
  await call({ action: "library" });
  const now = vaultConfig();
  assert.notEqual(now.token, old.token);
  assert.ok(!fs.existsSync(vaultFile(`${old.token}.html`)));
  for (const section of ["keys", "logins"]) {
    assert.ok(fs.existsSync(vaultFile(`${now.token}-${section}.json`)), section);
    assert.ok(!fs.existsSync(vaultFile(`${old.token}-${section}.json`)), section);
  }
  postVault({ secret: old.secret, ev: "key-save", label: "x", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(vaultState().secrets, []);
});

test("a newer Vault page another skill wrote isn't written over", async () => {
  await call({ action: "library" });
  const file = vaultFile(`${vaultConfig().token}.html`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"version":\d+/, '"version":999'));
  await call({ action: "library" });
  assert.match(fs.readFileSync(file, "utf8"), /"version":999/);
});

test("while the Vault is open, what the user does is applied without waiting for the agent", async () => {
  await call({ action: "library" });
  postVault({ ev: "key-save", label: "live", site: "api.example.com", sealed: seal(KEY) });
  let state = vaultState();
  for (let i = 0; i < 100 && !state.secrets.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    state = vaultState();
  }
  assert.deepEqual(state.secrets.map((s: { label: string }) => s.label), ["live"], "the section's state was written again by the watch");
});

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
/** A machine saved as the page saves it: the address, the account and the line the setup command printed. */
const saveTarget = (fields: Record<string, unknown> = {}) => post({ ev: "target-save", label: "box", host: "box.internal", login: "sandbox", fingerprint: `256 ${FINGERPRINT} root@box (ED25519)`, sealed: "", ...fields });

test("a target the user deletes with the page open is gone from its state without the agent's next call", async () => {
  await call({ action: "library" });
  saveTarget();
  // Once its sign-in has been tried: a try still going would write the state again after the delete, and hide that the delete doesn't.
  await until(() => pageState().targets[0]?.status && pageState().targets[0].status !== "not tried yet", 15000);
  post({ ev: "target-delete", label: "box" });
  await until(() => pageState().targets.length === 0);
});

test("a save posted with another page's secret is dropped: no target, and no word of one saved", async () => {
  await call({ action: "library" });
  saveTarget({ label: "forged", secret: "not-the-secret" });
  saveTarget({ label: "real" }); // after it, so that the forgery was taken before this was applied
  await until(() => pageState().result?.n === 1);
  assert.deepEqual(pageState().result, { n: 1, ev: "target-save", label: "real", error: null, field: null });
  assert.deepEqual(pageState().targets.map((m: { label: string }) => m.label), ["real"]);
  saveTarget({ label: "forged", secret: "not-the-secret" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(pageState().result.n, 1, "a forgery alone makes no result");
});

test("what the skill refuses on a machine the user saves reaches the page in the user's words, one reason each, with the field it concerns; a save that works says so", async () => {
  await call({ action: "library" });
  assert.equal(pageState().result, null);
  const refusals: [Record<string, unknown>, RegExp, string][] = [
    [{ label: "Pi!" }, /^A name is 2 to 31 lower-case letters/, "label"],
    [{ host: "bad host!" }, /^Give a name or an address, like build\.example\.net or 192\.168\.1\.20, with :port after it/, "host"],
    [{ host: "box.internal:70000" }, /^The port after the : is a number from 1 to 65535/, "host"],
    [{ host: "[fd00::1]:x" }, /^The port after the : is a number/, "host"],
    [{ login: "" }, /^Give the account to sign in as/, "login"],
    [{ fingerprint: "256 SHA256:short root@box (ED25519)" }, /^That line has no SHA256 fingerprint\. Paste the whole line the command printed/, "fingerprint"],
    [{ sealed: seal("not a key") }, /^That isn’t a private key ssh can sign in with/, "key"],
    [{ public: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAInotthespare library-lean" }, /^This command’s key was used for another machine/, "command"],
  ];
  let n = 0;
  for (const [fields, why, field] of refusals) {
    saveTarget({ label: "bad", ...fields });
    n++;
    await until(() => pageState().result?.n === n);
    assert.equal(pageState().result.ev, "target-save");
    assert.match(pageState().result.error, why);
    assert.equal(pageState().result.field, field, JSON.stringify(fields));
  }
  assert.deepEqual(pageState().targets, [], "nothing was saved");
  saveTarget({ public: pageState().spare });
  n++;
  await until(() => pageState().result?.n === n);
  assert.deepEqual(pageState().result, { n, ev: "target-save", label: "box", error: null, field: null });
});

test("the address tells a private one, in place of a tick: a name of this network or a private address is let through as one, a name that looks public isn't, whatever the page posts; a port rides on the address", async () => {
  await call({ action: "library" });
  const saved: [string, Record<string, unknown>, { host: string; port: number; private: boolean }][] = [
    ["lan", { host: "Box.Internal:2222" }, { host: "box.internal", port: 2222, private: true }],
    ["single", { host: "nas" }, { host: "nas", port: 22, private: true }],
    ["public", { host: "box.invalid", private: true }, { host: "box.invalid", port: 22, private: false }],
    ["v6", { host: "[FD00::1]:2200" }, { host: "fd00::1", port: 2200, private: true }],
    ["bare-v6", { host: "fd00::2" }, { host: "fd00::2", port: 22, private: true }],
  ];
  for (const [label, fields, want] of saved) {
    const n = pageState().result?.n ?? 0;
    saveTarget({ label, ...fields });
    await until(() => (pageState().result?.n ?? 0) > n, 15000); // a save looks the name up, which may take its 3 s
    assert.equal(pageState().result.error, null, label);
    const m = pageState().targets.find((t: { label: string }) => t.label === label);
    assert.deepEqual({ host: m.host, port: m.port, private: m.private }, want, label);
  }
});

test("an event that breaks (not a refusal) is logged, and the events after it are still applied", async () => {
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "save", service: "ex", function: { name: "two", description: "Two.", source: "async function main() { return 2; }" } });
  await call({ action: "library" });
  fs.mkdirSync(path.join(library, "toolkits", "ex", "state", "one.json", "x"), { recursive: true }); // removing one's state fails with EISDIR, not a refusal
  post({ ev: "fn-delete", fn: "ex.one" });
  post({ ev: "fn-delete", fn: "ex.two" });
  const said = await call({ action: "library", service: "ex" });
  assert.doesNotMatch(said, /ex\.two\(/, "the event after the one that broke was applied");
});

// Drift: what the pages post and read must be what the skill applies and writes.

const pageSource = (name: string) => fs.readFileSync(path.join(skillDir, "static", "pages", name), "utf8");
const vaultSource = () => fs.readFileSync(path.join(skillDir, "..", "..", "shared", "vault.html"), "utf8");
const source = fs.readFileSync(path.join(skillDir, "src", "page.ts"), "utf8");
const handled = (fn: string) => [...source.slice(source.indexOf(`function ${fn}(`)).split("\n}\n")[0].matchAll(/case "([a-z-]+)":|e\.ev === "([a-z-]+)"/g)].map((m) => m[1] || m[2]);

test("every event the pages post is one the skill applies", () => {
  const posted = [...pageSource("library.html").matchAll(/post\("([a-z-]+)"|remove\("[^"]*", "([a-z-]+)"/g)].map((m) => m[1] || m[2]);
  assert.ok(posted.length >= 3);
  for (const ev of posted) assert.ok(handled("apply").includes(ev), ev);
  const keys = [...vaultSource().matchAll(/post\("keys", "([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 4);
  for (const ev of [...keys, "rotate"]) assert.ok(handled("applyKeys").includes(ev), `keys: ${ev}`);
});

test("every field the pages read from their state is one the skill writes", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "secret", site: "api.other.example", label: "other" });
  await call({ action: "save", service: "ex", toolkit: { base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" }, test: {} });
  await call({ action: "secret", kind: "ssh", label: "pi" });
  postVault({ ev: "signing-new", label: "signer", namespace: "test-ns" });
  await call({ action: "library" });
  saveTarget({ label: "box", public: pageState().spare });
  await until(() => pageState().targets.length === 1);
  const state = pageState();
  const html = pageSource("library.html");
  for (const [, field] of html.matchAll(/\b[sS]\.([a-z_]+)/g)) assert.ok(field in state, `s.${field}`);
  const items = { t: state.toolkits[0], f: state.toolkits[0].functions[0], r: state.runs[0], need: state.needs[0], m: state.targets[0] };
  for (const [name, item] of Object.entries(items)) for (const [, field] of html.matchAll(new RegExp(`\\b${name}\\.([a-z_]+)`, "g"))) assert.ok(field in item, `${name}.${field}`);
  const keys = vaultState();
  const vault = vaultSource();
  for (const [, field] of vault.matchAll(/\bks\.([a-z_]+)/g)) assert.ok(field in keys, `ks.${field}`);
  const vaultItems = { k: keys.secrets[0], n: keys.needs[0], g: keys.signing[0] };
  for (const [name, item] of Object.entries(vaultItems)) {
    assert.ok(item, name);
    for (const [, field] of vault.matchAll(new RegExp(`\\b${name}\\.([a-z_]+)`, "g"))) assert.ok(field in item, `${name}.${field}`);
  }
  assert.ok(fs.existsSync(path.join(library, "page.json")));
  assert.ok(fs.existsSync(path.join(storage, "vault-lean", "vault-page.json")));
});

test("a toolkit's functions are one line each on the Library page, as the canvas draws them: what each does, cut short with an ellipsis", () => {
  const html = pageSource("library.html");
  assert.match(html, /\.one\{overflow:hidden;white-space:nowrap;text-overflow:ellipsis\}/);
  assert.match(html, /t\.functions\.map\(\(f\) => rowLink\(fnHref\(t\.service, f\.name\), el\("span", \{ className: "one", textContent: does\(f\) \}\)\)\)/);
});

test("the user renames a toolkit on the Library page and a key on the Vault: only the pages show the new names, and the agent's next save keeps them", async () => {
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "save", service: "ex", toolkit: { title: "Example", base_urls: ["https://api.example.com"] }, function: { name: "one", description: "One.", source: "async function main() { return 1; }" } });
  await call({ action: "library" });
  post({ ev: "toolkit-rename", service: "ex", name: "My example" });
  postVault({ ev: "key-rename", label: "ex", name: "Example key" });
  await call({ action: "save", service: "ex", toolkit: { title: "Example 2" } });
  await call({ action: "library" });
  assert.equal(pageState().toolkits[0].title, "My example");
  assert.deepEqual(vaultState().secrets, [{ label: "ex", site: "api.example.com", shown: "Example key" }]);
  assert.match(await call({ action: "library", service: "ex" }), /Example 2/, "the agent still reads the toolkit's own title");
  post({ ev: "toolkit-rename", service: "ex", name: "" });
  postVault({ ev: "key-delete", label: "ex" });
  await giveKey("ex", "api.example.com", KEY);
  await call({ action: "library" });
  assert.equal(pageState().toolkits[0].title, "Example 2", "an empty name shows the title again");
  assert.deepEqual(vaultState().secrets, [{ label: "ex", site: "api.example.com", shown: null }], "a deleted key's name goes with it");
});

test("a machine the agent asks for is a card saying the agent waits for it, with one button; the general row says another while one waits", () => {
  const html = pageSource("library.html");
  assert.ok(!html.includes("which the agent asks for"), "no second Add row that reads like the first");
  assert.match(html, /`The agent is waiting for \$\{need\.label\}`/);
  assert.match(html, /textContent: `Add \$\{need\.label\}`/);
  assert.match(html, /asking\.length \? "Add another machine" : "Add a machine"/);
});

// ---- What the agent asks the user for: which chat asked and when, one per chat and kind, Not needed
// (and the chat told), and a day's expiry.

const HOME = { slug: "home", name: "Household", thread: 5 };
const pageFile = () => path.join(library, "page.json");
const kept = () => JSON.parse(fs.readFileSync(pageFile(), "utf8"));
/** page.json changed by `fn`, as an older one, or one left a day, would be. */
const age = (fn: (p: any) => void) => {
  const p = kept();
  fn(p);
  fs.writeFileSync(pageFile(), JSON.stringify(p));
};
const DAY = 24 * 60 * 60 * 1000;

test("a request says which chat asked and when: the workspace's name (AnythingLLM gives a thread by its id only), else its slug; a scheduled job's says none", async () => {
  const before = Date.now();
  await call({ action: "secret", kind: "ssh", label: "vm" }, HOME);
  await call({ action: "secret", site: "api.example.com", label: "ex" }, { slug: "work", thread: null });
  const [machine] = pageState().needs;
  assert.deepEqual([machine.label, machine.where], ["vm", "Household"]);
  assert.ok(machine.at >= before && machine.at <= Date.now(), "when it was asked");
  assert.match(machine.id, /^[\w-]{12}$/, "an id the page drops it by");
  assert.equal(vaultState().needs[0].where, "work", "no name: the slug");
  assert.ok(!("chat" in machine), "the chat's key stays in page.json");
  await call({ action: "secret", kind: "ssh", label: "nightly" }, null);
  assert.deepEqual(pageState().needs.map((n: { label: string; where: string }) => [n.label, n.where]), [["vm", "Household"], ["nightly", ""]]);
});

test("a chat's new request replaces its earlier one of that kind; another chat's stays, even for the same label, and the key given meets them all", async () => {
  await call({ action: "secret", kind: "ssh", label: "vm" }, HOME);
  await call({ action: "secret", kind: "ssh", label: "owen" }, HOME);
  assert.deepEqual(askedFor(pageState().needs), [{ label: "owen", site: "" }], "the chat moved on to owen");
  await call({ action: "secret", kind: "ssh", label: "vm" }, { ...HOME, thread: 6 });
  await call({ action: "secret", kind: "ssh", label: "owen" }, "work");
  assert.deepEqual(askedFor(pageState().needs).map((n) => n.label), ["owen", "vm", "owen"], "each chat's own: another thread, another workspace");
  await call({ action: "secret", site: "api.github.com", label: "github" }, HOME);
  assert.equal(pageState().needs.length, 3, "a key doesn't replace a machine");
  await call({ action: "secret", site: "api.slack.com", label: "slack" }, HOME);
  await call({ action: "secret", site: "api.slack.com", label: "slack" }, "work");
  assert.deepEqual(askedFor(vaultState().needs), [{ label: "slack", site: "api.slack.com" }, { label: "slack", site: "api.slack.com" }]);
  const again = vaultState().needs[0];
  await call({ action: "secret", site: "api.slack.com", label: "slack" }, HOME);
  assert.equal(vaultState().needs.length, 2, "asked again: still one for the chat");
  assert.notEqual(vaultState().needs.at(-1).id, again.id, "the newer ask, with its own time");
  postVault({ ev: "key-save", label: "slack", site: "api.slack.com", sealed: seal(KEY) });
  await call({ action: "library" });
  assert.deepEqual(vaultState().needs, [], "the key given meets both chats' requests");
});

test("Not needed drops a machine's request at once, and the chat that asked is told at its next call, once; no other chat is", async () => {
  await call({ action: "secret", kind: "ssh", label: "vm" }, HOME);
  await call({ action: "secret", kind: "ssh", label: "box" }, "work");
  const [vm] = pageState().needs;
  post({ ev: "need-drop", id: vm.id, label: "vm" });
  const other = await call({ action: "library" }, "work");
  assert.ok(!other.includes("isn't needed"), "another chat isn't told");
  assert.deepEqual(askedFor(pageState().needs), [{ label: "box", site: "" }], "gone from the page");
  const said = await call({ action: "library" }, HOME);
  assert.match(said, /^The user said the machine "vm" isn't needed \(on the Library page\), so its request is dropped\. Don't ask for it again unless the user says so\.\n\n/);
  assert.ok(!(await call({ action: "library" }, HOME)).includes("isn't needed"), "told once");
  post({ ev: "need-drop", id: pageState().needs[0].id, secret: "not-the-pages" });
  await call({ action: "library" }, "work");
  assert.equal(pageState().needs.length, 1, "a forgery drops nothing");
});

test("Not needed on the Vault drops a key's request, and the agent asking again in that chat is told the user said so, not asked again", async () => {
  await call({ action: "secret", site: "api.github.com", label: "github" }, HOME);
  postVault({ ev: "need-drop", id: vaultState().needs[0].id, label: "github" });
  const again = await call({ action: "secret", site: "api.github.com", label: "github" }, HOME);
  assert.match(again, /^The user said the key "github" for api\.github\.com isn't needed \(on the Vault\), so its request is dropped\. Don't ask for it again unless the user says so\.\n\nSo the key "github" wasn't asked for again\. If the user says they want it after all, ask again\.$/);
  assert.deepEqual(vaultState().needs, [], "not asked again");
  assert.match(await call({ action: "secret", site: "api.github.com", label: "github" }, HOME), /^The user gives the key in the library's own settings/, "asked once more, after being told: asked");
  assert.equal(vaultState().needs.length, 1);
  // A machine the user said isn't needed, asked for again in the same call that tells it.
  await call({ action: "secret", kind: "ssh", label: "vm" }, HOME);
  post({ ev: "need-drop", id: pageState().needs[0].id });
  assert.match(await call({ action: "secret", kind: "ssh", label: "vm" }, HOME), /isn't needed[^]*\n\nSo the machine "vm" wasn't asked for again\./);
  assert.deepEqual(pageState().needs, []);
});

test("a Not needed for a request met or replaced meanwhile drops nothing, and tells nothing", async () => {
  await call({ action: "secret", kind: "ssh", label: "vm" }, HOME);
  const old = pageState().needs[0].id;
  await call({ action: "secret", kind: "ssh", label: "owen" }, HOME);
  post({ ev: "need-drop", id: old });
  const said = await call({ action: "library" }, HOME);
  assert.ok(!said.includes("isn't needed"));
  assert.deepEqual(askedFor(pageState().needs), [{ label: "owen", site: "" }], "the newer request stands");
});

test("a request a day old isn't shown, and is gone from page.json at the next call; so is one from before requests had a time, and a Not needed its chat never heard", async () => {
  await call({ action: "secret", kind: "ssh", label: "vm" }, HOME);
  await call({ action: "secret", site: "api.github.com", label: "github" }, "work");
  await call({ action: "secret", kind: "ssh", label: "box" }, "work");
  post({ ev: "need-drop", id: pageState().needs.find((n: { label: string }) => n.label === "box").id });
  await call({ action: "library" }, "other");
  assert.equal(kept().declined.length, 1, "work hasn't been told yet");
  age((p) => {
    for (const n of p.needs) n.at -= DAY;
    p.declined[0].at -= DAY;
  });
  await call({ action: "secret", kind: "ssh", label: "fresh" }, "other");
  age((p) => p.needs.push({ label: "old", site: "", kind: "target", until: Date.now() + 60_000 })); // page.json as before 2026-11-01
  assert.ok(!(await call({ action: "library" }, "work")).includes("isn't needed"), "a day on, work isn't told");
  assert.deepEqual(askedFor(pageState().needs), [{ label: "fresh", site: "" }]);
  assert.deepEqual(vaultState().needs, []);
  assert.deepEqual(kept().needs.map((n: { label: string }) => n.label), ["fresh"], "gone from page.json");
  assert.deepEqual(kept().declined, []);
});

test("a request's card says where and when, with Not needed, a plain secondary, beside its one primary; Undo holds the drop with no timer, until the toast closes or the page is left", () => {
  for (const html of [pageSource("library.html"), vaultSource()]) {
    assert.match(html, /need\.where \? `Asked in \$\{need\.where\} · ` : "Asked by a scheduled job · "|n\.where \? `Asked in \$\{n\.where\} · ` : "Asked by a scheduled job · "/);
    assert.match(html, /<div id="toast" role="status" hidden><span><\/span><button type="button" class="undo" hidden>Undo<\/button><button type="button" class="shut" aria-label="Close" hidden><\/button><\/div>/);
    assert.match(html, /if \(undo\) held = undo;\n {4}else toastTimer = setTimeout\(hideToast, 4000\);/, "only a toast without Undo times out");
    assert.match(html, /addEventListener\("pagehide", \(\) => \{ hideToast\(\); sendHeld\(\); \}\);/);
    assert.match(html, /\{ quiet: true \}\)/, "the drop is sent as the toast closes, kept alive as the page is left");
    assert.match(html, /Date\.now\(\) - (need|n)\.at < DAY/, "a day old: not shown");
  }
  assert.match(pageSource("library.html"), /acts\(el\("a", \{ className: "hu-button hu-button--primary", href: `#add\/\$\{encodeURIComponent\(need\.label\)\}`, textContent: `Add \$\{need\.label\}` \}\), no\)/);
  assert.match(pageSource("library.html"), /btn\("Not needed", "secondary", /);
  assert.match(vaultSource(), /el\("button", \{ className: "hu-button hu-button--secondary", type: "button", textContent: "Not needed"/);
});
