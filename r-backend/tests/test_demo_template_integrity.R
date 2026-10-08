# Run with the cached scientific image; no network or package installation.
# Rscript /repo/r-backend/tests/test_demo_template_integrity.R /repo
args <- commandArgs(trailingOnly=TRUE)
repo <- if (length(args)) args[[1]] else getwd()
suppressPackageStartupMessages({library(Seurat); library(Matrix); library(jsonlite)})
root <- tempfile('demo-integrity-')
dir.create(root)
key <- 'projects/proj_integrity/checkpoints/job_integrity/checkpoint.rds'
write_json(list(checkpointKey=key), file.path(root, '.demo-template-bootstrap.json'), auto_unbox=TRUE)
Sys.setenv(STORAGE_ROOT=root, DEMO_PRECOMPUTED_DIR='')
status <- system2(file.path(R.home('bin'), 'Rscript'),
  shQuote(file.path(repo, 'r-backend/generate-demo-template.R')))
stopifnot(status == 0L)
bundle <- readRDS(file.path(root, key))
obj <- bundle$global
stopifnot(ncol(obj) == 800L, nrow(obj) == 200L,
  !'seurat_clusters' %in% colnames(bundle$raw[[]]),
  'FindClusters' %in% names(obj@commands),
  identical(as.character(Idents(obj)), as.character(obj$seurat_clusters)),
  identical(LayerData(obj, layer='counts'), LayerData(bundle$raw, layer='counts')),
  all(table(obj$cell_type) == 200L))
# Reproduce from counts with independent standard Seurat calls, including real
# graph clustering. Supplied simulation labels are never inputs to these calls.
fresh <- CreateSeuratObject(LayerData(bundle$raw, layer='counts'))
fresh <- NormalizeData(fresh, verbose=FALSE)
fresh <- FindVariableFeatures(fresh, nfeatures=120, verbose=FALSE)
fresh <- ScaleData(fresh, verbose=FALSE)
fresh <- RunPCA(fresh, npcs=15, verbose=FALSE)
fresh <- FindNeighbors(fresh, dims=1:10, verbose=FALSE)
fresh <- FindClusters(fresh, resolution=.5, random.seed=20260808, verbose=FALSE)
fresh <- RunUMAP(fresh, dims=1:10, n.neighbors=20, min.dist=.25, seed.use=20260808, verbose=FALSE)
stopifnot(identical(as.character(Idents(fresh)), as.character(Idents(obj))),
  isTRUE(all.equal(Embeddings(fresh,'umap'), Embeddings(obj,'umap'), tolerance=1e-10)))
# Exercise the actual endpoint, not a mirrored trace serializer.
runtime <- new.env(parent=globalenv())
plumber_file <- file.path(repo, 'r-backend/plumber.R')
sys.source(plumber_file, envir=runtime)
source_lines <- readLines(plumber_file)
line <- which(trimws(source_lines) == '#* @get /umap')
stopifnot(length(line) == 1L)
handler <- eval(parse(text=source_lines[(line + 1L):length(source_lines)], n=1L)[[1]], envir=runtime)
runtime$global_obj <- obj
response <- handler(res=new.env(), dims=10, n_components=2, n_neighbors=20, min_dist=.25, seed=20260808)
stopifnot(is.null(response$error), response$result$n_points == 800L, !response$result$sampled)
actual <- Embeddings(runtime$global_obj, 'umap')
for (trace in response$result$trace_data) {
  group <- sub('^Cluster ', '', trace$name)
  indices <- which(as.character(Idents(runtime$global_obj)) == group)
  stopifnot(identical(trace$x, as.numeric(actual[indices,1])),
    identical(trace$y, as.numeric(actual[indices,2])))
}
stopifnot(isTRUE(all.equal(actual, Embeddings(obj,'umap'), tolerance=1e-10)))
if (length(args) > 1L) write_json(response, args[[2]], auto_unbox=TRUE, digits=NA)
unlink(root, recursive=TRUE)
cat('PASS: inferred clusters and reproducible Seurat coordinates; endpoint returns all 800 exact coordinates; raw counts unchanged.\n')
