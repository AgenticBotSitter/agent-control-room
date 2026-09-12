# Disposable reader browser check

Run from the checkout root with prepared dependencies:

```sh
pnpm exec vite --config vite.article-preview.config.ts
```

Open loopback port 4174. Stop the preview with Ctrl+C afterward. It uses synthetic
article data, intercepts application fetch calls, and does not require login,
provider credentials or a database. This is not a production entry point.

Check with keyboard and a narrow viewport:

1. Open saved text and confirm headings, lists, table and code remain readable.
2. Confirm the embedded script is inert and the remote image is not loaded.
3. Switch project; the old article must disappear and reopening shows the new ID.
4. Expire access while reading; text must disappear with an unavailable message.
5. Restore access and reopen; verify the reader recovers without a page reload.
6. Close the reader; verify focus is usable and the summary remains visible.

Record actual browser results before claiming this gate passes. Source rendering
and fake-DOM tests alone do not prove visual layout, accessibility or real-browser
behavior. The initial attempt was blocked by the locked Mac; no visual pass is
recorded.
