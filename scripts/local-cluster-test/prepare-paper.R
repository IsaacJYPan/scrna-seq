suppressPackageStartupMessages({library(Matrix); library(Seurat); library(hdf5r); library(jsonlite)})
x <- readRDS('/fixture/pbmc68k_data.rds')$all_data[[1]]$hg19
mat <- as(t(x$mat), 'CsparseMatrix')
stopifnot(nrow(mat) == length(x$genes), ncol(mat) == length(x$barcodes))
rownames(mat) <- make.unique(x$gene_symbols)
colnames(mat) <- x$barcodes
# The production app currently scales every retained gene densely. A full
# 68k-cell run exceeds this local machine's memory envelope. Freeze an unbiased
# 10k-cell sample before inspecting any clusters or marker expression.
set.seed(20261108)
selected <- sort(sample(seq_len(ncol(mat)), 10000))
mat <- mat[, selected]
f <- H5File$new('/fixture/pbmc68k-subset.h5', 'w')
g <- f$create_group('hg19')
g[['data']] <- mat@x; g[['indices']] <- mat@i; g[['indptr']] <- mat@p
g[['shape']] <- as.integer(dim(mat)); g[['barcodes']] <- colnames(mat)
g[['genes']] <- x$genes; g[['gene_names']] <- rownames(mat)
f$close_all()
check <- Read10X_h5('/fixture/pbmc68k-subset.h5')
stopifnot(identical(dim(mat), dim(check)), isTRUE(all.equal(mat, check)))
writeLines(colnames(mat), '/fixture/paper-selected-barcodes.txt')
write_json(list(source_cells=length(x$barcodes), selected_cells=ncol(mat), genes=nrow(mat), sample_seed=20261108, counts_equal_after_conversion=TRUE), '/fixture/paper-input-manifest.json', auto_unbox=TRUE, pretty=TRUE)
cat('Verified paper subset:', nrow(mat), 'genes;', ncol(mat), 'cells\n')
