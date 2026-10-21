#!/usr/bin/env Rscript
# Test the production aggregation helper without requiring Seurat or a server.
# The reference preserves the prior dot-plot handler's exact aggregation code.
load_dot_plot_runtime <- function() {
  runtime <- new.env(parent = globalenv())
  file <- file.path("r-backend", "plumber.R")
  sys.source(file.path(dirname(file), "lib", "publicParameters.R"), envir = runtime)
  expressions <- parse(file)
  for (expression in expressions) {
    if (!is.call(expression) || !identical(expression[[1L]], as.name("<-")) ||
        !is.symbol(expression[[2L]])) next
    name <- as.character(expression[[2L]])
    if (name == "dot_plot_group_summaries") eval(expression, runtime)
  }
  lines <- readLines(file, warn = FALSE)
  line <- which(trimws(lines) == "#* @get /dot-plot")
  stopifnot(length(line) == 1L)
  runtime$handler <- eval(parse(text = lines[(line + 1L):length(lines)], n = 1L)[[1L]], runtime)
  runtime
}

reference_dot_plot_group_summaries <- function(expression_data, genes, idents, clusters) {
  avg_list <- vector("list", length(genes))
  pct_list <- vector("list", length(genes))
  for (gi in seq_along(genes)) {
    g <- genes[gi]
    expr <- as.numeric(expression_data[[g]])
    avg_row <- sapply(clusters, function(cl) mean(expr[idents == cl]))
    pct_row <- sapply(clusters, function(cl) mean(expr[idents == cl] > 0))
    avg_list[[gi]] <- as.numeric(avg_row)
    pct_list[[gi]] <- as.numeric(pct_row)
  }
  list(avg_expr = avg_list, pct_expr = pct_list)
}

assert_dot_plot_parity <- function(runtime, expression_data, genes, idents, clusters) {
  force(genes)
  force(clusters)
  original_data <- serialize(expression_data, NULL)
  original_idents <- serialize(idents, NULL)
  original_rng <- if (exists(".Random.seed", envir = .GlobalEnv)) .Random.seed else NULL
  expected <- reference_dot_plot_group_summaries(expression_data, genes, idents, clusters)
  actual <- runtime$dot_plot_group_summaries(expression_data, genes, idents, clusters)
  # Serialization also checks NaN/NA and floating-point bit patterns, list/column
  # order, attributes, and signed zero rather than allowing numeric tolerance.
  stopifnot(identical(serialize(actual, NULL), serialize(expected, NULL)))
  stopifnot(identical(serialize(expression_data, NULL), original_data))
  stopifnot(identical(serialize(idents, NULL), original_idents))
  stopifnot(identical(if (exists(".Random.seed", envir = .GlobalEnv)) .Random.seed else NULL,
                      original_rng))
  invisible(actual)
}

