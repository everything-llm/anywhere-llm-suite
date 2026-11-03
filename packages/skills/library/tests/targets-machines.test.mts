// Targets (src/targets.ts), the first of three files: registering and checking machines. The page's
// key and save, the switch, moves and deletes, the fence on addresses, this machine and the owner's
// exception, and what a target can reach.
// The stand-in machine, its reset before each test and the helpers are in targets-fixture.mts.

import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listen } from "#shared/test-helpers";
import { call as called, keyPair, LIBRARY_CARD, pageConfig, pageState, post, storage, THIS_HOST_FINGERPRINT, until } from "./harness.mts";
import { asThisMachine, BASE, boxState, call, fingerprint, HINT, hostKey, IMPOSTER_PORT, letJobs, LOOK_MS, machine, ops, otherHostKey, pageOf, PORT, printed, reachLeft, record, recordFile, register, registered, result, savedAs, seal, seen, SIGN_IN_MS } from "./targets-fixture.mts";

test("a target is asked for and registered on the page, with a key made there whose private half nobody is shown", async () => {
  const asked = await call({ action: "secret", kind: "ssh", label: "box" });
  assert.match(asked, new RegExp(`^The user adds the machine "box" on the Library page, under Machines\\. Give them this card as it is, in its own quote:\\n\\n${LIBRARY_CARD}\\n\\nTell them to open it`));
  assert.deepEqual(pageState().needs.map(({ label, site }: { label: string; site: string }) => ({ label, site })), [{ label: "box", site: "" }]);
  const box = await register({}, undefined, undefined, false);
  assert.match(box.public, /^ssh-ed25519 AAAA\S+ library-lean box$/);
  assert.equal(box.status, "the target \"box\" refused its key: the user runs the setup command the Library page shows under Machines on the machine, as sandbox, then tries again", "tried at once, before its line was added");
  assert.equal(box.problem, "key", "the page says the key was refused, and shows the command again");
  assert.equal(box.private, true, "127.0.0.1 is private by itself");
  assert.deepEqual(pageState().needs, [], "the need is met");
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await call({ action: "library" });
  await until(() => boxState().status === "signed in", SIGN_IN_MS);
  const vaultText = fs.readFileSync(path.join(storage, "vault-lean", "vault.json"), "utf8");
  assert.ok(!vaultText.includes("PRIVATE KEY") && !vaultText.includes("sandbox"), "the vault holds it encrypted");
  assert.ok(!JSON.stringify(pageState()).includes("PRIVATE KEY"), "the page never shows the private half");
  await ops();
  const listed = await call({ action: "library", service: "ops" });
  assert.match(listed, /Targets: box \(sandbox@127\.0\.0\.1:\d+, signed in\)/);
  assert.ok(!listed.includes("PRIVATE KEY"));
});

test("a pasted key signs in; a key that isn't one, or a line without a fingerprint, isn't saved", async () => {
  const mine = keyPair();
  const box = await register({}, mine);
  assert.equal(box.public, null, "a pasted key's public half is the user's own");
  assert.equal(box.status, "signed in");
  assert.equal(box.problem, null);
  for (const fields of [{ sealed: seal("not a key") }, { fingerprint: "256 SHA256:short root@box (ED25519)" }]) post({ secret: pageConfig().secret, ev: "target-save", label: "bad", host: `127.0.0.1:${PORT}`, login: "sandbox", fingerprint: printed(hostKey.public), ...fields });
  await call({ action: "library" });
  assert.deepEqual(pageState().targets.map((t: { label: string }) => t.label), ["box"], "none of them was saved");
});

test("the page's key is made before the machine is saved: the setup command carries it, a save takes it, and a stale one is refused", async () => {
  await call({ action: "secret", kind: "ssh", label: "box" });
  const spare = pageState().spare;
  assert.match(spare, /^ssh-ed25519 AAAA\S+ library-lean$/, "the page has a key for the command before anything is saved");
  assert.equal(pageState().spare, spare, "kept until a save takes it");
  const box = await register();
  assert.equal(box.public.split(" ")[1], spare.split(" ")[1], "the machine signs in with the key the command added");
  assert.match(box.public, / library-lean box$/);
  assert.notEqual(pageState().spare.split(" ")[1], spare.split(" ")[1], "the next machine gets a key of its own");
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await call({ action: "library" });
  // It was signed in already, so the try is waited for to its end: a try left going signs in, after
  // the next test's reset, with a key the stand-in no longer takes, and writes that on its "box".
  await until(() => boxState().status === "signed in" && !boxState().trying, SIGN_IN_MS + LOOK_MS);
  // A command copied before that save carries the key box took: another machine can't take it.
  const n = pageState().result.n;
  post({ secret: pageConfig().secret, ev: "target-save", label: "two", host: `127.0.0.2:${PORT}`, login: "sandbox", fingerprint: printed(hostKey.public), public: spare, sealed: "" });
  await call({ action: "library" });
  await until(() => pageState().result.n > n);
  assert.deepEqual({ ...pageState().result, n: 0 }, { n: 0, ev: "target-save", label: "two", error: "This command’s key was used for another machine. Copy the command again and run it on the machine.", field: "command" });
  assert.deepEqual(pageState().targets.map((t: { label: string }) => t.label), ["box"]);
});

