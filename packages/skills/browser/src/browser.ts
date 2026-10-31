// Chrome, run by this skill inside AnythingLLM's own process, through the Puppeteer bundled with
// the skill (puppeteer-core, which downloads nothing) and a Chrome found on the machine (chrome()).
// Each workspace gets a browser of its own, with a profile in a temporary folder that goes when it
// closes; its cookies are sealed beside the vault (sessions.ts), saved SAVE_MS after a step and as
// it closes, so its sign-ins last. Each chat thread gets a tab. The user may open tabs of their own
// from a tab's page (openYours): those live in a browser context of their own, with cookies apart
// from the chats', in a map the agent's actions never look in (tab and existing refuse their names
// too). A browser closes after IDLE_MS unused, and at most MAX_BROWSERS run at once. Every request a page makes goes through the fence (#shared/fence), and
// every tab has a passkey authenticator (passkey.ts).
// What must outlive a reload (the browsers, their tabs) is kept per process (state.ts).

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { perProcess } from "#shared/anythingllm";
import { FENCED, NetError, letThrough, makeFence, noteRefused, originOf, pathRefused } from "#shared/fence";
import { firstLine } from "#shared/errors";
import { ACT_MS, NAVIGATE_MS, settle } from "./act";
import { BrowserError } from "./errors";
import type { Browser, Page, Puppeteer } from "./host";
import { forgetTab, redraw, restamp } from "./page";
import * as passkey from "./passkey";
import * as sessions from "./sessions";
import { type Entry, IDLE_MS, type Tab, VIEWPORT, YOURS, isYours, note, say, state, threadKey } from "./state";

/** Where a system Chrome or Chromium is looked for, after the ones Puppeteer downloaded (Linux only, so far). */
const SYSTEM_CHROMES = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];
/** How long after a step its browser's cookies are saved. */
const SAVE_MS = 10 * 1000;
const MAX_BROWSERS = 3;
/** The screen a research page reads at, so docs show their desktop layout. */
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1 };
const ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate,MediaRouter", "--password-store=basic"];
/** Chrome's own password saving, off in every profile the skill makes. */
const PREFERENCES = { credentials_enable_service: false, profile: { password_manager_enabled: false } };

/** The Chromes Puppeteer downloaded into its cache `root`, newest first, read by its own Cache (in
 *  the bundle already, as puppeteer-core's); none when there's no cache to read. Sorted here: its
 *  getVersionComparator takes only semver, and a Chrome's build is four numbers (119.0.6045.105). */
function downloaded(root: string): string[] {
  try {
    const { Browser, Cache } = require("@puppeteer/browsers") as typeof import("@puppeteer/browsers");
    const chromes = new Cache(root).getInstalledBrowsers().filter((installed) => installed.browser === Browser.CHROME);
    return chromes.sort((a, b) => b.buildId.localeCompare(a.buildId, "en", { numeric: true })).map((installed) => installed.executablePath);
  } catch {
    return [];
  }
}

/** The Chrome to launch: BROWSER_LEAN_CHROME, else the newest one Puppeteer downloaded (in
 *  PUPPETEER_CACHE_DIR or ~/.cache/puppeteer; AnythingLLM's image has one, for its collector), else
 *  a system Chrome or Chromium. */
function chrome(): string {
  if (process.env.BROWSER_LEAN_CHROME) return process.env.BROWSER_LEAN_CHROME;
  const root = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), ".cache", "puppeteer");
  const found = [...downloaded(root), ...SYSTEM_CHROMES].find((file) => fs.existsSync(file));
  if (!found) throw new BrowserError(`there's no Chrome to run (looked in ${root} and at ${SYSTEM_CHROMES.join(", ")}); set BROWSER_LEAN_CHROME in AnythingLLM's environment to one`);
  return found;
}

/** The bundled Puppeteer, or the stand-in BROWSER_LEAN_PUPPETEER names (the tests'). Required when
 *  first launched, so a load of the skill that opens no browser doesn't load it, and once per
 *  process, not once per load of the skill. */
