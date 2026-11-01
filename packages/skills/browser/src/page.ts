// A tab's card and its page. After each step the tab's picture is taken and written into
// AnythingLLM's public folder (public/browser-lean/, served to any browser), with a small state file
// beside it (its title and address, what the agent asks the user for, where the Vault is) and
// the tab's page (static/pages/tab.html), all under a random name kept for the chat's tab. The card
// the agent puts in its reply is a crop of the picture that opens the page.
//
// The page is where the user gives what only they may know: a login or a code the agent asked for,
// sealed on their device with the vault's public key, posted through AnythingLLM's browser-extension
// upload (#shared/pages), checked against the tab's secret and typed into the tab here; never on
// AnythingLLM's question card, which shows its answers in the chat. There they also take the tab
// over to use it themselves (takeover.ts) and save what it offers. The saved logins are listed and
// deleted on the Vault (#shared/vault-page), whose logins section this skill writes and applies,
// and which the tab's page links to, unless the links are kept from the agent (#shared/page-links).
// Events are applied as they come while a page was shown lately, and at the start of each call.
//
// Each tab's page shows the workspace's tabs along its top (each chat's, and the ones the user
// opened), and a new tab's home, where the user searches or types an address: that opens a tab of
// their own (browser.ts openYours), drawn and posted to like a chat's, but never the agent's. Its
// state, picture and page are in the same public folder, under a token no answer of the agent's
// carries, and the fence keeps the agent off that folder (#shared/fence pathRefused).
//
// A tab that closed (from its page, or with its browser, past its idle time) keeps its page's frame:
// its state says it closed, with the workspace's tabs and sites still in it, and its page shows a new
// tab's home in the tab's place. For CLOSED_MS that page may ask for one thing, a tab of the user's
// own (`new`), with its tab's key and secret, which stay in tabs.json marked closed (`closedUntil`)
// and are checked as an open tab's are; nothing else it posts is applied. Its token goes dead for good
// once that time is up, or once its key gets new names (its chat's thread opens a tab again; a tab of
// the user's own never takes a kept key): its state then says only that it closed. A tab whose
// browser went with AnythingLLM (a restart writes nothing) may ask too, once its state's `until` is
// past, and is marked closed as of then when it does. A scheduled job's tabs close at once, as before.

import fs from "node:fs";
import path from "node:path";
import * as addresses from "#shared/addresses";
import { jobTimeLeft, perProcess } from "#shared/anythingllm";
import { readJson as readJsonOr, writeJson } from "#shared/atomic";
import { Told } from "#shared/errors";
import { checkUrl, hostOf, makeFence } from "#shared/fence";
import * as logins from "#shared/logins";
import { linksHidden, noteTabs, type TabLink } from "#shared/page-links";
import { inTurn, newSecret, pageHtml, publicPath, readPublic, removePublic, sameSecret, takeEvents, watch, writePublic } from "#shared/pages";
import * as vault from "#shared/vault";
import * as vaultPage from "#shared/vault-page";
import { type Unsent, isUnsent, submitted, typeIn } from "./act";
import { MAX_YOURS, TO_USER, closeTab, entryFor, openYours, refusal } from "./browser";
import * as passkey from "./passkey";
import { searchAt } from "./research";
import { JOBS } from "./scope";
import { type Snap, asksPassword, fieldOf, isPasswordLine, lineOf, readPage } from "./snapshot";
import { type Entry, IDLE_MS, NEED_MS, type Need, OFFER_MS, type Tab, VIEWPORT, clip, holder, lineAfter, live, note, say, state, statics, tabOf, workspaceDir } from "./state";
import * as takeover from "./takeover";

const TITLE = "browser-lean-event";
/** How long the pages' events are watched for after one was last shown. */
const WATCH_MS = 30 * 60 * 1000;
const QUALITY = 70;
/** A tab's pictures: the whole, and the card's crop. Beside them are its state and its page. */
const PICTURES = [".jpg", "-card.jpg"];
const MAX_TEXT = 500;
/** How long a closed tab's page may still ask for a tab of the user's own, from its home. */
const CLOSED_MS = 2 * 60 * 60 * 1000;
/** At most this many closed tabs' pages may, per workspace: the ones that closed last. */
const MAX_CLOSED = 16;
/** How lately a closed tab's page asked for a tab, by AnythingLLM's clock as the page has it, for it
 *  to be opened: one that waited out a restart opens nothing, as its page stopped waiting. */
const FRESH_MS = 60 * 1000;

/** The page as just read, for drawing it: its title, and its elements and fields. */
type Read = { snap: Snap; title: string };

