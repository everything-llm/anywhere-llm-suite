// The stand-in machine and helpers of the targets tests (targets-*.test.mts): machines the library's
// functions run commands on over SSH (src/targets.ts), against a stand-in machine, ssh2's own Server on
// 127.0.0.1, run in the test's process. It accepts the one key it's told to, runs a few named commands,
// serves files over SFTP from memory (`files`), and can misbehave: show another host key, open channels
// toward the client, never end, stall a write. The built handler.js does the client's side, as
// AnythingLLM loads it. ssh2's server ignores a signal once the client has ended stdin, which OpenSSH's
// doesn't, so that TERM reaches a command is checked against a real sshd (tests/e2e), not here.
// The tests are in three files, so node runs them in three processes, each well inside the per-file
// --test-timeout; each file that imports this one starts its own stand-ins and resets them before each
// test. Not a *.test.mts, so it isn't run by itself.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { listen } from "#shared/test-helpers";
import { sshFingerprint } from "#shared/thishost";
import { call as called, keyPair, pageConfig, pageState, post, publicDir, reset, seal as sealWith, storage, THIS_HOST_FINGERPRINT, until } from "./harness.mts";

const { Server, utils } = ssh2;

/** The stand-in machines are on 127.0.0.1 and 127.0.0.2, which the library refuses as this machine's
 *  own: the seam names them as not this machine (shared/thishost.mts). The tests of that refusal take
 *  it away for their length. */
const THISHOST_EXCEPT = Symbol.for("anywherellm-suite.thishost.except");
const THISHOST_RECORD = Symbol.for("anywherellm-suite.thishost.record");
const standIns = new Set(["127.0.0.1", "127.0.0.2"]);
(globalThis as unknown as Record<symbol, Set<string>>)[THISHOST_EXCEPT] = standIns;
export const asThisMachine = async (fn: () => Promise<void>) => {
  const g = globalThis as unknown as Record<symbol, Set<string>>;
  g[THISHOST_EXCEPT] = new Set();
  try {
    await fn();
  } finally {
    g[THISHOST_EXCEPT] = standIns;
  }
};
export const call = (args: Record<string, unknown>, slug: string | null = "work") => called(args, { slug });

/** The longest a target's sign-in may take (src/targets.ts LIMITS.connectMs to connect, and as long to sign in, plus a margin), and the
 *  longest looking at what it reaches may (LIMITS.checkMs): what the page and these tests wait for, on a machine as busy as it gets. */
export const SIGN_IN_MS = 25_000;
export const LOOK_MS = 30_000;

/** `text` sealed as the Library page seals it (harness seal), with the key the page has. */
export const seal = (text: string): string => sealWith(text, pageConfig().pub);

export const hostKey = keyPair();
export const otherHostKey = keyPair();
export const fingerprint = (pub: string) => sshFingerprint(Buffer.from(pub.split(" ")[1], "base64"));

/** Misbehaviour of the stand-in's SFTP, by the path it concerns: removing it fails, and a rename to it
 *  is answered that many times before the next ones never are. */
export const failRemove = new Set<string>();
export const stallRenames = new Map<string, number>();

/** The stand-in's files, by path, as its SFTP keeps them. */
export const files = new Map<string, { data: Buffer; mode: number }>();
/** Symbolic links among them: a path, and the file it leads to. */
export const links = new Map<string, string>();

/** The SFTP requests a put and a get make, answered from `files`; a write to "stall.bin" is never
 *  answered. ssh2's server offers no posix-rename, so a put's move takes its fallback here. */
