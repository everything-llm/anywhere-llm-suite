// The machines the library's functions run commands on over SSH, which the user adds on the Library
// page, under Machines ("targets" is the agent's word and the code's): each a vault entry of kind
// "ssh" (#shared/vault) holding its host, port and login, the private key it signs in with, and the
// SHA-256 fingerprint of the host key the machine must show. A function names a target and nothing
// else of it (runs.ts), so the key goes to its own machine and nowhere else, and never into a script.
// What a target is (a cloud VM, a Pi, a port this machine forwards) is the user's: the library sees a
// host and a port.
//
// The page's key for the next machine is made before the user adds it (spare), so the one command
// the page shows can carry it: the user runs that command on the machine, as the account, and pastes
// back the host key's fingerprint it prints.
//
// The connection goes through the fence (#shared/net connect). A private address is reached only as
// a target whose address is private by itself (a private IP, or a name that is this network's by its
// name alone: #shared/fence hostRefused), at its own host and port; a name that looks public is
// public, so one that resolves to a private address is refused when it connects. FENCE_ALLOW and the
// origins let through for requests (allowed.json) play no part.
// The client is ssh2 (docs/notes/README.md): public-key sign-in only, no agent, no forwarding, no
// X11, and a channel the machine opens toward us is refused (ssh2 refuses any it didn't ask for).
// Files go over SFTP, the subsystem OpenSSH offers by default.

import { isUtf8 } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, utils, type ClientChannel, type SFTPWrapper } from "ssh2";
import { lastBase, perProcess } from "#shared/anythingllm";
import { NetError, bareHost, hostRefused, lookupAll, portOf } from "#shared/fence";
import { Unreachable, connect, send } from "#shared/net";
import { removePublic, writePublic } from "#shared/pages";
import { OWN_PORTS, alwaysOwn, bare, sshFingerprint, thisHostAddresses, thisHostKeyRefusal, thisHostRefusal, thisHostUsable } from "#shared/thishost";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";
import { countUse } from "./secrets";

const LIMITS = {
  connectMs: 10 * 1000,
  /** How long removing a cut-off upload's part file may take, sign-in included. */
  cleanupMs: 5 * 1000,
  /** How long trying a target may take: signing in (connectMs) and what it can reach. */
  checkMs: 30 * 1000,
  /** A command's time, in seconds as kit.ssh.exec's timeout_s: by default and at most. */
  execS: 30,
  execMaxS: 300,
  outBytes: 256 * 1024,
  outMaxBytes: 1024 * 1024,
  stdinBytes: 1024 * 1024,
  commandChars: 32 * 1024,
  /** Commands going at once on one target, from one process; more wait their turn. */
  perTarget: 4,
  /** How long a stopped command has between TERM and its channel being closed. */
  killMs: 2000,
  /** What kit.ssh.put writes, and kit.ssh.get reads, in one call. */
  fileBytes: 1024 * 1024,
};

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const LOGIN = /^[a-z_][a-z0-9_.-]{0,31}$/i;
// Exactly 43 characters: a longer run is a mistyped fingerprint, not one with something after it.
const FINGERPRINT = /SHA256:[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/])/;

/** Why the last try didn't sign in, as the page tells it: the key refused, another host key, this
 *  machine, an address the fence refuses, no answer, or anything else (its status says what). */
export type Problem = "key" | "host-key" | "this-machine" | "fenced" | "unreachable" | "failed";

/** A refusal of what the user gave on the page, in the user's words, with the field it concerns
 *  (null: the form as a whole). Only the page saves a target, so these go only to the page. */
export class Refused extends LibraryError {
  readonly field: "label" | "host" | "login" | "fingerprint" | "key" | "command" | null;
  constructor(message: string, field: Refused["field"]) {
    super(message);
    this.field = field;
  }
}

/** A sign-in that failed, and why, as the page tells it. */
class SignInError extends LibraryError {
  readonly problem: Problem;
  constructor(message: string, problem: Problem) {
    super(message);
    this.problem = problem;
  }
}

/** A target as the agent and the page see it: never its key. */
export interface Target {
  label: string;
  host: string;
  port: number;
  login: string;
  fingerprint: string;
  /** Whether its address is private by itself (#shared/fence hostRefused), so the fence lets it through. */
  private: boolean;
  /** Whether scheduled jobs may use it. */
  unattended: boolean;
  /** The public half of a key made on the page, for the machine's authorized_keys; null for a pasted one. */
  public: string | null;
  /** How the last try went: "signed in", or why not; "not tried yet". */
  status: string;
  /** Why the last try didn't sign in, for the page; null when it did, or wasn't tried. */
  problem: Problem | null;
  /** Whether a try is going: from a save or a "Try again" until it ends. */
  trying: boolean;
  /** Why it isn't used (it reaches this AnythingLLM's pages, or is this machine's account), or null. */
  barred: string | null;
  /** What the last try found that the user should know, short sentences. */
  notes: string[];
}

interface Entry extends vault.Entry {
  kind: "ssh";
  port: number;
  login: string;
  key: string;
  fingerprint: string;
  private: boolean;
  unattended: boolean;
  public: string | null;
  status: string | null;
  problem?: Problem | null;
  barred: string | null;
  notes: string[];
  /** Whether what the machine reaches was looked at (check) since it was saved. */
  probed: boolean;
  /** When a try was asked for, and when the last one ended (ms). */
  since?: number;
  tried?: number;
}

