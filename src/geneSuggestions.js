// Preserve backend gene order and spelling while stopping once the visible
// suggestions are filled. There is no need to scan or allocate all matches.
export function findGeneSuggestions(genes, input) {
  const prefix = input.toLowerCase();
  const suggestions = [];
  for (const gene of genes) {
    if (gene.toLowerCase().startsWith(prefix)) {
      suggestions.push(gene);
      if (suggestions.length === 8) break;
    }
  }
  return suggestions;
}
