summary <- data.frame(
  cells = ncol(obj),
  features = nrow(obj)
)
write_table(summary, "cell-summary.csv")
