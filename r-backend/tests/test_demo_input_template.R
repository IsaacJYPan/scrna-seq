# Compare the small guided-demo checkpoint with the verified PBMC3k image asset.
args <- commandArgs(trailingOnly=TRUE)
repo <- args[[1]]
precomputed <- if (length(args) > 1L) args[[2]] else Sys.getenv("DEMO_PRECOMPUTED_DIR")
suppressPackageStartupMessages({ library(Seurat); library(jsonlite) })
root <- tempfile("demo-input-test-")
dir.create(root)
key <- "projects/proj_input_test/checkpoints/job_input_test/checkpoint.rds"
write_json(list(checkpointKey=key, stage="input"),
  file.path(root, ".demo-template-bootstrap.json"), auto_unbox=TRUE)
status <- system2(file.path(R.home("bin"), "Rscript"),
  shQuote(file.path(repo, "r-backend/generate-demo-template.R")),
  env=c(paste0("STORAGE_ROOT=", root), "DEMO_DATASET=pbmc3k",
        paste0("DEMO_PRECOMPUTED_DIR=", precomputed)))
stopifnot(status == 0L)
source <- readRDS(file.path(precomputed, "checkpoint.rds"))
generated <- readRDS(file.path(root, key))
stopifnot(ncol(generated$global) == 2700L, nrow(generated$global) == 13714L,
  identical(Layers(generated$global), "counts"),
  length(generated$global@reductions) == 0L,
  !"seurat_clusters" %in% colnames(generated$global[[]]),
  identical(LayerData(generated$global, layer="counts"), LayerData(source$raw, layer="counts")),
  identical(generated$global[[]], source$raw[[]]),
  identical(generated$global, generated$raw),
  identical(generated$global@misc$traceomics_demo, fromJSON(file.path(precomputed, "manifest.json"))$source),
  file.info(file.path(root, key))$size < file.info(file.path(precomputed, "checkpoint.rds"))$size / 5)
cat(toJSON(list(success=TRUE, cells=ncol(generated$global),
  originalBytes=file.info(file.path(precomputed, "checkpoint.rds"))$size,
  inputBytes=file.info(file.path(root, key))$size), auto_unbox=TRUE), "\n")
unlink(root, recursive=TRUE)
