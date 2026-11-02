// Run inside a stock AnythingLLM container (by hand: see docs/notes/skills/browser): loads the skill
// through AnythingLLM's own loader (ImportedPlugin), sets it up on a stand-in agent as AnythingLLM's
// agent would, and drives the image's real Chrome, through the bundled Puppeteer, against a site this script
// serves on 127.0.0.1 and localhost (FENCE_ALLOW lets them through): open and read a page, act on it, sign in with
// the password given on the tab's page (sealed with the vault's key, posted as AnythingLLM's
// collector writes it), take the tab over and sign in by tapping and typing, make a passkey while
// holding the tab and sign in with it from another tab (the site checking its signature and count),
// open tabs of the user's own from a tab's page (their own cookies), and from a closed tab's page, in
// the image's Chrome (its frame kept, posted through AnythingLLM's upload), search and look at a stand-in
// search page, and stay signed in (the site's cookie, kept in the
// vault) after the browser closes and starts again.
// Prints "ok" or throws.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { HUB_ID } = process.env;
const APP = "/app/server";
const PORT = 18090;
const SITE = `http://127.0.0.1:${PORT}`;
/** The same server under another name, for a search result that isn't on the engine's own site. */
const DOCS = `http://localhost:${PORT}/docs`;
/** The passkey page, on localhost: a secure context, so WebAuthn works over http. */
const PASSKEYS = `http://localhost:${PORT}/pk`;

const ImportedPlugin = require(`${APP}/utils/agents/imported.js`);

const page = (title, body) => `<!doctype html><title>${title}</title><body>${body}</body>`;

// The passkey page: Add a passkey makes one and sends its public key here; Sign in with a passkey
// signs a challenge, which this server checks against that key and the count.
const passkeys = { keys: new Map(), challenges: new Set(), log: [] };
const PK_PAGE = page("Passkeys", `<button id="add" style="position:fixed;left:0;top:0;width:320px;height:80px">Add a passkey</button>
<button id="in" style="position:fixed;left:0;top:100px;width:320px;height:80px">Sign in with a passkey</button><p id="out" style="margin-top:200px">Not signed in</p>
<script>
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const say = (t) => (document.getElementById("out").textContent = t);
const to = (path, body) => fetch(path, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
document.getElementById("add").onclick = async () => {
  try {
    const c = await navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: "Passkeys", id: location.hostname }, user: { id: new TextEncoder().encode("u1"), name: "anna", displayName: "Anna" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required", userVerification: "required" } } });
    say(await to("/pk/registered", { id: c.id, pub: b64(c.response.getPublicKey()) }));
  } catch (e) { say("Passkey refused: " + e.name); }
};
document.getElementById("in").onclick = async () => {
  try {
    const challenge = await (await fetch("/pk/challenge")).text();
    const a = await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(atob(challenge.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)), rpId: location.hostname, userVerification: "required" } });
    say(await to("/pk/assert", { id: a.id, cd: b64(a.response.clientDataJSON), ad: b64(a.response.authenticatorData), sig: b64(a.response.signature) }));
  } catch (e) { say("Passkey refused: " + e.name); }
};
</script>`);

