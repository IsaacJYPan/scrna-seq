## The study (what the researcher told you)

- Mouse peripheral blood mononuclear cells (PBMCs), 10x Genomics (Cell Ranger
  v1.3 output, mm10), one library per experimental group.
- 2 × 2 design: genotype × surgery.
  - `db_db`: leptin-receptor-deficient db/db mice, a model of type 2 diabetes.
  - `db_pos`: db/+ littermates, normoglycemic controls.
  - `dMCAO`: ischemic stroke by distal middle cerebral artery occlusion.
  - `Sham`: sham surgery.
- Samples: `db_db-DMCAO`, `db_db-Sham`, `db_pos-dMCAO`, `db_pos-Sham`.
- Research question: how do type 2 diabetes and stroke change circulating immune
  cells, in particular monocytes (which cell types change in abundance, which
  monocyte subsets exist and how they shift between groups, and which genes and
  pathways change in monocytes with diabetes and with stroke)? Report what you
  find, how confident you are, and what the researcher should check.
- There is no published reference for this dataset. You are the first to analyze it.

## Data

Read-only: `../data/<sample>/` for each of the four samples, each containing
`matrix.mtx`, `genes.tsv`, `barcodes.tsv` (Cell Ranger v2-style; use
`Seurat::Read10X`).
