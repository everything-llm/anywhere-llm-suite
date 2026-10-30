// The part of JSON Schema an app's data is checked with. Every keyword it does not know is refused
// when the schema is written (schemaProblems), so no data goes unchecked by a keyword it ignores.

import { clone, equal, type Json } from "./patch.ts";

const ANNOTATIONS = new Set(["title", "description", "default", "examples", "$comment", "format"]);
const patterns = new Map<string, RegExp>();
/** The compiled regular expression for a schema's pattern, kept so a long list compiles it once. */
function patternOf(source: string): RegExp {
  if (!patterns.has(source)) patterns.set(source, new RegExp(source, "u"));
  return patterns.get(source)!;
}

const isPrimitive = (v: Json): boolean => v === null || typeof v !== "object";

/** A value's JSON with each object's keys in order, so equal values give the same text. */
const canonical = (v: Json): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const isType = (v: Json, t: string): boolean => typeOf(v) === t || (t === "number" && typeOf(v) === "integer");

const strings = (v: Json): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
const compiles = (v: Json): boolean => {
  try {
    return typeof v === "string" && !!patternOf(v);
  } catch {
    return false;
  }
};
const NUMBER: [(v: Json) => boolean, string] = [(v) => typeof v === "number", "a number"];
/** Each keyword this checker knows, with what its value must be, so data is never checked by a
 *  pattern that won't compile or a "required" that isn't a list (null: any value, or a schema). */
const KEYWORDS: Record<string, [(v: Json) => boolean, string] | null> = {
  type: [(v) => typeof v === "string" || strings(v), "a type's name, or a list of them"],
  properties: [(v) => !!v && typeof v === "object" && !Array.isArray(v), "an object of schemas"],
  required: [strings, "a list of key names"],
  additionalProperties: null,
  items: null,
  uniqueItems: [(v) => typeof v === "boolean", "true or false"],
  pattern: [compiles, "a regular expression that compiles"],
  enum: [Array.isArray, "a list of the values allowed"],
  const: null,
  ...Object.fromEntries(
    ["minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].map((k) => [k, NUMBER]),
  ),
};

/** What's wrong with `schema` for this checker, at any depth, as "/path: problem": a keyword it
 *  doesn't know, or one whose value it can't use. */
export function schemaProblems(schema: Json, at = ""): string[] {
  if (schema === true || schema === false) return [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${at || "/"}: not a schema`];
  const found: string[] = [];
  for (const [k, v] of Object.entries(schema as Record<string, Json>)) {
    if (ANNOTATIONS.has(k)) continue;
    const rule = KEYWORDS[k];
    if (!Object.hasOwn(KEYWORDS, k)) found.push(`${at}/${k}: not a keyword artifacts check; use type, properties, required, items, enum, minimum and the like`);
    else if (rule && !rule[0](v)) found.push(`${at}/${k}: ${rule[1]}`);
    else if (k === "properties") for (const [p, s] of Object.entries(v)) found.push(...schemaProblems(s, `${at}/properties/${p}`));
    else if (k === "items" || (k === "additionalProperties" && typeof v === "object")) found.push(...schemaProblems(v, `${at}/${k}`));
  }
  return found;
}

/** Why `value` breaks `schema`, as a list of "/path: problem"; empty when it satisfies it. */
export function problems(value: Json, schema: Json, at = ""): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at || "/"}: not allowed`];
  const where = at || "/";
  const out: string[] = [];
  if (schema.type !== undefined) {
    const types: string[] = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) return [`${where}: should be ${types.join(" or ")}, not ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.some((e: Json) => equal(e, value))) out.push(`${where}: should be one of ${JSON.stringify(schema.enum)}`);
  if ("const" in schema && !equal(schema.const, value)) out.push(`${where}: should be ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) out.push(`${where}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) out.push(`${where}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !patternOf(schema.pattern).test(value)) out.push(`${where}: doesn't match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) out.push(`${where}: should be above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) out.push(`${where}: should be below ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) out.push(`${where}: not a multiple of ${schema.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${where}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${where}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.every(isPrimitive) ? value : value.map(canonical)).size !== value.length) out.push(`${where}: items repeat`);
    if (schema.items !== undefined) value.forEach((v, i) => out.push(...problems(v, schema.items, `${at}/${i}`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) out.push(`${where}: needs ${key}`);
    const count = Object.keys(value).length;
    if (schema.minProperties !== undefined && count < schema.minProperties) out.push(`${where}: fewer than ${schema.minProperties} keys`);
    if (schema.maxProperties !== undefined && count > schema.maxProperties) out.push(`${where}: more than ${schema.maxProperties} keys`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) out.push(...problems(v, props[k], `${at}/${k}`));
      else if (schema.additionalProperties !== undefined) out.push(...problems(v, schema.additionalProperties, `${at}/${k}`));
    }
  }
  return out;
}

// What a required key left out of first data starts as, by its type: an agent sending eight list
// items without `done` means eight unticked items, not a refused app. Sent as bare text
// ("Passport"), an item whose schema asks for a `text` takes it as its text.
const ZERO: Record<string, Json> = { boolean: false, integer: 0, number: 0, array: [] };

/** `value` with each required key it lacks filled with its type's zero, at any depth, where that
 *  zero satisfies the key's schema; and the keys filled, such as "cards/[]/seen". */
export function withDefaults(value: Json, schema: Json): { value: Json; filled: string[] } {
  const filled = new Set<string>();
  const fill = (value: Json, schema: Json, at: string): Json => {
    if (!schema || typeof schema !== "object") return value;
    if (Array.isArray(value) && schema.items && typeof schema.items === "object")
      return value.map((v) => {
        if (typeof v === "string" && schema.items.properties?.text?.type === "string" && (schema.items.required || []).includes("text")) {
          filled.add(`${at}/[]`.slice(1) + " as {text}");
          v = { text: v };
        }
        return fill(v, schema.items, `${at}/[]`);
      });
    if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
      value = { ...value };
      for (const key of schema.required || []) {
        const sub = schema.properties[key];
        if (key in value || !sub || !(sub.type in ZERO)) continue;
        const zero = clone(ZERO[sub.type]);
        if (problems(zero, sub).length) continue;
        value[key] = zero;
        filled.add(`${at}/${key}`.slice(1));
      }
      for (const [key, sub] of Object.entries(schema.properties)) if (key in value) value[key] = fill(value[key], sub, `${at}/${key}`);
    }
    return value;
  };
  return { value: fill(value, schema, ""), filled: [...filled] };
}
