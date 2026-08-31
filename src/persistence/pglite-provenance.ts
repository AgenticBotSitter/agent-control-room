import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { isHostProxyV1 } from "../security/host-value";

type PGliteConstructor = new () => PGlite;
type ExpectedDescriptor = Readonly<{ key: PropertyKey; kind: "method" | "getter"; sourceHash: string }>;
type Callable = (...args: never[]) => unknown;

const functionToString = Function.prototype.toString;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectDefineProperties = Object.defineProperties;
const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;

/*
 * PGlite is pinned at 0.3.14 by the frozen lockfile. These hashes cover every
 * executable descriptor on both prototype levels used by that exact package.
 * The repository-only simulation factory rejects drift before construction,
 * rather than privately branding behavior selected from a mutable prototype.
 */
const leafDescriptors: readonly ExpectedDescriptor[] = Object.freeze([
  { key: "_checkReady", kind: "method", sourceHash: "e77ac9024f3d7cb248ba868defd2b7ab0138c832eed8349f418fb8b002d1eedb" },
  { key: "_cleanupBlob", kind: "method", sourceHash: "201b17ed806dc7ca6db90a6160d7f13f3251bfc26c5529a6cb7b78bfcef88c6c" },
  { key: "_getWrittenBlob", kind: "method", sourceHash: "4272549be5b797e61d62e5ad78df8abf8d63b292ee69564a8ba92b60dcbe93cc" },
  { key: "_handleBlob", kind: "method", sourceHash: "8272826b3af97fe93464c8d18d282d050f3b06a63fef496f4ebe3e992aec81d2" },
  { key: "_runExclusiveListen", kind: "method", sourceHash: "53ee8f8fdfdd8298f0f165978e5e9afb04524d06433f91a9f968b80004d998e8" },
  { key: "_runExclusiveQuery", kind: "method", sourceHash: "4099b329b7fc1ed7faf9455ef1ad9eae17802e449465587e05d17f783ae71562" },
  { key: "_runExclusiveTransaction", kind: "method", sourceHash: "6b661e6eed771efeb8c67ffb0a6d8266b2e04c0ba5aa094978e8c2ea4c5b5815" },
  { key: "clone", kind: "method", sourceHash: "27441fda7f871cebaabd913f1c8b28674469b1ca91c731aeac9a94e6c10bb480" },
  { key: "close", kind: "method", sourceHash: "325f103af5400be5b75aadd0944f78e2be73f726600af20cc723f120cf7b44f1" },
  { key: "closed", kind: "getter", sourceHash: "d7429deed5dadc9b05e89c52b3eeb1d9e5b20b855dee3aa7688747d4782b4bf0" },
  { key: "constructor", kind: "method", sourceHash: "b4eecc54a9f5b6f52c03ce0afa50d6161a95378b75178357e3f27bdb71dfb842" },
  { key: "dumpDataDir", kind: "method", sourceHash: "9296789d1627ee3ff1e2dfddb03f05b87e80510e1f3f580bdc969e41c072f617" },
  { key: "execProtocol", kind: "method", sourceHash: "390fee66db6b8a32b9afc04013952321d5840c51da7e43473ff0f4687e57e6ad" },
  { key: "execProtocolRaw", kind: "method", sourceHash: "9d3361155fdb97f49a3869bd121fb30f0256cf20da6684b01af0dc3dbce36578" },
  { key: "execProtocolRawSync", kind: "method", sourceHash: "62bb893ccdc7b11a8531190152fbbe7b2efb2c0c8f676eab00fd2eb91404be98" },
  { key: "execProtocolStream", kind: "method", sourceHash: "fa9c49ed80496a94647bdebe10006cfa6df34263bfcec287acafe21f0d0d51cc" },
  { key: "isInTransaction", kind: "method", sourceHash: "0992a1bd431a36176a95e78b77296deb13988fa36987ad323b2d8623b5c57f3f" },
  { key: "listen", kind: "method", sourceHash: "9bc60202fac1ca4912bdbaea23d31749411bafe551a9a698bb00243e75d9130f" },
  { key: "Module", kind: "getter", sourceHash: "789bc151773e1632dcf005682f1a3c073ee2f7b35b37c5370f2707ab3ee64376" },
  { key: "offNotification", kind: "method", sourceHash: "0ef1fd7dbbc92dee06a83d9c4b41cb55038771d1e7f0d94a7c7d96b80ddf3af9" },
  { key: "onNotification", kind: "method", sourceHash: "00b3236fdc154f2987fdb33aaa457911ad70627cc98e0305f536dcb23e879427" },
  { key: "ready", kind: "getter", sourceHash: "a493558c93f606eb6c2ce3b20daf42f31ea6e3e6d20dddef6308126bf33085aa" },
  { key: Symbol.asyncDispose, kind: "method", sourceHash: "089ecdf9c300be6e8ca03eb0b170bb844a32fe6e9738523c84ee0e8f154f8dee" },
  { key: "syncToFs", kind: "method", sourceHash: "ddedff5a165d88d8448a5615323ea1232c409f51122b30345a58f9b6a5a33971" },
  { key: "unlisten", kind: "method", sourceHash: "555c9431d0a7b55d6c6fd558abebcd5973a7ae9b37b1ad59705aa47297383348" },
]);

