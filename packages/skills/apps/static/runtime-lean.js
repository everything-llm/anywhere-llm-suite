// runtime-lean.js: apps-lean's stand-in for a pages server, inlined in every page just before
// app.js, which the page uses unchanged. app.js saves with `post(app.append, ...)` and keeps up
// with `post(app.sync, ...)`; apps-lean gives it the addresses lean:append and lean:sync, and
// answers both here:
//   lean:append  the change goes to AnythingLLM as an apps-lean-event document (through the
//                browser extension's upload, which only stores it), with the app's secret, and is
//                confirmed as the next line. The skill applies it as it lands.
//   lean:sync    the page reads its state file (<token>.json beside it, which the skill writes
//                after every change) every 2 s while it's in view, and at once after it posts:
//                a newer line is the data, under this page's changes the app hasn't recorded yet.
//                A page whose parts changed reloads, unless the user is typing; an app that was
//                deleted says so.
// A change sent but not recorded stays applied over newer data, in this browser's storage, until
// the app lists its id (patched with App.apply, the page's one patch engine). App.log gives the
// newest changes the page was written with.
// A page whose <html> has data-picture is a picture: the apps manager draws it small, its HTML the
// document of a sandboxed frame, and says so. It shows the data it was written with, reads and posts
// nothing, has no Comment, and tells the frame's parent once it's drawn ("apps-lean:drawn"), so the
// manager shows it in place of the icon. Any other page, framed or not, is a page. Comment, below,
// runs on the composer the page carries just before this script (shared/composer.js).
var AppsLean = (() => {
  const cfg = JSON.parse(document.getElementById("apps-lean").textContent);
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const native = window.fetch.bind(window);
  // app.js's two addresses answered by `append` and `sync`; any other, as the browser would.
  const serve = (append, sync) => {
    window.fetch = (url, opts) => (url === "lean:append" ? append(JSON.parse(opts.body)) : url === "lean:sync" ? sync(JSON.parse(opts.body)) : native(url, opts));
  };
  const app = (data, line) => ({ title: cfg.title, card: cfg.card, data, line, append: "lean:append", sync: "lean:sync" });
  // App.log asks without waiting: the newest changes, as the page was written with them.
  const log = (since, line) => answer(200, { line, lines: cfg.log.filter((l) => l.n > (since || 0)) });

  if (document.documentElement.hasAttribute("data-picture")) {
    serve(() => answer(409, { error: "A picture of the page saves nothing." }), (body) => (body.wait === false ? log(body.since, cfg.line) : new Promise(() => {})));
    // Drawn: app.js and the parts draw as the page loads, so a moment after it the picture is ready.
    window.addEventListener("load", () => setTimeout(() => window.parent.postMessage("apps-lean:drawn", "*"), 100));
    return { app: () => app(cfg.data, cfg.line) };
  }

  const KEY = "apps-lean:" + cfg.workspace + "/" + cfg.app;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ pending })); } catch (e) {} };
  let pending = (load().pending || []).filter((e) => !cfg.seen.includes(e.id));
  let line = cfg.line, served = cfg.line, posted = 0;
  const stateUrl = location.pathname.replace(/\.html$/, ".json");
  function over(data) {
    // `data` with the changes the app hasn't recorded on top; one that no longer applies goes.
    const kept = [];
    for (const e of pending) {
      try { data = App.apply(data, e.patch); kept.push(e); } catch (err) {}
    }
    pending = kept;
    keep();
    return data;
  }
  const uuid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));

  /** Posts the change as an event of this app's page, with its secret, as a document AnythingLLM only
   *  stores; relative, as the page is served by AnythingLLM itself at whatever address the user
   *  reached it. */
  async function append(body) {
    const id = uuid();
    const event = { apps_lean_event: 1, workspace: cfg.workspace, app: cfg.app, secret: cfg.secret, id, t: new Date().toISOString(), ev: body.ev || "change", fields: body.fields, patch: body.patch };
    const r = await native("/api/browser-extension/upload-content", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      body: JSON.stringify({ textContent: JSON.stringify(event), metadata: { title: cfg.eventTitle, docSource: "apps-lean page" } }),
    });
    if (r.status === 403) return answer(403, { error: "AnythingLLM refused the pages' key: make a new one in Settings › Browser Extension, paste it into a suite skill's PAGE_KEY, then reload this page." });
    if (!r.ok) return answer(r.status >= 500 ? 503 : r.status, { error: "AnythingLLM answered " + r.status + "." });
    pending.push({ id, patch: body.patch });
    keep();
    posted = Date.now();
    line = Math.max(line, body.base) + 1;
    return answer(200, { line, lines: [{ n: line, patch: body.patch }] });
  }

  // Every 2 s while the page is in view, soon after this page posted, and at once when it comes
  // back into view.
  const pause = () => new Promise((go) => {
    const ms = Date.now() - posted < 2000 ? 250 : 2000;
    const done = () => (clearTimeout(t), document.removeEventListener("visibilitychange", wake), go());
    const wake = () => { if (!document.hidden) done(); };
    const t = setTimeout(done, ms);
    document.addEventListener("visibilitychange", wake);
  });
  /** The bar along the bottom saying what the user should know now, with an optional button: one
   *  bar, whose words are the newest. */
  let barEl = null;
  function bar(text, label, act) {
    if (!barEl) {
      barEl = document.createElement("div");
      barEl.setAttribute("role", "status");
      barEl.dataset.surface = "inverse"; // House UI's focus ring in the ground's colour
      barEl.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:9;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:12px;background:var(--ink,#222);color:var(--ground,#fff);font:400 .9375rem/1.4 var(--font-sans,system-ui,sans-serif)";
    }
    if (barEl.dataset.said === text) return;
    barEl.dataset.said = text;
    barEl.textContent = text;
    if (label) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "flex:none;min-height:44px;padding:0 14px;border-radius:10px;border:0;background:var(--accent-soft,#dee5fe);color:var(--ink,#222);box-shadow:none;font:inherit;font-weight:600";
      b.addEventListener("click", act);
      barEl.append(b);
    }
    document.body.append(barEl);
  }
  // The focused element, inside a shadow root too (Comment's tray is in one).
  const typing = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || !!(a && a.isContentEditable); };
  let gone = false;
  async function sync(body) {
    if (body.wait === false) return log(body.since, line);
    if (gone) return new Promise(() => {}); // nothing more will come
    await pause();
    if (!/^https?:$/.test(location.protocol)) return answer(200, { line: body.since, lines: [] });
    try {
      const next = await (await native(stateUrl, { cache: "no-cache" })).json();
      if (next && next.gone) {
        gone = true;
        bar("This artifact was deleted.");
        return new Promise(() => {});
      }
      if (next && next.version && next.version !== cfg.version) {
        // The page itself changed: a reload gets it. This page's unrecorded changes are kept in
        // the browser's storage, so they come back over it.
        if (!typing()) location.reload();
        else bar("This artifact's page changed.", "Reload", () => location.reload());
      }
      if (!next || typeof next.line !== "number") return answer(200, { line: body.since, lines: [] });
      // A change the app saw is recorded, or was refused, which leaves the line as it was: either
      // way it no longer goes over the data.
      const seen = next.seen || [], left = pending.filter((e) => !seen.includes(e.id));
      const refused = (next.refused || []).filter((r) => pending.some((e) => e.id === r.id));
      if (next.line === served && left.length === pending.length) return answer(200, { line: body.since, lines: [] });
      if (refused.length) bar((refused.length > 1 ? refused.length + " changes weren't saved: " : "A change wasn't saved: ") + refused[refused.length - 1].why);
      served = next.line;
      pending = left;
      line = Math.max(line, next.line);
      return answer(200, { data: over(next.data), line });
    } catch (e) {
      return answer(503, { error: "Can't reach AnythingLLM." });
    }
  }

  // --- Comment: the user says one thing about the page, a question or a change, which goes to the
  // chat as their message; they may point at up to 5 things on it first, and none is fine. Only
  // AnywhereLLM, whose web view gives the page its AnywhereLLMApps channel, has a chat to send it to;
  // elsewhere there's no Comment. The sheet holds the composer the browser's chat bar shares
  // (shared/composer.js, inlined ahead of this script), expanded: writing first, Point at the page
  // lowers it to the pick tray. While pointing, taps pick instead of pressing: these listeners, on
  // the window and added before any part's, see each tap first and keep it from the page; scrolling
  // still works.
  const C = window.AnywhereComposer || null;
  const chat = C && C.channel(window);
  let composer = null, open = false, opener = null;
  const host = document.createElement("div");
  const ui = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  const ours = (e) => (e.composedPath ? e.composedPath().includes(host) : host.contains(e.target));
  const picking = () => !!(composer && composer.pointing);
  /** What marks the picked element in page.html and in the data, and what it showed. */
  function locate(el) {
    const near = (sel) => (el.closest ? el.closest(sel) : null);
    const part = near("[data-part]"), ref = near("[data-ref]"), id = near("[id]"), fig = near("[data-figure]"), item = near("[data-at]");
    let figure;
    try { figure = fig ? JSON.parse(fig.getAttribute("data-figure")).kind : undefined; } catch (e) {}
    const shown = String(el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const key = el.getAttribute && el.getAttribute("data-text");
    return {
      id: id && id.id || undefined, ref: ref && ref.getAttribute("data-ref") || undefined, part: part && part.getAttribute("data-part") || undefined,
      at: item ? item.getAttribute("data-at") + (key ? "/" + key : "") : undefined, figure, tag: String(el.tagName || "").toLowerCase(), cls: el.classList && el.classList[0] || undefined, shown: shown || undefined,
    };
  }
  const code = (v) => "`" + String(v).replace(/`/g, "'") + "`";
  /** A pick's line in the message: what marks it in page.html and in the data, and what it showed. */
  const described = ({ tag, id, cls, part, ref, at, figure, shown }) =>
    [code((tag || "element") + (id ? "#" + id : cls ? "." + cls : "")), part && "part " + code(part), ref && "data-ref " + code(ref), at && "data at " + code(at), figure && "figure " + code(figure), shown && `showing "${shown}"`].filter(Boolean).join(", ");
  /** The tapped element as the composer picks it; a password field is a secret, which it refuses. */
  function pickOf(el) {
    const where = locate(el);
    const secret = el.tagName === "INPUT" && (el.type === "password" || /password/.test(el.getAttribute("autocomplete") || ""));
    const shown = where.shown && !secret ? " “" + where.shown.slice(0, 40) + "”" : "";
    return { key: el, chip: (where.part || where.ref || where.tag) + shown, line: described(where), secret, box: el };
  }
  /** The comment as the user's message: which app, what they picked by what marks each in page.html
   *  (none is fine), then their words. */
  function message(text, picks) {
    const about = `Comment on my ${cfg.title || cfg.app} app's page (apps-lean app ${code(cfg.app)})`;
    return C.message(picks.length ? about + ", about what I picked there:" : about + ":", picks, text);
  }
  // Each pick: an accent outline on the element, and its number at its corner.
  const outline = (el, on) => { el.style.outline = on ? "3px solid var(--accent)" : ""; el.style.outlineOffset = on ? "2px" : ""; };
  let marked = [];
  function mark(picks) {
    for (const el of marked) if (!picks.some((p) => p.box === el)) outline(el, false);
    marked = picks.map((p) => p.box);
    for (const el of marked) outline(el, true);
    const box = ui.querySelector(".m");
    if (!box) return;
    box.replaceChildren(...picks.map((p, i) => {
      const r = p.box.getBoundingClientRect();
      const b = document.createElement("b");
      b.textContent = String(i + 1);
      b.style.left = r.left + scrollX - 12 + "px";
      b.style.top = r.top + scrollY - 12 + "px";
      return b;
    }));
  }
  // The Comment button is a 44 px round icon in the page's top right corner, 16 px in, level with the
  // top of its content and over it, scrolling away with the page. The page's first block keeps clear
  // of the corner's 76 px (the button and 16 px either side of it), whatever the app put there.
  const CORNER = 76, SIDE = "(var(--pad,20px) - 4px)", MARGIN = "max(0px,(100vw - 40rem) / 2)";
  const clear = document.createElement("style");
  // Wide enough to reach past the button's left edge, and tall enough that what follows starts
  // under it.
  clear.textContent = `main>:first-child{padding-right:max(0px,calc(${CORNER}px - ${SIDE} - ${MARGIN}));min-height:max(0px,calc(40px - var(--gap,14px)))}` +
    `main.center>:first-child{padding-left:max(0px,calc(${CORNER}px - ${SIDE} - ${MARGIN}))}`;
  function place() {
    // Open, the sheet is on the body too, out of the page's layout. Put back if the page took either out.
    if (host.parentNode !== document.body) document.body.append(host);
    if (!clear.isConnected) (document.head || document.body).append(clear);
  }
  // The sheet's buttons are House UI's: its block, which the page has inline, given to the shadow root
  // too, where the page's own styles don't reach (its tokens reach it, as inherited values).
  let adopted = false;
  function adopt() {
    if (adopted || !("adoptedStyleSheets" in ui) || typeof CSSStyleSheet !== "function") return;
    adopted = true;
    const house = [...document.querySelectorAll("style")].find((s) => s.textContent.startsWith("/* house ui:"));
    if (!house) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(house.textContent);
      ui.adoptedStyleSheets = [sheet];
    } catch (e) {}
  }
  const X = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  const BUBBLE = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7.5L4.5 13.5V11h-1A1.5 1.5 0 0 1 2 9.5V4a1.5 1.5 0 0 1 1.5-1.5Z"/></svg>';
  function build() {
    if (!document.body || composer) return;
    place();
    adopt();
    ui.innerHTML = `<style>
      :host{all:initial;display:block;font-family:var(--font-sans);color:var(--ink)}
      :focus-visible{outline:var(--size-focus) solid var(--focus);outline-offset:3px}
      [hidden]{display:none!important}
      .b{position:absolute;right:16px;top:calc(var(--pad,20px) + 12px);z-index:2147483646;box-sizing:border-box;width:44px;height:44px;padding:0;border-radius:50%;border:1px solid var(--tile-edge);background:var(--tile);color:var(--ink);box-shadow:var(--shadow-tile);display:flex;align-items:center;justify-content:center;cursor:pointer}
      .t{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;box-sizing:border-box;max-height:96vh;overflow:auto;padding:0 var(--space-4) var(--space-5);border:1px solid var(--tile-edge);border-bottom:0;border-radius:var(--radius-xl) var(--radius-xl) 0 0;background:var(--tile);color:var(--ink);box-shadow:var(--shadow-sheet);display:flex;flex-direction:column;gap:var(--space-2);font-size:1rem}
      .t.tray{padding-top:var(--space-3)}
      .top{position:relative;height:44px;margin-right:calc(-1 * var(--space-3));display:flex;align-items:center;justify-content:flex-end}
      .top>span{position:absolute;left:50%;top:10px;width:40px;height:4px;margin-left:-14px;border-radius:var(--radius-pill);background:var(--line)}
      .x{position:relative;flex:none;width:48px;height:48px;padding:0;border:0;border-radius:50%;background:none;color:var(--ink);display:grid;place-items:center;cursor:pointer}
      .m b{position:absolute;z-index:2147483645;width:24px;height:24px;box-sizing:border-box;border-radius:50%;border:2px solid var(--tile);background:var(--accent);color:var(--on-accent);display:grid;place-items:center;font:700 0.8125rem/1 var(--font-sans);pointer-events:none}
      @media (forced-colors:active){.m b{forced-color-adjust:none;background:Highlight;color:HighlightText;border-color:Canvas}}
    </style><button class="b" data-a="start" type="button" aria-label="Comment" title="Comment">${BUBBLE}</button><div class="m" aria-hidden="true"></div><div class="t" role="dialog" aria-modal="true" hidden><div class="top"><span aria-hidden="true"></span><button class="x" data-a="close" type="button" aria-label="Close">${X}</button></div><div class="w"></div></div>`;
    const title = "Comment on " + (cfg.title || cfg.app);
    ui.querySelector(".t").setAttribute("aria-label", title);
    composer = C.make(ui.querySelector(".w"), {
      label: title,
      placeholder: "Ask a question or describe a change",
      state: "expanded",
      tray: true,
      hint: "It goes to the chat as your message, and the agent answers there.",
      onPicks: mark,
      onPoint: (on) => {
        // Pointing lowers the sheet to the pick tray; Done brings it back, with the picks as chips.
        const sheet = ui.querySelector(".t");
        sheet.classList.toggle("tray", on);
        sheet.setAttribute("aria-modal", String(!on));
        sheet.setAttribute("aria-label", on ? "Point at the page" : title);
        ui.querySelector(".top").hidden = on;
        if (!on) composer.focus();
      },
      onSend: async (text, picks) => {
        const answer = await C.deliver(window, C.payload(cfg.workspace, message(text, picks)));
        if (answer.ok) setTimeout(shut, 0);
        return answer;
      },
    });
  }
  function show() {
    open = true;
    opener = ui.querySelector(".b");
    ui.querySelector(".b").hidden = true;
    ui.querySelector(".t").hidden = false;
    composer.focus();
  }
  // Closed: what was picked and written goes, and taps press again.
  function shut() {
    open = false;
    if (picking()) composer.point(false);
    composer.clear();
    ui.querySelector(".t").hidden = true;
    ui.querySelector(".b").hidden = false;
    if (opener) opener.focus();
  }
  ui.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("[data-a]");
    if (!a) return;
    if (a.getAttribute("data-a") === "start") show();
    else if (a.getAttribute("data-a") === "close") shut();
  });
  // Keys typed in the sheet are its own: from outside its shadow they'd look like keys on the page
  // (a deck's space and arrows turn its screen). Esc leaves pointing, else closes the sheet.
  ui.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && open) picking() ? composer.point(false) : shut();
  });
  // Without a chat to send to, Comment isn't put on the page, and nothing listens for it.
  if (chat && C) {
    for (const type of ["click", "pointerdown", "mousedown", "mouseup", "pointerup", "submit", "input", "change", "keydown", "touchend"])
      window.addEventListener(type, (e) => {
        if (!picking() || ours(e)) return;
        if (type === "keydown" && e.key === "Escape") composer.point(false);
        if (type !== "touchend") e.preventDefault();
        e.stopImmediatePropagation();
        if (type !== "click" || !e.target || e.target === document.body || e.target === document.documentElement) return;
        // Tapping a pick again unpicks it, and the numbers close up; a sixth does nothing.
        const at = composer.picks.findIndex((p) => p.box === e.target || p.box.contains(e.target));
        if (at >= 0) composer.remove(at);
        else composer.pick(pickOf(e.target));
      }, { capture: true });
    addEventListener("resize", () => composer && mark(composer.picks));
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
    else build();
    // A page that draws itself again can take the button, or the corner's rule, out with what it
    // replaces: each goes back at once, as it was (the button's shadow root goes with it).
    if (typeof MutationObserver === "function")
      new MutationObserver(() => (host.isConnected && clear.isConnected) || !document.body || place()).observe(document.documentElement, { childList: true, subtree: true });
  }

  serve(append, sync);
  return {
    /** The app as app.js's App.start takes it. */
    app: () => app(over(cfg.data), line),
  };
})();
