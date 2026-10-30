// The browser-extension key the skills' pages post with (#shared/pages), found or made by the skills
// themselves, so a skill imported from AnythingLLM's Community Hub works without a shell step. At the
// start of each of its calls a skill with pages looks for it (find), in this order:
//
//   1. its own PAGE_KEY setting (#shared/settings), which the user fills only when the chat asks:
//      checked with AnythingLLM, kept in the vault, and the field emptied;
//   2. the key in the vault (an entry of kind "page-key"), which any suite skill may have kept there;
//   3. the key `anywherellm-suite install --page-key` keeps in the storage, as before;
//   4. one it makes with AnythingLLM's own model (models/browserExtensionApiKey, an internal, so
//      feature-detected), kept in the vault: in multi-user mode only for its one admin, else none;
//   5. none: pageKey's refusal tells the agent to ask the user for PAGE_KEY.
//
// A key AnythingLLM refuses (one revoked in Settings › Browser Extension) is dropped from the vault,
// or passed over (install's), and the order goes on from there. AnythingLLM is asked with the browser
// extension's own check (GET /api/browser-extension/check, behind the same middleware as the upload
// the pages post to), else its model's validate; a key that can't be checked is taken as good, and a
// verdict holds for CHECKED_MS. A page's own 403 reaches no skill, so the check is what notices.

import crypto from "node:crypto";
import { perBuild, readPageKey, serial, serverRequire, storageDir } from "./anythingllm.mts";
import { Told } from "./errors.mts";
import { remember, repeated, setSettings, setting } from "./settings.mts";
import { anythingllmUrl, request } from "./upstream.mts";
import * as vault from "./vault.mts";

/** The skill calling: its hubId, and its name as Settings › Agent Skills shows it. */
export interface Skill {
  hubId: string;
  name: string;
}

const KIND = "page-key";
const SETTING = "PAGE_KEY";
/** How long AnythingLLM's word on a key holds before it's asked again. */
const CHECKED_MS = 60 * 1000;
const CHECK_TIMEOUT_MS = 3000;
const BRX = /^brx-\S+$/;

type Verdict = "good" | "refused" | "unknown";

/** What AnythingLLM said of each key lately, and the keys it refused (passed over from then on). */
const known = () => perBuild("pagekey", () => ({ checked: new Map<string, { verdict: Verdict; at: number }>(), refused: new Set<string>() }));

/** The skill this bundle is, as the last find named it: pageKey's refusal names its settings. */
let asking: Skill | null = null;

interface Keys {
  create(userId: number | null): Promise<{ apiKey: { key?: unknown } | null; error?: string | null }>;
  validate?(key: string): Promise<unknown>;
}
interface Settings {
  SystemSettings: { isMultiUserMode(): Promise<boolean> };
}
interface Users {
  User: { where(clause: Record<string, unknown>): Promise<{ id: number; suspended?: number | boolean }[]> };
}

/** AnythingLLM's model of browser-extension keys, or null where it isn't there as this expects. */
function model(): Keys | null {
  try {
    const keys = serverRequire<{ BrowserExtensionApiKey?: Keys }>("models/browserExtensionApiKey").BrowserExtensionApiKey;
    return keys && typeof keys.create === "function" ? keys : null;
  } catch {
    return null;
  }
}

/** What AnythingLLM says of `key`: the browser extension's check, else its model's validate. */
async function ask(key: string): Promise<Verdict> {
  try {
    const { status } = await request(`${anythingllmUrl(process.env)}/api/browser-extension/check`, { token: key, timeout: CHECK_TIMEOUT_MS });
    if (status === 200) return "good";
    if (status === 401 || status === 403) return "refused";
  } catch {} // not reached: its model, then
  const keys = model();
  if (typeof keys?.validate === "function")
    try {
      return (await keys.validate(key)) ? "good" : "refused";
    } catch {}
  return "unknown";
}

/** `key`'s verdict, asked at most every CHECKED_MS. */
async function checked(key: string): Promise<Verdict> {
  const { checked } = known();
  const kept = checked.get(key);
  if (kept && Date.now() - kept.at < CHECKED_MS) return kept.verdict;
  const verdict = await ask(key);
  checked.set(key, { verdict, at: Date.now() });
  return verdict;
}

/** The pages' key in the vault, or "" (also where the vault can't be opened: install's is next). */
function inVault(): string {
  try {
    return String(vault.entries().find((e) => e.kind === KIND)?.value ?? "");
  } catch {
    return "";
  }
}

/** Keeps `key` in the vault as the pages' key, in place of any there: given in the skill's PAGE_KEY
 *  (`given`: its hubId, whose slot is remembered in the same change), or made. */
const keep = (key: string, given?: string): Promise<void> =>
  vault.update((v) => {
    v.entries = v.entries.filter((e) => e.kind !== KIND);
    v.entries.push({ id: vault.newId(), kind: KIND, site: "anythingllm", user: "pages", value: key, made: !given });
    if (given) remember(v, given, SETTING, key);
  });

