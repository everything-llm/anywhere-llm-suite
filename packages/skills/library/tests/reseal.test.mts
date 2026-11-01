// A key a scheduled job's function calls with, lost from the vault and given again in NEW_KEY (board
// #58, c804): the test instance's sequence. The key was saved from NEW_KEY, the pages' key kept from
// PAGE_KEY, the function ran from a job; then the key was gone ("no key named ... is saved"), and the
// same key pasted into NEW_KEY again was only emptied, as a settings page left open saving it again
// is, and nothing was written. The same key, given again for the same name, is taken again.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { close, listen } from "#shared/test-helpers";
import { call, idOf, installed, postVault, reset, runRecord, storage } from "./harness.mts";

const TOKEN = "tk_trial-0123456789abcdef";
const api = http.createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${TOKEN}`;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify(ok ? { messages: [] } : { error: "unauthorized" }));
});
const BASE = `http://127.0.0.1:${await listen(api)}`;
test.after(() => close(api));
test.beforeEach(reset);

const vaultFile = path.join(storage, "vault-lean", "vault.json");
const pluginFile = path.join(storage, "plugins", "agent-skills", "library-lean", "plugin.json");

/** Saves the library's settings as AnythingLLM's settings page does, `values` in place. */
function save(values: Record<string, string>): void {
  const config = JSON.parse(fs.readFileSync(pluginFile, "utf8"));
  for (const [name, v] of Object.entries(values)) config.setup_args[name].value = v;
  fs.writeFileSync(pluginFile, JSON.stringify(config, null, 2));
}
const value = (name: string): unknown => JSON.parse(fs.readFileSync(pluginFile, "utf8")).setup_args[name].value ?? "";

/** What a scheduled job sees: a process of its own (no cache of the vault), no workspace. */
function asJob(): void {
  for (const s of Object.getOwnPropertySymbols(globalThis)) if (/vault\.cache|pagekey/.test(String(s))) delete (globalThis as unknown as Record<symbol, unknown>)[s];
}

/** How the trial's function ended, run from a scheduled job: "ok", or its error. */
async function poll(): Promise<string> {
  asJob();
  const record = runRecord(idOf(await call({ action: "run", name: "ntfy.check_messages" }, null)));
  return record.status === "ok" ? "ok" : `${record.error.name}: ${record.error.message}`;
}

/** The trial as set up on the instance: the key from NEW_KEY, the toolkit, its function. */
async function trial(t: TestContext): Promise<void> {
  installed(t);
  await call({ action: "secret", site: "127.0.0.1", label: "ntfy-trial" });
  save({ NEW_KEY: TOKEN });
  assert.match(await call({ action: "library" }), /^Saved the key "ntfy-trial" for 127\.0\.0\.1 from NEW_KEY/);
  const source = "async function main(input, kit) { const a = await kit.http({ path: '/messages', auth: 'ntfy-trial' }); if (!a.ok) throw new Error('the API answered ' + a.status); return a.body; }";
  await call({ action: "save", service: "ntfy", toolkit: { base_urls: [BASE], secrets: [{ label: "ntfy-trial", as: "bearer" }] }, function: { name: "check_messages", description: "New messages.", source } });
  assert.equal(await poll(), "ok");
}

test("the trial's sequence: a key lost from the vault is given again in NEW_KEY, written, and the job's function calls with it again", async (t) => {
  await trial(t);
  save({ PAGE_KEY: "brx-browser-extension-key" });
  assert.match(await call({ action: "library" }), /The key in PAGE_KEY \(Settings › Agent Skills › Library\) is kept in the Vault for the pages/);
  assert.equal(value("PAGE_KEY"), "");
  assert.equal(await poll(), "ok", "keeping the pages' key leaves the key the function calls with");

  postVault({ ev: "key-delete", label: "ntfy-trial" }); // the key goes from the vault
  await call({ action: "library" });
  assert.equal(await poll(), 'KitError: no key named "ntfy-trial" is saved: ask the user for it with secret');

  // The reseal: asked for again, the same key pasted into NEW_KEY, the secret action called again.
  await call({ action: "secret", site: "127.0.0.1", label: "ntfy-trial" });
  const before = fs.statSync(vaultFile).mtimeMs;
  save({ NEW_KEY: TOKEN });
  const said = await call({ action: "secret", site: "127.0.0.1", label: "ntfy-trial" });
  assert.match(said, /^Saved the key "ntfy-trial" for 127\.0\.0\.1 from NEW_KEY[^\n]*\n\nThe key "ntfy-trial" for 127\.0\.0\.1 is saved\./);
  assert.equal(value("NEW_KEY"), "");
  assert.notEqual(fs.statSync(vaultFile).mtimeMs, before, "the vault is written");
  assert.equal(await poll(), "ok", "the job's function calls with it again");
});

test("the same key saved again while it is still in the vault is only emptied, and the answer says it is saved already", async (t) => {
  await trial(t);
  const before = fs.readFileSync(vaultFile, "utf8");
  save({ NEW_KEY: TOKEN }); // a settings page left open, saved again
  const said = await call({ action: "library" });
  assert.match(said, /^NEW_KEY \(Settings › Agent Skills › Library\) held the key saved already as "ntfy-trial" \(127\.0\.0\.1\): nothing changed, and NEW_KEY is empty again\./);
  assert.equal(value("NEW_KEY"), "");
  assert.equal(fs.readFileSync(vaultFile, "utf8"), before, "nothing written");
});

test("a key the vault can't be written with stays in NEW_KEY, and the answer says why instead of claiming it saved", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes a read-only folder");
  await trial(t);
  await call({ action: "secret", site: "127.0.0.1", label: "other" });
  const dir = path.dirname(vaultFile);
  save({ NEW_KEY: "tk_other-0123456789" });
  fs.chmodSync(dir, 0o500);
  let said: string;
  try {
    said = await call({ action: "library" });
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.match(said, /^The key in NEW_KEY \(Settings › Agent Skills › Library\) couldn't be saved in the Vault \(EACCES\): it stays in NEW_KEY for the next call\. Tell the user it wasn't saved; AnythingLLM's log has the detail\./);
  assert.ok(!said.includes("Saved the key"));
  assert.equal(value("NEW_KEY"), "tk_other-0123456789");
  assert.match(await call({ action: "library" }), /^Saved the key "other" for 127\.0\.0\.1 from NEW_KEY/);
});

test("NEW_KEY that can't be emptied after a key saved again is said so", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes a read-only file");
  await trial(t);
  save({ NEW_KEY: TOKEN });
  fs.chmodSync(path.dirname(pluginFile), 0o500); // the folder AnythingLLM's user can't write (c762)
  let said: string;
  try {
    said = await call({ action: "library" });
  } finally {
    fs.chmodSync(path.dirname(pluginFile), 0o755);
  }
  assert.match(said, /^NEW_KEY \(Settings › Agent Skills › Library\) held the key saved already as "ntfy-trial" \(127\.0\.0\.1\): nothing changed, but NEW_KEY couldn't be emptied \(EACCES\): the user empties it there by hand\./);
});