const named = (label: string) => (e: Readonly<vault.Entry>): e is Entry => e.kind === "ssh" && e.user === label;
const found = (label: string) => vault.entries().find(named(label));
const shown = (e: Readonly<Entry>): Target => ({
  label: e.user,
  host: e.site,
  port: e.port,
  login: e.login,
  fingerprint: e.fingerprint,
  private: e.private,
  unattended: e.unattended,
  public: e.public,
  status: e.status ?? "not tried yet",
  problem: e.status && e.status !== "signed in" ? (e.problem ?? "failed") : null,
  // Not for ever: a try ends within checkMs, and one cut off by a restart says nothing.
  trying: (e.since ?? 0) > (e.tried ?? 0) && Date.now() - e.since! < 2 * LIMITS.checkMs,
  barred: e.barred,
  notes: e.notes,
});

/** A target's name, checked. */
export function nameOf(raw: unknown): string {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!NAME.test(name)) throw new LibraryError('a target is named in lower-case letters, digits and -, 2 to 31 of them, starting with a letter, like "pi" or "build-vm"');
  return name;
}

/** The saved targets, without their keys. */
export const targets = (): Target[] => vault.entries().filter((e): e is Entry => e.kind === "ssh").map(shown);

/** A target as the user gives it on the page; `key` is a pasted private key, opened from its seal,
 *  or empty to keep the one saved (or, for a new target, make one). */
export interface Given {
  label: unknown;
  host: unknown;
  port: unknown;
  login: unknown;
  fingerprint: unknown;
  unattended: unknown;
  /** The page's key the setup command carried ("ssh-ed25519 AAAA…"), or empty: a target's own, kept,
   *  or the spare. */
  public?: unknown;
  key: string;
}

/** The sealed file beside the vault that holds the spare: the page's key for the next machine. */
const SPARE = "library-ssh-spare";

interface Spare {
  private: string;
  public: string;
}

const spareKept = (): Spare | null => {
  const kept = vault.readSealed(SPARE) as Spare | null;
  return kept && typeof kept.private === "string" && typeof kept.public === "string" ? kept : null;
};

/** A new ed25519 key pair for signing in to a machine. */
const made = (): Spare => {
  const pair = utils.generateKeyPairSync("ed25519", { comment: "library-lean" });
  return { private: pair.private, public: pair.public.trim() };
};

/** The public half of the page's key for the next machine ("ssh-ed25519 AAAA… library-lean"), made
 *  the first time it's asked for and kept, sealed beside the vault, until a save takes it: the page
 *  shows it in the setup command before the machine is saved. */
export function spare(): string {
  const kept = spareKept();
  if (kept) return kept.public;
  const fresh = made();
  vault.writeSealed(SPARE, fresh);
  return fresh.public;
}

/** A public key line's key ("AAAA…"), to compare: its type and comment aside. */
const keyBody = (line: unknown): string => String(line ?? "").trim().split(/\s+/)[1] ?? "";

/** The host and port of an address the user typed: a name or an address, with ":port" when it isn't
 *  22 ("[v6]:port" for IPv6). `port` is a port given apart, for an address without one. */
export function addressOf(rawHost: unknown, rawPort: unknown = ""): { host: string; port: number } {
  let host = String(rawHost ?? "").trim().toLowerCase();
  let port = String(rawPort ?? "").trim();
  const v6 = host.match(/^\[([^\]]*)\](?::(.*))?$/);
  if (v6) [host, port] = [v6[1], v6[2] || port];
  else if (/^[^:]*:[^:]*$/.test(host)) [host, port] = [host.split(":")[0], host.split(":")[1] || port];
  if (!(HOST.test(host) || net.isIP(host))) throw new Refused("Give a name or an address, like build.example.net or 192.168.1.20, with :port after it if it isn’t 22.", "host");
  const n = Number(port || 22);
  if (!/^\d*$/.test(port) || !Number.isInteger(n) || n < 1 || n > 65535) throw new Refused("The port after the : is a number from 1 to 65535.", "host");
  return { host, port: n };
}

/** Why `host` is this machine, or null: a literal address is checked as it is, a name by what it
 *  resolves to now (a try, since a name can answer otherwise later: connecting checks the address it
 *  goes to). */
async function thisMachine(host: string): Promise<string | null> {
  if (net.isIP(host)) return thisHostRefusal(host);
  for (const a of (await lookupAll(host, 3000)) ?? []) {
    const why = thisHostRefusal(a);
    if (why) return `${host} resolves to ${why}`;
  }
  return null;
}

/** Saves a target; its name. What the user gave is checked first, each refusal in the user's words
 *  for the field it concerns (Refused). The key is the one the user pasted; or the target's own, kept
 *  when it stays at the same host, port and account; or the page's spare, which the setup command
 *  carried (`public` says which the page showed: one that is neither is refused, since the machine
 *  was given another key). */
