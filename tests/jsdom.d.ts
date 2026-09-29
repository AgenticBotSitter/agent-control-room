/** Minimal test-only surface used by TypeScript tests while this repository
 * intentionally has no @types/jsdom development dependency. */
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { pretendToBeVisual?: boolean; url?: string });
    readonly window: Window & typeof globalThis;
  }
}
