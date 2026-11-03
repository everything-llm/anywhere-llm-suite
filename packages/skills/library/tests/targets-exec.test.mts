// Targets (src/targets.ts), the second of three files: running commands on a target. Exit, output and
// stdin, what a function may name, the pinned host key, caps and times, stops, the 4 slots and the 60
// uses a minute.
// The stand-in machine, its reset before each test and the helpers are in targets-fixture.mts.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { keyPair, storage, until } from "./harness.mts";
import { allow, call, exec, file, fileFn, fingerprint, hostKey, IMPOSTER_PORT, letJobs, machine, ops, otherHostKey, PORT, register, result, seen, sleep } from "./targets-fixture.mts";

const { utils } = ssh2;

test("a function runs a command on its toolkit's target: its exit, output and error, and its stdin", async () => {
  await register();
  await ops();
  const hi = await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } });
  assert.match(hi, /^Ran ops\.run \(r-[\w-]+\): ok, [\d.]+ s, 1 request\./);
  assert.match(hi, /- SSH box \$ \(7 characters\): 0 \(\d+ ms\)/);
  assert.deepEqual({ ...result(hi), ms: 0 }, { exit: 0, signal: null, stdout: "hi\n", stderr: "", truncated: false, killed: null, remote_may_run: false, ms: 0 });
  const failed = result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "fail" } } }));
  assert.deepEqual([failed.exit, failed.stderr], [3, "no such thing\n"]);
  await call({ action: "save", service: "ops", function: { name: "shout", description: "Upper-cases its input on the machine.", source: "async function main(input, kit) { return (await kit.ssh.exec({ target: 'box', command: 'cat', stdin: 'quiet' })).stdout; }" } });
  assert.match(await call({ action: "run", name: "ops.shout", inputs: {} }), /Result \(JSON\):\n"QUIET"/);
});

test("a function names a target and nothing else of it: a host, a key or a target its toolkit lacks is refused", async () => {
  await register();
  await ops();
  seen.auths = 0;
  for (const field of ["host", "port", "user", "privateKey", "password", "fingerprint"]) {
    const said = await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi", [field]: "x" } } });
    assert.match(said, new RegExp(`kit\\.ssh\\.exec takes target, command, stdin, timeout_s, max_bytes, not ${field}: a target's host, port, login, key and fingerprint are the user's`), field);
  }
  assert.equal(seen.auths, 0, "nothing reached the machine");
  await call({ action: "save", service: "ops", function: { name: "elsewhere", description: "Another target.", source: "async function main(i, kit) { return kit.ssh.exec({ target: 'prod', command: 'echo hi' }); }" } });
  assert.match(await call({ action: "run", name: "ops.elsewhere", inputs: {} }), /"prod" isn't one of the ops toolkit's targets \(box\)/);
  await call({ action: "save", service: "ops", toolkit: { targets: ["box", "prod"] } });
  assert.match(await call({ action: "run", name: "ops.elsewhere", inputs: {} }), /no target "prod" is saved: ask the user for it with secret, kind "ssh"/);
});

test("a host key other than the one pinned is refused before signing in, and nothing is sent", async () => {
  await register({ host: `127.0.0.1:${IMPOSTER_PORT}` });
  await ops();
  seen.auths = 0;
  const said = await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } });
  assert.match(said, new RegExp(`showed a host key that isn't the one saved for it \\(saved ${fingerprint(hostKey.public).replace(/[+/]/g, "\\$&")}, shown ${fingerprint(otherHostKey.public).replace(/[+/]/g, "\\$&")}\\): nothing was sent`));
  assert.equal(seen.auths, 0, "no sign-in was tried");
});

test("output past its cap is cut, and a command past its time is stopped and said to be maybe still going", async () => {
  await register();
  await ops();
  const big = result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "big", max_bytes: 1000 } } }));
  assert.deepEqual([big.stdout.length, big.stderr, big.truncated], [1000, "yyyyyyyyyy", true]);
  const hung = result(await call({ action: "run", name: "ops.run", inputs: { req: { command: "hang", timeout_s: 1 } } }));
  assert.deepEqual([hung.killed, hung.exit, hung.remote_may_run], ["timeout", null, true], "TERM, then its channel closed 2 s later, with no exit status from the machine");
  assert.ok(hung.ms >= 3000 && hung.ms < 4500, `${hung.ms} ms`);
  await until(() => seen.closed === 1);
});