/** Drops `key` from the vault, if it is the pages' key there still. */
const drop = (key: string): Promise<void> =>
  vault.update((v) => {
    v.entries = v.entries.filter((e) => !(e.kind === KIND && e.value === key));
  });

/** A key made with AnythingLLM's own model: for no user in single-user mode, as Settings › Browser
 *  Extension makes one, and in multi-user mode for the admin when there is exactly one (a key of no
 *  user is refused there); null where none can be made. */
async function make(): Promise<string | null> {
  const keys = model();
  if (!keys) return null;
  let owner: number | null = null;
  try {
    if (await serverRequire<Settings>("models/systemSettings").SystemSettings.isMultiUserMode()) {
      const admins = (await serverRequire<Users>("models/user").User.where({ role: "admin" })).filter((u) => !u.suspended);
      if (admins.length !== 1) return null;
      owner = admins[0].id;
    }
  } catch {
    return null; // whether a key needs a user can't be told: none is made
  }
  const { apiKey } = await keys.create(owner);
  const key = String(apiKey?.key ?? "");
  return BRX.test(key) ? key : null;
}

/** What to tell the user about the skill's PAGE_KEY setting, which held `given`: kept, refused, or
 *  nothing for a value saved again. The field is emptied once that's decided; where the vault can't
 *  keep it, it stays for the next call (find logs why). */
async function fromSetting(skill: Skill, given: string): Promise<string | null> {
  const where = `PAGE_KEY (Settings › Agent Skills › ${skill.name})`;
  const told = await (async () => {
    if (repeated(skill.hubId, SETTING, given)) return null;
    if (!BRX.test(given)) return `The key in ${where} isn't a browser-extension key (those start "brx-"), so it wasn't kept; the field is empty again. Tell the user to copy one from AnythingLLM's Settings › Browser Extension.`;
    if ((await checked(given)) === "refused") return `AnythingLLM refused the key in ${where}, so it wasn't kept; the field is empty again. Tell the user to make a new one in Settings › Browser Extension and paste it there.`;
    await keep(given, skill.hubId);
    known().refused.delete(given);
    return `The key in ${where} is kept in the Vault for the pages, and the field is empty again.`;
  })();
  setSettings(skill.hubId, { [SETTING]: "" });
  return told;
}

/** Finds the pages' key for a call of `skill`, whose PAGE_KEY setting the call was given as `given`
 *  (#shared/settings reads it from plugin.json), in the order above. Answers what the agent tells the
 *  user, as lines (none, mostly). One at a time in this process, so two skills' first calls don't
 *  each make a key. It never throws: what fails is logged with `log`, and the call goes on. */
export function find(skill: Skill, given: string | undefined, log: (message: string) => void = console.error): Promise<string[]> {
  asking = skill;
  return serial("pagekey.find", async () => {
    const said: string[] = [];
    try {
      const slot = setting(skill.hubId, SETTING, given);
      const told = slot ? await fromSetting(skill, slot) : null;
      if (told) said.push(told);
      const { refused } = known();
      const kept = inVault();
      if (kept) {
        if ((await checked(kept)) !== "refused") return said;
        refused.add(kept);
        await drop(kept);
      }
      const installed = readPageKey(storageDir());
      if (installed && !refused.has(installed)) {
        if ((await checked(installed)) !== "refused") return said;
        refused.add(installed);
      }
      const made = await make();
      if (made) {
        await keep(made);
        said.push(`The pages had no key to post with, so ${skill.name} made one with AnythingLLM. Tell the user they'll see it under Settings › Browser Extension, where they can revoke it (a skill then makes another at its next call, unless they give one in PAGE_KEY).`);
      }
    } catch (e) {
      log(`${skill.hubId} couldn't find the pages' key: ${(e as Error)?.message ?? e}`);
    }
    return said;
  });
}

/** The key the skills' pages post with, as the last find left it: the vault's, else install's,
 *  unless AnythingLLM refused it; a refusal that tells the agent to ask for PAGE_KEY when there's
 *  none. */
export function pageKey(): string {
  const { refused } = known();
  const key = [inVault(), readPageKey(storageDir())].find((k) => k && !refused.has(k));
  if (key) return key;
  const name = asking?.name ?? "the skill";
  throw new Told(
    `the pages have no key to post with, and ${name} couldn't make one: ask the user to make one in AnythingLLM's Settings › Browser Extension, paste it into PAGE_KEY under Settings › Agent Skills › ${name}, save, and say done (never in the chat); the next call takes it`,
  );
}

/** A short stamp of the pages' key, "" when there's none: a page written with another key is stale. */
export function keyStamp(): string {
  try {
    return crypto.createHash("sha256").update(pageKey()).digest("hex").slice(0, 8);
  } catch {
    return "";
  }
}

/** `text`, a skill's answer, after what find said to tell the user, if anything. */
export const ahead = (said: string[], text: string): string => (said.length ? `${said.join("\n")}\n\n${text}` : text);
