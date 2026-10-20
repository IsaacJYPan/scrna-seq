#!/usr/bin/env Rscript
# Run from the repository root. No Seurat/server/data download is required.
# Timing covers only aggregation after FetchData, not an end-to-end analysis.
source(file.path("r-backend", "tests", "test_dot_plot_summaries.R"))
run_dot_plot_parity_tests()
runtime <- load_dot_plot_runtime()
set.seed(3107)

allocated_bytes <- function(fn, fixture) {
  if (!isTRUE(capabilities("profmem"))) return(NA_real_)
  path <- tempfile("dot-plot-allocations-")
  on.exit(unlink(path), add = TRUE)
  Rprofmem(path)
  tryCatch(do.call(fn, fixture), finally = Rprofmem(NULL))
  lines <- readLines(path, warn = FALSE)
  sum(suppressWarnings(as.numeric(sub(" .*", "", lines))), na.rm = TRUE)
}

benchmark <- function(label, cells, genes, groups, skewed = FALSE, repeats = 5L) {
  gene_names <- paste0("Gene", seq_len(genes))
  labels <- paste0("Group", seq_len(groups))
  idents <- if (skewed) {
    sample(labels, cells, replace = TRUE, prob = c(50, rep(1, groups - 1L)))
  } else {
    rep(labels, length.out = cells)
  }
  frame <- as.data.frame(matrix(rpois(cells * genes, lambda = 0.3), ncol = genes))
  names(frame) <- gene_names
  fixture <- list(expression_data = frame, genes = gene_names,
                  idents = idents, clusters = labels)
  assert_dot_plot_parity(runtime, frame, gene_names, idents, labels)
  reference <- reference_dot_plot_group_summaries
  optimized <- runtime$dot_plot_group_summaries
  # Warm both functions, then alternate order to reduce warm-up/cache bias.
  invisible(do.call(reference, fixture))
  invisible(do.call(optimized, fixture))
  old <- new <- numeric(repeats)
  operations <- if (cells <= 3000L) 50L else 1L
  for (index in seq_len(repeats)) {
    order <- if (index %% 2L == 1L) c("old", "new") else c("new", "old")
    for (version in order) {
      invisible(gc())
      fn <- if (version == "old") reference else optimized
      started <- Sys.time()
      for (operation in seq_len(operations)) invisible(do.call(fn, fixture))
      elapsed <- as.numeric(difftime(Sys.time(), started, units = "secs")) / operations
      if (version == "old") old[index] <- elapsed else new[index] <- elapsed
    }
  }
  data.frame(scenario = label, cells = cells, genes = genes, groups = groups,
    reference_ms = round(1000 * median(old), 1),
    optimized_ms = round(1000 * median(new), 1),
    speedup = round(median(old) / median(new), 2),
    reference_alloc_mb = round(allocated_bytes(reference, fixture) / 1024^2, 2),
    optimized_alloc_mb = round(allocated_bytes(optimized, fixture) / 1024^2, 2),
    exact_parity = TRUE)
}

results <- rbind(
  benchmark("PBMC-sized", 3000L, 12L, 9L),
  benchmark("50 genes / 32 groups", 20000L, 50L, 32L),
  benchmark("skewed 200 groups", 20000L, 50L, 200L, skewed = TRUE)
)
cat("R version:", as.character(getRversion()), "\n")
cat("Median of five alternating runs (50 operations/run for PBMC-sized inputs).\n")
cat("Allocated memory is cumulative, not peak RSS.\n")
print(results, row.names = FALSE)
