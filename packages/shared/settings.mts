// A skill's own settings, as AnythingLLM keeps them: in the skill's plugin.json, each setup_args
// entry's `value`, in plain text. The file is in the folder AnythingLLM loaded the skill's handler.js
// from (<storage>/plugins/agent-skills/<folder>): the skill's hubId when install put it there, but
// the Hub's own id for the item when it was imported from the Community Hub, which names the folder
// and the plugin.json's hubId alike (utils/agents/imported.js importCommunityItemFromUrl). So the
// file is found beside the running handler.js, and by the skill's hubId only where the bundle runs
// elsewhere (a test). A setting can be a slot the user pastes a secret into (the library's NEW_KEY,
// PAGE_KEY), which the skill moves into the vault and empties at its next call: the secret is in
// plain text only from the user's save until then.
//
// The file is read at each call, never the call's runtimeArgs: AnythingLLM reads the settings into
// runtimeArgs once, as it loads the skill for an agent run, and a chat's agent session (its
// websocket) keeps that run, and those values, until it ends. A value saved meanwhile is in the file
// only, and a slot emptied by an earlier call is still in the runtimeArgs.
//
// AnythingLLM's settings page saves the whole plugin.json as it showed it, so a page left open and
// saved again puts a slot's old value back. What a slot last gave is kept as a digest in the vault
// (#shared/vault `slots`), and the same value given again is only emptied.
//
// A change is a read and an atomic write with nothing between them, so nothing in this process
// (AnythingLLM's own write of the file, another skill's call) comes between. It takes no lock:
// AnythingLLM's write takes none either, and a change another process (a scheduled job) made at the
// same moment is made again by that skill's next call (a description's list) or meets the digest
// (a slot's value).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { storageDir } from "./anythingllm.mts";
import { writeAtomic } from "./atomic.mts";
import * as vault from "./vault.mts";

type Arg = Record<string, unknown> & { value?: unknown };
/** A skill's plugin.json, as far as this module reads it. */
export type Config = Record<string, unknown> & { setup_args?: Record<string, Arg> };

/** Where AnythingLLM keeps the plugin.json of the skill running, whose hubId is `hubId` (a skill
 *  asks for its own only): beside its handler.js, when AnythingLLM loaded it from its skills folder,
 *  whatever the folder is named (see above); else in the folder `hubId` names. */
export function pluginFile(hubId: string): string {
  const real = (dir: string): string => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  const skills = path.join(storageDir(), "plugins", "agent-skills");
  const own = typeof __dirname === "string" && path.dirname(real(__dirname)) === real(skills);
  return path.join(own ? __dirname : path.join(skills, hubId), "plugin.json");
}

/** The skill's plugin.json, or null where there is none, or it isn't JSON. */
function readConfig(hubId: string): Config | null {
  try {
    const config = JSON.parse(fs.readFileSync(pluginFile(hubId), "utf8"));
    return config && typeof config === "object" ? config : null;
  } catch {
    return null;
  }
}

/** What the setting `name` holds now in the skill's plugin.json, trimmed ("" when empty); with no
 *  plugin.json where AnythingLLM keeps the skill (a bundle run elsewhere), what the call was given
 *  (`given`, from its runtimeArgs). Read from the file, not the call: a value saved while an agent
 *  run goes on, or emptied by an earlier call of the same run, is as the file says (see above). */
export function setting(hubId: string, name: string, given?: string): string {
  const config = readConfig(hubId);
  if (!config) return String(given ?? "").trim();
  return String(config.setup_args?.[name]?.value ?? "").trim();
}

/** Changes the skill's plugin.json: `change` gets it as it is now, changes it in place and answers
 *  whether it changed anything; only then is it written, atomically and with the mode it had.
 *  Nothing where there's no plugin.json. Whether it wrote. */
export function changePlugin(hubId: string, change: (config: Config) => boolean): boolean {
  const file = pluginFile(hubId);
  const config = readConfig(hubId);
  if (!config || !change(config)) return false;
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {}
  writeAtomic(file, JSON.stringify(config, null, 2), mode);
  return true;
}

/** Sets the settings `values` (by name; "" empties one), those the skill declares. Whether it wrote. */
export const setSettings = (hubId: string, values: Record<string, string>): boolean =>
  changePlugin(hubId, (config) => {
    let changed = false;
    for (const [name, value] of Object.entries(values)) {
      const arg = config.setup_args?.[name];
      if (!arg || arg.value === value || (value === "" && arg.value === undefined)) continue;
      arg.value = value;
      changed = true;
    }
    return changed;
  });

/** A slot's name in the vault's `slots`. */
const slotOf = (hubId: string, name: string): string => `${hubId}.${name}`;
const digest = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");

/** Whether `value` is what the slot `name` last gave: the same value saved again. */
export const repeated = (hubId: string, name: string, value: string): boolean => vault.slots()[slotOf(hubId, name)] === digest(value);

/** Notes in `v` (in the vault change that keeps what the slot gave) that the slot `name` gave `value`. */
export const remember = (v: vault.Vault, hubId: string, name: string, value: string): void => void (v.slots[slotOf(hubId, name)] = digest(value));
