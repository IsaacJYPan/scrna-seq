// Review flags for custom (agent- or person-written) R code.
//
// This is not a security boundary: custom code already runs in a no-network
// sandbox with read-only inputs, and nothing it writes is accepted until a
// person promotes it. The flags point the reviewer at the lines that most
// deserve a look: escapes the sandbox would block anyway (shell, network,
// installs), code built at run time, and scientific choices that change the
// result (dropping cells, unseeded randomness, overwritten metadata).

const RULES = [
  { id: 'shell', severity: 'high', label: 'Runs a shell command', pattern: /\b(system2?|shell|processx::run|pipe)\s*\(/ },
  { id: 'native-code', severity: 'high', label: 'Calls compiled code directly', pattern: /\.(Call|C|External|Fortran)\s*\(|\bRcpp::/ },
  { id: 'dynamic-code', severity: 'high', label: 'Builds and runs code at run time', pattern: /\beval\s*\(\s*(parse|str2lang|str2expression)\s*\(|\bsource\s*\(|\bsys\.source\s*\(/ },
  { id: 'network', severity: 'medium', label: 'Tries to reach the network (blocked in the sandbox)', pattern: /\b(download\.file|url|socketConnection|curl::|httr2?::|RCurl::|GET|POST)\s*\(/ },
  { id: 'install', severity: 'medium', label: 'Installs packages (not possible in the sandbox)', pattern: /\b(install\.packages|BiocManager::install|remotes::install_\w+|devtools::install_\w+)\s*\(/ },
  { id: 'file-deletion', severity: 'medium', label: 'Deletes or moves files', pattern: /\b(unlink|file\.remove|file\.rename)\s*\(/ },
  { id: 'environment', severity: 'low', label: 'Reads or changes environment settings', pattern: /\b(Sys\.setenv|Sys\.getenv|setwd|options)\s*\(/ },
  { id: 'direct-write', severity: 'low', label: 'Writes files without the output helpers', pattern: /\b(saveRDS|write\.csv|write\.table|writeLines|ggsave|png|pdf)\s*\(/ },
  { id: 'cell-filtering', severity: 'review', label: 'Removes cells or features (changes what later steps see)', pattern: /\bsubset\s*\(|\bobj\s*<-\s*obj\s*\[|\bobj\s*\[\s*,|\bWhichCells\s*\(/ },
  { id: 'metadata-overwrite', severity: 'review', label: 'Changes cell metadata or identities', pattern: /\bobj\s*\$\s*[\w.]+\s*<-|\bobj\s*\[\[\s*["'][^"']+["']\s*\]\]\s*<-|\bIdents\s*\(\s*obj\s*\)\s*<-|\bRenameIdents\s*\(/ },
];

const STOCHASTIC = /\b(RunUMAP|RunTSNE|FindClusters|RunPCA|sample|kmeans|runif|rnorm|IntegrateLayers|RunHarmony)\s*\(/;

function stripComment(line) {
  let inString = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === inString) inString = null;
    } else if (char === '"' || char === "'") {
      inString = char;
    } else if (char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

export function reviewFlags(source, { maxFlags = 40 } = {}) {
  if (typeof source !== 'string' || source === '') return [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const flags = [];
  let seeded = false;
  let firstStochastic = null;
  lines.forEach((raw, index) => {
    const line = stripComment(raw);
    if (!line.trim()) return;
    if (/\bset\.seed\s*\(/.test(line)) seeded = true;
    if (!seeded && firstStochastic === null && STOCHASTIC.test(line)) firstStochastic = index;
    for (const rule of RULES) {
      if (rule.pattern.test(line) && flags.length < maxFlags) {
        flags.push({ id: rule.id, severity: rule.severity, label: rule.label, line: index + 1, excerpt: raw.trim().slice(0, 160) });
      }
    }
  });
  if (firstStochastic !== null && flags.length < maxFlags) {
    flags.push({
      id: 'unseeded', severity: 'review', label: 'Random steps run before any set.seed(), so reruns can differ',
      line: firstStochastic + 1, excerpt: lines[firstStochastic].trim().slice(0, 160),
    });
  }
  const order = { high: 0, medium: 1, review: 2, low: 3 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
}

export function flagSummary(flags) {
  const counts = { high: 0, medium: 0, review: 0, low: 0 };
  for (const flag of flags || []) counts[flag.severity] = (counts[flag.severity] || 0) + 1;
  return counts;
}
