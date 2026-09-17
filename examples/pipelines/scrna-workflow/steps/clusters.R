analysis <- FindClusters(inputs$analysis, resolution = params$resolution, random.seed = seed, verbose = FALSE)
write_output("labels", data.frame(cell = colnames(analysis), cluster = as.character(Idents(analysis))))
