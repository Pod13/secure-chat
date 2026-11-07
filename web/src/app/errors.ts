// What to tell the person when something fails. Messages say what to do next and never repeat
// anything the person typed.

const MESSAGES: Record<string, string> = {
  invite_invalid: 'That invite is not valid. It may have expired or already been used.',
  bad_invite_link: 'That does not look like an invite link. Paste the whole link you were sent.',
  username_required: 'Choose a name. It is only shown to you, on this device.',
  passcode_too_short: 'Use a passcode of at least 10 characters.',
  wrong_passcode: 'That passcode is not right.',
  rate_limited: 'Too many tries. Wait a few minutes, then try again.',
  no_devices: 'That invite has no one to connect to. Ask for a new link.',
  unknown_conversation: 'That conversation no longer exists.',
  exists: 'This device already has an account. Reload the page and unlock it.',
};

export function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    (typeof code === 'string' ? MESSAGES[code] : undefined) ?? 'Something went wrong. Try again.'
  );
}
