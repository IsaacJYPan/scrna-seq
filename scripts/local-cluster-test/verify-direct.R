suppressPackageStartupMessages({library(Seurat); library(jsonlite)})
source('/source/r-backend/lib/seuratPipelineCore.R')
p <- fromJSON('/fixture/pbmc3k-resolved-params.json', simplifyVector=FALSE)
remote <- readRDS('/source/exports/paper-reproduction/pbmc3k-ssh-checkpoint.rds')$global
result <- run_seurat_pipeline_core(p, function(x) Read10X_h5(x), '/fixture/direct.rds', single_input='/fixture/pbmc3k.h5')
direct <- readRDS('/fixture/direct.rds')$global
checks <- list(
  retained_barcodes_identical=identical(colnames(remote),colnames(direct)),
  retained_genes_identical=identical(rownames(remote),rownames(direct)),
  cluster_labels_identical=identical(as.character(Idents(remote)),as.character(Idents(direct))),
  variable_features_identical=identical(VariableFeatures(remote),VariableFeatures(direct)),
  normalized_counts_equal=isTRUE(all.equal(LayerData(remote,layer='data'),LayerData(direct,layer='data'),tolerance=1e-12)),
  pca_equal=isTRUE(all.equal(Embeddings(remote,'pca'),Embeddings(direct,'pca'),tolerance=1e-8)),
  umap_equal=isTRUE(all.equal(Embeddings(remote,'umap'),Embeddings(direct,'umap'),tolerance=1e-8))
)
write_json(list(checks=checks,all_passed=all(unlist(checks)),n_cells=ncol(remote),n_clusters=nlevels(Idents(remote)),direct_summary=result$summary), '/fixture/direct-comparison.json',auto_unbox=TRUE,pretty=TRUE)
print(checks)
stopifnot(all(unlist(checks)))