function serveFiles(sftp: ssh2.SFTPWrapper): void {
  const { STATUS_CODE: S, flagsToString } = utils.sftp;
  const open = new Map<string, { path: string; append: boolean }>();
  let n = 0;
  const of = (handle: Buffer) => open.get(handle.toString("hex"));
  const attrs = (f: { data: Buffer; mode: number }) => ({ size: f.data.length, mode: f.mode, uid: 0, gid: 0, atime: 0, mtime: 0 });
  sftp.on("OPEN", (id, path, flags) => {
    const how = flagsToString(flags) ?? "r";
    if (how.startsWith("r") && !files.has(path)) return sftp.status(id, S.NO_SUCH_FILE, "No such file");
    if (how.startsWith("w") || !files.has(path)) files.set(path, { data: Buffer.alloc(0), mode: 0o100644 });
    const handle = Buffer.from(String(++n));
    open.set(handle.toString("hex"), { path, append: how.startsWith("a") });
    sftp.handle(id, handle);
  });
  sftp.on("WRITE", (id, handle, offset, data) => {
    const h = of(handle)!;
    if (h.path.startsWith("stall.bin")) return; // never answered
    const f = files.get(h.path)!;
    const at = h.append ? f.data.length : offset;
    const grown = Buffer.alloc(Math.max(f.data.length, at + data.length));
    f.data.copy(grown);
    data.copy(grown, at);
    f.data = grown;
    sftp.status(id, S.OK);
  });
  sftp.on("READ", (id, handle, offset, length) => {
    const f = files.get(of(handle)!.path)!;
    if (offset >= f.data.length) return sftp.status(id, S.EOF);
    sftp.data(id, f.data.subarray(offset, offset + length));
  });
  sftp.on("CLOSE", (id, handle) => (open.delete(handle.toString("hex")), sftp.status(id, S.OK)));
  sftp.on("FSTAT", (id, handle) => sftp.attrs(id, attrs(files.get(of(handle)!.path)!)));
  sftp.on("STAT", (id, path) => {
    if (machine.sees && path.includes(".reach-marker-")) return sftp.attrs(id, attrs({ data: Buffer.from("x"), mode: 0o100600 }));
    const f = files.get(links.get(path) ?? path); // STAT follows a link
    return f ? sftp.attrs(id, attrs(f)) : sftp.status(id, S.NO_SUCH_FILE);
  });
  const setMode = (path: string, mode: number | undefined) => mode !== undefined && files.has(path) && (files.get(path)!.mode = mode);
  sftp.on("SETSTAT", (id, path, a) => (setMode(path, a.mode), sftp.status(id, S.OK)));
  sftp.on("FSETSTAT", (id, handle, a) => (setMode(of(handle)!.path, a.mode), sftp.status(id, S.OK)));
  sftp.on("REALPATH", (id, path) => {
    const real = links.get(path) ?? path;
    sftp.name(id, [{ filename: real, longname: real, attrs: {} as ssh2.Attributes }]);
  });
  sftp.on("REMOVE", (id, path) => sftp.status(id, failRemove.has(path) ? S.FAILURE : files.delete(path) ? S.OK : S.NO_SUCH_FILE));
  sftp.on("RENAME", (id, from, to) => {
    const left = stallRenames.get(to);
    if (left !== undefined) {
      if (left <= 0) return; // never answered
      stallRenames.set(to, left - 1);
    }
    if (!files.has(from) || files.has(to)) return sftp.status(id, S.FAILURE);
    files.set(to, files.get(from)!);
    files.delete(from);
    sftp.status(id, S.OK);
  });
}

/** What the stand-in is like to the reach check (src/targets.ts looked): whether it has curl or wget
 *  (tools), what a page it is asked to fetch answers, by address (serve: the body, or null when the
 *  address isn't reachable); its hostname and user; and whether it can see the marker file in the
 *  vault's folder. Its exec runs the library's fixed command in a real sh, with a curl that answers
 *  from `serve`, so the command itself (quoting, the token compared, the addresses tried together) is tested. */
export const machine = { tools: true, serve: (_u: URL): string | null => null, hostname: "vm-1", uid: "1001", sees: false, silent: false };
/** What AnythingLLM itself serves at an address: the file the library put in its public folder. */
export const pageOf = (u: URL): string | null => (fs.existsSync(path.join(publicDir, u.pathname)) ? fs.readFileSync(path.join(publicDir, u.pathname), "utf8") : null);

