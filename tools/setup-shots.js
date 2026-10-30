// The setup guide's screenshots (setup.html, on the gh-pages branch), run inside a throwaway
// AnythingLLM container by tools/setup-shots: AnythingLLM's own pages at a phone's size (390 px wide,
// twice as many device pixels), in the Chrome the image ships for its collector. Each picture marks
// the one control its step is about with an outline in the guide's accent colour, and is cut to the
// part of the screen around it. A key a picture would show is replaced by "brx-…" first: the values
// are the throwaway's, but none is shown. Writes WebP files into /shots.
const puppeteer = require("/app/collector/node_modules/puppeteer");

const BASE = "http://127.0.0.1:3001";
/** The guide's accent in its light theme: about 5.7:1 on AnythingLLM's white, where each outline sits. */
const ACCENT = "#4b5dc3";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
/** How much of the screen a picture keeps, in CSS pixels: the marked control and what's around it,
 *  little enough that the guide shows it near its own size on a phone. */
const CUT = 380;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The last element whose text is `text` (of those `sel` matches). */
async function byText(page, text, sel = "*") {
  const found = await page.evaluateHandle((text, sel) => [...document.querySelectorAll(sel)].filter((e) => e.textContent.trim() === text).at(-1) ?? null, text, sel);
  if (!(await found.evaluate((e) => !!e))) throw new Error(`nothing reads "${text}" on ${page.url()}`);
  return found;
}

/** The input of the skill setting `name`, labelled by its name on the skill's settings page. */
async function settingInput(page, name) {
  const found = await page.evaluateHandle((name) => {
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent.trim() === name);
    return (label && (document.getElementById(label.htmlFor) || label.parentElement.querySelector("input"))) ?? null;
  }, name);
  if (!(await found.evaluate((e) => !!e))) throw new Error(`no setting ${name} on ${page.url()}`);
  return found;
}

/** Replaces every browser-extension key the page shows, in its text and its fields, with "brx-…". */
const hideKeys = (page) =>
  page.evaluate(() => {
    const key = /brx-[A-Z0-9-]{4,}/g;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = n.nodeValue.replace(key, "brx-…");
    for (const i of document.querySelectorAll("input, textarea")) i.value = i.value.replace(key, "brx-…");
  });

/** Whether the page shows a key anywhere still, in its text or its fields. */
const showsKey = (page) => page.evaluate(() => /brx-[A-Z0-9-]{4,}/.test(document.body.innerText + [...document.querySelectorAll("input, textarea")].map((i) => i.value).join(" ")));

/** Takes the picture `name`: `el` scrolled to the middle and outlined, the screen cut around it, or
 *  around `frame` (an element holding it: a dialog) where one is given, `cut` CSS pixels high. */
async function shot(page, el, name, frame = el, cut = CUT) {
  await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await sleep(300);
  await page.evaluate(() => document.activeElement?.blur()); // no focus ring beside the outline
  await hideKeys(page);
  if (await showsKey(page)) throw new Error(`${name}: a key would show`);
  await el.evaluate((e, accent) => {
    const r = e.getBoundingClientRect();
    const mark = document.createElement("div");
    mark.id = "setup-shots-mark";
    Object.assign(mark.style, { position: "fixed", left: `${r.left - 5}px`, top: `${r.top - 5}px`, width: `${r.width + 10}px`, height: `${r.height + 10}px`, border: `3px solid ${accent}`, borderRadius: "12px", boxSizing: "border-box", pointerEvents: "none", zIndex: 2147483647 });
    document.body.appendChild(mark);
  }, ACCENT);
  const box = await frame.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  const middle = (box.top + box.bottom) / 2;
  const y = Math.round(Math.min(Math.max(0, middle - cut / 2), PHONE.height - cut));
  await page.screenshot({ path: `/shots/${name}.webp`, type: "webp", quality: 80, clip: { x: 0, y, width: PHONE.width, height: cut } });
  await page.evaluate(() => document.getElementById("setup-shots-mark")?.remove());
  console.log(`wrote ${name}.webp`);
}

/** Opens the Library's settings: Settings › Agent Skills, then Library. */
async function librarySettings(page) {
  await page.goto(`${BASE}/settings/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent.trim() === "Library"), { timeout: 60000 });
  await sleep(500);
  const row = await byText(page, "Library");
  await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const box = await row.boundingBox();
  await page.mouse.click(box.x + 5, box.y + box.height / 2);
  await page.waitForSelector("label");
  await sleep(500);
}

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const phone = async () => {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport(PHONE);
    return page;
  };
  let page = await phone();

  // Step 1: the key, made in Settings › Browser Extension.
  await page.goto(`${BASE}/settings/browser-extension`, { waitUntil: "networkidle0" });
  await shot(page, await byText(page, "Generate New API Key", "button"), "browser-extension");
  await (await byText(page, "Generate New API Key", "button")).click();
  await (await byText(page, "Create API Key", "button")).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Copy API Key"));
  await sleep(500);
  const copy = await byText(page, "Copy API Key", "button");
  await shot(page, copy, "copy-key", await copy.evaluateHandle((b) => b.closest("form") ?? b), 460);

  // Step 1, then: PAGE_KEY in the Library's settings, a key pasted; step 2: NEW_KEY, the same way.
  // A page for each, since a settings form with a value typed in holds the page from leaving it.
  for (const [setting, name] of [["PAGE_KEY", "page-key"], ["NEW_KEY", "new-key"]]) {
    await page.close();
    page = await phone();
    await librarySettings(page);
    const input = await settingInput(page, setting);
    await input.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await input.type(setting === "PAGE_KEY" ? "brx-…" : "a key of the service's");
    await sleep(300);
    await shot(page, input, name);
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
