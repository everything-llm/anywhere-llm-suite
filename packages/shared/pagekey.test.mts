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

// AnythingLLM's keys, as its model and its browser extension's check see them: the stand-in model in
// a server folder of its own (ANYTHINGLLM_SERVER_DIR), and the check on a port of its own.
type Allm = { valid: Set<string>; made: { key: string; user: number | null }[]; multi: boolean; admins: { id: number; suspended?: number }[]; checks: number; refuseMade?: boolean };
const allm: Allm = ((globalThis as unknown as { __pageKeys: Allm }).__pageKeys = { valid: new Set(), made: [], multi: false, admins: [], checks: 0 });
const server = path.join(tmp, "server");
fs.mkdirSync(path.join(server, "models"), { recursive: true });
fs.writeFileSync(
  path.join(server, "models", "browserExtensionApiKey.js"),
  `const a = globalThis.__pageKeys;
module.exports = { BrowserExtensionApiKey: {
  create: async (userId = null) => { const key = "brx-made-" + (a.made.length + 1); a.made.push({ key, user: userId }); if (!a.refuseMade) a.valid.add(key); return { apiKey: { id: a.made.length, key, user_id: userId }, error: null }; },
  validate: async (key) => (a.valid.has(key) ? { key } : false),
} };`,
);
fs.writeFileSync(path.join(server, "models", "systemSettings.js"), "module.exports = { SystemSettings: { isMultiUserMode: async () => globalThis.__pageKeys.multi } };");
fs.writeFileSync(path.join(server, "models", "user.js"), "module.exports = { User: { where: async (c) => (c.role === 'admin' ? globalThis.__pageKeys.admins : []) } };");
const nothing = path.join(tmp, "no-server");

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

beforeEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
  Object.assign(allm, { valid: new Set(), made: [], multi: false, admins: [], checks: 0, refuseMade: false });
  process.env.ANYTHINGLLM_URL = CHECK;
  process.env.ANYTHINGLLM_SERVER_DIR = server;
  forget();
});

test("install's key is used while AnythingLLM takes it, and none is made", async () => {
  writeAtomic(pageKeyFile(storage), "brx-installed\n");
  allm.valid.add("brx-installed");
  assert.deepEqual(await find(SKILL, undefined), []);
  assert.equal(pageKey(), "brx-installed");
  assert.equal(allm.made.length, 0);
  assert.equal(allm.checks, 1);
  await find(SKILL, undefined);
  assert.equal(allm.checks, 1, "asked again only after a while");
});

test("PAGE_KEY is checked, kept in the vault ahead of install's and emptied; saved again, it's only emptied", async () => {
  writeAtomic(pageKeyFile(storage), "brx-installed\n");
  allm.valid.add("brx-installed").add("brx-given");
  const value = setPageKey("brx-given");
  const said = await find(SKILL, "stale");
  assert.match(said.join("\n"), /The key in PAGE_KEY \(Settings › Agent Skills › Test\) is kept in the Vault/);
  assert.equal(value(), "", "the field is empty again");
  assert.equal(pageKey(), "brx-given", "the vault's comes before install's");
  assert.equal(kept().length, 1);
  assert.equal(kept()[0].made, false);
  assert.ok(!fs.readFileSync(path.join(vaultDir(), "vault.json"), "utf8").includes("brx-given"), "sealed");
  setPageKey("brx-given"); // a settings page left open, saved again
  assert.deepEqual(await find(SKILL, undefined), [], "nothing to tell");
  assert.equal(value(), "");
  assert.equal(kept().length, 1);
});

