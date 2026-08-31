import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ArtifactEvidenceCard,
	type ArtifactEvidenceCardModelV1,
} from "../app/components/artifact-evidence-card.tsx";

const baseModel: ArtifactEvidenceCardModelV1 = {
	schema: "control-room.artifact-evidence-card/v1",
	artifactId: "artifact-0001",
	logicalRole: "build-manifest",
	state: "declared",
	mimeType: "application/json",
	byteSize: 2048,
	contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	createdAt: "2026-08-26T00:00:00Z",
	locatorAvailable: false,
	producerClaim: {
		claimId: "claim-0001",
		producerId: "producer-x",
		claim: "content_hash_matches_exact_bytes",
		contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		manifestDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		claimDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		createdAt: "2026-08-26T00:01:00Z",
	},
	independentVerification: { state: "not_run" },
};

function render(model: ArtifactEvidenceCardModelV1): string {
	return renderToStaticMarkup(React.createElement(ArtifactEvidenceCard, { model }));
}

test("labels the three required sections", () => {
	const html = render(baseModel);
	assert.ok(html.includes("Artifact manifest"));
	assert.ok(html.includes("Producer claim"));
	assert.ok(html.includes("Independent verification"));
});

test("shows required artifact and claim values", () => {
	const html = render(baseModel);
	for (const value of [
		baseModel.artifactId,
		baseModel.logicalRole,
		baseModel.mimeType,
		`${baseModel.byteSize} bytes`,
		baseModel.contentHash,
		baseModel.createdAt,
		baseModel.producerClaim.claimId,
		baseModel.producerClaim.producerId,
		baseModel.producerClaim.contentHash,
		baseModel.producerClaim.manifestDigest,
		baseModel.producerClaim.claimDigest,
	]) {
		assert.ok(html.includes(value), `missing ${value}`);
	}
	assert.ok(html.includes("Content hash matches exact bytes"));
});

test("renders Not run when verification has not occurred", () => {
	const html = render(baseModel);
	assert.ok(html.includes("Not run"));
});

test("shows locator presence without disclosing the locator", () => {
	assert.ok(render({ ...baseModel, locatorAvailable: true }).includes("Locator recorded"));
	assert.ok(
		render({ ...baseModel, locatorAvailable: false }).includes("No locator recorded"),
	);
});

test("verification states render with verifier identity", () => {
	const verified: ArtifactEvidenceCardModelV1 = {
		...baseModel,
		independentVerification: {
			state: "failed",
			verifierId: "verifier-9",
			observedAt: "2026-08-26T02:00:00Z",
		},
	};
	const html = render(verified);
	assert.ok(html.includes("Failed"));
	assert.ok(html.includes("verifier-9"));
	assert.ok(html.includes("2026-08-26T02:00:00Z"));
});

test("never characterizes the producer claim as verified, accepted, or approved", () => {
	const html = render(baseModel).toLowerCase();
	assert.ok(!html.includes("accepted"));
	assert.ok(!html.includes("approved"));
	// "verified" may only appear in the independent-verification context.
	const producerSection = render(baseModel)
		.split("Producer claim")[1]
		?.split("Independent verification")[0]
		.toLowerCase();
	assert.ok(producerSection);
	assert.ok(!producerSection.includes("verified"));
});

test("status is understandable without color (text status element)", () => {
	const html = render(baseModel);
	assert.ok(/role="status"/.test(html));
	assert.ok(!/<svg/.test(html));
});

test("uses semantic headings and definition lists", () => {
	const html = render(baseModel);
	assert.ok(/<h3>/.test(html));
	assert.ok(/<dl>/.test(html));
	assert.ok(/<dt>/.test(html));
	assert.ok(/<dd>/.test(html));
});

test("escapes supplied text safely", () => {
	const hostile: ArtifactEvidenceCardModelV1 = {
		...baseModel,
		logicalRole: '<script>alert("x")</script>',
	};
	const html = render(hostile);
	assert.ok(!html.includes("<script>"));
	assert.ok(html.includes("&lt;script&gt;"));
});

test("deterministic output for identical props", () => {
	assert.equal(render(baseModel), render(baseModel));
});
