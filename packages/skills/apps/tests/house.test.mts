// An artifact's page looks as the design canvas draws the apps' parts: House UI's tokens and buttons
// (the block every suite page carries, the Vault's), the scheme the page names in data-scheme, and its
// increased-contrast themes. A page written before (a hue in --accent-h, app.css's older token names)
// still draws, in the scheme nearest its hue.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { definitionFor, skillDir } from "./harness.mts";
import { houseRoot, render, SCHEMES, schemeOfHue, schemesFor } from "../src/page.ts";
import * as parts from "../src/parts.ts";

const vault = fs.readFileSync(fileURLToPath(new URL("../../../shared/vault.html", import.meta.url)), "utf8");
const block = /\/\* house ui:[\s\S]*?\/\* end of house ui \*\//.exec(vault)![0];
const libs = parts.libraries();
const page = (html: string) => render({ name: "groceries", title: "Groceries", line: 0, ...definitionFor("list", { title: "Groceries" }), page: html, data: { items: [] } }, "home", "brx-test")!;
const list = () => parts.compose(parts.template("column"), "item-list");
const htmlTag = (html: string) => /<html\b[^>]*>/.exec(html)![0];
const styles = (html: string) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);

test("a page carries the Vault's House UI block, then the schemes it names, then app.css; its <html> is House UI's root", () => {
  assert.equal(libs["house.css"], block, "the same block as every suite page, from shared/vault.html");
  const html = page(list());
  const [house, schemes, app] = styles(html);
  assert.equal(house, block);
  assert.equal(app, libs["app.css"]);
  assert.doesNotMatch(schemes, /--(blue|teal|green|amber|coral|rose|violet|graphite)-/, "no scheme it doesn't name");
  assert.match(schemes, /^\[data-scheme="indigo"\]/m);
  assert.equal(htmlTag(html), '<html lang="en" data-scheme="indigo" class="hu-root">');
});

