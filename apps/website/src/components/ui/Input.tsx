import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const inputVariants = cva(
  [
    'flex w-full',
    'bg-bg',
    'border border-border',
    'rounded-md',
    'text-body text-text',
    'placeholder:text-muted',
    'transition-all duration-150',
    'focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface',
  ],
  {
    variants: {
      inputSize: {
        sm: 'h-8 px-3 text-body-sm',
        md: 'h-10 px-3',
        lg: 'h-12 px-4 text-body',
      },
      hasError: {
        true: 'border-danger focus:ring-danger',
      },
    },
    defaultVariants: {
      inputSize: 'md',
    },
  }
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {
  leftElement?: React.ReactNode;
  rightElement?: React.ReactNode;
  error?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type = 'text',
      inputSize,
      hasError,
      leftElement,
      rightElement,
      error,
      ...props
    },
    ref
  ) => {
    const hasLeftElement = !!leftElement;
    const hasRightElement = !!rightElement;

    if (hasLeftElement || hasRightElement) {
      return (
        <div className="relative w-full">
          {hasLeftElement && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">
              {leftElement}
            </div>
          )}
          <input
            type={type}
            className={cn(
              inputVariants({ inputSize, hasError: hasError || !!error, className }),
              hasLeftElement && 'pl-10',
              hasRightElement && 'pr-10'
            )}
            ref={ref}
            aria-invalid={hasError || !!error}
            {...props}
          />
          {hasRightElement && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
              {rightElement}
            </div>
          )}
        </div>
      );
    }

    return (
      <input
        type={type}
        className={cn(inputVariants({ inputSize, hasError: hasError || !!error, className }))}
        ref={ref}
        aria-invalid={hasError || !!error}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

// Textarea component
const textareaVariants = cva(
  [
    'flex w-full min-h-[80px]',
    'bg-bg',
    'border border-border',
    'rounded-md',
    'px-3 py-2',
    'text-body text-text',
    'placeholder:text-muted',
    'transition-all duration-150',
    'focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface',
    'resize-y',
  ],
  {
    variants: {
      hasError: {
        true: 'border-danger focus:ring-danger',
      },
    },
  }
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  hasError?: boolean;
  error?: string;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, hasError, error, ...props }, ref) => {
    return (
      <textarea
        className={cn(textareaVariants({ hasError: hasError || !!error, className }))}
        ref={ref}
        aria-invalid={hasError || !!error}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

// Form field wrapper
interface FormFieldProps {
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

const FormField: React.FC<FormFieldProps> = ({
  label,
  error,
  hint,
  required,
  children,
  className,
}) => {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label className="block text-body-sm font-medium text-text">
          {label}
          {required && <span className="text-danger ml-1">*</span>}
        </label>
      )}
      {children}
      {error && (
        <p className="text-small text-danger" role="alert">
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-small text-muted">{hint}</p>
      )}
    </div>
  );
};

export { Input, Textarea, FormField, inputVariants, textareaVariants };
