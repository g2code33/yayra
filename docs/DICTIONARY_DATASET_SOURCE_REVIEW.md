# Dictionary dataset source review

Reviewed 25 October 2026. This is a practical redistribution screen, not legal advice. The downloads in this review are free to obtain, but retain each source's attribution, version, scope, integrity pin, and redistribution notices. Princeton WordNet 3.0, Open English WordNet 2025, GCIDE 0.54, and FIBO Q2 2026 are now built as explicit user downloads; see the catalog and pack-manager notices for details.

## Verified downloadable pack

### Open English WordNet 2025 (core edition)

- Upstream edition: Open English WordNet 2025, released 31 December 2025; source commit `dc343f2683279ecbb13fab4e2fd778d7b162d287`.
- The official source README reports 107,519 synsets. The deterministic Yayra transform indexes 127,311 unique terms and preserves the included usage examples. This is the 2025 core edition, not 2025+; proper names are excluded.
- Licensing: the upstream `LICENSE.md` applies CC BY 4.0 to Open English WordNet and states the resource derives from Princeton WordNet. The distribution's `WNDB_License.txt` preserves the underlying WordNet 3.1 notice. Both complete source notices are carried in the pack metadata and `public/dictionary-packs/OPEN-ENGLISH-WORDNET-LICENSE-2025.md`.
- Pinned source archive: `https://codeload.github.com/globalwordnet/english-wordnet/zip/dc343f2683279ecbb13fab4e2fd778d7b162d287`; SHA-256 `c5068434cf585e8d7899ca0908db2c00cb51edf015e9d0846484d0f5680495d2`.
- Yayra asset: `public/dictionary-packs/oewn-2025-v1.yayrapack`; SHA-512 `HO0KHKrsw6faeu4HiAW9jYoXppL0ouYxfY9gGeZtqpWxvSyMJ/7joZQSR4W7AIpeHDNi+GHmjHXVfzORu2v7SA==`.
- Rebuild from the extracted pinned source with `node scripts/build-oewn-pack.mjs <source-directory>`. The build script verifies the pinned directory and a SHA-256 digest of the README, license notices, and YAML source tree (`3da494282ea713ae27f29bcb1dde3ede9e2359aadfd13122009fb98776a776d4`), then checks the edition counts and notices. The pack remains an explicit user download (not precached) and stays below the app's compressed and decompressed import limits.

### GCIDE 0.54 (general, medical-tagged, and pharmacy-tagged subsets)

- Upstream edition: GNU Collaborative International Dictionary of English 0.54, identified in its `INFO` as based on Webster's Revised Unabridged Dictionary (1913), with WordNet additions and later volunteer revisions. Exact mirror commit: `9fbf5adae3e59c79b1d020d79e99d1d7fd65a5ce`.
- The codeload archive SHA-256 is `fd16b06551f57a5d1013b4f2fe447f65006ad8414f37d255251c3f1ea0016abe`; the builder also pins a digest of the required source files (`ab11931f9ccd063bee16e6e2bbe5dce027c2d39d23f527bcb8ea35d1de1468a9`). This is a pinned GitHub mirror snapshot, not the official GNU tarball; the official tarball checksum was not compared.
- Redistribution: the exact source's `INFO` and `COPYING` identify GPL-3.0-or-later. Every pack includes those source notices and the full GPL text in metadata; the standalone copy is `public/dictionary-packs/GCIDE-LICENSE-0.54.md`. The pinned source archive remains linked from the pack card and source metadata. Rebuild with `python3 scripts/build-gcide-packs.py <extracted-source-directory>`; the builder refuses files outside its content pin.
- Yayra outputs: `gcide-0.54-v1.yayrapack` (114,757 terms), `gcide-medical-0.54-v1.yayrapack` (5,761 source-field-tagged terms), and `gcide-pharmacy-0.54-v1.yayrapack` (61 source-field-tagged terms). Their SHA-512 pins are in `dictionaryPackManager.js` and the gzip assets are each below the 20 MiB download cap and 50 MiB decompressed import cap.
- The medical and pharmacy datasets are historical subject-tagged vocabulary, not current clinical/drug references, a complete formulary, or medical advice. Do not use them for treatment or prescribing decisions.

