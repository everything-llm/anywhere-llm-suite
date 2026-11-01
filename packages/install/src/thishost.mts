// What install records of the machine it runs on, for the library to refuse a target that is this
// machine: <storage>/anywherellm-suite/this-host.json holds the SHA-256 fingerprints of its SSH host
// keys (/etc/ssh/ssh_host_*_key.pub) and every address of every interface it has, as the host sees
// them (the container AnythingLLM runs in sees fewer: a tailnet address the host has isn't there).
// A machine that shows one of these keys, or answers from one of these addresses, is the host, and
// signing in there reads the vault's key and the pages' secrets (shared/thishost.mts). The library
// only reads the file, and refuses every target when it is missing or holds no key, so install
// writes it again each time it runs, and health says when it is missing or the host has changed.
//
// `this-host --allow login@port` (and --disallow) is the owner's one exception: it adds the account
// to the record's `allow` (or takes it out), keeping the keys and addresses as they are, and install
// keeps the list when it writes the record again. The library then lets a target here through at
// that login and port alone. The file is in AnythingLLM's storage, which code in the container can
// write: the list says which accounts the owner vouches for, it doesn't lock anything against what
// runs inside. Allow only a separate unprivileged account that can't read the storage (README).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomicIfChanged } from "#shared/atomic";
import { Told } from "#shared/errors";
import { type Account, type ThisHost, accountOf, accountText, bare, recorded, sshFingerprint, thisHostFile } from "#shared/thishost";
import { type Check, refuseLinks } from "./addons.mts";

/** The machine as install sees it: where its SSH host keys are, and its interfaces (a test says
 *  another). */
