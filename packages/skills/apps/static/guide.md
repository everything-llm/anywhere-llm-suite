# Artifacts (lean)

This edition keeps artifacts inside AnythingLLM, with no server of its own. Its pages come from the parts and design rules below. What differs:

- A starter, listed first below, is a working artifact in one call: `create` with `starter`, `title` and the user's first `data` (the keys it replaces). Use one whenever it fits.
- `guide` takes several topics at once (`query: "counter, date-grid"`), and a component comes with `runtime`, the `App` reference its script is written against. The design rules list `app.css`'s classes; `guide styles` is the whole stylesheet, for when what a class looks like matters.
- `create` with a `template` and `parts` composes the components, merges their schemas and first data (design rule 2, done); a group `{"each": "habits", "parts": [...]}` repeats its parts for each named item. `text` (app.json) adds about, rules and card. It answers with page.html as made. A refused `create` or `edit` lists every problem: fix them all in the next call.
- The first data is what the user gave, or empty. Never make up history (past days, scores, sessions) to make a page look used.
- `undo` takes back the newest change, to the data or a file (`file` picks one). `edit` with no `find` writes the whole file.
- There is no browser check or icon set (leave `icon` out); a write is refused when a script doesn't parse or a `data-part` has no `App.mount`. Before giving the user a page, go over page.html once against the design rules and the finish topic.
