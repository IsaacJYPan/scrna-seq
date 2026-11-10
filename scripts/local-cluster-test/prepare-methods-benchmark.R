# Sponsor-only format conversion of public, unperturbed PBMC technical data.
# No author labels, embeddings or inferred populations enter the app inputs.
suppressPackageStartupMessages({library(hdf5r);library(Matrix);library(jsonlite)})
root<-'/fixture';dir.create(file.path(root,'inputs'),showWarnings=FALSE)
design<-data.frame(
 inputId=c('4e793c57-b2e5-4c6a-8978-20ce416921f6','2c3ce3e7-28cd-41c0-88f6-645501e4d51e','dd5d124c-54a3-4dfa-ba79-20ab8cd21eca','5a1e5341-f890-4d11-8c89-cfed74167b17'),
 sampleName=sprintf('S%02d',1:4),conditionName=c('tech_v2','tech_v2','tech_v3','tech_v2'),
 donorCode=c('D01','D01','D01','D02'),batch=c('10x_3prime_v2','10x_3prime_v2','10x_3prime_v3','10x_3prime_v2'),
 sourcePrefix=c('pbmc1_10x_v2_A','pbmc1_10x_v2_B','pbmc1_10x_v3','pbmc2_10X_V2'),stringsAsFactors=FALSE)
manifest<-list()
for(version in c('10XV2','10XV3')) {
 f<-H5File$new(file.path(root,paste0('systematic-comparison-human-blood-',version,'.loom')),'r')
 ids<-f[['col_attrs/input_id']][];barcodes<-f[['col_attrs/CellID']][]
 symbols<-f[['row_attrs/gene_names']][];ensembl<-f[['row_attrs/ensembl_ids']][]
 symbols[is.na(symbols)|symbols=='']<-ensembl[is.na(symbols)|symbols==''];symbols<-make.unique(symbols)
 stopifnot(length(symbols)==f[['matrix']]$dims[2],length(ids)==f[['matrix']]$dims[1])
 for(k in which(design$inputId%in%ids)) {
  cells<-which(ids==design$inputId[k]);chunks<-split(cells,ceiling(seq_along(cells)/256L));blocks<-list()
  for(b in seq_along(chunks)) {
   dense<-f[['matrix']][chunks[[b]],,drop=FALSE]
   stopifnot(all(is.finite(dense)),all(dense>=0),all(dense==round(dense)))
   blocks[[b]]<-as(Matrix::Matrix(t(dense),sparse=TRUE),'CsparseMatrix');rm(dense)
  }
  m<-do.call(cbind,blocks);rm(blocks);invisible(gc());stopifnot(!anyDuplicated(barcodes[cells]))
  path<-file.path(root,'inputs',paste0('sample',sprintf('%02d',k),'.h5'));h<-H5File$new(path,'w');g<-h$create_group('hg38')
  g[['data']]<-m@x;g[['indices']]<-m@i;g[['indptr']]<-m@p;g[['shape']]<-as.integer(dim(m));g[['barcodes']]<-barcodes[cells];g[['genes']]<-ensembl;g[['gene_names']]<-symbols;h$close_all()
  h<-H5File$new(path,'r');stopifnot(identical(h[['hg38/data']][],m@x),identical(h[['hg38/indices']][],m@i),identical(h[['hg38/indptr']][],m@p));h$close_all()
  row<-as.list(design[k,]);row$file<-basename(path);row$sha256<-digest::digest(file=path,algo='sha256');row$cells<-ncol(m);row$genes<-nrow(m);row$conversionSparseArraysEqual<-TRUE;manifest[[k]]<-row
  cat(design$sampleName[k],':',ncol(m),'unfiltered barcodes, exact integer UMI conversion verified\n');rm(m);invisible(gc())
 }
 f$close_all()
}
stopifnot(length(manifest)==4L,all(vapply(manifest,length,integer(1))>0))
write_json(manifest,file.path(root,'sponsor-inputs.json'),auto_unbox=TRUE,pretty=TRUE)