const shims = fs.mkdtempSync(path.join(os.tmpdir(), "targets-shims-"));
fs.mkdirSync(path.join(shims, "bin"));
fs.mkdirSync(path.join(shims, "empty"));
fs.symlinkSync("/bin/sh", path.join(shims, "empty", "sh")); // the fixed command starts another sh, and nothing else is found
fs.writeFileSync(path.join(shims, "bin", "curl"), '#!/bin/sh\nfor a; do u="$a"; done\nf="$ANSWERS/$(printf %s "$u" | sed \'s#[^A-Za-z0-9]#_#g\')"\n[ -f "$f" ] && cat "$f" || exit 7\n', { mode: 0o755 });
test.after(() => fs.rmSync(shims, { recursive: true, force: true }));
/** Runs a fixed reach command as the machine's shell would, its curl answering from `machine.serve`. */
function runReach(command: string, urls: string[]): Promise<{ out: string; code: number }> {
  const answers = fs.mkdtempSync(path.join(shims, "answers-"));
  for (const u of urls) {
    const body = machine.serve(new URL(u));
    if (body !== null) fs.writeFileSync(path.join(answers, u.replace(/[^A-Za-z0-9]/g, "_")), body);
  }
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { PATH: machine.tools ? `${path.join(shims, "bin")}:/usr/bin:/bin` : path.join(shims, "empty"), ANSWERS: answers } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.on("close", (code) => resolve({ out, code: code ?? -1 }));
  });
}

/** What the stand-in saw, for the tests to check: sign-ins tried, naps going at once, channels
 *  refused, hung commands started and their connections closed, and the connections that used SFTP
 *  closed (a try's look at what the machine reaches is one). */
export const seen = { auths: 0, open: 0, most: 0, refused: [] as string[], hung: 0, closed: 0, sftpClosed: 0, execs: 0, unanswered: 0, authDelay: 0, fetched: [] as string[] };
let allowed: ssh2.ParsedKey | null = null;
/** Lets the stand-in accept `key`, as a test that signs in by itself needs. */
export const allow = (key: ssh2.ParsedKey | null) => (allowed = key);

