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

import fs from "node:fs";
import path from "node:path";
import * as addresses from "#shared/addresses";
import { perProcess } from "#shared/anythingllm";
import { writeJson } from "#shared/atomic";
import { Told } from "#shared/errors";
import { checkUrl, hostOf } from "#shared/fence";
import * as logins from "#shared/logins";
import { linksHidden, noteTabs, type TabLink } from "#shared/page-links";
import { inTurn, newSecret, pageHtml, publicPath, readPublic, removePublic, sameSecret, takeEvents, watch, writePublic } from "#shared/pages";
import * as vault from "#shared/vault";
import * as vaultPage from "#shared/vault-page";
import { setting } from "#shared/settings";
import { type Unsent, isUnsent, submitted, typeIn } from "./act";
import { MAX_YOURS, closeTab, openYours, refusedHere } from "./browser";
import * as passkey from "./passkey";
import { searchAt } from "./research";
import { JOBS } from "./scope";
import { type Snap, asksPassword, fieldOf, isPasswordLine, lineOf, readPage } from "./snapshot";
import { type Entry, IDLE_MS, NEED_MS, type Need, OFFER_MS, type Tab, VIEWPORT, clip, holder, isYours, live, note, pageOf, say, state, statics, workspaceDir } from "./state";
import * as takeover from "./takeover";

const TITLE = "browser-lean-event";
/** How long the pages' events are watched for after one was last shown. */
const WATCH_MS = 30 * 60 * 1000;
const QUALITY = 70;
/** A tab's files: its picture, the card's crop, its state and its page. */
const ENDINGS = [".jpg", "-card.jpg", ".json", ".html"];
const MAX_TEXT = 500;

/** The page as just read, for drawing it: its title, and its elements and fields. */
type Read = { snap: Snap; title: string };

type Names = { token: string; secret: string };

const tabsFile = (workspace: string) => path.join(workspaceDir(workspace), "tabs.json");
/** A tab's file in the public folder, by one of ENDINGS. */
const pub = (token: string, ending: string) => `browser-lean/${token}${ending}`;

function readTabs(workspace: string): Record<string, Names> {
  try {
    return JSON.parse(fs.readFileSync(tabsFile(workspace), "utf8"));
  } catch {
    return {};
  }
}

const saveTabs = (workspace: string, tabs: Record<string, Names>) => writeJson(tabsFile(workspace), tabs);

/** A thread's tab's names, kept in tabs.json: its token names its files; its secret goes with every
 *  event its page posts. Made the first time unless `make` is false (then null). */
function namesOf(workspace: string, key: string, make = true): Names | null {
  const tabs = readTabs(workspace);
  if (tabs[key]?.token && tabs[key]?.secret) return tabs[key];
  if (!make) return null;
  tabs[key] = { token: newSecret(), secret: newSecret(24) };
  saveTabs(workspace, tabs);
  return tabs[key];
}

/** When a thread's tab closes: its files go, its state says so, for its page to show, and its names
 *  are dropped, so a link to it opens nothing again and the next tab gets new ones. */
export function forgetTab(workspace: string, key: string): void {
  const tabs = readTabs(workspace);
  const token = tabs[key]?.token;
  if (!token) return;
  delete tabs[key];
  try {
    saveTabs(workspace, tabs);
    for (const ending of ENDINGS) removePublic(pub(token, ending));
    writePublic(pub(token, ".json"), JSON.stringify({ closed: true }));
  } catch {
    // no folder to write in
  }
  listTabs(workspace);
}

/** How far a browser's closing time moves before its tabs are listed again with it. */
const RELIST_MS = 60 * 1000;

/** What each workspace's tabs were last listed as, to list them again only when that changes. */
const listed = () => perProcess("browser-lean.listed", () => new Map<string, { tokens: string; until: number }>());

/** Lists a workspace's drawn tabs in the links file (#shared/page-links), for AnywhereLLM Lite's
 *  Browser row: each one's page, and when the browser closes. Again only when a tab came or went, or
 *  the closing time moved RELIST_MS (each tab's state has it exactly). None of a scheduled job's. */
