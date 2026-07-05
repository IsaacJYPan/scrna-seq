const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATASET_URL = 'https://cf.10xgenomics.com/samples/cell/pbmc3k/pbmc3k_filtered_gene_bc_matrices.tar.gz';
const ARCHIVE_PATH = path.join(DATA_DIR, 'pbmc3k.tar.gz');
const EXTRACT_DIR = path.join(DATA_DIR, 'pbmc3k');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fail(message, err) {
  if (err && err.message) {
    console.error(`${message}: ${err.message}`);
  } else {
    console.error(message);
  }
  process.exit(1);
}

console.log(`Downloading PBMC 3k dataset from ${DATASET_URL}...`);

const file = fs.createWriteStream(ARCHIVE_PATH);

https.get(DATASET_URL, (response) => {
  if (response.statusCode !== 200) {
    response.resume();
    fail(`Failed to download dataset. Status code: ${response.statusCode}`);
  }

  response.pipe(file);

  file.on('finish', () => {
    file.close();
    console.log('Download complete. Extracting archive...');
    
    if (!fs.existsSync(EXTRACT_DIR)) {
      fs.mkdirSync(EXTRACT_DIR, { recursive: true });
    }

    try {
      // Use standard tar command available on Windows 10+
      execFileSync('tar', ['-xf', ARCHIVE_PATH, '-C', EXTRACT_DIR], { stdio: 'inherit' });
      console.log('Extraction complete! Sample dataset is ready.');
      console.log(`Location: ${EXTRACT_DIR}`);
      
      // Clean up archive
      fs.unlinkSync(ARCHIVE_PATH);
    } catch (err) {
      fail('Failed to extract archive', err);
    }
  });
}).on('error', (err) => {
  fs.unlink(ARCHIVE_PATH, () => {});
  fail('Network error during download', err);
});

file.on('error', (err) => {
  fs.unlink(ARCHIVE_PATH, () => {});
  fail('File error during download', err);
});