const baseDescriptors: readonly ExpectedDescriptor[] = Object.freeze([
  { key: "_initArrayTypes", kind: "method", sourceHash: "f4b540b50ea5d0ae8bf0876da341e62ec5acade4316c686f4ce2ee031b36b90a" },
  { key: "constructor", kind: "method", sourceHash: "f6b530b8d0c4f8013ba1515817be5e69f62f9fd5e4b2bfb2815ae2094f1b772c" },
  { key: "describeQuery", kind: "method", sourceHash: "6ae357e710194813b4fd90543a4ed42a4b6aa3b9a329652c2806cc8a4a987e30" },
  { key: "exec", kind: "method", sourceHash: "9b041479d1a6a82f5dc355fda6731e85e053e08477995d0b7950004e7e8aee32" },
  { key: "query", kind: "method", sourceHash: "edc0ebef94d5bb410822a4a892562a109c329b2523d9b68224e3e3f3e2b374f2" },
  { key: "refreshArrayTypes", kind: "method", sourceHash: "02f5e0068cdfbbb87f01c56d32f9adfc3dad47924d369afd12ef1520162d4a2e" },
  { key: "runExclusive", kind: "method", sourceHash: "8fb9a49e3375e04d8463676db4bc55c50dbbb658de4da715884648671dc2dcea" },
  { key: "sql", kind: "method", sourceHash: "d185313391d2ff3149deb8e7511e4e673e06dac7b24c41c20891b2ff6458cd24" },
  { key: "transaction", kind: "method", sourceHash: "251452e1c20451c642761c9379fbce96cd1d5174d8efb16896546f1b958d92d5" },
]);

const pgliteConstructorHash = "b4eecc54a9f5b6f52c03ce0afa50d6161a95378b75178357e3f27bdb71dfb842";

function sourceHash(value: Callable): string {
  return createHash("sha256").update(reflectApply(functionToString, value, []) as string, "utf8").digest("hex");
}

function sameKey(left: PropertyKey, right: PropertyKey): boolean { return left === right; }

