coordinates <- inputs$coordinates
labels <- inputs$labels
if (anyDuplicated(labels$cell) || !setequal(coordinates$ids, labels$cell)) stop("Cell identities differ")
matched <- match(coordinates$ids, labels$cell)
points <- data.frame(x = coordinates$x, y = coordinates$y, cluster = labels$cluster[matched])
write_output("figure", ggplot2::ggplot(points, ggplot2::aes(x = x, y = y, color = cluster)) +
  ggplot2::geom_point(size = params[["point-size"]]) + ggplot2::theme_minimal())
