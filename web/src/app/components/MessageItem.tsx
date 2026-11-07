import type { MessageView } from '../../crypto/messagetypes';
import type { MessageStatus } from '../../store/history';

const STATUS_TEXT = {
  sending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  expired: 'Not delivered: it expired',
} as const;

export const LIKE = '👍';

interface Props {
  message: MessageView;
  /** The message this one replies to, if it is still known. */
  quoted: MessageView | undefined;
  status: MessageStatus | undefined;
  onReply(): void;
  onEdit(): void;
  onLike(): void;
}

function Actions({ message, onReply, onEdit, onLike }: Omit<Props, 'quoted' | 'status'>) {
  const liked = message.reactions.get(LIKE)?.has('me') === true;
  return (
    <div className="message-actions">
      <button type="button" onClick={onReply}>
        Reply
      </button>
      <button type="button" onClick={onLike}>
        {liked ? 'Unlike' : 'Like'}
      </button>
      {message.author === 'me' ? (
        <button type="button" onClick={onEdit}>
          Edit
        </button>
      ) : null}
    </div>
  );
}

/** One message with its reply quote, reactions, status and the few things a person can do to it. */
export function MessageItem({ message, quoted, status, ...actions }: Props) {
  const likes = message.reactions.get(LIKE)?.size ?? 0;
  const mine = message.author === 'me';
  return (
    <li className={mine ? 'message mine' : 'message theirs'}>
      {quoted ? <blockquote>{quoted.text}</blockquote> : null}
      <p>
        {message.text}
        {message.edited ? <small> (edited)</small> : null}
      </p>
      {likes > 0 ? (
        <p aria-label={`${likes} liked this`}>
          {LIKE} {likes}
        </p>
      ) : null}
      {mine && status ? <small className="status">{STATUS_TEXT[status.state]}</small> : null}
      <Actions message={message} {...actions} />
    </li>
  );
}
