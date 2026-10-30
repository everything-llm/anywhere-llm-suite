// The library's key slot: one setting of its own (#shared/settings), NEW_KEY (a password field), so a
// key is given in AnythingLLM's own settings, with no page and no second skill. When the agent asks for
// a key (secret), the answer names the key's site and tells the user to paste it into NEW_KEY under
// Settings › Agent Skills › Library, save, and say done: the key never passes through the chat, and
// the model never sees it.
//
// At the start of every call, a chat's or a scheduled job's, a filled NEW_KEY is taken for the newest
// key the agent asked for that is still waiting: sealed into the vault, the need met, and NEW_KEY
// emptied in the skill's own plugin.json. Until then the key is in plain text there. With no key
// asked for, there's no site to send it to: it stays in NEW_KEY, and the answer says so. The same value
// saved again, from a settings page left open, is only emptied (#shared/settings repeated). The
// Vault's Keys (page.ts) stay a second way to give a key, where pages work.

import { guideAt } from "#shared/pagekey";
import { Told } from "#shared/errors";
import { remember, repeated, setSettings, setting } from "#shared/settings";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";
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

/** Empties NEW_KEY. */
const empty = (): boolean => setSettings(HUB_ID, { NEW_KEY: "" });

/** What the user is told to do to give the key for `site`, `label`'s, in the slot. */
export const steps = (site: string, label: string): string =>
  `Tell them to open ${SETTINGS} in AnythingLLM, paste the key for ${site} into NEW_KEY, save, and say "done" here; the setup guide shows it: ${guideAt("service-key")}. When they say done, call secret again with the same site and label: it says whether "${label}" was saved.`;

/** Takes a key from the slot, if NEW_KEY holds one (see above): what to tell the user, and the key
 *  taken, if one was. A name that is another secret's empties the slot and says why; with no key
 *  asked for, or where the vault can't keep it, the key stays in NEW_KEY for a later call. */
export async function collect(self: HandlerContext): Promise<{ text: string; taken: Taken | null } | null> {
  const value = setting(HUB_ID, "NEW_KEY", self.runtimeArgs?.NEW_KEY);
  if (!value) return null;
  if (repeated(HUB_ID, "NEW_KEY", value)) {
    empty(); // a page left open saved it again
    return null;
  }
  const need = page.keyNeeds().at(-1);
  if (!need) return { text: `NEW_KEY (${SETTINGS}) holds a key, but the library didn't ask for one, so it doesn't know which site it goes to: it stays there. Ask with secret for the service the user means, and the next call takes it.`, taken: null };
  const taken: Taken = { site: need.site, label: need.label };
  try {
    await vault.update((v) => {
      secrets.putKey(v, taken.site, taken.label, value);
      remember(v, HUB_ID, "NEW_KEY", value);
    });
  } catch (e) {
    // The library's own refusal (a name that is another secret's) is final; the vault's (closed,
    // busy) passes, so the key waits in NEW_KEY for the next call.
    if (e instanceof LibraryError) {
      empty();
      return { text: `The key in NEW_KEY (${SETTINGS}) wasn't kept: ${e.message.replace(/\.$/, "")}. NEW_KEY is empty again.`, taken: null };
    }
    if (!(e instanceof Told)) throw e;
    return { text: `The key in NEW_KEY (${SETTINGS}) can't be kept yet: ${e.message.replace(/\.$/, "")}. It stays in NEW_KEY for the next call.`, taken: null };
  }
  await page.met(taken.label);
  let after = "NEW_KEY is empty again";
  try {
    empty();
  } catch (e) {
    after = `NEW_KEY couldn't be emptied (${(e as NodeJS.ErrnoException).code ?? "error"}): the user empties it there by hand`;
  }
  return { text: `Saved the key "${taken.label}" for ${taken.site} from NEW_KEY (${SETTINGS}) into the Vault, sealed; ${after}. Tell the user it's saved, by its name only.`, taken };
}
