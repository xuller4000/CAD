"""Builds CadQuery 3D models from structured operation dicts and exports to STEP."""

from __future__ import annotations

import cadquery as cq


# ---------------------------------------------------------------------------
# Shape factory
# ---------------------------------------------------------------------------

def _make_shape(op_type: str, params: dict) -> cq.Workplane:
    t = op_type.lower()

    if t == "box":
        return cq.Workplane("XY").box(
            params["length"],
            params["width"],
            params["height"],
        )

    if t == "cylinder":
        radius = params.get("radius") or params["diameter"] / 2
        return cq.Workplane("XY").cylinder(params["height"], radius)

    if t == "sphere":
        radius = params.get("radius") or params["diameter"] / 2
        return cq.Workplane("XY").sphere(radius)

    if t == "cone":
        solid = cq.Solid.makeCone(
            params.get("radius1", 10),
            params.get("radius2", 0),
            params["height"],
        )
        return cq.Workplane("XY").add(solid)

    if t == "torus":
        solid = cq.Solid.makeTorus(params["radius1"], params["radius2"])
        return cq.Workplane("XY").add(solid)

    raise ValueError(f"Unsupported shape type: '{op_type}'")


# ---------------------------------------------------------------------------
# Model builder
# ---------------------------------------------------------------------------

def build(spec: dict) -> cq.Workplane:
    """Build a CadQuery model from the structured spec returned by interpreter."""
    operations = spec.get("operations", [])
    if not operations:
        raise ValueError("No operations found in spec.")

    result: cq.Workplane | None = None

    for op in operations:
        op_type = op.get("type", "")
        params = op.get("params", {})
        pos = op.get("position", {})
        boolean = op.get("operation", "create").lower()

        shape = _make_shape(op_type, params)

        # Apply position offset
        x, y, z = pos.get("x", 0), pos.get("y", 0), pos.get("z", 0)
        if x or y or z:
            shape = shape.translate((x, y, z))

        if result is None or boolean == "create":
            result = shape
        elif boolean == "union":
            result = result.union(shape)
        elif boolean == "cut":
            result = result.cut(shape)
        elif boolean == "intersect":
            result = result.intersect(shape)
        else:
            raise ValueError(f"Unknown boolean operation: '{boolean}'")

    # Apply fillets
    for fillet in spec.get("fillets", []):
        radius = fillet.get("radius", 1)
        edges = fillet.get("edges", "all")
        if edges == "all":
            result = result.edges().fillet(radius)

    # Apply chamfers
    for chamfer in spec.get("chamfers", []):
        distance = chamfer.get("distance", 1)
        edges = chamfer.get("edges", "all")
        if edges == "all":
            result = result.edges().chamfer(distance)

    return result


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def export_step(model: cq.Workplane, output_path: str) -> None:
    """Write the model to a STEP file."""
    cq.exporters.export(model, output_path)
