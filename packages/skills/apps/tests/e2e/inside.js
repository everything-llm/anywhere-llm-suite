// Run inside a started stock AnythingLLM container, by hand (see the skill's notes): loads the skill
// through AnythingLLM's own loader (ImportedPlugin), sets it up on a stand-in agent as AnythingLLM's
// agent would, and drives it against the real server: a page published into AnythingLLM's public
// folder and served by AnythingLLM itself, with its state file; a tap posted to the real
// browser-extension upload, written by the real collector and applied by the skill's folder watch
// with no call; an event without the app's secret refused; Comment in the collector's real Chrome,
// absent without AnywhereLLM's channel and handing its comment to a stand-in one; the page check, which reads a page's scripts and runs none; a
// delete that leaves its page saying so; the apps manager in the same Chrome, each artifact a picture of its
// page in a sandboxed frame that reads nothing. Prints "ok" or throws.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { HUB_ID, STORAGE_DIR } = process.env;
const APP = "/app/server";
const SERVER = `http://127.0.0.1:${process.env.INNER_PORT || 3001}`;
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** The link a card gives to the page of the app titled `title`, with the address as group 1 (and,
 *  titled with the app's icon, its name as group 2). */
const linkTo = (title) => new RegExp(String.raw`\*\*\[${title}\]\((${escaped(SERVER)}/${HUB_ID}/[A-Za-z0-9_-]+\.html)(?: "([a-z]+)")?\)`);
const ImportedPlugin = require(`${APP}/utils/agents/imported.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  assert.ok(ImportedPlugin.validateImportedPluginHandler(HUB_ID), "the handler is where AnythingLLM looks");
  const active = JSON.stringify(ImportedPlugin.activeImportedPlugins());
  assert.ok(active.includes(HUB_ID), `AnythingLLM lists the skill as active: ${active}`);

  const plugin = ImportedPlugin.loadPluginByHubId(HUB_ID).plugin({ ANYTHINGLLM_URL: SERVER });
  const call = async (slug, args) => {
    let fn;
    const agent = {
      handlerProps: { invocation: { workspace: { slug } }, log: () => {} },
      introspect: () => {},
      function: (def) => (fn = def),
      socket: { send: () => {} },
    };
    plugin.setup(agent);
    assert.equal(fn.name, HUB_ID);
    return fn.handler.call(fn, args);
  };

  // A starter: the app and its page in one call, the page published as it is made.
  const made = await call("home", { action: "create", name: "groceries", title: "Groceries", starter: "checklist" });
  const link = made.match(linkTo("Groceries"));
  assert.ok(link, `create gave a link: ${made.split("\n").slice(0, 3).join(" / ")}`);
  const url = link[1];
  assert.equal(link[2], "check", "the card's link is titled with the starter's icon, for AnywhereLLM Lite");
  const stateUrl = url.replace(/\.html$/, ".json");
  const page = await fetch(url);
  assert.equal(page.status, 200, "AnythingLLM serves the page");
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const cfg = JSON.parse((await page.text()).match(/<script id="apps-lean" type="application\/json">(.*?)<\/script>/)[1]);
  assert.ok(cfg.key.startsWith("brx-"), "the pages' key is the browser-extension key install was given");
  assert.ok(cfg.secret && !("base" in cfg), "the page has its app's secret, and no address of AnythingLLM's");
  const state = async () => (await fetch(stateUrl, { cache: "no-store" })).json();
  assert.deepEqual(Object.keys(await state()).sort(), ["data", "line", "refused", "seen", "version"]);

  assert.match(await call("home", { action: "do", name: "groceries", ev: "add", patch: [{ op: "add", path: "/items/-", value: { text: "Bread", done: false } }] }), /\n- ☐ Bread$/m);
  assert.match(await call("work", { action: "list" }), /^This workspace has no artifacts yet\./);

  // A tap, posted as the page posts it, twice (a page may send one again), and one claiming the app
  // without its secret; the watch the calls started applies them as the collector writes them.
  const post = (event) =>
    fetch(SERVER + "/api/browser-extension/upload-content", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      body: JSON.stringify({ textContent: JSON.stringify(event), metadata: { title: cfg.eventTitle, docSource: "apps-lean page" } }),
    });
  const tap = { apps_lean_event: 1, workspace: "home", app: "groceries", secret: cfg.secret, id: "tap-1", ev: "tick", fields: { text: "Bread" }, patch: [{ op: "test", path: "/items/0/text", value: "Bread" }, { op: "replace", path: "/items/0/done", value: true }] };
  for (let i = 0; i < 2; i++) assert.equal((await post(tap)).status, 200, "AnythingLLM takes the page's event");
  assert.equal((await post({ ...tap, secret: "not-its-own", id: "tap-2", ev: "untick", patch: [{ op: "replace", path: "/items/0/done", value: false }] })).status, 200);
  const until = Date.now() + 40_000; // the watch, or its 30 s poll where a folder watch sees nothing
  while (Date.now() < until && !(await state()).seen.includes("tap-1")) await sleep(200);
  const after = await state();
  assert.deepEqual(after.data.items.map((i) => [i.text, i.done]), [["Bread", true]], "the tap reached the app and its state file with no call");
  await sleep(1000);
  const listed = await call("home", { action: "list" });
  assert.match(listed, /Changes made on artifact pages and the artifacts manager since the last call[^\n]*\n- tick Bread on groceries\n\n/, listed);
  assert.match(listed, /0 of 1 left/, "the untick without the app's secret was refused");
  const saved = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, HUB_ID, "home", "groceries.json"), "utf8"));
  assert.equal(saved.history.filter((h) => h.by === "page").length, 1, "the tap sent twice applies once");

  // Comment, in a real Chrome (the collector's): none without AnywhereLLM's channel; with a stand-in,
  // the sheet opens writing first; Point at the page is optional, and a tap while pointing picks, never
  // presses; the picks and the words go to the channel, the sheet closes once AnywhereLLM says it went,
  // and a comment with no picks, or one AnywhereLLM didn't take, is said as the boards have it.
  const habits = await call("home", { action: "create", name: "reading", title: "Reading", starter: "tracker" });
  const readingUrl = habits.match(linkTo("Reading"))[1];
  const puppeteer = require("/app/collector/node_modules/puppeteer");
  const chrome = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const bare = await chrome.newPage();
    await bare.goto(readingUrl, { waitUntil: "load" });
    assert.equal(await bare.evaluate(() => [...document.querySelectorAll("div")].some((d) => d.shadowRoot)), false, "no Comment outside AnywhereLLM");
    const tab = await chrome.newPage();
    await tab.setViewport({ width: 390, height: 844 });
    // AnywhereLLM Lite's channel, an androidx WebMessageListener: postMessage, and its reply as a message event.
    await tab.evaluateOnNewDocument(() => {
      const channel = new EventTarget();
      channel.postMessage = (m) => (window.posted = [...(window.posted || []), m]);
      window.AnywhereLLMApps = channel;
    });
    await tab.goto(readingUrl, { waitUntil: "load" });
    const inTray = (sel) =>
      tab.evaluate((s) => {
        const el = [...document.querySelectorAll("div")].find((d) => d.shadowRoot)?.shadowRoot.querySelector(s);
        return el ? (el.click(), "ok") : "missing";
      }, sel);
    const sheet = () =>
      tab.evaluate(() => {
        const ui = [...document.querySelectorAll("div")].find((d) => d.shadowRoot).shadowRoot;
        const shown = (el) => !!el && el.getClientRects().length > 0;
        const area = ui.querySelector(".cp-area");
        return {
          open: shown(ui.querySelector(".t")), button: shown(ui.querySelector(".b")), label: ui.querySelector(".t").getAttribute("aria-label"),
          area: shown(area), focused: ui.activeElement?.className || "", rows: area.getAttribute("rows"), mode: shown(ui.querySelector(".cp-mode")) ? ui.querySelector(".cp-mode p").textContent : "",
          chips: [...ui.querySelectorAll(".cp-pick span")].map((c) => c.textContent), said: ui.querySelector(".cp-said").textContent, send: ui.querySelector(".cp-actions [data-a=send]").disabled,
          badges: [...ui.querySelectorAll(".m b")].map((b) => b.textContent), close: shown(ui.querySelector(".x")) && ui.querySelector(".x").getBoundingClientRect().width,
        };
      });
    const write = (text) => tab.evaluate((t) => {
      const area = [...document.querySelectorAll("div")].find((d) => d.shadowRoot).shadowRoot.querySelector(".cp-area");
      area.value = t;
      area.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }, text);
    const posted = async () => JSON.parse((await tab.evaluate(() => window.posted || [])).at(-1));
    const answer = (reply) => tab.evaluate((r) => window.AnywhereLLMApps.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(r) })), reply);
    assert.notEqual(await inTray('[data-a="start"]'), "missing", "the page has Comment");
    let now = await sheet();
    assert.deepEqual([now.open, now.button, now.label, now.area, now.focused, now.rows, now.send, now.close], [true, false, "Comment on Reading", true, "cp-area", "3", true, 48], "writing first: the field focused, Send off while it's empty, a 48 px Close");
    assert.equal(now.said, "It goes to the chat as your message, and the agent answers there.");
    await inTray('.cp-actions [data-a="point"]');
    now = await sheet();
    assert.deepEqual([now.mode, now.area, now.close], ["Tap up to 5 things on the page · 0 of 5", false, false], "Point lowers the sheet to the pick tray");
    const count = await tab.evaluate(() => App.data.count);
    await tab.click('[data-ref="more"]');
    await sleep(300);
    assert.equal(await tab.evaluate(() => App.data.count), count, "the tap picked the button and didn't press it");
    now = await sheet();
    assert.deepEqual([now.mode, now.badges], ["Tap up to 5 things on the page · 1 of 5", ["1"]], "the pick numbered on the page");
    await inTray('[data-a="done"]');
    now = await sheet();
    assert.deepEqual([now.area, now.chips.length], [true, 1], "Done brings the sheet back, the pick a chip");
    assert.match(now.chips[0], /^1 · counter/);
    await write("Make the plus bigger");
    await inTray('.cp-actions [data-a="send"]');
    const { comment } = await posted();
    assert.deepEqual(Object.keys(comment), ["workspace", "message"], "no thread: the app's chat is the one AnywhereLLM has open");
    assert.equal(comment.workspace, "home");
    assert.match(comment.message, /^Comment on my Reading app's page \(apps-lean app `reading`\), about what I picked there:\n1\. `button[^\n]*part `counter`, data-ref `more`[^\n]*\n\nMake the plus bigger$/);
    await answer({ ok: true, chat: "Main" });
    await sleep(100);
    now = await sheet();
    assert.deepEqual([now.open, now.button, now.badges], [false, true, []], "sent: the sheet closes");
    await tab.click('[data-ref="more"]');
    await sleep(300);
    assert.equal(await tab.evaluate(() => App.data.count), count + 1, "once sent, taps press again");
    // No picks: a comment all the same. One AnywhereLLM didn't take keeps its words and says why.
    await inTray('[data-a="start"]');
    await write("Is this the right goal?");
    await inTray('.cp-actions [data-a="send"]');
    assert.equal((await posted()).comment.message, "Comment on my Reading app's page (apps-lean app `reading`):\n\nIs this the right goal?");
    await answer({ ok: false, error: "AnywhereLLM didn’t answer. Try again in a moment." });
    await sleep(100);
    now = await sheet();
    assert.deepEqual([now.open, now.said], [true, "Not sent: AnywhereLLM didn’t answer. Try again in a moment."]);
    assert.equal(await tab.evaluate(() => [...document.querySelectorAll("div")].find((d) => d.shadowRoot).shadowRoot.querySelector(".cp-area").value), "Is this the right goal?");
    await inTray('[data-a="close"]');
    assert.deepEqual([(await sheet()).open, (await sheet()).button], [false, true], "Close closes it");

    // The apps manager at a phone's width: each artifact a picture of its page, its HTML the document
    // of a frame that has an origin of its own and asks AnythingLLM for nothing.
    const links = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, "anywherellm-suite", "page-links.json"), "utf8"));
    const manager = await chrome.newPage();
    await manager.setViewport({ width: 390, height: 844 });
    const framed = [];
    // A data: URL (the House UI block's display font) is the page's own bytes, asked of no one.
    manager.on("request", (r) => r.frame() && r.frame() !== manager.mainFrame() && !r.url().startsWith("data:") && framed.push(r.url()));
    await manager.goto(SERVER + links.apps, { waitUntil: "load" });
    await manager.waitForFunction(() => document.querySelectorAll(".pic.drawn").length === 2, { timeout: 20_000 });
    const shown = await manager.evaluate(() => [...document.querySelectorAll(".ws")].map((s) => [s.querySelector("h2").textContent, [...s.querySelectorAll(".label")].map((l) => l.textContent)]));
    assert.deepEqual(shown, [["home", ["Reading", "Groceries"]]], "grouped by workspace, newest first");
    const frames = await manager.evaluate(() => [...document.querySelectorAll(".pic iframe")].map((f) => [f.getAttribute("sandbox"), f.contentDocument === null, f.srcdoc.includes('id="apps-lean"')]));
    assert.deepEqual(frames, [["allow-scripts", true, true], ["allow-scripts", true, true]], "sandboxed, in an origin of their own, each its page");
    const read = [];
    manager.on("request", (r) => r.frame() === manager.mainFrame() && /\.html\b/.test(r.url()) && read.push(r.url()));
    await manager.evaluate(() => (window.kept = [...document.querySelectorAll(".pic iframe")]));
    await sleep(5000);
    assert.deepEqual(framed, [], "a picture asks AnythingLLM for nothing");
    // A theme switched while it's open: the same frames, given the HTML read already in that theme.
    await manager.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await manager.waitForFunction(() => [...document.querySelectorAll(".pic iframe")].every((f) => f.srcdoc.includes('data-picture data-theme="dark"')), { timeout: 5_000 });
    assert.ok(await manager.evaluate(() => [...document.querySelectorAll(".pic iframe")].every((f, i) => f === window.kept[i])), "the frames kept");
    assert.deepEqual(read, [], "no page read again");
  } finally {
    await chrome.close();
  }
  // The press on "more" posted an event; wait for it to land and for a call to hand over its note, so no later reply leads with it.
  const readingFile = path.join(STORAGE_DIR, HUB_ID, "home", "reading.json");
  const landed = Date.now() + 40_000;
  while (Date.now() < landed && !JSON.parse(fs.readFileSync(readingFile, "utf8")).history.some((h) => h.by === "page")) await sleep(200);
  let news = "";
  while (Date.now() < landed && !news.includes("on reading")) news = await call("home", { action: "list" });
  assert.match(news, /Changes made on artifact pages and the artifacts manager since the last call[^\n]*\n- [^\n]* on reading/, news);

  // The page check, reading the bundled parser on this Node.
  const refused = await call("home", { action: "edit", name: "groceries", file: "page.html", find: "<!--scripts-->", text: "<script>App.onchange(draw);</script>\n<!--scripts-->" });
  assert.match(refused, /page\.html uses draw, which no script declares/);

  assert.match(await call("home", { action: "delete", name: "groceries" }), /^Deleted the artifact groceries, its changes and its page\./);
  assert.deepEqual(await state(), { gone: true }, "a page still open is told");
  assert.ok(!fs.existsSync(path.join(APP, "public", HUB_ID, url.split("/").pop())), "the page is gone");
  assert.match(await call("home", { action: "guide" }), /^# Artifacts/);
  console.log("ok");
  process.exit(0);
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
