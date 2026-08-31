export type ObservedProxyMode = "transparent" | "key_hiding" | "descriptor_fabricating" | "throwing";

export function observedProxy<T extends object>(target: T, mode: ObservedProxyMode): { value: T; trapCount: () => number } {
  let traps = 0;
  const observed = <V>(operation: () => V): V => {
    traps += 1;
    if (mode === "throwing") throw new Error("Proxy trap must not execute");
    return operation();
  };
  const handler: ProxyHandler<T> = {
    get: (value, key, receiver) => observed(() => Reflect.get(value, key, receiver)),
    getPrototypeOf: (value) => observed(() => Reflect.getPrototypeOf(value)),
    has: (value, key) => observed(() => Reflect.has(value, key)),
    ownKeys: (value) => observed(() => {
      const keys = Reflect.ownKeys(value);
      return mode === "key_hiding" ? keys.filter((key) => typeof key === "string") : keys;
    }),
    getOwnPropertyDescriptor: (value, key) => observed(() => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      return mode === "descriptor_fabricating" && descriptor ? { ...descriptor } : descriptor;
    }),
  };
  return { value: new Proxy(target, handler), trapCount: () => traps };
}

export type BinaryViewAttackMode = "shared" | "buffer_getter" | "buffer_data" | "byte_length_getter"
  | "byte_length_data" | "subclass" | "prototype_drift" | "detached"
  | "backing_constructor_getter" | "method_getters" | "subview_offset" | "subview_prefix";

export function binaryViewAttack(mode: BinaryViewAttackMode): {
  value: Uint8Array;
  getterCount(): number;
  isWiped(): boolean;
} {
  let getters = 0, value: Uint8Array, whole: Uint8Array;
  if (mode === "subview_offset" || mode === "subview_prefix") {
    whole = new Uint8Array([91, 65, 66, 67, 93, 94, 95]);
    value = new Uint8Array(whole.buffer, mode === "subview_offset" ? 1 : 0, 3);
  } else if (mode === "shared" || mode === "buffer_getter" || mode === "buffer_data") {
    value = new Uint8Array(new SharedArrayBuffer(3));
  } else if (mode === "subclass") {
    class ExtendedUint8Array extends Uint8Array {}
    value = new ExtendedUint8Array(3);
  } else value = new Uint8Array(3);
  if (mode !== "subview_offset" && mode !== "subview_prefix") Uint8Array.prototype.set.call(value, [65, 66, 67]);
  whole ??= value;
  if (mode === "buffer_getter") Object.defineProperty(value, "buffer", { configurable: true, get() { getters += 1; return new ArrayBuffer(3); } });
  if (mode === "buffer_data") Object.defineProperty(value, "buffer", { configurable: true, value: new ArrayBuffer(3) });
  if (mode === "byte_length_getter") Object.defineProperty(value, "byteLength", { configurable: true, get() { getters += 1; return 3; } });
  if (mode === "byte_length_data") Object.defineProperty(value, "byteLength", { configurable: true, value: 3 });
  if (mode === "method_getters") {
    for (const key of ["at", "fill", "set", "slice", Symbol.iterator]) Object.defineProperty(value, key, { configurable: true, get() { getters += 1; return undefined; } });
  }
  if (mode === "prototype_drift") Object.setPrototypeOf(value, {});
  if (mode === "detached" || mode === "backing_constructor_getter") {
    const buffer = Reflect.apply(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer")!.get!, value, []) as ArrayBuffer;
    if (mode === "backing_constructor_getter") Object.defineProperty(buffer, "constructor", { configurable: true, get() { getters += 1; return ArrayBuffer; } });
    else structuredClone(buffer, { transfer: [buffer] });
  }
  return {
    value,
    getterCount: () => getters,
    isWiped: () => mode === "detached" || Uint8Array.prototype.every.call(whole, (byte) => byte === 0),
  };
}
