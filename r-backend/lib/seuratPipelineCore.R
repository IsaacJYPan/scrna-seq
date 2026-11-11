# Shared Seurat QC -> normalization -> PCA -> clustering -> UMAP computation.
# Used by the Plumber worker bridge (r-backend/plumber.R) and by the standalone
# cluster runner (r-backend/hpc-runner.R) so both execute identical analysis code.
# `read_gene_expression(input)` returns a counts matrix for one input reference;
# `save_rds(value, path)` writes the checkpoint at `output_path`.
# Strict parameter contract, mirroring SEURAT_PIPELINE_PARAM_SPEC in
# backend/seuratPipeline.js. R is the one place the record must match the
# computation, so an invalid value stops the run instead of being replaced by a
# default or clamped to a bound. The seed has a fixed default: no job path draws
# a random one.
SEURAT_PIPELINE_PARAMETER_SPEC <- list(
  stopAfter = list(type = "enum", values = c("qc", "normalize", "pca", "cluster", "umap"), default = "umap"),
  minCells = list(type = "int", min = 0, max = 10000, default = 3L),
  minFeatures = list(type = "int", min = 0, max = 100000, default = 200L),
  applyQcFilter = list(type = "bool", default = TRUE),
  minFeaturesFilter = list(type = "int", min = 0, max = 100000, default = 200L),
  maxFeaturesFilter = list(type = "int", min = 1, max = 1000000, default = 2500L),
  maxPercentMt = list(type = "number", min = 0, max = 100, default = 5),
  minCountsFilter = list(type = "int", min = 0, max = 10000000, default = 0L),
  integrationMethod = list(type = "enum", values = c("none", "rpca"), default = "none"),
  normalizationMethod = list(type = "enum", values = c("LogNormalize", "SCTransform"), default = "LogNormalize"),
  scaleFactor = list(type = "int", min = 1, max = 10000000, default = 10000L),
  variableFeatures = list(type = "int", min = 50, max = 10000, default = 2000L),
  pcaDims = list(type = "int", min = 2, max = 100, default = 50L),
  clusterDims = list(type = "int", min = 2, max = 100, default = 15L),
  clusterResolution = list(type = "number", min = 0.01, max = 10, default = 0.8),
  umapDims = list(type = "int", min = 2, max = 100, default = 15L),
  umapComponents = list(type = "enum", values = c(2L, 3L), default = 2L),
  umapNeighbors = list(type = "int", min = 2, max = 200, default = 30L),
  umapMinDist = list(type = "number", min = 0, max = 1, default = 0.3),
  seed = list(type = "int", min = 0, max = 2147483647, default = 42L)
)

# Returns the effective parameters (every name in `parameter_names`, defaults applied to
# absent values). Unknown names and invalid values stop with a clear error.
validate_seurat_pipeline_parameters <- function(p, parameter_names = names(SEURAT_PIPELINE_PARAMETER_SPEC)) {
  if (is.null(p)) p <- list()
  if (!is.list(p)) stop("Pipeline parameters must be an object.", call. = FALSE)
  unknown <- setdiff(names(p), parameter_names)
  if (length(unknown)) stop(sprintf("Unknown pipeline parameter '%s'.", unknown[[1]]), call. = FALSE)
  out <- list()
  for (name in parameter_names) {
    spec <- SEURAT_PIPELINE_PARAMETER_SPEC[[name]]
    value <- p[[name]]
    if (is.null(value)) {
      out[[name]] <- spec$default
      next
    }
    invalid <- function(why) stop(sprintf("Invalid pipeline parameter '%s': %s.", name, why), call. = FALSE)
    if (length(value) != 1L || (!is.character(value) && is.na(value))) invalid("expected one value")
    if (identical(spec$type, "enum")) {
      if (!(value %in% spec$values)) invalid(paste("must be one of", paste(spec$values, collapse = ", ")))
      out[[name]] <- if (is.numeric(spec$values)) as.integer(value) else as.character(value)
    } else if (identical(spec$type, "bool")) {
      if (!is.logical(value)) invalid("must be true or false")
      out[[name]] <- value
    } else {
      if (!is.numeric(value) || !is.finite(value)) invalid("must be a finite number")
      if (identical(spec$type, "int") && value != round(value)) invalid("must be an integer")
      if (value < spec$min || value > spec$max) invalid(sprintf("must be between %s and %s", spec$min, spec$max))
      out[[name]] <- if (identical(spec$type, "int")) as.integer(value) else as.numeric(value)
    }
  }
  out
}

