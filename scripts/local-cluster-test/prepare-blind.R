suppressPackageStartupMessages({library(Matrix);library(hdf5r);library(jsonlite)})
load('/fixture/source.RData')
# Extract the serialized legacy SCE's raw assay without using logcounts or any
# reduced dimensions. No analysis or reference-based cell selection is applied.
x<-sce_sc_10x_qc
assay_list<-attr(get('data',attr(attr(x,'assays'),'.xData')),'listData')
mat<-as(assay_list$counts,'CsparseMatrix')
meta<-attr(attr(x,'colData'),'listData')
labels<-as.character(meta$cell_line_demuxlet)
stopifnot(ncol(mat)==length(labels),ncol(mat)==902,all(is.finite(mat@x)),all(mat@x>=0),all(mat@x==round(mat@x)))
original_cells<-colnames(mat)
cell_ids<-sprintf('cell_%04d',seq_len(ncol(mat)))
annotation<-read.delim('/source/data/pbmc3k/filtered_gene_bc_matrices/hg19/genes.tsv',header=FALSE,stringsAsFactors=FALSE)
symbols<-annotation$V2[match(rownames(mat),annotation$V1)]
symbols[is.na(symbols)|symbols=='']<-rownames(mat)[is.na(symbols)|symbols=='']
symbols<-make.unique(symbols)
rownames(mat)<-symbols;colnames(mat)<-cell_ids
f<-H5File$new('/fixture/sample-A.h5','w');g<-f$create_group('hg19')
g[['data']]<-mat@x;g[['indices']]<-mat@i;g[['indptr']]<-mat@p;g[['shape']]<-as.integer(dim(mat))
g[['barcodes']]<-cell_ids;g[['genes']]<-symbols;g[['gene_names']]<-symbols;f$close_all()
f<-H5File$new('/fixture/sample-A.h5','r');check<-sparseMatrix(i=f[['hg19/indices']][]+1L,p=f[['hg19/indptr']][],x=f[['hg19/data']][],dims=f[['hg19/shape']][])
stopifnot(identical(dim(mat),dim(check)),identical(mat@x,check@x),identical(mat@i,check@i),identical(mat@p,check@p));f$close_all()
dir.create('/fixture/reference',showWarnings=FALSE)
write.csv(data.frame(cell=cell_ids,original_cell=original_cells,label=labels),'/fixture/reference/truth.csv',row.names=FALSE)
write_json(list(cells=ncol(mat),genes=nrow(mat),count_conversion_equal=TRUE,label_counts=as.list(table(labels)),source='Tian et al. 2019, DOI 10.1038/s41592-019-0425-8; complete post-QC 10x three-cell-line experiment',criteria=list(all_cells_retained=TRUE,population_count=3,adjusted_rand_index_min=0.95,best_label_accuracy_min=0.95),limits='This evaluates population recovery, not all pipeline comparisons in the paper; modern Seurat differs from historical versions.'),'/fixture/reference/preregistered.json',auto_unbox=TRUE,pretty=TRUE)
cat('Prepared blinded input and separate reference:',nrow(mat),'genes;',ncol(mat),'cells\n')
