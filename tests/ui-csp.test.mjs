import assert from "node:assert/strict";
import test from "node:test";
import {
  componentStyleHashes,
  renderStyleHeaders,
} from "../tools/build-ui-csp.mjs";

const component =
  'class A { static ɵcmp = define({ styles: ["berth-app{color:var(--%NS%ink)}"], encapsulation: 2 }); }';
const template =
  "/*\n  Content-Security-Policy: script-src 'self'; style-src 'self'; object-src 'none'\n";
const digest = "'sha256-WYnwZ5LXy5VnNGN0ewGm/oD3Fb8aCW545iZ9Dl418ho='";
const lazyDigest = "'sha256-BwiqtBxFOqLz9mcHgWp/YfxzG3F4aF5lg7SGqsETx6A='";

test("the Pages build hashes final component CSS, deduplicates chunks and preserves the rest of the policy", () => {
  assert.equal(
    renderStyleHeaders(template, [
      component,
      'const unrelated = { styles: ["outside a component"] };',
      component,
      'class Lazy { static ɵcmp = define({ styles: ["berth-app{display:block}"], encapsulation: 2 }); }',
    ]),
    template.replace(
      "style-src 'self';",
      `style-src 'self' ${lazyDigest} ${digest};`,
    ),
  );
});

test("the Pages CSP build rejects CSS it cannot hash and overlong header rules", () => {
  assert.throws(() => componentStyleHashes([]), /No compiled/);
  assert.throws(
    () =>
      componentStyleHashes([
        component.replace("encapsulation: 2", "encapsulation: 0"),
      ]),
    /ViewEncapsulation.None/,
  );
  assert.throws(
    () => componentStyleHashes([component.replace("%NS%", "%COMP%")]),
    /Unsupported runtime/,
  );
  assert.throws(
    () =>
      renderStyleHeaders(template.replace("script-src", "a".repeat(2000)), [
        component,
      ]),
    /header line limit/,
  );
});