test("a stopped run stops the command it's waiting on", async () => {
  await register();
  await ops();
  process.env.LIBRARY_WAIT_MS = "300";
  const started = await call({ action: "run", name: "ops.run", inputs: { req: { command: "hang", timeout_s: 60 } } });
  const id = started.match(/\((r-[\w-]+)\)/)![1];
  await until(() => seen.hung > 0);
  assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.run.*stopped/);
  await until(() => seen.closed === 1);
});

test("channels the machine opens toward the library (a remote forward, X11) are refused", async () => {
  await register();
  await ops();
  assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "open channels" } } }), /"stdout": "tried\\n"/);
  assert.deepEqual(seen.refused.sort(), ["forwarded-tcpip", "x11"]);
});

test("scheduled jobs use a target only when the user lets them, and a target takes 4 commands at once", async () => {
  await register();
  await ops();
  assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }, null), /scheduled jobs don't use the target "box": the user switches on "Scheduled jobs may use it" for it on the Library page, under Machines/);
  await letJobs();
  assert.match(await call({ action: "run", name: "ops.run", inputs: { req: { command: "echo hi" } } }, null), /"stdout": "hi\\n"/);
  const naps = await Promise.all(Array.from({ length: 6 }, () => call({ action: "run", name: "ops.run", inputs: { req: { command: "nap" } } })));
  for (const n of naps) assert.match(n, /"exit": 0/);
  assert.equal(seen.most, 4, `${seen.most} at once: 4 is the limit, and 6 asked`);
});

test("the ssh2 internals term() sends TERM through are where it reaches for them, on an ended channel", async () => {
  const client = new ssh2.Client();
  allow(utils.parseKey(hostKey.public) as ssh2.ParsedKey); // any key the stand-in knows: here, its own
  await new Promise<void>((resolve, reject) => client.once("ready", resolve).once("error", reject).connect({ host: "127.0.0.1", port: PORT, username: "x", privateKey: hostKey.private, hostVerifier: () => true }));
  const stream = await new Promise<ssh2.ClientChannel>((resolve, reject) => client.exec("hang", (err, s) => (err ? reject(err) : resolve(s))));
  stream.end();
  const channel = stream as unknown as { outgoing: { id: number; state: string }; _client: { _protocol: { signal: unknown } } };
  assert.equal(channel.outgoing.state, "eof");
  assert.equal(typeof channel.outgoing.id, "number");
  assert.equal(typeof channel._client._protocol.signal, "function");
  client.end();
});

test("a machine that takes the connection but never says its banner ends at the command's time, with nothing left uncaught", async () => {
  await register();
  await ops();
  machine.silent = true;
  assert.match(await exec({ command: "echo hi", timeout_s: 1 }), /didn't finish signing in within 1 s/);
  await sleep(300); // past the second error ssh2 raises when a socket ends before the banner, which once went uncaught
});

test("a machine that never answers the request to run a command ends at the command's time, and frees its slot and connection", async () => {
  await register();
  await ops();
  process.env.LIBRARY_WAIT_MS = "4000"; // a call that doesn't end shows as "still running", which result() refuses
  for (let i = 0; i < 5; i++) {
    const ran = result(await exec({ command: "unanswered", timeout_s: 1 }));
    assert.deepEqual([ran.killed, ran.exit, ran.remote_may_run], ["timeout", null, true], "the machine may still run it");
    assert.ok(ran.ms >= 900 && ran.ms < 2500, `${ran.ms} ms`);
  }
  assert.equal(seen.unanswered, 5, "more than the 4 slots a target has: none was kept");
  assert.match(await exec({ command: "echo hi" }), /"stdout": "hi\\n"/);
});

test("a stopped run frees the slot of a command the machine never answered", async () => {
  await register();
  await ops();
  process.env.LIBRARY_WAIT_MS = "300";
  for (let i = 1; i <= 4; i++) {
    const id = (await exec({ command: "unanswered", timeout_s: 60 })).match(/\((r-[\w-]+)\)/)![1];
    await until(() => seen.unanswered === i);
    assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.run.*stopped/);
  }
  process.env.LIBRARY_WAIT_MS = "4000";
  assert.match(await exec({ command: "echo hi" }), /"stdout": "hi\\n"/, "the 4 stopped ones kept no slot");
});

