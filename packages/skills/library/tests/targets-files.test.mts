// Targets (src/targets.ts), the third of three files: files on a target. Put and get, in parts and in
// pages, modes and links, and transfers cut off or past their time.
// The stand-in machine, its reset before each test and the helpers are in targets-fixture.mts.

import assert from "node:assert/strict";
import test from "node:test";
import { until } from "./harness.mts";
import { call, failRemove, file, fileFn, files, hex, links, ops, register, result, seen, sleep, stallRenames } from "./targets-fixture.mts";

test("a file is put on the target and got back, as text or, for bytes, as base64, with its sha256", async () => {
  await register();
  await ops();
  await fileFn();
  const text = "name,score\nada,3\n";
  assert.deepEqual(await file("put", { path: "~/scores.csv", content: text, mode: "600" }), { path: "scores.csv", size: text.length, sha256: hex(Buffer.from(text)) });
  assert.equal(files.get("scores.csv")!.mode & 0o777, 0o600);
  assert.deepEqual([...files.keys()], ["scores.csv"], "the part file it was written to was moved over the path");
  assert.deepEqual(await file("get", { path: "scores.csv" }), { content: text, encoding: "utf8", size: text.length, sha256: hex(Buffer.from(text)), eof: true });
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.equal((await file("put", { path: "all.bin", content: bytes.toString("base64"), encoding: "base64" })).sha256, hex(bytes));
  assert.deepEqual(files.get("all.bin")!.data, bytes);
  const got = await file("get", { path: "all.bin" });
  assert.deepEqual([got.encoding, got.content, got.sha256], ["base64", bytes.toString("base64"), hex(bytes)], "not UTF-8, so base64");
  assert.match(await call({ action: "run", name: "ops.file", inputs: { call: "get", req: { path: "scores.csv" } } }), /- SSH box get scores\.csv: 0 \(\d+ ms\)/);
});

test("a file bigger than a call goes in parts: put whole then appended, read back by offset to eof", async () => {
  await register();
  await ops();
  const source = `async function main(input, kit) {
    const box = { target: "box", path: "big.txt" };
    await kit.ssh.put(Object.assign({ content: "a".repeat(1024 * 1024) }, box));
    const end = await kit.ssh.put(Object.assign({ content: "b".repeat(512 * 1024), append: true }, box));
    const one = await kit.ssh.get(box);
    const two = await kit.ssh.get(Object.assign({ offset: one.content.length }, box));
    return { size: end.size, one: [one.content.length, one.eof], two: [two.content.length, two.eof, two.content[0]] };
  }`;
  await call({ action: "save", service: "ops", function: { name: "big", description: "A big file.", source } });
  assert.deepEqual(result(await call({ action: "run", name: "ops.big", inputs: {} })), { size: 1.5 * 1024 * 1024, one: [1024 * 1024, false], two: [512 * 1024, true, "b"] });
});

test("a file put over another keeps its mode unless one is given, and a symbolic link stays one", async () => {
  await register();
  await ops();
  await fileFn();
  await file("put", { path: "run.sh", content: "#!/bin/sh\n", mode: "755" });
  await file("put", { path: "run.sh", content: "#!/bin/sh\necho 2\n" });
  assert.equal(files.get("run.sh")!.mode & 0o7777, 0o755, "kept");
  await file("put", { path: "run.sh", content: "#!/bin/sh\necho 3\n", mode: "600" });
  assert.equal(files.get("run.sh")!.mode & 0o7777, 0o600, "changed when given");
  files.set("real.txt", { data: Buffer.from("old"), mode: 0o100640 });
  links.set("link.txt", "real.txt");
  await file("put", { path: "link.txt", content: "new" });
  assert.deepEqual([...files.keys()].sort(), ["real.txt", "run.sh"], "no file took the link's place");
  assert.equal(files.get("real.txt")!.data.toString(), "new");
  assert.equal(files.get("real.txt")!.mode & 0o7777, 0o640);
});

test("a text file read in pages gives text in every page, each ending on a character", async () => {
  await register();
  await ops();
  await fileFn();
  files.set("utf.txt", { data: Buffer.from("éééé"), mode: 0o100644 }); // 8 bytes
  const first = await file("get", { path: "utf.txt", bytes: 3 });
  assert.deepEqual([first.content, first.encoding, first.eof], ["é", "utf8", false], "cut before the half of a character");
  const second = await file("get", { path: "utf.txt", offset: Buffer.byteLength(first.content), bytes: 3 });
  assert.deepEqual([second.content, second.encoding], ["é", "utf8"]);
  const rest = await file("get", { path: "utf.txt", offset: 4, bytes: 100 });
  assert.deepEqual([rest.content, rest.eof], ["éé", true]);
});

