import { registerHooks } from "node:module";

// Node indexes UTF-16 units; Alloy XS indexes Unicode scalars. Adapt only the
// three native string operations while loading tests. Production imports no
// test module and contains no host branch. Native Unicode proof remains needed.
const packedUrl = new URL("../src/embeddedjs/packed.js", import.meta.url).href;
const replacements = [
  ["function stringSize(value) { return value.length; }",
    "function stringSize(value) { return Array.from(value).length; }"],
  ["function stringCode(value, index) { return value.charCodeAt(index); }",
    "function stringCode(value, index) { return Array.from(value)[index]?.codePointAt(0) ?? NaN; }"],
  ["function stringPart(value, start, end) { return value.slice(start, end); }",
    "function stringPart(value, start, end) { return Array.from(value).slice(start, end).join(''); }"]
];

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== packedUrl) return loaded;
    let source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    for (const [native, host] of replacements) {
      if (!source.includes(native)) throw new Error("XS test adapter no longer matches native string operations");
      source = source.replace(native, host);
    }
    return { ...loaded, source };
  }
});

export function watchModule(name) {
  return import(new URL(`../src/embeddedjs/${name}.js`, import.meta.url).href);
}
