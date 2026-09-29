# Build-time only: audit the runtime closure and attest loadability offline.
args <- commandArgs(trailingOnly=TRUE)
action <- args[[1]]
profile <- if (length(args) > 1) args[[2]] else "demo"
roots <- c("plumber", "jsonlite", "digest", "Seurat", "dplyr", "Matrix", "ggplot2", "base64enc",
           "clusterProfiler", "fgsea", "AnnotationDbi", "org.Hs.eg.db", "org.Mm.eg.db", "GO.db",
           "CellChat", "NMF", "presto", "ComplexHeatmap", "BiocGenerics", "BiocNeighbors", "edgeR", "limma")
if (identical(profile, "private")) roots <- c(roots, "hdf5r")
packages <- installed.packages()
packages <- packages[!duplicated(packages[, "Package"]), , drop=FALSE]
stopifnot(all(roots %in% rownames(packages)))

if (identical(action, "select")) {
  # Upload-only hdf5r, installers, and unused Suggests are excluded. Keep the
  # entire Depends/Imports/LinkingTo closure, including all public heavy jobs.
  closure <- sort(unique(c(roots, unlist(tools::package_dependencies(
    roots, db=packages, which=c("Depends", "Imports", "LinkingTo"), recursive=TRUE)))))
  # The complete base/recommended R library is copied with the R runtime.
  closure <- sort(unique(c(setdiff(closure, "R"),
    packages[packages[, "LibPath"] == file.path(R.home(), "library"), "Package"])))
  destination <- "/opt/demo-library"
  dir.create(destination, recursive=TRUE)
  for (name in closure) {
    location <- find.package(name)
    if (dirname(location) == file.path(R.home(), "library")) next
    if (!file.copy(location, destination, recursive=TRUE)) stop("Could not copy ", name)
  }
  jsonlite::write_json(list(roots=roots, retained=closure, excluded=setdiff(rownames(packages), closure)),
                      "/opt/demo-packages.json", pretty=TRUE, auto_unbox=TRUE)
} else if (identical(action, "manifest")) {
  required <- vapply(roots, requireNamespace, logical(1), quietly=TRUE)
  if (!all(required)) stop("Unloadable runtime packages: ", paste(roots[!required], collapse=", "))
  stopifnot(identical(as.character(packageVersion("CellChat")), "2.1.2"))
  # Optional health capabilities must report absence truthfully.
  checks <- unique(c(roots, "harmony"))
  checked <- lapply(checks, function(name) list(
    loadable=requireNamespace(name, quietly=TRUE),
    version=if (name %in% rownames(packages)) packages[name, "Version"] else NULL
  ))
  names(checked) <- checks
  dir.create("/usr/local/share/traceomics", recursive=TRUE, showWarnings=FALSE)
  jsonlite::write_json(list(schemaVersion=1, profile=profile, rVersion=as.character(getRversion()),
    packages=checked, installed=as.list(setNames(packages[, "Version"], rownames(packages)))),
    "/usr/local/share/traceomics/r-packages.json", pretty=TRUE, auto_unbox=TRUE)
} else stop("Unknown build-time package action")
