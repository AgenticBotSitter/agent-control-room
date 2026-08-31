import type { JSX } from "react";

export interface ArtifactEvidenceCardModelV1 {
	schema: "control-room.artifact-evidence-card/v1";
	artifactId: string;
	logicalRole: string;
	state: "declared" | "available" | "verified" | "rejected" | "expired";
	mimeType: string;
	byteSize: number;
	contentHash: string;
	createdAt: string;
	locatorAvailable: boolean;
	producerClaim: {
		claimId: string;
		producerId: string;
		claim: "content_hash_matches_exact_bytes";
		contentHash: string;
		manifestDigest: string;
		claimDigest: string;
		createdAt: string;
	};
	independentVerification:
		| { state: "not_run" }
		| {
				state: "passed" | "failed" | "blocked" | "inconclusive";
				verifierId: string;
				observedAt: string;
		  };
}

const STATE_LABELS: Record<ArtifactEvidenceCardModelV1["state"], string> = {
	declared: "Declared",
	available: "Available",
	verified: "Verified",
	rejected: "Rejected",
	expired: "Expired",
};

function DefinitionItem(props: { label: string; value: string }) {
	return (
		<div>
			<dt>{props.label}</dt>
			<dd>{props.value}</dd>
		</div>
	);
}

/**
 * Presentational evidence card for a single artifact.
 *
 * Renders server-resolved state as text only. It never recomputes hashes,
 * fetches content, inspects a locator, or promotes artifact state. Producer
 * claim text is always shown as a claim — the words "verified", "accepted",
 * and "approved" are reserved for independent verification output.
 */
export function ArtifactEvidenceCard(props: {
	model: ArtifactEvidenceCardModelV1;
}): JSX.Element {
	const { model } = props;
	const { producerClaim } = model;

	let verificationLabel: string;
	let verificationDetail: string;
	if (model.independentVerification.state === "not_run") {
		verificationLabel = "Not run";
		verificationDetail = "Independent verification has not been performed.";
	} else {
		verificationLabel =
			model.independentVerification.state.charAt(0).toUpperCase() +
			model.independentVerification.state.slice(1);
		verificationDetail = `Verifier ${model.independentVerification.verifierId} at ${model.independentVerification.observedAt}`;
	}

	return (
		<article aria-label={`Artifact evidence for ${model.artifactId}`}>
			<h3>Artifact manifest</h3>
			<dl>
				<DefinitionItem label="Logical role" value={model.logicalRole} />
				<DefinitionItem label="Artifact ID" value={model.artifactId} />
				<DefinitionItem label="State" value={STATE_LABELS[model.state]} />
				<DefinitionItem label="MIME type" value={model.mimeType} />
				<DefinitionItem label="Byte size" value={`${model.byteSize} bytes`} />
				<DefinitionItem label="Content hash" value={model.contentHash} />
				<DefinitionItem label="Created at" value={model.createdAt} />
				<DefinitionItem
					label="Locator"
					value={
						model.locatorAvailable
							? "Locator recorded"
							: "No locator recorded"
					}
				/>
			</dl>

			<h3>Producer claim</h3>
			<p>
				The following is a producer claim only. It has not been independently
				checked.
			</p>
			<dl>
				<DefinitionItem label="Claim ID" value={producerClaim.claimId} />
				<DefinitionItem label="Producer" value={producerClaim.producerId} />
				<DefinitionItem
					label="Claim type"
					value={producerClaim.claim === "content_hash_matches_exact_bytes"
						? "Content hash matches exact bytes"
						: producerClaim.claim}
				/>
				<DefinitionItem label="Claimed content hash" value={producerClaim.contentHash} />
				<DefinitionItem label="Manifest digest" value={producerClaim.manifestDigest} />
				<DefinitionItem label="Claim digest" value={producerClaim.claimDigest} />
				<DefinitionItem label="Claimed at" value={producerClaim.createdAt} />
			</dl>

			<h3>Independent verification</h3>
			<p role="status">{verificationLabel}</p>
			<p>{verificationDetail}</p>
		</article>
	);
}

export default ArtifactEvidenceCard;
