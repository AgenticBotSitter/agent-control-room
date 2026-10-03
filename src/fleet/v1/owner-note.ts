/** Worker-authored free text is untrusted, including unfamiliar secret formats.
 * Shared response and display policy: keep the note and its title private;
 * retain only status/time and a fixed explanation on the owner screen. */
export function ownerWorkerNoteV1<T extends { message: string; taskTitle: string }>(note: T): T {
  return { ...note, message: "Worker note may contain private details; open the protected task to investigate.", taskTitle: "" };
}