function validateLevel(prototype: object, expected: readonly ExpectedDescriptor[]): Map<PropertyKey, PropertyDescriptor> {
  if (isHostProxyV1(prototype)) throw new Error("repository simulation database implementation drift");
  const keys = reflectOwnKeys(prototype);
  if (keys.length !== expected.length || expected.some(({ key }) => !keys.some((actual) => sameKey(actual, key)))) {
    throw new Error("repository simulation database implementation drift");
  }
  const captured = new Map<PropertyKey, PropertyDescriptor>();
  for (const item of expected) {
    const descriptor = objectGetOwnPropertyDescriptor(prototype, item.key);
    if (!descriptor) throw new Error("repository simulation database implementation drift");
    const callable = item.kind === "method" ? descriptor.value : descriptor.get;
    const exactShape = item.kind === "method"
      ? descriptor && "value" in descriptor && descriptor.writable === true && descriptor.get === undefined && descriptor.set === undefined
      : descriptor && !("value" in descriptor) && descriptor.get !== undefined && descriptor.set === undefined;
    if (!exactShape || descriptor.enumerable !== false || descriptor.configurable !== true
      || typeof callable !== "function" || isHostProxyV1(callable)
      || sourceHash(callable as Callable) !== item.sourceHash) {
      throw new Error("repository simulation database implementation drift");
    }
    captured.set(item.key, descriptor);
  }
  return captured;
}

function pinnedDescriptors(...levels: ReadonlyArray<Map<PropertyKey, PropertyDescriptor>>): PropertyDescriptorMap {
  const result: PropertyDescriptorMap = {};
  for (const level of levels) for (const [key, descriptor] of level) {
    if (key === "constructor" || typeof key !== "string") continue;
    result[key] = "value" in descriptor
      ? { value: descriptor.value, writable: false, enumerable: false, configurable: false }
      : { get: descriptor.get, set: undefined, enumerable: false, configurable: false };
  }
  const asyncDispose = levels.flatMap((level) => [...level]).find(([key]) => key === Symbol.asyncDispose)?.[1];
  if (asyncDispose && "value" in asyncDispose) Object.defineProperty(result, Symbol.asyncDispose, {
    value: { value: asyncDispose.value, writable: false, enumerable: false, configurable: false },
    enumerable: true, configurable: true,
  });
  return result;
}

export interface ExactPgliteReceiverV1 {
  readonly receiver: PGlite;
  readonly query: PGlite["query"];
  readonly transaction: PGlite["transaction"];
  readonly exec: PGlite["exec"];
  readonly close: PGlite["close"];
}

/** Validate the pinned PGlite implementation before construction and seal its private receiver surface. */
export function createExactPgliteReceiverV1(PGliteClass: PGliteConstructor): ExactPgliteReceiverV1 {
  if (typeof PGliteClass !== "function" || isHostProxyV1(PGliteClass)
    || sourceHash(PGliteClass as unknown as Callable) !== pgliteConstructorHash) {
    throw new Error("repository simulation database implementation drift");
  }
  const prototypeDescriptor = objectGetOwnPropertyDescriptor(PGliteClass, "prototype");
  if (!prototypeDescriptor || !("value" in prototypeDescriptor) || prototypeDescriptor.writable !== false
    || prototypeDescriptor.enumerable !== false || prototypeDescriptor.configurable !== false
    || !prototypeDescriptor.value || typeof prototypeDescriptor.value !== "object") {
    throw new Error("repository simulation database implementation drift");
  }
  const leaf = prototypeDescriptor.value as object;
  const base = objectGetPrototypeOf(leaf) as object | null;
  if (!base || isHostProxyV1(base) || objectGetPrototypeOf(base) !== Object.prototype) {
    throw new Error("repository simulation database implementation drift");
  }
  const leafCaptured = validateLevel(leaf, leafDescriptors);
  const baseCaptured = validateLevel(base, baseDescriptors);
  if (leafCaptured.get("constructor")?.value !== PGliteClass) {
    throw new Error("repository simulation database implementation drift");
  }

  const receiver = new PGliteClass();
  if (objectGetPrototypeOf(receiver) !== leaf || isHostProxyV1(receiver)) {
    throw new Error("repository simulation database implementation drift");
  }
  objectDefineProperties(receiver, pinnedDescriptors(baseCaptured, leafCaptured));
  return Object.freeze({
    receiver,
    query: baseCaptured.get("query")!.value as PGlite["query"],
    transaction: baseCaptured.get("transaction")!.value as PGlite["transaction"],
    exec: baseCaptured.get("exec")!.value as PGlite["exec"],
    close: leafCaptured.get("close")!.value as PGlite["close"],
  });
}
