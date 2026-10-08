#!/usr/bin/env Rscript
suppressPackageStartupMessages(library(Seurat))

# Execute the actual researcher starter against raw and processed analyses.
lines <- readLines(file.path("src", "pages", "ExpertR.jsx"), warn = FALSE)
first <- which(startsWith(lines, "const STARTER = `"))
stopifnot(length(first) == 1L)
last <- which(seq_along(lines) > first & trimws(lines) == "`;")[1L]
stopifnot(!is.na(last))
script <- c(sub("^const STARTER = `", "", lines[first]), lines[seq.int(first + 1L, last - 1L)])
commands <- parse(text = script)

counts <- matrix(rep(seq_len(12L), 8L), nrow = 12L, ncol = 8L,
                 dimnames = list(paste0("Gene", seq_len(12L)), paste0("Cell", seq_len(8L))))
raw <- CreateSeuratObject(counts)
processed <- raw
processed$seurat_clusters <- factor(rep(c("0", "1"), 4L))
coordinates <- matrix(seq_len(16L), ncol = 2L,
                      dimnames = list(colnames(processed), c("UMAP_1", "UMAP_2")))
processed[["umap"]] <- CreateDimReducObject(coordinates, key = "UMAP_", assay = "RNA")

for (object in list(raw, processed)) {
  runtime <- new.env(parent = globalenv())
  runtime$obj <- object
  before <- serialize(object, NULL)
  tables <- list()
  figures <- list()
  runtime$write_table <- function(value, filename) { tables[[filename]] <<- value }
  runtime$save_figure <- function(value, filename, width, height) {
    stopifnot(inherits(value, "ggplot"), width > 0, height > 0)
    figures[[filename]] <<- value
  }
  eval(commands, runtime)
  stopifnot(identical(before, serialize(runtime$obj, NULL)), length(tables) == 1L)
  summary <- tables[["object-summary.csv"]]
  stopifnot(summary$cells == 8L, summary$features == 12L)
  if ("umap" %in% Reductions(object)) {
    stopifnot(summary$clusters == 2L, length(figures) == 1L)
  } else {
    stopifnot(is.na(summary$clusters), length(figures) == 0L)
  }
}
cat("Expert R starter: raw and processed analysis inspection OK\n")
