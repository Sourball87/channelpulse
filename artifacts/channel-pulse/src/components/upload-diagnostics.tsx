import type { UploadDiagnostics as Diagnostics } from "@workspace/api-client-react";

export function UploadDiagnostics({ diagnostics, compact = false }: { diagnostics?: Diagnostics; compact?: boolean }) {
  if (!diagnostics) return null;
  return (
    <div className={compact ? "mt-2 text-xs space-y-1" : "mt-3 text-sm space-y-2"}>
      {diagnostics.ready_to_commit && (
        <p className="text-emerald-700 dark:text-emerald-400">
          Checks passed. Ready for your confirmation; this pending upload has not been committed.
        </p>
      )}
      <ul className="space-y-1 list-disc pl-4 text-amber-800 dark:text-amber-300">
        {diagnostics.review_reasons.map(reason => <li key={reason.code}>{reason.message}</li>)}
      </ul>
      {!compact && (
        <>
          <p className="text-muted-foreground">
            Week source: {({ filename: "report filename", batch: "your batch selection", manual: "your confirmation",
              ai_suggested: "AI suggestion — not confirmed" } as Record<string, string>)[diagnostics.week_source ?? ""] ?? "not established"}.
          </p>
          {diagnostics.metadata_missing && (
            <p className="text-muted-foreground">
              Original sheet metadata was not saved. Recheck uses only saved source cells and the filename;
              select missing details yourself or re-upload the original if needed.
            </p>
          )}
          {diagnostics.ai && (
            <div className="rounded border border-border bg-background/60 p-3 text-muted-foreground">
              <p className="font-medium">AI recognition: {diagnostics.ai.message}</p>
              {diagnostics.ai.evidence?.length ? (
                <ul className="mt-2 list-disc pl-4 space-y-1 break-words">
                  {diagnostics.ai.evidence.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