/** A thread's tab's names, kept in tabs.json under its key: its token names its files; its secret
 *  goes with every event its page posts. Once the tab closed, `closedUntil` says until when its page
 *  may still ask for a tab of the user's own, and what its frame shows meanwhile besides the
 *  workspace's tabs: its site among Your sites (`host`), the Vault's link (`vault`) and a line from the
 *  skill (`msg`: why a tab didn't open). */
type Names = { token: string; secret: string; closedUntil?: number; host?: string; vault?: string; msg?: Line };
type Line = ReturnType<typeof lineAfter>;

const tabsFile = (workspace: string) => path.join(workspaceDir(workspace), "tabs.json");
/** A tab's file in the public folder, by its ending: a picture's (PICTURES), ".json" or ".html". */
const pub = (token: string, ending: string) => `browser-lean/${token}${ending}`;

function readTabs(workspace: string): Record<string, Names> {
  try {
    return readJsonOr<Record<string, Names>>(tabsFile(workspace), () => ({})) ?? {};
  } catch {
    return {}; // no such workspace, or a file that isn't one
  }
}

const saveTabs = (workspace: string, tabs: Record<string, Names>) => writeJson(tabsFile(workspace), tabs);

/** Whether a key has names in tabs.json, an open tab's or a closed one's: a tab of the user's own
 *  takes another (browser.ts openYours), so it never replaces a closed one's page. */
export const hasNames = (workspace: string, key: string): boolean => key in readTabs(workspace);

/** A thread's tab's names, made the first time. A closed tab's under the same key are replaced: its
 *  page goes, and may ask for nothing again. */
function namesOf(workspace: string, key: string): Names {
  const tabs = readTabs(workspace);
  const was = tabs[key];
  if (was?.token && was.secret && !was.closedUntil) return was;
  if (was?.closedUntil) deadPage(was.token);
  tabs[key] = { token: newSecret(), secret: newSecret(24) };
  saveTabs(workspace, tabs);
  return tabs[key];
}

/** A closed tab's page that may ask for nothing again: its page goes, and its state says only that it
 *  closed. */
function deadPage(token: string): void {
  try {
    removePublic(pub(token, ".html"));
    writePublic(pub(token, ".json"), JSON.stringify({ closed: true }));
  } catch {
    // no folder to write in
  }
}

/** Drops from `tabs` (a workspace's tabs.json) the closed tabs whose time is up and those past
 *  MAX_CLOSED, their pages gone dead; notes until when the newest left may ask, for the watch.
 *  Answers whether any went. */
function prune(workspace: string, tabs: Record<string, Names>): boolean {
  const now = Date.now();
  const closed = Object.entries(tabs)
    .filter(([, n]) => n.closedUntil)
    .sort((a, b) => b[1].closedUntil! - a[1].closedUntil!);
  let went = false;
  closed.forEach(([key, n], i) => {
    if (n.closedUntil! > now && i < MAX_CLOSED) return;
    delete tabs[key];
    deadPage(n.token);
    went = true;
  });
  const newest = closed.find(([key]) => key in tabs)?.[1].closedUntil;
  if (newest) watching().closed.set(workspace, newest);
  else watching().closed.delete(workspace);
  return went;
}

/** What each workspace's closed tabs' states were last written from, to write them again only when
 *  that changes. */
const stamped = () => perProcess("browser-lean.stamped", () => new Map<string, string>());

/** A closed tab's state: that it closed, until when its page may ask for a tab, and its frame: the
 *  workspace's open tabs along the top (`tabs`), Your sites (`shown`) with its own first, the Vault's
 *  link (none while the links are kept from the agent) and the skill's line while it lasts. */
function closedState(n: Names, tabs: StripTab[], shown: string[]) {
  const msg = n.msg && n.msg.until > Date.now() ? { text: n.msg.text, id: n.msg.id } : null;
  const sites = n.host && !shown.includes(n.host) ? [n.host, ...shown].slice(0, 12) : shown;
  return { closed: true, until: n.closedUntil, tabs, sites, vault: linksHidden() ? null : (n.vault ?? null), msg };
}

/** Writes each closed tab's state of a workspace's (in `tabs`, its tabs.json) with its browser's open
 *  tabs (`strip`) and Your sites (`shown`); only when one of those, the closed tabs or their lines
 *  changed since the last time. */
function stampClosed(workspace: string, tabs: Record<string, Names>, strip: StripTab[], shown: string[]): void {
  const closed = Object.values(tabs).filter((n) => n.closedUntil);
  const now = Date.now();
  const stamp = JSON.stringify([strip, shown, linksHidden(), closed.map((n) => [n.token, n.closedUntil, n.msg && n.msg.until > now ? n.msg.id : 0])]);
  if (stamped().get(workspace) === stamp) return;
  stamped().set(workspace, stamp);
  for (const n of closed) {
    try {
      writePublic(pub(n.token, ".json"), JSON.stringify(closedState(n, strip, shown)));
    } catch {
      // no folder to write in
    }
  }
}

