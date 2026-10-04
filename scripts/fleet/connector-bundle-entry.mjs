#!/usr/bin/env node
import { createFleetHarnessAdapter } from "../../src/fleet/v1/harness-adapters.ts";
import { registerBundledHarnessAdapterFactory } from "./connector.mjs";

registerBundledHarnessAdapterFactory(createFleetHarnessAdapter);
export * from "./connector.mjs";
