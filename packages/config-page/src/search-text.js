const FRENCH_JOIN_WORDS = new Set(["d", "de", "du", "des", "l", "la", "le", "les"]);

export function normalizeCatalogSearchText(value) {
    return value
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLocaleLowerCase("fr-FR")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/gu, " ");
}

export function normalizeCatalogSearchQuery(value) {
  return normalizeCatalogSearchText(value)
    .split(" ")
    .filter((token) => !FRENCH_JOIN_WORDS.has(token))
    .join(" ");
}

export function catalogSearchBucket(token) {
  return Array.from(token).slice(0, 2).map((character) =>
    character.codePointAt(0).toString(16)).join("_");
}