test("Scheduled jobs may use it: the page's switch, on and off", async () => {
  await register();
  assert.equal(boxState().unattended, false);
  for (const on of [true, false]) await letJobs(on);
});

test("the user deletes a target on the page, and with it its key", async () => {
  await register();
  post({ secret: pageConfig().secret, ev: "target-delete", label: "box" });
  await call({ action: "library" });
  assert.deepEqual(pageState().targets, []);
});

test("a name that looks public and resolves to a private address is refused when it connects, whatever the page says and FENCE_ALLOW names; its address itself is let through", async () => {
  const lookup = dns.lookup;
  const allow = process.env.FENCE_ALLOW;
  process.env.FENCE_ALLOW = "127.0.0.1,box.example";
  dns.lookup = ((host: string, options: unknown, cb: (...a: unknown[]) => void) => (host === "box.example" ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : (lookup as (...a: unknown[]) => void)(host, options, cb))) as typeof dns.lookup;
  try {
    // The page's old "On my network" tick, if one were posted, plays no part.
    const refused = await register({ host: `box.example:${PORT}`, private: true });
    assert.match(refused.status, /box\.example resolves to 127\.0\.0\.1, which isn't a public address/);
    assert.equal(refused.problem, "fenced", "the page says to give the address itself");
    assert.equal(refused.private, false, "a name that looks public is public");
    assert.equal(seen.auths, 0, "no sign-in was tried");
    const itself = await register({ host: `127.0.0.1:${PORT}` });
    assert.equal(itself.status, "signed in", "a private address is let through, at its own host and port");
  } finally {
    dns.lookup = lookup;
    process.env.FENCE_ALLOW = allow;
  }
});

test("moving a target to another host, port or account drops its key; an edit that stays put keeps it", async () => {
  const first = await register();
  const edit = async (fields: Record<string, unknown>) => {
    const n = pageState().result?.n ?? 0;
    post({ secret: pageConfig().secret, ev: "target-save", label: "box", host: `127.0.0.1:${PORT}`, login: "sandbox", fingerprint: printed(hostKey.public), sealed: "", ...fields });
    await call({ action: "library" });
    await until(() => (pageState().result?.n ?? 0) > n);
    await until(() => boxState().status !== "not tried yet", SIGN_IN_MS);
    return boxState();
  };
  await letJobs();
  const same = await edit({ fingerprint: printed(otherHostKey.public), public: first.public });
  assert.equal(same.public, first.public, "the fingerprint changes (set up again), the key stays");
  assert.equal((await edit({ fingerprint: printed(hostKey.public), public: first.public })).unattended, true, "set up again in the same place, it keeps the switch");
  for (const moved of [{ host: `127.0.0.2:${PORT}` }, { host: `127.0.0.1:${PORT + 1}` }, { login: "other" }]) {
    const was = boxState().public;
    const now = await edit(moved);
    assert.match(now.public, /^ssh-ed25519 AAAA\S+ library-lean box$/);
    assert.notEqual(now.public, was, `${JSON.stringify(moved)}: a new key is made, whose line goes in the new account's authorized_keys`);
    await edit({ host: `127.0.0.1:${PORT}`, login: "sandbox" });
  }
});

test("a target can't be this machine: a literal address, a name, or a name that answers otherwise at connect time", async () => {
  await call({ action: "secret", kind: "ssh", label: "box" }); // makes the page
  await asThisMachine(async () => {
    const saved = () => pageState().targets.map((t: { label: string }) => t.label);
    const refusal = async (label: string, host: string) => {
      const n = pageState().result?.n ?? 0;
      post({ secret: pageConfig().secret, ev: "target-save", label, host, login: "sandbox", fingerprint: printed(hostKey.public), sealed: "" });
      await call({ action: "library" });
      await until(() => (pageState().result?.n ?? 0) > n);
      return pageState().result.error as string | null;
    };
    for (const host of ["127.0.0.1", "127.0.0.9", "::1", "0.0.0.0", "169.254.169.254", "fe80::1"]) {
      assert.equal(await refusal("itself", host), "That’s an address of the machine AnythingLLM runs on. Add a different machine.", host);
      assert.equal(pageState().result.field, "host", "shown under the address");
    }
    assert.deepEqual(saved(), [], "none of them was saved");
    const lookup = dns.lookup;
    let calls = 0;
    dns.lookup = ((host: string, options: unknown, cb: (...a: unknown[]) => void) => {
      if (host === "me.example") return cb(null, [{ address: "127.0.0.1", family: 4 }]);
      // Public when the save asks, this machine when the connection does.
      if (host === "rebind.example") return cb(null, [{ address: ++calls === 1 ? "192.0.2.9" : "127.0.0.1", family: 4 }]);
      return (lookup as (...a: unknown[]) => void)(host, options, cb);
    }) as typeof dns.lookup;
    try {
      assert.equal(await refusal("itself", "me.example"), "me.example leads to the machine AnythingLLM runs on. Add a different machine.");
      assert.equal(await refusal("rebind", "rebind.example"), null, "a name that was public when saved is saved");
      await until(() => pageState().targets.find((t: { label: string }) => t.label === "rebind")?.status !== "not tried yet", SIGN_IN_MS);
      const rebound = pageState().targets.find((t: { label: string }) => t.label === "rebind");
      assert.match(rebound.status, /rebind\.example:\d+ isn't reached: .*an address of this machine itself/, "the address the connection goes to is checked, at connect time");
      assert.equal(rebound.problem, "this-machine", "the page says it's the machine AnythingLLM runs on");
      assert.equal(seen.open, 0, "nothing connected");
    } finally {
      dns.lookup = lookup;
    }
  });
});

test("a target that can fetch this AnythingLLM's pages is refused, and the token file it was asked for is gone", async () => {
  machine.serve = pageOf;
  const box = await registered();
  assert.match(box.barred, /^it can reach this AnythingLLM's pages at anythingllm\.test:3001\. Block that address in its firewall, then try again$/);
  assert.equal(seen.fetched.length, 1);
  assert.match(seen.fetched[0], /^http:\/\/anythingllm\.test:3001\/library-lean\/reach-[0-9a-f]{16}\.txt$/);
  assert.deepEqual(reachLeft(), [], "the file is removed");
  await ops();
  const execs = seen.execs;
  assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }), /the target "box" isn't used: it can reach this AnythingLLM's pages/);
  assert.equal(seen.execs, execs, "nothing was run on it");
  assert.match(await call({ action: "library", service: "ops" }), /Targets: box \(sandbox@127\.0\.0\.1:\d+, signed in, not used: it can reach this AnythingLLM's pages/);
  assert.match(boxState().barred, /can reach/, "the Targets card shows it");
  // Put right, then tried again: used.
  machine.serve = () => null;
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => boxState().barred === null, LOOK_MS);
  assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n");
});

test("a target that can't fetch the pages is used; one that can't say (no curl or wget) is shown, not refused", async () => {
  const blocked = await registered();
  assert.equal(blocked.barred, null);
  assert.ok(!blocked.notes.some((n: string) => /reaches/.test(n)), "a refused connection says nothing more");
  await ops();
  assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n");
  machine.tools = false;
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => boxState().notes.some((n: string) => /it has neither curl nor wget/.test(n)), LOOK_MS);
  assert.equal(boxState().barred, null);
  assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n");
  assert.deepEqual(reachLeft(), []);
});

