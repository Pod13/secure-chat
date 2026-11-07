import type { ButtonHTMLAttributes } from 'react';

/** A real button, so keyboard and screen readers work; `type` defaults to "button". */
export function Button({ type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className="button" {...rest} />;
}
