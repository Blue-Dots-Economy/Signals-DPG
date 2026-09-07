/**
 * `SelectWidget` for enum fields: a keyboard-navigable dropdown that an
 * optional field can be cleared back out of.
 *
 * Replaces `@rjsf/shadcn`'s `FancySelect` for the single-value case, which had
 * two defects, both inside the vendored package and so unreachable from a
 * wrapper:
 *
 *  - **Arrow keys did nothing visible.** `FancySelect` is a `cmdk` `Command`
 *    whose trigger is a plain button. Arrow keys do reach `Command`'s own
 *    handler and move its internal cursor, but `cmdk` only follows focus to
 *    the item when the active element carries `cmdk-input` or `cmdk-root` —
 *    the trigger carries neither — and its `CommandItem` had no
 *    `data-selected` styling, so nothing on screen changed.
 *  - **Enter could not select.** The trigger's own `onKeyDown` calls
 *    `stopPropagation()` on Enter, so `Command` never saw it and never
 *    dispatched its select event. Keyboard-only users could open the dropdown
 *    and never choose from it.
 *
 * Built instead on the app's own `ui/select` (Radix), which is what the
 * language switcher and birth-year select already use: arrow keys, typeahead,
 * Home/End, Escape and a visible highlight all come from the primitive rather
 * than being reimplemented here.
 *
 * `multiple` (array-of-enum) fields still fall through to the theme widget —
 * those render `FancyMultiSelect`, which has a real `CommandInput` and so does
 * get `cmdk`'s keyboard handling, and whose chips are individually removable.
 */
import { X } from 'lucide-react';
import { Widgets } from '@rjsf/shadcn';
import {
  enumOptionsIndexForValue,
  enumOptionsValueForIndex,
  type EnumOptionsType,
  type WidgetProps,
} from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const ThemeSelectWidget = Widgets.SelectWidget;

export function ClearableSelectWidget(props: Readonly<WidgetProps>) {
  const { t } = useTranslation();
  const {
    id,
    value,
    required,
    disabled,
    readonly,
    multiple,
    autofocus,
    onChange,
    onBlur,
    onFocus,
    options,
    placeholder,
    rawErrors = [],
  } = props;

  if (multiple) return <ThemeSelectWidget {...props} />;

  const enumOptions = (options.enumOptions ?? []) as EnumOptionsType[];
  const enumDisabled = options.enumDisabled as EnumOptionsType['value'][] | undefined;

  // Radix addresses items by string, and an enum's values can be numbers or
  // booleans, so the option's *index* is the item value — RJSF's own helpers
  // do that translation for every other theme too. `''` (no match) is exactly
  // what Radix reads as "no selection", so it shows the placeholder.
  const selectedIndex = (enumOptionsIndexForValue(value, enumOptions, false) as string) ?? '';

  // Only offered where clearing is both allowed and meaningful: an optional
  // field that currently holds something and isn't locked. A required field is
  // deliberately excluded — emptying it is not a state it may hold, so the
  // button would invite a validation error rather than offer a choice.
  const clearable = !required && selectedIndex !== '' && !disabled && !readonly;

  return (
    <div className="relative">
      <Select
        value={selectedIndex}
        onValueChange={(index) =>
          onChange(enumOptionsValueForIndex(index, enumOptions, options.emptyValue))
        }
        disabled={disabled || readonly}
        required={required}
      >
        <SelectTrigger
          id={id}
          autoFocus={autofocus}
          onBlur={() => onBlur(id, value)}
          onFocus={() => onFocus(id, value)}
          aria-invalid={rawErrors.length > 0 || undefined}
          // Padding goes on the VALUE, not the trigger. Padding the trigger
          // moves the chevron inward — which is what left the first version of
          // this button sitting outside the chevron, at the very edge of the
          // field. The value is `flex-1`, so this reserves the button's space
          // between a long label and a chevron that hasn't moved.
          className={cn(clearable && '*:data-[slot=select-value]:pr-7')}
        >
          <SelectValue placeholder={placeholder || t('form.select_placeholder')} />
        </SelectTrigger>
        <SelectContent>
          {enumOptions.map(({ value: optionValue, label }, index) => (
            <SelectItem
              key={`${index}-${label}`}
              value={String(index)}
              disabled={Array.isArray(enumDisabled) && enumDisabled.includes(optionValue)}
            >
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {clearable && (
        <button
          type="button"
          // `emptyValue`, matching what `enumOptionsValueForIndex` falls back
          // to above. With no `ui:emptyValue` set (the norm) it IS `undefined`,
          // and RJSF then drops the key from `formData` rather than storing an
          // empty string — which is what "not answered" means downstream.
          onClick={() => onChange(options.emptyValue)}
          aria-label={t('form.clear_selection')}
          title={t('form.clear_selection')}
          // Overlaid on the trigger, not nested in it: Radix's trigger is
          // itself a `<button>`, and a button inside a button is invalid HTML
          // that browsers resolve by dropping the inner one. `inset-y-0 my-auto`
          // centres it on the trigger whatever height the trigger resolves to,
          // and `right-8` clears the chevron (12px padding + 16px icon = 28px)
          // without depending on the trigger's own padding.
          className={cn(
            'absolute inset-y-0 right-8 my-auto flex size-6 items-center justify-center',
            'rounded-md text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
