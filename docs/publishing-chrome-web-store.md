# Publishing to the Chrome Web Store

The extension is built and published by the GitHub Actions workflow
[`.github/workflows/publish-chrome.yml`](../.github/workflows/publish-chrome.yml).
It installs deps, typechecks, runs the unit tests, builds + zips the MV3 extension
(`wxt zip`), uploads the zip as a workflow artifact, then uploads it to the Chrome
Web Store as a **new draft version** via WXT's `wxt submit` (`--chrome-skip-submit-review`,
which wraps [`publish-extension`](https://www.npmjs.com/package/publish-browser-extension)
against the Chrome Web Store API). The draft is **not** submitted for review or
published automatically — you do that from the Chrome Web Store dashboard.

## When it runs

| Trigger | Behavior |
|---|---|
| Push a tag `v*` (e.g. `v0.2.0`) | Build + verify + **upload a new draft** (not submitted for review — you publish it from the dashboard). |
| Manual run from the **Actions** tab | Build + verify, then a **dry run** by default (verifies auth + zips, no upload). Untick **dry_run** to upload the draft. |

If the Chrome Web Store secrets (below) aren't set, the upload step is **skipped
with a warning** and the build still succeeds — so the workflow doubles as a plain
build/CI pipeline until the store is wired up. The built `.zip` is always available
as the **`chrome-mv3-zip`** artifact on the run.

> **Bump the version before each release.** The Chrome Web Store refuses to
> re-upload an existing version. WXT derives the manifest version from
> `packages/extension/package.json` → `"version"`, so bump it (and tag to match,
> e.g. `v0.2.0`) before releasing.

## Required GitHub secrets

Add these under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | What it is |
|---|---|
| `CHROME_EXTENSION_ID` | The item's ID from the Chrome Web Store developer dashboard. |
| `CHROME_CLIENT_ID` | Google Cloud OAuth client ID. |
| `CHROME_CLIENT_SECRET` | Google Cloud OAuth client secret. |
| `CHROME_REFRESH_TOKEN` | OAuth refresh token for the Chrome Web Store API. |

## Getting the credentials (one-time)

1. **Create the store item.** In the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole),
   create the extension item once by uploading an initial build manually — the API
   only *updates* an existing item, so it needs the ID. Copy the **Item ID** →
   `CHROME_EXTENSION_ID`. (For Hexagon's enterprise rollout this item is **unlisted**
   and force-installed via `ExtensionInstallForcelist`; that's a dashboard visibility
   setting, not a workflow change.)

2. **Enable the API.** In the [Google Cloud console](https://console.cloud.google.com/),
   create (or pick) a project and enable the **Chrome Web Store API**.

3. **Create an OAuth client.** Configure the OAuth consent screen (External; add
   yourself as a test user), then create an **OAuth client ID** of type **Desktop app**.
   Copy the client ID/secret → `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET`.

4. **Get a refresh token.** The easiest way is WXT's interactive helper, run locally:

   ```bash
   cd packages/extension
   npx wxt submit init
   ```

   It walks you through authorizing and prints `CHROME_EXTENSION_ID`,
   `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, and `CHROME_REFRESH_TOKEN`. Copy the
   refresh token → `CHROME_REFRESH_TOKEN`. (`wxt submit init` writes a local
   `.env.submit` — **do not commit it**; copy the values into GitHub secrets instead.)

   See the [WXT publishing docs](https://wxt.dev/guide/essentials/publishing.html)
   for the full walkthrough.

## Releasing

```bash
# 1. bump the version (becomes the manifest version); --no-git-tag-version just
#    edits package.json so we control the commit + tag explicitly below
npm version --workspace=@page-capture/extension --no-git-tag-version patch   # or minor/major

# 2. commit, then tag to match and push
git commit -am "release: extension vX.Y.Z"
git tag vX.Y.Z
git push --follow-tags
```

The tag push triggers the workflow, which uploads a new draft. Then open the Chrome
Web Store dashboard and click **Submit for review** when you're ready to publish it.
To rehearse without uploading, run the workflow manually from the Actions tab with
**dry_run** left on.

## Notes

- **Dry run still needs valid secrets** — it authenticates against the API (just
  doesn't upload). Use it to confirm the credentials work.
- A real run uploads a **draft only** (`--chrome-skip-submit-review`) — the new
  version sits in the dashboard and nothing goes live until you click **Submit for
  review** there (unlisted/enterprise items still pass review before going live).
- To make the workflow auto-submit for review on a real run instead, remove
  `--chrome-skip-submit-review` from the `wxt submit` call in the workflow.