export async function save(given: Given): Promise<string> {
  const label = String(given.label ?? "").trim().toLowerCase();
  if (!NAME.test(label)) throw new Refused("A name is 2 to 31 lower-case letters, digits and -, starting with a letter, like pi or build-box.", "label");
  const { host, port } = addressOf(given.host, given.port);
  const login = String(given.login ?? "").trim();
  if (!LOGIN.test(login)) throw new Refused("Give the account to sign in as, like pi.", "login");
  const fingerprint = String(given.fingerprint ?? "").match(FINGERPRINT)?.[0];
  if (!fingerprint) throw new Refused("That line has no SHA256 fingerprint. Paste the whole line the command printed, like 256 SHA256:… root@pi (ED25519).", "fingerprint");
  // Without a record of this machine (the installer writes it) nothing can be told from it: no target.
  if (!thisHostUsable().ok) throw new Refused("No machine can be added yet: this AnythingLLM’s own machine isn’t recorded, so no other can be told from it. Run the installer on the host, as its README says.", null);
  if (thisHostKeyRefusal(fingerprint)) throw new Refused("That’s the machine AnythingLLM runs on. Add a different machine.", "fingerprint");
  // The address tells a private one: an address outside the public internet, or a name that is this
  // network's by its name alone. The fence lets that host through for this target, and nothing else.
  const why = hostRefused(host, new Set());
  const onNetwork = why !== null && why !== "lookup";
  if (await thisMachine(host)) throw new Refused(net.isIP(host) ? "That’s an address of the machine AnythingLLM runs on. Add a different machine." : `${host} leads to the machine AnythingLLM runs on. Add a different machine.`, "host");
  const was = found(label);
  const samePlace = !!was && was.site === host && was.port === port && was.login === login;
  const shown = keyBody(given.public);
  let key = given.key.trim();
  let pub: string | null = null;
  let taken = false;
  if (key) {
    // No passphrase: the vault keeps the key encrypted already, and opening one on every connect
    // costs about 0.4 s of pure-JavaScript bcrypt.
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) throw new Refused("That isn’t a private key ssh can sign in with. It needs no passphrase: ssh-keygen -p -N \"\" -f <file> removes one.", "key");
    key = `${key}\n`;
  } else if (samePlace && (!shown || shown === keyBody(was.public))) [key, pub] = [was.key, was.public];
  else {
    // A new target, or one moved to another host, port or account: the saved key doesn't follow it
    // (an edit must not aim the user's key at another machine). It takes the spare, whose public line
    // the setup command put in the account's authorized_keys.
    const spared = spareKept();
    if (shown && shown !== keyBody(spared?.public)) throw new Refused("This command’s key was used for another machine. Copy the command again and run it on the machine.", "command");
    const use = spared ?? made();
    [key, pub, taken] = [use.private, `${use.public.split(/\s+/).slice(0, 2).join(" ")} library-lean ${label}`, !!spared];
  }
  // Scheduled jobs keep what they had at the same place, unless the user says otherwise.
  const unattended = given.unattended === undefined ? samePlace && was.unattended : given.unattended === true;
  const entry = { kind: "ssh" as const, site: host, user: label, port, login, key, fingerprint, private: onNetwork, unattended, public: pub, status: null, problem: null, barred: null, notes: [], probed: false, since: Date.now() };
  await vault.update((v) => {
    const at = v.entries.findIndex(named(label));
    if (at >= 0) v.entries[at] = { id: v.entries[at].id, ...entry };
    else v.entries.push({ id: vault.newId(), ...entry });
  });
  if (taken) vault.writeSealed(SPARE, null); // the next machine gets a key of its own
  return label;
}

/** Marks a target as being tried, for the page: a save does, and "Try again". */
export const trying = (label: string): Promise<void> => patch(label, { since: Date.now() });

/** Lets scheduled jobs use a target, or not: the page's "Scheduled jobs may use it". */
export const setUnattended = (label: string, on: boolean): Promise<void> => patch(label, { unattended: on });

/** Deletes a target and its key; whether there was one. */
export const remove = (label: string): Promise<boolean> =>
  vault.update((v) => {
    const before = v.entries.length;
    const is = named(label);
    v.entries = v.entries.filter((e) => !is(e));
    return v.entries.length < before;
  });

/** An address a fixed command can carry safely: scheme, host (or [IPv6]) and port, nothing else. */
const ADDRESS = /^https?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i;

/** What looking at a target's reach found: why it is barred (or null), and what the user should know. */
interface Found {
  barred: string | null;
  notes: string[];
  /** Whether its reach of AnythingLLM was looked at: not without AnythingLLM's address. */
  probed: boolean;
}

const quoted = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const MAX_PROBES = 40;

/** What a machine is asked to fetch `rel` from: AnythingLLM's own address as it is given (ANYTHINGLLM_URL),
 *  and each of this host's recorded addresses on OWN_PORTS (the host, reached from another machine
 *  on the network, shows one of them). Each is checked against ADDRESS, so a fixed command can
 *  carry it. */
function probes(base: string | null, rel: string): string[] {
  const urls = new Set<string>();
  if (base && ADDRESS.test(base)) urls.add(`${base}/${rel}`);
  for (const raw of thisHostAddresses()) {
    // Only an address a machine could reach this one by: not a loopback, link-local or unspecified
    // one, which on the machine means itself.
    const a = bare(raw);
    if (!net.isIP(a) || alwaysOwn(a)) continue;
    for (const port of OWN_PORTS) {
      const origin = `${port === 443 ? "https" : "http"}://${net.isIP(a) === 6 ? `[${a}]` : a}:${port}`;
      if (ADDRESS.test(origin)) urls.add(`${origin}/${rel}`);
    }
  }
  return [...urls].slice(0, MAX_PROBES);
}

/** Which pages of this AnythingLLM the machine can fetch: a random token is put in a file in the
 *  library page's folder, and the machine is asked, with one fixed command (curl or wget, every address
 *  at the same time, 3 s each), to read it from each address AnythingLLM may be at (`probes`). Only a
 *  page that answers with the token is a hit: another service answering on that port isn't. The
 *  addresses it fetched, or why it couldn't be told. */