test("over 1 MB in one call, or a field of its own, is refused before anything is written", async () => {
  await register();
  await ops();
  await fileFn();
  const source = "async function main(i, kit) { return kit.ssh.put({ target: 'box', path: 'huge.txt', content: 'x'.repeat(1024 * 1024 + 1) }); }";
  await call({ action: "save", service: "ops", function: { name: "huge", description: "Too big.", source } });
  assert.match(await call({ action: "run", name: "ops.huge", inputs: {} }), /kit\.ssh\.put writes at most 1 MB a call: send a bigger file in parts/);
  assert.match(await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "x", content: "y", host: "elsewhere" } } }), /kit\.ssh\.put takes target, path, content, encoding, mode, append, not host/);
  assert.match(await call({ action: "run", name: "ops.file", inputs: { call: "get", req: { path: "x", key: "k" } } }), /kit\.ssh\.get takes target, path, offset, bytes, encoding, not key/);
  assert.deepEqual([...files.keys()], []);
});

test("a stopped run ends the transfer it's waiting on, and leaves no part file behind it in view", async () => {
  await register();
  await ops();
  await fileFn();
  process.env.LIBRARY_WAIT_MS = "300";
  const started = await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "stall.bin", content: "z" } } });
  const id = started.match(/\((r-[\w-]+)\)/)![1];
  await until(() => [...files.keys()].some((k) => k.startsWith("stall.bin.part-")));
  seen.sftpClosed = 0;
  assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.file.*stopped/);
  await until(() => seen.sftpClosed === 1);
  assert.ok(!files.has("stall.bin"), "nothing was moved into place");
  await until(() => ![...files.keys()].some((k) => k.startsWith("stall.bin.part-")), 10_000); // removed over a connection of its own
});

test("an upload cut off after it removed the file it replaces keeps the new content, on a server without posix-rename", async () => {
  await register();
  await ops();
  await fileFn();
  files.set("keep.txt", { data: Buffer.from("old"), mode: 0o100644 });
  stallRenames.set("keep.txt", 1); // the first rename is refused (the file is there), the one after the remove never answered
  process.env.LIBRARY_WAIT_MS = "300";
  const id = (await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "keep.txt", content: "new" } } })).match(/\((r-[\w-]+)\)/)![1];
  await until(() => !files.has("keep.txt") && [...files.keys()].some((k) => k.startsWith("keep.txt.part-")));
  assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.file.*stopped/);
  await sleep(1500); // time for the clean-up connection a cut-off upload opens
  const part = [...files.keys()].filter((k) => k.startsWith("keep.txt.part-"));
  assert.equal(part.length, 1, "the part file is kept: it holds the only copy");
  assert.equal(files.get(part[0])!.data.toString(), "new");
});

test("an upload cut off after its remove failed leaves the old file and no part file", async () => {
  await register();
  await ops();
  await fileFn();
  files.set("stay.txt", { data: Buffer.from("old"), mode: 0o100644 });
  failRemove.add("stay.txt");
  stallRenames.set("stay.txt", 1);
  process.env.LIBRARY_WAIT_MS = "300";
  const id = (await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "stay.txt", content: "new" } } })).match(/\((r-[\w-]+)\)/)![1];
  await until(() => [...files.keys()].some((k) => k.startsWith("stay.txt.part-")));
  await sleep(300); // past the failed remove, at the rename that never answers
  assert.match(await call({ action: "run", run_id: id, stop: true }), /ops\.file.*stopped/);
  await until(() => ![...files.keys()].some((k) => k.startsWith("stay.txt.part-")), 10_000);
  assert.equal(files.get("stay.txt")!.data.toString(), "old", "nothing was lost, so nothing is kept");
});

test("a transfer that runs past its time is ended and its part file removed", async () => {
  await register();
  await ops();
  await fileFn();
  process.env.LIBRARY_RUN_MS = "2500";
  process.env.LIBRARY_WAIT_MS = "6000";
  const said = await call({ action: "run", name: "ops.file", inputs: { call: "put", req: { path: "stall.bin", content: "z" } } });
  assert.match(said, /ran past its time and was stopped/, "the run's own end is the transfer's");
  await until(() => ![...files.keys()].some((k) => k.startsWith("stall.bin.part-")), 10_000);
});
