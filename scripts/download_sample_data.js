const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATASET_URL = 'https://cf.10xgenomics.com/samples/cell/pbmc3k/pbmc3k_filtered_gene_bc_matrices.tar.gz';
const ARCHIVE_PATH = path.join(DATA_DIR, 'pbmc3k.tar.gz');
const EXTRACT_DIR = path.join(DATA_DIR, 'pbmc3k');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

console.log(`Downloading PBMC 3k dataset from ${DATASET_URL}...`);

const file = fs.createWriteStream(ARCHIVE_PATH);

https.get(DATASET_URL, (response) => {
  if (response.statusCode !== 200) {
    console.error(`Failed to download dataset. Status code: ${response.statusCode}`);
    process.exit(1);
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
      execSync(`tar -xf "${ARCHIVE_PATH}" -C "${EXTRACT_DIR}"`, { stdio: 'inherit' });
      console.log('Extraction complete! Sample dataset is ready.');
      console.log(`Location: ${EXTRACT_DIR}`);
      
      // Clean up archive
      fs.unlinkSync(ARCHIVE_PATH);
    } catch (err) {
      console.error('Failed to extract archive:', err.message);
    }
  });
}).on('error', (err) => {
  fs.unlink(ARCHIVE_PATH, () => {});
  console.error('Network error during download:', err.message);
});
