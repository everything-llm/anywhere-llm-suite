// The browser-extension key the skills' pages post with (#shared/pages). The user makes it once, in
// AnythingLLM's Settings › Browser Extension, and pastes it into one skill's PAGE_KEY setting; every
// suite skill finds it after that, so a skill imported from AnythingLLM's Community Hub needs no shell
// step. At the start of each of its calls a skill with pages looks for it (find), in this order:
//
//   1. its own PAGE_KEY setting (#shared/settings): checked with AnythingLLM, kept in the vault, and
//      the field emptied;
//   2. the key in the vault (an entry of kind "page-key"), which any suite skill may have kept there;
//   3. the key `anywherellm-suite install --page-key` keeps in the storage, as before;
//   4. none: pageKey's refusal gives the agent the user's two steps, and the setup guide's.
//
// A key AnythingLLM refuses (one revoked in Settings › Browser Extension) is dropped from the vault,
// or passed over (install's), and the order goes on from there. AnythingLLM is asked with the browser
// extension's own check (GET /api/browser-extension/check, behind the same middleware as the upload
// the pages post to); a key that can't be checked is taken as good, and a verdict holds for
// CHECKED_MS. A page's own 403 reaches no skill, so the check is what notices.

import crypto from "node:crypto";
import { perBuild, readPageKey, serial, storageDir } from "./anythingllm.mts";
import { Told } from "./errors.mts";
import { remember, repeated, setSettings, setting } from "./settings.mts";
import { anythingllmUrl, request } from "./upstream.mts";
import * as vault from "./vault.mts";

/** The skill calling: its hubId, and its name as Settings › Agent Skills shows it. */
export interface Skill {
  hubId: string;
  name: string;
}

/** The setup guide, on the suite's own site, and its steps' anchors. */
const SETUP_GUIDE = "https://everything-llm.github.io/anywhere-llm-suite/setup.html";
export const guideAt = (step: "page-key" | "service-key" | "imports"): string => `${SETUP_GUIDE}#${step}`;

const KIND = "page-key";
const SETTING = "PAGE_KEY";
/** How long AnythingLLM's word on a key holds before it's asked again. */
const CHECKED_MS = 60 * 1000;
const CHECK_TIMEOUT_MS = 3000;
const BRX = /^brx-\S+$/;

/** The key in what the user pasted: Settings › Browser Extension's Copy API Key copies its connection
 *  string, AnythingLLM's address and the key ("http://host:3001/api|brx-..."), so the key is what
 *  follows the last "|". */
export const keyIn = (pasted: string): string => pasted.trim().split("|").at(-1)!.trim();

type Verdict = "good" | "refused" | "unknown";

/** What AnythingLLM said of each key lately, and the keys it refused (passed over from then on). */
const known = () => perBuild("pagekey", () => ({ checked: new Map<string, { verdict: Verdict; at: number }>(), refused: new Set<string>() }));

/** The skill this bundle is, as the last find named it: pageKey's refusal names its settings. */
let asking: Skill | null = null;

/** What AnythingLLM says of `key`, with the browser extension's own check. */
async function ask(key: string): Promise<Verdict> {
  try {
    const { status } = await request(`${anythingllmUrl(process.env)}/api/browser-extension/check`, { token: key, timeout: CHECK_TIMEOUT_MS });
    if (status === 200) return "good";
    if (status === 401 || status === 403) return "refused";
  } catch {} // not reached: taken as good
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

/** The pages' key in the vault, or ""; null where the vault can't be opened (install's is next). */
function inVault(): string | null {
  try {
    return String(vault.entries().find((e) => e.kind === KIND)?.value ?? "");
  } catch {
    return null;
  }
}

/** Keeps `key`, given in the PAGE_KEY of the skill `hubId`, in the vault as the pages' key, in place
 *  of any there, and remembers the slot's value in the same change. */
const keep = (key: string, hubId: string): Promise<void> =>
  vault.update((v) => {
    v.entries = v.entries.filter((e) => e.kind !== KIND);
    v.entries.push({ id: vault.newId(), kind: KIND, site: "anythingllm", user: "pages", value: key });
    remember(v, hubId, SETTING, key);
  });

/** Drops `key` from the vault, if it is the pages' key there still. */
const drop = (key: string): Promise<void> =>
  vault.update((v) => {
    v.entries = v.entries.filter((e) => !(e.kind === KIND && e.value === key));
  });

/** What to tell the user about the skill's PAGE_KEY setting, which held `given`: kept, refused, or
 *  nothing for a value saved again. The field is emptied once that's decided; where the vault can't
 *  keep it, it stays for the next call (find logs why). */
async function fromSetting(skill: Skill, pasted: string): Promise<string | null> {
  const where = `PAGE_KEY (Settings › Agent Skills › ${skill.name})`;
  const given = keyIn(pasted);
  const told = await (async () => {
    if (repeated(skill.hubId, SETTING, given)) return null;
    if (!BRX.test(given)) return `The key in ${where} isn't a browser-extension key (those start "brx-"), so it wasn't kept; the field is empty again. Tell the user to copy one from AnythingLLM's Settings › Browser Extension (${guideAt("page-key")}).`;
    if ((await checked(given)) === "refused") return `AnythingLLM refused the key in ${where}, so it wasn't kept; the field is empty again. Tell the user to make a new one in Settings › Browser Extension and paste it there (${guideAt("page-key")}).`;
    await keep(given, skill.hubId);
    known().refused.delete(given);
    return `The key in ${where} is kept in the Vault for the pages, and the field is empty again. Every suite skill finds it now.`;
  })();
  setSettings(skill.hubId, { [SETTING]: "" });
  return told;
}

/** Finds the pages' key for a call of `skill`, whose PAGE_KEY setting the call was given as `given`
 *  (#shared/settings reads it from plugin.json), in the order above. Answers what the agent tells the
 *  user, as lines (none, mostly). One at a time in this process. It never throws: what fails is
 *  logged with `log`, and the call goes on. */
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
      if (installed && !refused.has(installed) && (await checked(installed)) === "refused") refused.add(installed);
    } catch (e) {
      log(`${skill.hubId} couldn't find the pages' key: ${(e as Error)?.message ?? e}`);
    }
    return said;
  });
}

/** The key the skills' pages post with, as the last find left it: the vault's, else install's,
 *  unless AnythingLLM refused it; with none, a refusal that gives the agent the user's two steps. */
export function pageKey(): string {
  const { refused } = known();
  const key = [inVault(), readPageKey(storageDir())].find((k) => k && !refused.has(k));
  if (key) return key;
  const name = asking?.name ?? "this skill";
  throw new Told(
    `the pages have no key to post with yet. Give the user these two steps, and never ask for the key in the chat: 1. In AnythingLLM, open Settings › Browser Extension, create a key and copy it. 2. Open Settings › Agent Skills › ${name}, paste it into PAGE_KEY and save. The setup guide shows both: ${guideAt("page-key")}. One skill is enough: every suite skill finds the key after that`,
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
