/**
 * Reduce a bunko report to the handful of numbers the README cites, so the
 * claims about image size and dependency closure are checkable rather than
 * remembered. Run through `bun run build:report`.
 */
import { readFile, rm, writeFile } from "node:fs/promises";

const raw = JSON.parse(await readFile(".oci-report.json", "utf8"));
const image = raw.images?.[0] ?? {};
const layers: { kind?: string; descriptor?: { size?: number } }[] = raw.layers ?? [];
const appBytes = layers
  .filter((layer) => layer.kind === "app")
  .reduce((total, layer) => total + (layer.descriptor?.size ?? 0), 0);

// Layer totals come from the exported OCI layout itself, not from a field in
// the report: the layout is the artefact that would be pushed.
const index = JSON.parse(await readFile(".oci/index.json", "utf8"));
const indexDigest = index.manifests?.[0]?.digest?.replace("sha256:", "");
const indexBody = JSON.parse(await readFile(`.oci/blobs/sha256/${indexDigest}`, "utf8"));
const manifestDigest = (indexBody.manifests?.[0]?.digest ?? indexBody.layers ? indexBody : null)
  ? (indexBody.manifests?.[0]?.digest ?? "").replace("sha256:", "")
  : "";
const manifest = manifestDigest
  ? JSON.parse(await readFile(`.oci/blobs/sha256/${manifestDigest}`, "utf8"))
  : indexBody;
const manifestLayers: { size?: number }[] = manifest.layers ?? [];
const totalBytes = manifestLayers.reduce((total, layer) => total + (layer.size ?? 0), 0);

const summary = {
  source: {
    // bunko's own hash of the sources it built. Deliberately the only
    // provenance recorded: a git revision here would always name the commit
    // *before* the one shipping the report, because the report is generated
    // from the working tree and then committed with it. That is a reference a
    // reader cannot resolve, and for the first commit it resolves to nothing
    // at all. This digest identifies the input without that problem.
    digest: raw.sourceDigest ?? null,
  },
  generatedBy: `bunko ${raw.builder?.version ?? "unknown"}`,
  builderMode: raw.builder?.kind ?? null,
  platform: image.platform ?? null,
  base: raw.baseDigest ?? null,
  imageDigest: raw.manifest?.digest ?? null,
  layers: {
    total: manifestLayers.length,
    totalBytesCompressed: totalBytes,
    appLayerBytesCompressed: appBytes,
    baseBytesCompressed: totalBytes - appBytes,
  },
  dependencyClosure: image.closure ?? null,
  bundledPackages: image.bundledInventory ?? [],
};

await writeFile("docs/build-report.json", `${JSON.stringify(summary, null, 2)}\n`);
await rm(".oci-report.json", { force: true });
console.log(JSON.stringify(summary, null, 2));
