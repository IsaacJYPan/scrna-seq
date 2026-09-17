analysis <- NormalizeData(inputs$analysis, verbose = FALSE)
analysis <- FindVariableFeatures(analysis, nfeatures = min(params$features, nrow(analysis)), verbose = FALSE)
analysis <- ScaleData(analysis, verbose = FALSE)
write_output("analysis", analysis)
