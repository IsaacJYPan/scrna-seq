#!/usr/bin/env Rscript

# Real-Seurat smoke check for the classic Visium bundle contract used by
# spatial.seurat.v1. It creates a small synthetic Space Ranger-compatible
# bundle, runs the exact archive extractor, loads the image/coordinates with
# Load10X_Spatial, and exercises the preprocessing operations preserved in the
# durable checkpoint. No database or running server is required.

required <- c("Seurat", "Matrix", "hdf5r", "jsonlite")
missing <- required[!vapply(required, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing)) {
  cat("SKIP spatial Seurat verification; missing R packages:", paste(missing, collapse = ", "), "\n")
  quit(status = 0)
}
suppressPackageStartupMessages({
  library(Seurat)
  library(Matrix)
  library(hdf5r)
})

args <- commandArgs(trailingOnly = FALSE)
file_arg <- grep("^--file=", args, value = TRUE)
trailing_args <- commandArgs(trailingOnly = TRUE)
fixture_output_arg <- grep("^--fixture-output=", trailing_args, value = TRUE)
if (length(fixture_output_arg) > 1L) stop("Only one --fixture-output path may be supplied.")
fixture_output <- if (length(fixture_output_arg) == 1L) {
  sub("^--fixture-output=", "", fixture_output_arg)
} else ""
script_dir <- if (length(file_arg) == 1L) {
  dirname(normalizePath(sub("^--file=", "", file_arg)))
} else normalizePath("scripts")
workspace <- normalizePath(file.path(script_dir, ".."))
plumber_env <- new.env(parent = globalenv())
sys.source(file.path(workspace, "r-backend", "plumber.R"), envir = plumber_env)
extract_bundle <- get("extract_classic_visium_bundle", envir = plumber_env)

fixture <- tempfile("traceomics-spatial-smoke-")
outs <- file.path(fixture, "sample", "outs")
spatial_dir <- file.path(outs, "spatial")
dir.create(spatial_dir, recursive = TRUE)
on.exit(unlink(fixture, recursive = TRUE, force = TRUE), add = TRUE)

set.seed(23)
n_features <- 320L
n_spots <- 48L
counts <- matrix(rpois(n_features * n_spots, lambda = 2), nrow = n_features)
counts[sample(length(counts), floor(length(counts) * 0.2))] <- 0L
rownames(counts) <- c(paste0("MT-GENE", 1:5), paste0("GENE", 6:n_features))
colnames(counts) <- sprintf("SPOT%03d-1", seq_len(n_spots))
counts <- as(Matrix(counts, sparse = TRUE), "CsparseMatrix")

h5_path <- file.path(outs, "filtered_feature_bc_matrix.h5")
h5 <- H5File$new(h5_path, mode = "w")
tryCatch({
  matrix_group <- h5$create_group("matrix")
  matrix_group[["data"]] <- as.integer(counts@x)
  matrix_group[["indices"]] <- as.integer(counts@i)
  matrix_group[["indptr"]] <- as.integer(counts@p)
  matrix_group[["shape"]] <- as.integer(c(nrow(counts), ncol(counts)))
  matrix_group[["barcodes"]] <- colnames(counts)
  features <- matrix_group$create_group("features")
  features[["id"]] <- rownames(counts)
  features[["name"]] <- rownames(counts)
  features[["feature_type"]] <- rep("Gene Expression", nrow(counts))
  features[["genome"]] <- rep("synthetic", nrow(counts))
  features[["_all_tag_keys"]] <- c("genome")
}, finally = h5$close_all())

positions <- data.frame(
  barcode = colnames(counts),
  in_tissue = 1L,
  array_row = rep(seq_len(6L), each = 8L),
  array_col = rep(seq_len(8L), times = 6L),
  pxl_row_in_fullres = rep(seq(10, 90, length.out = 6L), each = 8L),
  pxl_col_in_fullres = rep(seq(10, 90, length.out = 8L), times = 6L),
  check.names = FALSE
)
utils::write.csv(positions, file.path(spatial_dir, "tissue_positions.csv"), row.names = FALSE)
jsonlite::write_json(list(
  spot_diameter_fullres = 8,
  tissue_hires_scalef = 1,
  fiducial_diameter_fullres = 8,
  tissue_lowres_scalef = 1
), file.path(spatial_dir, "scalefactors_json.json"), auto_unbox = TRUE)
grDevices::png(file.path(spatial_dir, "tissue_lowres_image.png"), width = 100, height = 100)
graphics::par(mar = rep(0, 4))
graphics::plot.new()
graphics::rect(0, 0, 1, 1, col = "white", border = NA)
grDevices::dev.off()

zip_path <- file.path(fixture, "sample-outs.zip")
prior_wd <- getwd()
setwd(fixture)
utils::zip(zip_path, c(
  "sample/outs/filtered_feature_bc_matrix.h5",
  "sample/outs/spatial/tissue_positions.csv",
  "sample/outs/spatial/scalefactors_json.json",
  "sample/outs/spatial/tissue_lowres_image.png"
), flags = "-q")
setwd(prior_wd)

if (nzchar(fixture_output)) {
  fixture_output <- normalizePath(fixture_output, winslash = "/", mustWork = FALSE)
  dir.create(dirname(fixture_output), recursive = TRUE, showWarnings = FALSE)
  if (!file.copy(zip_path, fixture_output, overwrite = TRUE)) {
    stop("Could not write the requested spatial browser fixture.")
  }
}

extracted <- extract_bundle(zip_path)
on.exit(unlink(extracted$root, recursive = TRUE, force = TRUE), add = TRUE)
obj <- Load10X_Spatial(
  data.dir = extracted$data_dir,
  filename = "filtered_feature_bc_matrix.h5",
  assay = "Spatial",
  slice = "slice1",
  filter.matrix = TRUE
)
stopifnot(inherits(obj, "Seurat"), ncol(obj) == n_spots, length(Images(obj)) == 1L)
stopifnot(nrow(GetTissueCoordinates(obj)) == n_spots)

obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern = "^MT-")
obj <- NormalizeData(obj, assay = "Spatial", verbose = FALSE)
obj <- FindVariableFeatures(obj, assay = "Spatial", nfeatures = 250, verbose = FALSE)
obj <- ScaleData(obj, assay = "Spatial", features = VariableFeatures(obj), verbose = FALSE)
obj <- RunPCA(obj, npcs = 10, seed.use = 23, verbose = FALSE)
obj <- FindNeighbors(obj, reduction = "pca", dims = 1:8, verbose = FALSE)
obj <- FindClusters(obj, resolution = 0.4, random.seed = 23, verbose = FALSE)
obj <- RunUMAP(obj, reduction = "pca", dims = 1:8, n.neighbors = 15,
               seed.use = 23, verbose = FALSE)
stopifnot(all(c("pca", "umap") %in% names(obj@reductions)), length(Images(obj)) == 1L)

cat(sprintf(
  "Spatial Seurat verification: OK (%d features, %d spots, %d clusters, image + coordinates retained)\n",
  nrow(obj), ncol(obj), length(unique(obj$seurat_clusters))
))
