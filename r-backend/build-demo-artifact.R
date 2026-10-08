# Only invoked by the demo image build, with network disabled.
library(jsonlite)
library(digest)
root <- "/tmp/demo-checkpoint-build"
dir.create(root, recursive=TRUE)
key <- "projects/proj_image_template/checkpoints/job_image_template/checkpoint.rds"
write_json(list(checkpointKey=key), file.path(root, ".demo-template-bootstrap.json"), auto_unbox=TRUE)
Sys.setenv(STORAGE_ROOT=root, DEMO_PRECOMPUTED_DIR="")
status <- system2(file.path(R.home("bin"), "Rscript"), "/tmp/demo-build/generate-demo-template.R")
if (status != 0L) stop("Demo template generation failed")
bundle <- readRDS(file.path(root, key))
dataset <- Sys.getenv('DEMO_DATASET', unset='synthetic')
destination <- "/opt/traceomics/demo"
dir.create(destination, recursive=TRUE)
stopifnot(file.copy(file.path(root, key), file.path(destination, "checkpoint.rds")))
# The generator writes private project files with mode 0600. This immutable,
# synthetic image asset must be readable by the unprivileged bootstrap process.
Sys.chmod(file.path(destination, "checkpoint.rds"), mode="0444")
write_json(list(version=2, dataset=dataset, synthetic=dataset == 'synthetic',
  cells=ncol(bundle$global), features=nrow(bundle$global),
  source=bundle$global@misc$traceomics_demo,
  checksumSha256=digest(file=file.path(destination, "checkpoint.rds"), algo="sha256"),
  sizeBytes=file.info(file.path(destination, "checkpoint.rds"))$size,
  recipeSha256=digest(file="/tmp/demo-build/generate-demo-template.R", algo="sha256"),
  rVersion=as.character(getRversion()), seuratVersion=as.character(packageVersion("Seurat"))),
  file.path(destination, "manifest.json"), pretty=TRUE, auto_unbox=TRUE)
unlink(root, recursive=TRUE)
