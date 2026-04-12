# ── Plumber Server Launcher ───────────────────────────────────────
# This script sets up the environment and starts the Plumber API.
# Called by: Electron main.js or manually via Rscript

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

# Set root path (one level up from r-backend)
root_dir <- normalizePath(file.path(script_dir, ".."), winslash = "/")
Sys.setenv(ANALYSIS_ROOT = root_dir)

# Set sample CSV path as environment variable so plumber.R can read it
csv_path <- file.path(script_dir, "sample_data.csv")
Sys.setenv(PLUMBER_SAMPLE_CSV = csv_path)

cat("Starting Plumber API...\n")
cat("Script dir:", script_dir, "\n")
cat("Sample CSV:", csv_path, "\n")

# Plumb the API file and start
api_file <- file.path(script_dir, "plumber.R")
options(plumber.autoreload = TRUE)
pr <- plumber::plumb(api_file)

cat("Plumber API running on http://0.0.0.0:8000\n")
pr$run(host = "0.0.0.0", port = 8000)
