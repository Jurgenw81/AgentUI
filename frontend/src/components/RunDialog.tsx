import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Hand, Play } from "lucide-react";
import { api, type Graph } from "../api";
import { Modal, useToast } from "./ui";

export function RunDialog({
  open, onClose, target, graph,
}: {
  open: boolean;
  onClose: () => void;
  target: { kind: "agent" | "workflow"; id: string; name: string } | null;
  graph?: Graph;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [autonomous, setAutonomous] = useState(false);
  const [approvals, setApprovals] = useState<{ ask: number; ai: number }>({ ask: 0, ai: 0 });

  useEffect(() => {
    if (!open || target?.kind !== "workflow") return;
    Promise.all([api.workflow(target.id), api.settings()]).then(([wf, st]) => {
      setAutonomous(wf.autonomous ?? st.autonomous_default ?? false);
      const steps = (graph ?? wf.graph).nodes.filter((n) => n.type === "approval");
      setApprovals({ ask: steps.filter((n) => (n.data.mode ?? "ask") === "ask").length, ai: steps.filter((n) => n.data.mode === "ai").length });
    }).catch(() => {});
  }, [open, target, graph]);
  const nav = useNavigate();
  const toast = useToast();

  const start = async () => {
    if (!target || !input.trim()) return;
    setBusy(true);
    try {
      const run = await api.startRun(
        target.kind === "agent" ? { agent_id: target.id, input } : { workflow_id: target.id, input, graph, autonomous },
      );
      onClose();
      setInput("");
      nav(`/runs/${run.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<>Run <span className="text-indigo-600 dark:text-indigo-400">{target?.name}</span></>}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!input.trim() || busy} onClick={start}>
            <Play size={15} /> {busy ? "Starting…" : "Start run"}
          </button>
        </>
      }
    >
      <label className="label">What should {target?.kind === "agent" ? "the agent" : "the team"} do?</label>
      <textarea
        autoFocus
        rows={6}
        className="input resize-y"
        placeholder="e.g. Research the best open-source vector databases and write a comparison table"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && start()}
      />
      <p className="hint">Press Ctrl+Enter to start. You'll watch every step live.</p>

      {target?.kind === "workflow" && (
        <div className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
          <div className="flex items-center gap-3">
            {autonomous ? <Bot size={18} className="text-indigo-600" /> : <Hand size={18} className="text-amber-600" />}
            <div className="flex-1">
              <div className="text-sm font-medium">{autonomous ? "Run autonomously" : "Supervised run"}</div>
              <div className="text-xs text-zinc-500">
                {approvals.ask + approvals.ai === 0
                  ? "This workflow has no approval steps, so it runs through on its own either way."
                  : autonomous
                    ? "It won't stop to ask you. Approval steps are approved automatically, and AI-check concerns are passed on to the next steps."
                    : `It may pause at ${approvals.ask + approvals.ai} approval step${approvals.ask + approvals.ai === 1 ? "" : "s"}${approvals.ai ? " (AI-checked ones only if there's a problem)" : ""}.`}
              </div>
            </div>
            <button role="switch" aria-checked={autonomous} onClick={() => setAutonomous(!autonomous)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${autonomous ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700"}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${autonomous ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
