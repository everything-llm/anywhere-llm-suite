import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { pageKeyFile } from "./anythingllm.mts";
import { writeAtomic } from "./atomic.mts";
import { Told } from "./errors.mts";
import { find, keyStamp, pageKey } from "./pagekey.mts";
import { pluginFile } from "./settings.mts";
import { close, listen } from "./test-helpers.mts";
import { entries, vaultDir } from "./vault.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pagekey-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const storage = path.join(tmp, "storage");
process.env.STORAGE_DIR = storage;
const SKILL = { hubId: "test-lean", name: "Test" };

// AnythingLLM's keys, as its browser extension's check sees them, on a port of its own.
const allm = { valid: new Set<string>(), checks: 0 };
const check = http.createServer((req, res) => {
  allm.checks++;
  const key = String(req.headers.authorization ?? "").split(" ")[1] ?? "";
  res.writeHead(req.url === "/api/browser-extension/check" && allm.valid.has(key) ? 200 : 403, { "content-type": "application/json" }).end("{}");
});
const CHECK = `http://127.0.0.1:${await listen(check)}`;
after(() => close(check));

/** Forgets what AnythingLLM said lately, as a minute gone by would. */
const forget = (): void => void delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("anywherellm-suite.pagekey source")];

/** The skill's plugin.json with PAGE_KEY holding `value`; its value as it is after, to read. */
function setPageKey(value: string): () => string {
  const file = pluginFile(SKILL.hubId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hubId: SKILL.hubId, setup_args: { PAGE_KEY: { type: "string", input: { type: "password" }, value } } }));
  return () => JSON.parse(fs.readFileSync(file, "utf8")).setup_args.PAGE_KEY.value;
}

const kept = () => entries().filter((e) => e.kind === "page-key");

/** pageKey's refusal: the user's two steps, naming the skill's settings, and the guide's step 1. */
const asksForIt = (e: Error) =>
  e instanceof Told &&
  e.message.includes("1. In AnythingLLM, open Settings › Browser Extension, create a key and copy it. 2. Open Settings › Agent Skills › Test, paste it into PAGE_KEY and save.") &&
  e.message.includes("https://everything-llm.github.io/anywhere-llm-suite/setup.html#page-key") &&
  e.message.includes("never ask for the key in the chat");

beforeEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
  Object.assign(allm, { valid: new Set(), checks: 0 });
  process.env.ANYTHINGLLM_URL = CHECK;
  forget();
});

test("install's key is used while AnythingLLM takes it, and asked about again only after a while", async () => {
  writeAtomic(pageKeyFile(storage), "brx-installed\n");
  allm.valid.add("brx-installed");
  assert.deepEqual(await find(SKILL, undefined), []);
  assert.equal(pageKey(), "brx-installed");
  assert.equal(allm.checks, 1);
  await find(SKILL, undefined);
  assert.equal(allm.checks, 1);
});

test("PAGE_KEY is checked, kept in the vault ahead of install's and emptied; saved again, it's only emptied", async () => {
  writeAtomic(pageKeyFile(storage), "brx-installed\n");
  allm.valid.add("brx-installed").add("brx-given");
  const value = setPageKey("brx-given");
  const said = await find(SKILL, "stale");
  assert.match(said.join("\n"), /The key in PAGE_KEY \(Settings › Agent Skills › Test\) is kept in the Vault for the pages, and the field is empty again\. Every suite skill finds it now\./);
  assert.equal(value(), "", "the field is empty again");
  assert.equal(pageKey(), "brx-given", "the vault's comes before install's");
  assert.equal(kept().length, 1);
  assert.ok(!fs.readFileSync(path.join(vaultDir(), "vault.json"), "utf8").includes("brx-given"), "sealed");
  setPageKey("brx-given"); // a settings page left open, saved again
  assert.deepEqual(await find(SKILL, undefined), [], "nothing to tell");
  assert.equal(value(), "");
  assert.equal(kept().length, 1);
  assert.equal(pageKey(), "brx-given");
});

test("a PAGE_KEY that isn't a browser-extension key, or that AnythingLLM refuses, isn't kept, and the field is emptied", async () => {
  const value = setPageKey("sk-nope");
  assert.match((await find(SKILL, undefined)).join("\n"), /isn't a browser-extension key \(those start "brx-"\)[^\n]*setup\.html#page-key/);
  assert.equal(value(), "");
  setPageKey("brx-revoked");
  assert.match((await find(SKILL, undefined)).join("\n"), /AnythingLLM refused the key in PAGE_KEY/);
  assert.equal(value(), "");
  assert.equal(kept().length, 0);
});

test("a key AnythingLLM refuses (a 403) is dropped, and the order goes on: install's next, then the chat asks", async () => {
  writeAtomic(pageKeyFile(storage), "brx-installed\n");
  allm.valid.add("brx-installed").add("brx-given");
  setPageKey("brx-given");
  await find(SKILL, undefined);
  assert.equal(pageKey(), "brx-given");
  allm.valid.delete("brx-given"); // revoked in Settings › Browser Extension
  forget();
  assert.deepEqual(await find(SKILL, undefined), []);
  assert.equal(kept().length, 0, "dropped from the vault");
  assert.equal(pageKey(), "brx-installed");
  allm.valid.delete("brx-installed");
  forget();
  await find(SKILL, undefined);
  assert.throws(pageKey, asksForIt, "install's refused one is passed over");
  assert.equal(keyStamp(), "");
  allm.valid.add("brx-new");
  setPageKey("brx-new");
  await find(SKILL, undefined);
  assert.equal(pageKey(), "brx-new", "a new one given takes its place");
  assert.equal(keyStamp().length, 8);
});

test("a key that can't be checked (AnythingLLM not reached) is taken as good", async () => {
  process.env.ANYTHINGLLM_URL = "http://127.0.0.1:1";
  writeAtomic(pageKeyFile(storage), "brx-installed\n");
  await find(SKILL, undefined);
  assert.equal(pageKey(), "brx-installed");
});

test("with no key anywhere, pageKey's refusal gives the two steps and the guide, naming this skill's settings", async () => {
  assert.deepEqual(await find(SKILL, undefined), []);
  assert.throws(pageKey, asksForIt);
});

test("with a vault this skill can't read (a newer format), install's key is still found", async () => {
  allm.valid.add("brx-given").add("brx-installed");
  setPageKey("brx-given");
  await find(SKILL, undefined);
  fs.writeFileSync(path.join(vaultDir(), "vault.json"), JSON.stringify({ v: 99, pub: null, box: {} }));
  forget();
  assert.deepEqual(await find(SKILL, undefined), []);
  assert.throws(pageKey, Told);
  writeAtomic(pageKeyFile(storage), "brx-installed\n");
  await find(SKILL, undefined);
  assert.equal(pageKey(), "brx-installed");
});
