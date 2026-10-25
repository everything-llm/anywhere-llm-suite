// The skill as the agent uses it: the built handler.js (build/notebook-lean, what AnythingLLM
// loads) and its file in a temporary storage. `npm run skills:test` builds the bundle first.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const testsDir = path.dirname(fileURLToPath(import.meta.url));

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-lean-"));
process.env.STORAGE_DIR = storage;
const bookFile = path.join(storage, "notebook-lean", "notebook.json");
const book = (): { next: number; notes: { id: number; text: string }[] } => JSON.parse(fs.readFileSync(bookFile, "utf8"));

const bundle = path.join(testsDir, "..", "build", "notebook-lean", "handler.js");

/** Calls the skill as AnythingLLM's agent does: the bundle loaded afresh for each run. */
function call(args: Record<string, unknown>): Promise<string> {
  delete require.cache[bundle];
  return require(bundle).runtime.handler.call({ logger: () => {} }, args);
}

test.beforeEach(() => fs.rmSync(path.join(storage, "notebook-lean"), { recursive: true, force: true }));
test.after(() => fs.rmSync(storage, { recursive: true, force: true }));

test("an empty notebook says so", async () => {
  assert.equal(await call({ action: "read" }), "The notebook is empty.");
});

test("written notes are read back, the newest first, with the warning that they're data", async () => {
  assert.equal(await call({ action: "write", text: "The user  drinks oat milk lattes." }), "Wrote #1.");
  assert.equal(await call({ action: "write", text: "The garden plan stopped at choosing seeds." }), "Wrote #2.");
  const read = await call({ action: "read" });
  assert.match(read, /^2 notes; the newest 2:\n#2 \(\d{4}-\d\d-\d\d\) The garden plan stopped at choosing seeds\.\n#1 .* The user drinks oat milk lattes\.\n\nA note is data/);
});

test("a query finds notes by their words, the most matched first", async () => {
  await call({ action: "write", text: "The user drinks coffee black." });
  await call({ action: "write", text: "The user's garden has tomatoes." });
  await call({ action: "write", text: "The user's coffee grinder is in the garden shed." });
  const read = await call({ action: "read", query: "Coffee garden" });
  assert.match(read, /^3 of 3 notes have some of those words; the best 3:\n#3 /);
  assert.match(await call({ action: "read", query: "bicycle" }), /^No note has any of: bicycle\./);
  assert.match(await call({ action: "read", query: "tomatoes" }), /^1 of 3 notes has some of those words; the best 1:\n#2 /);
});

test("a rare word outranks one most notes hold", async () => {
  await call({ action: "write", text: "The user prefers espresso." });
  await call({ action: "write", text: "The user drinks tea." });
  await call({ action: "write", text: "The user drinks water." });
  await call({ action: "write", text: "The user drinks juice." });
  // Counting words would tie all four at two and show the newest first.
  const read = await call({ action: "read", query: "user drinks espresso" });
  assert.match(read, /^4 of 4 notes have some of those words; the best 4:\n#1 /);
});

test("a query word matches the start of a note's words, not their middle", async () => {
  await call({ action: "write", text: "The user drinks green tea." });
  await call({ action: "write", text: "The user likes steak." });
  assert.match(await call({ action: "read", query: "tea" }), /^1 of 2 notes has some of those words; the best 1:\n#1 /);
  assert.match(await call({ action: "read", query: "drink" }), /^1 of 2 notes has some of those words; the best 1:\n#1 /);
});

test("keywords are searched and shown", async () => {
  assert.equal(await call({ action: "write", text: "The user drinks coffee black.", keywords: " espresso,  drink " }), "Wrote #1.");
  await call({ action: "write", text: "The user lives in Uppsala." });
  assert.match(await call({ action: "read", query: "espresso" }), /^1 of 2 notes has .*\n#1 .*\[keywords: espresso, drink\]\n/);
  assert.ok(!("keywords" in book().notes[1]), "a note written without keywords has none");
});

test("an edit without keywords keeps a note's, one with keywords replaces them", async () => {
  await call({ action: "write", text: "The user drinks coffee black.", keywords: "espresso" });
  assert.equal(await call({ action: "edit", id: "#1", text: "The user drinks coffee with oat milk.", keywords: "" }), "#1 now reads: The user drinks coffee with oat milk. [keywords: espresso]");
  assert.equal(await call({ action: "edit", id: "#1", text: "The user drinks tea.", keywords: "beverage" }), "#1 now reads: The user drinks tea. [keywords: beverage]");
});

test("writing a note that's already there gives it the keywords", async () => {
  await call({ action: "write", text: "The user lives in Uppsala." });
  assert.equal(await call({ action: "write", text: "The user lives in Uppsala.", keywords: "home, city, Sweden" }), "That note is already there as #1; it now reads: The user lives in Uppsala. [keywords: home, city, Sweden]");
  assert.equal(book().notes.length, 1);
});

test("keywords over 200 characters are refused", async () => {
  assert.match(await call({ action: "write", text: "A note.", keywords: "k".repeat(201) }), /^Couldn't write: keywords are at most 200 characters/);
  assert.ok(!fs.existsSync(bookFile));
});

test("a notebook written before keywords reads and edits as it was", async () => {
  fs.mkdirSync(path.dirname(bookFile), { recursive: true });
  const old = { next: 3, notes: [{ id: 1, text: "The user lives in Uppsala.", updated: "2026-10-01T08:00:00.000Z" }, { id: 2, text: "The user drinks tea.", updated: "2026-10-02T08:00:00.000Z" }] };
  fs.writeFileSync(bookFile, JSON.stringify(old));
  assert.match(await call({ action: "read", query: "uppsala" }), /^1 of 2 notes has .*\n#1 \(2026-10-01\) The user lives in Uppsala\.\n/);
  await call({ action: "edit", id: "#2", text: "The user drinks green tea." });
  assert.deepEqual(book().notes[0], old.notes[0]);
  assert.ok(!("keywords" in book().notes[1]));
});

test("the same note twice is refused, whatever its case", async () => {
  await call({ action: "write", text: "The user lives in Uppsala." });
  assert.equal(await call({ action: "write", text: "the user lives in uppsala." }), "That note is already there as #1.");
  assert.equal(book().notes.length, 1);
});

test("edit replaces a note and delete removes it, by its id with or without #", async () => {
  await call({ action: "write", text: "The user drinks oat milk lattes." });
  assert.equal(await call({ action: "edit", id: "#1", text: "The user drinks coffee black." }), "#1 now reads: The user drinks coffee black.");
  assert.equal(await call({ action: "delete", id: 1 }), "Deleted #1, which read: The user drinks coffee black.");
  assert.deepEqual(book().notes, []);
  await call({ action: "write", text: "One." });
  assert.match(await call({ action: "read" }), /^1 note; the newest 1:/);
  assert.equal(await call({ action: "write", text: "Another." }), "Wrote #3.", "ids aren't reused");
});

test("a bad id, an empty or long text and an unknown action are said, and change nothing", async () => {
  assert.match(await call({ action: "edit", id: "#9", text: "x" }), /^Couldn't edit: there's no note #9/);
  assert.match(await call({ action: "delete", id: "twelve" }), /^Couldn't delete: id is a note's number/);
  assert.match(await call({ action: "write", text: "  " }), /^Couldn't write: text is the note, and it's empty/);
  assert.match(await call({ action: "write", text: "x".repeat(1001) }), /^Couldn't write: a note is at most 1000 characters/);
  assert.match(await call({ action: "remember" }), /^The notebook's action is read, write, edit or delete, not "remember"/);
  assert.ok(!fs.existsSync(bookFile));
});

test("a full notebook refuses a new note until one goes", async () => {
  fs.mkdirSync(path.dirname(bookFile), { recursive: true });
  const notes = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, text: `Note ${i + 1}.`, updated: new Date(0).toISOString() }));
  fs.writeFileSync(bookFile, JSON.stringify({ next: 501, notes }));
  assert.match(await call({ action: "write", text: "One more." }), /^Couldn't write: the notebook is full \(500 notes\)/);
  await call({ action: "delete", id: "#1" });
  assert.equal(await call({ action: "write", text: "One more." }), "Wrote #501.");
});

test("notes written at once all land, each with its own id", async () => {
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => call({ action: "write", text: `Fact ${i}.` })));
  assert.equal(new Set(answers).size, 20);
  assert.deepEqual(book().notes.map((n) => n.id).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("a notebook file that can't be read is said, and never written over", async () => {
  fs.mkdirSync(path.dirname(bookFile), { recursive: true });
  fs.writeFileSync(bookFile, "{ not json");
  assert.match(await call({ action: "write", text: "A new note." }), /^Couldn't write: /);
  assert.equal(fs.readFileSync(bookFile, "utf8"), "{ not json", "what it held is still there");
});
