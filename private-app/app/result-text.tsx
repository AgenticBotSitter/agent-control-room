"use client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Presentation only. No HTML interpretation, remote images, commands or file access. */
export function ResultText({ text }: { text: string }) {
  const plain = <textarea aria-label="Agent result text" readOnly value={text} />;
  // Keep the exact original available and bound synchronous Markdown parsing.
  if (text.length > 32768) return <><p>Large result shown as plain text.</p>{plain}</>;
  return <>
    <div className="private-result-markdown" aria-label="Formatted agent result">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
        img: ({ alt }) => <span>[Image omitted{alt ? `: ${alt}` : ""}]</span>,
        a: ({ href, children }) => href && /^https?:\/\//i.test(href)
          ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          : <span>{children}</span>,
      }}>{text}</Markdown>
    </div>
    <details><summary>Original plain text</summary>{plain}</details>
  </>;
}
