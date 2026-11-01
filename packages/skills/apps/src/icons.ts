// The icon set: the names an app's icon (app.json's `icon`) may take, the design canvas's 24 (page
// "Apps", The icon set). Only names travel: AnywhereLLM Lite draws each one's glyph from the link's
// title on the card, and the apps manager from its own copy of the glyphs (static/pages/manager.html,
// GLYPHS); a name either doesn't know is drawn as the grid.

import type { Json } from "./patch.ts";

export const ICONS = [
  "cart", "check", "timer", "flame", "book", "calendar", "bars", "target", "cards", "note", "heart", "star",
  "dumbbell", "drop", "moon", "wallet", "plane", "home", "mail", "pin", "bell", "music", "sun", "bulb",
];

/** An app's icon when it is one of the set, else null. */
export const iconOf = (app: Json): string | null => (typeof app?.icon === "string" && ICONS.includes(app.icon) ? app.icon : null);
