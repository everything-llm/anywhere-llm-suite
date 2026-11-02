// composer.js: the one composer for a message that may point at things on a page, as the design
// canvas draws it (Shared pieces: "Composer: message with optional picks"). Apps' Comment holds it
// expanded in its sheet, and the browser's chat bar on a chat's tab holds it collapsed above the bar
// (expanded above the keyboard while it's typed in). It's text a page carries inline (build.mjs's
// PAGE_LIBRARIES, by the name composer.js), ahead of the page's own script, so both pages run this
// same code; under Node it's a module, for its tests (shared/composer.test.mts).
//
// Expanded: a label over a field that shows 3 lines, grows to about 6, then scrolls; the picks as
// numbered chips above it, each with a remove ×; Point at the page and Send (off while the field is
// empty) under it. Collapsed: one line with Point (a crosshair), the field and a round Send. While
// pointing, a line says "Tap up to 5 things on the page · n of 5" with Done above it; in a tray
// (Apps' sheet lowered while pointing) that line is all it shows. Up to 5 picks, and none is fine; a
// password field can't be picked. What a tap picks, and the marks on the page, are the page's: it
// gives each pick as { key, chip, line, secret } (the chip's words, and the line the agent reads).
//
// The message goes to AnywhereLLM's channel (window.AnywhereLLMApps, AnywhereLLM Lite's androidx
// WebMessageListener: postMessage(string), and its reply as a message event on the channel, a JSON
// string, {"ok":true,"chat":"<name>"} or {"ok":false,"error":"<text>"}). Lite parses strictly: exactly
// {comment:{workspace, message}} or {comment:{workspace, thread, message}}, and {open:{workspace,
// thread?}}, at most 8 KB. A page without that channel (one opened outside AnywhereLLM) has no chat to
// send to, and shows no composer.
/** A pick: `key` tells it from the others (a ref, an element), `chip` is its chip's words, `line` the
 *  line the agent reads for it, `secret` marks a password field, and `box` is the page's own.
 *  @typedef {{ key: unknown, chip: string, line: string, secret?: boolean, box?: any }} Pick */
/** What AnywhereLLM said about a message: whether it went, the chat it went to, and why not.
 *  @typedef {{ ok?: boolean, why?: string, chat?: string }} Answer */
/** @typedef {{ label?: string, placeholder?: string, state?: "expanded" | "collapsed", tray?: boolean, hint?: string,
 *    onPoint?: (on: boolean) => void, onPicks?: (picks: Pick[]) => void, onExpand?: (on: boolean) => void,
 *    onSend?: (text: string, picks: Pick[]) => Promise<Answer> }} Options */
