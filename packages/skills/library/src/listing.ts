// The library's functions, listed at the end of the skill's own description (#shared/anythingllm
// SAVED_NOW), and the runs that ended with no answer showing them yet: AnythingLLM reads plugin.json
// again for each agent run, so the model sees what's saved without calling library first, picks a
// saved function over a web search, and knows a background run ended. Refreshed where either changes
// (after every call, a background run's end, and the page's deletes); written as the skill's own
// settings are (#shared/settings), and only when the list changed.

import { SAVED_NOW } from "#shared/anythingllm";
import { changePlugin } from "#shared/settings";
import { unseen } from "./runs";
import * as store from "./store";

const HUB_ID = "library-lean";
/** At most this many functions are listed; the rest are left to library. */
const MAX = 25;

/** The list as the description ends with it; empty while nothing is saved. */
function listing(): string {
  const fns = store.services().flatMap((service) => store.functions(service).map((f) => `${service}.${f.name} (${f.description.slice(0, 80)})`));
  if (!fns.length) return "";
  const more = fns.length > MAX ? `; ${fns.length - MAX} more: call library` : "";
  const ended = unseen().map((r) => `${r.fn} (${r.status}, ${r.id})`);
  const told = ended.length ? ` Ended, not shown to the user yet: ${ended.slice(0, 5).join("; ")}: call library, which shows them.` : "";
  return `${SAVED_NOW} ${fns.slice(0, MAX).join("; ")}${more}. When one does what's asked, run it (run, name) rather than searching the web.${told}`;
}

/** Ends the installed skill's description with the list as it is now. With no plugin.json where
 *  AnythingLLM keeps the skill (a test, a bundle run elsewhere), there's nothing to write; a list or
 *  a write that fails is logged, since the list is a hint and the change it follows stands. */
export function refresh(log?: (message: string) => void): void {
  try {
    changePlugin(HUB_ID, (config) => {
      const description = String(config.description ?? "");
      const next = description.split(SAVED_NOW)[0] + listing();
      if (next === description) return false;
      config.description = next;
      return true;
    });
  } catch (e) {
    log?.(`library-lean couldn't list its functions in its description: ${(e as Error).message}`);
  }
}
