// An app's card: its title, a line under it and up to ROWS rows, as Markdown the agent puts in its
// reply. app.json's card names what to show:
//   summary  text for the line under the title, after what the call changed
//   lines    a list of texts, or one pointer to a list in the data
//   items    a pointer to a list in the data: one row each, with a tick when the item has a `done`
//            key; `text` and `done` name the keys (default "text" and "done"); `where` keeps only
//            the items whose keys have those values
// A text that starts with "/" is a JSON Pointer into the data; elsewhere {/pointer} is replaced by
// what the pointer finds, and a pointer ending in /length on a list is its length. A missing value
// reads as empty, so a card never fails to draw.

import { iconOf } from "./icons.ts";
import { get, type Json } from "./patch.ts";

export const ROWS = 6;
const TEXT_MAX = 120;

function lookup(data: Json, pointer: string): Json {
  try {
    return found(data, pointer);
  } catch {
    return undefined; // a card never breaks an answer: what isn't there shows as nothing
  }
}

function found(data: Json, pointer: string): Json {
  if (pointer.endsWith("/length")) {
    const list = get(data, pointer.slice(0, -"/length".length));
    return Array.isArray(list) ? list.length : undefined;
  }
  return get(data, pointer);
}

const plain = (v: Json): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const short = (s: string): string => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX - 1) + "…" : s);

/** A pointer's value as a card says it: a list as how many it holds ("3 cards"), else as text. */
const counted = (v: Json, pointer: string): string => (Array.isArray(v) ? `${v.length} ${pointer.split("/").pop()}` : plain(v));

/** A card's text: a pointer's value, or text with {/pointer}s filled in. */
const textOf = (data: Json, text: Json): string =>
  typeof text !== "string" ? "" : text.startsWith("/") ? counted(lookup(data, text), text) : text.replace(/\{(\/[^{}]*)\}/g, (_, p) => plain(lookup(data, p)));

/** The items the card lists: the pointer's list, less those `where` leaves out. */
function itemsOf(spec: Json, data: Json): Json[] | null {
  const found = typeof spec.items === "string" ? get(data, spec.items) : undefined;
  if (!Array.isArray(found)) return null;
  const where = spec.where && typeof spec.where === "object" ? Object.entries(spec.where) : [];
  return found.filter((i) => where.every(([k, v]) => i && typeof i === "object" && i[k] === v));
}

function summaryOf(card: Json, data: Json, items: Json[] | null): string {
  if (typeof card.summary === "string") return textOf(data, card.summary);
  if (!items) return "";
  const done = card.done || "done";
  if (items.some((i) => i && typeof i === "object" && typeof i[done] === "boolean")) {
    const left = items.filter((i) => !(i && i[done] === true)).length;
    return `${left} of ${items.length} left`;
  }
  return `${items.length} item${items.length === 1 ? "" : "s"}`;
}

/** Text on one line, as a quote's or a list's line must be. */
const flat = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ");

/** The card's summary line, as text: what the headline says beside the title. */
export function summary(app: Json): string {
  const spec = app.card || {};
  return summaryOf(spec, app.data, itemsOf(spec, app.data));
}

/** The app's title as the card's bold name: with an address, the link to its page, titled with its
 *  icon's name when it has one of the set (a Markdown client shows the title only as a tooltip). */
function named(app: Json, url?: string | null): string {
  const icon = iconOf(app);
  return `**${url ? `[${flat(app.title).replace(/[[\]]/g, "\\$&")}](${url}${icon ? ` "${icon}"` : ""})` : flat(app.title)}**`;
}

/** An app as one line, as list gives each: its name (linked, as on the card) and its summary. */
export function headline(app: Json, url?: string | null): string {
  const line = summary(app);
  return `${named(app, url)}${line ? ` · ${flat(line)}` : ""}`;
}

/** What one change did, as the card and the apps manager say it: "add: Oat milk". */
export const changeText = (h: Json): string => `${h.ev}${typeof h?.fields?.text === "string" ? `: ${short(flat(h.fields.text))}` : ""}`;

/** The card's Markdown lines: a quote whose first paragraph is the app's name, bold, as the link to its
 *  page titled with its glyph, then the change line: what this call changed (`change`), if anything,
 *  and the summary. The library's cards for the Vault and the Library are quotes of the same shape, so
 *  AnywhereLLM Lite has one rule for a card (docs/page-links.md, the card in an answer); any other
 *  client shows the quote. Its items follow the quote as a list, ☐ and ☑ (AnythingLLM's chat draws no
 *  Markdown checkboxes), a ticked one struck through, at most ROWS of them. */
export function card(app: Json, url?: string | null, change?: string | null): string[] {
  const line = [change, summary(app)].filter(Boolean).map((t) => flat(t as string)).join(" · ");
  const quote = [`> ${named(app, url)}`, ...(line ? [">", `> ${line}`] : [])];
  const spec = app.card || {};
  const found = itemsOf(spec, app.data);
  const items = found && found.length ? found : null;
  if (!items) {
    // A pointer's list is data, shown as it is; a list in the card is texts that may point.
    const fromData = typeof spec.lines === "string";
    const listed = fromData ? lookup(app.data, spec.lines) : spec.lines;
    const lines: string[] = Array.isArray(listed) ? listed.slice(0, ROWS).map((l) => flat(short(fromData ? plain(l) : textOf(app.data, l)))).filter(Boolean) : [];
    return lines.length ? [...quote, "", ...lines.map((l) => `- ${l}`)] : quote;
  }
  const textKey = spec.text || "text", doneKey = spec.done || "done";
  const rows = items.slice(0, ROWS).map((item) => {
    const isObject = item && typeof item === "object" && !Array.isArray(item);
    const text = flat(short(plain(isObject ? item[textKey] : item)) || "(empty)");
    const done = isObject && typeof item[doneKey] === "boolean" ? (item[doneKey] as boolean) : null;
    return done === null ? `- ${text}` : done ? `- ☑ ~~${text}~~` : `- ☐ ${text}`;
  });
  return [...quote, "", ...rows, ...(items.length > ROWS ? [`- …and ${items.length - ROWS} more`] : [])];
}
