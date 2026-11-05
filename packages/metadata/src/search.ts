import type { IptcFields } from '@ee/contracts';

/**
 * Text search over a photo's file name, caption and keywords.
 *
 * Case-insensitive, and diacritics are kept: `å` matches `Å` and `å`, never `a`. Unicode
 * normal form C on both sides, because macOS file names come in NFD (`a` + ring) while a
 * typed `å` is one code point. Every whitespace-separated word of the query must appear
 * somewhere in the photo's text (any order), so `gais målvakt` finds a caption that
 * has both.
 */
export function normalizeForSearch(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/** The words of a query, normalised; empty when the query holds only whitespace. */
export function searchTerms(query: string): string[] {
  return normalizeForSearch(query)
    .split(/\s+/u)
    .filter((term) => term !== '');
}

/** What is searched in the IPTC part of a photo: the caption, then one line per keyword. */
export function searchTextOf(fields: Pick<IptcFields, 'caption' | 'keywords'>): string {
  const keywords = Array.isArray(fields.keywords) ? fields.keywords : [];
  return normalizeForSearch([fields.caption ?? '', ...keywords].join('\n'));
}

/** True when every term is in `fileName` or `text` (as made by {@link searchTextOf}). */
export function matchesSearch(fileName: string, text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${normalizeForSearch(fileName)}\n${text}`;
  return terms.every((term) => haystack.includes(term));
}