function listTabs(workspace: string): void {
  if (workspace === JOBS) return;
  const entry = state().browsers.get(workspace);
  const until = entry ? entry.last + IDLE_MS : 0;
  const tabs: TabLink[] = [];
  for (const key of entry ? keysOf(entry) : []) {
    try {
      const names = namesOf(workspace, key, false);
      const there = names && readPublic(pub(names.token, ".json"));
      const st = there ? JSON.parse(there) : null;
      if (st && !st.closed) tabs.push({ path: `/${pub(names!.token, ".html")}`, workspace, until, drawn: Number(st.shot) || 0 });
    } catch {
      // not drawn where it can be read: not listed
    }
  }
  const tokens = tabs.map((t) => t.path).sort().join(" ");
  const was = listed().get(workspace);
  if (was && was.tokens === tokens && Math.abs(until - was.until) < RELIST_MS) return;
  listed().set(workspace, { tokens, until });
  void noteTabs(workspace, tabs);
}

/** Every tab of a workspace's browser: its chats', then the ones the user opened. */
const keysOf = (entry: Entry): string[] => [...entry.tabs.keys(), ...entry.yours.keys()];

/** A tab's state as last written, or null where it isn't drawn (or closed). */
function stateOf(workspace: string, key: string): { names: Names; text: string; st: Record<string, any> } | null {
  try {
    const names = namesOf(workspace, key, false);
    const text = names && readPublic(pub(names.token, ".json"));
    const st = text ? JSON.parse(text) : null;
    return st && !st.closed ? { names: names!, text: text!, st } : null;
  } catch {
    return null;
  }
}

/** One of the tabs along the top of a tab's page: its page (beside this one in the public folder),
 *  its title and host, whether it's the user's own, whether the agent has it (a chat's tab the user
 *  doesn't hold), whether it's this one, and the id the page that asked for it gave (`made`). */
type StripTab = { path: string; title: string; host: string; mine: boolean; agent: boolean; here: boolean; made: string | null };

/** The workspace's tabs, for the page of `here`, from their states as last written (and `drawn`,
 *  the state `here` is getting now): only the ones drawn. */
function strip(workspace: string, entry: Entry, here: string, drawn?: { title: string; host: string }): StripTab[] {
  const tabs: StripTab[] = [];
  for (const key of keysOf(entry)) {
    if (!pageOf(entry, key)) continue;
    const names = namesOf(workspace, key, false);
    const st = key === here ? drawn : stateOf(workspace, key)?.st;
    if (!names || !st) continue;
    const mine = isYours(key);
    tabs.push({ path: `${names.token}.html`, title: clip(st.title, 200), host: clip(st.host, 300), mine, agent: !mine && !entry.holds.has(key), here: key === here, made: entry.made.get(key) ?? null });
  }
  return tabs;
}

/** Your sites, on a new tab's home: the sites with a saved login first, then the open tabs' hosts
 *  (`host`, the one drawn now, first of those). */
function sites(workspace: string, entry: Entry, host: string): string[] {
  let saved: string[] = [];
  try {
    saved = logins.list().map((l) => l.site);
  } catch {
    // the vault can't be opened: the open tabs' sites alone
  }
  const open = [host, ...keysOf(entry).map((key) => stateOf(workspace, key)?.st.host as string | undefined)];
  return [...new Set([...saved, ...open].filter((h): h is string => !!h))].slice(0, 12);
}

/** Writes when a workspace's browser closes, its tabs along the top and its sites, into each of its
 *  tabs' states that's there: a step in one chat keeps every tab of the workspace open, and a tab
 *  that came or went, or a login saved, shows on every page. */
