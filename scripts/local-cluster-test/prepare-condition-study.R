suppressPackageStartupMessages({library(Matrix);library(hdf5r);library(jsonlite)})
root<-'/fixture';files<-list.files(root,pattern='filtered_feature_bc_matrix.h5$',full.names=TRUE)
design<-read.delim('/output/reference/sample-design.tsv',stringsAsFactors=FALSE,check.names=FALSE)
dir.create(file.path(root,'inputs'),showWarnings=FALSE)
manifest<-list()
for(i in seq_len(nrow(design))) {
  sample<-design$sample[i];target<-file.path(root,'inputs',sprintf('sample%02d.h5',i))
  if(sample=='GSM3660650') {
    m<-as(readMM(gzfile(file.path(root,'extra_matrix.mtx.gz'))),'CsparseMatrix')
    genes<-read.delim(gzfile(file.path(root,'extra_genes.tsv.gz')),header=FALSE,stringsAsFactors=FALSE)
    barcodes<-readLines(gzfile(file.path(root,'extra_barcodes.tsv.gz')))
    stopifnot(nrow(m)==nrow(genes),ncol(m)==length(barcodes),all(m@x==round(m@x)))
    f<-H5File$new(target,'w');g<-f$create_group('hg19')
    g[['data']]<-m@x;g[['indices']]<-m@i;g[['indptr']]<-m@p;g[['shape']]<-as.integer(dim(m));g[['barcodes']]<-barcodes;g[['genes']]<-genes[[1]];g[['gene_names']]<-genes[[2]];f$close_all()
    f<-H5File$new(target,'r');stopifnot(identical(f[['hg19/data']][],m@x),identical(f[['hg19/indices']][],m@i),identical(f[['hg19/indptr']][],m@p));f$close_all();rm(m);gc()
  } else {
    source<-files[grepl(paste0('_',sample,'_'),basename(files),fixed=TRUE)]
    stopifnot(length(source)==1L,file.copy(source,target,overwrite=TRUE))
  }
  condition<-c(HC='control',M='moderate',S='severe')[[design$group[i]]]
  manifest[[i]]<-list(file=basename(target),sampleName=sprintf('S%02d',i),conditionName=condition,donorCode=sprintf('D%02d',i),batch=if(i%in%c(1,2,4))'chemistry_3prime_v2' else if(i==3)'chemistry_3prime_v3' else 'chemistry_5prime',sourceSample=sample,sha256=digest::digest(file=target,algo='sha256'))
}
write_json(manifest,file.path(root,'sponsor-inputs.json'),auto_unbox=TRUE,pretty=TRUE)
cat('Prepared all 13 independent donor inputs, including the external control, without expression downsampling.\n')