test("a page that names a scheme gets its tokens in every layer, light, dark and more contrast, and no other", () => {
  const html = page(list().replace('data-scheme="indigo"', 'data-scheme="teal"'));
  const schemes = styles(html)[1];
  assert.equal(schemes.match(/--teal-ground:/g)?.length, 10, "the ten layers House UI's tokens have");
  assert.match(schemes, /\[data-theme="dark-hc"\] \{\n {2}--teal-ground:/);
  assert.match(schemes, /@media \(prefers-contrast: more\) \{\n {2}:root:where\(:not\(\[data-contrast="off"\]\)\) \{\n {4}--teal-ground:/);
  assert.match(schemes, /^\[data-scheme="teal"\] \{ --ground: var\(--teal-ground\);/m);
  assert.doesNotMatch(schemes, /--rose-|data-scheme="rose"/);
  assert.doesNotMatch(schemes, /\{\s*\}/, "no layer left empty");
  // an element of its own in another scheme
  assert.match(schemesFor('<html data-scheme="teal"><div data-scheme="rose">', libs["schemes.css"]), /--rose-accent:/);
});

test("schemes.css has the other eight schemes in the block's layers, the same names as indigo in each", () => {
  const css = libs["schemes.css"];
  const layers = (text: string) => [...text.matchAll(/^ *([^\n{}]*\S) \{$/gm)].map((m) => m[1]);
  const tokens = block.slice(0, block.indexOf("@font-face"));
  assert.deepEqual(new Set(layers(css.slice(0, css.indexOf("[data-scheme=")))), new Set(layers(tokens).filter((l) => !l.includes("[data-scheme]"))));
  const names = (scheme: string, text: string) => [...text.matchAll(new RegExp(`--${scheme}-([a-z-]+):`, "g"))].map((m) => m[1]);
  for (const scheme of SCHEMES.slice(1)) assert.deepEqual(names(scheme, css), names("indigo", block), scheme);
  assert.equal(css.match(/^\[data-scheme="[a-z]+"\] \{/gm)?.length, 9, "bundle.css's rules pointing the roles at each scheme");
});

test("a page written with app.css's hue gets the scheme nearest it: 272, the old default, is indigo", () => {
  const old = (hue: string, attrs = ' lang="en"') => htmlTag(houseRoot(`<!doctype html>\n<html${attrs}>\n<style>:root{--accent-h:${hue}}</style>\n<main></main>`));
  assert.equal(old("272"), '<html lang="en" data-scheme="indigo" class="hu-root">');
  assert.equal(old("140"), '<html lang="en" data-scheme="green" class="hu-root">');
  assert.equal(old("20"), '<html lang="en" data-scheme="coral" class="hu-root">');
  assert.equal(old("-10"), '<html lang="en" data-scheme="rose" class="hu-root">');
  assert.equal(old("140", ' lang="en" class="wide" data-scheme="amber"'), '<html lang="en" class="wide hu-root" data-scheme="amber">', "a scheme it names wins");
  assert.equal(htmlTag(houseRoot('<html lang="en"><style>:root{--accent-h:272}</style><style>:root{--accent-h:210}</style>')), '<html lang="en" data-scheme="teal" class="hu-root">', "the hue set last");
  assert.equal(htmlTag(houseRoot('<html lang="en"><main>')), '<html lang="en" class="hu-root">', "none named, none set: indigo, House UI's own");
  assert.deepEqual([0, 69, 150, 200, 250, 302, 355].map(schemeOfHue), ["rose", "amber", "green", "teal", "blue", "violet", "rose"]);
  assert.match(styles(page(`<!doctype html>\n<html lang="en">\n<link rel="stylesheet" href="app.css">\n<style>:root{--accent-h:150}</style>\n<main></main>\n<script src="app.js"></script>`))[1], /--green-accent:/, "and its tokens");
});

test("app.css's older names are House UI's roles, so a page's own styles that use them still read in every theme", () => {
  const css = libs["app.css"];
  const older: Record<string, string> = { bg: "tile", panel: "ground", well: "sunken", soft: "accent-soft", edge: "tile-edge", lift: "shadow-tile", glow: "shadow-glow", ok: "success", bad: "danger", font: "font-sans", mono: "font-mono" };
  for (const [name, role] of Object.entries(older)) assert.match(css, new RegExp(`--${name}:var\\(--${role}\\)`), name);
});

test("the parts use House UI's tokens and app.css's own, and set no colours of their own", () => {
  const defined = new Set([...block.matchAll(/--([a-z0-9-]+)(?=:)/g), ...libs["app.css"].matchAll(/--([a-z0-9-]+)(?=:)/g)].map((m) => m[1]));
  const files = ["app.css", "motion.css", "runtime-lean.js", ...fs.readdirSync(path.join(skillDir, "static/parts/components")).map((f) => `parts/components/${f}`), ...fs.readdirSync(path.join(skillDir, "static/parts/figures")).map((f) => `parts/figures/${f}`)];
  const texts = Object.fromEntries(files.map((name) => [name, fs.readFileSync(path.join(skillDir, "static", name), "utf8")]));
  // A property the parts set themselves (the dial's --p, from the counter's script) is their own.
  const own = new Set(Object.values(texts).flatMap((text) => [...text.matchAll(/--([a-z0-9-]+)(?=:|", )/g)].map((m) => m[1])));
  for (const [name, text] of Object.entries(texts)) {
    const used = [...text.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]).filter((t) => !defined.has(t) && !own.has(t));
    assert.deepEqual([...new Set(used)], [], name);
  }
  // The dial's transparent (#0000) and its mask's black (#000) are no colours the page shows.
  assert.doesNotMatch(libs["app.css"].replace(/#0000?\b/g, ""), /#[0-9a-f]{3,8}\b|oklch\(|rgba?\(/i, "app.css sets no colours of its own");
});