test("a target that sees AnythingLLM's storage, or is this machine's account, is refused", async () => {
  machine.sees = true;
  const sees = await registered();
  assert.match(sees.barred, /^it can read AnythingLLM's storage, where the Vault keeps its secrets\. Use another machine or account$/);
  assert.deepEqual(fs.readdirSync(path.join(storage, "vault-lean")).filter((n) => n.startsWith(".reach-marker")), [], "the marker is removed");
  machine.sees = false;
  Object.assign(machine, { hostname: os.hostname(), uid: String(process.getuid!()) });
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => /^it is the account AnythingLLM runs as \(hostname .*\), which can read the Vault's secrets\. Use another machine or account$/.test(boxState().barred ?? ""), LOOK_MS);
  // The same hostname alone, or the same user alone, proves nothing.
  for (const other of [{ hostname: os.hostname(), uid: String(process.getuid!() + 1) }, { hostname: `${os.hostname()}-x`, uid: String(process.getuid!()) }]) {
    Object.assign(machine, other);
    post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
    await called({ action: "library" }, { slug: "work", base: BASE });
    await until(() => boxState().barred === null, LOOK_MS);
  }
});

test("a target is looked at on its first use when it wasn't at its check for want of AnythingLLM's address", async () => {
  machine.serve = pageOf;
  const box = await registered(null);
  assert.equal(box.barred, null);
  assert.ok(box.notes.some((n: string) => /AnythingLLM's own address isn't known here/.test(n)));
  assert.equal(seen.fetched.length, 0);
  await ops();
  assert.match(await called({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }, { slug: "work", base: BASE }), /the target "box" isn't used: it can reach this AnythingLLM's pages/);
  assert.equal(seen.fetched.length, 1, "looked at once");
  assert.match(boxState().barred, /can reach/);
  assert.deepEqual(reachLeft(), []);
});

test("it warns, without refusing, of an AnythingLLM with no password, and the vault's key beside the vault", async () => {
  const answers = { results: { RequiresAuth: false, MultiUserMode: false } };
  const web = http.createServer((req, res) => res.end(req.url === "/api/setup-complete" ? JSON.stringify(answers) : "{}"));
  const base = `http://127.0.0.1:${await listen(web)}`;
  try {
    const open = await registered(base);
    assert.equal(open.barred, null);
    assert.ok(open.notes.includes("this AnythingLLM has no password: whoever reaches it is its administrator"));
    assert.ok(open.notes.some((n: string) => /the vault's key is kept beside the vault \(VAULT_KEY_FILE isn't set\)/.test(n)));
    answers.results.RequiresAuth = true;
    post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
    await called({ action: "library" }, { slug: "work", base });
    await until(() => !boxState().notes.some((n: string) => /no password/.test(n)), LOOK_MS);
    assert.equal(boxState().barred, null);
  } finally {
    web.close();
  }
});

