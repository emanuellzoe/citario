// DOI metadata from Crossref, and what its license lets Citario do.
//
// Selling passages needs rights. The contract accepts Paid only for
// author-retained, CC0, CC-BY and CC-BY-SA; everything else is CiteOnly
// (agents pay citation fees, the text is never sold).

export type Work = {
  doi: string;
  found: boolean;
  title: string | null;
  authors: { name: string; orcid: string | null }[];
  publisher: string | null;
  licenseUrls: string[];
};

export type Classified = {
  license: string;
  mode: 'Paid' | 'CiteOnly';
  reason: string;
};

export const PAID_LICENSES = ['author-retained', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0'];

export function normalizeDoi(doi: string): string {
  const d = doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:/, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(d) || d.length > 200) throw new Error('not a DOI (expected 10.xxxx/...)');
  return d;
}

export async function crossrefWork(doiIn: string): Promise<Work> {
  const doi = normalizeDoi(doiIn);
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { 'user-agent': 'citario-hackathon-demo (https://citario.vercel.app)' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!r || !r.ok) return { doi, found: false, title: null, authors: [], publisher: null, licenseUrls: [] };
  const m: any = (await r.json()).message;
  return {
    doi,
    found: true,
    title: Array.isArray(m.title) ? m.title[0] ?? null : null,
    authors: (m.author ?? []).map((a: any) => ({
      name: [a.given, a.family].filter(Boolean).join(' ') || a.name || '',
      orcid: a.ORCID ? String(a.ORCID).replace(/^https?:\/\/orcid\.org\//, '') : null,
    })),
    publisher: m.publisher ?? null,
    licenseUrls: (m.license ?? []).map((l: any) => String(l.URL)),
  };
}

/** Maps Crossref license URLs (or an author's own claim) to a license id and mode. */
export function classify(work: Work | null, claimed?: string): Classified {
  const urls = work?.licenseUrls ?? [];
  const cc = urls.map((u) => u.toLowerCase()).find((u) => u.includes('creativecommons.org'));
  if (cc) {
    if (cc.includes('/publicdomain/zero')) return { license: 'CC0-1.0', mode: 'Paid', reason: 'Crossref: CC0, the text may be sold' };
    const m = cc.match(/licenses\/([a-z-]+)\//);
    const kind = m?.[1] ?? '';
    if (kind === 'by') return { license: 'CC-BY-4.0', mode: 'Paid', reason: 'Crossref: CC-BY, the text may be sold with attribution' };
    if (kind === 'by-sa') return { license: 'CC-BY-SA-4.0', mode: 'Paid', reason: 'Crossref: CC-BY-SA, the text may be sold with attribution' };
    return { license: `CC-${kind.toUpperCase()}-4.0`, mode: 'CiteOnly', reason: `Crossref: CC-${kind.toUpperCase()} does not allow selling the text; citation fees only` };
  }
  if (work?.found && urls.length) {
    return { license: 'publisher', mode: 'CiteOnly', reason: `Crossref: publisher license (${work.publisher ?? 'unknown'}); the author may collect citation fees but not sell the text` };
  }
  if (work?.found) {
    return { license: 'unknown', mode: 'CiteOnly', reason: 'Crossref has no license for this DOI; citation fees only until the rights are clear' };
  }
  // No Crossref record (preprint, self-published, test DOI): the author's own claim.
  if (claimed && PAID_LICENSES.includes(claimed)) {
    return { license: claimed, mode: 'Paid', reason: `author states ${claimed}; checked by the verifier before activation if a DOI is given` };
  }
  return { license: claimed || 'unknown', mode: 'CiteOnly', reason: 'license does not allow selling the text; citation fees only' };
}
