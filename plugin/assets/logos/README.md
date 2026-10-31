# Pool and provider logos for the terminal

Generated, do not edit by hand: `node scripts/render-logos.mjs` (after `pnpm install` in `hub/web`)
renders the logos named in `hub/web/src/lib/logos.json` (the web panel's list) into `<name>@2x.png`
(26×32 px) and `<name>@3x.png` (38×48 px), the shape of two terminal cells of one row, and writes `logos.json` (the same list, file names and colours).
`plugin/lib/workers/logos.test.mjs` fails when this copy and the hub's list drift apart.

Sources and licences (MIT, CC0, ISC) and the trademark note: [THIRD_PARTY.md](../../../THIRD_PARTY.md).
