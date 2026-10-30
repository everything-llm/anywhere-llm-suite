// The suite against the real thing, which tools/e2e starts and names in the environment:
//
//   E2E_ALLM_URL, E2E_PASSWORD  AnythingLLM from here, and its password (AUTH_TOKEN)
//   E2E_CLI                     the built anywherellm-suite.cjs, with ANYTHINGLLM_URL in the environment
//   E2E_STORAGE                 the throwaway's storage folder, as this machine sees it
//
// Also E2E_ENGINE, E2E_CONTAINER, E2E_ALLM_PORT and E2E_WORKSPACE (the slug of the one workspace
// AnythingLLM holds), for a command run in the tests' place (tools/e2e-skill). The agent's control
// server is anywherellm-bridge's, with its own e2e.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { request } from "../packages/shared/upstream.mts";

const env = (name: string): string => process.env[name] ?? "";
const run = !env("E2E_CONTAINER") ? { skip: "run it through tools/e2e" } : {};

/** `call`, once more if AnythingLLM closed the connection it reused: fetch keeps one open, and
 *  AnythingLLM closes an idle one after 5 s, which a skill's call in the container can outlast. */
async function again<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!/other side closed/.test(`${(e as Error).message} ${((e as Error).cause as Error | undefined)?.message}`)) throw e;
    return call();
  }
}

/** AnythingLLM's internal API, logged in as its pages are: its JSON for `path`. */
async function allm(path: string): Promise<any> {
  return again(async () => {
    const login = await request(`${env("E2E_ALLM_URL")}/api/request-token`, { method: "POST", body: { password: env("E2E_PASSWORD") } });
    const token = String((login.json as { token?: unknown } | null)?.token);
    return (await request(`${env("E2E_ALLM_URL")}/api${path}`, { token, timeout: 120_000 })).json;
  });
}

/** A login's token for AnythingLLM's internal API, as its pages get one. */
async function login(): Promise<string> {
  const reply = await again(() => request(`${env("E2E_ALLM_URL")}/api/request-token`, { method: "POST", body: { password: env("E2E_PASSWORD") } }));
  return String((reply.json as { token?: unknown } | null)?.token);
}

/** A call of AnythingLLM's internal API as a login: its status and JSON. */
async function api(method: string, path: string, body?: unknown) {
  const token = await login();
  return again(() => request(`${env("E2E_ALLM_URL")}/api${path}`, { method, body, token, timeout: 120_000 }));
}

/** The skill `hubId`'s plugin.json, as AnythingLLM lists it to its settings page. */
async function skillConfig(hubId: string): Promise<any> {
  const { settings } = await allm("/admin/system-preferences-for?labels=imported_agent_skills");
  return settings.imported_agent_skills.find((s: { hubId: string }) => s.hubId === hubId);
}

/** Saves the skill's settings as AnythingLLM's settings page does: the whole plugin.json it showed
 *  (`shown`), with `values` in place, through its own endpoint. */
async function saveSettings(hubId: string, shown: any, values: Record<string, string>): Promise<void> {
  const updates = structuredClone(shown);
  for (const [name, value] of Object.entries(values)) updates.setup_args[name].value = value;
  const saved = await api("POST", `/experimental/agent-plugins/${hubId}/config`, { updates });
  assert.equal(saved.status, 200);
}

// A call of a skill inside the container, as AnythingLLM's agent makes one: the skill loaded by
// AnythingLLM's own loader (ImportedPlugin, which reads plugin.json and its settings), from its
// server folder, in a node process of its own (as a scheduled job's is). It prints the answer as JSON.
const CALL = `const ImportedPlugin = require("/app/server/utils/agents/imported.js");
const [hubId, args, slug] = process.argv.slice(2);
const loaded = ImportedPlugin.loadPluginByHubId(hubId);
const plugin = loaded.plugin(loaded.parseCallOptions());
let fn;
plugin.setup({ handlerProps: { invocation: { workspace: { slug }, thread_id: 1 }, log: (m) => console.error(m) }, function: (def) => (fn = def) });
fn.handler.call(fn, JSON.parse(args)).then((a) => (console.log(JSON.stringify({ answer: a, options: ImportedPlugin.loadPluginByHubId(hubId).parseCallOptions() })), process.exit(0)));`;

/** Calls the skill `hubId` with `args` in the container: its answer, and the settings AnythingLLM's
 *  loader reads from its plugin.json after the call (loaded again, as the next agent run loads it). */
