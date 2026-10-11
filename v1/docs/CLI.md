# CLI usage

Set `API_TOKEN` to a unique random value of at least 32 characters on the API server. Supply the same token as `ROOFLINE_TOKEN` to the CLI through the environment. Use `ROOFLINE_URL` for the server origin. Remote connections require HTTPS. Credentials never belong in arguments, URLs or committed JSON files.

## Node

```bash
node cli/roofline.mjs health
node cli/roofline.mjs connectors
node cli/roofline.mjs geocode '100 Main Street, Austin, TX 78701'
node cli/roofline.mjs report 123456789
node cli/roofline.mjs import examples/measurement.json
node cli/roofline.mjs estimate examples/quote-request.json
```

The import/report response contains a measurement `id`. Put that in `measurementId` in a copy of `examples/quote-request.json`, then:

```bash
node cli/roofline.mjs quote /path/to/request.json
node cli/roofline.mjs quotes
node cli/roofline.mjs export YOUR_QUOTE_ID /path/to/proposal.pdf
node cli/roofline.mjs batch /path/to/array-of-quote-requests.json
```

Batch handles at most 100 requests sequentially. It returns successes and errors by input index, and exits nonzero if any item failed. Do not blindly rerun a partially successful batch: quote creation itself is not idempotent. Export refuses to overwrite an existing file. Review is required before marking CLI-generated drafts ready.

## BuildCLI

Requires JDK 21+ and Maven. `./scripts/build-cli.sh` clones the pinned upstream commit into `.buildcli/source`, builds its real modules with a local Maven repository, compiles `cli/roof`, and packages the plugin. You can set `MVN=/absolute/path/to/mvn` to select Maven. No global plugin installation is performed; Java's `user.home` is redirected inside `.buildcli/home` by the launcher.

```bash
./scripts/buildcli roof --help
./scripts/buildcli roof health
./scripts/buildcli roof connectors
./scripts/buildcli roof geocode '100 Main Street, Austin, TX 78701'
./scripts/buildcli roof report 123456789
./scripts/buildcli roof import --file examples/measurement.json
./scripts/buildcli roof estimate --file examples/quote-request.json
./scripts/buildcli roof quote --file /path/to/request.json
./scripts/buildcli roof quotes
./scripts/buildcli roof export YOUR_QUOTE_ID --out /path/to/proposal.pdf
```

The plugin was scaffolded by BuildCLI `plugin init --name roof --type COMMAND`. `RoofCommand` extends `BuildCLICommandPlugin`; the upstream PF4J manager loads `roof.jar` and registers its Picocli commands. `RooflineLauncher` preserves the real BuildCLI command tree while skipping its automatic updater/banner and returning the command exit code. This matters because the pinned upstream stock launcher exits 0 unconditionally. Source scaffold, service metadata, plugin metadata and upstream MIT license are included.

Both CLIs call the same API; neither implements a second pricing engine. For automatic paid report ordering, use the UI confirmation flow or documented `/api/jobs/price` and `/api/jobs/order` endpoints with explicit authorization.

## Property Data sandbox

Both command clients support this workflow (replace REQUEST_ID with the returned ID):

```bash
node cli/roofline.mjs sandbox-addresses
node cli/roofline.mjs sandbox-request '4220 BARKER AVE, OMAHA, NE 68105'
node cli/roofline.mjs sandbox-result REQUEST_ID
node cli/roofline.mjs sandbox-select REQUEST_ID 0

./scripts/buildcli roof sandbox-addresses
./scripts/buildcli roof sandbox-request '4220 BARKER AVE, OMAHA, NE 68105'
./scripts/buildcli roof sandbox-result REQUEST_ID
./scripts/buildcli roof sandbox-select REQUEST_ID 0
```

Result polling is safe to repeat; wait at least ten seconds between checks. Select uses the result's **zero-based index**. Selection is idempotent for that request/structure. Its measurement ID can be used with `quote` to save a sandbox-only draft. EagleView Client ID and Secret belong on the server; CLI authentication still uses the independent Roofline API token.
