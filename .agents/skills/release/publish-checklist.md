# npm publish checklist

Use only after a GitHub release tag exists (`vX.Y.Z` matches `package.json`), and only when the user explicitly asked to publish.

## One-time setup (remind if missing)

- [ ] npm account exists and can publish public packages
- [ ] Logged in locally: `npm whoami` succeeds (or `npm login`)
- [ ] 2FA enabled on npm (required for publishing)
- [ ] Package name `jevonian` still free or already owned by this account: `npm view jevonian name version`
- [ ] Publishing identity matches `package.json` `author` / npm org expectations
- [ ] First public publish: `publishConfig.access` is already `"public"` in `package.json`

No GitHub `NPM_TOKEN` is required for **local** publish. Only add a token/OIDC workflow if you later re-enable CI publish on purpose.

## Pre-publish verification (every release)

From a clean tree at the release tag:

```bash
git checkout "vX.Y.Z"
git status   # clean
node -p "require('./package.json').version"   # must equal X.Y.Z without v
pnpm install --frozen-lockfile
pnpm exec vp check
pnpm test
pnpm build
pnpm smoke
npm pack --dry-run
```

Check dry-run output:

- [ ] Includes `dist/cli.mjs`, `dist/web/**`, `LICENSE`, `README.md`
- [ ] No `*.map` files
- [ ] No `src/`, `web/src/`, `.env`, credentials
- [ ] License field is `AGPL-3.0-only`
- [ ] Tarball size looks sane (on the order of hundreds of KB to low MB)

`prepublishOnly` already runs `vp check`, `test`, and `build` on publish; still run them manually so failures are caught before the npm round-trip.

## Publish

```bash
npm publish --access public
```

For a dry run of the real publish path:

```bash
npm publish --access public --dry-run
```

Provenance: local `npm publish` without GitHub OIDC may omit provenance; that is acceptable for manual publishes. Do not add `--provenance` unless the environment supports it.

## Post-publish verification

```bash
npm view jevonian version
npm view jevonian dist-tags
npm install --global jevonian@X.Y.Z
jevonian --help   # or: jevonian update --check
```

- [ ] Registry version is `X.Y.Z`
- [ ] Global install runs
- [ ] GitHub Release notes link or mention the npm version
- [ ] Remind: installed clients pick this up via `jevonian update` / dashboard update (registry check ≤24h cache)

## Do not

- Publish from a dirty working tree or untagged commit
- Publish a version that already exists on the registry (npm will reject; bump first)
- Rely on tag-push auto-publish (removed on purpose)
- Commit npm tokens or `.npmrc` with `_authToken` into the repo