export function restamp(workspace: string, entry: Entry): void {
  const until = entry.last + IDLE_MS;
  for (const key of keysOf(entry)) {
    try {
      const there = stateOf(workspace, key);
      if (!there) continue; // not drawn yet
      const { names, text, st } = there;
      const tabs = strip(workspace, entry, key, st as { title: string; host: string });
      const shown = sites(workspace, entry, st.host);
      if (st.until === until && JSON.stringify([st.tabs, st.sites]) === JSON.stringify([tabs, shown])) continue;
      writePublic(pub(names.token, ".json"), JSON.stringify({ ...st, until, tabs, sites: shown }), text);
    } catch {
      // no folder to write in, or a state that isn't one: the next draw writes it whole
    }
  }
  listTabs(workspace);
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
function tabState(at: Tab, title: string, url: string, snap: Snap, vaultLink: string | null, nav: { back: boolean; forward: boolean }) {
  const host = hostOf(url);
  const need = pendingNeed(at.entry, at.key);
  const screen = at.page.viewport() ?? VIEWPORT;
  const held = !!holder(at.entry, at.key);
  const msg = live(at.entry.msgs, at.key);
  return {
    title: title.slice(0, 200),
    url: url.slice(0, 2000),
    host,
    mine: isYours(at.key),
    tabs: strip(at.workspace, at.entry, at.key, { title, host }),
    sites: sites(at.workspace, at.entry, host),
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
  const names = namesOf(at.workspace, at.key)!;
  try {
    const shot = publicPath(pub(names.token, ""));
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    // Chrome draws no frame for a tab in the background, and its screenshot waits for one until the
    // protocol times out: the tab drawn is brought to the front first (a chat's tab or the user's
    // own, each of which the user may be looking at on its page).
    await at.page.bringToFront().catch(() => {});
    await at.page.screenshot({ path: `${shot}.jpg`, type: "jpeg", quality: QUALITY });
    if (card) {
      const { width, height } = at.page.viewport() ?? VIEWPORT;
      await at.page.screenshot({ path: `${shot}-card.jpg`, type: "jpeg", quality: QUALITY, clip: { x: 0, y: 0, width, height: Math.min(height, Math.round(width * 1.2)), scale: 0.5 } });
    }
    // The Vault page is written either way; its link goes into the tab's state (which the agent's card
    // carries) only while the links aren't kept from the agent (#shared/page-links, read each time).
    const vaultLink = await showVault();
    writePublic(pub(names.token, ".json"), JSON.stringify(tabState(at, title, at.page.url(), snap, linksHidden() ? null : vaultLink, await history(at.page))));
    if (card || !fs.existsSync(`${shot}.html`)) writePublic(pub(names.token, ".html"), await pageHtml(statics().get("pages/tab.html")!.text, { token: names.token, secret: names.secret, title: TITLE, workspace: at.workspace, tab: at.key }));
  } catch {
    return null;
  }
  listTabs(at.workspace);
  const until = Date.now() + WATCH_MS;
  watch(TITLE, drain, () => until);
  return names.token;
}

/** Draws the tab `at` for the agent's answer, from the page as just read: its card's Markdown lines
 *  (a crop of its picture that opens its page, then its title and address; those alone where there's
 *  no picture) and whether it has a page the user can answer on. `base` is the address the user's
 *  browser reaches AnythingLLM at (null: links from its own root). */
export async function card(at: Tab, base: string | null, read: Read): Promise<{ lines: string[]; page: boolean }> {
  const token = await draw(at, true, read);
  const { title } = read;
  const url = at.page.url();
  const host = hostOf(url);
  const name = plain(title) || plain(host || url);
  const lines = [`**${name}** · ${plain(host || url, 200)}`];
  if (!token) return { lines, page: false };
  const link = `${base ?? ""}/browser-lean/${token}`;
  return { lines: [`[![${name}](${link}-card.jpg?v=${Date.now().toString(36)})](${link}.html)`, "", ...lines], page: true };
}

const NOTHING_READ: Snap = { elements: [], text: "", more: false, fields: [] };

/** Draws `at` for its page alone: read only when the user holds it (its fields) or an offer waits on
 *  the page asking for a password; the picture and the title otherwise. */
async function redrawn(at: Tab): Promise<void> {
  if (pageOf(at.entry, at.key) !== at.page) return; // closed meanwhile: nothing to draw, and no names to make again
  const read = holder(at.entry, at.key) || at.entry.offers.has(at.key) ? await readPage(at.page) : { snap: NOTHING_READ, title: await at.page.title().catch(() => "") };
  await draw(at, false, read);
}

/** Draws a thread's tab again, for its page, in turn with the events' passes: what changed there came
 *  from outside a step (a passkey a site made, say). */
export const redraw = (workspace: string, entry: Entry, key: string): Promise<void> =>
  inTurn(TITLE, async () => {
    const page = pageOf(entry, key);
    if (page) await redrawn({ workspace, entry, page, key });
  });

const text = (v: unknown, n = MAX_TEXT) => clip(v, n);

/** The SEARCH_URL a call was last given, for a search from a tab's page where the skill's
 *  plugin.json isn't where AnythingLLM keeps it (#shared/settings setting). */
const given = () => perProcess("browser-lean.search", () => ({ url: "" }));
export const searchGiven = (url: unknown): void => void (given().url = String(url ?? ""));

/** What the user typed into the home's field, as an address: one with a scheme, or a host (with a
 *  port and a path, perhaps); null for words to search for. */
function addressOf(q: string): string | null {
  if (/\s/.test(q)) return null;
  if (!/^https?:\/\//i.test(q) && !/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(q)) return null;
  try {
    return checkUrl(q);
  } catch {
    return null;
  }
}

/** A search or an address typed on a tab's page (`q`): opens a tab of the user's own there, through
 *  the fence, and draws it; the page that asked finds it by `made` along its tabs. What can't be
 *  opened is said on the page that asked. */
async function openFrom(at: Tab, e: Record<string, unknown>): Promise<boolean> {
  const q = text(e.q, 2000).trim();
  if (!q) return false;
  if (at.entry.yours.size >= MAX_YOURS) return say(at.entry, at.key, `You have ${MAX_YOURS} tabs of your own open. Close one, then try again.`), true;
  const url = addressOf(q) ?? searchAt(setting("browser-lean", "SEARCH_URL", given().url) || given().url, q);
  if (await at.entry.fence(url)) return say(at.entry, at.key, refusedHere(url)), true;
  const { at: yours, failed } = await openYours(at.workspace, at.entry, url, text(e.made, 40));
  if (failed) say(yours.entry, yours.key, `Couldn’t open ${hostOf(url) || "that address"}. Check the address, then try again.`);
  await redrawn(yours);
  return true;
}

/** Closes the tab `at` from its page; a chat's tab not while its agent is in the middle of a step. */
async function closeFrom(at: Tab): Promise<boolean> {
  if (!isYours(at.key) && at.entry.busy.has(at.key)) return say(at.entry, at.key, "The agent is busy. Try again in a moment."), true;
  await closeTab(at.workspace, at.entry, at.key);
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
    if (need) note(at.entry, at.key, instead ? "the user is taking the tab over to enter it themselves instead; wait for them to hand it back, then read the page" : "the user chose not to enter it now, so nothing was typed; tell them you can't go on without it");
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
  if (!asking) return note(at.entry, at.key, `${sent}; ${hidden}`), true;
  // Likely refused: a login the user asked to save isn't kept; they're asked again where the same
  // field is still there, else told on the page.
  at.entry.offers.delete(at.key);
  const it = login ? "a password" : "the code";
  const refused = `${sent}, but the page still asks for ${it}: the site may have refused it.`;
  if (asking === "same") {
    at.entry.needs.set(at.key, { ...need, text: `${MAYBE_REFUSED} Enter it again.`, until: Date.now() + NEED_MS });
    note(at.entry, at.key, `${refused} The user is asked again on the tab's page; wait for them, then read the page`);
  } else {
    say(at.entry, at.key, MAYBE_REFUSED);
    note(at.entry, at.key, `${refused} Read the page, tell the user, and use login again if they want to retry`);
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
 *  answers its path on this host, for the tab's page to link to. */
async function showVault(): Promise<string> {
  const link = await vaultPage.show("logins", loginsState(), drainLogins, null);
  addresses.show(null);
  return link;
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
 *  tab's secret; then draws each tab that changed. One that fails is skipped, and its tab says so. */
async function drain(): Promise<void> {
  const changed = new Set<Tab>();
  for (const e of takeEvents(TITLE, "browser_lean_event")) {
    const workspace = text(e.workspace, 100);
    const key = text(e.tab, 100);
    let names: Names | null;
    try {
      names = namesOf(workspace, key, false);
    } catch {
      continue; // no such workspace
    }
    if (!names || !sameSecret(e.secret, names.secret)) continue; // not this tab's: an old link's, or a forgery
    const entry = state().browsers.get(workspace);
    const page = entry && pageOf(entry, key);
    if (!entry || !page) continue; // the tab closed meanwhile
    const at = [...changed].find((t) => t.page === page) ?? { workspace, entry, page, key };
    entry.touch(); // the browser isn't closed under the user
    try {
      if (await apply(e, at)) changed.add(at);
    } catch (err) {
      if (!(err instanceof Told)) throw err;
      note(at.entry, at.key, `what the user entered on the tab's page couldn't be used: ${err.message}`);
      changed.add(at);
    }
  }
  for (const at of changed) at.entry.changed(); // a login typed, a takeover's step: its cookies may have changed
  await Promise.all([...changed].map(redrawn));
  // A tab that came, went or changed hands shows along the top of every page of its workspace.
  for (const [workspace, entry] of new Map([...changed].map((at) => [at.workspace, at.entry]))) restamp(workspace, entry);
}
