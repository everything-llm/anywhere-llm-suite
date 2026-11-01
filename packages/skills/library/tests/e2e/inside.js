// Run inside a stock AnythingLLM container (tools/check, or by hand: see the skill's notes): loads the
// skill through AnythingLLM's own loader (ImportedPlugin), sets it up on a stand-in agent as
// AnythingLLM's agent would, and builds a toolkit for a stand-in API this script serves on
// 127.0.0.1 (FENCE_ALLOW lets it through): the key is asked for on the Vault and given there
// (posted as AnythingLLM's collector writes it), never on a question card; a function is saved and
// tested in QuickJS on the image's own Node, a flow runs another, and a run with no workspace (as a
// scheduled job's) is recorded as one; a job's run in a forked child, as AnythingLLM forks one, and
// one whose child is killed mid-run, which the next chat is shown as interrupted. With E2E_SSH_PORT
// (beside.sh: a real OpenSSH server at 127.0.0.1), a target registered on the page with a pasted key
// and a pinned host key, and a function's commands on it: their output, and a command past its time
// stopped with TERM. Prints "ok" or throws.
const assert = require("assert");
const { fork } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { HUB_ID } = process.env;
const APP = "/app/server";
const PORT = 18083;
const KEY = "e2e-key-0123456789";

const ImportedPlugin = require(`${APP}/utils/agents/imported.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scheduled job's process, as run-scheduled-job.js is: forked, the skill loaded afresh, no workspace.
if (process.argv[2] === "job") {
  const plugin = ImportedPlugin.loadPluginByHubId(HUB_ID).plugin({});
  let fn;
  plugin.setup({ handlerProps: { invocation: { workspace: null, workspace_id: null }, log: () => {} }, function: (def) => (fn = def) });
  return void fn.handler.call(fn, JSON.parse(process.argv[3])).then((answer) => (process.send({ answer }), process.exit(0)));
}
/** Runs `args` in a forked job process: its answer, and the process. */
const inJob = (args) => {
  const child = fork(__filename, ["job", JSON.stringify(args)]);
  return { child, answer: new Promise((resolve, reject) => (child.on("message", (m) => resolve(m.answer)), child.on("exit", (code) => code && reject(new Error(`the job's process exited ${code}`))))) };
};

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== `Bearer ${KEY}`) return ((res.statusCode = 401), res.end('{"message":"no key"}'));
  if (req.url.startsWith("/tasks")) return res.end(JSON.stringify([{ id: 1, title: "Water the plants", done: false }, { id: 2, title: "File taxes", done: true }]));
  res.statusCode = 404;
  res.end("{}");
});

