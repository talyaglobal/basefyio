'use client';

import React from 'react';
import { cn } from '../../lib/utils';
import { SparklesCore } from './SparklesCore';

// Company logo SVGs - authentic brand logos
const logos = [
  // Vercel
  {
    name: 'Vercel',
    svg: (
      <svg viewBox="0 -17 256 256" fill="currentColor" className="h-full w-full">
        <polygon points="128 0 256 221.705007 0 221.705007" />
      </svg>
    ),
  },
  // Stripe
  {
    name: 'Stripe',
    svg: (
      <svg viewBox="0 0 32 32" fill="currentColor" className="h-full w-full">
        <path d="M8.25 10.435l-2.165 0.46-0.010 7.12c0 1.315 0.99 2.165 2.305 2.165 0.73 0 1.265-0.135 1.56-0.295v-1.69c-0.285 0.115-1.685 0.525-1.685-0.785v-3.16h1.685v-1.89h-1.685zM12.705 13.015l-0.135-0.655h-1.92v7.66h2.215v-5.155c0.525-0.69 1.41-0.555 1.695-0.465v-2.040c-0.3-0.105-1.335-0.3-1.855 0.655zM17.32 9.4l-2.23 0.475v1.81l2.23-0.475zM2.245 14.615c0-0.345 0.29-0.48 0.755-0.485 0.675 0 1.535 0.205 2.21 0.57v-2.090c-0.735-0.29-1.47-0.405-2.205-0.405-1.8 0-3 0.94-3 2.51 0 2.46 3.375 2.060 3.375 3.12 0 0.41-0.355 0.545-0.85 0.545-0.735 0-1.685-0.305-2.43-0.71v2c0.825 0.355 1.66 0.505 2.425 0.505 1.845 0 3.115-0.79 3.115-2.39 0-2.645-3.395-2.17-3.395-3.17zM32 16.28c0-2.275-1.1-4.070-3.21-4.070s-3.395 1.795-3.395 4.055c0 2.675 1.515 3.91 3.675 3.91 1.060 0 1.855-0.24 2.46-0.575v-1.67c-0.605 0.305-1.3 0.49-2.18 0.49-0.865 0-1.625-0.305-1.725-1.345h4.345c0.010-0.115 0.030-0.58 0.030-0.795zM27.605 15.44c0-1 0.615-1.42 1.17-1.42 0.545 0 1.125 0.42 1.125 1.42zM21.96 12.21c-0.87 0-1.43 0.41-1.74 0.695l-0.115-0.55h-1.955v10.24l2.22-0.47 0.005-2.51c0.32 0.235 0.795 0.56 1.57 0.56 1.59 0 3.040-1.16 3.040-3.98 0.005-2.58-1.465-3.985-3.025-3.985zM21.43 18.335c-0.52 0-0.83-0.19-1.045-0.42l-0.015-3.3c0.23-0.255 0.55-0.44 1.060-0.44 0.81 0 1.37 0.91 1.37 2.070 0.005 1.195-0.545 2.090-1.37 2.090zM15.095 20.020h2.23v-7.66h-2.23z" />
      </svg>
    ),
  },
  // Linear
  {
    name: 'Linear',
    svg: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-full w-full">
        <path d="M3.03509 12.9431C3.24245 14.9227 4.10472 16.8468 5.62188 18.364C7.13904 19.8811 9.0631 20.7434 11.0428 20.9508L3.03509 12.9431Z" />
        <path d="M3 11.4938L12.4921 20.9858C13.2976 20.9407 14.0981 20.7879 14.8704 20.5273L3.4585 9.11548C3.19793 9.88771 3.0451 10.6883 3 11.4938Z" />
        <path d="M3.86722 8.10999L15.8758 20.1186C16.4988 19.8201 17.0946 19.4458 17.6493 18.9956L4.99021 6.33659C4.54006 6.89125 4.16573 7.487 3.86722 8.10999Z" />
        <path d="M5.66301 5.59517C9.18091 2.12137 14.8488 2.135 18.3498 5.63604C21.8508 9.13708 21.8645 14.8049 18.3907 18.3228L5.66301 5.59517Z" />
      </svg>
    ),
  },
  // Notion
  {
    name: 'Notion',
    svg: (
      <svg viewBox="0 0 192 192" fill="currentColor" className="h-full w-full">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="m138.462 21.522 27.784 19.588.044.033.275.201c1.713 1.256 3.349 2.455 4.452 3.83 1.411 1.76 1.884 3.644 1.884 5.877v104.706c0 3.587-.635 7.178-3.058 9.934-2.451 2.789-6.145 4.067-10.732 4.394l-.018.001-98.629 5.971-.021.001c-3.242.154-6.094.035-8.669-.907-2.688-.984-4.719-2.727-6.604-5.129l-.01-.012-19.979-25.979-.012-.017c-3.81-5.086-5.723-9.348-5.723-14.509V34.509c0-3.12.688-6.394 2.745-9.033 2.124-2.727 5.356-4.328 9.503-4.686l.058-.005 84.854-4.344c5.192-.445 8.938-.576 12.286.185 3.459.787 6.208 2.452 9.57 4.896ZM56.43 157.336h.002v3.3c0 1.904.47 2.337.613 2.452.296.235 1.203.652 3.642.518l97.449-5.371c1.928-.106 2.256-.649 2.348-.801l.005-.008c.29-.476.486-1.407.486-3.357V60.001c0-1.635-.334-2.218-.421-2.327l-.005-.007-.002-.003-.006-.002a.117.117 0 0 1-.012-.004c-.053-.019-.263-.078-.724-.037l-.057.005-101.622 5.668c-.624.056-.973.163-1.152.242-.142.062-.173.104-.181.116l-.002.002c-.066.085-.36.586-.36 2.321v91.361Zm9.085-106.705 87.074-4.506-21.028-15.375-.039-.031c-1.259-.98-2.507-1.854-4.12-2.46-1.588-.597-3.695-.993-6.669-.734l-.05.005-87.009 4.898h-.01a6.453 6.453 0 0 0-.893.116L49.934 48.56c2.037 1.646 3.109 2.146 4.337 2.367 1.538.277 3.52.167 7.722-.115l3.522-.237v.056Zm-34.231-3.586v83.893c0 .538.175 1.061.498 1.49l13.174 17.464V61.224a2.47 2.47 0 0 0-.877-1.889l-.08-.068-12.715-12.222Zm109.871 35.062c.451 2.04 0 4.082-2.041 4.315l-3.393.673v49.881c-2.947 1.586-5.66 2.492-7.927 2.492-3.622 0-4.528-1.134-7.239-4.53l-.003-.003L98.36 100.02v33.78l7.02 1.59s0 4.082-5.664 4.082l-15.615.906c-.455-.91 0-3.176 1.582-3.627l4.078-1.131V90.955l-5.66-.459c-.454-2.04.677-4.987 3.85-5.216l16.754-1.128 23.09 35.367V88.231l-5.885-.677c-.455-2.499 1.356-4.315 3.618-4.536l15.627-.91v-.001Z"
        />
      </svg>
    ),
  },
  // Figma
  {
    name: 'Figma',
    svg: (
      <svg viewBox="0 0 38 57" fill="currentColor" className="h-full w-full">
        <path d="M19 28.5C19 23.2533 23.2533 19 28.5 19C33.7467 19 38 23.2533 38 28.5C38 33.7467 33.7467 38 28.5 38C23.2533 38 19 33.7467 19 28.5Z" />
        <path d="M0 47.5C0 42.2533 4.25329 38 9.5 38H19V47.5C19 52.7467 14.7467 57 9.5 57C4.25329 57 0 52.7467 0 47.5Z" />
        <path d="M19 0V19H28.5C33.7467 19 38 14.7467 38 9.5C38 4.25329 33.7467 0 28.5 0H19Z" />
        <path d="M0 9.5C0 14.7467 4.25329 19 9.5 19H19V0H9.5C4.25329 0 0 4.25329 0 9.5Z" />
        <path d="M0 28.5C0 33.7467 4.25329 38 9.5 38H19V19H9.5C4.25329 19 0 23.2533 0 28.5Z" />
      </svg>
    ),
  },
];

