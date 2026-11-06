// The readable view of R scripts: steps from section comments, and defensive
// code hidden without changing what the remaining code says.
import { describe, expect, it } from 'vitest';

const fs = require('fs');
const path = require('path');
const { readableSteps } = require('../shared/readableR.mjs');

describe('readableSteps', () => {
  it('splits on both section comment styles and names the leading code Setup', () => {
    const steps = readableSteps('library(Seurat)\n# ---- Normalize ----\nobj <- NormalizeData(obj)\n# Cluster ----\nobj <- FindClusters(obj)\n');
    expect(steps.map((s) => s.title)).toEqual(['Setup', 'Normalize', 'Cluster']);
    expect(steps[1]).toMatchObject({ number: 2, code: 'obj <- NormalizeData(obj)', readable: 'obj <- NormalizeData(obj)', hiddenLines: 0 });
  });

  it('hides checks, guard clauses, and wrappers but keeps the protected expression', () => {
    const [step] = readableSteps([
      'stopifnot(is.numeric(k))',
      'if (k < 1) stop("k must be positive")',
      'if (ncol(obj) < 10) {',
      '  warning("few cells")',
      '  return(NULL)',
      '}',
      'obj <- tryCatch({',
      '  FindClusters(obj, resolution = k)',
      '}, error = function(e) stop("failed: ", conditionMessage(e)))',
      'res <- suppressWarnings(as.numeric(x))',
      'm <- try(FindAllMarkers(obj), silent = TRUE)',
      'if (k > 2) obj <- RunUMAP(obj, dims = 1:k)',
    ].join('\n'));
    expect(step.readable).toBe([
      'obj <- FindClusters(obj, resolution = k)',
      'res <- as.numeric(x)',
      'm <- FindAllMarkers(obj)',
      'if (k > 2) obj <- RunUMAP(obj, dims = 1:k)',
    ].join('\n'));
    expect(step.hiddenLines).toBe(8);
  });

  it('inlines a multi-statement wrapped block and strips guards inside blocks', () => {
    const [step] = readableSteps([
      'suppressMessages({',
      '  a <- 1',
      '  stopifnot(a == 1)',
      '  b <- 2',
      '})',
      'for (g in genes) {',
      '  if (!g %in% rownames(obj)) stop("missing gene")',
      '  plot_gene(g)',
      '}',
    ].join('\n'));
    expect(step.readable).toBe('a <- 1\nb <- 2\nfor (g in genes) {\n  plot_gene(g)\n}');
  });

  it('is not fooled by keywords inside strings and comments', () => {
    const [step] = readableSteps('msg <- "tryCatch(stop()) # not code"\n# stop("comment")\nprint(msg)');
    expect(step.readable).toBe('msg <- "tryCatch(stop()) # not code"\n# stop("comment")\nprint(msg)');
  });

  it('keeps else branches and unbalanced code as written', () => {
    const code = 'if (x) stop("no") else y <- 1\nz <- f(';
    expect(readableSteps(code)[0].readable).toBe(code);
  });

  it('gives the pinned Seurat pipeline core a step outline', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'r-backend', 'lib', 'seuratPipelineCore.R'), 'utf8');
    const steps = readableSteps(source);
    expect(steps.map((s) => s.title)).toEqual(['Setup', 'Read parameters', 'Load counts', 'Quality control', 'Normalize',
      'PCA', 'Cluster', 'UMAP', 'Save checkpoint', 'Summarize']);
    const qc = steps.find((s) => s.title === 'Quality control');
    expect(qc.code).toContain('tryCatch');
    expect(qc.readable).not.toContain('tryCatch');
    expect(qc.readable).not.toContain('stop(');
    expect(qc.readable).toContain('obj <- subset(obj, cells = colnames(obj)[keep])');
  });
});
