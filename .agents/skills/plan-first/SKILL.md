---
name: plan-first
description: Use for broad, ambiguous, or high-risk coding requests where the user wants planning before implementation. Create a scoped plan, get approval, inspect relevant code, then present an implementation plan before editing.
---

# Plan First

Use this skill when planning is the deliverable, or when a coding request is too broad, ambiguous, or risky to implement directly. Do not use it for simple fixes, explanations, reviews, or requests where the user clearly wants immediate action.

## Principles

- Separate explicit requirements, assumptions, unknowns, and non-goals.
- Ask only blocking or scope-changing questions; otherwise make conservative assumptions and label them.
- Keep scope minimal while satisfying the stated task.
- Do not edit files until the user approves the implementation plan.
- If discovery changes the task materially, pause and revise the plan.

## Workflow

1. Read `./AGENTS.md`. Optionally do a tiny read-only preflight of named files, nearby repo docs, or directory shape if needed to make the task plan concrete.

2. Present a concise task plan before editing:

- Restatement
- Scope
- Assumptions or questions
- Non-goals
- Steps

Omit empty sections. Make the plan concrete enough to evaluate, but avoid detailed file-level edits until after code navigation.

3. Incorporate feedback until the user approves or asks to proceed. Rewrite the full plan only when feedback changes scope, goals, or ordering; otherwise acknowledge the amendment and continue.

4. Inspect relevant code read-only. Use `rg`, nearby docs, existing patterns, tests, entry points, and likely affected files. Summarize only findings that affect the implementation plan.

5. Present an implementation plan before editing:

- Findings that affect the change
- Files to edit
- Validation
- Risks or open decisions

Keep changes minimal and directly tied to the approved task plan.

6. After approval, implement. If new information materially changes scope or invalidates the plan, stop and update the plan for review.

7. Finish with changed files, validation run, and remaining risks.
