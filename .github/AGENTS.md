# Bunny deployment

When changing `.github/workflows/deploy-bunny.yml`:

- Keep credentials in the `production` GitHub environment and reference them only through `secrets` or `vars`.
- Deploy only `var/config-site`; catalog source databases, `.env` files, and verification artifacts stay private.
- A `vX.Y.Z` tag is the only automatic production deployment trigger. After quality gates and Bunny deployment succeed, publish a GitHub Release with generated notes. Merges and branch pushes must not deploy.
- A `pre-vX-Y.Z` tag (for example, `pre-v1-2.3`) runs the release quality gates but must not use the production environment or deploy anywhere. It reserves the preview release channel for a separate Bunny infrastructure.
- Rebuild and publish the catalog only through a manual dispatch with `refresh_catalog` enabled.
- Upload immutable catalog files concurrently before `catalog/manifest.json`. Keep concurrency below Bunny's documented per-IP HTTP limit. A production upload runs to completion before a newer deployment starts.
- Keep the bilingual hosting and privacy copy in `packages/config-page/index.html` consistent with the CDN provider and the phone-only PRIM path.
