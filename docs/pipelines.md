# Pipeline registry

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
data-only module contract. Approved workflows can render declared parameter
and result templates as a disabled, read-only preview; the preview never submits
parameters or starts work. Routes, React components, artifact types, and worker
job types remain application-controlled. Of the manifest modules currently
registered, the durable DEG and ranked pathway-enrichment modules declare executable
job types `deg.find_markers.v1` and `enrichment.gsea.v1`.

Definitions created by the older project/user upload path remain stored but are
quarantined: they are neither listed nor selectable as trusted definitions, and
an existing selection that references one safely falls back to the built-in
pipeline. Stored platform definitions are revalidated before being returned.

Manifest publication does not upload JavaScript, R code, R packages, endpoints,
or new module implementations, and it is not a generic execution engine. Future
BYOC arbitrary-R support would require isolated per-job containers or VMs,
strict input/output mounts, network and secret isolation, and resource quotas.
