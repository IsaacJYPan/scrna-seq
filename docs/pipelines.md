# Pipelines

Open **Pipelines** to search the shared catalog, preview a definition, and choose
which analysis tools appear in your project. Browsing does not change the active
pipeline; **Use pipeline** applies the choice to your account in that project.
**Open pipeline** opens the selected workflow. Saved analyses are unaffected.

## Share executable R pipelines

A pipeline package contains a name, ID, version, R package profile, and script.
The packer adds no datasets or account configuration to the supplied source.
The script receives a saved Seurat analysis as `obj` and can write results with
`write_table`, `save_figure`, and `save_workspace`.

Start with the working example:

```bash
npm run pipeline:pack -- examples/pipelines/cell-summary.json examples/pipelines/cell-summary.R cell-summary.pipeline.json
```

Edit the metadata and R source in separate files, then pack them for sharing.
The command validates the package and refuses to overwrite an existing output.
Use a new `major.minor.patch` version when changing a published pipeline. The
example reports cell and feature counts and writes `cell-summary.csv`.

In the app:

1. Open **Pipelines → Import pipeline** and choose the `.pipeline.json` file.
2. Review the name, version, description, and optional source preview. Click
   **Install version**. Installation does not execute the script.
3. Select a saved analysis you own and click **Run**. Save pending live changes
   first. **View results** opens the existing Runs & Results view.
4. Use **Export** to share that exact version. **Remove** uninstalls it from
   this browser; existing jobs and results are unchanged.

Installed versions are stored in the browser for the signed-in account. They do
not sync across machines: export a copy before clearing browser storage. Multiple
versions may coexist, and importing different contents under the same ID/version
is rejected. The run source includes `id@version`; the backend records its SHA-256
before applying the existing source-retention policy.

Execution uses the existing `expert.r.v1` worker and isolated R sandbox. The
server checks the account capability, project role, input ownership, package
profile, and job limits. Once that private runtime and account access have been
configured, individual pipeline installations and runs do not need an operator
approval. See [sandbox setup](deployment.md#optional-expert-r-sandbox).

The current package format supports one R entry script, a matching installed R
profile, and the selected saved analysis. JavaScript modules, arbitrary package
installation, network access, and automatic dependency resolution are not
supported. The public demo permits package import/export but executes only its
built-in analyses. Executable packages are limited to 48 KiB, including a run
script of at most 32 KiB, and each browser account can install 20 versions.

## Pipelines with tabs and dependent steps

Use a workflow package for a pipeline with its own QC, normalization, PCA, or
other analysis tabs. Each step declares inputs, parameters, R source, and outputs;
the application supplies simple reusable forms and result viewers. Dependencies
control the sidebar locks and which results a rerun clears. Explicit saves retain
whole workflow snapshots. See [authoring and running workflow pipelines](workflow-pipelines.md)
for the package format and the working single-cell example.

## Share catalog definitions

**Export definition** downloads a `.definition.json` file describing a composition
of built-in tools. These files use the declarative registry format below; they
are not executable R packages. A platform publisher can register a definition
for everyone on the server. A catalog definition cannot load new code or grant
execution permissions.

## Built-in catalog administration

Pipeline manifests are global, declarative definitions for composing UI modules
that already ship with the application. Any project member may list approved
manifests and select one for their own user/project pair. Project roles do not
grant publication rights: only an account with the server-managed
`pipeline_registry.publish` platform capability may publish. Manifest publication
and platform-capability administration are deliberately outside the ordinary
researcher browser interface.

An operator grants, revokes, or inspects that capability outside the browser:

```bash
npm run platform-developer -- grant developer@example.com
npm run platform-developer -- status developer@example.com
npm run platform-developer -- revoke developer@example.com
```

Publication accepts at most 64 KiB of strictly validated JSON and the registry
is capped at 200 definitions. Backend and frontend consume the same
data-only module contract. Pipelines can render declared parameter
and result templates as a disabled, read-only preview; the preview never submits
parameters or starts work. Routes, React components, artifact types, and worker
job types remain application-controlled. Of the manifest modules currently
registered, the durable DEG and ranked pathway-enrichment modules declare executable
job types `deg.find_markers.v1` and `enrichment.gsea.v1`.

Definitions created by the older project/user upload path remain stored but are
quarantined: they are neither listed nor selectable as trusted definitions, and
an existing selection that references one safely falls back to the built-in
pipeline. Stored platform definitions are revalidated before being returned.

Manifest publication composes installed modules. Executable R packages and
workflow packages use the isolated runner described above and have separate
import formats and execution permissions.
