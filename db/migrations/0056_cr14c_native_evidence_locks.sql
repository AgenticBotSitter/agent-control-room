-- Row locks without granting canonical attempt/lease transitions to the evidence receiver.
ALTER TABLE control_attempts ADD COLUMN evidence_lock boolean NOT NULL DEFAULT false CHECK (evidence_lock IS FALSE);
ALTER TABLE control_leases ADD COLUMN evidence_lock boolean NOT NULL DEFAULT false CHECK (evidence_lock IS FALSE);
