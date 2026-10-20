# Read an existing, measured PBMC3k checkpoint for frontend UI review.
# This does not recompute, modify, or save the Seurat analysis.
suppressPackageStartupMessages({ library(Seurat); library(jsonlite) })
args <- commandArgs(trailingOnly=TRUE)
checkpoint_path <- if (length(args) >= 1L) args[[1L]] else '/opt/traceomics/demo/checkpoint.rds'
output_path <- if (length(args) >= 2L) args[[2L]] else '/review/pbmc-ui-data.json'
saved <- readRDS(checkpoint_path)
obj <- saved$global
stopifnot(identical(obj@misc$traceomics_demo$synthetic, FALSE), ncol(obj) == 2638L)
groups <- as.character(Idents(obj))
coordinates <- Embeddings(obj, 'umap')
pca <- Embeddings(obj, 'pca')
genes <- c('CD3E', 'MS4A1', 'LYZ', 'NKG7', 'PPBP', 'FCER1A')
expression <- as.matrix(GetAssayData(obj, assay='RNA', layer='data')[genes, , drop=FALSE])
clusters <- sort(unique(groups))
traces <- function(matrix) lapply(clusters, function(cluster) {
  selected <- groups == cluster
  list(name=paste('Cluster', cluster), x=unname(matrix[selected,1]), y=unname(matrix[selected,2]))
})
avg <- t(vapply(clusters, function(cluster) rowMeans(expression[,groups==cluster,drop=FALSE]), numeric(length(genes))))
pct <- t(vapply(clusters, function(cluster) rowMeans(expression[,groups==cluster,drop=FALSE] > 0), numeric(length(genes))))
loading <- Loadings(obj, 'pca')
gene_loadings <- lapply(seq_len(min(10L,ncol(loading))), function(i) rownames(loading)[order(abs(loading[,i]),decreasing=TRUE)[1:15]])
names(gene_loadings) <- paste0('PC',seq_along(gene_loadings))
out <- list(
  source=list(dataset='PBMC3k', synthetic=FALSE, cells=ncol(obj), features=nrow(obj),
    preparedCheckpoint=TRUE, backendResponses='Simulated API; values extracted from measured PBMC3k checkpoint',
    input=obj@misc$traceomics_demo),
  objectInfo=list(n_cells=ncol(obj),n_features=nrow(obj),n_genes=nrow(obj),assays=Assays(obj),active_assay=DefaultAssay(obj),
    reductions=Reductions(obj),meta_cols=lapply(names(obj[[]]),function(name) list(name=name,type=if(is.numeric(obj[[name,drop=TRUE]])) 'numeric' else 'character'))),
  qc=list(n_cells=ncol(obj),n_features=nrow(obj),percent_mt=unname(obj$percent.mt),nFeature_RNA=unname(obj$nFeature_RNA),nCount_RNA=unname(obj$nCount_RNA)),
  umap=list(exists=TRUE,restored=TRUE,n_components=2L,n_cells=ncol(obj),trace_data=traces(coordinates),
    settings=obj@misc$traceomics_demo$umap),
  pca=list(exists=TRUE,restored=TRUE,npcs=ncol(pca),stdevs=unname(Stdev(obj,'pca')),gene_loadings=gene_loadings,trace_data=traces(pca),settings=list(npcs=ncol(pca))),
  genes=genes,
  expression=setNames(lapply(genes,function(gene) list(gene=gene,u1=unname(coordinates[,1]),u2=unname(coordinates[,2]),expression=unname(expression[gene,]),clusters=groups)),genes),
  heatmap=list(genes=genes,clusters=clusters,z=unname(t(avg))),
  dotplot=list(genes=genes,clusters=clusters,avg_expr=unname(t(avg)),pct_expr=unname(t(pct))),
  clusterCounts=setNames(as.integer(table(groups)),names(table(groups)))
)
write_json(out,output_path,auto_unbox=TRUE,digits=8)
cat('Exported measured PBMC3k values:',ncol(obj),'cells;',length(clusters),'clusters\n')