test("nothing is sent to the machine once the command's time is up, even when signing in took it", async () => {
  await register();
  await ops();
  seen.execs = 0;
  seen.authDelay = 500; // signing in takes longer than the 0.2 s the command has
  const said = await exec({ command: "echo hi", timeout_s: 0.2 });
  assert.match(said, /signing in/);
  await sleep(700);
  assert.equal(seen.execs, 0, "the command never reached the machine");
  seen.authDelay = 0;
  seen.execs = 0;
  assert.match(await exec({ command: "echo hi", timeout_s: 0.001 }), /in time|"killed": "timeout"|didn't finish signing in within/);
  assert.equal(seen.execs, 0, "a time that is up before the first try sends nothing");
});

test("a target takes 60 uses a minute, a sign-in the page tried among them", async () => {
  await register(); // its sign-in was the first use
  const source = `async function main(input, kit) {
    let ok = 0;
    let error = null;
    for (let i = 0; i < 16; i++) {
      const got = await Promise.all([0, 1, 2, 3].map(() => kit.ssh.exec({ target: "box", command: "echo hi" }).then(() => 1, (e) => ((error = error || String(e.message || e)), 0))));
      ok += got.reduce((a, b) => a + b, 0);
    }
    return { ok, error };
  }`;
  await call({ action: "save", service: "ops", toolkit: { title: "Ops", targets: ["box"] }, function: { name: "many", description: "Many commands.", source } });
  const out = result(await call({ action: "run", name: "ops.many", inputs: {} }));
  assert.equal(out.ok, 59, "64 asked: 59 and the page's sign-in make the 60");
  assert.match(out.error, /the target "box" was used 60 times in the last minute/);
});

test("output and time are clamped, and what can't be one is refused before anything is sent", async () => {
  await register();
  await ops();
  await call({ action: "save", service: "ops", function: { name: "measure", description: "How much output a command gave.", inputs: { req: { type: "object", required: true } }, source: "async function main(input, kit) { const r = await kit.ssh.exec(Object.assign({ target: 'box' }, input.req)); return { length: r.stdout.length, truncated: r.truncated }; }" } });
  const measure = async (req: Record<string, unknown>) => result(await call({ action: "run", name: "ops.measure", inputs: { req } }));
  assert.deepEqual(await measure({ command: "huge", max_bytes: 5_000_000 }), { length: 1024 * 1024, truncated: true }, "1 MB at most");
  assert.deepEqual(await measure({ command: "big" }), { length: 256 * 1024, truncated: true }, "256 KB by default");
  process.env.LIBRARY_RUN_MS = "2500";
  const ended = await exec({ command: "hang", timeout_s: 300 }); // never past the run's own end
  assert.match(ended, /ran past its time and was stopped/, "the run's own end, not the 300 s");
  assert.ok(seen.hung >= 1);
  delete process.env.LIBRARY_RUN_MS;
  seen.execs = 0;
  for (const [req, said] of [
    [{ command: "echo hi", timeout_s: 0 }, /timeout_s is a positive number/],
    [{ command: "echo hi", timeout_s: "soon" }, /timeout_s is a positive number/],
    [{ command: "echo hi", max_bytes: -1 }, /max_bytes is a positive number/],
    [{ command: "x".repeat(32 * 1024 + 1) }, /at most 32768 characters/],
    [{ command: "echo\0hi" }, /kit\.ssh\.exec needs command/],
    [{ command: "  " }, /kit\.ssh\.exec needs command/],
    [{ command: "cat", stdin: "x".repeat(1024 * 1024 + 1) }, /stdin is at most 1 MB/],
    [{ command: "cat", stdin: 5 }, /stdin is text/],
  ] as [Record<string, unknown>, RegExp][]) assert.match(await exec(req), said, JSON.stringify(req).slice(0, 60));
  assert.equal(seen.execs, 0, "none of them reached the machine");
});

test("a pasted private key is in no run record, log, page or vault file", async () => {
  const mine = keyPair();
  const body = mine.private.split("\n").filter((l) => l && !l.startsWith("-----"))[0];
  await register({}, mine);
  await ops();
  await fileFn();
  await exec({ command: "echo hi" });
  await exec({ command: "fail" });
  await file("put", { path: "a.txt", content: "x" });
  await call({ action: "library", service: "ops" });
  const seenIn: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, f.name);
      if (f.isDirectory()) walk(at);
      else if (fs.readFileSync(at, "utf8").includes(body)) seenIn.push(at);
    }
  };
  walk(storage);
  walk(path.dirname(path.join(storage, "..", "public")));
  assert.deepEqual(seenIn, [], "the key is nowhere in the clear");
});