/** Puts `text` on the page of a closed tab (`key`'s), as say does on an open one's: its line kept in
 *  tabs.json, and its state alone written again. */
function sayClosed(workspace: string, key: string, text: string): void {
  const tabs = readTabs(workspace);
  const n = tabs[key];
  if (!n?.closedUntil) return;
  n.msg = lineAfter(n.msg, text);
  try {
    saveTabs(workspace, tabs);
    const st = JSON.parse(readPublic(pub(n.token, ".json")) ?? "null");
    if (st?.closed) writePublic(pub(n.token, ".json"), JSON.stringify({ ...st, msg: { text: n.msg.text, id: n.msg.id } }));
  } catch {
    // no folder to write in
  }
}

/** When tabs close (`keys`, at `goneAt`, now unless said): their pictures go and their states say they
 *  closed. Each one's names stay in tabs.json, marked closed: its page keeps its frame and may ask for
 *  a tab of the user's own until CLOSED_MS after (then it goes), and the next tab under its key gets
 *  new names. Not a scheduled job's (its workspace's, or in its process): their pages go at once. The
 *  workspace's tabs.json is read and written, and its pages stamped and listed, once. */
export function forgetTabs(workspace: string, keys: string[], goneAt = Date.now()): void {
  const tabs = readTabs(workspace);
  const keep = workspace !== JOBS && jobTimeLeft() === null;
  let went = false;
  for (const key of keys) {
    const n = tabs[key];
    if (!n?.token || n.closedUntil) continue;
    went = true;
    try {
      for (const ending of PICTURES) removePublic(pub(n.token, ending));
    } catch {
      // no folder to write in
    }
    const last = keep ? stateOf(n)?.st : null;
    if (!last) {
      delete tabs[key];
      deadPage(n.token);
    } else tabs[key] = { token: n.token, secret: n.secret, closedUntil: goneAt + CLOSED_MS, host: clip(last.host, 300) || undefined, vault: typeof last.vault === "string" ? last.vault : undefined };
  }
  if (!went) return;
  prune(workspace, tabs);
  try {
    saveTabs(workspace, tabs);
  } catch {
    return; // no folder to write in
  }
  const entry = state().browsers.get(workspace);
  if (entry) restamp(workspace, entry, tabs);
  else {
    stampClosed(workspace, tabs, [], sites(new Map()));
    listTabs(workspace, new Map());
  }
  if (keep) watchFor();
}

/** Until when a tab that isn't open here (`n`) may still ask for a tab of the user's own: its closed
 *  time's end; or, where its state says its browser's time ran out though it was never marked closed
 *  (it went with AnythingLLM, which writes nothing as it goes), CLOSED_MS after that. 0 for one whose
 *  time isn't out: it may be open in another process (a scheduled job's). */
function asksUntil(n: Names): number {
  if (n.closedUntil) return n.closedUntil;
  const until = Number(stateOf(n)?.st.until);
  return until <= Date.now() ? until + CLOSED_MS : 0;
}

/** Until when the pages' events are watched, in this process: an open tab's page WATCH_MS after it was
 *  last drawn (`open`), and each workspace's newest closed tab's page while it may ask (`closed`, kept
 *  by prune, so one that ended shortens it). */
const watching = () => perProcess("browser-lean.watching", () => ({ open: 0, closed: new Map<string, number>() }));

/** Watches the pages' events while an open tab's page was drawn lately (until `open`, at least) or a
 *  closed one's may still ask for a tab. */
function watchFor(open = 0): void {
  const w = watching();
  w.open = Math.max(w.open, open);
  watch(TITLE, drain, () => Math.max(w.open, ...w.closed.values()));
}

/** How far a browser's closing time moves before its tabs are listed, and their states stamped,
 *  again with it. */
const RELIST_MS = 60 * 1000;

/** What each workspace's tabs were last listed as, to list them again only when that changes. */
const listed = () => perProcess("browser-lean.listed", () => new Map<string, { tokens: string; until: number }>());

/** Lists a workspace's drawn tabs (`drawn`, read again when not given) in the links file
 *  (#shared/page-links), for AnywhereLLM Lite's Browser row: each one's page, and when the browser
 *  closes. Again only when a tab came or went, or the closing time moved RELIST_MS (each tab's state
 *  has it exactly). None of a scheduled job's. */
