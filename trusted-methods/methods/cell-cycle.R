# Trusted method: cell-cycle phase scoring, optionally regressed out.
# Upstream: Seurat vignette "Cell-Cycle Scoring and Regression"
# (satijalab.org/seurat/articles/cell_cycle_vignette):
#   s.genes <- cc.genes$s.genes; g2m.genes <- cc.genes$g2m.genes
#   marrow <- CellCycleScoring(marrow, s.features = s.genes,
#                              g2m.features = g2m.genes, set.ident = TRUE)
#   marrow <- ScaleData(marrow, vars.to.regress = c("S.Score", "G2M.Score"),
#                       features = rownames(marrow))
#   # alternative: regress the difference
#   marrow$CC.Difference <- marrow$S.Score - marrow$G2M.Score
#   marrow <- ScaleData(marrow, vars.to.regress = "CC.Difference", ...)
# Gene lists are Seurat's cc.genes.updated.2019 (Tirosh et al. 2016, updated
# symbols). Mouse data uses the same lists converted to title case.
analysis <- inputs$analysis
s_genes <- cc.genes.updated.2019$s.genes
g2m_genes <- cc.genes.updated.2019$g2m.genes
if (identical(params[["species"]], "mouse")) {
  title_case <- function(x) paste0(substr(x, 1, 1), tolower(substring(x, 2)))
  s_genes <- title_case(s_genes)
  g2m_genes <- title_case(g2m_genes)
}
found_s <- intersect(s_genes, rownames(analysis))
found_g2m <- intersect(g2m_genes, rownames(analysis))
if (length(found_s) < 10 || length(found_g2m) < 10) stop("Too few cell-cycle genes are present; check the species setting.")

analysis <- CellCycleScoring(analysis, s.features = found_s, g2m.features = found_g2m, set.ident = FALSE)

regression <- params[["regress"]]
if (regression != "none") {
  vars <- if (regression == "all-phases") c("S.Score", "G2M.Score") else {
    analysis$CC.Difference <- analysis$S.Score - analysis$G2M.Score
    "CC.Difference"
  }
  # The vignette scales all genes; scaling variable features keeps memory
  # bounded on large objects and is what PCA uses downstream.
  features <- if (length(VariableFeatures(analysis))) VariableFeatures(analysis) else rownames(analysis)
  analysis <- ScaleData(analysis, vars.to.regress = vars, features = features, verbose = FALSE)
  analysis <- RunPCA(analysis, features = features, npcs = params[["dims"]], seed.use = seed, verbose = FALSE)
  analysis <- FindNeighbors(analysis, dims = seq_len(params[["dims"]]), verbose = FALSE)
  analysis <- FindClusters(analysis, resolution = params[["resolution"]], random.seed = seed, verbose = FALSE)
  analysis <- RunUMAP(analysis, dims = seq_len(params[["dims"]]), seed.use = seed, verbose = FALSE)
}

phases <- table(factor(analysis$Phase, levels = c("G1", "S", "G2M")))
group_column <- if ("seurat_clusters" %in% colnames(analysis[[]])) "seurat_clusters" else NULL
by_group <- if (is.null(group_column)) data.frame(group = "all", G1 = phases[["G1"]], S = phases[["S"]], G2M = phases[["G2M"]]) else {
  counts <- as.data.frame.matrix(table(analysis[[group_column, drop = TRUE]], factor(analysis$Phase, levels = c("G1", "S", "G2M"))))
  data.frame(group = rownames(counts), counts, check.names = FALSE, row.names = NULL)
}
write_output("analysis", analysis)
write_output("summary", list(
  n_cells = ncol(analysis),
  fraction_g1 = round(phases[["G1"]] / ncol(analysis), 4),
  fraction_s = round(phases[["S"]] / ncol(analysis), 4),
  fraction_g2m = round(phases[["G2M"]] / ncol(analysis), 4),
  s_genes_found = length(found_s),
  g2m_genes_found = length(found_g2m),
  regression = regression
))
write_output("phases", by_group)
figure <- if ("umap" %in% Reductions(analysis)) DimPlot(analysis, reduction = "umap", group.by = "Phase") else
  RidgePlot(analysis, features = c("S.Score", "G2M.Score"), group.by = "Phase", ncol = 2)
write_output("figure", figure)
