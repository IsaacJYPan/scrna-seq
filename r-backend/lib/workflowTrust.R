workflow_source_inventory <- function() {
  files <- list.files(workflow_runtime_root, pattern="\\.R$", recursive=TRUE, full.names=FALSE)
  files <- sort(files[!grepl("(^|/)tests/|(^|/)_", files)])
  lapply(files, function(file) list(path=paste0("r-backend/",file), sha256=digest::digest(file=file.path(workflow_runtime_root,file),algo="sha256")))
}
workflow_startup_source <- workflow_source_inventory()
workflow_runtime_manifest <- function() {
  if (!identical(workflow_startup_source,workflow_source_inventory())) stop("R source changed after startup; restart and reapprove.")
  pkgs <- installed.packages(noCache=TRUE)
  pkgs <- pkgs[!duplicated(pkgs[,"Package"]),,drop=FALSE]
  list(schema="traceomics.workflow-runtime.v1",imageDigest=Sys.getenv("TRACEOMICS_RUNTIME_IMAGE_DIGEST"),rVersion=as.character(getRversion()),
       packages=lapply(seq_len(nrow(pkgs)),function(i)list(name=unname(pkgs[i,"Package"]),version=unname(pkgs[i,"Version"]))),source=workflow_startup_source)
}
