analysis <- inputs$analysis
dimensions <- seq_len(min(params$dimensions, ncol(Embeddings(analysis, "pca"))))
analysis <- RunUMAP(analysis, dims = dimensions, n.neighbors = min(params$neighbors, ncol(analysis) - 1L), seed.use = seed, verbose = FALSE)
coordinates <- Embeddings(analysis, "umap")
write_output("coordinates", list(x = unname(coordinates[, 1]), y = unname(coordinates[, 2]), ids = rownames(coordinates)))
