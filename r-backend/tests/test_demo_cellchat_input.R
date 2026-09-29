# Run in the reviewed demo image, with this repository mounted at /repo.
# The canonical checkpoint must stay unchanged: it lacks complete eligible
# secreted-signaling pairs and must fail as a pre-write input rejection.
runtime <- new.env(parent=globalenv())
sys.source('/repo/r-backend/plumber.R', envir=runtime)
checkpoint <- file.path(Sys.getenv('DEMO_PRECOMPUTED_DIR'), 'checkpoint.rds')
before <- digest::digest(file=checkpoint, algo='sha256')
object <- readRDS(checkpoint)$global
params <- runtime$normalize_cellchat_inference_params(list(
  groupBy='seurat_clusters', assay='RNA', species='human',
  databaseCategory='secreted_signaling', analysisIntent='single_context',
  minCellsPerGroup=10L, maxCellsPerGroup=500L, maxTotalCells=1000L,
  pValueCutoff=0.1, topInteractions=5L, topPathways=5L, randomSeed=17L
))
failure <- tryCatch({runtime$run_cellchat_inference_analysis(object, params); NULL}, error=identity)
stopifnot(inherits(failure, 'cellchat_inference_input_error'),
  identical(failure$code, 'CELLCHAT_NO_ELIGIBLE_INTERACTIONS'),
  identical(before, digest::digest(file=checkpoint, algo='sha256')))
cat('PASS: canonical CellChat input is rejected explicitly before writing; checkpoint unchanged.\n')