function puppeteer(): Puppeteer {
  const standIn = process.env.BROWSER_LEAN_PUPPETEER;
  if (standIn) return createRequire(path.join(process.cwd(), "index.js"))(standIn);
  return perProcess(`browser-lean.puppeteer ${VENDORED_VERSIONS}`, () => require("puppeteer-core"));
}

/** A profile for one run of Chrome, in a temporary folder, with Chrome's own password saving off. */
function makeProfile(): string {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "browser-lean-"));
  fs.mkdirSync(path.join(profile, "Default"));
  fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify(PREFERENCES));
  return profile;
}

/** Saves the workspace's cookies, if they changed; a failure (Chrome gone, say) leaves them as last saved. */
async function saveNow(workspace: string, entry: Entry): Promise<void> {
  if (!entry.browser) return;
  entry.saved = await sessions.save(workspace, entry.browser, entry.saved).catch(() => entry.saved);
}

/** Saves the workspace's cookies SAVE_MS from now, in place of a save to come. */
function saveSoon(workspace: string, entry: Entry): void {
  clearTimeout(entry.saving ?? undefined);
  entry.saving = setTimeout(() => void saveNow(workspace, entry), SAVE_MS);
  entry.saving.unref?.();
}

/** At most this many tabs the user opened themselves, in each workspace's browser. */
export const MAX_YOURS = 8;

/** Forgets a tab, a thread's or the user's, however it closed: its page then says the tab closed. */
function dropTab(workspace: string, entry: Entry, key: string): void {
  entry.tabs.delete(key);
  entry.yours.delete(key);
  entry.made.delete(key);
  entry.notes.delete(key);
  entry.needs.delete(key);
  entry.offers.delete(key);
  entry.msgs.delete(key);
  entry.holds.delete(key);
  entry.screens.delete(key);
  forgetTab(workspace, key);
}

/** Forgets a workspace's browser and every tab in it. */
function dropEntry(workspace: string, entry: Entry): void {
  const { browsers } = state();
  if (browsers.get(workspace) !== entry) return;
  browsers.delete(workspace);
  clearTimeout(entry.timer ?? undefined);
  clearTimeout(entry.saving ?? undefined);
  for (const key of [...entry.tabs.keys(), ...entry.yours.keys()]) dropTab(workspace, entry, key);
}

async function closeEntry(workspace: string): Promise<void> {
  const entry = state().browsers.get(workspace);
  if (!entry) return;
  await saveNow(workspace, entry);
  dropEntry(workspace, entry);
  await (await entry.ready.catch(() => null))?.close().catch(() => {});
}

/** Keeps a workspace's browser open IDLE_MS from now, which each of its tabs' states says. */
function touch(workspace: string, entry: Entry): void {
  entry.last = Date.now();
  clearTimeout(entry.timer ?? undefined);
  entry.timer = setTimeout(() => void closeEntry(workspace), IDLE_MS);
  entry.timer.unref?.();
  restamp(workspace, entry);
}

