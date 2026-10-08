#!/usr/bin/env Rscript
# Exercise the exact read-only handler against real Seurat reductions.
runtime <- new.env(parent = globalenv())
plumber_file <- file.path("r-backend", "plumber.R")
sys.source(plumber_file, envir = runtime)
lines <- readLines(plumber_file, warn = FALSE)
marker <- which(trimws(lines) == "#* @get /reduction-results")
stopifnot(length(marker) == 1L)
preview <- eval(parse(text = lines[(marker + 1L):length(lines)], n = 1L)[[1]], runtime)
response <- function() new.env(parent = emptyenv())

main <- function() {
  cells <- runtime$MAX_PUBLIC_CELL_VALUES + 17L
  cell_names <- paste0("CELL", seq_len(cells))
  counts <- Matrix::sparseMatrix(i = rep(1:8, length.out = cells), j = seq_len(cells),
    x = rep(1, cells), dims = c(8L, cells),
    dimnames = list(paste0("GENE", 1:8), cell_names))
  object <- Seurat::CreateSeuratObject(counts, min.cells = 0, min.features = 0)
  object$seurat_clusters <- factor(rep(c("0", "1"), length.out = cells))
  SeuratObject::Idents(object) <- "seurat_clusters"
  pca_coordinates <- cbind(PC_1 = seq_len(cells), PC_2 = -seq_len(cells))
  rownames(pca_coordinates) <- cell_names
  pca_loadings <- matrix(seq_len(16L), ncol = 2L,
    dimnames = list(rownames(object), c("PC_1", "PC_2")))
  object[["pca"]] <- SeuratObject::CreateDimReducObject(embeddings = pca_coordinates,
    loadings = pca_loadings, stdev = c(4, 2), key = "PC_", assay = "RNA")
  umap_coordinates <- cbind(UMAP_1 = seq_len(cells), UMAP_2 = -seq_len(cells), UMAP_3 = rep(1, cells))
  rownames(umap_coordinates) <- cell_names
  object[["umap"]] <- SeuratObject::CreateDimReducObject(embeddings = umap_coordinates,
    key = "UMAP_", assay = "RNA")
  object@commands[["RunUMAP.RNA.pca"]] <- methods::new("SeuratCommand",
    name = "RunUMAP.RNA.pca", time.stamp = Sys.time(), assay.used = "RNA", call.string = "RunUMAP(object)",
    params = list(dims = 1:10, reduction = "pca", n.components = 3L,
      n.neighbors = 20L, min.dist = 0.25, seed.use = 42L, private_path = "/private/operator"))
  object@commands[["RunPCA.RNA"]] <- methods::new("SeuratCommand",
    name = "RunPCA.RNA", time.stamp = Sys.time(), assay.used = "RNA", call.string = "RunPCA(object)",
    params = list(npcs = 2L, seed.use = 42L))
  runtime$global_obj <- object
  runtime$raw_obj <- object
  runtime$live_revision <- 0
  runtime$live_saved_revision <- 0
  original <- serialize(runtime$global_obj, NULL)
  set.seed(555)
  original_rng <- .Random.seed
  umap <- preview(response(), "umap")
  pca <- preview(response(), "pca")
  repeated <- preview(response(), "umap")
  stopifnot(is.null(umap$provenance), is.null(pca$provenance))
  stopifnot(identical(serialize(runtime$global_obj, NULL), original))
  stopifnot(identical(.Random.seed, original_rng))
  stopifnot(identical(runtime$live_revision, 0), identical(runtime$live_saved_revision, 0))
  stopifnot(identical(umap$live_state$has_unsaved_changes, FALSE))
  stopifnot(identical(umap$result$settings$dims, 10L), identical(umap$result$settings$seed, 42))
  stopifnot(!"private_path" %in% names(umap$result$settings))
  stopifnot(identical(umap$result$trace_data, repeated$result$trace_data))
  stopifnot(umap$result$n_points == runtime$MAX_PUBLIC_CELL_VALUES, isTRUE(umap$result$sampled))
  stopifnot(sum(vapply(umap$result$trace_data, function(x) length(x$x), integer(1))) == runtime$MAX_PUBLIC_CELL_VALUES)
  stopifnot(all(vapply(umap$result$trace_data, function(x) identical(x$y, -x$x), logical(1))))
  stopifnot(all(vapply(umap$result$trace_data, function(x) all(x$z == 1), logical(1))))
  stopifnot(identical(pca$result$stdevs, c(4, 2)), length(pca$result$gene_loadings) == 2L)
  stopifnot(pca$result$n_points == runtime$MAX_PUBLIC_CELL_VALUES)

  # Missing reductions do not trigger analysis, and invalid selectors do not
  # allow inspection of arbitrary metadata or unknown reduction names.
  runtime$global_obj[["umap"]] <- NULL
  missing <- preview(response(), "umap")
  stopifnot(identical(missing$result$exists, FALSE), is.null(missing$provenance))
  invalid_response <- response()
  invalid <- preview(invalid_response, "private_operator_data")
  stopifnot(identical(invalid_response$status, 400L), !is.null(invalid$error))

  # A restored artifact without recorded commands is still inspectable; no
  # parameter values are invented. Non-finite coordinates are excluded.
  object@commands <- list()
  object[["umap"]]@cell.embeddings[1L, 1L] <- NA_real_
  runtime$global_obj <- object
  runtime$MAX_PUBLIC_CELL_VALUES <- cells
  unknown_settings <- preview(response(), "umap")
  stopifnot(length(unknown_settings$result$settings) == 0L)
  stopifnot(unknown_settings$result$nonfinite_points == 1L)
  stopifnot(unknown_settings$result$n_points == cells - 1L)

  # The read does not clean an already modified live analysis.
  runtime$live_revision <- 3
  dirty <- preview(response(), "pca")
  stopifnot(isTRUE(dirty$live_state$has_unsaved_changes), identical(runtime$live_revision, 3))
}
main()
cat("Restored reduction inspection: OK\n")