(async () => {
  // The sshd beside AnythingLLM is at 127.0.0.1 in its network namespace, which a target may not be in
  // production (it's this machine); this test says it isn't, as the unit tests do (shared/thishost.mts).
  globalThis[Symbol.for("anywherellm-suite.thishost.except")] = new Set(["127.0.0.1"]);
  // And a host record, as the installer writes it on the host: a target is refused without one. The
  // fingerprint is not the sshd's, so it is "some other machine".
  globalThis[Symbol.for("anywherellm-suite.thishost.record")] = { fingerprints: ["SHA256:" + "A".repeat(43)], addresses: [], hostname: "e2e-host" };
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  assert.ok(ImportedPlugin.validateImportedPluginHandler(HUB_ID), "the handler is where AnythingLLM looks");
  assert.ok(JSON.stringify(ImportedPlugin.activeImportedPlugins()).includes(HUB_ID), "AnythingLLM lists the skill as active");
  const plugin = ImportedPlugin.loadPluginByHubId(HUB_ID).plugin({});
  const cards = [];
  const call = async (args, slug = "check") => {
    let fn;
    const agent = {
      // The workspace's row, as AnythingLLM's invocation carries it: its name with its slug.
      handlerProps: { invocation: { workspace: slug ? { slug, name: "Check room" } : null, thread_id: 1 }, log: (m) => console.error(m) },
      requestUserClarification: async (q) => (cards.push(q), { skipped: true }),
      addClarifyingQuestionSurvey: () => {},
      function: (def) => (fn = def),
    };
    plugin.setup(agent);
    assert.equal(fn.name, HUB_ID);
    return fn.handler.call(fn, args);
  };

  assert.match(await call({ action: "guide" }), /The library is the user's own set of API toolkits/);
  assert.match(await call({ action: "secret", site: "127.0.0.1", label: "tasks" }), /^The user gives the key in the library's own settings, so it never passes through the chat\. Tell them to open Settings › Agent Skills › Library in AnythingLLM, paste the key for 127\.0\.0\.1 into NEW_KEY[^]*give them this card as it is, in its own quote:\n\n> \*\*\[The Vault\]\(\/vault-lean\/[\w-]+\.html "vault"\)\*\*\n>\n> Every key and browser login, by name\.\n\n/);
  assert.equal(cards.length, 0, "never on a question card, which shows its answers in the chat");
  const storage = process.env.STORAGE_DIR || `${APP}/storage`;
  const { token, secret } = JSON.parse(fs.readFileSync(`${storage}/vault-lean/vault-page.json`, "utf8"));
  const cfg = JSON.parse(fs.readFileSync(`${APP}/public/vault-lean/${token}.html`, "utf8").match(/const cfg = (\{.*?\});/)[1]);
  const pub = crypto.createPublicKey({ key: Buffer.from(cfg.pub, "base64"), format: "der", type: "spki" });
  const sealed = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(KEY)).toString("base64");
  const events = `${storage}/documents/custom-documents`;
  fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(path.join(events, `raw-vault-lean-keys-${crypto.randomUUID()}.json`), JSON.stringify({ pageContent: JSON.stringify({ vault_lean_event: 1, secret, ev: "key-save", label: "tasks", site: "127.0.0.1", sealed }) }));
  assert.match(await call({ action: "library" }), /\[The Library\]\(\/library-lean\/[\w-]+\.html "library"\)/, "the Library page's card");

  const toolkit = { title: "Tasks", base_urls: [`http://127.0.0.1:${PORT}`], secrets: [{ label: "tasks", as: "bearer" }] };
  const open = { name: "open", description: "The tasks not done yet.", source: "async function main(i, kit) { const a = await kit.http({ path: '/tasks' }); return a.body.filter((t) => !t.done).map((t) => t.title); }" };
  const saved = await call({ action: "save", service: "tasks", toolkit, function: open, test: {} });
  assert.match(saved, /Saved tasks\.open, version 1/);
  assert.match(saved, /: ok, .*1 request/);
  assert.match(saved, /"Water the plants"/);
  assert.ok(!saved.includes("File taxes"));

  await call({ action: "save", service: "digest", toolkit: { base_urls: [`http://127.0.0.1:${PORT}`] }, function: { name: "count", description: "How many tasks are open.", source: "async function main(i, kit) { return { open: (await kit.run('tasks.open', {})).length }; }" } });
  assert.match(await call({ action: "run", name: "digest.count" }), /"open": 1/);

  const job = await call({ action: "run", name: "tasks.open" }, null);
  assert.match(job, /: ok, /);
  assert.match(await call({ action: "library" }), /- tasks\.open: ok, \d+ s ago, from a scheduled job/);
  assert.ok(!(await call({ action: "call", url: `http://127.0.0.1:${PORT}/tasks`, auth: "bearer" })).includes(KEY));

  const forked = await inJob({ action: "run", name: "digest.count" }).answer;
  assert.match(forked, /^Ran digest\.count \(r-[\w-]+\): ok, /);
  const runs = `${storage}/library-lean/runs`;
  const forkedId = forked.match(/\((r-[\w-]+)\)/)[1];
  assert.equal(JSON.parse(fs.readFileSync(`${runs}/${forkedId}.digest.count.json`, "utf8")).trigger, "job");
  await call({ action: "save", service: "digest", function: { name: "nap", description: "Naps.", source: "async function main(i, kit) { for (let n = 0; n < 30; n++) await kit.sleep(500); return 1; }" } });
  const killed = inJob({ action: "run", name: "digest.nap" });
  killed.answer.catch(() => {});
  let napping;
  for (let i = 0; i < 100 && !napping; i++) {
    await new Promise((r) => setTimeout(r, 100));
    napping = fs.readdirSync(runs).find((f) => f.endsWith(".digest.nap.json"));
  }
  assert.ok(napping, "the job's run was recorded as it started");
  killed.child.kill("SIGKILL");
  await new Promise((r) => killed.child.once("exit", r));
  assert.match(await call({ action: "library" }), /^Finished since last shown [^\n]*\n- digest\.nap: interrupted \(Interrupted: [^\n]*from a scheduled job/);

  // ---- The pages keep a draft of what's typed, in a real Chrome (the collector's) at a phone's width:
  // a reload (a phone's browser drops a page put away) brings back the Library's add form and the
  // Vault's Add a key as they were typed, never the private key or the key itself; Back and Cancel
  // drop the draft.
  {
    const puppeteer = require("/app/collector/node_modules/puppeteer");
    const viewer = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const at = `http://127.0.0.1:${process.env.INNER_PORT || 3001}`;
      const libToken = JSON.parse(fs.readFileSync(`${storage}/library-lean/page.json`, "utf8")).token;
      const vaultToken = JSON.parse(fs.readFileSync(`${storage}/vault-lean/vault-page.json`, "utf8")).token;
      const shown = await viewer.newPage();
      await shown.setViewport({ width: 390, height: 844 });
      const errors = [];
      shown.on("pageerror", (e) => errors.push(e.message));
      const PRIVATE = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA-e2e-not-a-real-key\n-----END OPENSSH PRIVATE KEY-----";
      const LINE = "256 SHA256:e2eDraftLine0123456789abcdefghijklmnopqrstu root@pi (ED25519)";
      const fieldOf = (name) => `#screen form [aria-describedby="err-${name}"]`;
      const addForm = async () => {
        await shown.waitForSelector(fieldOf("host"), { timeout: 10_000 });
        return shown.evaluate((names) => names.map((n) => document.querySelector(`#screen form [aria-describedby="err-${n}"]`)?.value ?? null), ["label", "host", "login", "fingerprint", "key"]);
      };
      const stored = () => shown.evaluate(() => JSON.stringify(Object.entries(localStorage)));
      await shown.goto(`${at}/library-lean/${libToken}.html#add`, { waitUntil: "load" });
      await addForm();
      await shown.type(fieldOf("label"), "pi");
      await shown.type(fieldOf("host"), "192.168.1.20:2222");
      await shown.type(fieldOf("login"), "sandbox");
      await shown.type(fieldOf("fingerprint"), LINE);
      await shown.click("#screen details.own summary");
      await shown.type(fieldOf("key"), PRIVATE);
      await shown.reload({ waitUntil: "load" });
      assert.deepEqual(await addForm(), ["pi", "192.168.1.20:2222", "sandbox", LINE, ""], "the add form as it was typed, the private key gone");
      const kept = await stored();
      assert.ok(kept.includes("192.168.1.20:2222"), "kept on the device");
      assert.ok(!kept.includes("OPENSSH") && !kept.includes("e2e-not-a-real-key"), "never the private key");
      assert.ok(!kept.includes(libToken), "nor the page's token");
      await shown.click("#screen .bar a.back");
      await shown.waitForSelector("#home:not([hidden])");
      await shown.goto(`${at}/library-lean/${libToken}.html#add`, { waitUntil: "load" });
      assert.deepEqual(await addForm(), ["", "", "", "", ""], "Back dropped the draft");

      // The Vault's Add a key: Name and Site come back, open as they were; the key never.
      const keysForm = "#apikeys button.add + form input";
      const vaultOpen = async () => {
        await shown.goto(`${at}/vault-lean/${vaultToken}.html`, { waitUntil: "load" });
        await shown.waitForSelector("#apikeys button.add", { timeout: 10_000 });
        return shown.$$eval(keysForm, (inputs) => inputs.map((i) => [i.type, i.value]));
      };
      assert.deepEqual(await vaultOpen(), [], "the form is closed at first");
      await shown.click("#apikeys button.add");
      const [nameIn, siteIn, keyIn] = await shown.$$(keysForm);
      await nameIn.type("github");
      await siteIn.type("api.github.com");
      await keyIn.type("ghp_e2eDraftSecretValue0123456789");
      await shown.reload({ waitUntil: "load" });
      await shown.waitForSelector(keysForm, { timeout: 10_000 });
      assert.deepEqual(await shown.$$eval(keysForm, (inputs) => inputs.map((i) => [i.type, i.value])), [["text", "github"], ["text", "api.github.com"], ["password", ""]], "open again, as it was typed, the key gone");
      assert.ok(!(await stored()).includes("ghp_e2eDraftSecretValue"), "never the key");
      await shown.click("#apikeys button.add"); // Cancel
      assert.deepEqual(await vaultOpen(), [], "Cancel dropped the draft: closed, and empty");

      // A request says which chat asked and when; Not needed hides it with an Undo that has no timer
      // (a toast without one goes after 6 s); Close (or leaving the page) sends it, and the chat that
      // asked is told at its next call.
      const toldIn = async (args) => {
        for (let i = 0; i < 40; i++) {
          const said = await call(args);
          if (said.includes("isn't needed")) return said;
          await sleep(250);
        }
        assert.fail("the chat wasn't told the user said it isn't needed");
      };
      const visible = (selector) => shown.$eval(selector, (n) => !n.hidden && !n.closest("[hidden]")).catch(() => false);
      await call({ action: "secret", kind: "ssh", label: "vm" });
      await shown.goto(`${at}/library-lean/${libToken}.html#machines`, { waitUntil: "load" });
      await shown.waitForSelector("#tab .card.need [data-need]", { timeout: 10_000 });
      assert.match(await shown.$eval("#tab .card.need", (n) => n.textContent), /The agent is waiting for vm.*Asked in Check room · just now/, "where and when");
      await shown.click("#tab .card.need [data-need]");
      assert.equal(await visible("#tab .card.need"), false, "hidden at once");
      assert.equal(await shown.$eval("#toast", (n) => n.textContent), "Dropped the request for vmUndo");
      await sleep(7000);
      assert.equal(await visible("#toast .undo"), true, "Undo is still there after 7 s");
      await shown.click("#toast .undo");
      assert.equal(await visible("#tab .card.need"), true, "Undo brings it back");
      assert.deepEqual(await shown.$eval("#toast", (n) => [n.textContent, n.hidden, n.getAttribute("role")]), ["", false, "status"], "emptied, its live region still in the page");
      await shown.click("#tab .card.need [data-need]");
      await shown.click("#toast .shut");
      assert.match(await toldIn({ action: "library" }), /^The user said the machine "vm" isn't needed \(on the Library page\)/, "Close sent it, and the chat is told");
      await shown.waitForFunction(() => !document.querySelector("#tab .card.need"), { timeout: 10_000 });

      // The Vault's: sent as the page is left.
      await call({ action: "secret", site: "api.github.com", label: "github" });
      await shown.goto(`${at}/vault-lean/${vaultToken}.html`, { waitUntil: "load" });
      await shown.waitForSelector("#apikeys .card.need [data-need]", { timeout: 10_000 });
      assert.match(await shown.$eval("#apikeys .card.need", (n) => n.textContent), /The agent asks for a key for api\.github\.com.*Asked in Check room · just now/);
      await shown.click("#apikeys .card.need [data-need]");
      assert.equal(await visible("#toast .undo"), true);
      await shown.goto("about:blank");
      // Applied by the Vault's watch (asked again first, it would be a new request the drop misses).
      const keyNeeds = () => JSON.parse(fs.readFileSync(`${APP}/public/vault-lean/${vaultToken}-keys.json`, "utf8")).needs;
      for (let i = 0; i < 40 && keyNeeds().length; i++) await sleep(250);
      assert.deepEqual(keyNeeds(), [], "leaving the page sent it");
      assert.match(await call({ action: "secret", site: "api.github.com", label: "github" }), /^The user said the key "github" for api\.github\.com isn't needed \(on the Vault\)[^]*So the key "github" wasn't asked for again\./, "and the chat is told");

      // ---- The house-style audit of 2026-11-01, at 390 px: a long key site and a long address shown
      // in full, at 100% and 200% text, the row's buttons under them; a refusal is a banner that stays
      // until it's closed; a field left empty says so under itself, and has the focus.
      const LONG_SITE = "api.openweathermap.org.e2e-a-rather-long-site-name.example";
      const LONG_ADDRESS = "http://10.123.234.201:65000";
      const vaultPost = (section, event) => fs.writeFileSync(path.join(events, `raw-vault-lean-${section}-${crypto.randomUUID()}.json`), JSON.stringify({ pageContent: JSON.stringify({ vault_lean_event: 1, secret, ...event }) }));
      vaultPost("keys", { ev: "key-save", label: "openweather", site: LONG_SITE, sealed: crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from("ow-e2e-key")).toString("base64") });
      vaultPost("addresses", { ev: "address-allow", origin: LONG_ADDRESS });
      await call({ action: "library" });
      const section = (name) => JSON.parse(fs.readFileSync(`${APP}/public/vault-lean/${vaultToken}-${name}.json`, "utf8"));
      for (let i = 0; i < 40 && !section("addresses").origins.some((o) => o.origin === LONG_ADDRESS); i++) await sleep(250);
      assert.ok(section("keys").secrets.some((k) => k.site === LONG_SITE), "the key with a long site is saved");
      assert.ok(section("addresses").origins.some((o) => o.origin === LONG_ADDRESS), "the address is let through");
      await shown.goto(`${at}/vault-lean/${vaultToken}.html`, { waitUntil: "load" });
      await shown.waitForFunction((site) => [...document.querySelectorAll("#apikeys .row small")].some((n) => n.textContent.includes(site)), { timeout: 10_000 }, LONG_SITE);
      /** How the value holding `text` (under `selector`) is shown: whole, not cut, inside the page, its row's buttons under it. */
      const shownWhole = (selector, text) => shown.evaluate((selector, text) => {
        const n = [...document.querySelectorAll(selector)].find((x) => x.textContent.includes(text));
        const s = getComputedStyle(n), r = n.getBoundingClientRect(), ends = n.closest(".row").querySelector(".ends").getBoundingClientRect();
        return { text: n.textContent, ellipsis: s.textOverflow === "ellipsis", nowrap: s.whiteSpace === "nowrap", cut: n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1, inside: r.left >= 0 && r.right <= innerWidth + 0.5, under: ends.top >= r.bottom - 1, title: n.hasAttribute("title") };
      }, selector, text);
      const whole = (text) => ({ text, ellipsis: false, nowrap: false, cut: false, inside: true, under: true, title: false });
      const big = (on) => shown.evaluate((on) => (document.documentElement.style.fontSize = on ? "200%" : ""), on);
      for (const on of [false, true]) {
        await big(on);
        assert.deepEqual(await shownWhole("#apikeys .row small", LONG_SITE), whole(LONG_SITE), `the key's site in full${on ? " at 200% text" : ""}`);
      }
      await big(false);
      await shown.click('nav button[data-tab="addresses"]');
      await shown.waitForSelector("#addresses .addr", { timeout: 10_000 });
      for (const on of [false, true]) {
        await big(on);
        assert.deepEqual(await shownWhole("#addresses .addr .who b", LONG_ADDRESS), whole(LONG_ADDRESS), `the address in full${on ? " at 200% text" : ""}`);
      }
      await big(false);
      // A loopback address is refused by the skill: the refusal is a banner, near the top, still there after 10 s.
      const originIn = "#addresses form input";
      await shown.type(originIn, "http://localhost:8080");
      await shown.click('#addresses form button[type="submit"]');
      await shown.waitForSelector("#banners > div", { timeout: 15_000 });
      const said = () => shown.$$eval("#banners > div", (bs) => bs.map((b) => [b.getAttribute("role"), b.textContent]));
      assert.deepEqual(await said(), [["alert", "http://localhost:8080 is AnythingLLM’s own machine. Use a name or address on your network."]]);
      assert.ok(await shown.$eval("#banners", (b) => b.getBoundingClientRect().top < 120), "near the top");
      await sleep(10_000);
      assert.equal((await said()).length, 1, "still there after 10 s");
      await shown.click("#banners .shut");
      assert.deepEqual(await said(), [], "Close takes it away");
      // Add a key sent empty: each field says what it needs under it, and the first has the focus.
      await shown.click('nav button[data-tab="keys"]');
      await shown.click("#apikeys button.add");
      await shown.click('#apikeys button.add + form button[type="submit"]');
      const marked = await shown.$$eval(keysForm, (inputs) => inputs.map((i) => [i.getAttribute("aria-invalid"), document.getElementById(i.getAttribute("aria-describedby")).textContent, i === document.activeElement]));
      assert.deepEqual(marked, [["true", "Give the key a name, like github.", true], ["true", "Give the site it’s for, like api.github.com.", false], ["true", "Paste the key.", false]], "under each field, the first focused");
      assert.equal(await shown.$eval("#toast", (n) => n.textContent), "", "no toast for it");
      await shown.click("#apikeys button.add"); // Cancel
      assert.deepEqual(errors, [], "no error on the pages");
    } finally {
      await viewer.close();
    }
  }

  if (process.env.E2E_SSH_PORT) {
    // Machines (targets) are added on the Library page (the keys are given on the Vault), which has a
    // token, a secret and a key of its own.
    const lib = JSON.parse(fs.readFileSync(`${APP}/public/library-lean/${JSON.parse(fs.readFileSync(`${storage}/library-lean/page.json`, "utf8")).token}.html`, "utf8").match(/const cfg = (\{.*?\});/)[1]);
    const libPub = crypto.createPublicKey({ key: Buffer.from(lib.pub, "base64"), format: "der", type: "spki" });
    // A private key is longer than RSA-OAEP seals: the page seals it with AES-GCM under a sealed key.
    const aes = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const gcm = crypto.createCipheriv("aes-256-gcm", aes, iv);
    const box = Buffer.concat([gcm.update(process.env.E2E_SSH_KEY), gcm.final(), gcm.getAuthTag()]);
    const sealedKey = ["h1", crypto.publicEncrypt({ key: libPub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aes).toString("base64"), iv.toString("base64"), box.toString("base64")].join(".");
    // As the page posts it: the address with its port, the line ssh-keygen printed, the key sealed.
    const pagePost = (event) => fs.writeFileSync(path.join(events, `raw-${lib.title}-${crypto.randomUUID()}.json`), JSON.stringify({ pageContent: JSON.stringify({ library_lean_event: 1, secret: lib.secret, ev: "target-save", ...event }) }));
    pagePost({ label: "box", host: `127.0.0.1:${process.env.E2E_SSH_PORT}`, login: "sandbox", fingerprint: `256 ${process.env.E2E_SSH_FINGERPRINT} root@sshd (ED25519)`, public: "", sealed: sealedKey });
    await call({ action: "library" });
    const pageState = () => JSON.parse(fs.readFileSync(`${APP}/public/library-lean/${lib.token}.json`, "utf8"));
    const status = (label = "box") => pageState().targets.find((t) => t.label === label)?.status;
    for (let i = 0; i < 200 && [undefined, "not tried yet"].includes(status()); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(status(), "signed in", "the pasted key signs in, the host key matching its fingerprint");
    const run = { name: "run", description: "Runs a command.", inputs: { req: { type: "object", required: true } }, source: "async function main(i, kit) { return kit.ssh.exec(Object.assign({ target: 'box' }, i.req)); }" };
    await call({ action: "save", service: "ops", toolkit: { title: "Ops", targets: ["box"] }, function: run });
    const ran = async (name, inputs) => JSON.parse((await call({ action: "run", name, inputs })).match(/Result \(JSON\):\n([\s\S]*?)\n\n/)[1]);
    const result = (req) => ran("ops.run", { req });
    const hi = await result({ command: "echo hi; id -un; echo oops >&2; exit 4" });
    assert.deepEqual([hi.exit, hi.stdout, hi.stderr], [4, "hi\nsandbox\n", "oops\n"]);
    const slept = await result({ command: "sleep 30", timeout_s: 2 });
    assert.deepEqual([slept.killed, slept.signal, slept.remote_may_run], ["timeout", "SIGTERM", false], `OpenSSH acts on TERM and says so: ${JSON.stringify(slept)}`);
    assert.equal((await result({ command: "pgrep -x sleep || echo none" })).stdout, "none\n", "the command is gone from the machine");

    // Files over OpenSSH's SFTP: a script put with its mode, run, and what it wrote got back, its
    // sha256 the machine's own; put again over it in one step (posix-rename).
    const file = { name: "file", description: "Moves a file.", inputs: { call: { type: "string", required: true }, req: { type: "object", required: true } }, source: "async function main(i, kit) { return kit.ssh[i.call](Object.assign({ target: 'box' }, i.req)); }" };
    await call({ action: "save", service: "ops", function: file });
    const moved = (callName, req) => ran("ops.file", { call: callName, req });
    await moved("put", { path: "~/squares.sh", content: "#!/bin/sh\nfor n in 1 2 3; do echo \"$n,$((n * n))\"; done > squares.csv\n", mode: "755" });
    assert.equal((await result({ command: "./squares.sh && ls -l squares.sh | cut -c1-10" })).stdout, "-rwxr-xr-x\n");
    const csv = await moved("get", { path: "squares.csv" });
    assert.deepEqual([csv.content, csv.encoding, csv.eof], ["1,1\n2,4\n3,9\n", "utf8", true]);
    assert.equal((await result({ command: "sha256sum squares.csv | cut -d' ' -f1" })).stdout, `${csv.sha256}\n`, "the same file, by the machine's own hash");
    await moved("put", { path: "squares.csv", content: "replaced\n" });
    assert.equal((await result({ command: "cat squares.csv; ls -a | grep -c part- || true" })).stdout, "replaced\n0\n", "moved over it, no part file left");

    // The page's setup command, as the page builds it, run twice on the machine as the account: the
    // page's key added once, the permissions sshd wants, and the host key's line printed. A machine
    // added from that line signs in with the page's key, though the line carries restrict.
    const html = fs.readFileSync(`${APP}/public/library-lean/${lib.token}.html`, "utf8");
    const setupCommand = new Function(`${html.slice(html.indexOf("const NAME = "), html.indexOf("  /** A machine's address"))}; return setupCommand;`)();
    const spare = pageState().spare;
    const command = setupCommand(spare, "box2");
    const setUp = await result({ command });
    assert.equal(setUp.exit, 0, `the command ran: ${setUp.stderr}`);
    assert.equal((await result({ command })).stdout, setUp.stdout, "run again, it prints the same line");
    assert.equal((await result({ command: `grep -c ${spare.split(" ")[1]} ~/.ssh/authorized_keys; stat -c %a ~/.ssh ~/.ssh/authorized_keys` })).stdout, "1\n700\n600\n", "the key is in once, and the permissions are sshd's");
    assert.ok(setUp.stdout.includes(process.env.E2E_SSH_FINGERPRINT), `it printed the host key's fingerprint: ${setUp.stdout}`);
    pagePost({ label: "box2", host: `127.0.0.1:${process.env.E2E_SSH_PORT}`, login: "sandbox", fingerprint: setUp.stdout.trim(), public: spare, sealed: "" });
    await call({ action: "library" });
    for (let i = 0; i < 200 && [undefined, "not tried yet"].includes(status("box2")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(status("box2"), "signed in", "the machine added with the page's command signs in with the page's key");
    assert.notEqual(pageState().spare, spare, "the next machine gets a key of its own");

    // The owner's exception (this-host --allow), against the real sshd and without the seam: at
    // 127.0.0.1 it is this machine, used only while the record allows that login at that port.
    const EXCEPT = Symbol.for("anywherellm-suite.thishost.except");
    const record = globalThis[Symbol.for("anywherellm-suite.thishost.record")];
    const sshPort = Number(process.env.E2E_SSH_PORT);
    const standIn = globalThis[EXCEPT];
    globalThis[EXCEPT] = new Set();
    const runText = () => call({ action: "run", name: "ops.run", inputs: { req: { command: "id -un" } } });
    assert.match(await runText(), /an address of this machine itself/, "this machine, not allowed");
    record.allow = [{ login: "sandbox", port: sshPort }];
    assert.equal((await result({ command: "id -un" })).stdout, "sandbox\n", "allowed at that login and port");
    record.allow = [{ login: "sandbox", port: sshPort + 1 }, { login: "root", port: sshPort }];
    assert.match(await runText(), /an address of this machine itself/, "another port or login allows nothing");
    delete record.allow;
    globalThis[EXCEPT] = standIn;
  }

  server.close();
  console.log("ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
