# Official release requirements research for issue #9

Checked on 2026-09-13. This note records requirements that can be supported by current first-party pages, published license texts, or the source of the current Rebble developer portal. It does not record a publication or deployment.

## Conclusions for the release checklist

1. Submit the PBW through the current [Rebble Developer Portal](https://dev-portal.rebble.io/), not the retired email-a-ZIP flow still described by an old help article. The live portal can create and directly publish a store entry.
2. A new watchapp submission needs a name, watchapp type, category, description, release notes, a PBW, a banner, large and small store icons, and screenshots for every platform in the PBW. Website and source URLs are optional. The current portal has explicit `emery` and `gabbro` support.
3. There is no single license that covers every IDFM source used by Lapin Futé. Current catalog metadata assigns Licence Mobilités, Licence Ouverte 2.0, and ODbL to different inputs. The two live APIs are also not presented consistently by PRIM. This is a release blocker for a definitive legal statement, not a detail to infer from issue #9.
4. The safest current attribution design is a visible "Data: Île-de-France Mobilités" credit associated with transport output, plus a linked data-and-licenses page that names every source, gives its update date, and links both the source and applicable license. This meets the explicit source-link shape of the licenses, but whether a settings-page notice is sufficiently "associated" with watch output is a legal interpretation that the official material does not settle.
5. Pebble's manual configuration guide requires a hosted page reachable from the Pebble mobile app and defines the close-response protocol. It does not mandate a hosting vendor, HTTPS, cache headers, an SLA, CORS policy, rollback mechanism, or privacy-policy URL. HTTPS, atomic catalog publishing, availability checks, and rollback are Lapin Futé release requirements rather than documented Pebble store requirements.

## 1. Current Pebble/Rebble publication channel

### Channel

The current channel is the [Rebble Developer Portal](https://dev-portal.rebble.io/). The portal says that a successful upload is live in the appstore, accepts new releases, and supports public or unlisted visibility. Its [first-party source repository](https://github.com/pebble-dev/rebble-dev-portal) describes it as "The developer portal for submitting apps to the store."

An older official [Rebble Help submission article](https://help.rebble.io/appstore-submission/) still directs authors through `rebble.io/submit`, creates a ZIP, and asks them to email it to `support@rebble.io`. That conflicts with the live developer portal. The portal is the current operational interface and its source was updated on 2026-04-05 at [commit `48e3cbd`](https://github.com/pebble-dev/rebble-dev-portal/commit/48e3cbd5d04aca23580caa0d98e8a70dbf55aaf0); the help article should not drive the release procedure.

The uploader needs a Rebble account. Rebble's current [Terms of Service](https://rebble.io/tos), effective 2025-11-17, require a human account holder, a valid email address, account security, lawful/non-infringing uploads, and the right to post all submitted content. Uploading through the portal expressly accepts those terms in the [portal form](https://github.com/pebble-dev/rebble-dev-portal/blob/48e3cbd5d04aca23580caa0d98e8a70dbf55aaf0/html/index.html#L1320-L1332).

### PBW and embedded metadata

The official [submission guide](https://developer.rebble.io/guides/appstore-publishing/preparing-a-submission/) says a listing needs at least one Pebble-SDK-generated `.pbw`; the UUID must not already belong to another app and the version must exceed all earlier releases. Its [appstore overview](https://developer.rebble.io/guides/appstore-publishing/) also says to use a unique valid UUID and a non-beta SDK.

The PBW carries app metadata built from `package.json`. The official [app metadata reference](https://developer.rebble.io/guides/tools-and-resources/app-metadata/) marks the UUID, package name, display name, version, SDK version, target platforms, watchapp settings, message keys, and resources as project metadata. It states:

- generate a valid unique UUID rather than editing one by hand;
- use a version in `major.minor.0` form;
- set `pebble.watchapp.watchface` to `false` for a watchapp;
- list each target in `pebble.targetPlatforms`;
- include `configurable` in `pebble.capabilities` when the app has a settings page.

For issue #9, this means the release PBW must itself report version `1.0.0`, the intended UUID, watchapp type, and both `emery` and `gabbro`. Store form text cannot repair incorrect PBW metadata.

### Store metadata and assets

The current portal is more useful than the legacy prose for the actual fields. Its [new-app form](https://github.com/pebble-dev/rebble-dev-portal/blob/48e3cbd5d04aca23580caa0d98e8a70dbf55aaf0/html/index.html#L1334-L1517) and [client-side validation](https://github.com/pebble-dev/rebble-dev-portal/blob/48e3cbd5d04aca23580caa0d98e8a70dbf55aaf0/html/res/js/devPortal.js#L1638-L1729) establish the following:

| Material | Current portal requirement |
| --- | --- |
| App name and type | Required; choose Watch App. |
| Category | Required for a watchapp. Choices currently shown are Daily, Tools & Utilities, Notifications, Remotes, Health & Fitness, and Games. |
| Description | Required. |
| Release notes | Required, including the first upload. |
| PBW | Required. |
| Screenshots | At least one for every supported platform. The portal supports up to five per platform and accepts PNG, JPG/JPEG, or GIF. |
| Appstore banner | Required for a watchapp. |
| Store icons | Large and small icons are both required for a watchapp. These are separate from the watch launcher's embedded menu icon. |
| Website and source URL | Optional. |
| Visibility | Public or unlisted. An unlisted app remains reachable by its store URL but is omitted from search and announcements. |
| Timeline permission | Only select it if the app uses timeline. |

The current portal's [platform table](https://github.com/pebble-dev/rebble-dev-portal/blob/48e3cbd5d04aca23580caa0d98e8a70dbf55aaf0/html/res/js/devPortal.js#L10-L64) gives native screenshot canvases of 200 × 228 for `emery` and 260 × 260 for `gabbro`, with at most five screenshots. Use unframed screenshots. The official [asset guide](https://developer.rebble.io/guides/appstore-publishing/appstore-assets/) says listing screenshots must not be placed in watch frames.

The portal provides downloadable example assets. The checked-in examples at the cited portal commit are 720 × 320 for the banner, 576 × 576 for the large icon, and 192 × 192 for the small icon. These are template dimensions, not documented server-side acceptance limits. Neither the live form nor the public guide states file-size limits, icon formats, or mandatory pixel dimensions, so the final files should be tested in the authenticated portal before release day.

The older [preparation guide](https://developer.rebble.io/guides/appstore-publishing/preparing-a-submission/) describes a 1,600-character description limit and platform-specific asset collections. The current portal exposes one description field and platform-specific screenshots, and its public client code does not enforce 1,600 characters. Treat 1,600 as a conservative copy limit, not a verified current portal constraint.

No current public portal field or official guide reviewed here requires:

- separate French and English listings or localized descriptions;
- a privacy-policy URL;
- a support email entered on the submission form;
- French and English screenshots.

Those remain worthwhile project release materials, but issue #9 should not label them as current Rebble submission requirements without confirmation from the authenticated portal or Rebble support.

## 2. IDFM/PRIM licenses and attribution

### Source-by-source licenses

The license must be taken from each current dataset/API record, not from PRIM's broad license summary.

| Lapin Futé source | Current official record | License shown on 2026-09-13 |
| --- | --- | --- |
| Scheduled GTFS | [`offre-horaires-tc-gtfs-idfm`](https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/offre-horaires-tc-gtfs-idfm) | Licence Mobilités, version dated 2021-02-03 |
| Real-time coverage perimeter | [`perimetre-des-donnees-tr-disponibles-plateforme-idfm`](https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/perimetre-des-donnees-tr-disponibles-plateforme-idfm) | Licence Mobilités |
| Stops | [`arrets`](https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets) | Licence Ouverte 2.0 (Etalab) |
| Stop zones | [`zones-d-arrets`](https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/zones-d-arrets) | Licence Ouverte 2.0 (Etalab) |
| Stop relations | [`relations`](https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/relations) | Licence Ouverte 2.0 (Etalab) |
| Lines | [`referentiel-des-lignes`](https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/referentiel-des-lignes) | ODbL, French version |
| Stop-to-line associations | [`arrets-lignes`](https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets-lignes) | ODbL, French version |
| Next departures | [PRIM unit stop-monitoring API](https://prim.iledefrance-mobilites.fr/apis/idfm-ivtr-requete_unitaire) | Internally inconsistent: the catalog header says Licence Mobilité, while "Conditions Générales ... et licence" says ODbL. |
| Traffic disruptions | [PRIM disruptions API](https://prim.iledefrance-mobilites.fr/en/apis/idfm-disruptions_bulk) | Licence Mobilité in the catalog and license section. |

PRIM's [license overview](https://prim.iledefrance-mobilites.fr/fr/licences) says reference/geographic data generally use Licence Ouverte, offer/accessibility/validation data generally use ODbL, and maps use CC BY-NC-ND 3.0 France. Those categories do not override the more specific records above. In particular, current GTFS metadata names Licence Mobilités, while the overview's broad "offer data" wording points toward ODbL.

The next-departures record has a direct contradiction on one official page. PRIM's older open-data [license page](https://data.iledefrance-mobilites.fr/pages/licences/) also says API output is ODbL, while the current PRIM catalog badge says Licence Mobilité. Obtain written clarification from `contact-prim@iledefrance-mobilites.fr` before publishing a definitive departure-data license statement. This research cannot honestly collapse the two labels into one.

### Exact notice and source-link obligations

**Licence Mobilités.** The dataset metadata links to the official [2021 Licence Mobilités PDF](https://cloud.fabmob.io/s/eYWWJBdM3fQiFNm). Articles 5.3 and 5.4 require:

- when publicly conveying a database or derivative database, include the license or its URI in the database and relevant documentation, and preserve copyright/database/license notices;
- when publicly using a Produced Work, attach a notice that makes viewers aware that its content came from the named database and is available under Licence Mobilités;
- hyperlink the database name to the source database URI and "Licence Mobilités" to the license URI. If hyperlinks are impossible, include the full plain-text URIs.

The license's exact model is: `Contient des informations de NOM DE LA BASE DE DONNEES INITIALE, présentement mises à disposition aux conditions de la « Licence Mobilités »`.

Articles 5.5 to 5.8 also impose share-alike and machine-readable access duties on a publicly used derivative database, including publication on the national access point in specified cases. A generated, searchable static catalog may be a derivative database rather than only a Produced Work. That classification needs legal review before publishing the catalog.

**ODbL 1.0.** Sections 4.2 and 4.3 of the official [Open Data Commons ODbL 1.0 text](https://opendatacommons.org/licenses/odbl/1-0/) require the license URI and preserved notices when publicly conveying the database. Public use of a Produced Work needs an associated notice naming and linking the database and linking "Open Database License" to the license. Its exact model is: `Contains information from DATABASE NAME, which is made available here under the Open Database License (ODbL).` Sections 4.4 and 4.6 add share-alike and machine-readable access duties for public derivative databases.

**Licence Ouverte 2.0.** The official [Etalab Licence Ouverte 2.0 PDF](https://www.etalab.gouv.fr/wp-content/uploads/2017/04/ETALAB-Licence-Ouverte-v2.0.pdf) requires attribution with the source, at least the licensor's name, and the reused information's last-update date. A source hyperlink may satisfy the source part. The notice must not imply official endorsement.

IDFM's own [open-data license page](https://data.iledefrance-mobilites.fr/pages/licences/) separately tells reusers to avoid changing the informational meaning and to state the source and last-update date. Apply that source-and-date rule to all IDFM notices, even where the underlying database license's model sentence does not mention a date.

### Release-ready attribution structure

The official texts require source-specific links. A generic footer such as "Powered by PRIM" is not enough. A compliant candidate should contain, in French and English where the product presents both languages:

> Données : Île-de-France Mobilités. Sources et dates de mise à jour. Licences : Licence Mobilités, Licence Ouverte 2.0 et ODbL 1.0.

Each source name on the linked page should point to its official dataset/API record, show the source's last update used in the published build, and link its license name to the applicable full text. For live results, name the next-departures and disruptions APIs separately because their current license labels differ.

This wording is a synthesis, not text endorsed by IDFM. Keep each license's model sentence on the full data-and-licenses page. Do not say or visually imply that IDFM endorses Lapin Futé.

## 3. Static HTTPS configuration hosting

Pebble's official [manual configuration guide](https://developer.rebble.io/guides/user-interfaces/app-configuration-static/) provides the requirements that matter to a hosted page:

- put `configurable` in the app's `package.json` capabilities;
- handle PebbleKit JS `showConfiguration` and call `Pebble.openURL()` with the hosted page URL;
- host the HTML online so the Pebble mobile app can reach it;
- on Save, navigate to the supplied `return_to` query parameter, falling back to `pebblejs://close#`, and append `encodeURIComponent(JSON.stringify(options))`;
- handle `webviewclosed` in PebbleKit JS and decode the response.

The guide recommends Clay for an offline/local page but explicitly permits self-hosting and names GitHub Pages as one possible static host. It does not say HTTPS is mandatory and even shows an `http://` example. Given issue #9's explicit HTTPS requirement, use only an HTTPS URL and HTTPS subresources.

If GitHub Pages is selected, GitHub's official [Pages overview](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) confirms that it publishes static HTML, CSS, and JavaScript from a repository. GitHub's [HTTPS documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https) says correctly configured Pages and custom-domain sites support HTTPS enforcement, warns that Pages sites are public even when their source repository may be private, warns against sensitive transactions, and requires HTTPS subresources to avoid mixed-content failures.

That warning matters here. A static host necessarily receives ordinary web request data such as IP addresses, and GitHub says Pages logs visitor IP addresses for security. It must never receive or embed the PRIM key. The page can store and hand the key to phone-local PebbleKit JS, but no request, URL, static file, analytics script, or host log should contain it.

No official Pebble/Rebble source reviewed here specifies CORS headers, CSP, cache policy, service workers, redirects, custom domains, TLS versions, availability targets, schema consistency, atomic publication, or rollback. Choose and test those controls as Lapin Futé operational requirements. In particular:

- keep page and catalog JSON on one HTTPS origin unless cross-origin behavior is tested in both mobile platforms;
- publish one complete immutable revision before moving the stable entry point;
- verify every referenced file and its declared schema/revision after deployment;
- retain a previous complete revision and rehearse switching the stable entry point back;
- test the actual `Pebble.openURL()` and close-response flow on supported iOS and Android companion apps, not only in a desktop browser.

The last five items are engineering recommendations derived from issue #9's release goals. They are not claims about Pebble store policy.

## Gaps that need direct confirmation

- Ask IDFM which license governs `idfm-ivtr-requete_unitaire` now and whether Lapin Futé's generated static catalog is a derivative database under Licence Mobilités.
- Confirm with IDFM where the full Produced Work notice may live for a watch UI with no hyperlinks.
- Check the authenticated Rebble portal for server-side image dimensions, file-size limits, accepted icon formats, description length, localization support, and any review delay. These are not fully documented publicly.
- Confirm whether the single PBW produced by the current SDK is accepted with both `emery` and `gabbro`; the current portal recognizes both platforms, but no submission was attempted during this research.
- Test hosted configuration on the actual companion apps and a physical watch. The official guide documents the protocol, not present-day WebView compatibility.
