analysis <- inputs$analysis
dimensions <- seq_len(min(params$dimensions, ncol(Embeddings(analysis, "pca"))))
analysis <- FindNeighbors(analysis, dims = dimensions, verbose = FALSE)
write_output("analysis", analysis)
