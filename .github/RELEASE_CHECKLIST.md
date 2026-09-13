# Lapin Futé 1.0.0 release checklist

This checklist tracks GitHub issue [#9](https://github.com/Anthodev/lapin-fute/issues/9). A checked item must point to durable evidence. Emulator or fixture evidence must not be presented as physical-device or production proof.

## Prepared in the release branch

- [x] Set every package and the configuration page to version `1.0.0`.
- [x] Select `https://lapin-fute.b-cdn.net/` as the stable, static HTTPS configuration-site origin.
- [x] Build release PBWs with that exact origin and reject release tags that differ from the watch package version.
- [x] Package one PBW containing both `emery` and `gabbro`, plus `SHA256SUMS`, as GitHub release assets.
- [x] Keep release tags page-only; manual real-IDFM refreshes compare `sourceRevision` with production and upload the catalog only when its inputs changed or an operator forces it.
- [x] Upload immutable catalog files before the manifest pointer.
- [x] Compare every built file with its served bytes and validate every current-revision catalog JSON against the manifest schema and revision.
- [x] Back up mutable hosted files before deployment and restore them automatically when upload, purge, or served-site verification fails.
- [x] Retain each pre-deployment rollback bundle for 30 days and provide a serialized manual rollback workflow.
- [x] Record current publication and license research in [`RELEASE_REQUIREMENTS_RESEARCH.md`](RELEASE_REQUIREMENTS_RESEARCH.md).

## Publication evidence

- [ ] Obtain written IDFM clarification for the contradictory next-departures license labels and for the generated catalog's derivative-database obligations. See [research gaps](RELEASE_REQUIREMENTS_RESEARCH.md#gaps-that-need-direct-confirmation).
- [ ] Update the bilingual data notice only after that clarification. Name and link every source and applicable license, include the source update date, and do not imply IDFM endorsement.
- [x] Confirm the authenticated RePebble portal accepts the submitted description, release notes, banner, icons, and platform-specific screenshots. The retained assets are in [`store-assets`](store-assets/).
- [ ] Add French store screenshots; the published listing currently uses the English emulator captures.
- [x] Verify that the portal accepts the single `1.0.0` PBW with both target platforms. The public [RePebble listing](https://apps.repebble.com/6d6aa01b7ecb4cfea469a183) identifies version `1.0.0` for Time 2 and Round 2.
- [ ] Run the clean-install, six-favorite, edit, disconnect/recovery, key replace/revoke/remove, all-mode, and traffic journeys against production on both emulators and a Pebble Time 2.
- [ ] Run the frozen 24-hour physical A/B battery scenario on the release build with Pebble firmware 4.32 or newer.
- [ ] Attach the inherited issue #8 evidence and new production/physical evidence to issue #9, preserving its stated coverage limits.
- [ ] Scan the repository, PBW, static output, captured HTTP exchanges, screenshots, logs, metrics, traces, and submission material for credentials and `apikey` values.

## Deployment and rollback rehearsal

1. Merge the reviewed release branch without tagging it.
2. Run **Deploy configuration site to Bunny** manually with `refresh_catalog=true`. If the source comparison reports no change, set `force_catalog_upload=true` for this one planned full-deployment rehearsal.
3. Save the workflow run ID, catalog revision, source revision, file count, and verification result as issue #9 evidence.
4. Run **Roll back Bunny configuration site** with that deployment run ID. It restores and byte-verifies the retained pre-deployment mutable files; the prior manifest points back to the already verified immutable catalog revision.
5. Run **Deploy configuration site to Bunny** again with `refresh_catalog=true`, save its verification result, and re-run the production configuration journey.

The workflow also restores its pre-deployment mutable files automatically on a failed deployment. Immutable catalog revisions remain available so an already-open settings page does not lose its pinned data.

## Publication gate

Creating and pushing `v1.0.0` deploys the configuration page without re-uploading the catalog, builds the PBW, and creates the public GitHub release. Submitting through the Rebble Developer Portal is a separate public action.

The repository owner approved publication, and version `1.0.0` is now public on [RePebble](https://apps.repebble.com/6d6aa01b7ecb4cfea469a183). The unchecked evidence above remains follow-up work and must not be represented as completed.

Pushing `v1.0.0` records the matching source release and runs the automated configuration-site deployment and GitHub release workflow.