async function reaches(client: Client, base: string | null, until: number, signal?: AbortSignal): Promise<{ hits: string[] } | { why: string }> {
  const rel = `library-lean/reach-${crypto.randomBytes(8).toString("hex")}.txt`;
  const token = crypto.randomBytes(16).toString("hex");
  const urls = probes(base, rel);
  if (!urls.length) return { hits: [] };
  try {
    writePublic(rel, token);
    const fetch = `if command -v curl >/dev/null 2>&1; then o=$(curl -fsS -k -m 3 "$1" 2>/dev/null); elif command -v wget >/dev/null 2>&1; then o=$(wget -qO- --no-check-certificate -T 3 "$1" 2>/dev/null); else echo NOTOOL; return; fi; [ "$o" = "${token}" ] && echo "HIT $1"`;
    const script = `p() { ${fetch}; }; ${urls.map((u) => `p ${quoted(u)} &`).join(" ")} wait`;
    const ran = await run(client, `sh -c ${quoted(script)}`, "", 8192, until, signal);
    if (ran.killed) return { why: "its time ran out" };
    const lines = ran.stdout.split("\n").map((l) => l.trim());
    if (lines.includes("NOTOOL")) return { why: "it has neither curl nor wget" };
    return { hits: lines.flatMap((l) => (l.startsWith("HIT ") && urls.includes(l.slice(4)) ? [l.slice(4)] : [])) };
  } catch (e) {
    return { why: (e as Error).message };
  } finally {
    try {
      removePublic(rel);
    } catch {}
  }
}

/** `host:port` of an address a machine fetched a page from. */
const hostPort = (url: string): string => {
  const u = new URL(url);
  return `${u.hostname}:${portOf(u)}`;
};

/** Why the machine is this one's own, or what it can see of its storage; null when neither shows. A
 *  marker file in the vault's folder is looked for over SFTP at the storage's path here and in the
 *  container image, and the machine's hostname and user are compared with this one's. */
async function ownsStorage(client: Client, until: number, signal?: AbortSignal): Promise<string | null> {
  const marker = `.reach-marker-${crypto.randomBytes(8).toString("hex")}`;
  const here = path.join(vault.vaultDir(), marker);
  fs.writeFileSync(here, "x", { mode: 0o600 });
  try {
    const sftp = await asked<SFTPWrapper>("start SFTP", (cb) => client.sftp(cb)).catch(() => null);
    for (const at of new Set([here, path.posix.join("/app/server/storage/vault-lean", marker)])) {
      if (sftp && (await asked(`stat ${at}`, (cb) => sftp.stat(at, cb)).then(() => true, () => false))) return `it can see AnythingLLM's storage (${path.dirname(at)})`;
    }
  } finally {
    fs.rmSync(here, { force: true });
  }
  const who = await run(client, "hostname; id -u", "", 1024, until, signal);
  const [host, uid] = who.stdout.trim().split("\n");
  if (host === os.hostname() && typeof process.getuid === "function" && Number(uid) === process.getuid()) return `it is this machine's own account (hostname ${host}, user ${uid})`;
  return null;
}

/** AnythingLLM without a password, from its own unauthenticated answer; false when it can't tell. */
async function openToAll(base: string): Promise<boolean> {
  try {
    const host = bareHost(new URL(base));
    const answer = await send({ url: `${base}/api/setup-complete`, allow: [host], timeout: 5000, maxBytes: 64 * 1024 });
    const body = JSON.parse(answer.body.toString("utf8"));
    const r = body?.results ?? body;
    return r?.RequiresAuth === false && r?.MultiUserMode !== true;
  } catch {
    return false;
  }
}

/** What a signed-in target can reach, and what the user should know about the setup. */
async function looked(client: Client, base: string | null, until: number, signal?: AbortSignal): Promise<Found> {
  const found: Found = { barred: null, notes: [], probed: false };
  const own = await ownsStorage(client, until, signal).catch((e: Error) => {
    found.notes.push(`couldn't tell whether it sees AnythingLLM's storage or is this account: ${e.message}`);
    return null;
  });
  if (own) found.barred = `${own}, which holds the vault and the pages' secrets. Use another machine or account`;
  const known = Boolean(base && ADDRESS.test(base));
  found.probed = known;
  const reach = await reaches(client, known ? base : null, until, signal);
  if ("why" in reach) found.notes.push(`couldn't tell whether it reaches this AnythingLLM: ${reach.why}`);
  else if (reach.hits.length) {
    const where = [...new Set(reach.hits.map(hostPort))].join(", ");
    found.barred ??= `it can fetch this AnythingLLM's pages (at ${where}), which carry the page secret. Change the machine's firewall (or the tailnet's access rules) so it can't reach ${where}, then try it again`;
  }
  if (!known) found.notes.push("this AnythingLLM's own address isn't known here (ANYTHINGLLM_URL): the machine was tried only at this host's recorded addresses");
  else if (await openToAll(base!)) found.notes.push("this AnythingLLM has no password: whoever reaches it is its administrator");
  if (!process.env.VAULT_KEY_FILE) found.notes.push("the vault's key is kept beside the vault (VAULT_KEY_FILE isn't set): a machine that can read AnythingLLM's storage reads every key");
  return found;
}

/** Keeps what was learned of a target, for the page and the agent to see: how signing in went
 *  (`status`), or what looking at it found. */
const patch = (label: string, fields: Partial<Pick<Entry, "status" | "problem" | "barred" | "notes" | "probed" | "since" | "tried" | "unattended">>): Promise<void> =>
  vault.update((v) => {
    const now = v.entries.find(named(label));
    if (now) Object.assign(now, fields);
  });