function passkeyRoute(url, body, res) {
  if (url.pathname === "/pk") return res.end(PK_PAGE);
  if (url.pathname === "/pk/challenge") {
    const challenge = crypto.randomBytes(32).toString("base64url");
    passkeys.challenges.add(challenge);
    return res.end(challenge);
  }
  const sent = JSON.parse(body || "{}");
  if (url.pathname === "/pk/registered") {
    passkeys.keys.set(sent.id, { pub: sent.pub, count: 0 });
    passkeys.log.push("registered");
    return res.end("Passkey added");
  }
  const known = passkeys.keys.get(sent.id);
  const cd = Buffer.from(sent.cd, "base64url");
  const ad = Buffer.from(sent.ad, "base64url");
  const client = JSON.parse(cd);
  const signed = Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]);
  const key = known && crypto.createPublicKey({ key: Buffer.from(known.pub, "base64url"), format: "der", type: "spki" });
  const count = ad.readUInt32BE(33);
  const ok = !!key && passkeys.challenges.delete(client.challenge) && ad.subarray(0, 32).equals(crypto.createHash("sha256").update("localhost").digest()) && crypto.verify("sha256", signed, key, Buffer.from(sent.sig, "base64url")) && count > known.count;
  if (ok) known.count = count;
  passkeys.log.push(ok ? "signed in" : "refused");
  res.end(ok ? `Signed in with a passkey, count ${count}` : "Refused");
}
/** The sign-in form, with `extra` fields before its button. */
const loginForm = (extra = "") => `<form method="post" action="/login"><label>User <input name="user"></label><label>Password <input id="p" name="pass" type="password"></label>${extra}<button>Sign in</button></form>`;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "text/html");
    const url = new URL(req.url, SITE);
    if (url.pathname === "/login" && req.method === "POST") {
      const form = new URLSearchParams(body);
      for (const [user, pass] of [["ada", "e2e-pass-123"], ["bea", "e2e-pass-456"]]) {
        if (form.get("user") !== user || form.get("pass") !== pass) continue;
        res.setHeader("Set-Cookie", `sid=${user}; Path=/; HttpOnly; Max-Age=3600`);
        return res.end(page("Home", `<p>Welcome, ${user}.</p>`));
      }
      return res.end(page("Sign in", "<p>Wrong password.</p>"));
    }
    if (url.pathname === "/me") {
      const sid = /(?:^|; )sid=(\w+)/.exec(req.headers.cookie || "");
      return res.end(page("Me", sid ? "<p>Signed in.</p>" : "<p>Not signed in.</p>"));
    }
    if (url.pathname === "/who") return res.end(page(/(?:^|; )sid=\w+/.test(req.headers.cookie || "") ? "Signed in" : "Not signed in", "<p>Who</p>"));
    if (url.pathname === "/login") return res.end(page("Sign in", loginForm()));
    if (url.pathname === "/shadow") return res.end(page("Sign in", `<sign-in></sign-in><script>customElements.define("sign-in", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(loginForm())}; } });</script>`));
    if (url.pathname === "/show") return res.end(page("Sign in", loginForm(`<label><input type="checkbox" onchange="p.type = this.checked ? 'text' : 'password'"> Show password</label>`)));
    if (url.pathname === "/captcha") return res.end(page("Sign in", loginForm('<label>Digits in the image <input name="digits" required></label>')));
    if (url.pathname === "/consent") return res.end(page("Sign in", `<main inert>${loginForm()}</main><div role="dialog" aria-modal="true" aria-label="Cookies on this site"><p>We use cookies.</p><button onclick="this.parentElement.remove(); document.querySelector('main').inert = false">Reject all</button><button>Accept all</button></div>`));
    if (url.pathname === "/dob") return res.end(page("Profile", '<form><label>Date of birth <input type="date" name="dob" required></label><button disabled>Next</button></form><script>const f = document.forms[0]; f.oninput = () => (f.querySelector("button").disabled = !f.checkValidity());</script>'));
    if (url.pathname === "/code" && req.method === "POST") {
      if (new URLSearchParams(body).get("code") === "123456") return res.end(page("Account", '<a href="/keys">Create API key</a>'));
      return res.end(page("Two-step", '<p>That code is wrong.</p><form method="post" action="/code"><label>Code <input name="code"></label><button>Verify</button></form>'));
    }
    if (url.pathname === "/code") return res.end(page("Two-step", '<p>Check your phone: we sent a code by text message.</p><form method="post" action="/code"><label>Code <input name="code"></label><button>Verify</button></form>'));
    if (url.pathname === "/signup" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const ok = form.get("pass") && form.get("pass") === form.get("confirm");
      return res.end(ok ? page("Welcome", `<p>Account made for ${form.get("user")}.</p>`) : page("Create account", "<p>The passwords don't match.</p>"));
    }
    if (url.pathname === "/signup") return res.end(page("Create account", '<form method="post" action="/signup"><label>Email <input name="user"></label><label>Password <input name="pass" type="password"></label><label>Confirm password <input name="confirm" type="password"></label><button>Next</button></form>'));
    if (url.pathname.startsWith("/pk")) return passkeyRoute(url, body, res);
    if (url.pathname === "/search") return res.end(page("Search", `<div><a href="${SITE}/go?u=${encodeURIComponent(DOCS)}">Docs for ${url.searchParams.get("q")}</a> The docs</div>`));
    if (url.pathname === "/docs") return res.end(page("Docs", "<h1>Docs</h1><p>The export button is under Settings.</p>"));
    res.statusCode = 404;
    res.end(page("Not found", ""));
  });
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  assert.ok(ImportedPlugin.validateImportedPluginHandler(HUB_ID), "the handler is where AnythingLLM looks");
  // SEARCH_URL as Settings › Agent Skills saves it, in the skill's plugin.json (which the skill reads
  // it from), and in the runtimeArgs AnythingLLM reads from there.
  const pluginJson = path.join(process.env.STORAGE_DIR || `${APP}/storage`, "plugins", "agent-skills", HUB_ID, "plugin.json");
  const config = JSON.parse(fs.readFileSync(pluginJson, "utf8"));
  config.setup_args.SEARCH_URL.value = `${SITE}/search?q={q}`;
  fs.writeFileSync(pluginJson, JSON.stringify(config, null, 2));
  const plugin = ImportedPlugin.loadPluginByHubId(HUB_ID).plugin({ SEARCH_URL: config.setup_args.SEARCH_URL.value });
  const call = async (args, thread = 7, workspace = "e2e") => {
    let fn;
    const agent = { handlerProps: { invocation: { workspace: { slug: workspace }, thread_id: thread }, log: (m) => console.error(m) }, introspect: () => {}, function: (def) => (fn = def) };
    plugin.setup(agent);
    assert.equal(fn.name, HUB_ID);
    return fn.handler.call(fn, args);
  };

  const opened = await call({ action: "open", url: `${SITE}/login` });
  assert.match(opened, /Page: Sign in/, opened);
  const ref = (label) => opened.match(new RegExp(`\\[(e\\d+)\\] ${label}`))[1];
  const [user, pass, submit] = [ref('input\\[text\\] "User'), ref('input\\[password\\] "Password'), ref('button "Sign in"')];
  assert.match(opened, /\[!\[Sign in\]\(\/browser-lean\/[\w-]+-card\.jpg\?v=\w+\)\]\(\/browser-lean\/[\w-]+\.html\)/, "the card");

  assert.match(await call({ action: "act", do: "fill", ref: pass, text: "nope" }), /password field, which act never types into/);
  assert.match(await call({ action: "login", user_ref: user, pass_ref: pass, submit_ref: submit }), /The user is asked on the tab's page/);

  // A thread's tab page: its settings, its state, and what it posts (written as AnythingLLM's
  // collector writes an upload), each applied by the next call.
  const storage = process.env.STORAGE_DIR || `${APP}/storage`;
  const tabPage = (thread) => {
    const { token } = JSON.parse(fs.readFileSync(`${storage}/browser-lean/e2e/tabs.json`, "utf8"))[String(thread)];
    const cfg = JSON.parse(fs.readFileSync(`${APP}/public/browser-lean/${token}.html`, "utf8").match(/const cfg = (\{.*?\});/)[1]);
    const state = () => JSON.parse(fs.readFileSync(`${APP}/public/browser-lean/${token}.json`, "utf8"));
    const seal = (text) => crypto.publicEncrypt({ key: crypto.createPublicKey({ key: Buffer.from(cfg.pub, "base64"), format: "der", type: "spki" }), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(text)).toString("base64");
    const events = `${storage}/documents/custom-documents`;
    const post = async (...steps) => {
      fs.mkdirSync(events, { recursive: true });
      for (const step of steps) {
        const event = { browser_lean_event: 1, workspace: "e2e", tab: String(thread), secret: cfg.secret, ...step };
        fs.writeFileSync(path.join(events, `raw-${cfg.title}-${crypto.randomUUID()}.json`), JSON.stringify({ pageContent: JSON.stringify(event) }));
        await new Promise((r) => setTimeout(r, 20)); // in order, as the page posts them
      }
      return call({ action: "read" }, thread);
    };
    return { token, state, seal, post };
  };
  // The Vault the tab pages link to, and its logins section: what it shows, and what it posts.
  const vaultPage = () => {
    const { token, secret } = JSON.parse(fs.readFileSync(`${storage}/vault-lean/vault-page.json`, "utf8"));
    const logins = () => JSON.parse(fs.readFileSync(`${APP}/public/vault-lean/${token}-logins.json`, "utf8")).logins;
    const post = (event) => {
      fs.mkdirSync(`${storage}/documents/custom-documents`, { recursive: true });
      fs.writeFileSync(path.join(`${storage}/documents/custom-documents`, `raw-vault-lean-logins-${crypto.randomUUID()}.json`), JSON.stringify({ pageContent: JSON.stringify({ vault_lean_event: 1, secret, ...event }) }));
    };
    return { token, logins, post };
  };
  const seven = tabPage(7);
  assert.equal(seven.state().need.kind, "login");
  const signedIn = await seven.post({ ev: "need-answer", user: "ada", sealed: seven.seal("e2e-pass-123"), save: true });
  assert.match(signedIn, /Page: Home/, signedIn);
  assert.match(signedIn, /Welcome, ada\./, "a username isn't a secret: only the password is hidden");
  assert.match(signedIn, /the login the user entered was saved for 127\.0\.0\.1, for next time/, "saved once the page no longer asks for a password");

  // ---- The user takes a tab over: taps the user field, types into it and the password, sealed,
  // then Enter; the page offers the login, they save it and hand the tab back.
  const eight = await call({ action: "open", url: `${SITE}/login` }, 8);
  const tab8 = tabPage(8);
  assert.match(await tab8.post({ ev: "take" }), /^The user has taken this tab over/);
  assert.match(await call({ action: "act", do: "click", ref: eight.match(/\[(e\d+)\] button "Sign in"/)[1] }, 8), /^Browser: the user has taken the tab over/);
  const fields = tab8.state().fields;
  const [userField, passField] = [fields.find((f) => f.kind === "text"), fields.find((f) => f.kind === "password")];
  assert.ok(userField && passField, `the fields in view: ${JSON.stringify(fields)}`);
  await tab8.post({ ev: "tap", x: userField.x + 5, y: userField.y + 5 }, { ev: "type", ref: userField.ref, text: "bea", then: "Tab" }, { ev: "type", ref: passField.ref, sealed: tab8.seal("e2e-pass-456"), then: "Enter" });
  const offered = tab8.state();
  assert.equal(offered.title, "Home", "Enter sent the form");
  assert.deepEqual(offered.offer, { kind: "password", site: "127.0.0.1", user: "bea" });
  await tab8.post({ ev: "offer", save: true });
  assert.ok(vaultPage().logins().some((l) => l.user === "bea"), "saved, and listed on the Vault");
  const handedBack = await tab8.post({ ev: "give" });
  assert.match(handedBack, /handed it back to you/);
  assert.match(handedBack, /Welcome, •••\./, "what the user typed is hidden from the agent");
  assert.equal(tab8.state().who, "agent");

  // ---- Passkeys: one the page makes while the agent has the tab is taken out again; one made
  // while the user holds it is offered and saved, and signs in from another tab, the site checking
  // its signature and count; deleted on the Vault, it signs in no more.
  const said = (reply) => reply.match(/Not signed in|Passkey added|Signed in with a passkey, count \d+|Passkey refused: \w+|Refused/)?.[0];
  const nine = await call({ action: "open", url: PASSKEYS }, 9);
  const add = nine.match(/\[(e\d+)\] button "Add a passkey"/)[1];
  const byAgent = (await call({ action: "act", do: "click", ref: add }, 9)) + (await call({ action: "read" }, 9));
  assert.match(byAgent, /made a passkey for localhost while you had the tab, and it was taken out again/, byAgent);
  const tab9 = tabPage(9);
  await tab9.post({ ev: "take" }, { ev: "tap", x: 20, y: 20 });
  for (let i = 0; !tab9.state().offer && i < 20; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(tab9.state().offer, { kind: "passkey", site: "localhost", user: "" });
  await tab9.post({ ev: "offer", save: true }, { ev: "give" });
  assert.ok(vaultPage().logins().some((l) => l.kind === "passkey" && l.site === "localhost"));

  const ten = await call({ action: "open", url: PASSKEYS }, 10);
  const signIn = ten.match(/\[(e\d+)\] button "Sign in with a passkey"/)[1];
  const read10 = async () => (await call({ action: "act", do: "click", ref: signIn }, 10)) + (await new Promise((r) => setTimeout(r, 300)), await call({ action: "read" }, 10));
  const first = await read10();
  assert.match(first, /Signed in with a passkey, count \d+/, first);
  assert.match(first, /the page signed in with the passkey saved for localhost/);
  assert.match(await read10(), /Signed in with a passkey, count \d+/, "the count went forward, so the site takes it again");
  const before = vaultPage();
  assert.equal(new URL(`http://x${tabPage(10).state().vault}`).pathname, `/vault-lean/${before.token}.html`, "the tab's page links to the Vault");
  // With the links kept from the agent (the switch file the owner makes on the host), the state has none.
  const hidden = `${storage}/anywherellm-suite/page-links-hidden`;
  fs.mkdirSync(path.dirname(hidden), { recursive: true });
  fs.writeFileSync(hidden, "e2e\n");
  try {
    await call({ action: "read" }, 10);
    assert.equal(tabPage(10).state().vault, null, "no Vault link in the tab's state while the links are kept from the agent");
  } finally {
    fs.rmSync(hidden, { force: true });
  }
  await call({ action: "read" }, 10);
  // Turning the links off the agent replaced the Vault's token once (the read above was the first page
  // call after the switch went on); the link given again now is the new one, and the old page is gone.
  const vault = vaultPage();
  assert.notEqual(vault.token, before.token, "the Vault was replaced once when the switch went on");
  assert.ok(!fs.existsSync(`${APP}/public/vault-lean/${before.token}.html`), "the old Vault page is gone");
  assert.equal(new URL(`http://x${tabPage(10).state().vault}`).pathname, `/vault-lean/${vault.token}.html`, "given again once the switch is off");
  vault.post({ ev: "login-delete", id: vault.logins().find((l) => l.kind === "passkey").id });
  assert.match(await read10(), /Passkey refused: NotAllowedError/, "deleted on the Vault, it signs in no more");
  assert.deepEqual(passkeys.log, ["registered", "registered", "signed in", "signed in"]);

  // ---- The Vault itself, in a real Chrome (the collector's) at a phone's width: the tab's link opens
  // it on its Logins tab (another tab when the link names it), and a Delete asks first in a sheet over
  // the inert page, which Esc closes, giving the focus back to the Delete.
  const puppeteer = require("/app/collector/node_modules/puppeteer");
  const viewer = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const vaultAt = `http://127.0.0.1:${process.env.INNER_PORT || 3001}${tabPage(10).state().vault}`;
    assert.match(vaultAt, /\.html#logins$/);
    const open = async (url) => {
      const shown = await viewer.newPage();
      await shown.setViewport({ width: 390, height: 844 });
      const errors = [];
      shown.on("pageerror", (e) => errors.push(e.message));
      await shown.goto(url, { waitUntil: "load" });
      await shown.waitForFunction(() => document.querySelector("#logins .row") && [...document.querySelectorAll("nav button")].some((b) => b.getAttribute("aria-selected") === "true"), { timeout: 10_000 });
      const tabs = await shown.evaluate(() => [...document.querySelectorAll("nav button")].filter((b) => !b.hidden).map((b) => `${b.textContent}${b.getAttribute("aria-selected") === "true" ? " (shown)" : ""}`));
      return { shown, errors, tabs };
    };
    assert.deepEqual((await open(vaultAt.replace(/#logins$/, "#addresses"))).tabs, ["Logins", "Addresses (shown)"], "the tab the link names");
    const { shown, errors, tabs } = await open(vaultAt);
    assert.deepEqual(tabs, ["Logins (shown)", "Addresses"], "the tab's link opens it on Logins");
    await shown.click("#logins .hu-button--danger");
    const asked = await shown.evaluate(() => [document.querySelector(".sheet h2")?.textContent, document.querySelector("main").inert, document.activeElement.textContent]);
    assert.match(asked[0] ?? "", /^Delete this (login|passkey)\?$/, "asked first");
    assert.deepEqual(asked.slice(1), [true, "Keep"], "over the inert page, Keep focused");
    await shown.keyboard.press("Escape");
    const closed = await shown.evaluate(() => [!!document.querySelector(".sheet"), document.querySelector("main").inert, document.activeElement.matches("#logins .hu-button--danger")]);
    assert.deepEqual(closed, [false, false, true], "Esc closes it and gives the focus back");
    assert.deepEqual(errors, [], "no error on the page");
  } finally {
    await viewer.close();
  }

  // ---- Fields in a shadow root, "Show password", a form that needs more than the login, and a new
  // account's "Confirm password".
  const refIn = (text, label) => text.match(new RegExp(`\\[(e\\d+)\\] ${label}`))[1];
  const shadow = await call({ action: "open", url: `${SITE}/shadow` }, 11);
  const inShadow = await call({ action: "login", user_ref: refIn(shadow, 'input\\[text\\] "User'), pass_ref: refIn(shadow, 'input\\[password\\]'), submit_ref: refIn(shadow, 'button "Sign in"') }, 11);
  assert.match(inShadow, /Page: Home/, `a saved login typed into a shadow root's fields: ${inShadow}`);

  const show = await call({ action: "open", url: `${SITE}/show` }, 12);
  const shownPass = refIn(show, 'input\\[password\\]');
  await call({ action: "act", do: "check", ref: refIn(show, 'input\\[checkbox\\]') }, 12);
  const shown = await call({ action: "read" }, 12);
  assert.match(shown, new RegExp(`\\[${shownPass}\\] input\\[password\\]`), "still read as a password field once shown");
  assert.match(await call({ action: "act", do: "fill", ref: shownPass, text: "e2e-pass-123" }, 12), /password field, which act never types into/);

  const captcha = await call({ action: "open", url: `${SITE}/captcha` }, 13);
  const unsent = await call({ action: "login", user_ref: refIn(captcha, 'input\\[text\\] "User'), pass_ref: refIn(captcha, 'input\\[password\\]'), submit_ref: refIn(captcha, 'button "Sign in"') }, 13);
  assert.match(unsent, /, but e\d+ wasn't clicked: the page still needs e\d+ "Digits in the image" first/, unsent);
  assert.match(unsent, /Page: Sign in/, "not sent");

  const signup = await call({ action: "open", url: `${SITE}/signup` }, 14);
  assert.match(await call({ action: "login", user_ref: refIn(signup, 'input\\[text\\] "Email'), pass_ref: refIn(signup, 'input\\[password\\] "Password'), confirm_ref: refIn(signup, 'input\\[password\\] "Confirm'), submit_ref: refIn(signup, 'button "Next"') }, 14), /needs a password for the new account/);
  const tab14 = tabPage(14);
  assert.equal(tab14.state().need.confirm, true);
  assert.match(await tab14.post({ ev: "need-answer", user: "dana", sealed: tab14.seal("e2e-new-789"), save: true }), /Page: Welcome/, "the same password in both fields");

  // ---- A cookie dialog that makes the page behind it inert, a date field, and a code taken on a
  // new page whose first ref is something else.
  const consent = await call({ action: "open", url: `${SITE}/consent` }, 15);
  assert.match(consent, /Elements \(\d+\):\n\[e\d+\] button "Reject all"/, `the dialog's buttons first: ${consent}`);
  assert.match(consent, /input\[text\] "User" \(behind a dialog\)/);
  const login15 = { user_ref: refIn(consent, 'input\\[text\\] "User'), pass_ref: refIn(consent, "input\\[password\\]"), submit_ref: refIn(consent, 'button "Sign in"') };
  assert.match(await call({ action: "login", ...login15 }, 15), /is behind a dialog \("Cookies on this site"; its buttons: e\d+ "Reject all", e\d+ "Accept all"\)/);
  await call({ action: "act", do: "click", ref: refIn(consent, 'button "Reject all"') }, 15);
  assert.match(await call({ action: "login", ...login15 }, 15), /Page: Home/, "the saved login, once the dialog is closed");

  const dob = await call({ action: "open", url: `${SITE}/dob` }, 16);
  const dobRef = refIn(dob, 'input\\[date\\]');
  assert.match(await call({ action: "act", do: "fill", ref: dobRef, text: "05/01/1990" }, 16), /a date field takes its value as YYYY-MM-DD/);
  const dated = await call({ action: "act", do: "fill", ref: dobRef, text: "1990-05-01" }, 16);
  assert.match(dated, /input\[date\] "Date of birth" value="1990-05-01"/, dated);
  assert.match(dated, /button "Next"\n/, "the page saw it: Next is enabled");

  const code = await call({ action: "open", url: `${SITE}/code` }, 17);
  const codeRef = refIn(code, 'input\\[text\\] "Code');
  assert.match(await call({ action: "login", what: "code", ref: codeRef, submit_ref: refIn(code, 'button "Verify"') }, 17), /The code sent to your phone/);
  const tab17 = tabPage(17);
  const wrong = await tab17.post({ ev: "need-answer", text: "000000" });
  assert.match(wrong, /the page still asks for the code/, "the same field after a wrong code: asked again");
  const taken = await tab17.post({ ev: "need-answer", text: "123456" });
  assert.match(taken, /Page: Account/, taken);
  assert.doesNotMatch(taken, /still asks for the code/, `${codeRef} on the new page is a link, not the code field`);
  assert.equal(tab17.state().need, null);

  // ---- A tab of the user's own, opened from the chat's tab's page: in a browser context of its own,
  // so the chat's sign-in isn't there; a search through SEARCH_URL; an address the fence refuses opens
  // nothing; nothing of it reaches the agent's answers; closed from its page.
  assert.match(await call({ action: "open", url: `${SITE}/who` }), /Page: Signed in/, "the chat's tab is signed in");
  const read7 = await seven.post({ ev: "new", q: `${SITE}/who`, made: "e2e-own" });
  const own = seven.state().tabs.find((t) => t.made === "e2e-own");
  assert.ok(own && !own.agent, `the user's tab along the top: ${JSON.stringify(seven.state().tabs)}`);
  const ownTab = tabPage("you-1");
  assert.equal(ownTab.state().title, "Not signed in", "its own cookies: the chat's sign-in isn't there");
  assert.equal(ownTab.state().who, "user");
  assert.ok(!read7.includes(own.path.replace(".html", "")) && !read7.includes("you-1"), "the agent's answer carries nothing of it");
  await seven.post({ ev: "new", q: "export", made: "e2e-search" });
  const searched = seven.state().tabs.find((t) => t.made === "e2e-search");
  assert.equal(JSON.parse(fs.readFileSync(`${APP}/public/browser-lean/${searched.path.replace(".html", ".json")}`, "utf8")).title, "Search", "searched through SEARCH_URL");
  const fenced = await seven.post({ ev: "new", q: "http://10.1.2.3/", made: "e2e-fenced" });
  assert.ok(seven.state().msg, `said on the page: ${JSON.stringify({ ...seven.state(), fields: undefined })}\n${fenced.slice(0, 600)}`);
  assert.match(seven.state().msg.text, /^http:\/\/10\.1\.2\.3 isn’t let through\. Allow it in the Vault, under Addresses/);
  assert.ok(!seven.state().tabs.some((t) => t.made === "e2e-fenced"), "nothing opened");
  await ownTab.post({ ev: "close" });
  assert.ok(!seven.state().tabs.some((t) => t.made === "e2e-own"), "closed, and gone from the top of the chat's tab");

  // ---- The closed tab's page, in a real Chrome at a phone's width, keeps its frame: one bar at the
  // bottom (Back, off; the pill with the home's field and the You chip; the count; More), with a new
  // tab's home in the tab's place; the count opens the tabs as a sheet, and More has New tab and
  // Logins. A search there is posted through AnythingLLM's own upload, opens a tab of the user's own,
  // and the page goes to it.
  const shut = ownTab.state();
  assert.equal(shut.closed, true);
  assert.ok(shut.tabs.length > 1 && shut.tabs.some((t) => t.made === "e2e-search"), "the open tabs, in its state");
  const phone = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const shown = await phone.newPage();
    await shown.setViewport({ width: 390, height: 844 });
    const errors = [];
    shown.on("pageerror", (e) => errors.push(e.message));
    await shown.goto(`http://127.0.0.1:${process.env.INNER_PORT || 3001}/browser-lean/${ownTab.token}.html`, { waitUntil: "load" });
    await shown.waitForFunction(() => !document.getElementById("home").hidden, { timeout: 10_000 });
    const frame = await shown.evaluate(() => {
      const seen = (id) => { const n = document.getElementById(id); return !n.hidden && n.getBoundingClientRect().height > 0; };
      const bar = document.getElementById("bar").getBoundingClientRect();
      return {
        seen: ["home", "bar", "searchbar", "chipown", "count", "morebtn"].map(seen),
        gone: ["stage", "addrbtn", "thin", "chatbar", "chip"].map(seen),
        back: document.getElementById("navback").disabled,
        chip: document.getElementById("chipown").textContent,
        count: [document.getElementById("countn").textContent, document.getElementById("count").getAttribute("aria-label")],
        atFoot: Math.round(innerHeight - bar.bottom),
        placeholder: document.getElementById("q").placeholder,
        hero: document.querySelector("#hero h1").textContent,
        title: document.title,
      };
    });
    assert.deepEqual(frame.seen, [true, true, true, true, true, true], "the home, and the bar with the field, the You chip, the count and More");
    assert.deepEqual(frame.gone, [false, false, false, false, false], "no picture, address, thin line, chat bar or holder button: the tab is gone");
    assert.equal(frame.back, true, "Back is off");
    assert.equal(frame.chip, "You: your own tab");
    assert.deepEqual(frame.count, [String(shut.tabs.length + 1), `${shut.tabs.length + 1} tabs`], "the open tabs and this one");
    assert.equal(frame.atFoot, 0, "the bar at the bottom");
    assert.deepEqual([frame.placeholder, frame.hero, frame.title], ["Search", "Where to?", "New tab"]);
    await shown.click("#count");
    const sheet = await shown.evaluate(() => ({
      open: !document.getElementById("tabsheet").hidden,
      heads: [...document.querySelectorAll("#tabslists h3")].map((h) => h.textContent),
      rows: [...document.querySelectorAll("#tabslists .ts-row")].map((r) => [r.querySelector(".ts-title").textContent, !!r.querySelector(".ts-av i"), r.getAttribute("aria-current")]),
    }));
    assert.equal(sheet.open, true, "the count opens the tabs sheet");
    assert.deepEqual(sheet.heads, ["Chats’ tabs", "Your tabs"]);
    assert.equal(sheet.rows.length, shut.tabs.length, `each open tab: ${JSON.stringify(sheet.rows)}`);
    assert.ok(sheet.rows.every(([, , current]) => current === null), "none is this page's: its tab closed");
    await shown.keyboard.press("Escape");
    assert.equal(await shown.evaluate(() => document.getElementById("tabsheet").hidden), true, "Esc closes it");
    await shown.click("#morebtn");
    const more = await shown.evaluate(() => [...document.querySelectorAll("#more .item")].filter((b) => !b.hidden).map((b) => b.textContent.trim()));
    assert.deepEqual(more, ["Logins", "New tab"], "More on a home: Logins and New tab, and no Close");
    await shown.click("#morenew");
    assert.equal(await shown.evaluate(() => [document.getElementById("more").hidden, document.activeElement.id].join()), "true,q", "New tab: the home's field, ready to type in");
    await shown.type("#q", `${SITE}/docs`);
    assert.equal(await shown.evaluate(() => [...document.querySelectorAll("#bar > *")].filter((n) => n.getClientRects().length).map((n) => n.id).join()), "pill", "typing: the field widens across the bar");
    await shown.keyboard.press("Enter");
    // AnythingLLM's collector writes what the page posted; the watch here, or the next call, applies it.
    for (let i = 0; i < 40 && shown.url().includes(ownTab.token); i++) {
      await call({ action: "guide" });
      await new Promise((r) => setTimeout(r, 500));
    }
    const opened = ownTab.state().tabs.find((t) => t.made && !shut.tabs.some((was) => was.made === t.made));
    assert.ok(opened, `the new tab, in the closed page's tabs: ${JSON.stringify(ownTab.state().tabs.map((t) => t.made))}`);
    assert.ok(opened.mine, "one of the user's own");
    assert.ok(shown.url().endsWith(`/browser-lean/${opened.path}`), `the page went to it: ${shown.url()}`);
    await shown.waitForFunction(() => !document.getElementById("stage").hidden && document.getElementById("addr").textContent.includes("127.0.0.1"), { timeout: 10_000 });
    assert.equal(JSON.parse(fs.readFileSync(`${APP}/public/browser-lean/${opened.path.replace(".html", ".json")}`, "utf8")).title, "Docs", "the user's own tab, at the address typed");
    const ownBar = await shown.evaluate(() => [document.getElementById("chipown").textContent, document.getElementById("chip").hidden, document.getElementById("chatbar").hidden]);
    assert.deepEqual(ownBar, ["You: your own tab, which the agent never reaches", true, true], "the user's own tab: the You chip, which does nothing, and no chat bar");
    await shown.click("#morebtn");
    const onPage = await shown.evaluate(() => [...document.querySelectorAll("#more .item")].filter((b) => !b.hidden).map((b) => `${b.textContent.trim()}${b.disabled ? " (off)" : ""}`));
    assert.deepEqual(onPage, ["Forward (off)", "Reload", "Logins", "New tab", "Close this tab"], "More on a tab's page");
    await shown.keyboard.press("Escape");
    // The address pill opens a new tab's home, whose More has New tab and Logins.
    await shown.click("#addrbtn");
    await shown.waitForFunction(() => !document.getElementById("home").hidden, { timeout: 5_000 });
    await shown.click("#morebtn");
    const atHome = await shown.evaluate(() => [...document.querySelectorAll("#more .item")].filter((b) => !b.hidden).map((b) => b.textContent.trim()));
    assert.deepEqual(atHome, ["Logins", "New tab"], "More on an open tab's home: Logins and New tab, and no Close this tab");
    assert.deepEqual(errors, [], "no error on the page");
  } finally {
    await phone.close();
  }

  // ---- The chat bar on a chat's tab, inside AnywhereLLM (a stand-in for its channel, an
  // androidx WebMessageListener: postMessage, and replies as message events): its tab belongs to a
  // real AnythingLLM thread, named by its slug. Point picks the element the agent's read names by its
  // ref, without taking the tab over, and never a password field; Send posts the whole message for
  // that thread, and the reply's chat is named in "Sent to". Outside AnywhereLLM, no chat bar.
  {
    const { Workspace } = require(`${APP}/models/workspace.js`);
    const { WorkspaceThread } = require(`${APP}/models/workspaceThread.js`);
    const { workspace: ws } = await Workspace.new("Chat bar");
    const { thread } = await WorkspaceThread.new(ws, null, { name: "Export my statements", slug: "export-my-statements" });
    const read = await call({ action: "open", url: `${SITE}/login` }, thread.id, ws.slug);
    const signInRef = read.match(/\[(e\d+)\] button "Sign in"/)[1];
    const names = JSON.parse(fs.readFileSync(`${storage}/browser-lean/${ws.slug}/tabs.json`, "utf8"))[String(thread.id)];
    const stateOf = () => JSON.parse(fs.readFileSync(`${APP}/public/browser-lean/${names.token}.json`, "utf8"));
    assert.deepEqual([stateOf().thread, stateOf().chat], ["export-my-statements", "Export my statements"], "the tab's chat, from AnythingLLM's thread");
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const url = `http://127.0.0.1:${process.env.INNER_PORT || 3001}/browser-lean/${names.token}.html`;
      const bare = await browser.newPage();
      await bare.setViewport({ width: 390, height: 844 });
      await bare.goto(url, { waitUntil: "load" });
      await bare.waitForFunction(() => !document.getElementById("stage").hidden && document.getElementById("addr").textContent.length > 2, { timeout: 10_000 });
      assert.equal(await bare.evaluate(() => document.getElementById("chatbar").hidden), true, "no chat bar outside AnywhereLLM");
      assert.equal(await bare.evaluate(() => document.getElementById("chip").textContent), "Agent", "the holder chip, always there");

      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844 });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.evaluateOnNewDocument(() => {
        const channel = new EventTarget();
        channel.postMessage = (m) => (window.posted = [...(window.posted || []), m]);
        window.AnywhereLLMApps = channel;
      });
      await page.goto(url, { waitUntil: "load" });
      await page.waitForFunction(() => !document.getElementById("chatbar").hidden && document.getElementById("shot").complete && document.getElementById("shot").naturalWidth > 0, { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 2500)); // the page's size asked for, and the tab drawn at it
      const bar = await page.evaluate(() => ({
        chip: [document.getElementById("chip").textContent, document.getElementById("chip").getAttribute("aria-label")],
        input: document.querySelector("#chatbar .cp-input").getAttribute("aria-label"),
        send: document.querySelector("#chatbar .cp-row [data-a=send]").disabled,
        above: Math.round(document.getElementById("bar").getBoundingClientRect().top - document.getElementById("chatbar").getBoundingClientRect().bottom),
      }));
      assert.deepEqual(bar, { chip: ["Agent", "Agent has this tab: take over"], input: "Message the agent", send: true, above: 0 }, "the chat bar above the bar, Send off while empty");
      // A tap at an element's middle, as the page draws the picture.
      const tapAt = async (ref) => {
        const st = stateOf();
        const t = st.targets.find((g) => g.ref === ref);
        assert.ok(t, `${ref} in the targets: ${JSON.stringify(st.targets)}`);
        const at = await page.evaluate((b, w) => { const r = document.getElementById("shot").getBoundingClientRect(); const k = r.width / w; return [r.left + (b.x + b.w / 2) * k, r.top + (b.y + b.h / 2) * k]; }, t, st.size.w);
        await page.mouse.click(at[0], at[1]);
        await new Promise((r) => setTimeout(r, 150));
      };
      await page.click("#chatbar .cp-point");
      await tapAt(signInRef);
      const password = stateOf().targets.find((t) => t.role === "input[password]");
      await tapAt(password.ref);
      const pointed = await page.evaluate(() => ({
        mode: document.querySelector("#chatbar .cp-mode p").textContent,
        chips: [...document.querySelectorAll("#chatbar .cp-pick span")].map((c) => c.textContent),
        marks: document.querySelectorAll("#marks .mark").length,
      }));
      assert.deepEqual(pointed, { mode: "A password field can’t be picked. 1 of 5", chips: ["1 · button “Sign in”"], marks: 1 }, "one picked, numbered on the page; the password field refused");
      assert.equal(stateOf().who, "agent", "pointing doesn't take the tab over");
      await page.keyboard.press("Escape");
      await page.click("#chatbar .cp-input");
      const typing = await page.evaluate(() => [document.getElementById("chatbar").dataset.state, document.getElementById("thin").hidden, document.getElementById("bar").hidden, document.activeElement.className]);
      assert.deepEqual(typing, ["expanded", false, true, "cp-area"], "typed in: the multi-line composer, over the thin bar");
      await page.keyboard.type("Which one exports them?");
      await page.click("#chatbar .cp-actions [data-a=send]");
      const sent = await page.evaluate(() => window.posted.map((m) => JSON.parse(m)));
      const host = stateOf().host;
      assert.deepEqual(sent, [{ comment: { workspace: ws.slug, thread: "export-my-statements", message: `About the browser tab Sign in (${host}):\n1. [${signInRef}] button "Sign in"\n\nWhich one exports them?` } }]);
      await page.evaluate(() => window.AnywhereLLMApps.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ok: true, chat: "Export my statements" }) })));
      await page.waitForFunction(() => document.getElementById("toast").textContent.startsWith("Sent to"), { timeout: 3_000 });
      assert.equal(await page.evaluate(() => document.getElementById("toast").textContent), "Sent to Export my statementsOpen chat");
      assert.equal(await page.evaluate(() => [document.querySelectorAll("#chatbar .cp-pick").length, document.querySelectorAll("#marks .mark").length, document.querySelector("#chatbar .cp-input").value].join()), "0,0,", "sent: the picks and the words go");
      await page.click("#toast button");
      assert.deepEqual(JSON.parse((await page.evaluate(() => window.posted)).at(-1)), { open: { workspace: ws.slug, thread: "export-my-statements" } }, "Open chat opens the tab's chat");
      // Not sent: AnywhereLLM's error is said, and the words are kept.
      await page.click("#chatbar .cp-input");
      await page.keyboard.type("Again");
      await page.click("#chatbar .cp-actions [data-a=send]");
      await page.evaluate(() => window.AnywhereLLMApps.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ok: false, error: "That chat is gone." }) })));
      await page.waitForFunction(() => document.querySelector("#chatbar .cp-said").textContent.startsWith("Not sent"), { timeout: 3_000 });
      assert.equal(await page.evaluate(() => [document.querySelector("#chatbar .cp-said").textContent, document.querySelector("#chatbar .cp-area").value].join("|")), "Not sent: That chat is gone.|Again");
      assert.deepEqual(errors, [], "no error on the page");
    } finally {
      await browser.close();
    }
  }

  const found = await call({ action: "search", query: "export" });
  assert.match(found, /1\. Docs for export\n {3}http:\/\/localhost:\d+\/docs/, found);
  assert.match(await call({ action: "look", url: DOCS, find: "export" }), /The export button is under Settings\./);
  assert.match(await call({ action: "open", url: "http://10.1.2.3/" }), /isn't a public address/);

  // Signed in, the browser closes (past three browsers, the oldest does) and starts again signed in.
  assert.match(await call({ action: "open", url: `${SITE}/me` }), /Signed in\./);
  for (const other of ["e2e-2", "e2e-3", "e2e-4"]) await call({ action: "open", url: DOCS }, 1, other);
  assert.ok(!fs.readFileSync(path.join(storage, "vault-lean", "sealed", "session-e2e.json"), "utf8").includes("sid"), "the cookie is sealed beside the vault");
  assert.ok(!fs.existsSync(path.join(storage, "browser-lean", "e2e", "profile")), "no profile in the storage");
  assert.match(await call({ action: "open", url: `${SITE}/me` }), /Signed in\./, "signed in again after the restart");

  server.close();
  console.log("ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
