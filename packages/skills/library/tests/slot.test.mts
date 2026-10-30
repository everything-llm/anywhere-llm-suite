// The key slot (src/slot.ts): NEW_KEY in the library's own settings, as AnythingLLM's settings page
// saves it (the whole plugin.json, as the page showed it), taken at the next call.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { call, installed, postVault, reset, storage, vaultState } from "./harness.mts";

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

test("secret names the key's site and sends the user to NEW_KEY and the guide's step 2, never the chat", async (t) => {
  const page = settingsPage(t);
  assert.ok(!("KEY_FOR" in page.config().setup_args), "one field");
  const said = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(
    said,
    /^The user gives the key in the library's own settings, so it never passes through the chat\. Tell them to open Settings › Agent Skills › Library in AnythingLLM, paste the key for api\.example\.com into NEW_KEY, save, and say "done" here; the setup guide shows it: https:\/\/everything-llm\.github\.io\/anywhere-llm-suite\/setup\.html#service-key\. When they say done, call secret again with the same site and label: it says whether "ex" was saved\. Never ask for the key in the chat/,
  );
  assert.match(said, /on the Vault instead/, "the Vault stays, as a second way");
  assert.equal(page.value("NEW_KEY") ?? "", "");
});

test("a key in NEW_KEY is taken at the next call, whatever it is: sealed into the vault for the need, the need met, the field emptied", async (t) => {
  const page = settingsPage(t);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  page.save({ NEW_KEY: KEY });
  const said = await call({ action: "guide", topic: "secrets" });
  assert.match(said, /^Saved the key "ex" for api\.example\.com from NEW_KEY \(Settings › Agent Skills › Library\) into the Vault, sealed; NEW_KEY is empty again\. Tell the user it's saved, by its name only\.\n\n# Keys/);
  assert.ok(!said.includes(KEY), "the model never sees it");
  assert.equal(page.value("NEW_KEY"), "");
  assert.deepEqual(keys(), [{ label: "ex", site: "api.example.com" }]);
  assert.deepEqual(vaultState().needs, [], "the need is met");
  assert.ok(!fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8").includes(KEY), "sealed");
  assert.equal(page.config().active, true, "the rest of plugin.json is as it was");
  assert.ok(page.config().entrypoint.params.action, "and AnythingLLM still finds the skill's parameters");
});

test("a key goes to the newest key asked for that still waits", async (t) => {
  const page = settingsPage(t);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  await call({ action: "secret", site: "api.other.com", label: "other" });
  page.save({ NEW_KEY: KEY });
  assert.match(await call({ action: "library" }), /^Saved the key "other" for api\.other\.com/);
  page.save({ NEW_KEY: "tok-second-key-0123" });
  assert.match(await call({ action: "library" }), /^Saved the key "ex" for api\.example\.com/, "then the one before it");
});

test("secret asked again after done: the key taken in the same call is saved; with NEW_KEY still empty, the instruction again", async (t) => {
  const page = settingsPage(t);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  const again = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(again, /^NEW_KEY is still empty, so nothing was saved for "ex" \(api\.example\.com\)\. Tell them to open Settings › Agent Skills › Library in AnythingLLM, paste the key for api\.example\.com into NEW_KEY[^\n]*setup\.html#service-key/);
  page.save({ NEW_KEY: KEY });
  const done = await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(done, /^Saved the key "ex" for api\.example\.com from NEW_KEY[^\n]*\n\nThe key "ex" for api\.example\.com is saved\. Call library: it shows as saved\.$/);
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
  page.save({ NEW_KEY: KEY }, shown); // saved again from the page left open
  const said = await call({ action: "library" });
  assert.ok(!said.includes("Saved the key"), said.slice(0, 200));
  assert.deepEqual(keys(), [], "not kept again");
  assert.equal(page.value("NEW_KEY"), "");
  page.save({ NEW_KEY: "tok-another-key" });
  assert.match(await call({ action: "library" }), /^Saved the key "other" for api\.other\.com/, "another value is taken");
});

test("NEW_KEY with no key asked for stays there, the agent is told, and the next ask takes it", async (t) => {
  const page = settingsPage(t);
  page.save({ NEW_KEY: KEY });
  assert.match(await call({ action: "library" }), /^NEW_KEY \(Settings › Agent Skills › Library\) holds a key, but the library didn't ask for one, so it doesn't know which site it goes to: it stays there\./);
  assert.equal(page.value("NEW_KEY"), KEY);
  assert.deepEqual(keys(), []);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  assert.match(await call({ action: "library" }), /^Saved the key "ex" for api\.example\.com/);
  assert.equal(page.value("NEW_KEY"), "");
});

test("a key the vault can't keep (one of a newer format) stays in NEW_KEY for a call that can", async (t) => {
  const page = settingsPage(t);
  await call({ action: "secret", site: "api.example.com", label: "ex" });
  const file = path.join(storage, "vault-lean", "vault.json");
  const kept = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, JSON.stringify({ v: 99, pub: null, box: {} }));
  page.save({ NEW_KEY: KEY });
  await call({ action: "guide" });
  assert.equal(page.value("NEW_KEY"), KEY, "not emptied: it would be lost");
  fs.writeFileSync(file, kept);
  assert.match(await call({ action: "guide" }), /^Saved the key "ex"/);
});