var AnywhereComposer = (() => {
  /** At most this many picks, and this many characters said. */
  const MAX = 5, LIMIT = 1000;
  /** How long AnywhereLLM has to say whether the message went, and the most it takes (bytes). */
  const WAIT_MS = 8000, MAX_BYTES = 8192;

  /** The message as the agent reads it: `head` (a line naming the page, ending in a colon), one
   *  numbered line per pick, then the words said. */
  /** @param {string} head @param {Pick[]} picks @param {string} words @returns {string} */
  function message(head, picks, words) {
    const said = String(words || "").trim();
    if (!picks || !picks.length) return head + "\n\n" + said;
    return [head, ...picks.map((p, i) => i + 1 + ". " + p.line), "", said].join("\n");
  }

  /** What picking `pick` does to `picks`: one picked already is unpicked (the numbers close up),
   *  another is added while there's room. A secret (a password field) is refused, and a sixth does
   *  nothing. Answers the picks after it, and `refused` with why when it changed nothing. */
  /** @param {Pick[]} picks @param {Pick | null | undefined} pick @returns {{ picks: Pick[], refused: string | null }} */
  function toggle(picks, pick) {
    if (!pick) return { picks, refused: "" };
    if (pick.secret) return { picks, refused: "A password field can’t be picked." };
    const at = picks.findIndex((p) => p.key === pick.key);
    if (at >= 0) return { picks: picks.filter((_, i) => i !== at), refused: null };
    if (picks.length >= MAX) return { picks, refused: "That’s 5 already. Remove one to pick another." };
    return { picks: [...picks, pick], refused: null };
  }

  /** What's posted to AnywhereLLM's channel: the message, for the chat `thread` names (its slug), or
   *  with no thread (none given, or null) for the chat AnywhereLLM has open. */
  const payload = (/** @type {string} */ workspace, /** @type {string} */ text, /** @type {string | null | undefined} */ thread) =>
    JSON.stringify({ comment: thread ? { workspace, thread, message: text } : { workspace, message: text } });
  /** What opens that chat in AnywhereLLM; with no thread, its main chat. */
  const opening = (/** @type {string} */ workspace, /** @type {string | null | undefined} */ thread) => JSON.stringify({ open: thread ? { workspace, thread } : { workspace } });

  /** AnywhereLLM's reply, as an Answer; null for a message that isn't one. */
  function reply(/** @type {any} */ data) {
    let r = data;
    try {
      if (typeof data === "string") r = JSON.parse(data);
    } catch (e) {
      return null;
    }
    if (!r || typeof r !== "object" || typeof r.ok !== "boolean") return null;
    return r.ok ? { ok: true, chat: typeof r.chat === "string" ? r.chat : undefined } : { ok: false, why: String(r.error || r.why || "AnywhereLLM didn’t take it.") };
  }

  /** AnywhereLLM's channel on `win`, or null outside AnywhereLLM. */
  const channel = (/** @type {any} */ win) => (win && win.AnywhereLLMApps && typeof win.AnywhereLLMApps.postMessage === "function" ? win.AnywhereLLMApps : null);

  /** Posts `json` on the channel and waits for AnywhereLLM's word: its reply on the channel (an
   *  older AnywhereLLM's anywherellm-comment event on the window is heard too); none in WAIT_MS is a
   *  failure, as is a message past MAX_BYTES, which isn't posted.
   *  @param {any} win @param {string} json @returns {Promise<Answer>} */
  function deliver(win, json, wait = WAIT_MS) {
    const chat = channel(win);
    if (!chat) return Promise.resolve({ ok: false, why: "AnywhereLLM isn’t here to send it." });
    const bytes = typeof TextEncoder === "function" ? new TextEncoder().encode(json).length : json.length * 3;
    if (bytes > MAX_BYTES) return Promise.resolve({ ok: false, why: "It’s too long to send. Make it shorter." });
    return new Promise((done) => {
      const was = chat.onmessage;
      const listens = typeof chat.addEventListener === "function";
      const finish = (/** @type {Answer} */ answer) => {
        clearTimeout(timer);
        if (listens) chat.removeEventListener("message", heard);
        else chat.onmessage = was;
        if (typeof win.removeEventListener === "function") win.removeEventListener("anywherellm-comment", older);
        done(answer);
      };
      const heard = (/** @type {any} */ e) => {
        const answer = reply(e && e.data);
        if (answer) finish(answer);
      };
      const older = (/** @type {any} */ e) => finish(reply((e && e.detail) || {}) || { ok: false, why: "AnywhereLLM didn’t take it." });
      const timer = setTimeout(() => finish({ ok: false, why: "AnywhereLLM didn’t answer. Try again in a moment." }), wait);
      if (listens) chat.addEventListener("message", heard);
      else chat.onmessage = heard;
      if (typeof win.addEventListener === "function") win.addEventListener("anywherellm-comment", older);
      try {
        chat.postMessage(json);
      } catch (e) {
        finish({ ok: false, why: "AnywhereLLM didn’t take it. Try again in a moment." });
      }
    });
  }

  const ICON = {
    point: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
    send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    warn: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  };
  const svg = (/** @type {keyof typeof ICON} */ name, /** @type {number} */ size, width = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  /** The composer's look, on House UI's tokens and its buttons (hu-button), which the page has. */
  const CSS = `/* composer */
.cp{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:var(--space-2);color:var(--ink);font-family:var(--font-sans);font-size:1rem}
.cp *{box-sizing:border-box}
.cp button,.cp input,.cp textarea{font:inherit;color:inherit}
.cp button{cursor:pointer}
.cp [hidden]{display:none!important}
.cp-label{font:600 0.875em/1.4 var(--font-sans);color:var(--ink)}
.cp-mode{display:flex;align-items:center;gap:var(--space-2);padding-left:var(--space-2)}
.cp-mode p{flex:1;min-width:0;margin:0;font:400 0.875em/1.4 var(--font-sans);color:var(--ink)}
.cp-picks{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:var(--space-2)}
.cp-pick{display:inline-flex;align-items:center;gap:6px;min-height:36px;max-width:100%;padding:0 0 0 var(--space-3);border:1px solid var(--accent);border-radius:var(--radius-pill);background:var(--accent-soft);color:var(--ink);font:500 0.8125em/1.3 var(--font-sans)}
.cp-pick>span{min-width:0;overflow-wrap:anywhere}
.cp-pick button{position:relative;flex:none;width:32px;height:32px;margin-right:1px;padding:0;border:0;border-radius:50%;background:none;display:grid;place-items:center}
.cp-pick button::after{content:"";position:absolute;inset:-8px}
.cp-row{display:flex;align-items:center;gap:var(--space-2)}
.cp-icon{position:relative;flex:none;min-width:48px;min-height:48px;padding:0;border:0;border-radius:var(--radius-pill);background:none;display:grid;place-items:center}
.cp-point[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);box-shadow:inset 0 0 0 2px var(--accent)}
.cp-field{flex:1;min-width:0;min-height:48px;display:flex;align-items:center;gap:var(--space-1);padding:0 0 0 var(--space-4);border-radius:var(--radius-pill);background:var(--tile);box-shadow:inset 0 0 0 1px var(--line-strong)}
.cp-field:focus-within{box-shadow:inset 0 0 0 2px var(--accent)}
.cp-input{flex:1;min-width:0;min-height:var(--size-control-touch);border:0;background:none;padding:0;font:400 1em/1.3 var(--font-sans);white-space:nowrap;text-overflow:ellipsis;outline:none}
.cp-input::placeholder,.cp-area::placeholder{color:var(--muted);opacity:1}
.cp-send{flex:none;width:48px;height:48px;border:0;padding:0;background:none;display:flex;align-items:center;justify-content:center}
.cp-send>span{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--accent);color:var(--on-accent);box-shadow:var(--shadow-glow)}
.cp-send:disabled{cursor:default}
.cp-send:disabled>span{background:var(--sunken);color:var(--muted);box-shadow:none}
.cp-area{display:block;width:100%;min-height:calc(4.5em + 26px);max-height:calc(9em + 26px);overflow-y:auto;resize:none;margin:0;padding:12px 14px;border:1px solid var(--line-strong);border-radius:var(--radius-lg);background:var(--tile);font:400 1em/1.5 var(--font-sans)}
.cp-area:focus-visible{outline:none;border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.cp-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2)}
.cp-actions .hu-button{min-height:48px;font-size:1em}
.cp-actions .hu-button svg{width:1.25em;height:1.25em}
.cp-said{margin:0;display:flex;align-items:flex-start;gap:var(--space-2);font:400 0.8125em/1.4 var(--font-sans);color:var(--ink)}
.cp-said svg{flex:none;margin-top:1px;color:var(--danger)}
.cp-said:empty{display:none}
@media (forced-colors:active){.cp-field{border:1px solid CanvasText}.cp-pick{border-color:CanvasText}.cp-point[aria-pressed="true"]{outline:2px solid Highlight;outline-offset:-2px}.cp-area:focus-visible{outline:2px solid Highlight;outline-offset:-2px}.cp-send>span{forced-color-adjust:none;border:1px solid CanvasText;background:Canvas;color:CanvasText;box-shadow:none}.cp-send:disabled>span{color:GrayText;border-color:GrayText}}
/* end of composer */`;

  let made = 0;
  /** The composer, drawn into `root` (an element, or a shadow root): the page tells it what a tap
   *  picks (pick), and it tells the page what changed. Options: label, placeholder, state
   *  ("expanded" or "collapsed"), tray (while pointing, the mode line alone), hint (the line under
   *  an expanded field), and the page's own: onPoint(on), onPicks(picks), onExpand(on), and
   *  onSend(text, picks), which answers { ok, why } (a Promise). */
  /** @param {any} root @param {Options} [o] */
  function make(root, o = {}) {
    const doc = root.ownerDocument || root;
    const id = "cp" + ++made;
    if (!root.composerStyled) {
      const style = doc.createElement("style");
      style.setAttribute("data-composer", "");
      style.textContent = CSS;
      root.append(style);
      root.composerStyled = true; // one style however many composers it holds
    }
    /** An element: its attributes (a boolean one given as true), then its children; `draw` is
     *  fixed markup of this file's own (an icon), never text from the page. */
    const h = (/** @type {string} */ tag, /** @type {Record<string, string | boolean>} */ attrs = {}, /** @type {any[]} */ ...kids) => {
      const n = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "draw") n.innerHTML = String(v);
        else if (v === true) n.setAttribute(k, "");
        else if (v !== false) n.setAttribute(k, String(v));
      }
      n.append(...kids);
      return n;
    };
    const label = o.label || "Message";
    const modeLine = h("p", { role: "status" });
    const mode = h("div", { class: "cp-mode", hidden: true }, modeLine, h("button", { type: "button", class: "hu-button hu-button--secondary", "data-a": "done" }, "Done"));
    const title = h("label", { class: "cp-label", for: id + "-area" }, label);
    const list = h("ul", { class: "cp-picks", hidden: true });
    const area = h("textarea", { class: "cp-area", id: id + "-area", rows: "3", maxlength: String(LIMIT), placeholder: o.placeholder || "" });
    const said = h("p", { class: "cp-said", role: "status" });
    const points = [
      h("button", { type: "button", class: "hu-button hu-button--secondary", "data-a": "point", "aria-pressed": "false", draw: svg("point", 20) }, "Point at the page"),
      h("button", { type: "button", class: "cp-icon cp-point", "data-a": "point", "aria-label": "Point at the page", "aria-pressed": "false", draw: svg("point", 22) }),
    ];
    const sends = [
      h("button", { type: "button", class: "hu-button hu-button--primary", "data-a": "send", disabled: true, draw: svg("send", 20, 2.4) }, "Send"),
      h("button", { type: "button", class: "cp-send", "data-a": "send", "aria-label": "Send", disabled: true }, h("span", { draw: svg("send", 16, 3) })),
    ];
    const actions = h("div", { class: "cp-actions" }, points[0], sends[0]);
    const input = h("input", { type: "text", class: "cp-input", maxlength: String(LIMIT), autocomplete: "off", enterkeyhint: "send", "aria-label": label, placeholder: o.placeholder || "" });
    const row = h("div", { class: "cp-row" }, points[1], h("div", { class: "cp-field" }, input, sends[1]));
    const box = h("div", { class: "cp", role: "group", "aria-label": label }, mode, title, list, area, said, actions, row);
    root.append(box);
    /** @type {any[]} */
    let removers = [];
    /** @type {Pick[]} */
    let picks = [];
    let text = "", pointing = false, expanded = o.state !== "collapsed", sending = false, line = { text: o.hint || "", bad: false };

    function fit() {
      area.style.height = "auto";
      if (area.scrollHeight) area.style.height = area.scrollHeight + 2 + "px"; // the CSS keeps it between 3 and about 6 lines
    }
    function draw() {
      const tray = pointing && !!o.tray;
      box.setAttribute("data-state", expanded ? "expanded" : "collapsed");
      mode.hidden = !pointing;
      modeLine.textContent = "Tap up to " + MAX + " things on the page · " + picks.length + " of " + MAX;
      title.hidden = area.hidden = said.hidden = actions.hidden = !expanded || tray;
      row.hidden = expanded || tray;
      list.hidden = !picks.length || tray;
      list.setAttribute("aria-label", picks.length + " picked on the page");
      removers = picks.map((p, i) => h("button", { type: "button", "data-a": "remove", "data-i": String(i), "aria-label": "Remove " + (i + 1) + ", " + String(p.chip).replace(/[“”]/g, ""), draw: svg("x", 14, 2.4) }));
      list.replaceChildren(...picks.map((p, i) => h("li", { class: "cp-pick" }, h("span", {}, i + 1 + " · " + p.chip), removers[i])));
      for (const b of points) b.setAttribute("aria-pressed", String(pointing));
      for (const b of sends) b.disabled = sending || !text.trim();
      if (area.value !== text) area.value = text;
      if (input.value !== text) input.value = text;
      said.replaceChildren();
      if (line.text) {
        if (line.bad) said.append(h("span", { draw: svg("warn", 16) }));
        said.append(h("span", {}, line.text));
      }
      said.setAttribute("role", line.bad ? "alert" : "status");
      if (expanded) fit();
    }
    const typed = (/** @type {any} */ e) => {
      text = e.target.value;
      for (const b of sends) b.disabled = sending || !text.trim();
      if (e.target === area) fit();
    };
    area.addEventListener("input", typed);
    input.addEventListener("input", typed);
    input.addEventListener("keydown", (/** @type {any} */ e) => e.key === "Enter" && (e.preventDefault(), send()));
    input.addEventListener("focus", () => o.onExpand && o.onExpand(true));

    /** @returns {Promise<Answer | undefined>} */
    async function send() {
      if (sending || !text.trim() || !o.onSend) return;
      sending = true;
      draw();
      /** @type {Answer} */
      let answer;
      try {
        answer = (await o.onSend(text.trim(), picks.slice())) || {};
      } catch (e) {
        answer = { ok: false, why: String((e instanceof Error && e.message) || e) };
      }
      sending = false;
      if (answer.ok) {
        text = "";
        picks = [];
        line = { text: o.hint || "", bad: false };
        if (o.onPicks) o.onPicks(picks);
      } else line = { text: "Not sent: " + (answer.why || "AnywhereLLM didn’t answer. Try again in a moment."), bad: true };
      draw();
      return answer;
    }
    /** @param {boolean} on */
    function point(on) {
      if (pointing === !!on) return;
      pointing = !!on;
      draw();
      if (o.onPoint) o.onPoint(pointing);
    }
    box.addEventListener("click", (/** @type {any} */ e) => {
      let b = e.target;
      while (b && b !== box && !(b.getAttribute && b.getAttribute("data-a"))) b = b.parentNode;
      if (!b || b === box || b.disabled) return;
      const a = b.getAttribute("data-a");
      if (a === "send") return void send();
      if (a === "point") return point(!pointing);
      if (a === "done") return point(false);
      if (a === "remove") {
        const at = Number(b.getAttribute("data-i"));
        picks = picks.filter((_, i) => i !== at);
        draw();
        if (o.onPicks) o.onPicks(picks);
        const next = removers[Math.min(at, picks.length - 1)];
        (next || (expanded ? area : input)).focus();
      }
    });
    draw();
    return {
      el: box,
      get picks() { return picks.slice(); },
      get pointing() { return pointing; },
      get expanded() { return expanded; },
      get text() { return text; },
      /** Picks or unpicks `p` ({ key, chip, line, secret }); answers why it changed nothing, or null. */
      /** @param {Pick} p */
      pick(p) {
        const r = toggle(picks, p);
        if (r.refused === null) {
          picks = r.picks;
          if (o.onPicks) o.onPicks(picks);
        }
        draw();
        if (r.refused) modeLine.textContent = r.refused + " " + picks.length + " of " + MAX;
        return r.refused;
      },
      /** Unpicks the pick at `i`. */
      /** @param {number} i */
      remove(i) {
        picks = picks.filter((_, at) => at !== i);
        draw();
        if (o.onPicks) o.onPicks(picks);
      },
      point,
      /** Expanded (the multi-line field) or collapsed (one line); its field focused unless `focus` is false. */
      /** @param {boolean} on */
      expand(on, focus = true) {
        if (expanded === !!on) return;
        expanded = !!on;
        draw();
        if (!focus) return;
        const field = expanded ? area : input;
        field.focus();
        if (field.setSelectionRange) field.setSelectionRange(text.length, text.length);
      },
      /** The line under the field: a hint, or (bad) what went wrong. */
      /** @param {string} words */
      say(words, bad = false) {
        line = { text: words || "", bad };
        draw();
      },
      clear() {
        text = "";
        picks = [];
        pointing = false;
        line = { text: o.hint || "", bad: false };
        draw();
        if (o.onPicks) o.onPicks(picks);
      },
      focus() {
        (expanded ? area : input).focus();
      },
      send,
    };
  }

  return { MAX, LIMIT, WAIT_MS, MAX_BYTES, CSS, message, toggle, payload, opening, reply, channel, deliver, make };
})();
if (typeof module === "object" && module && module.exports) module.exports = AnywhereComposer;
