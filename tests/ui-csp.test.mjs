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

test("the Pages CSP build hashes literal CSS in the optimized Material component wrapper", () => {
  const wrapped = `class Control {
    static ɵcmp = (function () {
      let constants = ["content"];
      function template() {}
      return define({ styles: ["berth-app{color:var(--%NS%ink)}"], encapsulation: 2, template, constants });
    })();
  }`;

  assert.deepEqual(componentStyleHashes([wrapped]), [digest]);
  for (const unsupported of [
    wrapped.replace("function ()", "function (metadata)"),
    wrapped.replace("function ()", "async function ()"),
    wrapped.replace("function ()", "function* ()"),
    wrapped.replace("encapsulation: 2", "encapsulation: 2, encapsulation: 2"),
    wrapped.replace("encapsulation: 2", "encapsulation: 2, ...extra"),
    wrapped.replace("encapsulation: 2", "encapsulation: 2, [key]: value"),
    wrapped.replace("return define(", "return other() || define("),
    wrapped.replace('["content"]', "inspect()"),
    wrapped.replace(
      "return define(",
      "return (function (metadata) { return metadata; })(",
    ),
    wrapped.replace(
      "template, constants });",
      "template, constants }, extra);",
    ),
    wrapped.replace("return define(", "inspect(); return define("),
    wrapped.replace("encapsulation: 2", "encapsulation: 0"),
  ]) {
    assert.throws(
      () => componentStyleHashes([unsupported]),
      /Unsupported Angular AOT|ViewEncapsulation.None/,
    );
  }
});
