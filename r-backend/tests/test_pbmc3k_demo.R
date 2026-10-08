# Run inside the reviewed PBMC3k demo image, repo mounted read-only at /repo.
suppressPackageStartupMessages({library(Seurat); library(jsonlite)})
manifest <- fromJSON('/opt/traceomics/demo/manifest.json')
checkpoint <- '/opt/traceomics/demo/checkpoint.rds'
stopifnot(identical(manifest$dataset,'pbmc3k'), identical(manifest$synthetic,FALSE),
  identical(digest::digest(file=checkpoint,algo='sha256'),manifest$checksumSha256))
bundle <- readRDS(checkpoint)
obj <- bundle$global
stopifnot(ncol(obj)==2638L, ncol(bundle$raw)==2700L, nrow(obj)==13714L,
  length(unique(obj$sample_id))==1L, !'condition' %in% colnames(obj[[]]),
  !'cell_type' %in% colnames(obj[[]]), all(obj$percent.mt<5),
  all(obj$nFeature_RNA>200 & obj$nFeature_RNA<2500),
  'FindClusters' %in% names(obj@commands),
  identical(as.character(Idents(obj)), as.character(obj$seurat_clusters)),
  !'seurat_clusters' %in% colnames(bundle$raw[[]]),
  identical(LayerData(obj,layer='counts'), LayerData(bundle$raw,layer='counts')[,colnames(obj)]))
runtime <- new.env(parent=globalenv())
sys.source('/repo/r-backend/plumber.R',envir=runtime)
lines <- readLines('/repo/r-backend/plumber.R')
endpoint <- function(method,route) {
  i <- which(trimws(lines)==paste('#* @',method,' ',route,sep=''))
  stopifnot(length(i)==1L)
  eval(parse(text=lines[(i+1L):length(lines)],n=1L)[[1]],envir=runtime)
}
runtime$global_obj <- obj
state <- endpoint('get','/pipeline-state')(res=new.env())
stopifnot(state$pca_dims==50L,state$cluster_dims==10L,state$has_qc,state$has_clusters)
result <- endpoint('get','/umap')(res=new.env(),dims=10,n_components=2,n_neighbors=30,min_dist=.3,seed=42)
stopifnot(is.null(result$error),result$result$n_points==2638L,!result$result$sampled,
  isTRUE(all.equal(Embeddings(runtime$global_obj,'umap'),Embeddings(obj,'umap'),tolerance=1e-10)))
cat(toJSON(list(success=TRUE,cells=ncol(obj),features=nrow(obj),clusters=as.list(table(Idents(obj))),
  checkpointBytes=file.info(checkpoint)$size,objectBytes=as.numeric(object.size(bundle))),auto_unbox=TRUE),'\n')