async function launch(workspace: string): Promise<Browser> {
  const profile = makeProfile();
  // Chrome may still be writing it as it goes, so it's removed in the background, with retries, and
  // never throws: this runs in an event handler, where a throw would take AnythingLLM down.
  const gone = () => fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
  let browser: Browser;
  try {
    browser = await puppeteer().launch({ executablePath: chrome(), headless: true, userDataDir: profile, args: ARGS, defaultViewport: VIEWPORT, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (e) {
    gone();
    throw e;
  }
  browser.on("disconnected", () => {
    gone();
    const entry = state().browsers.get(workspace);
    if (entry?.browser === browser) dropEntry(workspace, entry);
  });
  return browser;
}

/** The workspace's browser entry, its browser launched (and the least recently used one closed,
 *  past MAX_BROWSERS) if it isn't running. */
async function entryFor(workspace: string): Promise<Entry> {
  const { browsers } = state();
  let entry = browsers.get(workspace);
  if (!entry) {
    const others = [...browsers.entries()].sort((a, b) => a[1].last - b[1].last);
    while (others.length >= MAX_BROWSERS) await closeEntry(others.shift()![0]);
    const made: Entry = { tabs: new Map(), yours: new Map(), context: null, opened: 0, made: new Map(), notes: new Map(), needs: new Map(), offers: new Map(), msgs: new Map(), holds: new Map(), screens: new Map(), authenticators: new Map(), secrets: new Set(), fence: makeFence(), last: Date.now(), timer: null, saving: null, saved: null, ready: null!, touch: () => touch(workspace, made), changed: () => saveSoon(workspace, made), busy: new Set() };
    made.ready = launch(workspace).then(async (browser) => {
      made.saved = await sessions.restore(workspace, browser).catch(() => null);
      return (made.browser = browser);
    });
    browsers.set(workspace, (entry = made));
    try {
      await entry.ready;
    } catch (e) {
      browsers.delete(workspace);
      throw new BrowserError(`Chrome didn't start: ${firstLine(e)}`);
    }
  }
  await entry.ready;
  touch(workspace, entry);
  return entry;
}

/** Every request `page` makes through the fence; with `key`, a refused navigation of its main frame
 *  is noted for that tab's next read. */
async function fenced(entry: Entry, page: Page, key?: string): Promise<void> {
  page.setDefaultTimeout(ACT_MS);
  page.setDefaultNavigationTimeout(NAVIGATE_MS);
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    if (request.isInterceptResolutionHandled?.()) return;
    const why = await entry.fence(request.url());
    try {
      if (!why) return await request.continue();
      if (key && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        // The user's own tab is told on its page; a chat's tab, in the agent's next read.
        if (isYours(key)) say(entry, key, refusedHere(request.url()));
        else note(entry, key, `refused to open ${request.url().slice(0, 200)}: ${why}. ${refusal(request.url())}`);
      }
      await request.abort("blockedbyclient");
    } catch {
      // the page went away meanwhile
    }
  });
}

/** Sets up a tab of `key`'s in `workspace`'s browser: the screen its page asked for, the fence on
 *  every request, a passkey authenticator, dialogs answered and noted, a popup it opens made the
 *  thread's tab until it closes. */
async function adopt(workspace: string, entry: Entry, key: string, page: Page): Promise<Page> {
  const screen = entry.screens.get(key);
  if (screen) await page.setViewport(screen).catch(() => {});
  await fenced(entry, page, key);
  await passkey.attach(entry, key, page, () => void redraw(workspace, entry, key).catch(() => {}));
  page.on("dialog", async (dialog) => {
    const accept = dialog.type() === "alert" || dialog.type() === "beforeunload";
    note(entry, key, `the page showed a ${dialog.type()} ("${dialog.message().slice(0, 200)}"), which was ${accept ? "accepted" : "dismissed"}`);
    await (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });
  const tabs = isYours(key) ? entry.yours : entry.tabs; // a window a tab opens is the same tab's, the user's or the chat's
  page.on("popup", async (popup) => {
    if (!popup) return;
    const opener = tabs.get(key);
    await adopt(workspace, entry, key, popup);
    tabs.set(key, popup);
    note(entry, key, "the page opened a new window, which is this chat's tab until it closes");
    popup.once("close", () => {
      if (tabs.get(key) === popup && opener && !opener.isClosed()) {
        tabs.set(key, opener);
        note(entry, key, "the new window closed; the tab is the one before it again");
      }
    });
  });
  return page;
}

/** A page of the workspace's browser for research (search, look), apart from every chat's tab and
 *  never shown: a desktop's screen, the fence on its requests, its dialogs dismissed and any window
 *  it opens closed. The caller closes it. */
export async function scratch(workspace: string): Promise<{ entry: Entry; page: Page }> {
  const entry = await entryFor(workspace);
  const page = await entry.browser!.newPage();
  await page.setViewport(DESKTOP).catch(() => {});
  await fenced(entry, page);
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
  page.on("popup", (popup) => void popup?.close().catch(() => {}));
  return { entry, page };
}

/** A thread's key, never one of the user's own tabs': the agent's actions reach only its chat's tab. */
function chatKey(thread?: string | number): string {
  const key = threadKey(thread);
  if (isYours(key)) throw new BrowserError("that's a tab the user opened themselves, which only they use");
  return key;
}

/** This chat's tab in the workspace's browser, opened if it has none. */
export async function tab(workspace: string, thread?: string | number): Promise<Tab> {
  const entry = await entryFor(workspace);
  const key = chatKey(thread);
  let page = entry.tabs.get(key);
  if (!page || page.isClosed()) {
    page = await adopt(workspace, entry, key, await entry.browser!.newPage());
    entry.tabs.set(key, page);
  }
  return { workspace, entry, page, key };
}

/** This chat's open tab, or a BrowserError saying to open an address first. */
export function existing(workspace: string, thread?: string | number): Tab {
  const entry = state().browsers.get(workspace);
  const key = chatKey(thread);
  const page = entry?.tabs.get(key);
  if (!entry || !page || page.isClosed()) throw new BrowserError("this chat has no page open: open an address first");
  touch(workspace, entry);
  return { workspace, entry, page, key };
}

/** A tab of the user's own, opened from a tab's page in `entry`'s browser (the workspace's) at
 *  `url`, which the fence lets through (the caller asked it): in the user's browser context, with
 *  the fence on its requests and a passkey authenticator, as a chat's tab has. `made` is the id the
 *  page asked with. Answers the tab, and why loading didn't finish (null when it did). */
export async function openYours(workspace: string, entry: Entry, url: string, made: string): Promise<{ at: Tab; failed: string | null }> {
  if (!entry.browser) throw new BrowserError("the browser isn't running");
  entry.context ??= entry.browser.createBrowserContext();
  const context = await entry.context;
  const key = `${YOURS}${++entry.opened}`;
  const page = await adopt(workspace, entry, key, await context.newPage());
  entry.yours.set(key, page);
  entry.made.set(key, made);
  page.once("close", () => entry.yours.get(key) === page && dropTab(workspace, entry, key));
  touch(workspace, entry);
  return { at: { workspace, entry, page, key }, failed: await load(entry, page, url).catch((e) => firstLine(e)) };
}

/** Closes a tab from its page: the user's own, or a chat's (whose agent then finds no page open). */
export async function closeTab(workspace: string, entry: Entry, key: string): Promise<void> {
  const page = (isYours(key) ? entry.yours : entry.tabs).get(key);
  dropTab(workspace, entry, key);
  await page?.close().catch(() => {});
  restamp(workspace, entry);
}

/** What the user's own tab says when the fence refuses where it was going: where they let it through. */
export function refusedHere(url: string): string {
  const origin = originOf(url);
  if (!origin || pathRefused(new URL(url))) return "The browser doesn’t open that address.";
  noteRefused(origin);
  return `${origin} isn’t let through. Allow it in the Vault, under Addresses, then try again.`;
}

/** What the agent is told after the fence refused `url`: where the user lets its origin through,
 *  noted for the Vault page to offer (noteRefused); only that nothing else may reach it when there's
 *  no origin to let through (a page of the skills', another scheme). */
function refusal(url: string): string {
  const origin = originOf(url);
  if (!origin || pathRefused(new URL(url))) return FENCED;
  noteRefused(origin);
  return letThrough(origin);
}

/** Whether the fence lets `url` through: a NetError saying why not, said as `what` ("isn't opened"). */
export async function through(entry: Entry, url: string, what: string): Promise<void> {
  const refused = await entry.fence(url);
  if (!refused) return;
  if (pathRefused(new URL(url))) throw new BrowserError(`${url} ${what}: ${refused}`); // nothing to let through
  throw new NetError(`${url} ${what}: ${refused}. The browser reaches the public web only, and the hosts and addresses the user lets through. ${refusal(url)}`);
}

/** Loads `url` in `page` of `entry`'s browser, the fence asked first (through); answers why loading
 *  didn't finish, or null when it did. */
export async function load(entry: Entry, page: Page, url: string): Promise<string | null> {
  await through(entry, url, "isn't opened");
  let failed: string | null = null;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (e) {
    failed = firstLine(e);
  }
  await settle(page, 0);
  return failed;
}
