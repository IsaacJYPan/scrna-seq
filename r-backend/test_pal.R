get_pub_palette <- function(name, n) {
  tryCatch({
    max_colors <- RColorBrewer::brewer.pal.info[name, 'maxcolors']
    safe_n <- min(max(n, 3), max_colors)
    cols <- RColorBrewer::brewer.pal(safe_n, name)
    if (n > max_colors) cols <- colorRampPalette(cols)(n)
    return(cols)
  }, error = function(e) {
    return(scales::hue_pal()(n))
  })
}
print(length(get_pub_palette('Set2', 9)))
