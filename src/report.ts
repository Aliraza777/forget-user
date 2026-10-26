import pc from "picocolors";
import type { Executed } from "./run.js";
import type { Action, ServiceResult, Status, Subject } from "./types.js";

const ACTION: Record<Action, string> = {
  delete: pc.red("DELETE"),
  scrub: pc.yellow("SCRUB "),
  retain: pc.cyan("RETAIN"),
};

const STATUS: Record<Status, string> = {
  deleted: pc.green("✓ deleted "),
  scrubbed: pc.green("✓ scrubbed"),
  retained: pc.cyan("• retained"),
  pending: pc.yellow("… pending "),
  failed: pc.red("✗ failed  "),
};

const who = (s: Subject) => `${s.email}${s.userId ? ` / ${s.userId}` : ""}`;

function header(title: string, subject: Subject, n: number): string {
  return `${pc.bold("forget-user")} ${pc.dim(`· ${title} ·`)} ${who(subject)} ${pc.dim(`· ${n} service${n === 1 ? "" : "s"}`)}`;
}

function manual(results: { name: string; manual: string[] }[]): string[] {
  const items = results.flatMap((r) => r.manual.map((m) => `${r.name}: ${m}`));
  if (!items.length) return [];
  return ["", pc.bold("  Handle by hand"), ...items.map((m) => pc.dim(`    • ${m}`))];
}

/** The plan: what each service holds and what would happen to it. */
export function renderPlan(subject: Subject, results: ServiceResult[], dryRun: boolean): string {
  const out = ["", header(dryRun ? "plan" : "found", subject, results.length), ""];
  for (const r of results) {
    if (r.error) {
      out.push(`  ${pc.bold(r.name)}  ${pc.red("ERROR")} ${r.error}`);
      continue;
    }
    if (!r.found.length) {
      out.push(`  ${pc.bold(r.name)}  ${pc.dim("nothing found")}`);
      continue;
    }
    out.push(`  ${pc.bold(r.name)}`);
    for (const f of r.found) {
      out.push(`    ${ACTION[f.action]}  ${f.label}`);
      if (f.reason) out.push(pc.dim(`            ↳ ${f.reason}`));
      for (const w of f.warnings ?? []) out.push(`            ${pc.yellow("⚠")} ${w}`);
    }
  }
  out.push(...manual(results));
  const total = results.reduce((n, r) => n + r.found.length, 0);
  out.push("");
  if (results.some((r) => r.error))
    out.push(pc.red("  Some services couldn't be checked. Fix the errors above before deleting."));
  else if (dryRun)
    out.push(
      total
        ? `  ${pc.bold("Dry run: nothing was changed.")} Run again with ${pc.bold("--confirm")} to apply.`
        : pc.green("  ✓ Nothing to delete."),
    );
  out.push("");
  return out.join("\n");
}

/** The result of applying the plan, including whether each delete was confirmed afterwards. */
export function renderResult(subject: Subject, executed: Executed[], receiptPath?: string): string {
  const out = ["", header("result", subject, executed.length), ""];
  for (const e of executed) {
    if (!e.outcomes.length && !e.error) {
      out.push(`  ${pc.bold(e.name)}  ${pc.dim("nothing found")}`);
      continue;
    }
    out.push(`  ${pc.bold(e.name)}${e.error ? `  ${pc.red("ERROR")} ${e.error}` : ""}`);
    for (const o of e.outcomes) {
      const check =
        o.verified === true
          ? pc.dim(" (checked: gone)")
          : o.verified === false
            ? pc.red(" (still found afterwards)")
            : "";
      out.push(`    ${STATUS[o.status]}  ${o.label}${check}`);
      const detail = o.error ?? o.reason ?? o.note;
      if (detail) out.push(pc.dim(`              ↳ ${detail}`));
    }
  }
  out.push(...manual(executed));
  out.push("");
  if (receiptPath) out.push(`  Receipt written to ${pc.bold(receiptPath)}`, "");
  return out.join("\n");
}

/** True when anything failed, errored, or was still found after deleting. */
export function hasProblems(executed: Executed[]): boolean {
  return executed.some(
    (e) => e.error || e.outcomes.some((o) => o.status === "failed" || o.verified === false),
  );
}
