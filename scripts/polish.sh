#!/usr/bin/env bash
# polish.sh - Continuous polishing protocol for HCD Title Transfer Agent.
# Runs as: npm run polish
# Re-execute after every codebase change to enforce quality gates.
set -euo pipefail
cd "$(dirname "$0")/.."  # project_source root

echo "=== POLISH PROTOCOL ==="

# 1. Type safety
echo "[1/7] TypeScript strict check..."
npx tsc --noEmit

# 2. Lint + format
echo "[2/7] ESLint..."
npm run lint

# 3. Unit + contract tests
echo "[3/7] Vitest..."
npx vitest run --reporter=default

# 4. Build verification
echo "[4/7] Next.js build..."
npm run build

# 5. Artifact check - no stray logs, temp files, or secrets
# NOTE: .env is excluded from stray check (needed locally; P10 handles submission cleanup)
echo "[5/7] Artifact sweep..."
STRAY=$(find . -maxdepth 1 \( -name '*.log' -o -name 'response.*' \) 2>/dev/null || true)
if [ -n "$STRAY" ]; then
  echo "FAIL: Stray files found: $STRAY"
  exit 1
fi
if [ -d .agent ]; then
  echo "FAIL: .agent/ directory exists"
  exit 1
fi

# 6. Overview sync check - DETAILED_PROJECT_OVERVIEW.md must exist and have all sections
echo "[6/7] Overview sync..."
for SECTION in "Purpose" "Architecture" "Module Index" "API Reference" "State Machine" "MCP Server" "Copilot CLI" "Component Tree" "Test Matrix" "Configuration" "Environment" "File Tree"; do
  grep -q "$SECTION" DETAILED_PROJECT_OVERVIEW.md || { echo "FAIL: Overview missing section: $SECTION"; exit 1; }
done

# 7. Unused export heuristic - flag any exported symbol with zero external imports
echo "[7/7] Dead export scan..."
# (This is a heuristic; manual review may be needed for re-exports)
DEAD_EXPORTS=0
for FILE in $(find src/lib -name '*.ts' -not -name '*.test.ts'); do
  EXPORTS=$(grep -oE 'export (function|const|type|interface|class|enum) [A-Za-z_][A-Za-z0-9_]*' "$FILE" 2>/dev/null | awk '{print $NF}' || true)
  for EXP in $EXPORTS; do
    COUNT=$(grep -rl "$EXP" src/ tests/ --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v "$FILE" | wc -l || true)
    if [ "$COUNT" -eq 0 ]; then
      echo "  WARN: $FILE exports '$EXP' with 0 external consumers"
      DEAD_EXPORTS=$((DEAD_EXPORTS + 1))
    fi
  done
done
if [ "$DEAD_EXPORTS" -gt 0 ]; then
  echo "  ($DEAD_EXPORTS potential dead exports - review manually)"
fi

echo "=== POLISH PROTOCOL: ALL GREEN ==="
