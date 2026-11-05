import { describe, expect, it } from 'vitest';
import { matchesSearch, normalizeForSearch, searchTerms, searchTextOf } from '../src/search';

const found = (fileName: string, fields: Parameters<typeof searchTextOf>[0], query: string) =>
  matchesSearch(fileName, searchTextOf(fields), searchTerms(query));

describe('search text', () => {
  it('matches the file name, caption and keywords', () => {
    const fields = { caption: 'Målvakten räddar en straff', keywords: ['allsvenskan', 'GAIS'] };
    expect(found('_DSC1234.NEF', fields, 'dsc12')).toBe(true);
    expect(found('_DSC1234.NEF', fields, 'straff')).toBe(true);
    expect(found('_DSC1234.NEF', fields, 'allsven')).toBe(true);
    expect(found('_DSC1234.NEF', fields, 'aik')).toBe(false);
  });

  it('is case-insensitive and keeps å, ä and ö apart from a and o', () => {
    const fields = { caption: 'Åkerlund jublar', keywords: ['Örgryte'] };
    expect(found('a.NEF', fields, 'åkerlund')).toBe(true);
    expect(found('a.NEF', fields, 'ÅKERLUND')).toBe(true);
    expect(found('a.NEF', fields, 'örgryte')).toBe(true);
    expect(found('a.NEF', fields, 'akerlund')).toBe(false);
    expect(found('a.NEF', fields, 'orgryte')).toBe(false);
  });

  it('treats a decomposed å (macOS file names) like a typed å', () => {
    const decomposed = 'Å'.normalize('NFD') + 'ke.NEF';
    expect(decomposed.length).toBeGreaterThan('Åke.NEF'.length);
    expect(found(decomposed, {}, 'åke')).toBe(true);
    expect(found('Åke.NEF', {}, decomposed)).toBe(true);
  });

  it('needs every word, in any order', () => {
    const fields = { caption: 'Målvakten räddar', keywords: ['gais'] };
    expect(found('a.NEF', fields, 'gais målvakt')).toBe(true);
    expect(found('a.NEF', fields, 'räddar   gais')).toBe(true);
    expect(found('a.NEF', fields, 'gais aik')).toBe(false);
  });

  it('matches everything for an empty query', () => {
    expect(searchTerms('   ')).toEqual([]);
    expect(found('a.NEF', {}, '  ')).toBe(true);
  });

  it('does not match across a caption and a keyword boundary with one word', () => {
    // "räddar" ends the caption and "gais" starts the keywords; one word cannot span them.
    const fields = { caption: 'Målvakten räddar', keywords: ['gais'] };
    expect(found('a.NEF', fields, 'räddargais')).toBe(false);
  });

  it('normalises to a single form', () => {
    expect(normalizeForSearch('Å'.normalize('NFD'))).toBe('å');
  });
});
