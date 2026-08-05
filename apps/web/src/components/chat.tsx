import type { ChatMessageRecord, StrategyEvidenceEntry } from "@studio-parallel/db";
import Link from "next/link";

import { chatParagraphs, describeChatFailure, isFailedAnswer, questionBefore } from "../lib/chat";
import { resolveStrategyEvidence, strategyEvidenceTombstone } from "../lib/strategy";
import type { ChatSessionDetail, ChatSnapshot } from "../lib/server/chat-data";
import { startChatSessionAction } from "../app/(authenticated)/chat/actions";
import { ChatComposer } from "./chat-composer";
import { ChatSessionControls } from "./chat-session-controls";
import { EmptyState, ErrorSummary, PartialState } from "./states";
import { PageHeader } from "./page-header";
import { StatusBadge } from "./status-badge";

/**
 * The assistant, and the conversations a reader has had with it.
 *
 * An answer is shown with what it was allowed to argue from, in the same way a
 * strategy claim is: the evidence it cited resolves to the trend or the post it
 * came from, and an id the current manifest no longer holds is left as an
 * uncited note rather than a link to nothing. That is what keeps a conversation
 * inspectable rather than merely fluent.
 *
 * A failed turn is a message, not a missing one. It sits in sequence where the
 * answer would have been, says which failure it was, and offers the question
 * again — so a reader can tell the difference between "the assistant had
 * nothing to say" and "this one did not work".
 */

