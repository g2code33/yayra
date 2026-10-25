# Dictionary dataset source review

Reviewed 25 October 2026. This is a practical redistribution screen, not legal advice. No new corpus was imported or advertised as downloadable from this review. A source may be added only after pinning its edition, checking the exact files and notices shipped, documenting attribution and update cadence, and producing a reproducible Yayra pack.

## General English suggestions

| Source | Review | Decision |
| --- | --- | --- |
| Wiktionary | Entry text is dual-licensed under CC BY-SA 4.0 and GFDL, with imported pages and contributor attribution requiring care. Redistributed/adapted text must preserve the applicable licensing notices, attribution and share-alike obligations, including access to the transparent source copy. | Eligible in principle, but no dump parser, edition pin, attribution index or compliant pack is prepared. Do not call it a ready-to-install Yayra pack yet. |
| ConceptNet 5 | The graph is CC BY-SA 4.0 and requires attribution/share-alike. It contains relations and some lexical information, but is primarily a commonsense knowledge graph rather than a definitions dictionary. Its combined graph also aggregates sources with their own terms. | Eligible for a separately described related-concepts pack after source audit; not represented as a definitions dictionary and not included in the current pack catalog. |
| BabelNet | Its current license restricts the resource to research institutions/non-commercial use and controls distribution of indexes and processed adaptations. | Not suitable for a generally downloadable Yayra pack. |
| FrameNet | Machine-readable downloads are request-based. A clear current redistribution license for the requested corpus was not verified from the official material reviewed. | Not included pending permission and version-specific terms. |
| VerbNet | The official University of Colorado download page presents older release links and legacy license text; the separately surfaced v3.4 GitHub mirror does not, by itself, prove that its data files are covered by the repository-level Apache-2.0 metadata. | Not included until the exact upstream release and its data-specific license are confirmed. |

## Medical, pharmacy, and business suggestions

| Source | Review | Decision |
| --- | --- | --- |
| UMLS | Requires an individual UMLS license/account. The license restricts redistribution of the Metathesaurus and subsets, including individual source vocabularies, except under specified conditions and source-specific restrictions. | Do not bundle the full UMLS or assume that a source vocabulary can be redistributed. |
| MeSH | NLM freely provides its annual vocabulary. Its terms require clear NLM acknowledgment, no implied endorsement, and either keeping distributed data current or clearly stating its version/accuracy status. Translation files are outside those terms. | A viable medical terminology candidate, but no current annual edition has been transformed, reviewed, or packaged here. |
| RxNorm | The full releases combine public-domain NLM content with third-party proprietary data and require UMLS access/license. NLM's Current Prescribable Content subset is a distinct, no-license public-domain subset limited to `SAB=RXNORM` and `SAB=MTHSPL`; it is not the complete RxNorm release. | The public subset is a possible pharmacy-pack source; do not bundle full RxNorm as unrestricted. No subset pack is prepared. |
| ChEBI | EMBL-EBI describes its data as CC BY 4.0 and publishes monthly releases, but ChEBI is a chemical-entity ontology/dictionary, not a complete pharmacy dictionary. Attribution and exact monthly version must travel with a pack. | A viable specialized chemical vocabulary candidate, not a substitute for a pharmacy dictionary. No pack is prepared. |
| FIBO | The upstream `edmcouncil/fibo` repository and ontology guide identify MIT licensing, with copyright/license notices required. FIBO is an OWL/RDF finance ontology and common vocabulary; a usable dictionary pack requires a controlled extraction of labels, definitions, and synonyms. | A viable business-finance terminology candidate; no converted dataset is prepared. FIBO is also an EDM Council trademark, so use must not imply endorsement. |
| SEC EDGAR / financial statements | SEC data consists of filings and structured disclosures (including numeric XBRL facts), not a dictionary. Filings are registrant-submitted and SEC warns about errors/incompleteness. | Excluded from dictionaries. A future filing-research feature would be a different product scope. |

## Primary references checked

- Wiktionary copyright and reuse: https://en.wiktionary.org/wiki/Wiktionary:Copyrights and https://dumps.wikimedia.org/legal.html
- ConceptNet data license and attribution: https://conceptnet.io/ and https://github.com/commonsense/conceptnet5/wiki/Copying-and-sharing-ConceptNet
- BabelNet license: https://babelnet.org/license and https://babelnet.org/full-license
- FrameNet data request: https://framenet.icsi.berkeley.edu/ (request-based machine-readable downloads)
- VerbNet official downloads and legacy license notice: https://verbs.colorado.edu/~mpalmer/projects/verbnet/downloads.html
- UMLS access and license: https://www.nlm.nih.gov/databases/umls.html and https://www.nlm.nih.gov/research/umls/knowledge_sources/metathesaurus/release/license_agreement.html
- MeSH downloads and terms: https://www.nlm.nih.gov/databases/download/mesh.html and https://www.nlm.nih.gov/databases/download/terms_and_conditions_mesh.html
- RxNorm Current Prescribable Content: https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html
- ChEBI data and license: https://www.ebi.ac.uk/chebi/about/ and https://www.ebi.ac.uk/chebi/downloads
- FIBO source and license: https://github.com/edmcouncil/fibo and https://github.com/edmcouncil/fibo/blob/master/LICENSE
- SEC dataset scope: https://www.sec.gov/data-research/sec-markets-data/financial-statement-data-sets
