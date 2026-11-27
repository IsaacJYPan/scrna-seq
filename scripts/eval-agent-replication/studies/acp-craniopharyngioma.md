## The study (what the researcher told you)

- Tissue: surgically resected **adamantinomatous craniopharyngioma (ACP)** tumors
  from three patients (sample1, sample2, sample3). Human. 10x Genomics Chromium 3' v3,
  Cell Ranger filtered matrices aligned to GRCh38.
- sample2 was taken at the junction between the tumor and the adjacent glial scar
  (reactive brain tissue); sample1 and sample3 are tumor tissue.
- Research question: characterize the cellular composition of ACP, the heterogeneity
  of the neoplastic (tumor) cells, and the tumor microenvironment, including how
  tumor cells may interact with surrounding cells. Report what you find, how
  confident you are, and what the researcher should check.
- There is no published reference for this dataset. You are the first to analyze it.

## Data

Read-only: `../data/sample{1,2,3}/` each containing `matrix.mtx.gz`,
`features.tsv.gz`, `barcodes.tsv.gz` (use `Seurat::Read10X`).
