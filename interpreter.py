"""Converts natural language text into structured CAD operations via Claude API."""

import json
import os
import anthropic

SYSTEM_PROMPT = """You are a CAD design assistant. Convert the user's description into a JSON object
describing 3D geometry operations for CadQuery.

Return ONLY valid JSON with this structure:

{
  "name": "model name (snake_case)",
  "unit": "mm",
  "operations": [
    {
      "type": "box",
      "params": {"length": 50, "width": 30, "height": 20},
      "position": {"x": 0, "y": 0, "z": 0},
      "operation": "create"
    }
  ],
  "fillets": [],
  "chamfers": []
}

Supported shape types and their params:
  box          -> length, width, height
  cylinder     -> radius (or diameter), height
  sphere       -> radius (or diameter)
  cone         -> radius1 (base), radius2 (top), height
  torus        -> radius1 (major), radius2 (minor)

"operation" field:
  "create"    -> first shape (or union with previous result)
  "union"     -> boolean union with previous result
  "cut"       -> boolean subtraction from previous result
  "intersect" -> boolean intersection with previous result

"position": offset from origin (center of bounding box)

"fillets": list of {radius, edges: "all"}
"chamfers": list of {distance, edges: "all"}

Examples:
- "A 40x20x10mm box with a 5mm hole through the top"
  -> box create + cylinder cut (centered, radius 2.5, height 12)

- "A cylinder with a hollow inside"
  -> outer cylinder create + inner cylinder cut

Always use millimeters. Return ONLY the JSON object, no markdown, no explanation."""


def interpret(text: str, api_key: str | None = None) -> dict:
    """Parse a text description into structured CAD operations."""
    client = anthropic.Anthropic(api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"))

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": text}],
    )

    raw = message.content[0].text.strip()

    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.rsplit("```", 1)[0].strip()

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Claude returned invalid JSON:\n{raw}") from exc
