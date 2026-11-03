"""Author a small, deterministic public illustration; no scientific run is claimed."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import platform
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from PIL import Image, __version__ as pillow_version


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "public" / "examples" / "qc-retention" / "v1"
ROWS = (("Sample A", 1000, 850), ("Sample B", 1200, 900), ("Sample C", 800, 720))
FONT_SHA256 = "3fdf69cabf06049ea70a00b5919340e2ce1e6d02b0cc3c4b44fb6801bd1e0d22"
EXPECTED_ASSETS = {
    "counts.csv": (87, "9a99e0f8ad73055902fcb3ef9c75d46cf51a70cde206ee6b17488b4bd61e8285"),
    "table.json": (215, "165e08989a9718386abb179b48e1496bd001c32be0a7d407cba658010dfbdd89"),
    "figure.png": (44517, "be4e96cc6f4b422c9d2650d0fdc1a2293c913df6ccde8325ed9c3316801d0fd6"),
    "manifest.json": (1967, "b4eebe8ce2ebcb266891206a9a2db5777cedc7724f798994434cab7dc1b6d1da"),
}


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def descriptor(finding_id: str, family: str, source_sha: str, payload: bytes) -> dict:
    return {
        "schema": "traceomics.public-example-view.v1",
        "exampleId": "qc-retention",
        "version": 1,
        "findingId": finding_id,
        "family": family,
        "sourceSha256": source_sha,
        "representation": "fixed-table" if family == "table" else "png-raster",
        "spec": {"offset": 0, "limit": 3} if family == "table" else None,
        "blobSha256": sha256(payload),
        "blobBytes": len(payload),
        "width": None if family == "table" else 960,
        "height": None if family == "table" else 600,
    }


def create_png() -> bytes:
    # Pin the plotting/font dependencies for exact regenerated raster bytes.
    if matplotlib.__version__ != "3.11.2" or pillow_version != "12.0.0":
        raise RuntimeError("Regeneration requires Matplotlib3.11.2 and Pillow12.0.0; do not silently replace v1 bytes.")
    font_file = Path(font_manager.findfont("DejaVu Sans"))
    if sha256(font_file.read_bytes()) != FONT_SHA256:
        raise RuntimeError("The reviewed DejaVu Sans font differs; retain the existing v1 asset.")
    style = {
        "font.family": "DejaVu Sans", "font.size": 11, "text.color": "#172b4d",
        "axes.labelcolor": "#334155", "xtick.color": "#334155", "ytick.color": "#475569",
        "figure.facecolor": "white", "savefig.facecolor": "white", "hatch.linewidth": 0.7,
    }
    with plt.rc_context(style):
        figure = plt.figure(figsize=(9.6, 6), dpi=100)
        axes = figure.add_axes((0.12, 0.19, 0.84, 0.60))
        positions = [0, 1, 2]
        inputs = axes.bar([position - 0.19 for position in positions], [row[1] for row in ROWS],
                          width=0.32, label="Input", color="#cbd5e1", edgecolor="#64748b", hatch="//", linewidth=0.8)
        retained = axes.bar([position + 0.19 for position in positions], [row[2] for row in ROWS],
                            width=0.32, label="Retained", color="#0f766e", edgecolor="#115e59", linewidth=0.8)
        axes.bar_label(inputs, labels=[f"{row[1]:,}" for row in ROWS], padding=6, fontsize=12, color="#334155")
        axes.bar_label(retained, labels=[f"{row[2]:,}" for row in ROWS], padding=6, fontsize=12, color="#134e4a")
        axes.set_xticks(positions, [row[0] for row in ROWS], fontsize=12)
        axes.set_ylabel("Cells (invented counts)", labelpad=12)
        axes.set_ylim(0, 1400)
        axes.set_yticks(range(0, 1401, 200))
        axes.set_axisbelow(True)
        axes.yaxis.grid(True, color="#e2e8f0", linewidth=0.8)
        axes.tick_params(axis="both", length=0, pad=9)
        for side in ("top", "right", "left"):
            axes.spines[side].set_visible(False)
        axes.spines["bottom"].set_color("#cbd5e1")
        axes.legend(frameon=False, loc="lower center", bbox_to_anchor=(0.5, 1.025), ncol=2, fontsize=11, handleheight=1.3)
        figure.text(0.12, 0.945, "Synthetic QC retention", fontsize=21, fontweight="bold", color="#172b4d")
        figure.text(0.12, 0.895, "Invented counts for a saved-result illustration", fontsize=12, color="#475569")
        figure.text(0.12, 0.075, "Authored illustration  |  CC0-1.0  |  No cell-level filtering was run", fontsize=10, color="#475569")
        output = io.BytesIO()
        figure.savefig(output, format="png", dpi=100, metadata={"Software": "TraceOmics public illustration"},
                        pil_kwargs={"compress_level": 9, "optimize": False})
        plt.close(figure)
        result = output.getvalue()
    with Image.open(io.BytesIO(result)) as image:
        image.verify()
    return result


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    counts = ("sample,input_cells,retained_cells\n" + "".join(f"{sample},{inputs},{retained}\n" for sample, inputs, retained in ROWS)).encode("utf-8")
    table = canonical({
        "family": "table", "columns": ["Sample", "Input cells", "Retained cells"], "rows": [list(row) for row in ROWS],
        "offset": 0, "limit": 3, "hasMore": False, "scannedRows": 3, "truncated": False,
    })
    png = create_png()
    source_sha = sha256(counts)
    preimages = {
        "retention-table": descriptor("retention-table", "table", source_sha, table),
        "retention-figure": descriptor("retention-figure", "image", source_sha, png),
    }
    payloads = {"counts.csv": counts, "table.json": table, "figure.png": png}
    media_types = {"counts.csv": "text/csv", "table.json": "application/json", "figure.png": "image/png"}
    asset = lambda name: {"file": name, "mediaType": media_types[name], "bytes": len(payloads[name]), "sha256": sha256(payloads[name])}
    manifest = {
        "schema": "traceomics.public-saved-example.v1", "id": "qc-retention", "version": 1, "visibility": "public",
        "title": "Synthetic QC retention", "question": "How many cells are retained in each of three illustrative samples?",
        "provenance": {
            "kind": "authored-illustration", "synthetic": True, "license": "CC0-1.0",
            "notice": "These invented counts and this authored chart are a public illustration. No patient data, measured dataset or app-produced scientific run is represented.",
        },
        "method": {
            "label": "Illustrative input and retained cell counts",
            "description": "The table and paired bars present the same six authored counts. Retained counts are no greater than input counts. No cell-level filtering, statistical analysis or biological interpretation was performed.",
        },
        "limitations": "This saved example demonstrates inspection and byte verification only. It does not establish a QC threshold, reproduce an analysis or demonstrate scientific validity.",
        "source": asset("counts.csv"),
        "findings": [
            {"id": "retention-table", "family": "table", "caption": "Authored input and retained counts for three invented samples.",
             "sourceSha256": source_sha, "asset": asset("table.json"), "viewSha256": sha256(canonical(preimages["retention-table"]))},
            {"id": "retention-figure", "family": "image", "caption": "Paired bars display the same input and retained counts as the table.",
             "sourceSha256": source_sha, "asset": asset("figure.png"), "width": 960, "height": 600,
             "viewSha256": sha256(canonical(preimages["retention-figure"]))},
        ],
    }
    manifest_bytes = canonical(manifest)
    payloads["manifest.json"] = manifest_bytes
    # Public v1 is immutable. A different renderer or intentional content change
    # must never silently replace already distributed versioned bytes.
    for name, content in payloads.items():
        assert (len(content), sha256(content)) == EXPECTED_ASSETS[name], f"Frozen v1 asset differs: {name}"
    for name, content in payloads.items():
        (ASSETS / name).write_bytes(content)

    parsed_rows = list(csv.reader(io.StringIO(counts.decode("utf-8"))))
    assert parsed_rows == [["sample", "input_cells", "retained_cells"], *[[sample, str(inputs), str(retained)] for sample, inputs, retained in ROWS]]
    assert all(0 <= retained <= inputs for _, inputs, retained in ROWS)
    assert b"\r" not in counts and not counts.startswith(b"\xef\xbb\xbf") and counts.endswith(b"\n")
    assert json.loads(table)["rows"] == [list(row) for row in ROWS]
    with Image.open(io.BytesIO(png)) as image:
        assert image.size == (960, 600) and set(image.info) == {"Software", "dpi"} and not image.getexif()
    assert len(manifest_bytes) <= 16 * 1024 and len(counts) <= 4 * 1024 and len(table) <= 16 * 1024 and len(png) <= 256 * 1024
    for finding in manifest["findings"]:
        assert finding["sourceSha256"] == source_sha and finding["viewSha256"] == sha256(canonical(preimages[finding["id"]]))
        assert finding["asset"]["sha256"] == sha256(payloads[finding["asset"]["file"]])
    print(json.dumps({"python": platform.python_version(), "matplotlib": matplotlib.__version__, "pillow": pillow_version,
                      "fontSha256": FONT_SHA256,
                      "assets": [{"file": name, "bytes": len(content), "sha256": sha256(content)} for name, content in payloads.items()],
                      "viewPreimages": preimages, "viewSha256": {name: sha256(canonical(value)) for name, value in preimages.items()},
                      "synthetic": True, "appProducedRun": False, "allAssertionsPassed": True}, indent=2))


if __name__ == "__main__":
    main()
