'use client';

import { useEffect } from 'react';

export function GlobalErrorCatcher() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error(
        '[GlobalErrorCatcher] window.onerror:',
        event.message,
        '\nFilename:', event.filename,
        '\nLine:', event.lineno,
        '\nCol:', event.colno,
        '\nError:', event.error,
      );
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      console.error(
        '[GlobalErrorCatcher] unhandledrejection:',
        event.reason,
      );
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  return null;
}
