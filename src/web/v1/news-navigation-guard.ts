/** Keep an uncertain task's in-memory idempotency key reachable. No browser persistence of task content. */
export function installNewsNavigationGuard(windowPort: Pick<Window, "addEventListener" | "removeEventListener">,
  documentPort: Pick<Document, "addEventListener" | "removeEventListener">,
  shouldHold: () => boolean, explain: () => void) {
  const click = (event: Event) => {
    const target = event.target as Element | null;
    if (shouldHold() && target?.closest?.("a[href]")) {
      event.preventDefault(); event.stopPropagation(); explain();
    }
  };
  const leave = (event: Event) => {
    if (shouldHold()) {
      event.preventDefault(); (event as BeforeUnloadEvent).returnValue = "";
    }
  };
  const capture = { capture: true };
  documentPort.addEventListener("click", click, capture);
  windowPort.addEventListener("beforeunload", leave);
  return () => {
    documentPort.removeEventListener("click", click, capture);
    windowPort.removeEventListener("beforeunload", leave);
  };
}
