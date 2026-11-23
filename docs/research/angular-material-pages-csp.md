# Qualify Angular Material under static Pages CSP

Berth uses Angular Material 22.3.0 for history access. The production build
passed on loopback preview and local Wrangler with Material animations disabled.
The tested set was an outlined form field with a password input and hint,
a filled submit button, and an indeterminate progress bar with a visible
loading message. Default Material motion triggered a CSP violation in
Chromium.
Other Material components and browser engines need their own evidence.
If a control requires unsupported styles, keep the existing native control
or text status for that interaction.

The UI lockfile pins Material, CDK, and Forms at 22.3.0 alongside Angular.
The Sass theme compiles into the linked stylesheet. The production CSP
extractor recognizes literal component definitions inside the optimizer's
zero-argument declaration wrappers. It walks the syntax tree without
evaluating the bundle and rejects unsupported metadata, encapsulation, or
runtime CSS transformations.

## Production build measurements

Both builds used Node 24.22.3, pnpm 12.16.1 and the existing production AOT
configuration. The baseline was Berth main at `163d947`. The Material build uses
the checked-in UI and the updated extractor.

| Measure | Baseline | Material access |
| --- | ---: | ---: |
| Initial JavaScript | 365,390 bytes | 547,719 bytes |
| Linked stylesheet | 484 bytes | 8,456 bytes |
| Total initial assets | 365,874 bytes | 556,175 bytes |
| Angular estimated transfer | 104.03 kB | 136.42 kB |
| Build-time SHA-256 style hashes | 3 | 10 |
| CSP line in Pages `_headers` | 324 chars | 702 chars |

The Material build is 43,825 bytes below Berth's 600 kB initial bundle warning.
Cloudflare counts the whole CSP line, including indentation and header name,
against 2,000 characters. Wrangler 4.166.0 served the saved operation path
at HTTP 200 with the exact built shell and CSP. [Pages header limits](https://developers.cloudflare.com/pages/configuration/headers/#attach-a-header)

## Browser evidence

- Chromium loaded one same-origin linked stylesheet, which includes the Sass
  `mat.theme` output. The filled button computed to `rgb(0, 92, 187)`, and
  the original fixture observed nine unique nonempty Angular style blocks
  across form, progress and detail. Each was present in the served hash policy. Angular can inject component styles
  at runtime even when the theme is served as a linked CSS file. [Angular security guide](https://angular.dev/best-practices/security#configure-styles-for-static-hosting)
- The saved detail link prompted for access and sent no read before token
  entry. Focus, password entry, keyboard submission, the accessible hint, a
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

Run the builds and the focused Chromium checks from the repository root. The
tests supply synthetic reads and use the generated Pages policy through the
loopback preview.

```bash
pnpm build
pnpm build:ui
pnpm test:ui -g 'Material access|production CSP'
```

The same tests passed against Wrangler 4.166.0 on a loopback origin with the
generated static files and no cloud bindings. The saved detail route served
the built HTML and CSP without a redirect.

The first Material rollout covers access and progress. Recheck the combined
Infrastructure and history bundle as the UI adds controls.
