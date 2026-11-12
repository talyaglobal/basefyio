import { Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PLATFORM_PASSWORD_CHECKS } from '@/lib/password-policy';

/**
 * The account password rules, always visible under the field and ticked off
 * as the user types — a rule shown only on hover is a rule nobody reads until
 * the server rejects the password.
 */
export function PasswordChecklist({ password, id }: { password: string; id?: string }) {
  return (
    <ul id={id} className="space-y-1 text-xs" aria-label="Password requirements">
      {PLATFORM_PASSWORD_CHECKS.map(({ label, test }) => {
        const met = test(password);
        return (
          <li
            key={label}
            className={cn('flex items-center gap-1.5', met ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}
          >
            {met ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            ) : (
              <Circle className="h-3 w-3 shrink-0" aria-hidden />
            )}
            <span>
              {label}
              <span className="sr-only">{met ? ' — met' : ' — not met yet'}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
