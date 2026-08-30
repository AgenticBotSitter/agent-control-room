import type { JSX } from "react";
import type { TelegramPresentationV1 } from "@/src/telegram/v1/types";

function label(value:string):string { return value.replaceAll("_"," ").replace(/\b\w/g,(letter)=>letter.toUpperCase()); }

/** Read-only sanitized preview. Callback tokens and transport controls do not cross this component. */
export function TelegramMessagePreview({presentations}:{presentations:readonly TelegramPresentationV1[]}):JSX.Element {
  return <section className="telegram-preview" aria-label="Sanitized Telegram presentation previews">
    <p className="telegram-preview-boundary">Synthetic preview only. No bot or chat is connected. These intents cannot approve, dispatch, execute, or send a message.</p>
    {presentations.length===0?<p className="empty-state">No Telegram presentations are visible in this scope.</p>:<ol className="telegram-preview-list">
      {presentations.map((presentation)=><li key={presentation.presentationId} className={`telegram-preview-card risk-${presentation.risk}`}>
        <header><div><span>{label(presentation.risk)} risk</span><small>{label(presentation.delivery)}</small></div><b>{presentation.sourceMessagePlanIds.length} item{presentation.sourceMessagePlanIds.length===1?"":"s"}</b></header>
        <pre>{presentation.plainText}</pre>
        <ul className="telegram-intent-list" aria-label="Transport-neutral presentation intents">
          {presentation.buttons.map((intent,index)=><li key={`${intent.attentionId}:${intent.kind}:${index}`} className={`intent-${intent.kind}`}>
            <span>{intent.label}</span><small>{intent.kind==="callback_intent"?"Response proposal intent · unsigned":"Protected dashboard intent · sign-in required"}</small>
          </li>)}
        </ul>
        <footer><span>Plain text · no parse mode</span><span>No approval or execution authority</span></footer>
      </li>)}
    </ol>}
  </section>;
}
