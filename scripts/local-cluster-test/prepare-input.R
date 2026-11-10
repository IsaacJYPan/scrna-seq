suppressPackageStartupMessages({library(Seurat); library(hdf5r)})
mat <- Read10X('/source/data/pbmc3k/filtered_gene_bc_matrices/hg19')
f <- H5File$new('/fixture/pbmc3k.h5', 'w')
g <- f$create_group('hg19')
g[['data']] <- mat@x
g[['indices']] <- mat@i
g[['indptr']] <- mat@p
g[['shape']] <- as.integer(dim(mat))
g[['barcodes']] <- colnames(mat)
g[['genes']] <- rownames(mat)
g[['gene_names']] <- rownames(mat)
f$close_all()
check <- Read10X_h5('/fixture/pbmc3k.h5')
stopifnot(identical(dim(mat), dim(check)), isTRUE(all.equal(mat, check)))
cat('Verified 10x HDF5 conversion:', nrow(check), 'genes;', ncol(check), 'cells\n')
