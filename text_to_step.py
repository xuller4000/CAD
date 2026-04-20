#!/usr/bin/env python3
"""
Text-to-STEP generator
======================
Convert a natural language description of a 3D part into a STEP file
using the Claude API for interpretation and CadQuery for geometry.

Usage
-----
    python text_to_step.py "A 50x30x20mm box with a 10mm hole through the center"
    python text_to_step.py --file examples/bracket.txt --output bracket.step
    python text_to_step.py --dry-run "A hollow cylinder, outer radius 20mm, inner radius 15mm, height 40mm"
"""

import argparse
import json
import os
import sys

from interpreter import interpret
from builder import build, export_step


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def resolve_output(spec: dict, requested: str | None) -> str:
    if requested:
        return requested
    name = spec.get("name", "model").replace(" ", "_")
    if not name.endswith(".step"):
        name += ".step"
    return name


def print_spec(spec: dict) -> None:
    print("\n--- Interpreted CAD spec ---")
    print(json.dumps(spec, indent=2))
    print("----------------------------\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert a text description to a STEP file via Claude + CadQuery."
    )

    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("text", nargs="?", help="Description of the 3D part")
    src.add_argument("--file", "-f", metavar="PATH", help="Read description from a text file")

    parser.add_argument(
        "--output", "-o", metavar="PATH",
        help="Output STEP file path (default: <model_name>.step)",
    )
    parser.add_argument(
        "--api-key", metavar="KEY",
        help="Anthropic API key (default: ANTHROPIC_API_KEY env var)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the interpreted spec only; do not build or write a file",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Print the interpreted spec before building",
    )

    args = parser.parse_args()

    # ---- Read description ----
    if args.file:
        with open(args.file, "r", encoding="utf-8") as fh:
            description = fh.read().strip()
    else:
        description = args.text.strip()

    if not description:
        parser.error("Description is empty.")

    api_key = args.api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit(
            "Error: No API key provided. Set ANTHROPIC_API_KEY or use --api-key."
        )

    # ---- Interpret ----
    print(f"Interpreting description via Claude API...")
    try:
        spec = interpret(description, api_key=api_key)
    except Exception as exc:
        sys.exit(f"Interpretation failed: {exc}")

    if args.verbose or args.dry_run:
        print_spec(spec)

    if args.dry_run:
        print("Dry-run mode: skipping build and export.")
        return

    # ---- Build ----
    output_path = resolve_output(spec, args.output)
    print(f"Building 3D model...")
    try:
        model = build(spec)
    except Exception as exc:
        sys.exit(f"Build failed: {exc}")

    # ---- Export ----
    print(f"Exporting to {output_path}...")
    try:
        export_step(model, output_path)
    except Exception as exc:
        sys.exit(f"Export failed: {exc}")

    print(f"Done. STEP file written to: {output_path}")


if __name__ == "__main__":
    main()