### FIBO Q2 2026 (finance and business terminology)

- Upstream edition: EDM Council Financial Industry Business Ontology Q2 2026, source commit `f59157fe156e3d91b1c045222d0a7dc06b7d78a2`, released 10 July 2026. Pinned source archive SHA-256: `8099df46163681614bf53adb64eaefe729c19a49353c5ee01925c9cef3ca6f13`.
- The MIT `LICENSE` is reproduced in `public/dictionary-packs/FIBO-LICENSE-Q2-2026.txt`. The deterministic extractor indexes locally defined class labels and definitions; the source contained 2,671 OWL classes, of which 2,667 produced useful entries. The output `fibo-business-2026q2-v1.yayrapack` is 123,189 bytes, SHA-512 `Kra57xeFaAClKfCZ2hEQuL/KWjLuoz8zcWFJyfvSdP1zJF5mgXm/1zEFSckLCfQKebXIScu3vlX+sSQn8i6/7A==`.
- Rebuild with `node scripts/build-fibo-pack.mjs <extracted-source-directory>`. FIBO is specialized finance/business terminology, not current market data or legal advice. EDM Council is a trademark; the pack states that it is independent and not endorsed.

## General English suggestions

| Source | Review | Decision |
| --- | --- | --- |
| Open English WordNet 2025 | The pinned core release is CC BY 4.0 and derived from Princeton WordNet; the release also includes the underlying WordNet 3.1 notice. Both notices and attribution are preserved. | Added as `oewn-2025`, a verified General English download with 127,311 indexed terms. |
| GCIDE 0.54 | Pinned GitHub mirror commit and archive/content hashes verified; its `INFO` identifies 0.54 and `COPYING` contains GPL-3.0-or-later. Full source notices and GPL text accompany each pack. The official GNU tarball checksum was not compared with the mirror archive. | Added as `gcide-054`, 114,757 historical General English terms; separate subject-tagged medical and pharmacy subsets are separately described, not modern references. |
| Wiktionary | Entry text is dual-licensed under CC BY-SA 4.0 and GFDL, with imported pages and contributor attribution requiring care. Redistributed/adapted text must preserve the applicable licensing notices, attribution and share-alike obligations, including access to the transparent source copy. | Eligible in principle, but no dump parser, edition pin, attribution index or compliant pack is prepared. Do not call it a ready-to-install Yayra pack yet. |
| ConceptNet 5 | The graph is CC BY-SA 4.0 and requires attribution/share-alike. It contains relations and some lexical information, but is primarily a commonsense knowledge graph rather than a definitions dictionary. Its combined graph also aggregates sources with their own terms. | Eligible for a separately described related-concepts pack after source audit; not represented as a definitions dictionary and not included in the current pack catalog. |
| BabelNet | Its current license restricts the resource to research institutions/non-commercial use and controls distribution of indexes and processed adaptations. | Not suitable for a generally downloadable Yayra pack. |
| FrameNet | Machine-readable downloads are request-based. A clear current redistribution license for the requested corpus was not verified from the official material reviewed. | Not included pending permission and version-specific terms. |
| VerbNet | The official University of Colorado download page presents older release links and legacy license text; the separately surfaced v3.4 GitHub mirror does not, by itself, prove that its data files are covered by the repository-level Apache-2.0 metadata. | Not included until the exact upstream release and its data-specific license are confirmed. |

## Medical, pharmacy, and business suggestions