export interface HostView {
  sshDir: string;
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

const realHost = (): HostView => ({ sshDir: "/etc/ssh", interfaces: os.networkInterfaces() });

/** `SHA256:…` of a public key line ("ssh-ed25519 AAAA… comment"), as ssh-keygen -lf prints it; null
 *  for a line that isn't one. */
export function fingerprintOf(line: string): string | null {
  const blob = line.trim().split(/\s+/)[1];
  if (!blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  const key = Buffer.from(blob, "base64");
  return key.length ? sshFingerprint(key) : null;
}

/** What this host is: its host keys' fingerprints (none when /etc/ssh has none or can't be read) and
 *  its addresses, each sorted and once. */
export function recordOf(host: HostView): ThisHost {
  let names: string[] = [];
  try {
    names = fs.readdirSync(host.sshDir).filter((n) => /^ssh_host_.*_key\.pub$/.test(n));
  } catch {} // no sshd here: no keys, and health says so
  const fingerprints = names.flatMap((n) => {
    try {
      return fingerprintOf(fs.readFileSync(path.join(host.sshDir, n), "utf8")) ?? [];
    } catch {
      return [];
    }
  });
  const addresses = Object.values(host.interfaces).flatMap((list) => (list ?? []).map((a) => bare(a.address)));
  return { fingerprints: [...new Set(fingerprints)].sort(), addresses: [...new Set(addresses)].sort() };
}

/** The record as the file holds it: `allow` only when it names an account. */
const textOf = (record: ThisHost): string => {
  const { allow, ...rest } = record;
  return `${JSON.stringify(allow?.length ? { ...rest, allow } : rest, null, 2)}\n`;
};

/** Writes the record, unless it holds that already; whether it wrote. */
function write(file: string, record: ThisHost): boolean {
  refuseLinks(file, "the record of this machine");
  return writeAtomicIfChanged(file, textOf(record), 0o644);
}

/** The accounts the record in `storage` allows now; none when there is no record. */
const allowedIn = (storage: string): Account[] => {
  const held = recorded(storage);
  return "host" in held ? (held.host.allow ?? []) : [];
};

/** Records this machine in the storage, keeping the accounts the owner allowed; what it did. It
 *  never fails an install: a refusal or an error is said, and health then reports the file missing. */
export function putThisHost(storage: string, host: HostView = realHost()): string {
  const file = thisHostFile(storage);
  try {
    const allow = allowedIn(storage);
    const record = { ...recordOf(host), allow };
    const wrote = write(file, record);
    const note = record.fingerprints.length ? "" : ` (no SSH host key in ${host.sshDir}: the library will refuse every SSH target until this machine has one)`;
    const kept = allow.length ? `, allowing ${allow.map(accountText).join(", ")}` : "";
    return `${wrote ? "recorded" : "unchanged:"} this machine (${record.fingerprints.length} SSH host key${record.fingerprints.length === 1 ? "" : "s"}, ${record.addresses.length} addresses${kept}): ${file}${note}`;
  } catch (e) {
    return `didn't record this machine in ${file}: ${(e as Error).message}`;
  }
}

/** Whether the record of this machine is there, is one as the library reads it (#shared/thishost
 *  recorded), and says what the machine is now. */
export function thisHostCheck(storage: string, host: HostView = realHost()): Check {
  const name = "the record of this machine (for SSH targets)";
  const held = recorded(storage);
  if ("why" in held) return [name, false, `${held.why}: the library refuses every SSH target without it. Run install on this machine: it writes it again`];
  const now = recordOf(host);
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === b[i]);
  const drift = [...(same(held.host.fingerprints, now.fingerprints) ? [] : ["its SSH host keys"]), ...(same(held.host.addresses, now.addresses) ? [] : ["its addresses"])];
  if (drift.length) return [name, false, `differs from what this machine has now: ${drift.join(" and ")}. Run install on this machine: it writes the record again`];
  if (!now.fingerprints.length) return [name, false, `this machine has no SSH host key in ${host.sshDir}, so the library refuses every SSH target: install sshd's keys, then run install`];
  const allow = held.host.allow ?? [];
  return [name, true, allow.length ? `allows ${allow.map(accountText).join(", ")} (this-host --disallow takes one out)` : ""];
}

/** What `this-host` changes: accounts to allow and to disallow, each `login@port`. */
export interface Change {
  allow?: string[];
  disallow?: string[];
}

const ACCOUNT_FORM = "an account is login@port, like anythingllm@2222: the login a target signs in as, and the port its sshd listens on";

/** The accounts this machine allows the library to sign in to, as the owner gave them: adds and
 *  removes what `change` says, keeping the record's keys and addresses, and prints the list. A
 *  record that isn't there (or can't be read) is a refusal: install writes it first. */
export function thisHost(storage: string, change: Change, print: (line: string) => void): void {
  const parse = (texts: string[] | undefined, flag: string): Account[] =>
    (texts ?? []).map((t) => {
      const a = accountOf(t);
      if (!a) throw new Told(`--${flag} ${t}: ${ACCOUNT_FORM}`);
      return a;
    });
  const allow = parse(change.allow, "allow");
  const disallow = parse(change.disallow, "disallow");
  const same = (a: Account) => (b: Account) => a.login === b.login && a.port === b.port;
  const both = allow.find((a) => disallow.some(same(a)));
  if (both) throw new Told(`${accountText(both)} is both allowed and disallowed: choose one`);
  const file = thisHostFile(storage);
  const held = recorded(storage);
  if ("why" in held) throw new Told(`this machine isn't recorded (${held.why}): run install on this machine first, then this-host again`);
  const now = [...(held.host.allow ?? [])];
  for (const a of allow) {
    if (now.some(same(a))) {
      print(`unchanged: ${accountText(a)} is allowed already`);
    } else {
      now.push(a);
      print(`allowed ${accountText(a)} on this machine`);
    }
  }
  for (const a of disallow) {
    const at = now.findIndex(same(a));
    if (at < 0) {
      print(`unchanged: ${accountText(a)} isn't allowed`);
    } else {
      now.splice(at, 1);
      print(`disallowed ${accountText(a)}: the library refuses it again, at its next sign-in`);
    }
  }
  if (allow.length || disallow.length) {
    // Rewrites only `allow`: the keys and addresses stay as install recorded them (health says when
    // they are out of date).
    write(file, { fingerprints: held.host.fingerprints, addresses: held.host.addresses, allow: now });
  }
  print(`the record of this machine: ${file}`);
  if (!now.length) print("No account on this machine is allowed: the library refuses every SSH target that is this machine.");
  else {
    print(`Accounts on this machine the library may sign in to (that login at that port, nothing else here): ${now.map(accountText).join(", ")}`);
    if (allow.length) print("Allow only a separate unprivileged account that can't read AnythingLLM's storage: its home private (0700) and apart, AnythingLLM's processes hidden from it (hidepid), and a firewall that keeps it from AnythingLLM's ports. The record is in AnythingLLM's storage, so this is your word for which accounts you vouch for, not a lock against code inside AnythingLLM.");
  }
}
