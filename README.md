# scRNA-seq Dashboard

The scRNA-seq Dashboard is a robust Electron + React desktop client paired with a containerized R Plumber backend, designed for seamless single-cell RNA sequencing data analysis and lineage tracking.

## Docker Orchestration for Collaborators

To easily share and run datasets locally without needing a complex R environment setup, you can use the provided Docker container for the backend.

### Mounting Local Datasets

If you have local datasets you want to analyze, you can map them directly into the Docker container using volume mounts in the `docker-compose.yml` file.

1. Open `docker-compose.yml` in the root directory.
2. Locate the `volumes` section under your service definition.
3. Add a new volume mapping pointing your local data folder to the container's data folder. 

Example:

```yaml
services:
  r-backend:
    build: ./r-backend
    ports:
      - "8000:8000"
    volumes:
      # Map your local "data" directory to "/app/data" inside the container
      - ./data:/app/data
      # You can add absolute paths as well if data is stored elsewhere:
      # - /Users/yourname/Documents/scRNA_datasets:/app/external_data
```

4. Run `docker-compose up -d` to start the backend with your local datasets accessible.

Now, any data placed in your local `./data` folder will be instantly available to the R Plumber backend at `/app/data`.