| Source | Review | Decision |
| --- | --- | --- |
| UMLS | Requires an individual UMLS license/account. The license restricts redistribution of the Metathesaurus and subsets, including individual source vocabularies, except under specified conditions and source-specific restrictions. | Do not bundle the full UMLS or assume that a source vocabulary can be redistributed. |
| MeSH 2026 | NLM's annual vocabulary terms are freely provided with attribution, no implied endorsement, and clear currency/version. The inspected May 2026 third-party RDS mirror has no repository license, and the term tables inspected had no definitions or scope notes. | Not packaged: terms alone would not make reliable dictionary entries, and the mirror's own redistribution terms are unclear. |
| RxNorm | Full releases include third-party data and require UMLS licensing. NLM's Current Prescribable Content is a limited, no-license subset, not full RxNorm. The October 2026 CPC archive was not retrieved and its NLM MD5 was not verified. | Not packaged; do not imply a current drug database or use an unverified mirror. |
| ChEBI | EMBL-EBI describes its data as CC BY 4.0 and publishes monthly releases, but ChEBI is a chemical-entity ontology/dictionary, not a complete pharmacy dictionary. Attribution and exact monthly version must travel with a pack. | A viable specialized chemical vocabulary candidate, not a substitute for a pharmacy dictionary. No pack is prepared. |
| FIBO Q2 2026 | Exact release commit/archive pinned; upstream MIT license verified. The deterministic extractor indexes local class labels and definitions, preserving the source version and EDM Council trademark/non-endorsement notice. | Added as `fibo-business-2026q2`, 2,667 finance/business terms; not market data or legal advice. |
| SEC EDGAR / financial statements | SEC data consists of filings and structured disclosures (including numeric XBRL facts), not a dictionary. Filings are registrant-submitted and SEC warns about errors/incompleteness. | Excluded from dictionaries. A future filing-research feature would be a different product scope. |

## Primary references checked

- Open English WordNet 2025 source, release and license: https://github.com/globalwordnet/english-wordnet/tree/2025-edition, https://github.com/globalwordnet/english-wordnet/releases/tag/2025-edition, https://github.com/globalwordnet/english-wordnet/blob/2025-edition/LICENSE.md, and https://github.com/globalwordnet/english-wordnet/blob/2025-edition/WNDB_License.txt
- GCIDE project description and license: https://gcide.gnu.org.ua/ and https://gcide.gnu.org.ua/license; GNU 0.54 release announcement: https://lists.gnu.org/archive/html/info-gnu/2024-12/msg00009.html; pinned mirror source: https://codeload.github.com/GitMirroring/gcide/zip/9fbf5adae3e59c79b1d020d79e99d1d7fd65a5ce
- Wiktionary copyright and reuse: https://en.wiktionary.org/wiki/Wiktionary:Copyrights and https://dumps.wikimedia.org/legal.html
- ConceptNet data license and attribution: https://conceptnet.io/ and https://github.com/commonsense/conceptnet5/wiki/Copying-and-sharing-ConceptNet
- BabelNet license: https://babelnet.org/license and https://babelnet.org/full-license
- FrameNet data request: https://framenet.icsi.berkeley.edu/ (request-based machine-readable downloads)
- VerbNet official downloads and legacy license notice: https://verbs.colorado.edu/~mpalmer/projects/verbnet/downloads.html
- UMLS access and license: https://www.nlm.nih.gov/databases/umls.html and https://www.nlm.nih.gov/research/umls/knowledge_sources/metathesaurus/release/license_agreement.html
- MeSH downloads and terms: https://www.nlm.nih.gov/databases/download/mesh.html and https://www.nlm.nih.gov/databases/download/terms_and_conditions_mesh.html
- RxNorm Current Prescribable Content: https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html
- ChEBI data and license: https://www.ebi.ac.uk/chebi/about/ and https://www.ebi.ac.uk/chebi/downloads
- FIBO Q2 2026 release, source and license: https://github.com/edmcouncil/fibo/releases/tag/master_2026Q2, https://github.com/edmcouncil/fibo/tree/f59157fe156e3d91b1c045222d0a7dc06b7d78a2, and https://github.com/edmcouncil/fibo/blob/master/LICENSE
- SEC dataset scope: https://www.sec.gov/data-research/sec-markets-data/financial-statement-data-sets
