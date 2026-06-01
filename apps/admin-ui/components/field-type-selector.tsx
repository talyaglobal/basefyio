'use client';

import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Search, Database } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PG_FIELD_TYPES, FIELD_CATEGORIES, getFieldType } from '@/lib/pg-field-types';
import type { PgFieldType, FieldCategory } from '@/lib/pg-field-types';

interface FieldTypeSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  compact?: boolean;
}

const categoryColors: Record<FieldCategory, string> = {
  'ID & Keys': 'text-amber-500',
  'Numbers': 'text-blue-500',
  'Text': 'text-emerald-500',
  'Date & Time': 'text-violet-500',
  'Boolean': 'text-orange-500',
  'JSON': 'text-cyan-500',
  'Binary': 'text-rose-500',
};

export function FieldTypeSelector({ value, onValueChange, className, compact }: FieldTypeSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const selected = getFieldType(value);

  const Icon = selected?.icon ?? Database;
  const colorClass = selected ? categoryColors[selected.category] : 'text-muted-foreground';

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md border border-input bg-background text-sm ring-offset-background',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            compact ? 'h-8 px-2' : 'h-9 px-3',
            className,
          )}
        >
          <Icon className={cn('h-3.5 w-3.5 shrink-0', colorClass)} />
          <span className="truncate flex-1 text-left">
            {selected ? selected.label : value || 'Select type...'}
          </span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-40" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-50 w-[280px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none animate-in fade-in-0 zoom-in-95"
          sideOffset={4}
          align="start"
        >
          <Command className="w-full bg-popover">
            <div className="flex items-center border-b bg-popover px-3">
              <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
              <Command.Input
                placeholder="Search types..."
                className="flex h-9 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-72 overflow-y-auto bg-popover p-1">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                No type found.
              </Command.Empty>
              {FIELD_CATEGORIES.map((category) => {
                const items = PG_FIELD_TYPES.filter((t) => t.category === category);
                if (items.length === 0) return null;
                return (
                  <Command.Group
                    key={category}
                    heading={category}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {items.map((ft) => (
                      <TypeItem
                        key={ft.value}
                        fieldType={ft}
                        isSelected={value === ft.value}
                        colorClass={categoryColors[ft.category]}
                        onSelect={() => {
                          onValueChange(ft.value);
                          setOpen(false);
                        }}
                      />
                    ))}
                  </Command.Group>
                );
              })}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TypeItem({
  fieldType,
  isSelected,
  colorClass,
  onSelect,
}: {
  fieldType: PgFieldType;
  isSelected: boolean;
  colorClass: string;
  onSelect: () => void;
}) {
  const Icon = fieldType.icon;
  return (
    <Command.Item
      value={`${fieldType.label} ${fieldType.description}`}
      onSelect={onSelect}
      className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      <Check
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          isSelected ? 'opacity-100' : 'opacity-0',
        )}
      />
      <Icon className={cn('h-4 w-4 shrink-0', colorClass)} />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{fieldType.label}</span>
        <span className="block truncate text-[11px] text-muted-foreground leading-tight">{fieldType.description}</span>
      </div>
    </Command.Item>
  );
}