test("without a good record of this machine no target is saved or used", async () => {
  await register();
  await ops();
  assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n", "with the record it is used");
  const writeRecord = (text: string) => (fs.mkdirSync(path.dirname(recordFile()), { recursive: true }), fs.writeFileSync(recordFile(), text));
  const cases: [string, () => void, RegExp][] = [
    ["no file", () => fs.rmSync(recordFile(), { force: true }), /this machine isn't recorded.*is missing.*run the installer on the host/],
    ["a file that isn't JSON", () => writeRecord("not json"), /this machine isn't recorded.*isn't JSON/],
    ["a file that isn't a record", () => writeRecord('{"fingerprints":"x"}'), /this machine isn't recorded.*isn't a record of this machine/],
    ["no host key in it", () => writeRecord(JSON.stringify({ fingerprints: [], addresses: [] })), /holds no SSH host key.*run the installer on the host/],
    // An account allowed on this host doesn't make a record without a key usable.
    ["no host key, and this very account allowed", () => writeRecord(JSON.stringify({ fingerprints: [], addresses: [], allow: [{ login: "sandbox", port: PORT }] })), /holds no SSH host key/],
  ];
  for (const [what, make] of cases.map(([w, m]) => [w, m] as const)) {
    record(undefined); // the file, as shipped code reads it
    make();
    const wanted = cases.find(([w]) => w === what)![2];
    const execs = seen.execs;
    const auths = seen.auths;
    assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }), wanted, `${what}: a saved target isn't used`);
    assert.match((await savedAs("other", {})) ?? "", /^The page can’t yet tell this machine from others\. Run the installer/, `${what}: nothing is saved`);
    assert.deepEqual(pageState().targets.map((t: { label: string }) => t.label), ["box"]);
    assert.equal(seen.execs, execs, `${what}: nothing was run`);
    assert.equal(seen.auths, auths, `${what}: nothing was signed in to`);
  }
});

