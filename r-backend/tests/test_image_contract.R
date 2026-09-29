# Run in the demo image with the repository mounted read-only at /repo.
# Rscript /repo/r-backend/tests/test_image_contract.R
expressions <- parse("/repo/r-backend/plumber.R")
definition <- Filter(function(x) is.call(x) && identical(x[[1]], as.name("<-")) &&
  identical(x[[2]], as.name("runtime_package_available")), as.list(expressions))[[1]]
fresh_checker <- function() { environment <- new.env(); eval(definition, environment); environment$runtime_package_available }
fails <- function(expression) stopifnot(inherits(try(force(expression), silent=TRUE), "try-error"))
check <- fresh_checker()
stopifnot(check("CellChat"), check("clusterProfiler"), !check("harmony"), !check("hdf5r"))
stopifnot(!"CellChat" %in% loadedNamespaces(), !"clusterProfiler" %in% loadedNamespaces())
manifest_path <- Sys.getenv("TRACEOMICS_R_PACKAGE_MANIFEST")
manifest <- jsonlite::fromJSON(manifest_path, simplifyVector=FALSE)
temporary_manifest <- tempfile(fileext=".json")
manifest$packages$CellChat$version <- "0.0.0"
jsonlite::write_json(manifest, temporary_manifest, auto_unbox=TRUE)
Sys.setenv(TRACEOMICS_R_PACKAGE_MANIFEST=temporary_manifest)
fails(fresh_checker()("CellChat"))
manifest$rVersion <- "0.0.0"
jsonlite::write_json(manifest, temporary_manifest, auto_unbox=TRUE)
fails(fresh_checker()("Seurat"))
Sys.setenv(TRACEOMICS_R_PACKAGE_MANIFEST=paste0(temporary_manifest, ".missing"))
fails(fresh_checker()("Seurat"))
Sys.setenv(TRACEOMICS_R_PACKAGE_MANIFEST=manifest_path)

root <- tempfile("demo-bootstrap-")
dir.create(root)
key <- "projects/proj_contract/checkpoints/job_contract/checkpoint.rds"
jsonlite::write_json(list(checkpointKey=key), file.path(root, ".demo-template-bootstrap.json"), auto_unbox=TRUE)
Sys.setenv(STORAGE_ROOT=root)
run_bootstrap <- function() suppressWarnings(system2("Rscript", "/app/generate-demo-template.R", stdout=TRUE, stderr=TRUE))
result <- run_bootstrap()
stopifnot(is.null(attr(result, "status")))
receipt <- jsonlite::fromJSON(tail(result, 1))
stopifnot(isTRUE(receipt$precomputed), receipt$cells == 800L)
destination <- file.path(root, key)
original_hash <- digest::digest(file=destination, algo="sha256")
stopifnot(identical(original_hash, receipt$checksumSha256))
stopifnot(!is.null(attr(run_bootstrap(), "status")))
stopifnot(identical(digest::digest(file=destination, algo="sha256"), original_hash))
unlink(destination)
corrupt <- tempfile("corrupt-template-")
dir.create(corrupt)
file.copy(list.files(Sys.getenv("DEMO_PRECOMPUTED_DIR"), full.names=TRUE), corrupt)
Sys.chmod(file.path(corrupt, "checkpoint.rds"), mode="0600")
cat("corrupted", file=file.path(corrupt, "checkpoint.rds"), append=TRUE)
Sys.setenv(DEMO_PRECOMPUTED_DIR=corrupt)
stopifnot(!is.null(attr(run_bootstrap(), "status")), !file.exists(destination))
unlink(c(root, corrupt, temporary_manifest), recursive=TRUE)
cat("PASS: lazy capability checks, stale/missing manifest rejection, verified precomputed copy, no overwrite, corrupt checkpoint rejection\n")
