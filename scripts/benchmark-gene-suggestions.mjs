import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { findGeneSuggestions } from '../src/geneSuggestions.js';

// A deterministic synthetic 30k-feature list. Common families are interleaved
// so the measurement includes both early matches and full-list searches.
const families = ['AC', 'RPL', 'ENSG', 'HLA', 'RPS', 'MT', 'LINC', 'CD', 'SLC', 'LOC'];
const genes = Array.from({ length: 30000 }, (_, index) => `${families[index % families.length]}${index}`);
genes[29999] = 'MS4A1';
const inputs = ['CD', 'rpl', 'HLA', 'AC1', 'MS4', 'missing'];
const iterations = 500;
const previousSuggestions = (values, input) => values
  .filter(gene => gene.toLowerCase().startsWith(input.toLowerCase())).slice(0, 8);

function work(search, input) {
  let checks = 0;
  const values = genes.map(gene => ({ toLowerCase() { checks += 1; return gene.toLowerCase(); } }));
  search(values, input);
  return checks;
}

function medianTime(search, input) {
  for (let warmup = 0; warmup < 50; warmup += 1) search(genes, input);
  const samples = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) search(genes, input);
    samples.push((performance.now() - started) / iterations);
  }
  return samples.sort((a, b) => a - b)[2];
}

const rows = inputs.map(input => {
  assert.deepEqual(findGeneSuggestions(genes, input), previousSuggestions(genes, input));
  const beforeChecks = work(previousSuggestions, input);
  const afterChecks = work(findGeneSuggestions, input);
  assert.ok(afterChecks <= beforeChecks);
  return {
    prefix: input,
    matches: findGeneSuggestions(genes, input).length,
    beforeChecks,
    afterChecks,
    beforeMsPerSearch: Number(medianTime(previousSuggestions, input).toFixed(4)),
    afterMsPerSearch: Number(medianTime(findGeneSuggestions, input).toFixed(4)),
  };
});
console.log(JSON.stringify({ node: process.version, geneCount: genes.length, iterationsPerSample: iterations,
  timing: 'Median of 5 warmed samples; synthetic local measurements, not analysis runtime.', rows }, null, 2));
