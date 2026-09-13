# Lapin Futé 1.0.0 release checklist

This checklist tracks GitHub issue [#9](https://github.com/Anthodev/lapin-fute/issues/9). A checked item must point to durable evidence. Emulator or fixture evidence must not be presented as physical-device or production proof.

## Prepared in the release branch

- [x] Set every package and the configuration page to version `1.0.0`.
- [x] Select `https://lapin-fute.b-cdn.net/` as the stable, static HTTPS configuration-site origin.
- [x] Build release PBWs with that exact origin and reject release tags that differ from the watch package version.
- [x] Package one PBW containing both `emery` and `gabbro`, plus `SHA256SUMS`, as GitHub release assets.
- [x] Refresh a real IDFM catalog for production releases; no fixture fallback is available.
- [x] Upload immutable catalog files before the manifest pointer.
- [x] Compare every built file with its served bytes and validate every current-revision catalog JSON against the manifest schema and revision.
- [x] Back up mutable hosted files before deployment and restore them automatically when upload, purge, or served-site verification fails.
- [x] Retain each pre-deployment rollback bundle for 30 days and provide a serialized manual rollback workflow.
- [x] Record current publication and license research in [`RELEASE_REQUIREMENTS_RESEARCH.md`](RELEASE_REQUIREMENTS_RESEARCH.md).

## Blocking evidence before publication

- [ ] Obtain written IDFM clarification for the contradictory next-departures license labels and for the generated catalog's derivative-database obligations. See [research gaps](RELEASE_REQUIREMENTS_RESEARCH.md#gaps-that-need-direct-confirmation).
- [ ] Update the bilingual data notice only after that clarification. Name and link every source and applicable license, include the source update date, and do not imply IDFM endorsement.
- [ ] Check the authenticated Rebble Developer Portal for currently enforced dimensions, formats, file-size limits, description limits, localization support, and review behavior.
- [ ] Prepare the required portal material: category, description, release notes, banner, large icon, small icon, and at least one unframed screenshot for each of `emery` and `gabbro`. The project additionally requires French and English captures.
- [ ] Verify that the portal accepts the single `1.0.0` PBW with both target platforms. Do not make the listing public during this check.
- [ ] Run the clean-install, six-favorite, edit, disconnect/recovery, key replace/revoke/remove, all-mode, and traffic journeys against production on both emulators and a Pebble Time 2.
- [ ] Run the frozen 24-hour physical A/B battery scenario on the release build with Pebble firmware 4.32 or newer.
- [ ] Attach the inherited issue #8 evidence and new production/physical evidence to issue #9, preserving its stated coverage limits.
- [ ] Scan the repository, PBW, static output, captured HTTP exchanges, screenshots, logs, metrics, traces, and submission material for credentials and `apikey` values.

## Deployment and rollback rehearsal

1. Merge the reviewed release branch without tagging it.
2. Run **Deploy configuration site to Bunny** manually with `refresh_catalog=true`.
3. Save the workflow run ID, catalog revision, source revision, file count, and verification result as issue #9 evidence.
4. Run **Roll back Bunny configuration site** with that deployment run ID. It restores and byte-verifies the retained pre-deployment mutable files; the prior manifest points back to the already verified immutable catalog revision.
5. Run **Deploy configuration site to Bunny** again with `refresh_catalog=true`, save its verification result, and re-run the production configuration journey.

The workflow also restores its pre-deployment mutable files automatically on a failed deployment. Immutable catalog revisions remain available so an already-open settings page does not lose its pinned data.

## Publication gate

Creating and pushing `v1.0.0` deploys the static site, builds the PBW, and creates the public GitHub release. Submitting through the Rebble Developer Portal is a separate public action.

Do neither until:

- every blocking item above has durable evidence;
- issue #9 contains links to the evidence and release material;
- the repository owner explicitly approves both the `v1.0.0` tag and the Rebble publication.
