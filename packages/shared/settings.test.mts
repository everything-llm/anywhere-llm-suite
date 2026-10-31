import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pluginFile, remember, repeated, setSettings, setting } from "./settings.mts";
import { bundle } from "./test-helpers.mts";
import { update } from "./vault.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "settings-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.STORAGE_DIR = path.join(tmp, "storage");

const arg = (type: string, value?: string) => ({ type: "string", required: false, input: { type, default: "" }, ...(value === undefined ? {} : { value }) });

/** A skill's plugin.json as AnythingLLM keeps it, with `args` as its setup_args. */
function installed(hubId: string, args: Record<string, unknown>): string {
  const file = pluginFile(hubId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hubId, active: true, description: "d", setup_args: args }), { mode: 0o640 });
  return file;
}

test("a setting is read from plugin.json as it is now; with no plugin.json, from what the call was given", () => {
  assert.equal(setting("none-lean", "NEW_KEY", " given "), "given");
  installed("one-lean", { NEW_KEY: arg("password", " k-1 "), KEY_FOR: arg("text") });
  assert.equal(setting("one-lean", "NEW_KEY", "stale"), "k-1", "the file wins over the call's runtimeArgs");
  assert.equal(setting("one-lean", "KEY_FOR", "stale"), "", "no value is empty");
});

test("settings are set in place of their values, only those declared, atomically and with the file's mode", () => {
  const file = installed("two-lean", { NEW_KEY: arg("password", "k-1"), KEY_FOR: arg("text", "api.example.com"), ANYTHINGLLM_URL: arg("text", "https://llm.example.com") });
  assert.equal(setSettings("two-lean", { NEW_KEY: "", KEY_FOR: "", OTHER: "x" }), true);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.setup_args.NEW_KEY.value, "");
  assert.equal(config.setup_args.KEY_FOR.value, "");
  assert.equal(config.setup_args.ANYTHINGLLM_URL.value, "https://llm.example.com", "the others stay");
  assert.ok(!("OTHER" in config.setup_args), "a setting the skill doesn't declare isn't added");
  assert.equal(config.description, "d");
  if (process.platform !== "win32") assert.equal((fs.statSync(file).mode & 0o777).toString(8), "640");
  assert.equal(setSettings("two-lean", { NEW_KEY: "" }), false, "nothing to change, nothing written");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["plugin.json"], "no temporary file is left");
  assert.equal(setSettings("none-lean", { NEW_KEY: "" }), false, "no plugin.json, nothing written");
});

test("a skill imported from the Hub, in the folder the Hub's id for it names, finds its plugin.json beside its handler.js, not by its hubId", async () => {
  // As AnythingLLM imports one (utils/agents/imported.js): the folder, and the plugin.json's hubId,
  // are the Hub's item id. The module, bundled as the skills' build bundles it, is that handler.js.
  const folder = path.join(process.env.STORAGE_DIR!, "plugins", "agent-skills", "e2e0hubitem0id");
  fs.mkdirSync(folder, { recursive: true });
  const built = await bundle(new URL("./settings.mts", import.meta.url));
  fs.copyFileSync(built, path.join(folder, "handler.js"));
  const file = path.join(folder, "plugin.json");
  fs.writeFileSync(file, JSON.stringify({ hubId: "e2e0hubitem0id", active: true, setup_args: { NEW_KEY: arg("password", "k-hub") } }));
  const loaded: typeof import("./settings.mts") = createRequire(import.meta.url)(path.join(folder, "handler.js"));
  assert.equal(loaded.pluginFile("hub-lean"), file);
  assert.equal(loaded.setting("hub-lean", "NEW_KEY", "stale"), "k-hub", "the file beside it, not the call's runtimeArgs");
  assert.equal(loaded.setSettings("hub-lean", { NEW_KEY: "" }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).setup_args.NEW_KEY.value, "", "emptied there");
  assert.ok(!fs.existsSync(pluginFile("hub-lean")), "nothing by its hubId");
  assert.equal(createRequire(import.meta.url)(built).pluginFile("hub-lean"), pluginFile("hub-lean"), "a bundle run elsewhere goes by the hubId");
});

test("what a slot gave is remembered as a digest, by skill and setting, and the same value again is a repeat", async () => {
  assert.equal(repeated("one-lean", "NEW_KEY", "k-1"), false);
  await update((v) => remember(v, "one-lean", "NEW_KEY", "k-1"));
  assert.equal(repeated("one-lean", "NEW_KEY", "k-1"), true);
  assert.equal(repeated("one-lean", "NEW_KEY", "k-2"), false, "another value isn't");
  assert.equal(repeated("one-lean", "PAGE_KEY", "k-1"), false, "another slot's isn't");
  assert.ok(!fs.readFileSync(path.join(process.env.STORAGE_DIR!, "vault-lean", "vault.json"), "utf8").includes("one-lean"), "kept inside the sealed vault");
});
