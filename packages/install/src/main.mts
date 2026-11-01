#!/usr/bin/env node
// anywherellm-suite: `install`, `uninstall` and `health` put the skills into AnythingLLM's
// storage, take them out and check them (install.mts); `pages` shows the pages' links (pages.mts);
// `this-host` lists, allows and disallows the accounts on this machine the library may sign in to
// (thishost.mts).

import os from "node:os";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { INNER_STORAGE, type Payload } from "./addons.mts";
import { health, install, storageFor, uninstall, type Ctx } from "./install.mts";
import { pages } from "./pages.mts";
import { thisHost } from "./thishost.mts";

/** The skills, put in by packages/build.mjs. */
declare const PAYLOAD: Payload;

const USAGE = `usage: anywherellm-suite <command>

  install [--storage DIR]        put the skills into AnythingLLM's storage
          [--skills all|none|NAME,...]
          [--page-key brx-...]   optional: a key for the skills' pages (Settings > Browser
                                 Extension); without it, a skill's PAGE_KEY setting gives one
  uninstall [--storage DIR]      take them out again
  health [--storage DIR]         check it all; exit 1 when a check fails
  pages [--storage DIR]          show where to open the Library page and the Vault
        [--hide | --show]        keep their links from the agent, or give them back
  this-host [--storage DIR]      list the accounts on this machine the library may sign in to
            [--allow LOGIN@PORT] allow one (a separate account that can't read the storage)
            [--disallow LOGIN@PORT]  take one out again; each may be given more than once

The storage is AnythingLLM Desktop's when there is one; for Docker, the folder mounted at
${INNER_STORAGE}.
`;

const ctx: Ctx = {
  home: os.homedir(),
  env: process.env,
  platform: process.platform,
  print: console.log,
  payload: PAYLOAD,
};

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  install: {
    storage: { type: "string" },
    skills: { type: "string" },
    "page-key": { type: "string" },
  },
  uninstall: { storage: { type: "string" } },
  health: { storage: { type: "string" } },
  pages: { storage: { type: "string" }, hide: { type: "boolean" }, show: { type: "boolean" } },
  "this-host": { storage: { type: "string" }, allow: { type: "string", multiple: true }, disallow: { type: "string", multiple: true } },
};

const list = (value: unknown): string[] | undefined => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const values = parseArgs({ args: rest, options: OPTIONS[command] ?? {} }).values as Record<string, string | boolean | string[] | undefined>;
  const text = (name: string) => values[name] as string | undefined;
  switch (command) {
    case "install":
      await install(ctx, {
        storage: text("storage"),
        skills: list(values.skills),
        pageKey: text("page-key"),
      });
      return 0;
    case "uninstall":
      uninstall(ctx, { storage: text("storage") });
      return 0;
    case "health":
      return (await health(ctx, { storage: text("storage") })) ? 0 : 1;
    case "pages":
      return pages(ctx, { storage: text("storage"), hide: values.hide === true, show: values.show === true });
    case "this-host": {
      const storage = storageFor(ctx, text("storage"));
      ctx.print(`AnythingLLM's storage: ${storage}`);
      thisHost(storage, { allow: values.allow as string[] | undefined, disallow: values.disallow as string[] | undefined }, ctx.print);
      return 0;
    }
    default:
      console.error(USAGE);
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`anywherellm-suite: ${(e as Error).message}`);
    process.exit(1);
  },
);
