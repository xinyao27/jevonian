import { Autocomplete as BaseAutocomplete } from "@base-ui-components/react/autocomplete";
import { Combobox as BaseCombobox } from "@base-ui-components/react/combobox";
import { CheckIcon, ChevronDownIcon, ChevronsUpDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
}

const INPUT_CLASS =
  "h-9 w-full rounded-md border bg-background px-3 py-2 pr-8 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const ITEM_CLASS =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground";

type PopupParts = {
  Portal: typeof BaseCombobox.Portal;
  Positioner: typeof BaseCombobox.Positioner;
  Popup: typeof BaseCombobox.Popup;
  Empty: typeof BaseCombobox.Empty;
  List: typeof BaseCombobox.List;
  Item: typeof BaseCombobox.Item;
  ItemIndicator: typeof BaseCombobox.ItemIndicator;
};

function SharedPopup({
  parts,
  options,
  emptyText,
  showCheck,
  render,
}: {
  parts: PopupParts;
  options: ComboboxOption[];
  emptyText: string;
  showCheck: boolean;
  render: (item: string, hint: string) => ReactNode;
}) {
  const hints = new Map(options.map((option) => [option.value, option.hint]));
  const { Portal, Positioner, Popup, Empty, List, Item, ItemIndicator } = parts;
  return (
    <Portal>
      <Positioner sideOffset={4} align="start" className="z-50 w-(--anchor-width)">
        <Popup
          data-slot="combobox-content"
          className="max-h-72 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-sm"
        >
          <Empty className="py-6 text-center text-sm text-muted-foreground empty:hidden">
            {emptyText}
          </Empty>
          <List className="max-h-72 overflow-y-auto p-1">
            {(item: string) => (
              <Item key={item} value={item} className={ITEM_CLASS}>
                {render(item, hints.get(item) ?? "")}
                {showCheck ? (
                  <ItemIndicator className="flex size-4 items-center justify-center">
                    <CheckIcon className="size-4" />
                  </ItemIndicator>
                ) : null}
              </Item>
            )}
          </List>
        </Popup>
      </Positioner>
    </Portal>
  );
}

/** Picks exactly one of `options`; the input only ever holds a listed value. */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder = "Select…",
  emptyText = "No results.",
  className,
  disabled,
}: {
  id?: string;
  value?: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <BaseCombobox.Root
      items={options.map((option) => option.value)}
      value={value ?? null}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      disabled={disabled}
    >
      <div className={cn("relative w-full", className)}>
        <BaseCombobox.Input
          id={id}
          data-slot="combobox-input"
          placeholder={placeholder}
          className={INPUT_CLASS}
        />
        <BaseCombobox.Trigger className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground">
          <ChevronsUpDownIcon className="size-4 opacity-50" />
        </BaseCombobox.Trigger>
      </div>
      <SharedPopup
        parts={BaseCombobox}
        options={options}
        emptyText={emptyText}
        showCheck
        render={(item, hint) => (
          <>
            <span className="flex-1 truncate">{item}</span>
            {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
          </>
        )}
      />
    </BaseCombobox.Root>
  );
}

/**
 * Free text with suggestions. Unlike {@link Combobox} the input is the value, so any
 * exact id is accepted — `options` only narrows the list while typing. Use this when
 * a field is not limited to a fixed set (a model id, a custom slug).
 */
export function Autocomplete({
  id,
  value,
  onChange,
  options,
  placeholder = "Type or pick…",
  emptyText = "No matches — the typed value is used as-is.",
  className,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <BaseAutocomplete.Root
      items={options.map((option) => option.value)}
      value={value}
      onValueChange={(next: string) => onChange(next)}
      disabled={disabled}
    >
      <div className={cn("relative w-full", className)}>
        <BaseAutocomplete.Input
          id={id}
          data-slot="combobox-input"
          placeholder={placeholder}
          className={INPUT_CLASS}
        />
        <BaseAutocomplete.Trigger className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className="size-4 opacity-50" />
        </BaseAutocomplete.Trigger>
      </div>
      <SharedPopup
        parts={BaseAutocomplete as unknown as PopupParts}
        options={options}
        emptyText={emptyText}
        showCheck={false}
        render={(item, hint) => (
          <>
            <span className="flex-1 truncate">{item}</span>
            {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
          </>
        )}
      />
    </BaseAutocomplete.Root>
  );
}
