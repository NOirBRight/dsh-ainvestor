# Alpha.1 fixture provenance

This directory contains the clean official alpha.1 package tarballs plus the exact 68-package recursive runtime/dev fixture closure resolved from the public npm registry. The source checkout and registry metadata are recorded in [PROVENANCE.json](./PROVENANCE.json). All 87 tarballs are test-only inputs for the isolated offline pack gate and are not package dependencies or shipped plugin files.

## Regenerate

1. Obtain a clean checkout of `https://github.com/deepseek-ai/deepseek-harness.git` at tag `dsh-v0.1.2-alpha.1` and verify commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`.
2. Run the checkout’s pinned install and official build procedure; do not edit package manifests or create source declarations.
3. Run `pnpm pack --pack-destination <directory>` for each official alpha.1 package named in `PROVENANCE.json` and copy only those official tarballs here.
4. Resolve the repository lockfile recursively on the recorded `linux-x64` registry fixture platform from `https://registry.npmjs.org/`, then download only the exact registry package/version tarballs named by the resulting dependency edges. Preserve package roots such as `package/`, `chai/`, `deep-eql/`, `estree/`, and `node v22.20/` exactly as downloaded.
5. Recompute every tarball’s byte size, SHA-256, root path, package/version record, and versioned dependency edge; update `PROVENANCE.json`, and run `pnpm run pack:check`. The gate creates a fresh temporary scoped pnpm consumer with an invalid registry and isolated store/cache, then removes it safely.

The official `@standard-schema/spec@1.1.0` and registry `vitest@4.1.11` tarballs declare unused source targets that are not shipped; the official DSH alpha.1 packages declare unused `./src/*` source wildcards. Every such gap is recorded explicitly in `PROVENANCE.json`. The pack gate rejects every other missing public export target and rejects any missing target that the plugin or closure imports.
