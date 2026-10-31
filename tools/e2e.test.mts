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

test("with no key from install, the chat gives the user's two steps; a key given in PAGE_KEY is kept, the upload takes it, and a revoked one is dropped", run, async () => {
  const first = skillCall("library-lean", { action: "library" });
  assert.match(first.answer, /The Vault and the Library page aren't available here: the pages have no key to post with yet\. Give the user these two steps[^\n]*1\. In AnythingLLM, open Settings › Browser Extension, create a key and copy it\. 2\. Open Settings › Agent Skills › Library, paste it into PAGE_KEY and save\. The setup guide shows both: https:\/\/everything-llm\.github\.io\/anywhere-llm-suite\/setup\.html#page-key/);
  assert.equal((await extensionKeys()).length, 0, "no skill made one");

  // The key the user makes in Settings › Browser Extension and pastes into one skill's PAGE_KEY.
  const make = async () => String(((await api("POST", "/browser-extension/api-keys/new")).json as { apiKey: string }).apiKey);
  const given = await make();
  await saveSettings("library-lean", await skillConfig("library-lean"), { PAGE_KEY: given });
  const took = skillCall("library-lean", { action: "library" });
  assert.match(took.answer, /^The key in PAGE_KEY \(Settings › Agent Skills › Library\) is kept in the Vault for the pages, and the field is empty again\./);
  assert.equal((await skillConfig("library-lean")).setup_args.PAGE_KEY.value, "", "emptied in plugin.json");
  assert.equal((await pageCfg(vaultPath(took.answer))).key, given);
  assert.equal(await upload(given), 200, "AnythingLLM's upload takes it");
  assert.doesNotMatch(skillCall("apps-lean", { action: "list" }).answer, /no key to post with/, "another skill finds it in the vault");

  const id = (await extensionKeys()).find((k) => k.key === given)!.id;
  assert.equal((await api("DELETE", `/browser-extension/api-keys/${id}`)).status, 200); // revoked in Settings › Browser Extension
  assert.equal(await upload(given), 403);
  assert.match(skillCall("library-lean", { action: "library" }).answer, /the pages have no key to post with yet/, "the refused key is dropped, and the chat asks again");

  const next = await make();
  await saveSettings("apps-lean", await skillConfig("apps-lean"), { PAGE_KEY: `http://127.0.0.1:3001/api|${next}` }); // as Copy API Key copies it
  assert.match(skillCall("apps-lean", { action: "list" }).answer, /^The key in PAGE_KEY \(Settings › Agent Skills › Artifacts\) is kept in the Vault/);
  assert.equal((await pageCfg(vaultPath(skillCall("library-lean", { action: "library" }).answer))).key, next, "every skill's pages post with it now");
  assert.equal(await upload(next), 200);
});

test("a key saved in the library's settings is taken by its next call: the field really empties, and AnythingLLM still loads the skill", run, async () => {
  const asked = skillCall("library-lean", { action: "secret", site: "api.example.com", label: "ex" });
  assert.match(asked.answer, /paste the key for api\.example\.com into NEW_KEY, save, and say "done" here; the setup guide shows it: https:\/\/everything-llm\.github\.io\/anywhere-llm-suite\/setup\.html#service-key/);
  const shown = await skillConfig("library-lean");
  assert.ok(!("KEY_FOR" in shown.setup_args), "one field");
  await saveSettings("library-lean", shown, { NEW_KEY: "e2e-slot-key-0123" });
  const taken = skillCall("library-lean", { action: "guide" });
  assert.match(taken.answer, /^Saved the key "ex" for api\.example\.com from NEW_KEY \(Settings › Agent Skills › Library\) into the Vault, sealed; NEW_KEY is empty again\./);
  assert.ok(!taken.answer.includes("e2e-slot-key-0123"));
  const after = await skillConfig("library-lean");
  assert.equal(after.setup_args.NEW_KEY.value, "");
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

// A stand-in for the agent's model, OpenAI's chat completions on 127.0.0.1 in the container, as
// AnythingLLM's Generic OpenAI provider asks it with native tool calling off (tools/e2e sets that):
// each "pick a function" request takes the next step of the queue file, { name, arguments }, after
// waiting for the file `after` names when a step has one; with none left it answers nothing, so the
// agent makes a plain completion, which answers the last message it was given (the tools' answers
// are in it). So an agent run goes through AnythingLLM's own agent, in its own process, as a chat's.
const MODEL = `const fs = require("fs");
const [port, queue] = process.argv.slice(2);
require("http").createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    res.setHeader("content-type", "application/json");
    if (!req.url.endsWith("/chat/completions")) return res.end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model" }] }));
    const messages = JSON.parse(body).messages || [];
    let content = String(messages[messages.length - 1]?.content ?? "");
    if (messages[0]?.role === "system" && /picks the most optimal function/.test(messages[0].content)) {
      const steps = JSON.parse(fs.readFileSync(queue, "utf8"));
      const step = steps.shift();
      fs.writeFileSync(queue, JSON.stringify(steps));
      if (step?.after) while (!fs.existsSync(step.after)) await new Promise((r) => setTimeout(r, 100));
      content = step ? JSON.stringify({ name: step.name, arguments: step.arguments }) : "";
    }
    res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "stand-in", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
  });
}).listen(Number(port), "127.0.0.1");`;

test("NEW_KEY saved in AnythingLLM's settings while an agent run goes on is taken by the run's next call, in the server's own process, emptied in plugin.json and kept empty: as install puts the skill, and as a Hub import names its folder", run, async () => {
  const storage = env("E2E_STORAGE");
  const inner = "/app/server/storage";
  fs.writeFileSync(path.join(storage, "e2e-model.js"), MODEL);
  fs.writeFileSync(path.join(storage, "e2e-model.json"), "[]");
  const port = 4100;
  assert.equal(spawnSync(env("E2E_ENGINE"), ["exec", "-d", env("E2E_CONTAINER"), "node", `${inner}/e2e-model.js`, String(port), `${inner}/e2e-model.json`]).status, 0);
  const llm = await api("POST", "/system/update-env", { LLMProvider: "generic-openai", GenericOpenAiBasePath: `http://127.0.0.1:${port}/v1`, GenericOpenAiModelPref: "stand-in", GenericOpenAiTokenLimit: "8192", GenericOpenAiKey: "none" });
  assert.equal(llm.status, 200);
  const key = String(((await api("POST", "/system/generate-api-key", { name: "e2e-agent" })).json as { apiKey: { secret: string } }).apiKey.secret);
  /** An agent run in the workspace, through AnythingLLM's developer API (its own agent, in its process),
   *  whose model calls `steps` in turn: the run's answer, which ends with the tools' answers. */
  const agentRun = async (steps: Record<string, unknown>[]): Promise<string> => {
    fs.writeFileSync(path.join(storage, "e2e-model.json"), JSON.stringify(steps));
    const said = await again(() => request(`${env("E2E_ALLM_URL")}/api/v1/workspace/${env("E2E_WORKSPACE")}/chat`, { method: "POST", body: { message: "@agent go on", mode: "chat" }, token: key, timeout: 120_000 }));
    assert.equal(said.status, 200, JSON.stringify(said.json));
    return String((said.json as { textResponse?: unknown }).textResponse);
  };
  const skills = path.join(storage, "plugins", "agent-skills");
  const onDisk = (folder: string): unknown => JSON.parse(fs.readFileSync(path.join(skills, folder, "plugin.json"), "utf8")).setup_args.NEW_KEY.value;
  const hub = "e2e0hubitem0id"; // a Hub import's folder, and its plugin.json's hubId, are the Hub's id for it
  try {
    for (const [folder, label] of [["library-lean", "inst"], [hub, "hub"]]) {
      if (folder === hub) {
        fs.renameSync(path.join(skills, "library-lean"), path.join(skills, hub));
        const file = path.join(skills, hub, "plugin.json");
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), hubId: hub }, null, 2));
      }
      // One run, as a chat's agent session is: it asks for the key, and calls again once the user
      // saved it in Settings › Agent Skills › Library, which AnythingLLM loaded the skill before.
      const go = `e2e-go-${label}`;
      const running = agentRun([
        { name: folder, arguments: { action: "secret", site: "api.example.com", label } },
        { name: folder, arguments: { action: "library" }, after: `${inner}/${go}` },
      ]);
      // The model has the second step, and waits: the first call (the ask) has answered.
      for (let i = 0; i < 300 && JSON.parse(fs.readFileSync(path.join(storage, "e2e-model.json"), "utf8")).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
      await saveSettings(folder, await skillConfig(folder), { NEW_KEY: `e2e-${label}-key-0123` });
      assert.equal(onDisk(folder), `e2e-${label}-key-0123`, `${folder}: saved, as AnythingLLM's settings page saves it`);
      fs.writeFileSync(path.join(storage, go), "");
      const said = await running;
      assert.match(said, new RegExp(`Saved the key "${label}" for api\\.example\\.com from NEW_KEY \\(Settings › Agent Skills › Library\\) into the Vault, sealed; NEW_KEY is empty again\\.`), `${folder}: the run's next call took it`);
      assert.ok(!said.includes(`e2e-${label}-key-0123`), "the key never goes to the model");
      assert.equal(onDisk(folder), "", `${folder}: emptied in plugin.json`);
      assert.equal((await skillConfig(folder)).setup_args.NEW_KEY.value, "", `${folder}: and as AnythingLLM's settings page shows it`);
      const next = await agentRun([{ name: folder, arguments: { action: "guide" } }]);
      assert.doesNotMatch(next, /Saved the key|NEW_KEY \(Settings › Agent Skills › Library\) holds a key/, `${folder}: nothing left to take`);
      assert.equal(onDisk(folder), "", `${folder}: and it stays empty`);
    }
  } finally {
    if (fs.existsSync(path.join(skills, hub))) {
      const file = path.join(skills, hub, "plugin.json");
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), hubId: "library-lean" }, null, 2));
      fs.renameSync(path.join(skills, hub), path.join(skills, "library-lean"));
    }
  }
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