/** Signs in to a target once, without running anything else but what shows what it can reach, and
 *  keeps how it went for the page and the agent to see. It counts as a use, with the rate and
 *  slots of one. `base` is AnythingLLM's own address, when known. The sign-in is kept as soon as it is
 *  known: looking at what the machine reaches takes longer (several commands, and a request to
 *  AnythingLLM), and neither the page nor the agent waits on it to know the key works. */
export async function check(label: string, base: string | null = null): Promise<void> {
  if (!found(label)) return;
  let seen: Found | null = null;
  let signedIn = false;
  try {
    const until = Date.now() + LIMITS.checkMs;
    await withTarget(
      label,
      { deadline: until, job: false },
      until,
      async (client) => {
        await patch(label, { status: "signed in", problem: null });
        signedIn = true;
        seen = await looked(client, base ?? lastBase(), until);
      },
      true,
    );
  } catch (err) {
    if (!(err instanceof NetError || err instanceof LibraryError)) {
      await patch(label, { status: "couldn't try signing in (see the log)", problem: "failed", tried: Date.now() });
      throw err;
    }
    if (!signedIn) await patch(label, { status: err.message, problem: problemOf(err) });
    else seen = { barred: null, notes: [`couldn't finish looking at what it reaches: ${err.message}`], probed: false };
  }
  await patch(label, { ...seen, tried: Date.now() });
}

/** Why a sign-in failed, as the page tells it. */
const problemOf = (err: Error): Problem => (err instanceof SignInError ? err.problem : err instanceof Unreachable ? "unreachable" : err instanceof NetError ? "fenced" : "failed");

/** A turn at one of a target's command slots: waits for one to free up, at most until `until`. */
async function turn(label: string, until: number, signal?: AbortSignal): Promise<() => void> {
  const going = perProcess("library-lean.ssh-going", () => new Map<string, number>());
  while ((going.get(label) ?? 0) >= LIMITS.perTarget) {
    if (Date.now() >= until || signal?.aborted) throw new LibraryError(`the target "${label}" has ${LIMITS.perTarget} commands going already: try again when one ends`);
    await new Promise((r) => setTimeout(r, 50));
  }
  going.set(label, (going.get(label) ?? 0) + 1);
  return () => going.set(label, going.get(label)! - 1);
}

/** A signed-in connection to the target `e`, by `until`: its host key checked against the pinned
 *  fingerprint before anything else is said. The connecting and the signing in share that time, and
 *  none of it is waited for once it has passed. */
