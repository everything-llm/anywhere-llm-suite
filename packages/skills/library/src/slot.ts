// The library's key slot: one setting of its own (#shared/settings), NEW_KEY (a password field), so a
// key is given in AnythingLLM's own settings, with no page and no second skill. When the agent asks for
// a key (secret), the answer names the key's site and tells the user to paste it into NEW_KEY under
// Settings › Agent Skills › Library, save, and say done: the key never passes through the chat, and
// the model never sees it.
//
// At the start of every call, a chat's or a scheduled job's, a filled NEW_KEY is taken for the newest
// key the agent asked for that is still waiting: sealed into the vault, the need met, and NEW_KEY
// emptied in the skill's own plugin.json. Until then the key is in plain text there. With no key
// asked for, there's no site to send it to: it stays in NEW_KEY, and the answer says so. The Vault's
// Keys (page.ts) stay a second way to give a key, where pages work.
//
// The same value saved again (#shared/settings repeated) is mostly a settings page left open, saved
// again: only emptied, never taken for another key, which would send one service's key to another's
// site. It is taken again only for the key it was last given for (by name and site), when that key
// isn't in the vault any more: the user giving a lost key again. What the slot did is always said,
// a write that failed included: the agent tells the user from the answer, not from the log.

import { guideAt } from "#shared/pagekey";
import { Told } from "#shared/errors";
import { remember, repeated, setSettings, setting } from "#shared/settings";
import * as vault from "#shared/vault";
import { LibraryError } from "./errors";
import * as page from "./page";
import * as secrets from "./secrets";

const HUB_ID = "library-lean";
const SLOT = "NEW_KEY";
/** The slot's digest of what it last gave with the key it went to (its site and name), in the vault's slots. */
const GIVEN_FOR = "NEW_KEY.for";
/** Where the user finds the slot. */
export const SETTINGS = "Settings › Agent Skills › Library";

/** A key the slot gave in this call. */
export interface Taken {
  label: string;
  site: string;
}

/** What GIVEN_FOR remembers of `value` given for `to`. */
const givenFor = (to: Taken, value: string): string => `${to.site}\n${to.label.toLowerCase()}\n${value}`;

/** What the user is told to do to give the key for `site`, `label`'s, in the slot. */
export const steps = (site: string, label: string): string =>
  `Tell them to open ${SETTINGS} in AnythingLLM, paste the key for ${site} into NEW_KEY, save, and say "done" here; the setup guide shows it: ${guideAt("service-key")}. When they say done, call secret again with the same site and label: it says whether "${label}" was saved.`;

/** The code of an error, or its first words: what the answer names a failure by. */
const why = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120);

/** Empties NEW_KEY: whether it is empty now, and the words for it. */
function empty(): { done: boolean; text: string } {
  try {
    // Nothing written and the value still there: no plugin.json was found to empty it in.
    if (!setSettings(HUB_ID, { [SLOT]: "" }) && setting(HUB_ID, SLOT)) return { done: false, text: "NEW_KEY couldn't be emptied (the library's plugin.json wasn't found): the user empties it there by hand" };
    return { done: true, text: "NEW_KEY is empty again" };
  } catch (e) {
    console.error(`library-lean couldn't empty NEW_KEY: ${(e as Error)?.message ?? e}`);
    return { done: false, text: `NEW_KEY couldn't be emptied (${why(e)}): the user empties it there by hand` };
  }
}

/** NEW_KEY holding what it gave last (see above), with `need` the newest key asked for: the answer
 *  when it is only emptied, or null when it is taken again (for the key it was given for, lost since). */
async function again(value: string, need: Taken | undefined): Promise<{ text: string; taken: Taken | null } | null> {
  const kept = secrets.savedAs(value);
  if (!kept && need && repeated(HUB_ID, GIVEN_FOR, givenFor(need, value))) return null;
  const emptied = empty();
  const and = emptied.done ? "and" : "but";
  if (kept) {
    // The key the agent asks for is the one saved already: the need is met.
    const same = need && need.label.toLowerCase() === kept.label.toLowerCase() && need.site === kept.site;
    if (same) await page.met(need.label);
    return { text: `NEW_KEY (${SETTINGS}) held the key saved already as "${kept.label}" (${kept.site}): nothing changed, ${and} ${emptied.text}.`, taken: same ? kept : null };
  }
  return {
    text: `NEW_KEY (${SETTINGS}) held the key it gave before, which a settings page left open puts back, so it wasn't taken${need ? ` for "${need.label}"` : ""}; ${emptied.text}. If the user means to give that key${need ? ` for "${need.label}"` : ""}, they give it on the Vault, at the top of Keys.`,
    taken: null,
  };
}

/** Takes a key from the slot, if NEW_KEY holds one (see above): what to tell the user, and the key
 *  taken, if one was. A name that is another secret's empties the slot and says why; with no key
 *  asked for, or where the vault can't keep it, the key stays in NEW_KEY for a later call, and the
 *  answer says why. */
export async function collect(): Promise<{ text: string; taken: Taken | null } | null> {
  const value = setting(HUB_ID, SLOT);
  if (!value) return null;
  const need = page.keyNeeds().at(-1);
  if (repeated(HUB_ID, SLOT, value)) {
    const said = await again(value, need);
    if (said) return said;
  }
  if (!need) return { text: `NEW_KEY (${SETTINGS}) holds a key, but the library didn't ask for one, so it doesn't know which site it goes to: it stays there. Ask with secret for the service the user means, and the next call takes it.`, taken: null };
  const taken: Taken = { site: need.site, label: need.label };
  try {
    await vault.update((v) => {
      secrets.putKey(v, taken.site, taken.label, value);
      remember(v, HUB_ID, SLOT, value);
      remember(v, HUB_ID, GIVEN_FOR, givenFor(taken, value));
    });
  } catch (e) {
    // The library's own refusal (a name that is another secret's) is final; the vault's (closed,
    // busy, not writable) passes, so the key waits in NEW_KEY for the next call.
    if (e instanceof LibraryError) return { text: `The key in NEW_KEY (${SETTINGS}) wasn't kept: ${e.message.replace(/\.$/, "")}. ${empty().text}.`, taken: null };
    if (e instanceof Told) return { text: `The key in NEW_KEY (${SETTINGS}) can't be kept yet: ${e.message.replace(/\.$/, "")}. It stays in NEW_KEY for the next call.`, taken: null };
    console.error(`library-lean couldn't save the key in NEW_KEY: ${(e as Error)?.stack ?? e}`);
    return { text: `The key in NEW_KEY (${SETTINGS}) couldn't be saved in the Vault (${why(e)}): it stays in NEW_KEY for the next call. Tell the user it wasn't saved; AnythingLLM's log has the detail.`, taken: null };
  }
  // Read back: the answer says saved only for a key the vault holds now.
  if (secrets.savedAs(value)?.label.toLowerCase() !== taken.label.toLowerCase())
    return { text: `The key in NEW_KEY (${SETTINGS}) was written to the Vault but isn't in it when read back (${vault.vaultDir()}): it stays in NEW_KEY. Tell the user it wasn't saved; AnythingLLM's log may say why.`, taken: null };
  await page.met(taken.label);
  return { text: `Saved the key "${taken.label}" for ${taken.site} from NEW_KEY (${SETTINGS}) into the Vault, sealed; ${empty().text}. Tell the user it's saved, by its name only.`, taken };
}
