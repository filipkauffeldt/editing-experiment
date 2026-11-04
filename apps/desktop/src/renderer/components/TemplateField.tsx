import {
  templateVariablesFor,
  unknownTemplateVariables,
  type TemplateVariable,
  type TemplateVariableContext,
} from '@ee/metadata/variables';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './TemplateField.module.css';

interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

interface Choice {
  template: string;
  aliases: readonly string[];
  description: string;
  example: string;
}

const choicesFor = (context: TemplateVariableContext): Choice[] =>
  templateVariablesFor(context).flatMap((variable: TemplateVariable) => [
    {
      template: `{${variable.name}}`,
      aliases: variable.aliases,
      description: variable.description,
      example: variable.example,
    },
    ...variable.formats
      .filter((format) => format.contexts.includes(context))
      .map((format) => ({
        template: format.template,
        aliases: [],
        description: format.description,
        example: format.example,
      })),
  ]);

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max));

interface TemplateFieldProps {
  label: string;
  value: string;
  context: TemplateVariableContext;
  onChange(value: string): void;
  testId?: string;
  placeholder?: string;
  className?: string;
}

/**
 * Boxed template input with a picker for the variables that work in it. The
 * picker inserts at the caret (replacing a selection) and leaves focus in the
 * field, so typing a template by hand and picking from the list mix freely.
 */
export function TemplateField({
  label,
  value,
  context,
  onChange,
  testId,
  placeholder,
  className,
}: TemplateFieldProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [placement, setPlacement] = useState<Placement>();

  const choices = choicesFor(context);
  const normalizedQuery = query.trim().toLowerCase();
  const visible =
    normalizedQuery === ''
      ? choices
      : choices.filter((choice) =>
          `${choice.template} ${choice.description} ${choice.example}`
            .toLowerCase()
            .includes(normalizedQuery),
        );
  const unknown = unknownTemplateVariables(value, context);
  const listId = `${id}-variables`;

  // Keep the list inside the dialog even when the field sits near an edge.
  useLayoutEffect(() => {
    if (!open) return;
    const popover = popoverRef.current;
    const input = inputRef.current;
    if (!popover || !input) return;
    const dialog = input.closest('[role="dialog"]');
    const dialogRect = dialog?.getBoundingClientRect();
    const anchor = input.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const dialogWidth = dialogRect && dialogRect.width > 0 ? dialogRect.width : viewportWidth;
    const dialogLeft = dialogRect && dialogRect.width > 0 ? dialogRect.left : 0;
    const dialogTop = dialogRect && dialogRect.height > 0 ? dialogRect.top : 0;
    const dialogRight = dialogLeft + dialogWidth;
    const dialogBottom = dialogRect && dialogRect.height > 0 ? dialogRect.bottom : viewportHeight;
    const margin = 12;
    const width = clamp(360, 240, dialogWidth - margin * 2);
    popover.style.width = `${width}px`;
    popover.style.maxHeight = `${Math.max(120, dialogBottom - dialogTop - margin * 2)}px`;
    const measured = popover.getBoundingClientRect();
    const below = dialogBottom - anchor.bottom - margin;
    const above = anchor.top - dialogTop - margin;
    const naturalHeight = Math.min(Math.max(measured.height, 120), 360);
    const flipUp = below < Math.min(naturalHeight, 220) && above > below;
    const maxHeight = Math.max(120, Math.min(naturalHeight, flipUp ? above : below));
    popover.style.maxHeight = `${maxHeight}px`;
    setPlacement({
      left: clamp(anchor.left, dialogLeft + margin, dialogRight - width - margin),
      top: flipUp
        ? Math.max(dialogTop + margin, anchor.top - Math.min(measured.height, maxHeight) - 4)
        : Math.min(anchor.bottom + 4, dialogBottom - maxHeight - margin),
      width,
      maxHeight,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    filterRef.current?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (inputRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    // The dialog itself handles Escape in a document capture listener. Listen
    // one level higher so a keypress with the list open closes only the list.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      inputRef.current?.focus();
    };
    const close = (): void => setOpen(false);
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // React owns the value; restore the caret once the controlled update landed.
  useLayoutEffect(() => {
    if (caretRef.current === undefined) return;
    const position = caretRef.current;
    caretRef.current = undefined;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(position, position);
  }, [value]);

  const insert = (template: string): void => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? start;
    input.setSelectionRange(start, end);
    let inserted = false;
    try {
      // Chromium keeps this edit on the field's native undo stack.
      inserted = document.execCommand('insertText', false, template);
    } catch {
      // jsdom and other engines without execCommand use setRangeText below.
    }
    if (!inserted) input.setRangeText(template, start, end, 'end');
    caretRef.current = input.selectionStart ?? start + template.length;
    onChange(input.value);
    setOpen(false);
  };

  const moveFocus = (direction: 1 | -1): void => {
    const items = [
      ...(popoverRef.current?.querySelectorAll<HTMLButtonElement>('[data-variable-item]') ?? []),
    ];
    if (items.length === 0) return;
    const active = document.activeElement;
    const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
    const next = index < 0 ? (direction > 0 ? 0 : items.length - 1) : index + direction;
    items[(next + items.length) % items.length]?.focus();
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    }
  };

  const picker =
    open &&
    createPortal(
      <div
        ref={popoverRef}
        className={styles.popover}
        role="dialog"
        aria-label={`Variables for ${label}`}
        id={listId}
        data-testid={testId ? `${testId}-variable-list` : undefined}
        style={
          placement
            ? {
                left: placement.left,
                top: placement.top,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }
            : { left: 0, top: 0, width: 240, maxHeight: 120, visibility: 'hidden' }
        }
        onKeyDown={onListKeyDown}
      >
        <header className={styles.header}>
          <span className={styles.title}>Variables</span>
          <input
            ref={filterRef}
            className={styles.filter}
            value={query}
            placeholder="Filter…"
            aria-label={`Filter variables for ${label}`}
            aria-controls={listId}
            onChange={(event) => setQuery(event.target.value)}
          />
        </header>
        <div className={styles.list}>
          {visible.length === 0 && <div className={styles.empty}>No matching variables</div>}
          {visible.map((choice) => (
            <button
              key={choice.template}
              type="button"
              className={styles.item}
              data-variable-item
              aria-label={`Insert ${choice.template}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(choice.template)}
            >
              <span className={styles.variable}>{choice.template}</span>
              <span className={styles.description}>
                {choice.description}
                {choice.aliases.length > 0 && (
                  <span className={styles.aliases}>
                    {' '}
                    · also {choice.aliases.map((alias) => `{${alias}}`).join(', ')}
                  </span>
                )}
              </span>
              <span className={styles.example}>{choice.example}</span>
            </button>
          ))}
        </div>
      </div>,
      document.body,
    );

  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.row}>
        <input
          id={id}
          ref={inputRef}
          className={styles.input}
          value={value}
          placeholder={placeholder}
          data-testid={testId}
          aria-describedby={unknown.length > 0 ? `${id}-unknown` : undefined}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className={styles.trigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`Variables for ${label}`}
          data-testid={testId ? `${testId}-variables` : undefined}
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            setQuery('');
            setOpen(true);
          }}
        >
          Variables
        </button>
      </div>
      {unknown.length > 0 && (
        <span
          className={styles.unknown}
          id={`${id}-unknown`}
          role="status"
          data-testid={testId ? `${testId}-unknown` : undefined}
        >
          Unknown variable{unknown.length === 1 ? '' : 's'}:{' '}
          {unknown.map((name) => `{${name}}`).join(', ')}
        </span>
      )}
      {picker}
    </div>
  );
}