async function open(e: Readonly<Entry>, until: number, signal?: AbortSignal): Promise<Client> {
  const label = e.user;
  const outOfTime = () => new SignInError(`the target "${label}" (${e.site}:${e.port}) wasn't signed in to in time: the call's time ran out first`, "unreachable");
  const left = () => Math.min(LIMITS.connectMs, until - Date.now());
  const usable = thisHostUsable();
  if (!usable.ok) throw new LibraryError(usable.reason);
  if (left() <= 0) throw outOfTime();
  let mine = false; // whether the fence refused an address of this machine's
  const refuse = (a: string) => {
    const why = thisHostRefusal(a);
    mine ||= why !== null;
    return why;
  };
  const sock = await connect({ host: e.site, port: e.port, allow: e.private ? [e.site] : [], timeout: left(), signal, refuse }).catch((err: Error) => {
    throw mine ? new SignInError(err.message, "this-machine") : err;
  });
  const timeout = left();
  if (timeout <= 0) {
    sock.destroy();
    throw outOfTime();
  }
  const client = new Client();
  let seen = "";
  let ownKey: string | null = null;
  return new Promise((resolve, reject) => {
    // Until it's signed in, a stop ends the connection; after, the command's own stop does (run).
    const onAbort = () => failed(new Error("the run stopped"));
    const failed = (err: Error & { level?: string }) => {
      signal?.removeEventListener("abort", onAbort);
      client.end();
      sock.destroy();
      if (ownKey) return reject(new SignInError(`the target "${label}" (${e.site}:${e.port}) is this machine: ${ownKey}. Nothing was sent`, "this-machine"));
      if (seen && seen !== e.fingerprint) return reject(new SignInError(`the target "${label}" showed a host key that isn't the one saved for it (saved ${e.fingerprint}, shown ${seen}): nothing was sent. If the machine was rebuilt, the user sets it up again on the Library page, under Machines`, "host-key"));
      if (err.level === "client-authentication") return reject(new SignInError(`the target "${label}" refused its key: the user runs the setup command the Library page shows under Machines on the machine, as ${e.login}, then tries again`, "key"));
      if (err.level === "client-timeout") return reject(new SignInError(`the target "${label}" (${e.site}:${e.port}) didn't finish signing in within ${Math.ceil(timeout / 1000)} s`, "unreachable"));
      reject(new SignInError(`the target "${label}" (${e.site}:${e.port}) couldn't be reached: ${err.message}`, "unreachable"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    client.once("ready", () => {
      signal?.removeEventListener("abort", onAbort);
      // After sign-in a dropped connection ends the command's channel; its error needs a listener, or it is uncaught.
      client.on("error", () => {});
      resolve(client);
    });
    client.once("error", failed);
    client.connect({ sock, username: e.login, privateKey: e.key, readyTimeout: timeout, hostVerifier: (key: Buffer) => ((seen = sshFingerprint(key)), (ownKey = thisHostKeyRefusal(seen)), !ownKey && seen === e.fingerprint) });
  });
}

export interface Ran {
  exit: number | null;
  /** The signal it ended by, as ssh2 names it ("SIGTERM"); null when it exited. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Whether either stream was longer than max_bytes, and cut there. */
  truncated: boolean;
  /** Why the command was stopped: "timeout" or "stopped" (the run was); null when it ended. */
  killed: "timeout" | "stopped" | null;
  /** Whether a stopped command may still be going on the machine: it sent no exit status. */
  remote_may_run: boolean;
  ms: number;
}

const bounded = (v: unknown, fallback: number, max: number, what: string): number => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new LibraryError(`${what} is a positive number`);
  return Math.min(n, max);
};

/** How a call uses a target: by when it must end, whether it's a scheduled job's (which uses only a
 *  target the user said it may), and the run's stop. */
export interface Use {
  deadline: number;
  job: boolean;
  signal?: AbortSignal;
}

/** Runs `use` on a signed-in connection to the target `label`, ended after: the target's own checks
 *  (saved; unattended only when ticked), its rate and its slots, by `until`. */
async function withTarget<T>(label: string, { job, signal }: Use, until: number, use: (client: Client) => Promise<T>, checking = false): Promise<T> {
  const e = found(label);
  if (!e) throw new LibraryError(`no target "${label}" is saved: ask the user for it with secret, kind "ssh"`);
  if (e.barred && !checking) throw new LibraryError(`the target "${label}" isn't used: ${e.barred}`);
  if (job && !e.unattended) throw new LibraryError(`scheduled jobs don't use the target "${label}": the user switches on "Scheduled jobs may use it" for it on the Library page, under Machines`);
  countUse("library-lean.ssh-uses", e.id, (max) => `the target "${label}" was used ${max} times in the last minute: wait a minute, and do more in each command`);
  const done = await turn(label, until, signal);
  try {
    const client = await open(e, until, signal);
    try {
      // The first use since it was saved looks at what it reaches too, when AnythingLLM's address is known.
      if (!checking && !e.probed && lastBase()) {
        const seen = await looked(client, lastBase(), until, signal);
        await patch(label, seen);
        if (seen.barred) throw new LibraryError(`the target "${label}" isn't used: ${seen.barred}`);
      }
      return await use(client);
    } finally {
      client.end();
    }
  } finally {
    done();
  }
}

/** Runs `command` on the target `label`, by the run's deadline at the latest; a stopped run stops it. */
export async function exec(label: string, req: Record<string, unknown>, use: Use): Promise<Ran> {
  const command = typeof req.command === "string" ? req.command : "";
  if (!command.trim() || command.length > LIMITS.commandChars || command.includes("\0")) throw new LibraryError(`kit.ssh.exec needs command, one line or a script of at most ${LIMITS.commandChars} characters`);
  if (req.stdin !== undefined && typeof req.stdin !== "string") throw new LibraryError("stdin is text");
  const stdin = (req.stdin as string | undefined) ?? "";
  if (Buffer.byteLength(stdin) > LIMITS.stdinBytes) throw new LibraryError(`stdin is at most ${LIMITS.stdinBytes / 1024 / 1024} MB`);
  const until = Math.min(Date.now() + bounded(req.timeout_s, LIMITS.execS, LIMITS.execMaxS, "timeout_s") * 1000, use.deadline);
  const max = Math.floor(bounded(req.max_bytes, LIMITS.outBytes, LIMITS.outMaxBytes, "max_bytes"));
  const t0 = Date.now();
  return withTarget(label, use, until, async (client) => ({ ...(await run(client, command, stdin, max, until, use.signal)), ms: Date.now() - t0 }));
}

/** A path on the machine as the account sees it; one starting "~/" is under its home, as a relative
 *  one is (SFTP starts there). */
function pathOf(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 4096 || text.includes("\0")) throw new LibraryError("a file on the target needs path, like \"report.csv\" or \"/tmp/job/out.txt\"");
  return text === "~" ? "." : text.replace(/^~\//, "");
}

const encodingOf = (v: unknown): "utf8" | "base64" => {
  if (v === undefined || v === null || v === "" || v === "utf8" || v === "utf-8") return "utf8";
  if (v === "base64") return "base64";
  throw new LibraryError('encoding is "utf8" or "base64"');
};

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

/** One SFTP request as a promise; its failure said with what it was doing. */
const asked = <T,>(what: string, ask: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => ask((err, value) => (err ? reject(new LibraryError(`the target couldn't ${what}: ${err.message}`)) : resolve(value as T))));

/** `work` on SFTP to the target `label`, with the default command time: ended, and its connection
 *  with it, when that passes or the run stops, since a transfer has no TERM to send. */
function withSftp<T>(label: string, use: Use, work: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const until = Math.min(Date.now() + LIMITS.execS * 1000, use.deadline);
  return withTarget(label, use, until, (client) => {
    let end: (why: string) => void = () => {};
    const ended = new Promise<never>((_, reject) => (end = (why) => (client.end(), reject(new Ended(`the transfer ended: ${why}`)))));
    const timer = setTimeout(() => end("its time ran out"), Math.max(0, until - Date.now()));
    const onAbort = () => end("the run stopped");
    use.signal?.addEventListener("abort", onAbort, { once: true });
    if (use.signal?.aborted) onAbort();
    const sftp = asked<SFTPWrapper>("start SFTP (does its sshd offer it?)", (cb) => client.sftp(cb));
    return Promise.race([sftp.then(work), ended]).finally(() => (clearTimeout(timer), use.signal?.removeEventListener("abort", onAbort)));
  });
}

/** A transfer cut off by its time or a stop: its connection is gone with it. */
class Ended extends LibraryError {}

/** A failed move whose new content is still in its part file: that's kept, and said where. */
class Kept extends LibraryError {}

/** Moves `from` over `to`: in one step with OpenSSH's posix-rename. On a server without it, a plain
 *  rename, which won't replace a file, so when `to` is there it's removed first (`removed` says it
 *  may be gone: from the request until it fails); if the move then fails, `from` stays (Kept), since
 *  it holds the only copy. */
async function moveOver(sftp: SFTPWrapper, from: string, to: string, removed: { yes: boolean }): Promise<void> {
  const what = `move ${from} to ${to}`;
  try {
    return await asked(what, (cb) => sftp.ext_openssh_rename(from, to, cb));
  } catch (e) {
    if (e instanceof LibraryError) throw e; // posix-rename is there, and the move failed
  }
  if (await asked(what, (cb) => sftp.rename(from, to, cb)).then(() => true, () => false)) return;
  removed.yes = true;
  await asked(`remove ${to}`, (cb) => sftp.unlink(to, cb)).catch(() => (removed.yes = false));
  await asked(what, (cb) => sftp.rename(from, to, cb)).catch((e) => {
    throw new Kept(`${e.message}; the new content is kept at ${from}`);
  });
}

/** Writes `content` to `path` on the target `label`: whole, through a temporary file moved over it,
 *  or added to its end with `append`; at most LIMITS.fileBytes a call. `sha256` is of what it wrote. */
export async function put(label: string, req: Record<string, unknown>, use: Use): Promise<{ path: string; size: number; sha256: string }> {
  const path = pathOf(req.path);
  if (typeof req.content !== "string") throw new LibraryError('kit.ssh.put needs content, text (or bytes as base64, with encoding "base64")');
  const encoding = encodingOf(req.encoding);
  if (encoding === "base64" && !/^[A-Za-z0-9+/=\s]*$/.test(req.content)) throw new LibraryError("content isn't base64");
  const bytes = Buffer.from(req.content, encoding);
  if (bytes.length > LIMITS.fileBytes) throw new LibraryError(`kit.ssh.put writes at most ${LIMITS.fileBytes / 1024 / 1024} MB a call: send a bigger file in parts, the first whole and the rest with append`);
  const mode = req.mode === undefined || req.mode === null ? null : String(req.mode);
  if (mode !== null && !/^[0-7]{3,4}$/.test(mode)) throw new LibraryError('mode is octal, like "644" or "755"');
  const append = req.append === true;
  let part: string | null = null;
  const removed = { yes: false };
  try {
    return await withSftp(label, use, async (sftp) => {
      // A whole file goes over what the path leads to (a symlink stays one), keeping its mode unless one is given.
      const [real, was] = append ? [path, null] : await Promise.all([
        asked<string>(`resolve ${path}`, (cb) => sftp.realpath(path, cb)).catch(() => path),
        mode === null ? asked<{ mode: number }>(`stat ${path}`, (cb) => sftp.stat(path, cb)).then((a) => a.mode & 0o7777, () => null) : null,
      ]);
      const perm = mode ?? was;
      const to = append ? path : (part = `${real}.part-${crypto.randomBytes(4).toString("hex")}`);
      let size = bytes.length;
      try {
        const handle = await asked<Buffer>(`open ${to}`, (cb) => sftp.open(to, append ? "a" : "w", cb));
        try {
          // ssh2 splits a write into requests as big as the server takes (254 KB for OpenSSH).
          await asked(`write ${to}`, (cb) => sftp.write(handle, bytes, 0, bytes.length, 0, cb));
          if (perm !== null) await asked(`set the mode of ${to}`, (cb) => sftp.fchmod(handle, perm, cb));
          if (append) size = (await asked<{ size: number }>(`stat ${to}`, (cb) => sftp.fstat(handle, cb))).size;
        } finally {
          await asked(`close ${to}`, (cb) => sftp.close(handle, cb));
        }
        if (!append) await moveOver(sftp, to, real, removed);
      } catch (e) {
        if (!append && !removed.yes && !(e instanceof Kept)) await asked(`remove ${to}`, (cb) => sftp.unlink(to, cb)).catch(() => {});
        throw e;
      }
      return { path, size, sha256: sha256(bytes) };
    });
  } catch (e) {
    // A transfer cut off has no connection left to remove its part file on: one is opened for that,
    // unless the old file is gone already, and the part file then holds the only copy.
    if (e instanceof Ended && part) {
      if (!removed.yes) await unlinkAfter(label, part);
      else throw new Kept(`${e.message}; the new content may be kept at ${part}`);
    }
    throw e;
  }
}

/** Removes `path` on the target `label` over a connection of its own, as well as that can be done
 *  in a few seconds; nothing says if it couldn't. */
const unlinkAfter = (label: string, path: string): Promise<void> =>
  withSftp(label, { deadline: Date.now() + LIMITS.cleanupMs, job: false }, (sftp) => asked<void>(`remove ${path}`, (cb) => sftp.unlink(path, cb))).catch(() => {});

/** How much of `page` ends on a UTF-8 character: all of it, unless a cut of up to 3 bytes off its end
 *  makes valid text of it (it ended inside a character). */
function whole(page: Buffer): number {
  if (isUtf8(page)) return page.length;
  for (let cut = 1; cut <= Math.min(3, page.length - 1); cut++) if (isUtf8(page.subarray(0, page.length - cut))) return page.length - cut;
  return page.length;
}

/** Reads a page of `path` on the target `label`: up to `bytes` (LIMITS.fileBytes) from `offset`, as
 *  text when it's UTF-8 and base64 when it isn't (or when asked); a text page ends on a character, so
 *  it may be a few bytes short of `bytes`. `sha256` is of the page, so a whole file read at once
 *  (offset 0, eof) gives the file's own. */
export async function get(label: string, req: Record<string, unknown>, use: Use): Promise<{ content: string; encoding: "utf8" | "base64"; size: number; sha256: string; eof: boolean }> {
  const path = pathOf(req.path);
  const offset = req.offset === undefined || req.offset === null ? 0 : Number(req.offset);
  if (!Number.isInteger(offset) || offset < 0) throw new LibraryError("offset is a whole number of bytes, 0 or more");
  const want = Math.floor(bounded(req.bytes, LIMITS.fileBytes, LIMITS.fileBytes, "bytes"));
  const base64 = encodingOf(req.encoding) === "base64";
  return withSftp(label, use, async (sftp) => {
    const handle = await asked<Buffer>(`open ${path}`, (cb) => sftp.open(path, "r", cb));
    try {
      const size = (await asked<{ size: number }>(`stat ${path}`, (cb) => sftp.fstat(handle, cb))).size;
      let page = Buffer.alloc(Math.max(0, Math.min(want, size - offset)));
      // ssh2 splits a read as it does a write; it answers how much it read in all.
      if (page.length) page = page.subarray(0, await asked<number>(`read ${path}`, (cb) => sftp.read(handle, page, 0, page.length, offset, cb)));
      // A page that ends inside a character is cut before it, so every page of a text file is text:
      // the next starts at offset plus the bytes of this one's content.
      if (!base64 && offset + page.length < size) page = page.subarray(0, whole(page));
      const text = !base64 && isUtf8(page);
      return { content: page.toString(text ? "utf8" : "base64"), encoding: text ? "utf8" : "base64", size, sha256: sha256(page), eof: offset + page.length >= size };
    } finally {
      await asked(`close ${path}`, (cb) => sftp.close(handle, cb)).catch(() => {});
    }
  });
}

/** Sends the command TERM. ssh2's own stream.signal sends nothing once our side is ended, and it is
 *  as soon as stdin is sent, so the request goes through its protocol (ssh2 is pinned exactly; a
 *  test checks these internals are there, and the e2e that OpenSSH acts on it). */
function term(stream: ClientChannel): void {
  const channel = stream as unknown as { outgoing?: { id: number; state: string }; _client?: { _protocol?: { signal(id: number, name: string): void } } };
  if (channel.outgoing && ["open", "eof"].includes(channel.outgoing.state)) channel._client?._protocol?.signal(channel.outgoing.id, "TERM");
}

/** The command on a signed-in connection, to its end or until it's stopped. Its time and the run's
 *  stop count from before the machine is asked to run it: a machine that never answers that request
 *  ends it as one that never ends the command does. Once the time is up, or the run stopped, nothing
 *  more is sent. */
function run(client: Client, command: string, stdin: string, max: number, until: number, signal: AbortSignal | undefined): Promise<Omit<Ran, "ms">> {
  const unsent = (killed: "timeout" | "stopped"): Omit<Ran, "ms"> => ({ exit: null, signal: null, stdout: "", stderr: "", truncated: false, killed, remote_may_run: false });
  if (signal?.aborted) return Promise.resolve(unsent("stopped"));
  if (Date.now() >= until) return Promise.resolve(unsent("timeout"));
  return new Promise((resolve, reject) => {
    let stream: ClientChannel | undefined;
    let truncated = false;
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    /** Keeps the first `max` bytes of a stream in `into`, and notes when there were more. */
    const keep = (into: Buffer[]) => {
      let n = 0;
      return (chunk: Buffer) => {
        if (n < max) into.push(chunk.subarray(0, max - n));
        n += chunk.length;
        if (n > max) truncated = true;
      };
    };
    let exit: number | null = null;
    let sig: string | null = null;
    let exited = false;
    let killed: Ran["killed"] = null;
    let settled = false;
    let hard: NodeJS.Timeout | undefined;
    const release = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      release();
      resolve({ exit, signal: sig, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errs).toString("utf8"), truncated, killed, remote_may_run: killed !== null && !exited });
    };
    const stop = (why: "timeout" | "stopped") => {
      if (killed || settled) return;
      killed = why;
      if (!stream) return finish(); // the machine hasn't answered the request: it may still run the command
      term(stream);
      hard = setTimeout(() => (stream!.close(), finish()), LIMITS.killMs);
    };
    const timer = setTimeout(() => stop("timeout"), Math.max(0, until - Date.now()));
    const onAbort = () => stop("stopped");
    signal?.addEventListener("abort", onAbort, { once: true });
    client.exec(command, (err: Error | undefined, opened: ClientChannel) => {
      if (settled) return opened?.close(); // answered after it was given up on
      if (err) {
        release();
        return reject(new LibraryError(`the target didn't run it: ${err.message}`));
      }
      stream = opened;
      stream.on("data", keep(out));
      stream.stderr.on("data", keep(errs));
      stream.on("exit", (code: number | null, name?: string) => ((exited = true), (exit = typeof code === "number" ? code : null), (sig = name ?? null)));
      stream.on("close", finish);
      stream.end(stdin || undefined);
    });
  });
}
