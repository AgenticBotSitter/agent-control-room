# Damaged approval nonce ledger

If approval stops with `updater_passkey_nonce_ledger_refused`, the approval nonce ledger is damaged. Control Room blocks approval and leaves `updater-state/nonces.log` unchanged. Even a missing final newline requires owner repair: the affected approval may already have authorized an installation change.

Stop approval attempts and keep the damaged file as evidence. Do not delete the file, empty it, trim its tail, add a newline, or retry with a different nonce to bypass the refusal. A fresh authenticator counter does not make the old approval safe to repeat.

Owner repair requires a trusted, complete copy of the nonce ledger for this installation, including every approval that could have taken effect. With approval writers stopped, preserve the damaged file separately and have the lead verify that the recovery copy retains all burned nonces before restoring it with the original private ownership and permissions. Resume only after that verification; previously burned nonces must still refuse replay.

If no complete trusted copy is available, keep approval blocked and ask the lead to arrange recovery. Partial records must never be guessed into valid burns or discarded automatically.

Step journals and rehearsal evidence have a different recovery rule: their final incomplete record can be removed after the committed prefix is validated under the writer lock. That rule does not apply to approval, credential, grant, or replay ledgers.