test("a machine that shows this host's SSH host key is refused, whatever its address", async () => {
  await call({ action: "secret", kind: "ssh", label: "twin" }); // makes the page
  // The address is not this machine's by anything the container sees or the record holds; the key is.
  record({ fingerprints: [fingerprint(otherHostKey.public)], addresses: [] });
  assert.equal(await savedAs("twin", { fingerprint: printed(otherHostKey.public) }), "That’s the machine AnythingLLM runs on. Add a different machine.", "refused when the user pastes its fingerprint");
  assert.equal(pageState().result.field, "fingerprint", "shown under the line pasted");
  assert.deepEqual(pageState().targets, []);
  // Saved with a fingerprint that isn't this host's, at a machine that shows this host's key: the
  // key it shows is what is refused, before anything is sent.
  assert.equal(await savedAs("twin", { host: `127.0.0.1:${IMPOSTER_PORT}` }), null);
  await until(() => pageState().targets.find((t: { label: string }) => t.label === "twin")?.status !== "not tried yet", SIGN_IN_MS);
  const twin = pageState().targets.find((t: { label: string }) => t.label === "twin");
  assert.match(twin.status, /is this machine: SHA256:\S+ is this machine's own SSH host key.*Nothing was sent/);
  assert.equal(twin.problem, "this-machine");
  assert.equal(seen.execs, 0);
});

test("an account the owner allowed on this host is saved and used, at that login and port alone", async () => {
  // The stand-in is this machine by its address (no stand-in exception) and by its host key.
  const thisHost = { fingerprints: [fingerprint(hostKey.public)], addresses: [] };
  record({ ...thisHost, allow: [{ login: "sandbox", port: PORT }] });
  await asThisMachine(async () => {
    const box = await register();
    assert.equal(box.status, "signed in", "the allowed account at its port");
    assert.equal(box.problem, null);
    await ops();
    assert.equal(result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } })).stdout, "hi\n");
    // Another login, or another port, on this host is refused as before, with the hint.
    assert.equal(await savedAs("other", { login: "other" }), "That’s the machine AnythingLLM runs on. Add a different machine.");
    assert.equal(pageState().result.hint, HINT(`other@${PORT}`));
    assert.equal(await savedAs("other", { host: `127.0.0.1:${IMPOSTER_PORT}` }), "That’s the machine AnythingLLM runs on. Add a different machine.", "another port");
    assert.equal(pageState().result.hint, HINT(`sandbox@${IMPOSTER_PORT}`));
    // By its address alone (its key isn't recorded): refused under the address.
    record({ fingerprints: [THIS_HOST_FINGERPRINT], addresses: [], allow: [{ login: "sandbox", port: PORT }] });
    assert.equal(await savedAs("other", { login: "other" }), "That’s an address of the machine AnythingLLM runs on. Add a different machine.");
    assert.equal(pageState().result.field, "host");
    assert.equal(pageState().result.hint, HINT(`other@${PORT}`));
    assert.equal(await savedAs("other", { login: "Sandbox" }), "That’s an address of the machine AnythingLLM runs on. Add a different machine.", "a login is compared exactly");
    assert.deepEqual(pageState().targets.map((t: { label: string }) => t.label), ["box"]);
  });
  // A refusal that isn't this machine's has no hint.
  assert.equal(await savedAs("other", { fingerprint: "no fingerprint" }), "That line has no SHA256 fingerprint. Paste the whole line the command printed, like 256 SHA256:… root@pi (ED25519).");
  assert.equal(pageState().result.hint, undefined);
});

test("a target saved while its account was allowed isn't used once the owner takes it out", async () => {
  record({ fingerprints: [fingerprint(hostKey.public)], addresses: [], allow: [{ login: "sandbox", port: PORT }] });
  await register();
  await ops();
  const run = () => call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } });
  assert.equal(result(await run()).stdout, "hi\n");
  // Taken out (this-host --disallow writes the record without it): the host key says this machine.
  record({ fingerprints: [fingerprint(hostKey.public)], addresses: [] });
  const execs = seen.execs;
  assert.match(await run(), /the target "box" \(127\.0\.0\.1:\d+\) is this machine: SHA256:\S+ is this machine's own SSH host key.*Nothing was sent/);
  assert.equal(seen.execs, execs, "nothing was run");
  // Allowed at another port only: the same.
  record({ fingerprints: [fingerprint(hostKey.public)], addresses: [], allow: [{ login: "sandbox", port: PORT + 1 }, { login: "other", port: PORT }] });
  assert.match(await run(), /is this machine: .*Nothing was sent/);
  // By its address: refused before connecting, and the card says this machine.
  await asThisMachine(async () => {
    record({ fingerprints: [THIS_HOST_FINGERPRINT], addresses: [], allow: [{ login: "sandbox", port: PORT }] });
    assert.equal(result(await run()).stdout, "hi\n", "allowed, at its address");
    record({ fingerprints: [THIS_HOST_FINGERPRINT], addresses: [] });
    const open = seen.open;
    assert.match(await run(), /isn't reached: .*an address of this machine itself/);
    assert.equal(seen.open, open, "nothing connected");
    post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
    await call({ action: "library" });
    await until(() => boxState().problem === "this-machine", SIGN_IN_MS);
  });
  assert.equal(seen.execs, execs + 1, "only the run while it was allowed");
});

