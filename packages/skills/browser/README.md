# browser-lean

Tasks on the web, as one AnythingLLM agent skill: research (search the web, look at a page) and a real Chrome with a tab per chat, which the agent opens, reads as text with a ref on each element, and acts on by those refs. It runs inside AnythingLLM's process, with the Puppeteer bundled in the skill and the Chrome AnythingLLM's image ships, so nothing is installed beside it. A task worth running again, and any API with a key, are the library skill's; the browser is for what only a person's clicks can do.

| Action | Does |
| --- | --- |
| `guide` | how to pick the way to do a task, by topic (`static/guide/`) |
| `search` | the web, through `SEARCH_URL` (DuckDuckGo's plain HTML search by default) |
| `look` | reads a page in a page of its own, without moving the tab |
| `open` | an address in this chat's tab |
| `read` | the tab as text, with refs (`find`, `from` for long pages) |
| `act` | click, fill, type, press, select... by ref; or several `steps` |
| `login` | types the saved login; with none, the user enters it on the tab's page; `confirm_ref` asks them to choose a new account's password; `what` asks them for a code the same way |
| `call` | one request from the tab, with its signed-in session (`auth` "session") |

Each answer about the tab ends with its card, a picture of the tab that opens its page. There the user sees the tab, enters what the agent asks for (sealed on their device; the model never sees it) and saves the login they typed. The saved logins and passkeys are listed and deleted on the Vault, which the tab's page links to: a page this skill serves, with its logins section, and the library skill too, with its keys and sign-ins, so either works alone. A saved password is put into the page only in one call that first checks the field is in the page's own document on the login's site, never in a frame and never as keystrokes; a code is typed after the same check. Every request Chrome makes goes through the fence: the public web only, the hosts in `FENCE_ALLOW`, and the origins (scheme, host and port) the user lets through on the Vault, under Allowed addresses (`#shared/addresses`). An address the fence refuses is refused at once, and the agent is told the user can let it through there; the Vault lists the ones refused lately, to allow with a tap.

## Where it keeps things

| What | Where |
| --- | --- |
| Logins and passkeys | `vault-lean/vault.json` in AnythingLLM's storage, encrypted, shared with the library |
| Each workspace's cookies (so its sign-ins last) | `vault-lean/sealed/session-<workspace>.json`, encrypted with the vault's key |
| Chrome's profile while it runs | a temporary folder, removed when it closes |
| Each workspace's tabs' page names | `browser-lean/<workspace>/` |
| The tabs' pictures, state and pages | `public/browser-lean/` beside AnythingLLM's server |
| Your own versions of the guide and the page | `browser-lean/static/`, at the same paths as `static/` |

## Using it

`anywherellm-suite install` puts it in, or import it from AnythingLLM's Community Hub. Switch on Browser under Agent Skills, and set its ANYTHINGLLM_URL to the address you open AnythingLLM at, so the card opens anywhere. It needs a Chrome: the newest one Puppeteer downloaded (`PUPPETEER_CACHE_DIR`, else `~/.cache/puppeteer`, where AnythingLLM's Docker image keeps its collector's), else a system Chrome or Chromium in `/usr/bin`; set `BROWSER_LEAN_CHROME` in AnythingLLM's environment to choose one. The tab's page needs the pages' key: make it once in Settings > Browser Extension and paste it into `PAGE_KEY` here or in any suite skill ([the setup guide's step 1](https://everything-llm.github.io/anywhere-llm-suite/setup.html#page-key)). It has no key slot: it asks for no API keys, and a login or a code is typed on the tab's page.

The tab's page is drawn as the Browser Lean Design canvas has it: the workspace's tabs along the top (each chat's, a green dot on the ones the agent is using, and the user's own), the address bar with the site's host, a lock and Reload, the page filling the screen, and Back, Forward, Logins (the Vault, on its Logins tab) and More (New tab, Close this tab; New tab alone on a new tab's home) at the bottom. The page draws no Close of its own: AnywhereLLM Lite opens it in a Custom Tab, whose toolbar shows the tab's title and a Close, and in a browser tab the browser's Back does it. On a chat's tab a bar above them says who has it: the agent, with Take over, or the user, with Hand back. A request for a login or a code rises as a card at the bottom, over the page; its save switch starts off, and tapping the page above it (or Reload) takes the tab over instead. The agent's card then reads "Sign in · <the page's title>". A user name typed there stays on the device until the request is answered, turned down or ended, so a reload while you look the password up loses nothing; the password and the code are never kept (nor what is typed into a field of the page itself). An offer to save a login or a passkey rises the same way, with Back, Reload and Hand back out of reach until it's answered.

On the tab's page the user can take the tab over: tap the page (or Take over, Back, Forward or Reload), swipe to scroll, type into a field with their own keyboard (a password sealed on their device), then hand it back. The agent reads but doesn't act meanwhile (open, act, login and call are refused), and a hold with no step for 10 minutes lapses. After the user signs in that way, the page offers to save the login.

The tabs' + and More › New tab show a new tab's home: one field for a search (through `SEARCH_URL`, else DuckDuckGo's plain HTML search) or an address, suggestions while typing, and Your sites, the sites with a saved login first. What the user opens there is a tab of their own, which the agent never reaches: it's named `you-<n>`, a name no chat's thread has, kept apart from the chats' tabs and in a browser context of its own (so its cookies aren't the chats', and its sign-ins end when the last of the user's own tabs or the browser closes; a login saved from it is in the Vault like any other), always held by the user, and nothing done in it is told to the agent. It goes through the fence as a chat's tab does: an address the fence refuses opens nothing, and the page says where to let it through.

A tab that closes, from its page or with its browser (after 20 minutes unused, or with AnythingLLM), keeps its page's frame: the workspace's other tabs stay along the top, and a new tab's home takes the tab's place, with Back and Forward off. For two hours its page may open a tab of the user's own from there (the browser launched again if it closed; after a restart of AnythingLLM, once the agent has used the browser again), and nothing else; after that, or once its chat's thread opens a tab again, the page is gone and its link opens nothing.

Pages: fields inside open shadow roots work like any other. A password field stays one after "Show password" turns it into a text field, so `act` still won't type into it. A login isn't sent while its form still needs something else (a CAPTCHA, say): the agent and the user are told what. Fields inside iframes aren't read yet; there the user takes the tab over, and can't type into them either.

Passkeys: every tab has Chrome's virtual authenticator holding the saved passkeys, so a site's passkey sign-in works by itself. A passkey a site makes while the user holds the tab is offered for saving; one made while the agent has it is taken out again. The lean browser's passkeys are imported.
