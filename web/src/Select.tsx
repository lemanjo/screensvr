import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

type Option = { value: string; label: string };

function normalize(text: string) {
  return text.replaceAll("_", " ").toLowerCase();
}

export function Select({
  label,
  value,
  options,
  onChange,
  searchable = false,
  onSearch,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  searchable?: boolean;
  onSearch?: (query: string) => void;
}) {
  const id = useId();
  const control = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const selected = options.find((option) => option.value === value);
  const filtered = options.filter(
    (option) =>
      normalize(option.label).includes(normalize(query.trim())) ||
      normalize(option.value).includes(normalize(query.trim())),
  );

  function showOptions() {
    setQuery("");
    onSearch?.("");
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    typeahead.current = { text: "", time: 0 };
    setOpen(true);
  }

  function choose(option: Option) {
    onChange(option.value);
    setOpen(false);
    control.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }

  // Render outside the dialog's scroll containers so the menu is never clipped.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = control.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < Math.min(280, above);
      setPosition({
        left: rect.left,
        width: rect.width,
        maxHeight: Math.max(0, Math.min(280, upwards ? above : below)),
        top: upwards ? undefined : rect.bottom + 6,
        bottom: upwards ? window.innerHeight - rect.top + 6 : undefined,
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (
        !control.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open, activeIndex, query]);

  function keyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) showOptions();
      else if (filtered.length)
        setActiveIndex(
          (activeIndex +
            (event.key === "ArrowDown" ? 1 : -1) +
            filtered.length) %
            filtered.length,
        );
    } else if (event.key === "Enter" || (!searchable && event.key === " ")) {
      event.preventDefault();
      if (!open) showOptions();
      else if (filtered[activeIndex]) choose(filtered[activeIndex]);
    } else if (
      open &&
      !searchable &&
      (event.key === "Home" || event.key === "End")
    ) {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : filtered.length - 1);
    } else if (
      !searchable &&
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      if (!open) showOptions();
      const now = Date.now();
      const text =
        (now - typeahead.current.time < 700 ? typeahead.current.text : "") +
        event.key.toLowerCase();
      typeahead.current = { text, time: now };
      const match = options.findIndex((option) =>
        normalize(option.label).startsWith(text),
      );
      if (match !== -1) setActiveIndex(match);
    }
  }

  const common = {
    id,
    role: "combobox",
    "aria-labelledby": `${id}-label`,
    "aria-expanded": open,
    "aria-controls": open ? `${id}-list` : undefined,
    "aria-haspopup": "listbox" as const,
    "aria-activedescendant":
      open && filtered[activeIndex] ? `${id}-option-${activeIndex}` : undefined,
    onKeyDown: keyDown,
    onBlur: () => setOpen(false),
  };

  return (
    <div className="select-field">
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      <div ref={control} className="select-control" data-open={open}>
        {searchable ? (
          <input
            {...common}
            className="select-trigger"
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            placeholder={open ? "Type to search…" : "Choose an option"}
            value={open ? query : (selected?.label ?? value)}
            onFocus={(event) => event.currentTarget.select()}
            onClick={() => {
              if (!open) showOptions();
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              onSearch?.(event.target.value);
              setActiveIndex(0);
              setOpen(true);
            }}
          />
        ) : (
          <button
            {...common}
            type="button"
            className="select-trigger"
            onClick={() => (open ? setOpen(false) : showOptions())}
          >
            <span>{selected?.label ?? "Choose an option"}</span>
          </button>
        )}
        <svg
          className="select-chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={`${id}-list`}
            role="listbox"
            aria-labelledby={`${id}-label`}
            className="select-menu"
            style={position}
          >
            {filtered.map((option, index) => (
              <div
                id={`${id}-option-${index}`}
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                data-active={index === activeIndex}
                className="select-option"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="select-empty" role="status">
                No matching options.
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
