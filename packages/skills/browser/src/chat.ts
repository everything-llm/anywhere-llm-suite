// The chat a chat's tab belongs to, for the chat bar on its page, which sends the user's message to
// that chat through AnywhereLLM's channel: AnythingLLM's thread, as AnywhereLLM names it (its slug)
// and shows it (its name). A tab is kept by its thread's id (scope.ts), which is all AnythingLLM's
// invocation carries, so the slug and name are read from AnythingLLM's own thread model, in its
// process (models/workspaceThread.js beside its server). A chat through AnythingLLM's developer API
// (AnywhereLLM Lite's) has no thread in its invocation, and its tab ("_", "api-<n>") none here
// either: AnywhereLLM sends to the chat it has open. Where the model can't be reached (not inside
// AnythingLLM) or has no such thread, the same.

import { createRequire } from "node:module";
import path from "node:path";
import { perProcess, serverDir } from "#shared/anythingllm";

export type Chat = { thread: string | null; name: string | null };

const NONE: Chat = { thread: null, name: null };
/** How long a thread's name is kept before it's read again (a thread renamed meanwhile). */
const FRESH_MS = 60 * 1000;

type ThreadModel = { get(clause: { id: number }): Promise<{ slug?: unknown; name?: unknown } | null> };

/** AnythingLLM's thread model, or null where there's none to load. */
function threads(): ThreadModel | null {
  try {
    const { WorkspaceThread } = createRequire(path.join(serverDir(), "index.js"))("./models/workspaceThread.js");
    return WorkspaceThread && typeof WorkspaceThread.get === "function" ? WorkspaceThread : null;
  } catch {
    return null;
  }
}

/** The chat of the tab kept under `key` (its thread's id, from the invocation): its thread's slug
 *  and name, or nulls where it has no thread AnythingLLM knows. */
export async function chatOf(key: string): Promise<Chat> {
  if (!/^\d+$/.test(key)) return NONE;
  const known = perProcess("browser-lean.chats", () => new Map<string, Chat & { at: number }>());
  const was = known.get(key);
  if (was && Date.now() - was.at < FRESH_MS) return { thread: was.thread, name: was.name };
  const model = threads();
  if (!model) return NONE;
  try {
    const row = await model.get({ id: Number(key) });
    const chat: Chat = row && typeof row.slug === "string" && row.slug ? { thread: row.slug, name: typeof row.name === "string" && row.name ? row.name.slice(0, 200) : null } : NONE;
    known.set(key, { ...chat, at: Date.now() });
    return chat;
  } catch {
    return was ? { thread: was.thread, name: was.name } : NONE;
  }
}