const standIn = (key: string) =>
  new Server({ hostKeys: [key] }, (client) => {
    client.on("error", () => {}); // a client that hangs up mid-handshake, as one refusing the host key does
    client.on("authentication", (ctx) => {
      seen.auths++;
      if (ctx.method !== "publickey" || !allowed || ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject(["publickey"]);
      if (ctx.signature && !allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
      if (ctx.signature && seen.authDelay) return void setTimeout(() => ctx.accept(), seen.authDelay);
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          serveFiles(acceptSftp());
          client.on("close", () => seen.sftpClosed++);
        });
        session.on("exec", (acceptExec, _reject, info) => {
          const command = info.command;
          seen.execs++;
          if (command === "unanswered") return void seen.unanswered++; // neither accepted nor refused
          const s = acceptExec();
          const done = (code: number) => (s.exit(code), s.end());
          if (command.startsWith("sh -c ") && command.includes("library-lean/reach-")) {
            // The fixed command that asks the machine to fetch a page of AnythingLLM from each address it may be at.
            const urls = [...command.matchAll(/https?:\/\/[^'\s\\]+/g)].map((m) => m[0]);
            seen.fetched.push(...urls);
            return void runReach(command, urls).then(({ out, code }) => (s.write(out), done(code)));
          }
          if (command === "hostname; id -u") return s.write(`${machine.hostname}\n${machine.uid}\n`), done(0);
          if (command === "echo hi") return s.write("hi\n"), done(0);
          if (command === "fail") return s.stderr.write("no such thing\n"), done(3);
          if (command === "cat") {
            let got = "";
            s.on("data", (d: Buffer) => (got += d));
            return s.on("end", () => (s.write(got.toUpperCase()), done(0)));
          }
          if (command === "big") return s.write("x".repeat(300 * 1024)), s.stderr.write("y".repeat(10)), done(0);
          if (command === "huge") return s.write("x".repeat(1536 * 1024)), done(0);
          if (command === "nap") return void (seen.open++, (seen.most = Math.max(seen.most, seen.open)), setTimeout(() => (seen.open--, done(0)), 300));
          if (command === "open channels") {
            const tries: [string, (cb: (err: Error | undefined) => void) => void][] = [
              ["forwarded-tcpip", (cb) => client.forwardOut("127.0.0.1", 3001, "127.0.0.1", 50000, (err) => cb(err))],
              ["x11", (cb) => client.x11("127.0.0.1", 6000, (err) => cb(err))],
            ];
            let left = tries.length;
            for (const [name, open] of tries) open((err) => (err && seen.refused.push(name), --left || (s.write("tried\n"), done(0))));
            return;
          }
          if (command === "hang") return void (seen.hung++, client.on("close", () => seen.closed++)); // never ends
        });
      });
    });
  });

const server = standIn(hostKey.private);
// machine.silent: the machine takes the connection and never says its banner, as a port behind a proxy that accepts
// any connection does.
const tcp = (server as unknown as { _srv: net.Server })._srv;
const [greet] = tcp.listeners("connection") as ((sock: net.Socket) => void)[];
tcp.removeAllListeners("connection");
tcp.on("connection", (sock: net.Socket) => (machine.silent ? sock.on("error", () => {}) : greet(sock)));
export const PORT = await listen(server);
const imposter = standIn(otherHostKey.private);
export const IMPOSTER_PORT = await listen(imposter);
test.after(() => (server.close(), imposter.close()));

export const boxState = () => pageState().targets.find((t: { label: string }) => t.label === "box");

/** The line ssh-keygen -lf prints for a host key, as the user pastes it from the setup command. */
export const printed = (pub: string) => `256 ${fingerprint(pub)} root@box (ED25519)`;

/** Adds the machine "box" on the page as the user does: its address and account, the line the setup
 *  command printed, and the page's key the command carried (the spare), unless a key is pasted. The
 *  stand-in accepts that key, as running the command before the save does, unless `ran` is false.
 *  Waits for the try the page makes after a save to end: the sign-in and the look at what it reaches.
 *  127.0.0.1 is a private address by itself, so nothing says it is one. */
export async function register(fields: Record<string, unknown> = {}, pasted?: { private: string; public: string }, base?: string, ran = true) {
  await call({ action: "secret", kind: "ssh", label: "box" });
  const spare = pageState().spare;
  if (pasted) allowed = utils.parseKey(pasted.public) as ssh2.ParsedKey;
  else if (ran) allowed = utils.parseKey(spare) as ssh2.ParsedKey;
  post({ secret: pageConfig().secret, ev: "target-save", label: "box", host: `127.0.0.1:${PORT}`, login: "sandbox", fingerprint: printed(hostKey.public), public: pasted ? "" : spare, sealed: pasted ? seal(pasted.private) : "", ...fields });
  await called({ action: "library" }, { slug: "work", base });
  await until(() => boxState() && !boxState().trying, SIGN_IN_MS + LOOK_MS);
  const saved = boxState();
  if (saved.public) allowed = utils.parseKey(saved.public) as ssh2.ParsedKey;
  return saved;
}

/** A toolkit "ops" on the target "box", with a function that sends kit.ssh.exec what it's given. */
export async function ops() {
  const source = "async function main(input, kit) { return await kit.ssh.exec(Object.assign({ target: 'box' }, input.req)); }";
  const said = await call({ action: "save", service: "ops", toolkit: { title: "Ops", targets: ["box"] }, function: { name: "run", description: "Runs a command.", inputs: { req: { type: "object", required: true } }, source } });
  assert.match(said, /Saved the toolkit ops: target box; keys: none\.\nSaved ops\.run, version 1/);
}

export const result = (said: string) => JSON.parse(said.match(/Result \(JSON\):\n([\s\S]*?)\n\n/)![1]);

test.beforeEach(() => {
  reset();
  Object.assign(seen, { auths: 0, open: 0, most: 0, refused: [], hung: 0, closed: 0, sftpClosed: 0, execs: 0, unanswered: 0, authDelay: 0, fetched: [] });
  Object.assign(machine, { tools: true, serve: () => null, hostname: "vm-1", uid: "1001", sees: false, silent: false });
  (globalThis as unknown as Record<symbol, unknown>)[THISHOST_RECORD] = { fingerprints: [THIS_HOST_FINGERPRINT], addresses: [] };
  failRemove.clear();
  stallRenames.clear();
  files.clear();
  links.clear();
  allowed = null;
  delete process.env.LIBRARY_WAIT_MS;
  delete process.env.LIBRARY_RUN_MS;
});

/** Switches "Scheduled jobs may use it" on (or off) for the machine "box", as the page does. */
export async function letJobs(on = true) {
  post({ secret: pageConfig().secret, ev: "target-unattended", label: "box", on });
  await call({ action: "library" });
  await until(() => boxState().unattended === on);
}

/** A function "file" that makes one kit.ssh call (input.call: "put" or "get") and answers what it got,
 *  a long content as its length. */
export async function fileFn() {
  const source = "async function main(input, kit) { const out = await kit.ssh[input.call](Object.assign({ target: 'box' }, input.req)); return out.content && out.content.length > 2000 ? Object.assign({}, out, { content: out.content.length + ' characters' }) : out; }";
  await call({ action: "save", service: "ops", function: { name: "file", description: "Moves a file.", inputs: { call: { type: "string", required: true }, req: { type: "object", required: true } }, source } });
}
export const file = async (callName: string, req: Record<string, unknown>) => result(await call({ action: "run", name: "ops.file", inputs: { call: callName, req } }));
export const hex = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Runs the "ops.run" function on the target, as the agent does, with `req` for kit.ssh.exec. */
export const exec = (req: Record<string, unknown>) => call({ action: "run", name: "ops.run", inputs: { req } });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// What a target can reach (src/targets.ts looked): tried when it is checked, and once on first use.
export const BASE = "http://anythingllm.test:3001";
export const reachLeft = () => (fs.existsSync(path.join(publicDir, "library-lean")) ? fs.readdirSync(path.join(publicDir, "library-lean")).filter((n) => n.startsWith("reach-")) : []);
/** Registers "box" with a pasted key, so the first sign-in works, and waits for what it reaches to be kept. */
export async function registered(base: string | null = BASE) {
  const box = await register({}, keyPair(), base ?? undefined);
  await until(() => boxState().notes.length > 0 || boxState().barred !== null, LOOK_MS);
  return { ...box, ...boxState() };
}

// This machine, by what is recorded of it (shared/thishost.mts, written by the installer on the host).
export const record = (value: unknown) => ((globalThis as unknown as Record<symbol, unknown>)[THISHOST_RECORD] = value);
export const recordFile = () => path.join(storage, "anywherellm-suite", "this-host.json");
/** Saves a target the page way and answers the refusal the page shows, or null when it was saved,
 *  once the try the page makes after it has ended. */
export async function savedAs(label: string, fields: Record<string, unknown>, base?: string) {
  const n = pageState().result?.n ?? 0;
  post({ secret: pageConfig().secret, ev: "target-save", label, host: `127.0.0.1:${PORT}`, login: "sandbox", fingerprint: printed(hostKey.public), sealed: "", ...fields });
  await called({ action: "library" }, { slug: "work", base });
  await until(() => (pageState().result?.n ?? 0) > n);
  const error = pageState().result.error as string | null;
  if (!error) await until(() => !pageState().targets.find((t: { label: string }) => t.label === label)?.trying, SIGN_IN_MS + LOOK_MS);
  return error;
}

// The owner's exception (this-host --allow): one login at one port on this host is let through.
export const HINT = (account: string) => `The owner can allow a separate account on it: on the host, anywherellm-suite this-host --allow ${account}.`;
