/** Minimal test-only surface used by TypeScript tests while this repository
 * intentionally has no @types/jsdom development dependency. */
declare module "jsdom" {
  export class VirtualConsole {
    on(event: "jsdomError", listener: (error: Error) => void): this;
  }
  export class JSDOM {
    constructor(html?: string, options?: { pretendToBeVisual?: boolean; url?: string;
      runScripts?: "dangerously" | "outside-only"; virtualConsole?: VirtualConsole;
      beforeParse?: (window: Window & typeof globalThis) => void });
    readonly window: Window & typeof globalThis;
  }
}
