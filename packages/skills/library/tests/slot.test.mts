// The key slot (src/slot.ts): KEY_FOR and NEW_KEY in the library's own settings, as AnythingLLM's
// settings page saves them (the whole plugin.json, as the page showed it), taken at the next call.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { call, installed, postVault, reset, seal, storage, vaultState } from "./harness.mts";

const KEY = "tok-slot-0123456789";

test.beforeEach(reset);

/** The library installed where AnythingLLM keeps it: its settings' values as they are now, and a
 *  save of its settings page with `values`, from the plugin.json it showed (`shown`, else as it is now). */
function settingsPage(t: TestContext) {
  const skill = installed(t);
  const config = (): any => skill.config();
  const file = path.join(storage, "plugins", "agent-skills", "library-lean", "plugin.json");
  const value = (name: string): unknown => config().setup_args[name].value;
  const save = (values: Record<string, string>, shown = config()): void => {
    const config = structuredClone(shown);
    for (const [name, v] of Object.entries(values)) config.setup_args[name].value = v;
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  };
  return { value, save, config };
}

const keys = () => vaultState().secrets;

test("secret writes the site into KEY_FOR and sends the user to the slot, never the chat", async (t) => {
  const page = settingsPage(t);
  const said = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(said, /^The user gives the key in the library's own settings, so it never passes through the chat\. Tell them to open Settings › Agent Skills › Library in AnythingLLM, paste the key for api\.example\.com into NEW_KEY \(KEY_FOR says api\.example\.com\), save, and say "done" here\. When they do, call secret again with the same site and label: it says whether "ex" was saved\. Never ask for the key in the chat/);
  assert.match(said, /on the Vault instead/, "the Vault stays, as a second way");
  assert.equal(page.value("KEY_FOR"), "api.example.com");
  assert.equal(page.value("NEW_KEY") ?? "", "");
});

test("a key in NEW_KEY is taken at the next call, whatever it is: sealed into the vault for the need, the need met, both settings emptied", async (t) => {
  const page = settingsPage(t);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  page.save({ NEW_KEY: KEY });
  const said = await call({ action: "guide", topic: "secrets" });
  assert.match(said, /^Saved the key "ex" for api\.example\.com from NEW_KEY \(Settings › Agent Skills › Library\) into the Vault, sealed; NEW_KEY and KEY_FOR are empty again\. Tell the user it's saved, by its name only\.\n\n# Keys/);
  assert.ok(!said.includes(KEY), "the model never sees it");
  assert.equal(page.value("NEW_KEY"), "");
  assert.equal(page.value("KEY_FOR"), "");
  assert.deepEqual(keys(), [{ label: "ex", site: "api.example.com" }]);
  assert.deepEqual(vaultState().needs, [], "the need is met");
  assert.ok(!fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8").includes(KEY), "sealed");
  assert.equal(page.config().active, true, "the rest of plugin.json is as it was");
  assert.ok(page.config().entrypoint.params.action, "and AnythingLLM still finds the skill's parameters");
});

test("secret asked again after done: the key taken in the same call is saved; with NEW_KEY still empty, the instruction again", async (t) => {
  const page = settingsPage(t);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  const again = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(again, /^NEW_KEY is still empty, so nothing was saved for "ex" \(api\.example\.com\)\. Tell them to open Settings › Agent Skills › Library in AnythingLLM, paste the key for api\.example\.com into NEW_KEY/);
  assert.equal(page.value("KEY_FOR"), "api.example.com");
  page.save({ NEW_KEY: KEY });
  const done = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(done, /^Saved the key "ex" for api\.example\.com from NEW_KEY[^\n]*\n\nThe key "ex" for api\.example\.com is saved\. Call library: it shows as saved\.$/);
  assert.equal(page.value("KEY_FOR"), "", "not asked for again");
});

test("the same key saved again from a settings page left open is only emptied: not kept again, nothing said", async (t) => {
  const page = settingsPage(t);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  const shown = page.config(); // the settings page, opened after the ask and left open
  page.save({ NEW_KEY: KEY }, shown);
  await call({ action: "library" });
  postVault({ ev: "key-delete", label: "ex" }); // the user deletes it on the Vault
  await call({ action: "library" });
  assert.deepEqual(keys(), []);
  await call({ action: "secret", site: "api.other.com", label: "other" });
  page.save({ NEW_KEY: KEY }, shown); // saved again from the page left open, with the KEY_FOR it showed
  const said = await call({ action: "library" });
  assert.ok(!said.includes("Saved the key"), said.slice(0, 200));
  assert.deepEqual(keys(), [], "not kept again");
  assert.equal(page.value("NEW_KEY"), "");
  assert.equal(page.value("KEY_FOR"), "api.other.com", "KEY_FOR says the key waited for now");
  page.save({ NEW_KEY: "tok-another-key" });
  assert.match(await call({ action: "library" }), /^Saved the key "other" for api\.other\.com/, "another value is taken");
});

test("KEY_FOR emptied by a page opened before the ask: the newest need's; KEY_FOR with none asked: under the site's host", async (t) => {
  const page = settingsPage(t);
  const before = page.config();
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  page.save({ NEW_KEY: KEY }, before);
  assert.equal(page.value("KEY_FOR") ?? "", "", "the page showed none");
  assert.match(await call({ action: "library" }), /^Saved the key "ex" for api\.example\.com/);
  page.save({ KEY_FOR: "https://API.Unasked.com/v1", NEW_KEY: "tok-unasked-0123" });
  assert.match(await call({ action: "library" }), /^Saved the key "api\.unasked\.com" for api\.unasked\.com/);
  assert.deepEqual(keys(), [{ label: "ex", site: "api.example.com" }, { label: "api.unasked.com", site: "api.unasked.com" }]);
});

test("NEW_KEY with no site to go to, or one that isn't a site, isn't kept: both settings are emptied, and the agent is told", async (t) => {
  const page = settingsPage(t);
  page.save({ NEW_KEY: KEY });
  assert.match(await call({ action: "library" }), /^The key in NEW_KEY \(Settings › Agent Skills › Library\) wasn't kept: KEY_FOR doesn't say which site it is for, and no key was asked for: ask for it with secret first\. NEW_KEY and KEY_FOR are empty again\./);
  assert.equal(page.value("NEW_KEY"), "");
  page.save({ KEY_FOR: "not a site", NEW_KEY: KEY });
  assert.match(await call({ action: "library" }), /^The key in NEW_KEY [^\n]*wasn't kept: a key needs site/);
  assert.equal(page.value("NEW_KEY"), "");
  assert.equal(page.value("KEY_FOR"), "");
  assert.deepEqual(keys(), []);
});

test("KEY_FOR is emptied once nothing is asked for it any more: the key given on the Vault instead", async (t) => {
  const page = settingsPage(t);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  postVault({ ev: "key-save", label: "ex", site: "api.example.com", sealed: seal(KEY) });
  await call({ action: "library" });
  await call({ action: "library" });
  assert.equal(page.value("KEY_FOR"), "");
});
