# Synthetic fixture packs

The executable fixture packs live in `src/fixtures/data.ts` so the responsive prototype, simulator, and tests share one typed source. They contain only privacy-safe synthetic operational metadata.

- Wayfarer exercises a Control Room-native media project.
- Content Blooms exercises a source-scheduled project with Mac transcription, VPS/provider generation, customer-input wait, and draft-review status.
- Website Operations is a deliberately unlike advisory project used to prevent media/content assumptions from entering the core.

Fixtures must pass the recursive forbidden-field and secret-pattern tests before they can be committed.