run_dot_plot_parity_tests <- function() {
  runtime <- load_dot_plot_runtime()
  set.seed(3107)
  # Empty groups, dropped groups, missing identities, Unicode labels, repeated
  # genes, unusual numeric values, and cells returned in arbitrary order.
  values <- c(0, -0, -2.5, 1e-300, 1e300, NA_real_, NaN, Inf, -Inf, 7)
  frame <- data.frame(GeneA = values, GeneB = rev(values),
                      row.names = paste0("Cell", seq_along(values)))
  labels <- c("2", "10", "a", "\u03b2", "2", NA, "a", "10", "2", "\u03b2")
  names(labels) <- rownames(frame)
  clusters <- c("\u03b2", "2", "unused", "10", "a", NA_character_)
  assert_dot_plot_parity(runtime, frame, c("GeneB", "GeneA", "GeneB"), labels, clusters)
  assert_dot_plot_parity(runtime, frame[FALSE, ], names(frame), character(), clusters)
  assert_dot_plot_parity(runtime, frame, character(), labels, clusters)
  assert_dot_plot_parity(runtime, frame, names(frame), labels, character())
  # FetchData returns numeric columns; exercise sparse counts converted to that
  # representation without changing the zero-expression calculation.
  if (requireNamespace("Matrix", quietly = TRUE)) {
    sparse <- Matrix::sparseMatrix(i = c(1L, 5L, 8L, 2L), j = c(1L, 1L, 2L, 2L),
      x = c(1, 3, 0.5, -1), dims = c(10L, 2L),
      dimnames = list(rownames(frame), c("GeneA", "GeneB")))
    assert_dot_plot_parity(runtime, as.data.frame(as.matrix(sparse)),
                           c("GeneA", "GeneB"), labels, clusters)
  }
  for (index in seq_len(150L)) {
    count <- sample(0:350, 1L)
    gene_count <- sample(1:8, 1L)
    group_count <- sample(1:18, 1L)
    genes <- paste0("Gene", seq_len(gene_count))
    frame <- as.data.frame(matrix(sample(values, count * gene_count, replace = TRUE),
                                   nrow = count, ncol = gene_count))
    names(frame) <- genes
    groups <- paste0("Group", seq_len(group_count))
    labels <- sample(c(groups, NA_character_), count, replace = TRUE)
    requested_groups <- sample(c(groups, "unused"))
    assert_dot_plot_parity(runtime, frame, sample(genes), labels, requested_groups)
  }

  # Exercise the actual handler and its actual sampling/validation helpers. Only
  # the Seurat adapters are fixtures; both versions see identical fetched cells.
  cells <- paste0("Cell", seq_len(105L))
  genes <- c("GeneA", "GeneB", "GeneC")
  runtime$global_obj <- matrix(0, nrow = 3L, ncol = length(cells),
    dimnames = list(genes, cells))
  identity_values <- factor(rep(c("10", "2", "a"), length.out = length(cells)),
                            levels = c("a", "unused", "2", "10"))
  names(identity_values) <- cells
  frame <- as.data.frame(matrix(rnorm(length(cells) * length(genes)), ncol = 3L,
    dimnames = list(cells, genes)))
  frame[seq(1L, length(cells), by = 7L), ] <- 0
  runtime$Idents <- function(object) identity_values
  runtime$FetchData <- function(object, vars, cells) {
    # Seurat may omit/reorder fetched rows. Group lookup must use row names.
    frame[rev(cells[-1L]), vars, drop = FALSE]
  }
  optimized <- runtime$dot_plot_group_summaries
  runtime$dot_plot_group_summaries <- reference_dot_plot_group_summaries
  expected <- runtime$handler(new.env(), "GeneC,GeneA,GeneC")
  runtime$dot_plot_group_summaries <- optimized
  actual <- runtime$handler(new.env(), "GeneC,GeneA,GeneC")
  stopifnot(is.null(actual$error), identical(serialize(actual, NULL), serialize(expected, NULL)))
  stopifnot(identical(actual$clusters, c("a", "2", "10")))
  stopifnot(identical(actual$genes, c("GeneC", "GeneA")))
  stopifnot(actual$analysis_cells == length(cells) - 1L, isTRUE(actual$sampled))
  runtime$MAX_PUBLIC_CELL_VALUES <- 11L
  runtime$MAX_PUBLIC_CLUSTERS <- 2L
  runtime$dot_plot_group_summaries <- reference_dot_plot_group_summaries
  expected <- runtime$handler(new.env(), "GeneC,GeneA")
  runtime$dot_plot_group_summaries <- optimized
  actual <- runtime$handler(new.env(), "GeneC,GeneA")
  stopifnot(identical(serialize(actual, NULL), serialize(expected, NULL)))
  stopifnot(actual$analysis_cells == 10L, isTRUE(actual$clusters_truncated))
  response <- new.env()
  stopifnot(!is.null(runtime$handler(response, "")$error), response$status == 400)
  stopifnot(!is.null(runtime$handler(new.env(), "missing")$error))
  cat("PASS: dot-plot exact parity (154 edge/random fixtures, sparse values, handler sampling and ordering)\n")
  if (requireNamespace("Seurat", quietly = TRUE)) {
    seurat_runtime <- load_dot_plot_runtime()
    counts <- matrix(rpois(180L * 8L, lambda = 1), nrow = 8L,
      dimnames = list(paste0("Gene", 1:8), paste0("Cell", 1:180)))
    object <- Seurat::CreateSeuratObject(counts, min.cells = 0, min.features = 0)
    object <- Seurat::NormalizeData(object, verbose = FALSE)
    SeuratObject::Idents(object) <- factor(rep(c("10", "2", "a"), 60L),
                                         levels = c("a", "unused", "2", "10"))
    seurat_runtime$global_obj <- object
    seurat_runtime$Idents <- SeuratObject::Idents
    seurat_runtime$FetchData <- SeuratObject::FetchData
    original_object <- serialize(object, NULL)
    original_rng <- .Random.seed
    optimized <- seurat_runtime$dot_plot_group_summaries
    seurat_runtime$dot_plot_group_summaries <- reference_dot_plot_group_summaries
    expected <- seurat_runtime$handler(new.env(), "Gene4,Gene1,Gene7")
    seurat_runtime$dot_plot_group_summaries <- optimized
    actual <- seurat_runtime$handler(new.env(), "Gene4,Gene1,Gene7")
    stopifnot(is.null(actual$error), identical(serialize(actual, NULL), serialize(expected, NULL)))
    stopifnot(identical(serialize(seurat_runtime$global_obj, NULL), original_object))
    stopifnot(identical(.Random.seed, original_rng))
    cat("PASS: actual Seurat Idents/FetchData handler parity; object and RNG unchanged\n")
  } else {
    cat("SKIP: real Seurat integration (Seurat is not installed); handler adapter parity passed.\n")
  }
  invisible(TRUE)
}

if (sys.nframe() == 0L) run_dot_plot_parity_tests()