test("a target is asked to fetch the pages from AnythingLLM's address and from each of this host's, on each port, at once", async () => {
  record({ fingerprints: [THIS_HOST_FINGERPRINT], addresses: ["127.0.0.1", "fe80::1", "10.1.2.3", "2001:db8::5"] });
  const page = (u: URL) => pageOf(u);
  const miss = await registered();
  assert.equal(miss.barred, null);
  const rel = /\/library-lean\/reach-[0-9a-f]{16}\.txt$/;
  const origins = seen.fetched.map((u) => u.replace(rel, "")).sort();
  assert.deepEqual(origins, ["http://10.1.2.3:3001", "http://10.1.2.3:8467", "http://[2001:db8::5]:3001", "http://[2001:db8::5]:8467", "http://anythingllm.test:3001", "https://10.1.2.3:443", "https://[2001:db8::5]:443"].sort(), "loopback and link-local addresses of the host mean the machine itself, and aren't tried");
  assert.equal(seen.execs - 1 >= 1, true);
  // Only a page that answers with the token is a hit: another service on 3001 saying something isn't.
  const one = seen.fetched.length;
  machine.serve = (u) => (u.host === "10.1.2.3:8467" ? page(u) : u.host === "10.1.2.3:3001" ? "<html>hello</html>" : null);
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => boxState().barred !== null, LOOK_MS);
  assert.match(boxState().barred, /^it can reach this AnythingLLM's pages at 10\.1\.2\.3:8467\. Block/);
  assert.ok(seen.fetched.length > one);
  // Hits at two addresses are both named.
  machine.serve = (u) => (u.host === "10.1.2.3:8467" || u.host === "anythingllm.test:3001" ? page(u) : null);
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work", base: BASE });
  await until(() => /anythingllm\.test:3001/.test(boxState().barred ?? "") && /10\.1\.2\.3:8467/.test(boxState().barred ?? ""), LOOK_MS);
  // Without AnythingLLM's own address the host's are still tried.
  machine.serve = (u) => (u.hostname === "[2001:db8::5]" && u.protocol === "https:" ? page(u) : null);
  post({ secret: pageConfig().secret, ev: "target-check", label: "box" });
  await called({ action: "library" }, { slug: "work" });
  await until(() => /2001:db8::5:443|\[?2001:db8::5\]?:443/.test(boxState().barred ?? ""), LOOK_MS);
  assert.deepEqual(reachLeft(), []);
});

test("every save looks at what the target reaches again, not only the first", async () => {
  const first = await registered();
  assert.equal(first.barred, null);
  const before = seen.fetched.length;
  machine.serve = pageOf;
  assert.equal(await savedAs("box", {}, BASE), null, "saved again as it was");
  await until(() => boxState().barred !== null, LOOK_MS);
  assert.ok(seen.fetched.length > before, "looked at again");
  assert.match(boxState().barred, /can reach/);
});

test("any failure of a target save is told to the page, which would otherwise wait for it", async () => {
  await call({ action: "secret", kind: "ssh", label: "box" });
  const lookup = dns.lookup;
  const logged: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  dns.lookup = ((host: string, options: unknown, cb: (...a: unknown[]) => void) => {
    if (host === "boom.example") throw new Error("the resolver broke");
    return (lookup as (...a: unknown[]) => void)(host, options, cb);
  }) as typeof dns.lookup;
  try {
    assert.equal(await savedAs("box", { host: "boom.example" }), "Couldn’t save the machine. Try again, or check AnythingLLM’s log.");
    assert.ok(logged.some((l) => /couldn't apply a page event \(target-save\): the resolver broke/.test(l)), "the real error is logged");
    assert.deepEqual(pageState().targets, []);
  } finally {
    dns.lookup = lookup;
    console.error = log;
  }
});