interface SparklesLogoCloudProps {
  title?: string;
  subtitle?: string;
  className?: string;
  particleColor?: string;
  particleDensity?: number;
  minSize?: number;
  maxSize?: number;
  speed?: number;
}

export const SparklesLogoCloud: React.FC<SparklesLogoCloudProps> = ({
  title = 'Trusted by experts.',
  subtitle = 'Used by the leaders.',
  className,
  particleColor = '#6366f1',
  particleDensity = 80,
  minSize = 0.6,
  maxSize = 1.4,
  speed = 2,
}) => {
  return (
    <div className={cn('relative w-full overflow-hidden rounded-xl', className)}>
      {/* Background with sparkles */}
      <div className="absolute inset-0 bg-surface-2 dark:bg-[#0d0d0d]">
        <SparklesCore
          id="sparkles-logo-cloud"
          background="transparent"
          minSize={minSize}
          maxSize={maxSize}
          particleDensity={particleDensity}
          className="h-full w-full"
          particleColor={particleColor}
          speed={speed}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 px-6 py-12">
        {/* Title */}
        <div className="mb-10 text-center">
          <h3 className="text-2xl font-semibold text-text md:text-3xl">
            <span className="text-primary">{title.split('.')[0]}.</span>
            <br />
            <span>{subtitle}</span>
          </h3>
        </div>

        {/* Logo grid */}
        <div className="mx-auto grid max-w-4xl grid-cols-2 gap-6 md:grid-cols-5 md:gap-8">
          {logos.map((logo, index) => (
            <div
              key={logo.name}
              className="text-text/70 flex h-12 items-center justify-center transition-colors duration-200 hover:text-text"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              {logo.svg}
            </div>
          ))}
        </div>
      </div>

      {/* Gradient overlays for fade effect */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-surface-2 to-transparent dark:from-[#0d0d0d]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface-2 to-transparent dark:from-[#0d0d0d]" />
    </div>
  );
};

export default SparklesLogoCloud;
