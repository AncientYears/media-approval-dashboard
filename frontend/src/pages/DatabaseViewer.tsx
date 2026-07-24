import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../components/Toast";

interface TableData {
  columns: string[];
  rows: any[];
}

export default function DatabaseViewer() {
  const [data, setData] = useState<Record<string, TableData>>({});
  const [activeTable, setActiveTable] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"json" | "csv" | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    api.get("/db")
      .then((res) => {
        setData(res.data);
        const tables = Object.keys(res.data);
        if (tables.length > 0) setActiveTable(tables[0]);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const tables = Object.keys(data);

  async function copyJSON() {
    if (!active || !activeTable) return;
    const text = JSON.stringify({ [activeTable]: active }, null, 2);
    await navigator.clipboard.writeText(text);
    toast(`Copied ${activeTable} as JSON`, "success");
    setCopied("json");
    setTimeout(() => setCopied(null), 1500);
  }

  async function copyCSV() {
    if (!active || !activeTable) return;
    const header = active.columns.join(",");
    const lines = active.rows.map((row) =>
      active.columns.map((col) => {
        const v = row[col];
        if (v === null || v === undefined) return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      }).join(",")
    );
    const text = header + "\n" + lines.join("\n");
    await navigator.clipboard.writeText(text);
    toast(`Copied ${activeTable} as CSV`, "success");
    setCopied("csv");
    setTimeout(() => setCopied(null), 1500);
  }

  if (loading) return <div className="db-loading">Loading database...</div>;
  if (error) return <div className="db-error">Error: {error}</div>;
  if (tables.length === 0) return <div className="db-empty">No tables found.</div>;

  const active = data[activeTable];

  return (
    <div className="db-viewer">
      <div className="db-tabs">
        {tables.map((t) => (
          <button
            key={t}
            className={`db-tab ${t === activeTable ? "active" : ""}`}
            onClick={() => setActiveTable(t)}
          >
            {t}
            <span className="db-tab-count">{data[t].rows.length}</span>
          </button>
        ))}
      </div>
      <div className="db-actions">
        <button className="db-copy-btn" onClick={copyJSON} disabled={!active}>
          {copied === "json" ? "Copied!" : "Copy JSON"}
        </button>
        <button className="db-copy-btn" onClick={copyCSV} disabled={!active}>
          {copied === "csv" ? "Copied!" : "Copy CSV"}
        </button>
      </div>
      <div className="db-table-wrap">
        {active && active.rows.length === 0 ? (
          <div className="db-empty-table">Table is empty</div>
        ) : (
          <table className="db-table">
            <thead>
              <tr>
                {active?.columns.map((col) => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active?.rows.map((row, i) => (
                <tr key={i}>
                  {active.columns.map((col) => (
                    <td key={col} title={String(row[col] ?? "")}>
                      {formatCell(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {active && (
        <div className="db-footer">
          {active.rows.length} row{active.rows.length !== 1 ? "s" : ""} &middot;{" "}
          {active.columns.length} column{active.columns.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

function formatCell(value: any): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string" && value.length > 120) return value.slice(0, 120) + "...";
  return String(value);
}
