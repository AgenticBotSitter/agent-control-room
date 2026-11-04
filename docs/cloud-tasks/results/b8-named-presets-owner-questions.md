# b8-named-presets owner questions

None.

Settled owner choices recorded as context, not reopened here (from the task file):

- Picking a preset only copies an editable draft; it never grants Start, paid, cap or family-acknowledgement authority.
- Preset JSON holds only the five B8 roles (spec, spec_reviews, build, code_reviews, final) with effort and reviewer multiplicity; plan roles stay independent and are not stored in a preset.
- Paid consent, caps and family acknowledgement are never saved in selections, presets or defaults; each new run resets override controls.
- No seeded lineup, no preset-count cap, no automatically chosen default. The default pointer belongs to `b8-default-start` (D01b).
- Final may never share the builder family (including fallback or override); only ordinary review-family conflicts may be acknowledged, and preview creates no authority.

Technical prerequisites that are missing on this base (U81/U82 selection modules, R62/P72 admission evidence, PostgreSQL 17 on this cloud machine) are recorded as technical blockers/limits in the spec and status, not as owner questions.
