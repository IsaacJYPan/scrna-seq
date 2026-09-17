analysis <- inputs$analysis
analysis[["percent.mt"]] <- PercentageFeatureSet(analysis, pattern = "^MT-")
keep <- analysis$nFeature_RNA >= params[["min-features"]] &
  analysis$percent.mt <= params[["max-mito"]]
if (!any(keep)) stop("No cells match these filters")
analysis <- subset(analysis, cells = colnames(analysis)[keep])
write_output("analysis", analysis)
write_output("summary", list(cells = ncol(analysis), features = nrow(analysis)))
counts <- data.frame(features = analysis$nFeature_RNA)
write_output("distribution", ggplot2::ggplot(counts, ggplot2::aes(x = features)) +
  ggplot2::geom_histogram(bins = 30, fill = "#1685e8") + ggplot2::theme_minimal())
