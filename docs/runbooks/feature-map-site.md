# Feature-map site

The feature map, the gardening list and the specs' status lines as one page
per ref (Spec 020). Generated; nothing in it is edited by hand.

- Site: https://unknowntpo.github.io/oss-knowledge-base/ (goes to `main/`;
  `versions.json` lists every ref)
- Workflow: `.github/workflows/feature-map-site.yml`
- Generator: `scripts/feature-map-site/` (`bun run docs:feature-map-site`)
- Host: GitHub Pages. No Cloudflare resource, token or spend.

## The one setting it depends on

GitHub Pages with **Source: GitHub Actions** (repository Settings → Pages →
Build and deployment). **Done on 2026-10-14**; nothing is left to do after
the merge. Check it without opening the settings:

```sh
gh api repos/unknowntpo/oss-knowledge-base/pages --jq '{build_type, html_url}'
```

`build_type` must be `workflow`. The `github-pages` environment accepts
deployments from `main` only; the workflow relies on that and deploys from
`main` alone.

## When it publishes

| Event | What runs |
| --- | --- |
| Push to `main` | build every ref (`main`, `release/*`, `v*`), deploy, then read the published `versions.json` until it names the built commit |
| Push to `release/**`, or of a tag `v*` | one job that starts the workflow on `main`; that run builds and deploys |
| Run by hand on `main` (Actions → Feature map site → Run workflow) | as a push to `main`: use it to republish |
| Pull request | build every ref plus the pull request's tree; artifact `feature-map-site-<sha>`; no deploy |

## Build it locally

```sh
bun run docs:feature-map-site -- --out /tmp/fm-site --preview my-branch
python3 -m http.server --directory /tmp/fm-site 8000   # the switcher needs http, not file://
```

`--preview <name>` adds the working tree as one more branch. Without a
server the page still opens from disk; only the switcher's list is missing.

## When a run fails

| Step | Meaning | Do |
| --- | --- | --- |
| Build every ref | `main`'s own page could not be generated (the message names the file), or `main` was not found | fix the source file; a broken tag or release branch does not fail the build, it gets a page with the reason |
| Require GitHub Pages with source GitHub Actions | Pages is off or builds from a branch | restore the setting above, then run the workflow by hand |
| Deploy | GitHub Pages refused or timed out | rerun the job |
| Check that the published site is the one this run built | the site still serves an older `versions.json` after a minute | open the site; rerun if it is still old |

A release or tag whose page is missing: look for the "Rebuild from the
default branch" job in the run of that push, then for the run it started on
`main`.

## Rollback

Revert the commit on `main`; the next run republishes every ref with the
previous generator. To take the site down, unpublish it in Settings → Pages
(the next run on `main` then fails at the gate, by design).
