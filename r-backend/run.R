# ── Plumber Server Launcher ───────────────────────────────────────
# This script sets up the environment and starts the Plumber API.
# Launched by: the Express server (server.js startPlumber) as an internal,
# localhost-only compute backend, or manually via `Rscript run.R`. (The historical
# Electron main.js launcher is no longer the active runtime.)

library(plumber)
library(jsonlite)

# Determine this script's directory
args <- commandArgs(trailingOnly = FALSE)
file_arg <- grep("^--file=", args, value = TRUE)
if (length(file_arg) > 0) {
  script_dir <- normalizePath(dirname(sub("^--file=", "", file_arg)), winslash = "/")
} else {
  script_dir <- normalizePath(".", winslash = "/")
}

# Set root path. In local dev this file lives in r-backend/, while the Docker
# image copies r-backend contents directly into /app.
root_dir <- if (basename(script_dir) == "r-backend") {
  normalizePath(file.path(script_dir, ".."), winslash = "/")
} else {
  normalizePath(script_dir, winslash = "/")
}
Sys.setenv(ANALYSIS_ROOT = root_dir)

# Set sample CSV path as environment variable so plumber.R can read it
csv_path <- file.path(script_dir, "sample_data.csv")
Sys.setenv(PLUMBER_SAMPLE_CSV = csv_path)

cat("Starting Plumber API...\n")
cat("Script dir:", script_dir, "\n")
cat("Sample CSV:", csv_path, "\n")

# Plumb the API file and start
api_file <- file.path(script_dir, "plumber.R")
options(plumber.autoreload = FALSE)
pr <- plumber::plumb(api_file)

# Allow port override via env var (used by integration tests to avoid conflicts)
plumber_port <- as.integer(Sys.getenv("PLUMBER_PORT", unset = "8000"))
plumber_host <- Sys.getenv("PLUMBER_HOST", unset = "127.0.0.1")
if (!(plumber_host %in% c("127.0.0.1", "0.0.0.0"))) stop("Invalid PLUMBER_HOST")
cat("Plumber API running on configured private interface, port ", plumber_port, "\n", sep = "")
pr$setSerializer(plumber::serializer_json(auto_unbox = TRUE))

# Centralized Global Error Handler
# Efficiently catches unhandled errors from any endpoint and prevents server crashes
pr$setErrorHandler(function(req, res, err) {
  cat("\n[API ERROR in", req$PATH_INFO, "]", err$message, "\n")
  
  # Ensure any graphics devices opened by failed plots are closed
  if (dev.cur() > 1) dev.off()
  
  # The frontend expects JSON payload, but with a correct HTTP error code
  res$status <- 500
  return(list(error = paste("Backend Exception:", err$message)))
})
pr$run(host = plumber_host, port = plumber_port)
