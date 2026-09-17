analysis <- RunPCA(inputs$analysis, npcs = min(params$components, ncol(inputs$analysis) - 1L,
  length(VariableFeatures(inputs$analysis)) - 1L), seed.use = seed, verbose = FALSE)
write_output("analysis", analysis)
write_output("elbow", ElbowPlot(analysis))