function skillCall(hubId: string, args: Record<string, unknown>): { answer: string; options: Record<string, unknown> } {
  const script = path.join(env("E2E_STORAGE"), "e2e-call.js");
  fs.writeFileSync(script, CALL);
  const done = spawnSync(env("E2E_ENGINE"), ["exec", "-w", "/app/server", "-e", "STORAGE_DIR=/app/server/storage", env("E2E_CONTAINER"), "node", "/app/server/storage/e2e-call.js", hubId, JSON.stringify(args), env("E2E_WORKSPACE")], { encoding: "utf8", timeout: 120_000 });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  return JSON.parse(done.stdout.trim().split("\n").at(-1)!);
}

/** The settings a page's HTML was written with: its key among them. */
async function pageCfg(pagePath: string): Promise<{ key: string; token: string; secret: string }> {
  const html = await again(async () => (await fetch(env("E2E_ALLM_URL") + pagePath)).text());
  return JSON.parse(html.match(/const cfg = (\{.*?\});/)![1]);
}

/** Posts an event as a page does, with `key`: the status AnythingLLM's upload answers. */
async function upload(key: string): Promise<number> {
  const res = await again(() =>
    fetch(`${env("E2E_ALLM_URL")}/api/browser-extension/upload-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ textContent: JSON.stringify({ e2e: 1 }), metadata: { title: "e2e-upload", docSource: "e2e" } }),
    }),
  );
  return res.status;
}

/** The browser-extension keys AnythingLLM lists in Settings › Browser Extension. */
const extensionKeys = async (): Promise<{ id: number; key: string }[]> => ((await api("GET", "/browser-extension/api-keys")).json as { apiKeys: { id: number; key: string }[] }).apiKeys;

/** The Vault page's path in an answer that gives its card. */
const vaultPath = (answer: string): string => answer.match(/\((\/vault-lean\/[\w-]+\.html)\)/)![1];

test("AnythingLLM's server runs in its server folder, where a skill finds its models (serverDir)", run, () => {
  const find = `const fs = require("fs");
for (const p of fs.readdirSync("/proc").filter((n) => /^\\d+$/.test(n)))
  try {
    if (/node .*index\\.js/.test(fs.readFileSync("/proc/" + p + "/cmdline", "utf8").replace(/\\0/g, " "))) console.log(fs.readlinkSync("/proc/" + p + "/cwd"));
  } catch {}`;
  const done = spawnSync(env("E2E_ENGINE"), ["exec", env("E2E_CONTAINER"), "node", "-e", find], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(done.stdout.split("\n").includes("/app/server"), done.stdout);
});

test("with no key from install, a skill makes one with AnythingLLM's own model, the upload takes it, and a revoked one is replaced", run, async () => {
  const first = skillCall("library-lean", { action: "library" });
  assert.match(first.answer, /^The pages had no key to post with, so Library made one with AnythingLLM\. Tell the user they'll see it under Settings › Browser Extension, where they can revoke it/);
  const made = (await pageCfg(vaultPath(first.answer))).key;
  assert.match(made, /^brx-/);
  assert.ok((await extensionKeys()).some((k) => k.key === made), "AnythingLLM lists it in Settings › Browser Extension");
  assert.equal(await upload(made), 200, "AnythingLLM's upload takes it");
  assert.doesNotMatch(skillCall("browser-lean", { action: "guide" }).answer, /made one/, "another skill finds it in the vault");

  const id = (await extensionKeys()).find((k) => k.key === made)!.id;
  assert.equal((await api("DELETE", `/browser-extension/api-keys/${id}`)).status, 200); // revoked in Settings › Browser Extension
  assert.equal(await upload(made), 403);
  const again = skillCall("library-lean", { action: "library" });
  assert.match(again.answer, /^The pages had no key to post with, so Library made one/, "the refused key is dropped, and another made");
  const remade = (await pageCfg(vaultPath(again.answer))).key;
  assert.notEqual(remade, made);
  assert.equal(await upload(remade), 200);

  // A key the user gives in PAGE_KEY, as the chat would ask, from Settings › Browser Extension.
  const given = String(((await api("POST", "/browser-extension/api-keys/new")).json as { apiKey: string }).apiKey);
  await saveSettings("apps-lean", await skillConfig("apps-lean"), { PAGE_KEY: given });
  const took = skillCall("apps-lean", { action: "list" });
  assert.match(took.answer, /^The key in PAGE_KEY \(Settings › Agent Skills › Artifacts\) is kept in the Vault for the pages, and the field is empty again\./);
  assert.equal((await skillConfig("apps-lean")).setup_args.PAGE_KEY.value, "", "emptied in plugin.json");
  assert.equal((await pageCfg(vaultPath(skillCall("library-lean", { action: "library" }).answer))).key, given, "every skill's pages post with it now");
});

test("a key saved in the library's settings is taken by its next call: the field really empties, and AnythingLLM still loads the skill", run, async () => {
  const asked = skillCall("library-lean", { action: "secret", site: "api.example.com", label: "ex" });
  assert.match(asked.answer, /paste the key for api\.example\.com into NEW_KEY/);
  const shown = await skillConfig("library-lean");
  assert.equal(shown.setup_args.KEY_FOR.value, "api.example.com", "the skill wrote KEY_FOR while AnythingLLM runs");
  await saveSettings("library-lean", shown, { NEW_KEY: "e2e-slot-key-0123" });
  const taken = skillCall("library-lean", { action: "guide" });
  assert.match(taken.answer, /^Saved the key "ex" for api\.example\.com from NEW_KEY \(Settings › Agent Skills › Library\) into the Vault, sealed; NEW_KEY and KEY_FOR are empty again\./);
  assert.ok(!taken.answer.includes("e2e-slot-key-0123"));
  const after = await skillConfig("library-lean");
  assert.equal(after.setup_args.NEW_KEY.value, "");
  assert.equal(after.setup_args.KEY_FOR.value, "");
  assert.equal(taken.options.NEW_KEY, null, "AnythingLLM's loader reads it empty");
  assert.equal(after.active, true);
  const { settings } = await allm("/admin/system-preferences-for?labels=imported_agent_skills");
  assert.ok(settings.imported_agent_skills.some((s: { hubId: string }) => s.hubId === "library-lean"), "and still lists it");
  const vault = vaultPath(skillCall("library-lean", { action: "library" }).answer);
  const keys: any = await again(async () => (await fetch(env("E2E_ALLM_URL") + vault.replace(/\.html$/, "-keys.json"))).json());
  assert.deepEqual(keys.secrets.map((k: { label: string }) => k.label), ["ex"], "in the vault");
  assert.ok(!fs.readFileSync(path.join(env("E2E_STORAGE"), "vault-lean", "vault.json"), "utf8").includes("e2e-slot-key-0123"), "sealed");

  await saveSettings("library-lean", shown, { NEW_KEY: "e2e-slot-key-0123" }); // the settings page left open, saved again
  const repeat = skillCall("library-lean", { action: "guide" });
  assert.doesNotMatch(repeat.answer, /Saved the key/);
  assert.equal((await skillConfig("library-lean")).setup_args.NEW_KEY.value, "");
});

test("AnythingLLM lists the skills install put in", run, async () => {
  const { settings } = await allm("/admin/system-preferences-for?labels=imported_agent_skills");
  assert.ok(settings.imported_agent_skills.some((s: { hubId: string }) => s.hubId === "library-lean"), JSON.stringify(settings));
});

test("health passes for what install set up", run, () => {
  const done = spawnSync(process.execPath, [env("E2E_CLI"), "health", "--storage", env("E2E_STORAGE")], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /ok +the library skill/);
  assert.match(done.stdout, /ok +the pages' key/);
});

test("wake: a job runs when the wake asks, also when it's switched off", run, async () => {
  // The wake skill's own client, logged in with AnythingLLM's password as the skill is. The
  // throwaway has no model set up, so each run fails at once; that a run is made is what counts.
  const { Anything } = await import("../packages/skills/wake/src/anything.ts");
  const base = env("E2E_ALLM_URL");
  const api = new Anything(base, () => env("E2E_PASSWORD"));
  const login = await request(`${base}/api/request-token`, { method: "POST", body: { password: env("E2E_PASSWORD") } });
  const token = String((login.json as { token?: unknown }).token);
  const made = await request(`${base}/api/scheduled-jobs/new`, { method: "POST", token, body: { name: "wake e2e", prompt: "Say hi.", tools: null, schedule: "0 0 1 1 *" } });
  const id = Number((made.json as { job: { id: number } }).job.id);
  assert.equal(await api.jobName(id), "wake e2e");
  const runs = async () => ((await api.call("GET", `/scheduled-jobs/${id}/runs`)) as { runs: unknown[] }).runs.length;
  const settled = async (n: number) => {
    for (let i = 0; i < 300 && ((await runs()) < n || (await api.busy(id))); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await runs(), n);
  };
  await api.trigger(id);
  await settled(1);
  const off = await request(`${base}/api/scheduled-jobs/${id}`, { method: "PUT", token, body: { enabled: false } });
  assert.equal((off.json as { job: { enabled: boolean } }).job.enabled, false);
  await api.trigger(id);
  await settled(2);
});
