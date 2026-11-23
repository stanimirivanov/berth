# Qualify Angular Material under static Pages CSP

Angular Material 22.3.0 passed the sampled history access flow on Berth's
loopback preview and in local Wrangler with Material animations disabled.
The tested set was an outlined form field with a password input and hint,
a filled submit button, and an indeterminate progress bar with a visible
loading message. Default Material motion triggered a CSP violation in
Chromium. Use the qualified configuration for the first migration slice.
Other Material components and browser engines need their own evidence.
If a control requires unsupported styles, keep the existing native control
or text status for that interaction.

The [qualification patch](angular-material-pages-csp/qualification.patch)
pins Material, CDK, and Forms at 22.3.0 alongside Berth's existing Angular
22.3.0. Apply it in a disposable checkout. The patch serves the actual
history route with synthetic read responses and does not enter the production
UI or its lockfile. This PR updates the production CSP extractor so it
recognizes the optimizer's literal component definitions inside zero-argument
declaration wrappers, which the original build rejected. The extractor walks
the syntax tree without evaluating the bundle and still rejects unsupported
metadata, encapsulation, or runtime CSS transformations.

## Production build measurements

Both builds used Node 24.22.3, pnpm 12.16.1 and the existing production AOT
configuration. The baseline was Berth main at `163d947`. The candidate uses
the checked-in patch and the updated extractor.

| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| Initial JavaScript | 365,390 bytes | 547,744 bytes |
| Linked stylesheet | 484 bytes | 8,456 bytes |
| Total initial assets | 365,874 bytes | 556,200 bytes |
| Angular estimated transfer | 104.03 kB | 136.37 kB |
| Build-time SHA-256 style hashes | 3 | 10 |
| CSP line in Pages `_headers` | 324 chars | 702 chars |

The candidate is 43,800 bytes below Berth's 600 kB initial bundle warning.
Cloudflare counts the whole CSP line, including indentation and header name,
against 2,000 characters. Wrangler 4.166.0 served the saved operation path
at HTTP 200 with the exact built shell and CSP. [Pages header limits](https://developers.cloudflare.com/pages/configuration/headers/#attach-a-header)

## Browser evidence

- Chromium loaded one same-origin linked stylesheet, which includes the Sass
  `mat.theme` output. The filled button computed to `rgb(0, 92, 187)`, and
  Angular injected nine unique nonempty style blocks observed across form,
  progress and detail. The browser test computes the hash of each block and
  checks it against the served policy. Angular can inject component styles
  at runtime even when the theme is served as a linked CSS file. [Angular security guide](https://angular.dev/best-practices/security#configure-styles-for-static-hosting)
- The saved detail link prompted for access and sent no read before token
  entry. Focus, password entry, pointer submit, the accessible hint, a
  visible 4 px progress bar and the retained detail worked in both servers.
  On successful access, the history read for the selected operation preceded
  the initial list fetch. No provider was contacted.
- With default motion, Chromium reported one `style-src-elem` violation
  before the negative control. CDK `MediaMatcher` appends an empty style
  element for its Blink/WebKit media-query workaround. The blocked element
  had no sheet. The sample captured pointer ripple and progress CSSOM
  property writes separately. [CDK MediaMatcher source](https://github.com/angular/components/blob/v22.3.0/src/cdk/layout/media-matcher.ts)
- Setting the public `MATERIAL_ANIMATIONS` token to
  `{ animationsDisabled: true }` avoids Material's animation-related
  `MediaMatcher` call in the tested controls. It removes their motion, and
  the loading message still communicates progress. No unsolicited CSP
  violations occurred. Form outline width and progress transforms still
  produced inline style attributes via CSSOM property writes. Both servers
  blocked the deliberately unapproved style element, and its CSS did not
  apply. Keep the generated hashes and linked CSS under the existing
  static policy. [Material animation source](https://github.com/angular/components/blob/v22.3.0/src/material/core/animation/animation.ts)

## Reproduce locally

Run from a checkout of this PR with the pinned toolchain and Playwright
Chromium installed. The following creates an isolated checkout next to the
repository and installs only lockfile-pinned packages with the existing
lifecycle-script settings.

```bash
source_repo=$(git rev-parse --show-toplevel)
fixture=$(mktemp -d "$(dirname "$source_repo")/berth-material-qualification.XXXXXX")
git worktree add --detach "$fixture" HEAD
cd "$fixture"
git apply "$source_repo/docs/research/angular-material-pages-csp/qualification.patch"
pnpm install --frozen-lockfile
pnpm --dir ui install --frozen-lockfile
pnpm build
pnpm build:ui
```

Start `node dist/scripts/history-server.js` from the fixture root. In
another terminal in the fixture, run:

```bash
pnpm --dir ui test --config material-qualification.config.ts
```

To verify Pages independently, start Wrangler from the fixture root and run
the same test against its local origin. It needs no cloud bindings.

```bash
cd ui
WRANGLER_SEND_METRICS=false pnpm --config.ignore-scripts=true dlx wrangler@4.166.0 \
  pages dev dist/history/browser --ip 127.0.0.1 --port 4218
```

```bash
BERTH_QUALIFICATION_ORIGIN=http://127.0.0.1:4218 \
  pnpm --dir ui test --config material-qualification.config.ts
```

For the default-motion comparison, remove the `MATERIAL_ANIMATIONS` import
and provider from the fixture's `ui/src/main.ts`, rebuild the UI, restart
the chosen server and repeat its test command with
`BERTH_QUALIFICATION_DEFAULT_MOTION=1`. That diagnostic run expects the
CDK violation as well as the deliberate negative control.

This qualifies the sampled components in local Chromium and local Pages
emulation. The follow-up migration must recheck its final component set
and the combined Infrastructure and history bundle before release.
