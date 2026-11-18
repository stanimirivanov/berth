/** Synthetic public audit fixture for the former exact exception; no provider/account captures. */
export function picomatchReport() {
  return {
    advisories: {
      "1247710": {
        id: 1247710,
        module_name: "picomatch",
        severity: "high",
        github_advisory_id: "GHSA-fc5q-39xc-vjpf",
        vulnerable_versions: "<=4.0.7",
        patched_versions: null,
        url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
        findings: [
          {
            version: "4.0.7",
            paths: [
              ".>alchemy>tinyglobby>fdir>picomatch",
              ".>alchemy>tinyglobby>picomatch",
              ".>alchemy>picomatch",
              ".>neon>@neon/config-runtime>@vercel/nft>@rollup/pluginutils>picomatch",
              ".>neon>@neon/config-runtime>@vercel/nft>picomatch",
              ".>@neon/config-runtime>@vercel/nft>@rollup/pluginutils>picomatch",
              ".>@neon/config-runtime>@vercel/nft>picomatch",
              ".>@stylistic/eslint-plugin>picomatch",
              ".>@alchemy.run/sql>alchemy>tinyglobby>fdir>picomatch",
              ".>@alchemy.run/sql>alchemy>tinyglobby>picomatch",
              ".>@alchemy.run/sql>alchemy>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/docker>alchemy>tinyglobby>fdir>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/docker>alchemy>tinyglobby>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/docker>alchemy>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/acme>alchemy>tinyglobby>fdir>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/acme>alchemy>tinyglobby>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/acme>alchemy>picomatch",
              ".>@alchemy.run/cloudflare>alchemy>tinyglobby>fdir>picomatch",
              ".>@alchemy.run/cloudflare>alchemy>tinyglobby>picomatch",
              ".>@alchemy.run/cloudflare>alchemy>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/sql>alchemy>tinyglobby>fdir>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/sql>alchemy>tinyglobby>picomatch",
              ".>@alchemy.run/cloudflare>@alchemy.run/sql>alchemy>picomatch",
              ".>@alchemy.run/cloudflare>tinyglobby>fdir>picomatch",
              ".>@alchemy.run/cloudflare>tinyglobby>picomatch",
              ".>@alchemy.run/cloudflare>picomatch",
            ],
            dev: false,
            optional: false,
            bundled: false,
          },
        ],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    },
  };
}