run_seurat_pipeline_core <- function(p, read_gene_expression, output_path,
                                     single_input = NULL, dataset_inputs = NULL,
                                     sample_names = NULL, condition_names = NULL,
                                     save_rds = saveRDS) {
  # ---- Read parameters ----
  multi_sample <- !is.null(dataset_inputs)
  effective <- validate_seurat_pipeline_parameters(p)
  stages <- c("qc", "normalize", "pca", "cluster", "umap")
  completed_stage <- effective$stopAfter
  stage <- match(completed_stage, stages)
  scalar_string <- function(value) is.character(value) && length(value) == 1L && !is.na(value) && nzchar(value)
  min_cells <- effective$minCells
  min_features <- effective$minFeatures
  apply_qc <- effective$applyQcFilter
  min_features_filter <- effective$minFeaturesFilter
  max_features_filter <- effective$maxFeaturesFilter
  max_percent_mt <- effective$maxPercentMt
  norm_method <- effective$normalizationMethod
  scale_factor <- effective$scaleFactor
  nfeatures <- effective$variableFeatures
  pca_dims <- effective$pcaDims
  cluster_dims <- effective$clusterDims
  cluster_res <- effective$clusterResolution
  umap_dims <- effective$umapDims
  umap_components <- effective$umapComponents
  umap_neighbors <- effective$umapNeighbors
  umap_min_dist <- effective$umapMinDist
  used_seed <- effective$seed
  # ---- Load counts ----
  if (multi_sample) {
    sample_objects <- lapply(seq_along(dataset_inputs), function(index) {
      input <- dataset_inputs[[index]]
      sample_name <- sample_names[[index]]
      sample_obj <- CreateSeuratObject(
        counts = read_gene_expression(input$storage_key),
        project = sample_name,
        min.cells = min_cells,
        min.features = min_features
      )
      sample_obj$sample_id <- sample_name
      sample_obj$condition <- condition_names[[index]]
      sample_obj$donor_code <- if (scalar_string(input$donor_code)) as.character(input$donor_code)[1] else NA_character_
      sample_obj$batch <- if (scalar_string(input$batch)) as.character(input$batch)[1] else NA_character_
      sample_obj
    })
    obj <- merge(
      x = sample_objects[[1]],
      y = sample_objects[-1],
      add.cell.ids = sprintf("sample%02d", seq_along(sample_objects)),
      merge.data = FALSE
    )
    rm(sample_objects);invisible(gc())
    # Join before retaining the raw snapshot so raw/global can share immutable
    # count storage rather than keeping both split and joined count copies.
    obj<-JoinLayers(obj);invisible(gc())
  } else {
    obj <- CreateSeuratObject(
      counts = read_gene_expression(single_input),
      min.cells = min_cells,
      min.features = min_features
    )
  }
  raw_obj <- obj
  warnings <- c()
  pre_filter_cells <- ncol(obj)

  # ---- Quality control ----
  # PercentageFeatureSet returns 0 for every cell when no feature matches
  # (Ensembl IDs, other naming schemes), which would make a percent.mt filter
  # silently pass everything. Count the matches and say so instead.
  mt_feature_count <- sum(grepl("^[Mm][Tt]-", rownames(obj)))
  mt_ok <- mt_feature_count > 0L
  if (mt_ok) {
    tryCatch({
      obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern = "^[Mm][Tt]-")
    }, error = function(e) {
      mt_ok <<- FALSE
      warnings <<- c(warnings, "percent.mt could not be computed")
      obj[["percent.mt"]] <<- 0
    })
  } else {
    warnings <- c(
      warnings,
      "No mitochondrial genes (MT- or mt- prefix) were found; percent.mt is unavailable and is not a QC criterion."
    )
    obj[["percent.mt"]] <- 0
  }

  qc_distribution <- function(values) {
    values <- as.numeric(values)
    values <- values[is.finite(values)]
    if (!length(values)) return(NULL)
    as.list(setNames(
      as.numeric(quantile(values, c(0, .25, .5, .75, 1), names = FALSE)),
      c("min", "q25", "median", "q75", "max")
    ))
  }
  qc_before <- lapply(obj@meta.data[, c("nCount_RNA", "nFeature_RNA", "percent.mt"), drop = FALSE], qc_distribution)
  sample_qc <- if (multi_sample) lapply(split(obj[[]], obj$sample_id), function(m) list(
    sample = as.character(m$sample_id[1]),
    condition = as.character(m$condition[1]),
    cells = nrow(m),
    counts = qc_distribution(m$nCount_RNA),
    genes = qc_distribution(m$nFeature_RNA),
    mitochondrial = qc_distribution(m$percent.mt)
  )) else list()
  if (apply_qc && !mt_ok && max_percent_mt < 100) {
    stop(
      "maxPercentMt filtering needs mitochondrial genes, but none matched the MT- prefix. ",
      "Set maxPercentMt to 100 or turn off QC filtering.",
      call. = FALSE
    )
  }
  if (apply_qc) {
    keep <- obj$nFeature_RNA >= min_features_filter &
      obj$nFeature_RNA <= max_features_filter &
      obj$percent.mt <= max_percent_mt & obj$nCount_RNA >= effective$minCountsFilter
    if (sum(keep) < 3) stop("QC filtering would leave fewer than 3 cells.")
    obj <- subset(obj, cells = colnames(obj)[keep])
  }
  post_filter_cells <- ncol(obj)
  invisible(gc())

  # ---- Normalize ----
  set.seed(used_seed)
  npcs <- 0L
  if(stage >= 2L) {
  if(multi_sample){obj<-JoinLayers(obj);invisible(gc())}
  if (norm_method == "SCTransform") {
    obj <- SCTransform(obj, verbose = FALSE)
  } else {
    obj <- NormalizeData(obj, normalization.method = norm_method, scale.factor = scale_factor, verbose = FALSE)
    invisible(gc())
    obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = nfeatures, verbose = FALSE)
    invisible(gc())
    obj <- ScaleData(obj, features = VariableFeatures(obj), block.size = 256L, verbose = FALSE)
    invisible(gc())
  }
  }

  # ---- PCA ----
  if(stage >= 3L) {
  npcs <- min(pca_dims, ncol(obj) - 1, nrow(obj) - 1, 100, na.rm = TRUE)
  if (is.na(npcs) || npcs < 2) stop("Insufficient cells/features for PCA.")
  obj <- RunPCA(obj, features = VariableFeatures(object = obj), npcs = npcs, seed.use = used_seed, verbose = FALSE)
  }

  # ---- Cluster ----
  graph_reduction <- "pca"
  if (stage >= 4L && identical(effective$integrationMethod, "rpca")) {
    if (!multi_sample || norm_method != "LogNormalize") stop("RPCA requires multiple samples and LogNormalize")
    obj[["RNA"]] <- split(obj[["RNA"]], f = obj$sample_id)
    obj <- IntegrateLayers(
      object = obj, method = RPCAIntegration,
      orig.reduction = "pca", new.reduction = "integrated.rpca",
      dims = seq_len(npcs), verbose = FALSE
    )
    obj <- JoinLayers(obj)
    graph_reduction <- "integrated.rpca"
  }
  if(stage >= 4L) {
  avail_dims <- ncol(Embeddings(obj, "pca"))
  cdims <- min(cluster_dims, avail_dims)
  obj <- FindNeighbors(obj, reduction = graph_reduction, dims = 1:cdims, verbose = FALSE)
  obj <- FindClusters(obj, resolution = cluster_res, random.seed = used_seed, verbose = FALSE)
  }

  # ---- UMAP ----
  if(stage >= 5L) {
  avail_dims <- ncol(Embeddings(obj, "pca"))
  udims <- min(umap_dims, avail_dims)
  un <- min(umap_neighbors, ncol(obj) - 1, na.rm = TRUE)
  if (is.na(un) || un < 2) stop("Insufficient cells for UMAP.")
  obj <- RunUMAP(obj, reduction = graph_reduction, dims = 1:udims, n.components = umap_components,
                 n.neighbors = un, min.dist = umap_min_dist, seed.use = used_seed, verbose = FALSE)
  }

  # ---- Save checkpoint ----
  safe_path <- output_path
  save_rds(list(global = obj, raw = raw_obj), safe_path)
  size_bytes <- as.numeric(file.info(safe_path)$size)
  checksum <- tryCatch({
    if (requireNamespace("digest", quietly = TRUE)) {
      digest::digest(file = safe_path, algo = "sha256")
    } else if (requireNamespace("openssl", quietly = TRUE)) {
      as.character(openssl::sha256(file(safe_path)))
    } else {
      NA_character_
    }
  }, error = function(e) NA_character_)
  saved <- isTRUE(file.exists(safe_path)) && !is.na(checksum)
  cluster_counts <- if("seurat_clusters" %in% colnames(obj@meta.data)) table(obj$seurat_clusters) else integer()
  count_checks <- lapply(Layers(raw_obj[[DefaultAssay(raw_obj)]],search="^counts"),function(layer) {
    counts <- LayerData(raw_obj,layer=layer)
    values <- if(inherits(counts,"sparseMatrix"))counts@x else as.numeric(counts)
    c(nonfinite=any(!is.finite(values)),negative=any(values<0),integer=all(is.finite(values)&values==round(values)))
  })

  # ---- Summarize ----
  summary_out <- list(
    completed_stage = completed_stage,
    diagnostics = list(
      sample_qc = unname(sample_qc),
      qc_before = qc_before,
      qc_after = lapply(obj@meta.data[, c("nCount_RNA", "nFeature_RNA", "percent.mt"), drop = FALSE], qc_distribution),
      pca_variance = if (stage >= 3L) as.list(as.numeric(Stdev(obj, "pca")^2 / sum(Stdev(obj, "pca")^2))) else list(),
      pca_variance_basis = "fraction_among_stored_PCs",
      cluster_sizes = as.list(cluster_counts),
      checks = list(
        contains_nonfinite_counts = any(vapply(count_checks, function(x) x[["nonfinite"]], logical(1))),
        negative_counts = any(vapply(count_checks, function(x) x[["negative"]], logical(1))),
        integer_counts = all(vapply(count_checks, function(x) x[["integer"]], logical(1))),
        doublets_assessed = FALSE,
        ambient_rna_assessed = FALSE,
        batch_effects_assessed = FALSE
      )
    ),
    n_cells = ncol(obj),
    n_features = nrow(obj),
    pre_filter_cells = pre_filter_cells,
    post_filter_cells = post_filter_cells,
    percent_mt_available = mt_ok,
    n_mt_features = as.integer(mt_feature_count),
    n_variable_features = length(VariableFeatures(obj)),
    n_pcs = npcs,
    n_clusters = length(cluster_counts),
    cluster_sizes = as.list(as.integer(cluster_counts)),
    reductions = as.list(names(obj@reductions)),
    normalization_method = norm_method,
    resolution = cluster_res,
    used_seed = used_seed
  )
  if (multi_sample) {
    condition_counts <- table(condition_names)
    summary_out$n_samples <- length(dataset_inputs)
    summary_out$conditions <- as.list(names(condition_counts))
    summary_out$samples_per_condition <- lapply(seq_along(condition_counts), function(index) {
      list(condition = names(condition_counts)[[index]], n = as.integer(condition_counts[[index]]))
    })
  }

  response_out <- list(
    ok = TRUE,
    summary = summary_out,
    # The parameters this run actually used. The worker refuses to record a run
    # whose effective parameters differ from the ones it requested.
    effective_parameters = effective,
    warnings = as.list(warnings),
    checkpoint = list(
      saved = saved,
      checksum_sha256 = if (is.na(checksum)) NULL else checksum,
      size_bytes = size_bytes
    ),
    versions = list(
      seurat_version = as.character(utils::packageVersion("Seurat")),
      r_version = as.character(getRversion())
    )
  )
  response_out
}
