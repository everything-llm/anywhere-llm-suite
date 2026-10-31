import assert from "node:assert/strict";
import { test } from "node:test";
import { card, changeText, headline, ROWS } from "../src/card.ts";
import { ICONS } from "../src/icons.ts";

test("a list's card is a quote of its title and what is left, then its items as ☑ and ☐", () => {
  const app = { title: "Groceries", card: { items: "/items" }, data: { items: [{ text: "Eggs", done: true }, { text: "Milk", done: false }] } };
  assert.deepEqual(card(app), ["> **Groceries**", ">", "> 1 of 2 left", "", "- ☑ ~~Eggs~~", "- ☐ Milk"]);
});

test("the change line is what the call changed, then the summary", () => {
  const app = { title: "Groceries", card: { items: "/items" }, data: { items: [{ text: "Oat milk", done: false }] } };
  const change = changeText({ ev: "add", fields: { text: "Oat milk" } });
  assert.equal(change, "add: Oat milk");
  assert.deepEqual(card(app, null, change).slice(0, 3), ["> **Groceries**", ">", "> add: Oat milk · 1 of 1 left"]);
  assert.equal(changeText({ ev: "new week" }), "new week");
});

test("a summary reads pointers and lengths, and long lists are cut", () => {
  const events = Array.from({ length: ROWS + 2 }, (_, i) => ({ title: `E${i}` }));
  const lines = card({ title: "Cal", card: { items: "/events", text: "title", summary: "{/events/length} events, first {/events/0/title}" }, data: { events } });
  assert.equal(lines[2], `> ${ROWS + 2} events, first E0`);
  assert.equal(lines.at(-1), "- …and 2 more");
  assert.equal(lines[4], "- E0");
  assert.equal(lines.length, 4 + ROWS + 1);
});

test("missing values never break a card, and with no line the quote is the title alone", () => {
  assert.deepEqual(card({ title: "T", card: { items: "/nope", summary: "{/x}" }, data: {} }), ["> **T**"]);
});

test("a line break in an item, the title or the summary can't break the quote or the list", () => {
  const lines = card({ title: "A\nB", card: { items: "/items", summary: "x\ny" }, data: { items: [{ text: "a|b\nc", done: false }] } });
  assert.deepEqual(lines, ["> **A B**", ">", "> x y", "", "- ☐ a|b c"]);
});

test("a summary that points at a list says how many it holds, not the list", () => {
  assert.equal(card({ title: "Kanban Board", card: { summary: "/cards" }, data: { cards: [{ t: "a" }, { t: "b" }] } })[2], "> 2 cards");
});

test("with an address the title opens the app's page, titled with its icon when it's one of the set", () => {
  const url = "http://x:3001/apps-lean/tok.html";
  const list = { title: "Groceries", icon: "cart", card: { items: "/items" }, data: { items: [{ text: "Eggs", done: false }] } };
  assert.deepEqual(card(list, url).slice(0, 3), [`> **[Groceries](${url} "cart")**`, ">", "> 1 of 1 left"]);
  assert.equal(headline(list, url), `**[Groceries](${url} "cart")** · 1 of 1 left`, "list's line is titled the same way");
  assert.deepEqual(card({ title: "Wordle", card: { summary: "streak {/streak}" }, data: { streak: 3 } }, url), [`> **[Wordle](${url})**`, ">", "> streak 3"], "no icon: no title");
  assert.equal(card({ title: "W", icon: "rocket", card: {}, data: {} }, url)[0], `> **[W](${url})**`, "a name not in the set isn't written");
  assert.equal(card({ title: "A [b] | c", card: {}, data: {} }, url)[0], `> **[A \\[b\\] | c](${url})**`, "brackets in a title can't break the link");
  assert.equal(card({ title: "Groceries", icon: "cart", card: {}, data: {} })[0], "> **Groceries**", "without an address there's no link to title");
  assert.equal(ICONS.length, 24);
});
