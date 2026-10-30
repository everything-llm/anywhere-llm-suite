// The library's key slot: two settings of its own (#shared/settings), KEY_FOR (text) and NEW_KEY (a
// password field), so a key is given in AnythingLLM's own settings, with no page and no second skill.
// When the agent asks for a key (secret), the library writes the site into KEY_FOR, and the answer
// tells the user to paste the key into NEW_KEY under Settings › Agent Skills › Library, save, and say
// done: the key never passes through the chat, and the model never sees it.
//
// At the start of every call, a chat's or a scheduled job's, a filled NEW_KEY is taken: sealed into
// the vault as an API key, for the need whose site KEY_FOR names (the newest need where KEY_FOR is
// empty, as a settings page opened before the ask saves it), else under the site's host; the need is
// met, and both settings are emptied. Until then the key is in plain text in plugin.json. The same
// value saved again, from a settings page left open, is only emptied (#shared/settings repeated). The
// Vault's Keys (page.ts) stay a second way to give a key, where pages work.

import { Told } from "#shared/errors";
import { remember, repeated, setSettings, setting } from "#shared/settings";
import * as vault from "#shared/vault";
import type { HandlerContext } from "./host";
import * as page from "./page";
import * as secrets from "./secrets";

const HUB_ID = "library-lean";
/** Where the user finds the slot. */
export const SETTINGS = "Settings › Agent Skills › Library";

/** A key the slot gave in this call. */
export interface Taken {
  label: string;
  site: string;
}

/** Writes `site` into KEY_FOR, for the key just asked for. */
export const ask = (site: string): boolean => setSettings(HUB_ID, { KEY_FOR: site });

/** Empties the slot: NEW_KEY, and KEY_FOR unless `keyFor` says what it should hold now. */
const empty = (keyFor = ""): boolean => setSettings(HUB_ID, { NEW_KEY: "", KEY_FOR: keyFor });

/** What the user is told to do to give the key for `site`, `label`'s, in the slot. */
export const steps = (site: string, label: string): string =>
  `Tell them to open ${SETTINGS} in AnythingLLM, paste the key for ${site} into NEW_KEY (KEY_FOR says ${site}), save, and say "done" here. When they do, call secret again with the same site and label: it says whether "${label}" was saved.`;

/** Takes a key from the slot, if NEW_KEY holds one (see above): what to tell the user, and the key
 *  taken, if one was. A refusal (a site that isn't one, a name that is another secret's) empties the
 *  slot and says why; where the vault can't keep it, the key stays in NEW_KEY for the next call. */
export async function collect(self: HandlerContext): Promise<{ text: string; taken: Taken | null } | null> {
  const value = setting(HUB_ID, "NEW_KEY", self.runtimeArgs?.NEW_KEY);
  const keyFor = setting(HUB_ID, "KEY_FOR", self.runtimeArgs?.KEY_FOR);
  const needs = page.keyNeeds();
  const newest = needs.at(-1);
  if (!value) {
    // A need met on the Vault, or run out: KEY_FOR names nothing asked for any more.
    if (keyFor && !needs.some((n) => n.site === secrets.publicSite(keyFor))) setSettings(HUB_ID, { KEY_FOR: "" });
    return null;
  }
  if (repeated(HUB_ID, "NEW_KEY", value)) {
    // A page left open saved it again, with the KEY_FOR it showed then.
    empty(newest?.site ?? "");
    return null;
  }
  let taken: Taken;
  try {
    const site = keyFor ? secrets.siteChecked(keyFor) : newest?.site;
    if (!site) throw new Told("KEY_FOR doesn't say which site it is for, and no key was asked for: ask for it with secret first");
    const need = keyFor ? needs.filter((n) => n.site === site).at(-1) : newest;
    taken = { site, label: need?.label ?? secrets.labelOf(site) };
    if (!need) secrets.assertKeyName(taken.label);
  } catch (e) {
    if (!(e instanceof Told)) throw e;
    empty();
    return { text: `The key in NEW_KEY (${SETTINGS}) wasn't kept: ${e.message.replace(/\.$/, "")}. NEW_KEY and KEY_FOR are empty again.`, taken: null };
  }
  try {
    await vault.update((v) => {
      secrets.putKey(v, taken.site, taken.label, value);
      remember(v, HUB_ID, "NEW_KEY", value);
    });
  } catch (e) {
    if (!(e instanceof vault.VaultError)) {
      if (!(e instanceof Told)) throw e;
      empty();
      return { text: `The key in NEW_KEY (${SETTINGS}) wasn't kept: ${e.message.replace(/\.$/, "")}. NEW_KEY and KEY_FOR are empty again.`, taken: null };
    }
    return { text: `The key in NEW_KEY (${SETTINGS}) can't be kept yet: ${e.message.replace(/\.$/, "")}. It stays in NEW_KEY until the vault opens.`, taken: null };
  }
  await page.met(taken.label);
  let after = "NEW_KEY and KEY_FOR are empty again";
  try {
    empty();
  } catch (e) {
    after = `NEW_KEY couldn't be emptied (${(e as NodeJS.ErrnoException).code ?? "error"}): the user empties it there by hand`;
  }
  return { text: `Saved the key "${taken.label}" for ${taken.site} from NEW_KEY (${SETTINGS}) into the Vault, sealed; ${after}. Tell the user it's saved, by its name only.`, taken };
}
