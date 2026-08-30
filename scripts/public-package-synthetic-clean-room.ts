import {
  PUBLIC_OBSERVATION_CONTRACT_V1,
  PUBLIC_OBSERVATION_EVENT_V1,
  sha256DigestV1,
} from "../packages/control-room-core/src/index";
import { OBSERVATION_ADAPTER_SDK_VERSION_V1 } from "../packages/control-room-adapter-sdk/src/index";
import { OBSERVATION_CONFORMANCE_KIT_VERSION_V1 } from "../packages/control-room-conformance-kit/src/index";
import { runSyntheticControlRoomExampleV1 } from "../examples/synthetic/src/index";
import {
  assessPublicCleanRoomV1,
  buildPublicReleasePlanV1,
  buildPublicReproductionObservationV1,
} from "../src/public-package/v1";
import { sha256Digest } from "../src/security";

const observedAt = "2026-08-30T12:00:00.000Z";
const example = runSyntheticControlRoomExampleV1();
const releasePlan = buildPublicReleasePlanV1({
  packageVersion: "0.1.0",
  sourceRevisionDigest: sha256Digest({ source: "synthetic-public-candidate-v1" }),
  dependencyLockDigest: sha256Digest({ lock: "synthetic-public-candidate-v1" }),
  createdAt: observedAt,
});
const outputDigests = [
  sha256DigestV1({ PUBLIC_OBSERVATION_CONTRACT_V1, PUBLIC_OBSERVATION_EVENT_V1 }),
  sha256DigestV1({ OBSERVATION_ADAPTER_SDK_VERSION_V1 }),
  sha256DigestV1({ OBSERVATION_CONFORMANCE_KIT_VERSION_V1, results: example.conformance.results }),
  sha256DigestV1(example),
];
const first = buildPublicReproductionObservationV1({ plan: releasePlan, runnerId: "runner:synthetic:one", result: "passed",
  outputDigests, guideValidationPassed: true, conformancePassed: example.conformance.passed, observedAt });
const second = buildPublicReproductionObservationV1({ plan: releasePlan, runnerId: "runner:synthetic:two", result: "passed",
  outputDigests, guideValidationPassed: true, conformancePassed: example.conformance.passed, observedAt });
const assessment = assessPublicCleanRoomV1({ plan: releasePlan, first, second, assessedAt: observedAt });

console.log(JSON.stringify({ releasePlan, example, first, second, assessment }));