function listTabs(workspace: string, drawn?: Map<string, Drawn>): void {
  if (workspace === JOBS) return;
  const entry = state().browsers.get(workspace);
  const until = entry ? entry.last + IDLE_MS : 0;
  const tabs: TabLink[] = [...(drawn ?? drawnTabs(workspace, entry)).values()].map(({ names, st }) => ({ path: `/${pub(names.token, ".html")}`, workspace, until, drawn: Number(st.shot) || 0 }));
  const tokens = tabs.map((t) => t.path).sort().join(" ");
  const was = listed().get(workspace);
  if (was && was.tokens === tokens && Math.abs(until - was.until) < RELIST_MS) return;
  listed().set(workspace, { tokens, until });
  void noteTabs(workspace, tabs);
}

/** Every tab of a workspace's browser: its chats', then the ones the user opened. */
const keysOf = (entry: Entry): string[] => [...entry.tabs.keys(), ...entry.yours.keys()];

/** A drawn tab's names, and its state as last written (`st`, parsed from `text`). */
type Drawn = { names: Names; text: string; st: Record<string, any> };

/** A tab's state as last written, by its names, or null where it isn't drawn (or closed). */
function stateOf(names: Names | undefined): Drawn | null {
  if (!names?.token || !names.secret) return null;
  try {
    const text = readPublic(pub(names.token, ".json"));
    const st = text ? JSON.parse(text) : null;
    return st && !st.closed ? { names, text: text!, st } : null;
  } catch {
    return null;
  }
}

/** The drawn tabs of a workspace's browser, by key, in keysOf's order, from tabs.json (`names`, read
 *  when not given) and each one's state, each read once; `here`'s as given (a tab being drawn now) in
 *  place of its state's. */
function drawnTabs(workspace: string, entry: Entry | undefined, here?: [key: string, drawn: Drawn], names = readTabs(workspace)): Map<string, Drawn> {
  const drawn = new Map<string, Drawn>();
  for (const key of entry ? keysOf(entry) : []) {
    const there = here && key === here[0] ? here[1] : stateOf(names[key]);
    if (there) drawn.set(key, there);
  }
  return drawn;
}

/** One of the tabs along the top of a tab's page: its page (beside this one in the public folder,
 *  which the page knows itself by), its title and host, whether the agent has it (a chat's tab the
 *  user doesn't hold), and the id the page that asked for it gave (`made`, a tab of the user's own). */
type StripTab = { path: string; title: string; host: string; agent: boolean; made: string | null };

/** The workspace's tabs along the top of each of its pages: the open ones of those `drawn`. */
function strip(workspace: string, entry: Entry, drawn: Map<string, Drawn>): StripTab[] {
  const tabs: StripTab[] = [];
  for (const [key, { names, st }] of drawn) {
    const at = tabOf(workspace, entry, key);
    if (at) tabs.push({ path: `${names.token}.html`, title: clip(st.title, 200), host: clip(st.host, 300), agent: at.owner === "chat" && !entry.holds.has(key), made: entry.yours.get(key)?.made ?? null });
  }
  return tabs;
}

/** Your sites, on a new tab's home: the sites with a saved login first, then the hosts of the tabs
 *  `drawn`. */
function sites(drawn: Map<string, Drawn>): string[] {
  let saved: string[] = [];
  try {
    saved = logins.list().map((l) => l.site);
  } catch {
    // the vault can't be opened: the open tabs' sites alone
  }
  const open = [...drawn.values()].map(({ st }) => st.host as string | undefined);
  return [...new Set([...saved, ...open].filter((h): h is string => !!h))].slice(0, 12);
}

/** Writes when a workspace's browser closes, its tabs along the top and its sites, into each of its
 *  tabs' states that's there: a step in one chat keeps every tab of the workspace open, and a tab
 *  that came or went, or a login saved, shows on every page. A state is written again only when its
 *  tabs or sites changed, or the closing time moved RELIST_MS (a draw writes it exactly). The closed
 *  tabs' pages get the same tabs and sites (stampClosed), and those whose time is up go (`tabs`: the
 *  workspace's tabs.json, read when not given). */
export function restamp(workspace: string, entry: Entry, tabs = readTabs(workspace)): void {
  if (prune(workspace, tabs)) {
    try {
      saveTabs(workspace, tabs);
    } catch {
      // no folder to write in: pruned again next time
    }
  }
  const until = entry.last + IDLE_MS;
  const drawn = drawnTabs(workspace, entry, undefined, tabs);
  const along = strip(workspace, entry, drawn);
  const shown = sites(drawn);
  const now = JSON.stringify([along, shown]);
  for (const { names, text, st } of drawn.values()) {
    if (Math.abs(until - (Number(st.until) || 0)) < RELIST_MS && JSON.stringify([st.tabs, st.sites]) === now) continue;
    try {
      writePublic(pub(names.token, ".json"), JSON.stringify({ ...st, until, tabs: along, sites: shown }), text);
    } catch {
      // no folder to write in, or a state that isn't one: the next draw writes it whole
    }
  }
  stampClosed(workspace, tabs, along, shown);
  listTabs(workspace, drawn);
}

