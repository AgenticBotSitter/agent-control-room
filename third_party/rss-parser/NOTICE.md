# RSS parser dependency

Source: https://github.com/rbren/rss-parser
Package: `rss-parser@3.13.0`, MIT, copyright (c) 2016 Bobby Brennan.
The package is used without modification via `parseString`; Control Room does not use
its `parseURL` transport. XML parsing is reused instead of writing a custom parser.
The adapter binds project/source provenance, caps input and item counts, and emits
discovery-only records into the existing story model. It does not verify article claims.

Exact package and transitive integrity hashes are in `pnpm-lock.yaml`. Installed
dependencies include entities 2.2.0 (BSD-2-Clause), xml2js 0.5.0 (MIT), sax 1.6.1 (BlueOak-1.0.0)
and xmlbuilder 11.0.1 (MIT). Preserve each package's bundled license when distributing
dependencies or bundled software. This is dependency adoption, not a copied source fork.

Full rss-parser license follows in LICENSE. No publisher articles or raw feed bodies
are vendored. Feed item attribution does not grant rights to republish full articles.