test("a PAGE_KEY that isn't a browser-extension key, or that AnythingLLM refuses, isn't kept, and the field is emptied", async () => {
  const value = setPageKey("sk-nope");
  assert.match((await find(SKILL, undefined)).join("\n"), /isn't a browser-extension key \(those start "brx-"\)/);
  assert.equal(value(), "");
  setPageKey("brx-revoked");
  const said = (await find(SKILL, undefined)).join("\n");
  assert.match(said, /AnythingLLM refused the key in PAGE_KEY/);
  assert.equal(value(), "");
  assert.ok(!kept().some((e) => e.value === "brx-revoked"));
});

test("a key AnythingLLM refuses (a 403) is dropped, and the order goes on: install's next, then one made", async () => {
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
  const said = (await find(SKILL, undefined)).join("\n");
  assert.match(said, /so Test made one with AnythingLLM\. Tell the user they'll see it under Settings › Browser Extension, where they can revoke it/);
  assert.deepEqual(allm.made, [{ key: "brx-made-1", user: null }], "for no user, in single-user mode");
  assert.equal(pageKey(), "brx-made-1", "the made one, not install's refused one");
  assert.equal(kept()[0].made, true);
  assert.deepEqual(await find(SKILL, undefined), [], "found in the vault after");
  assert.equal(allm.made.length, 1);
});

test("with no check to reach, AnythingLLM's model says; with neither, a key is taken as good", async () => {
  process.env.ANYTHINGLLM_URL = "http://127.0.0.1:1";
  writeAtomic(pageKeyFile(storage), "brx-installed\n");
  await find(SKILL, undefined);
  assert.equal(pageKey(), "brx-made-1", "the model refused install's, and made one");
  process.env.ANYTHINGLLM_SERVER_DIR = nothing;
  fs.rmSync(vaultDir(), { recursive: true, force: true });
  writeAtomic(pageKeyFile(storage), "brx-other\n");
  forget();
  assert.deepEqual(await find(SKILL, undefined), []);
  assert.equal(pageKey(), "brx-other", "can't be checked: kept");
});

test("with no key to find and none to make, pageKey's refusal says to ask for PAGE_KEY in this skill's settings", async () => {
  process.env.ANYTHINGLLM_SERVER_DIR = nothing;
  assert.deepEqual(await find(SKILL, undefined), []);
  assert.throws(pageKey, (e: Error) => e instanceof Told && e.message.includes("paste it into PAGE_KEY under Settings › Agent Skills › Test") && e.message.includes("never in the chat"));
  assert.equal(keyStamp(), "");
});

test("in multi-user mode a key is made for the admin when there's one, and none when there are more", async () => {
  allm.multi = true;
  allm.admins = [{ id: 7 }, { id: 8, suspended: 1 }];
  await find(SKILL, undefined);
  assert.deepEqual(allm.made, [{ key: "brx-made-1", user: 7 }]);
  fs.rmSync(vaultDir(), { recursive: true, force: true });
  allm.admins = [{ id: 7 }, { id: 9 }];
  await find(SKILL, undefined);
  assert.equal(allm.made.length, 1, "which admin's isn't the skill's to choose");
  assert.throws(pageKey, Told);
});

test("two calls at once make one key", async () => {
  await Promise.all([find(SKILL, undefined), find({ hubId: "other-lean", name: "Other" }, undefined)]);
  assert.equal(allm.made.length, 1);
  assert.equal(keyStamp().length, 8);
});

test("with a vault this skill can't read (a newer format, a lost key), no key is made: it couldn't be kept", async () => {
  allm.valid.add("brx-given");
  setPageKey("brx-given");
  await find(SKILL, undefined); // the vault is made, and holds it
  fs.writeFileSync(path.join(vaultDir(), "vault.json"), JSON.stringify({ v: 99, pub: null, box: {} }));
  forget();
  assert.deepEqual(await find(SKILL, undefined), []);
  assert.equal(allm.made.length, 0);
  assert.throws(pageKey, Told);
});

test("keys refused as soon as they're made are made three times an hour at most, not at every call", async () => {
  allm.refuseMade = true;
  for (let i = 0; i < 6; i++) await find(SKILL, undefined);
  assert.equal(allm.made.length, 3);
  assert.throws(pageKey, Told, "and the chat asks for PAGE_KEY");
});