/** What the agent waits for the user to enter on the tab's page, or null: one that ran out goes. */
const pendingNeed = (entry: Entry, key: string): Need | null => live(entry.needs, key);

/** Text a card's Markdown can hold: no brackets or line breaks. */
const plain = (text: string, n = 120) => text.replace(/[[\]()\n\r|*_`<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Whether the tab can go back and forward, as its page's Navigation API says; both, where it
 *  can't say (an error page has none). */
async function history(page: Tab["page"]): Promise<{ back: boolean; forward: boolean }> {
  try {
    return await page.evaluate((_: { history: true }) => {
      const nav = (globalThis as any).navigation;
      return nav ? { back: !!nav.canGoBack, forward: !!nav.canGoForward } : { back: true, forward: true };
    }, { history: true });
  } catch {
    return { back: true, forward: true };
  }
}

/** The tab's state, as its page reads it: nothing secret. Who has the tab; while the user does, the
 *  fields in view, for the page to type into. A tab the user opened (`mine`) is always theirs. */
function tabState(at: Tab, names: Names, title: string, url: string, snap: Snap, vaultLink: string | null, nav: { back: boolean; forward: boolean }) {
  const host = hostOf(url);
  const drawn = drawnTabs(at.workspace, at.entry, [at.key, { names, text: "", st: { title, host } }]);
  const need = pendingNeed(at.entry, at.key);
  const screen = at.page.viewport() ?? VIEWPORT;
  const held = !!holder(at);
  const msg = live(at.entry.msgs, at.key);
  return {
    title: title.slice(0, 200),
    url: url.slice(0, 2000),
    host,
    mine: at.owner === "user",
    tabs: strip(at.workspace, at.entry, drawn),
    sites: sites(drawn),
    back: nav.back,
    forward: nav.forward,
    shot: Date.now(),
    until: at.entry.last + IDLE_MS,
    size: { w: screen.width, h: screen.height },
    who: held ? "user" : "agent",
    fields: held ? snap.fields : [],
    need: need ? { kind: need.kind, host: need.host, text: need.text, label: need.label ?? null, hasUser: !!need.userRef, confirm: !!need.confirmRef, until: need.until } : null,
    offer: takeover.shownOffer(at.entry, at.key),
    msg: msg && { text: msg.text, id: msg.id },
    vault: vaultLink,
  };
}

/** Takes the tab's picture (and with `card`, the card's crop) and writes its state, from the page as
 *  just read, and its page (with the card, or when it has none); answers the page's token, or null
 *  where AnythingLLM's public folder can't be written (AnythingLLM Desktop) or no page key is set. */
async function draw(at: Tab, card: boolean, { snap, title }: Read): Promise<string | null> {
  await takeover.keepOffer(at, asksPassword(snap)); // before the state shows the offer
  const names = namesOf(at.workspace, at.key);
  try {
    const shot = publicPath(pub(names.token, ""));
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    // Every tab is drawn as if it had the focus (browser.ts adopt), so its picture is taken where it is.
    // Its history and the Vault page are read and written meanwhile; the Vault page is written either
    // way, and its link goes into the tab's state (which the agent's card carries) only while the
    // links aren't kept from the agent (#shared/page-links, read each time).
    const pictured = (async () => {
      await at.page.screenshot({ path: `${shot}.jpg`, type: "jpeg", quality: QUALITY });
      if (!card) return;
      const { width, height } = at.page.viewport() ?? VIEWPORT;
      await at.page.screenshot({ path: `${shot}-card.jpg`, type: "jpeg", quality: QUALITY, clip: { x: 0, y: 0, width, height: Math.min(height, Math.round(width * 1.2)), scale: 0.5 } });
    })();
    const [, nav, vaultLink] = await Promise.all([pictured, history(at.page), showVault()]);
    writePublic(pub(names.token, ".json"), JSON.stringify(tabState(at, names, title, at.page.url(), snap, linksHidden() ? null : vaultLink, nav)));
    if (card || !fs.existsSync(`${shot}.html`)) writePublic(pub(names.token, ".html"), await pageHtml(statics().get("pages/tab.html")!.text, { token: names.token, secret: names.secret, title: TITLE, workspace: at.workspace, tab: at.key, address: ADDRESS.source }));
  } catch {
    return null;
  }
  listTabs(at.workspace);
  watchFor(Date.now() + WATCH_MS);
  return names.token;
}

/** Draws the tab `at` for the agent's answer, from the page as just read: its card's Markdown lines
 *  (a crop of its picture that opens its page, then its title and address; those alone where there's
 *  no picture) and whether it has a page the user can answer on. While the user is asked to sign in
 *  there (a login or a code), the title reads "Sign in · <title>", as the canvas's card has it. `base`
 *  is the address the user's browser reaches AnythingLLM at (null: links from its own root). */
export async function card(at: Tab, base: string | null, read: Read): Promise<{ lines: string[]; page: boolean }> {
  const token = await draw(at, true, read);
  const { title } = read;
  const url = at.page.url();
  const host = hostOf(url);
  const name = (pendingNeed(at.entry, at.key) ? "Sign in · " : "") + (plain(title) || plain(host || url));
  const lines = [`**${name}** · ${plain(host || url, 200)}`];
  if (!token) return { lines, page: false };
  const link = `${base ?? ""}/browser-lean/${token}`;
  return { lines: [`[![${name}](${link}-card.jpg?v=${Date.now().toString(36)})](${link}.html)`, "", ...lines], page: true };
}

const NOTHING_READ: Snap = { elements: [], text: "", more: false, fields: [] };

/** Draws `at` for its page alone: read only when the user holds it (its fields) or an offer waits on
 *  the page asking for a password; the picture and the title otherwise. */
async function redrawn(at: Tab): Promise<void> {
  if (tabOf(at.workspace, at.entry, at.key)?.page !== at.page) return; // closed meanwhile: nothing to draw, and no names to make again
  const read = holder(at) || at.entry.offers.has(at.key) ? await readPage(at.page) : { snap: NOTHING_READ, title: await at.page.title().catch(() => "") };
  await draw(at, false, read);
}

/** Draws a thread's tab again, for its page, in turn with the events' passes: what changed there came
 *  from outside a step (a passkey a site made, say). */
export const redraw = (workspace: string, entry: Entry, key: string): Promise<void> =>
  inTurn(TITLE, async () => {
    const at = tabOf(workspace, entry, key);
    if (at) await redrawn(at);
  });

const text = (v: unknown, n = MAX_TEXT) => clip(v, n);

/** What reads as an address in the home's field: one with a scheme, or a host (with a port and a
 *  path, perhaps), and no space. The tab's page has it too (its config's `address`), for its
 *  suggestions. */
const ADDRESS = /^(https?:\/\/\S*|(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?)$/i;

/** What the user typed into the home's field, as an address (ADDRESS); null for words to search for. */
function addressOf(q: string): string | null {
  if (!ADDRESS.test(q)) return null;
  try {
    return checkUrl(q);
  } catch {
    return null;
  }
}

/** A search or an address typed on a tab's page (`q`, as `e` has it; nothing for none): opens a tab
 *  of the user's own there, in the workspace's browser (launched if it isn't running: for a closed
 *  tab's page), through the fence and within MAX_YOURS, both asked before a browser is launched, with
 *  the fence asked then given to it. The page that asked finds it by `made` along its tabs; what
 *  can't be opened is said there (`tell`), and a load that failed on the new tab's own page. Answers
 *  the tab, or null. */
async function openOwn(workspace: string, e: Record<string, unknown>, tell: (line: string) => void): Promise<Tab | null> {
  const q = text(e.q, 2000).trim();
  if (!q) return null;
  const running = state().browsers.get(workspace);
  if ((running?.yours.size ?? 0) >= MAX_YOURS) return tell(`You have ${MAX_YOURS} tabs of your own open. Close one, then try again.`), null;
  const url = addressOf(q) ?? searchAt(q);
  const fence = running?.fence ?? makeFence();
  if (await fence(url)) return tell(refusal(url, TO_USER)), null;
  const { at, failed } = await openYours(workspace, await entryFor(workspace, fence), url, text(e.made, 40));
  if (failed) say(at.entry, at.key, `Couldn’t open ${hostOf(url) || "that address"}. Check the address, then try again.`);
  return at;
}

/** `new` from the page of the open tab `at`: a tab of the user's own (openOwn), drawn. */
async function openFrom(at: Tab, e: Record<string, unknown>): Promise<boolean> {
  const yours = await openOwn(at.workspace, e, (line) => say(at.entry, at.key, line));
  if (yours) await redrawn(yours);
  return true;
}

/** `new` from the page of a tab that isn't open while it may still ask (drain checked its secret and
 *  asksUntil), the one thing such a page may ask for: a tab of the user's own, as from an open tab's
 *  page. Only when asked lately (FRESH_MS); not a scheduled job's, nor in a job's process, whose
 *  browser ends with the job. A tab that went with AnythingLLM is marked closed first, as of when its
 *  browser would have closed, so its page finds the new tab along its top. Answers the tab opened,
 *  for the caller to draw, or null. */
async function fromClosed(workspace: string, key: string, n: Names, e: Record<string, unknown>): Promise<Tab | null> {
  if (!(Math.abs(Date.now() - Number(e.at)) < FRESH_MS) || workspace === JOBS || jobTimeLeft() !== null) return null;
  if (!n.closedUntil) forgetTabs(workspace, [key], Number(stateOf(n)?.st.until));
  const tell = (line: string) => sayClosed(workspace, key, line);
  try {
    return await openOwn(workspace, e, tell);
  } catch {
    tell("The browser couldn’t open a tab. Try again in a moment.");
    return null;
  }
}

/** Closes the tab `at` from its page; a chat's tab not while its agent is in the middle of a step. */
async function closeFrom(at: Tab): Promise<boolean> {
  if (at.owner === "chat" && at.entry.busy.has(at.key)) return say(at.entry, at.key, "The agent is busy. Try again in a moment."), true;
  await closeTab(at);
  return false; // gone: nothing to draw
}

/** Applies one event the page of `at` posted; answers whether the tab changed. */
async function apply(e: Record<string, unknown>, at: Tab): Promise<boolean> {
  if (takeover.EVENTS.has(String(e.ev))) return takeover.apply(e, at);
  if (e.ev === "new") return openFrom(at, e);
  if (e.ev === "close") return closeFrom(at);
  const need = pendingNeed(at.entry, at.key);
  if (e.ev === "need-cancel") {
    const instead = e.reason === "takeover";
    if (need) note(at, instead ? "the user is taking the tab over to enter it themselves instead; wait for them to hand it back, then read the page" : "the user chose not to enter it now, so nothing was typed; tell them you can't go on without it");
    at.entry.needs.delete(at.key);
    return !!need;
  }
  if (e.ev !== "need-answer" || !need) return false;
  const login = need.kind === "login";
  const secret = login ? vault.openSealed(text(e.sealed, 20000)) : text(e.text).trim();
  const user = login ? text(e.user).trim() : "";
  if (!secret || (need.userRef && !user)) return false;
  at.entry.needs.delete(at.key);
  const left = await typeIn(at, need.host, { userRef: need.userRef, user, secretRef: need.secretRef, confirmRef: need.confirmRef, secret, keys: !login }, need.submitRef);
  if (login && need.userRef && e.save === true) at.entry.offers.set(at.key, { kind: "password", site: need.host, user, pass: secret, agreed: true, until: Date.now() + OFFER_MS });
  const sent = `the user entered ${login ? "the login" : "the code"} you asked for on the tab's page and it was typed into the page${submitted(need.submitRef, left)}`;
  const hidden = "it stays hidden from you. Read the page to see whether it worked";
  if (isUnsent(left)) {
    // Not sent, so nothing was refused: the form needs something else first (a CAPTCHA, say).
    say(at.entry, at.key, oneMore(left));
  }
  const asking = need.submitRef && !isUnsent(left) ? await stillAsks(at, need) : null;
  if (!asking) return note(at, `${sent}; ${hidden}`), true;
  // Likely refused: a login the user asked to save isn't kept; they're asked again where the same
  // field is still there, else told on the page.
  at.entry.offers.delete(at.key);
  const it = login ? "a password" : "the code";
  const refused = `${sent}, but the page still asks for ${it}: the site may have refused it.`;
  if (asking === "same") {
    at.entry.needs.set(at.key, { ...need, text: `${MAYBE_REFUSED} Enter it again.`, until: Date.now() + NEED_MS });
    note(at, `${refused} The user is asked again on the tab's page; wait for them, then read the page`);
  } else {
    say(at.entry, at.key, MAYBE_REFUSED);
    note(at, `${refused} Read the page, tell the user, and use login again if they want to retry`);
  }
  return true;
}

/** What the page says when the site still asks for a login or a code after it was sent. */
const MAYBE_REFUSED = "It may not have been accepted.";

/** What the page says when an answer was typed but its form can't be sent yet: the fields it still
 *  asks for, by their labels, or that it needs something else (a CAPTCHA, say). */
function oneMore({ missing, disabled }: Unsent): string {
  const labels = missing.map((m) => m.label).filter(Boolean);
  if (disabled || !labels.length) return "One more step: the page needs something else first. Take the tab over to do it.";
  const quoted = labels.map((l) => `“${l}”`);
  return `One more step: the page asks you to ${quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : quoted[0]}.`;
}

/** After a login or a code was typed and submitted: whether its site still asks for it. "same" when
 *  the field it went into is still there under its ref (the same kind and label: a new page numbers
 *  its refs again; a login: still a password field), so the same request can go again; "other" when
 *  that field is there under another ref (the page moved it), or a login's page shows another
 *  password field; else null. A guess, not proof: a site that refuses a login usually keeps asking,
 *  and one that takes it moves on. */
async function stillAsks(at: Tab, need: Need): Promise<"same" | "other" | null> {
  if (hostOf(at.page.url()) !== need.host) return null;
  const { snap } = await readPage(at.page);
  const line = lineOf(snap, need.secretRef);
  if (line && (!need.field || fieldOf(line) === need.field) && (need.kind === "code" || isPasswordLine(line))) return "same";
  if (need.field && snap.elements.some((l) => fieldOf(l) === need.field)) return "other";
  return need.kind === "login" && asksPassword(snap) ? "other" : null;
}

/** Applies what the tabs' pages and the Vault posted, for a call, in its turn with the watch's
 *  (#shared/pages inTurn); `base` is AnythingLLM's address as the call has it. */
export const caughtUp = async (base: string | null): Promise<void> => {
  await inTurn(TITLE, drain);
  await vaultPage.inTurnFor("logins", drainLogins);
  await addresses.caughtUp(base);
};

/** Brings the Vault's names in line with the links switch (#shared/page-links) at the start of a call,
 *  a chat's or a scheduled job's, whether or not the call draws a page: with the switch on, the first
 *  call replaces the names the agent may have been given. Nothing without a Vault. */
export const settlePages = (): Promise<void> => vaultPage.settle("logins", drainLogins);

/** The saved logins and passkeys, as the Vault's logins section shows them: never a password or a key. */
const loginsState = () => ({ logins: logins.list() });

/** Writes the Vault with its logins and addresses sections and watches for their events for a while;
 *  answers its path on this host, for the tab's page to link to: on its Logins tab (#logins). */
async function showVault(): Promise<string> {
  const link = await vaultPage.show("logins", loginsState(), drainLogins, null);
  addresses.show(null);
  return `${link}#logins`;
}

/** Applies what the user did in the Vault's logins section since the last time (#shared/vault-page
 *  take checked its secret): a deleted passkey leaves every tab's authenticator at once. Then writes
 *  the section again. */
async function drainLogins(): Promise<void> {
  const events = vaultPage.take("logins");
  if (!events.length) return;
  for (const e of events) {
    if (e.ev === "login-delete") {
      const gone = await logins.remove(text(e.id, 100));
      if (gone?.kind === "passkey") await passkey.forget(gone.credentialId);
    } else if (e.ev === "rotate") await vaultPage.rotate();
  }
  vaultPage.refresh("logins", loginsState());
}

/** Applies every event the tabs' pages posted since the last time, in order, each only with its
 *  tab's secret, checked once; then draws each tab that changed. One that fails is skipped, and its
 *  tab says so. A page whose tab isn't open may ask for a tab of the user's own alone (fromClosed). */
async function drain(): Promise<void> {
  const changed = new Set<Tab>();
  for (const e of takeEvents(TITLE, "browser_lean_event")) {
    const workspace = text(e.workspace, 100);
    const key = text(e.tab, 100);
    const names = readTabs(workspace)[key];
    if (!names?.token || !sameSecret(e.secret, names.secret)) continue; // not this tab's: an old link's, or a forgery
    const entry = state().browsers.get(workspace);
    const open = entry && !names.closedUntil ? tabOf(workspace, entry, key) : null;
    if (!open) {
      // A closed tab's page, or one whose browser went: a tab of the user's own, while it may ask.
      const yours = e.ev === "new" && asksUntil(names) > Date.now() ? await fromClosed(workspace, key, names, e) : null;
      if (yours) changed.add(yours);
      continue;
    }
    const at = [...changed].find((t) => t.page === open.page) ?? open;
    open.entry.touch(); // the browser isn't closed under the user
    try {
      if (await apply(e, at)) changed.add(at);
    } catch (err) {
      if (!(err instanceof Told)) throw err;
      note(at, `what the user entered on the tab's page couldn't be used: ${err.message}`);
      changed.add(at);
    }
  }
  for (const at of changed) at.entry.changed(); // a login typed, a takeover's step: its cookies may have changed
  await Promise.all([...changed].map(redrawn));
  // A tab that came, went or changed hands shows along the top of every page of its workspace.
  for (const [workspace, entry] of new Map([...changed].map((at) => [at.workspace, at.entry]))) restamp(workspace, entry);
}
