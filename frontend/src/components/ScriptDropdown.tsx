import { useState, useEffect, useRef } from "react";

export const SCRIPT_OPTIONS: string[] = [];

export default function ScriptDropdown({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const toggle = (script: string) => {
    onChange(value.includes(script) ? value.filter((s) => s !== script) : [...value, script]);
  };

  return (
    <div className="script-dropdown" ref={ref}>
      <button type="button" className="script-dropdown-trigger" onClick={() => setOpen(!open)}>
        {value.length > 0 ? (
          <div className="script-tags">
            {value.map((s) => (
              <span key={s} className="script-tag">{s}</span>
            ))}
          </div>
        ) : (
          <span className="script-placeholder">{placeholder || "Select scripts..."}</span>
        )}
        <span className={`script-dropdown-arrow ${open ? "open" : ""}`}>&#9662;</span>
      </button>
      {open && (
        <div className="script-dropdown-menu">
          {SCRIPT_OPTIONS.length === 0 ? (
            <div className="script-dropdown-empty">No scripts available yet</div>
          ) : SCRIPT_OPTIONS.map((script) => (
            <label key={script} className="script-dropdown-item">
              <input type="checkbox" checked={value.includes(script)} onChange={() => toggle(script)} />
              <span>{script}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
