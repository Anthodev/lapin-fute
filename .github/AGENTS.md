# Bunny deployment

When changing `.github/workflows/deploy-bunny.yml`:

- Keep credentials in the `production` GitHub environment and reference them only through `secrets` or `vars`.
- Deploy only `var/config-site`; catalog source databases, `.env` files, and verification artifacts stay private.
- Upload immutable catalog files before `catalog/manifest.json`. A production upload runs to completion before a newer deployment starts.
- Keep the bilingual hosting and privacy copy in `packages/config-page/index.html` consistent with the CDN provider and the phone-only PRIM path.
