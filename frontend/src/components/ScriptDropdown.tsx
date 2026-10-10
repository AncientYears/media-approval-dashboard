import { useState, useEffect, useRef } from "react";
import { fetchWorkspaceScripts } from "../api";

export interface ScriptOption {
  id: string;
  label: string;
  description?: string;
}

// Module-level cache: script definitions are static on the server, so fetch
// once per session. `null` = not fetched yet.
let SCRIPT_OPTIONS_CACHE: ScriptOption[] | null = null;

export function useScriptOptions(): ScriptOption[] {
  const [options, setOptions] = useState<ScriptOption[]>(SCRIPT_OPTIONS_CACHE || []);
  useEffect(() => {
    if (SCRIPT_OPTIONS_CACHE) return;
    fetchWorkspaceScripts()
      .then((data) => {
        SCRIPT_OPTIONS_CACHE = data.scripts || [];
        setOptions(SCRIPT_OPTIONS_CACHE);
      })
      .catch(() => {});
  }, []);
  return options;
}

export default function ScriptDropdown({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = useScriptOptions();

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

  // A stored script id with no definition (removed/renamed) still renders, so it
  // can be seen and removed rather than silently vanishing from the workspace.
  const labelFor = (id: string) => options.find((o) => o.id === id)?.label || id;

  return (
    <div className="script-dropdown" ref={ref}>
      <button type="button" className="script-dropdown-trigger" onClick={() => setOpen(!open)}>
        {value.length > 0 ? (
          <div className="script-tags">
            {value.map((s) => (
              <span key={s} className="script-tag">{labelFor(s)}</span>
            ))}
          </div>
        ) : (
          <span className="script-placeholder">{placeholder || "Select scripts..."}</span>
        )}
        <span className={`script-dropdown-arrow ${open ? "open" : ""}`}>&#9662;</span>
      </button>
      {open && (
        <div className="script-dropdown-menu">
          {options.length === 0 ? (
            <div className="script-dropdown-empty">No scripts available yet</div>
          ) : options.map((script) => (
            <label key={script.id} className="script-dropdown-item" title={script.description || ""}>
              <input type="checkbox" checked={value.includes(script.id)} onChange={() => toggle(script.id)} />
              <span>{script.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
