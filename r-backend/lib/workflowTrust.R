workflow_source_inventory <- function() {
  files <- list.files(workflow_runtime_root, pattern="\\.R$", recursive=TRUE, full.names=FALSE)
  files <- sort(files[!grepl("(^|/)tests/|(^|/)_", files)])
  lapply(files, function(file) list(path=paste0("r-backend/",file), sha256=digest::digest(file=file.path(workflow_runtime_root,file),algo="sha256")))
}
workflow_startup_source <- workflow_source_inventory()
# Identity of the R runtime. A container deployment supplies its immutable
# image digest. A plain R installation (no container) can opt in with
# TRACEOMICS_RUNTIME_LOCAL_INSTALL=1: its identity is then a digest of the R
# home, R version and the full installed package inventory, so installing,
# removing or upgrading any package changes it and pinned runs are refused.
workflow_runtime_digest <- function(pkgs) {
  image <- Sys.getenv("TRACEOMICS_RUNTIME_IMAGE_DIGEST")
  if (nzchar(image) || !identical(Sys.getenv("TRACEOMICS_RUNTIME_LOCAL_INSTALL"), "1")) return(image)
  lines <- sort(paste(pkgs[,"Package"], pkgs[,"Version"], pkgs[,"LibPath"]))
  text <- paste(c("traceomics.local-r-install.v1", normalizePath(R.home(), winslash="/"), as.character(getRversion()), lines), collapse="\n")
  paste0("sha256:", digest::digest(text, algo="sha256", serialize=FALSE))
}
workflow_runtime_manifest <- function() {
  if (!identical(workflow_startup_source,workflow_source_inventory())) stop("R source changed after startup; restart and reapprove.")
  pkgs <- installed.packages(noCache=TRUE)
  pkgs <- pkgs[!duplicated(pkgs[,"Package"]),,drop=FALSE]
  list(schema="traceomics.workflow-runtime.v1",imageDigest=workflow_runtime_digest(pkgs),rVersion=as.character(getRversion()),
       packages=lapply(seq_len(nrow(pkgs)),function(i)list(name=unname(pkgs[i,"Package"]),version=unname(pkgs[i,"Version"]))),source=workflow_startup_source)
}