function timestamp(value: string): string {
  return new Date(value).toLocaleString("en-AU", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}

function Citations({
  evidence,
  keys,
}: Readonly<{ evidence: readonly StrategyEvidenceEntry[]; keys: readonly string[] }>) {
  if (keys.length === 0) return null;

  return (
    <div className="chat-message__evidence">
      <p className="chat-message__evidence-label">Based on</p>
      <ul>
        {keys.map((key) => {
          const resolved = resolveStrategyEvidence(evidence, key);

          if (resolved.kind === "missing") {
            return (
              <li key={key}>
                <span className="chat-message__tombstone">{strategyEvidenceTombstone}</span>
              </li>
            );
          }

          return (
            <li key={key}>
              {resolved.kind === "link" ? (
                <Link href={resolved.href}>{resolved.entry.summaryText}</Link>
              ) : (
                resolved.entry.summaryText
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Message({
  detail,
  isLast,
  message,
}: Readonly<{ detail: ChatSessionDetail; isLast: boolean; message: ChatMessageRecord }>) {
  if (isFailedAnswer(message)) {
    const question = questionBefore(detail.messages, message.sequence);

    return (
      <div className="chat-message chat-message--failed">
        <p className="chat-message__speaker">
          Assistant <StatusBadge tone="warning">No answer</StatusBadge>
        </p>
        <p>{describeChatFailure(message.failureCode ?? "")}</p>
        {/* Only the newest failure offers the question again. An older one has
            already been asked past, and a second composer on the page would put
            two identically labelled fields in front of a reader and duplicate
            the id that labels them. */}
        {isLast && question !== null ? (
          <ChatComposer presetQuestion={question} sessionId={detail.session.id} />
        ) : null}
      </div>
    );
  }

  return (
    <div className={`chat-message chat-message--${message.role === "user" ? "user" : "assistant"}`}>
      <p className="chat-message__speaker">
        {message.role === "user" ? "You" : "Assistant"}
        <span className="chat-message__time">
          <time dateTime={message.createdAt}>{timestamp(message.createdAt)}</time>
        </span>
      </p>
      {chatParagraphs(message.content).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
      {message.role === "assistant" ? (
        <Citations evidence={detail.evidence} keys={message.citedEvidenceKeys} />
      ) : null}
    </div>
  );
}

function FollowUps({ message }: Readonly<{ message: ChatMessageRecord | undefined }>) {
  if (message === undefined || message.role !== "assistant" || message.followUps.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="chat-follow-ups" className="chat-follow-ups">
      <h2 id="chat-follow-ups">You could ask next</h2>
      <ul>
        {message.followUps.map((followUp) => (
          <li key={followUp}>{followUp}</li>
        ))}
      </ul>
    </section>
  );
}

function StartConversation({ label }: Readonly<{ label: string }>) {
  return (
    <form action={startChatSessionAction}>
      <button className="button button--primary" type="submit">
        {label}
      </button>
    </form>
  );
}

export function ChatScreen({ snapshot }: Readonly<{ snapshot: ChatSnapshot }>) {
  return (
    <div className="page-stack">
      <PageHeader
        action={snapshot.hasAccount ? <StartConversation label="Start a conversation" /> : null}
        description="Ask about this account's strategy, the evidence behind it and what to make next. Every answer is built from work this product has already done."
        title="Assistant"
      />

      {snapshot.hasAccount ? null : (
        <EmptyState
          action={{ href: "/settings/integrations", label: "Connect Instagram account" }}
          description="Connect an Instagram professional account. The assistant answers from a strategy, and a strategy is built from analysed posts."
          title="No Instagram account connected"
        />
      )}

      {snapshot.hasAccount && !snapshot.hasStrategy ? (
        <PartialState
          action={{ href: "/strategy", label: "Generate a strategy" }}
          available={
            <p>
              You can still ask, and the assistant will say what it is missing rather than estimate
              an answer.
            </p>
          }
          missing="a generated strategy for this account, which is what answers are argued from"
          title="No strategy behind this account yet"
        />
      ) : null}

      {snapshot.hasAccount && snapshot.sessions.length === 0 ? (
        <EmptyState
          description="Nothing has been asked yet. A conversation keeps its own history, so follow-up questions carry what came before."
          title="No conversations yet"
        />
      ) : null}

      {snapshot.sessions.length === 0 ? null : (
        <section aria-labelledby="chat-sessions" className="chat-sessions">
          <h2 id="chat-sessions">Conversations</h2>
          <ul className="chat-sessions__list">
            {snapshot.sessions.map((session) => (
              <li key={session.id}>
                <article className="chat-session-card">
                  <h3>
                    <Link href={`/chat/${session.id}`}>{session.title}</Link>
                  </h3>
                  <p className="chat-session-card__meta">
                    {session.messageCount === 0 ? (
                      "No messages yet"
                    ) : (
                      <>
                        {session.messageCount} message{session.messageCount === 1 ? "" : "s"}
                      </>
                    )}
                    {session.lastMessageAt === null ? null : (
                      <>
                        {" · last "}
                        <time dateTime={session.lastMessageAt}>
                          {timestamp(session.lastMessageAt)}
                        </time>
                      </>
                    )}
                  </p>
                </article>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ChatSessionScreen({ detail }: Readonly<{ detail: ChatSessionDetail }>) {
  const last = detail.messages[detail.messages.length - 1];
  const hasFailedTail = last !== undefined && isFailedAnswer(last);

  return (
    <div className="page-stack">
      <PageHeader
        action={<ChatSessionControls sessionId={detail.session.id} title={detail.session.title} />}
        description="Answers are built from this account's current strategy and the evidence behind it."
        title={detail.session.title}
      />

      <p>
        <Link href="/chat">Back to conversations</Link>
      </p>

      <section aria-labelledby="chat-conversation" className="chat-conversation">
        <h2 className="visually-hidden" id="chat-conversation">
          Conversation
        </h2>

        {detail.messages.length === 0 ? (
          <p className="chat-conversation__opening">
            Ask something to begin. &ldquo;What video should I make next?&rdquo; is a good first
            question.
          </p>
        ) : (
          detail.messages.map((message, index) => (
            <Message
              detail={detail}
              isLast={index === detail.messages.length - 1}
              key={message.id}
              message={message}
            />
          ))
        )}
      </section>

      <FollowUps message={last} />

      {/* A failed tail already offers the question again beside the failure, and
          a second composer under it would ask the reader to choose between two
          identical forms. */}
      {hasFailedTail ? null : (
        <ChatComposer autoFocus={detail.messages.length === 0} sessionId={detail.session.id} />
      )}
    </div>
  );
}

export function ChatError({ reference }: Readonly<{ reference: string }>) {
  return (
    <div className="page-stack">
      <PageHeader description="Conversations could not be loaded." title="Assistant" />
      <ErrorSummary
        correlationId={reference}
        description="Nothing was changed. Try again, and quote this reference if it keeps happening."
        title="The assistant is unavailable"
      />
    </div>
  );
}
