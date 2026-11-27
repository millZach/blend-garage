"""
Blend Garage — Headless Blender CLI Car Exporter (Showroom-Optimized + Draco)

Runs inside Blender (3.6 / 4.x / 5.x):
  blender --background car.blend --python export_car.py -- \
    --output-dir <dir> --car-id <slug> --car-name <name> --source-file <file>

Features:
  - Auto-normalizes scale, lengthwise orientation, centering, and tire grounding (Y=0 in glTF)
  - Caps high offline Subsurf levels and adaptively decimates ultra-dense meshes to a real-time
    showroom triangle budget while preserving smooth shading & silhouettes
  - Groups multi-mesh wheels into 4 clean corner assemblies (wheel_FL, wheel_FR, wheel_RL, wheel_RR)
  - Filters fastener/hinge/bolt noise from swappable exterior parts
  - Smart material classification (fixes trim vs rim, windscreen glass, factory paint promotion)
  - Exports Draco-compressed model.glb + schema-v1 vehicle.json
"""

import argparse
import datetime
import json
import math
import os
import re
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Vector

_T0 = time.perf_counter()


def log_stage(msg):
    print(f"[stage {time.perf_counter() - _T0:6.2f}s] {msg}", flush=True)


IGNORED_BACKDROP_PATTERNS = (
    "studio_backdrop",
    "studio_floor",
    "studio_plane",
    "studio_wall",
    "studio_light",
    "backdrop",
    "cyclorama",
    "ground_plane",
    "garage_floor",
    "shadow_catcher",
)

NON_SPINNING_WHEEL_EXCLUSIONS = (
    "liner",
    "splash",
    "arch",
    "well",
    "caliper",
    "steering",
    "column",
    "mudguard",
    "housing",
    "strut",
    "knuckle",
    "suspension",
    "control_arm",
    "wishbone",
    "rotor",
    "disc_brake",
)

HARDWARE_PART_EXCLUSIONS = (
    "hinge",
    "pin",
    "latch",
    "bolt",
    "screw",
    "nut",
    "clip",
    "fixing",
    "fastener",
    "bracket",
    "mount",
    "seal",
    "gasket",
    "weatherstrip",
    "seam",
    "jamb",
    "shut face",
    "cassette",
    "seat",
    "liner",
    "frame",
    "inner",
    "support",
    "reinforce",
)

NON_PAINT_PROMOTION_KEYWORDS = (
    "shadow",
    "cavity",
    "polymer",
    "plastic",
    "rubber",
    "tire",
    "tyre",
    "metal",
    "iron",
    "steel",
    "chrome",
    "alloy",
    "graphite",
    "rotor",
    "brake",
    "glass",
    "window",
    "windscreen",
    "windshield",
    "lens",
    "lamp",
    "light",
    "led",
    "reflector",
    "interior",
    "leather",
    "fabric",
    "carpet",
    "carbon",
    "trim",
    "grille",
    "black",
    "dark",
    "exhaust",
    "underbody",
    "chassis_dark",
)


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    parser = argparse.ArgumentParser(description="Export .blend car to Blend Garage Car Package")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--car-id", required=True)
    parser.add_argument("--car-name", required=True)
    parser.add_argument("--source-file", required=True)
    parser.add_argument("--author", default="Garage Builder")
    parser.add_argument("--max-tris", type=int, default=0, help="Optional poly cap (0 = full fidelity, no decimation)")
    parser.add_argument("--no-draco", action="store_true")
    return parser.parse_args(argv)


def blender_to_gltf_vec3(v):
    """Convert Blender Z-up (X, Y, Z) to glTF/Three.js Y-up (X, Z, -Y)."""
    return [round(float(v.x), 4), round(float(v.z), 4), round(float(-v.y), 4)]


def linear_to_srgb_channel(c):
    c = max(0.0, min(1.0, float(c)))
    if c <= 0.0031308:
        return 12.92 * c
    return 1.055 * (c ** (1.0 / 2.4)) - 0.055


def rgba_to_hex(rgba):
    r = int(round(linear_to_srgb_channel(rgba[0]) * 255))
    g = int(round(linear_to_srgb_channel(rgba[1]) * 255))
    b = int(round(linear_to_srgb_channel(rgba[2]) * 255))
    return f"#{r:02x}{g:02x}{b:02x}"


def _srgb_to_linear_np(c):
    return np.where(c <= 0.04045, c / 12.92, np.power(np.maximum((c + 0.055) / 1.055, 0.0), 2.4))


def _linear_to_srgb_np(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


def _resize_rgba_bilinear(arr, new_w, new_h):
    h, w, _ = arr.shape
    if w == new_w and h == new_h:
        return arr
    ys = np.linspace(0.0, h - 1.0, new_h, dtype=np.float32)
    xs = np.linspace(0.0, w - 1.0, new_w, dtype=np.float32)
    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)
    wy = (ys - y0)[:, None, None]
    wx = (xs - x0)[None, :, None]
    top = arr[y0][:, x0] * (1.0 - wx) + arr[y0][:, x1] * wx
    bot = arr[y1][:, x0] * (1.0 - wx) + arr[y1][:, x1] * wx
    return top * (1.0 - wy) + bot * wy


def _parse_multi_uv_livery_graph(mat):
    """
    Detects chained multi-UV decal livery shaders that Blender's glTF exporter cannot preserve:
      - Pattern A: MIX_SHADER chain layering TEX_IMAGE + UVMAP Principled BSDFs over a base Principled BSDF.
      - Pattern B: MIX (Color) chain layering TEX_IMAGE + UVMAP images over a base RGB/color into Principled BSDF.
    Returns None or dict(base_rgba, metallic, roughness, coat, layers=[(uv_name, image, extension), ...])
    ordered bottom-to-top.
    """
    nt = getattr(mat, "node_tree", None)
    if not nt:
        return None
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.inputs.get("Surface") and n.inputs["Surface"].is_linked), None)
    if not out:
        return None

    top_node = out.inputs["Surface"].links[0].from_node

    def tex_and_uv_from_alpha(sock):
        if not sock or not sock.is_linked:
            return None
        lnk = sock.links[0]
        tn = lnk.from_node
        if tn.type != "TEX_IMAGE" or not tn.image or lnk.from_socket.name != "Alpha":
            return None
        vec = tn.inputs.get("Vector")
        if not vec or not vec.is_linked or vec.links[0].from_node.type != "UVMAP":
            return None
        uv_name = vec.links[0].from_node.uv_map
        if not uv_name:
            return None
        return tn, uv_name

    # Pattern A: MIX_SHADER chain
    if top_node.type == "MIX_SHADER":
        layers = []
        cur = top_node
        visited = set()
        while cur and cur.type == "MIX_SHADER" and cur not in visited:
            visited.add(cur)
            info = tex_and_uv_from_alpha(cur.inputs[0])
            if not info:
                return None
            tn, uv_name = info
            layers.append((uv_name, tn.image, tn.extension))
            if not cur.inputs[1].is_linked:
                return None
            cur = cur.inputs[1].links[0].from_node

        if len(layers) >= 2 and cur and cur.type == "BSDF_PRINCIPLED":
            layers.reverse()  # bottom-to-top
            bc = cur.inputs.get("Base Color")
            base_rgba = tuple(float(c) for c in bc.default_value[:4]) if bc and hasattr(bc, "default_value") else (0.8, 0.8, 0.8, 1.0)
            met = float(cur.inputs["Metallic"].default_value) if "Metallic" in cur.inputs else 0.0
            rgh = float(cur.inputs["Roughness"].default_value) if "Roughness" in cur.inputs else 0.25
            coat_in = cur.inputs.get("Coat Weight") or cur.inputs.get("Clearcoat")
            coat = float(coat_in.default_value) if coat_in else 0.0
            return {"base_rgba": base_rgba, "metallic": met, "roughness": rgh, "coat": coat, "layers": layers}
        return None

    # Pattern B: Principled BSDF with chained MIX (Color) nodes
    if top_node.type == "BSDF_PRINCIPLED":
        bc_in = top_node.inputs.get("Base Color")
        if not bc_in or not bc_in.is_linked:
            return None
        cur = bc_in.links[0].from_node
        if cur.type not in ("MIX", "MIX_RGB"):
            return None
        layers = []
        base_rgba = None
        visited = set()
        while cur and cur.type in ("MIX", "MIX_RGB") and cur not in visited:
            visited.add(cur)
            info = tex_and_uv_from_alpha(cur.inputs[0])
            if not info:
                return None
            tn, uv_name = info
            rgba_inputs = [inp for inp in cur.inputs if inp.type == "RGBA"]
            if len(rgba_inputs) < 2:
                return None
            inp_a, inp_b = rgba_inputs[0], rgba_inputs[1]
            if not inp_b.is_linked or inp_b.links[0].from_node != tn:
                return None
            layers.append((uv_name, tn.image, tn.extension))
            if inp_a.is_linked:
                src = inp_a.links[0].from_node
                if src.type == "RGB":
                    base_rgba = tuple(float(c) for c in src.outputs[0].default_value[:4])
                    break
                cur = src
            else:
                base_rgba = tuple(float(c) for c in inp_a.default_value[:4])
                break

        if len(layers) >= 2 and base_rgba is not None:
            layers.reverse()  # bottom-to-top

            def read_scalar(sock_name, fallback):
                sock = top_node.inputs.get(sock_name)
                if not sock:
                    return fallback
                if sock.is_linked:
                    src = sock.links[0].from_node
                    if src.type == "MIX":
                        f_inps = [i for i in src.inputs if i.type == "VALUE" and not i.is_linked]
                        if f_inps:
                            return float(f_inps[0].default_value)
                return float(sock.default_value)

            met = read_scalar("Metallic", 0.3)
            rgh = read_scalar("Roughness", 0.2)
            coat_name = "Coat Weight" if "Coat Weight" in top_node.inputs else "Clearcoat"
            coat = read_scalar(coat_name, 0.8)
            return {"base_rgba": base_rgba, "metallic": met, "roughness": rgh, "coat": coat, "layers": layers}
    return None


def _pack_livery_shelves(sizes, atlas_w, atlas_h, pad=16, reserve_bottom=80):
    """Packs (w, h) tiles onto horizontal shelves inside (atlas_w, atlas_h - reserve_bottom)."""
    usable_h = atlas_h - reserve_bottom
    scale = 1.0
    for _ in range(40):
        rects = [None] * len(sizes)
        order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
        x = pad
        y = reserve_bottom + pad
        row_h = 0
        ok = True
        for idx in order:
            tw = max(32, int(round(sizes[idx][0] * scale)))
            th = max(32, int(round(sizes[idx][1] * scale)))
            if tw + 2 * pad > atlas_w:
                ok = False
                break
            if x + tw + pad > atlas_w:
                x = pad
                y += row_h + pad
                row_h = 0
            if y + th + pad > atlas_h:
                ok = False
                break
            rects[idx] = (x, y, tw, th)
            x += tw + pad
            row_h = max(row_h, th)
        if ok:
            return rects, scale
        scale *= 0.94
    raise RuntimeError("Could not pack livery atlas tiles.")


def flatten_multi_uv_livery_materials(mesh_objects, hints):
    """
    Flattens multi-UV chained decal liveries (such as FF1 Toyota Supra body paintjobs)
    into a single glTF-2.0-native 4K texture atlas + single UV channel on CPU via NumPy,
    preserving full crisp artwork, metallic/roughness/clearcoat, and 1-click Paint Booth support.
    """
    mat_to_objs = {}
    for obj in mesh_objects:
        if not obj.data:
            continue
        for slot in obj.material_slots:
            if slot.material is not None:
                mat_to_objs.setdefault(slot.material, []).append(obj)

    for mat, objs in mat_to_objs.items():
        spec = _parse_multi_uv_livery_graph(mat)
        if not spec:
            continue

        layers = spec["layers"]
        base_lin = np.array(spec["base_rgba"][:3], dtype=np.float32)
        base_srgb = _linear_to_srgb_np(base_lin)

        # Read source images into NumPy arrays
        layer_arrays = []
        layer_sizes = []
        for uv_name, img, ext in layers:
            w, h = img.size[0], img.size[1]
            if w <= 0 or h <= 0:
                continue
            buf = np.empty(w * h * 4, dtype=np.float32)
            img.pixels.foreach_get(buf)
            arr = buf.reshape((h, w, 4))
            layer_arrays.append((uv_name, img.name, ext, arr))
            layer_sizes.append((w, h))

        if len(layer_arrays) < 2:
            continue

        ATLAS_W, ATLAS_H = 4096, 4096
        PAD = 16
        rects, pack_scale = _pack_livery_shelves(layer_sizes, ATLAS_W, ATLAS_H, pad=PAD, reserve_bottom=80)

        # Fill entire atlas with solid base paint color (sRGB, alpha=1)
        atlas = np.empty((ATLAS_H, ATLAS_W, 4), dtype=np.float32)
        atlas[..., 0] = base_srgb[0]
        atlas[..., 1] = base_srgb[1]
        atlas[..., 2] = base_srgb[2]
        atlas[..., 3] = 1.0

        # Composite each decal over base paint in linear space, then place into its atlas tile
        tile_uvs = []
        for (uv_name, img_name, ext, arr), (x0, y0, tw, th) in zip(layer_arrays, rects):
            resized = _resize_rgba_bilinear(arr, tw, th)
            src_lin = _srgb_to_linear_np(resized[..., :3])
            alpha = np.clip(resized[..., 3:4], 0.0, 1.0)
            comp_lin = base_lin[None, None, :] * (1.0 - alpha) + src_lin * alpha
            comp_srgb = _linear_to_srgb_np(comp_lin)
            atlas[y0 : y0 + th, x0 : x0 + tw, :3] = comp_srgb
            atlas[y0 : y0 + th, x0 : x0 + tw, 3] = 1.0
            tile_uvs.append((x0 / ATLAS_W, (x0 + tw) / ATLAS_W, y0 / ATLAS_H, (y0 + th) / ATLAS_H))

        # Plain base-paint swatch sits in the reserved bottom strip (y=0..64)
        plain_u = 32.0 / ATLAS_W
        plain_v = 32.0 / ATLAS_H

        atlas_name = f"BG_{slugify(mat.name)}_livery_atlas"
        atlas_img = bpy.data.images.new(atlas_name, width=ATLAS_W, height=ATLAS_H, alpha=False)
        atlas_img.colorspace_settings.name = "sRGB"
        atlas_img.pixels.foreach_set(atlas.ravel())
        atlas_img.pack()

        # Remap UVs on every mesh using this material (vectorized in NumPy)
        atlas_uv_name = "BG_LiveryAtlas"
        old_uv_names = {uv_name for uv_name, _, _, _ in layer_arrays}
        remapped_polys = 0
        seen_meshes = set()

        for obj in objs:
            me = obj.data
            if me in seen_meshes or not me.polygons:
                continue
            seen_meshes.add(me)

            body_slots = {i for i, m in enumerate(me.materials) if m == mat}
            if not body_slots:
                continue

            n_polys = len(me.polygons)
            n_loops = len(me.loops)
            loop_starts = np.empty(n_polys, dtype=np.int32)
            loop_totals = np.empty(n_polys, dtype=np.int32)
            mat_indices = np.empty(n_polys, dtype=np.int32)
            me.polygons.foreach_get("loop_start", loop_starts)
            me.polygons.foreach_get("loop_total", loop_totals)
            me.polygons.foreach_get("material_index", mat_indices)

            is_body_poly = np.isin(mat_indices, list(body_slots))
            if not np.any(is_body_poly):
                continue

            # Start with existing active UV for non-body faces, and plain swatch for body faces
            out_uv = np.empty((n_loops, 2), dtype=np.float32)
            if me.uv_layers.active:
                me.uv_layers.active.data.foreach_get("uv", out_uv.ravel())
            else:
                out_uv[:] = (plain_u, plain_v)

            is_body_loop = np.repeat(is_body_poly, loop_totals)
            out_uv[is_body_loop, 0] = plain_u
            out_uv[is_body_loop, 1] = plain_v

            # Apply each layer bottom-to-top so upper layers win on any overlap
            for (uv_name, _, ext, arr), (u0, u1, v0, v1) in zip(layer_arrays, tile_uvs):
                uvl = me.uv_layers.get(uv_name)
                if not uvl:
                    continue
                h, w, _ = arr.shape
                alpha_ch = arr[..., 3]
                luv = np.empty((n_loops, 2), dtype=np.float32)
                uvl.data.foreach_get("uv", luv.ravel())
                lu = luv[:, 0]
                lv = luv[:, 1]

                # Exclude polygons containing unprojected sentinel UVs (e.g. -2.0)
                in_margin = (lu >= -0.05) & (lu <= 1.05) & (lv >= -0.05) & (lv <= 1.05)
                poly_in_margin = np.minimum.reduceat(in_margin, loop_starts)

                # Sample alpha at vertices
                in_unit = (lu >= 0.0) & (lu <= 1.0) & (lv >= 0.0) & (lv <= 1.0)
                iu = np.clip((lu * (w - 1)).astype(np.int32), 0, w - 1)
                iv = np.clip((lv * (h - 1)).astype(np.int32), 0, h - 1)
                vert_hit = in_unit & (alpha_ch[iv, iu] > 0.004)
                poly_vert_hit = np.maximum.reduceat(vert_hit, loop_starts)

                # Also sample alpha at polygon UV centroid
                cu = np.add.reduceat(lu, loop_starts) / loop_totals
                cv = np.add.reduceat(lv, loop_starts) / loop_totals
                c_in_unit = (cu >= 0.0) & (cu <= 1.0) & (cv >= 0.0) & (cv <= 1.0)
                ciu = np.clip((cu * (w - 1)).astype(np.int32), 0, w - 1)
                civ = np.clip((cv * (h - 1)).astype(np.int32), 0, h - 1)
                poly_cent_hit = c_in_unit & (alpha_ch[civ, ciu] > 0.004)

                win_poly = is_body_poly & poly_in_margin & (poly_vert_hit | poly_cent_hit)
                hit_count = int(np.count_nonzero(win_poly))
                if hit_count == 0:
                    continue
                remapped_polys += hit_count

                win_loop = np.repeat(win_poly, loop_totals)
                pad_u = (PAD * 0.5) / max(1, (u1 - u0) * ATLAS_W)
                pad_v = (PAD * 0.5) / max(1, (v1 - v0) * ATLAS_H)
                su = np.clip(lu[win_loop], -pad_u, 1.0 + pad_u)
                sv = np.clip(lv[win_loop], -pad_v, 1.0 + pad_v)
                out_uv[win_loop, 0] = u0 + su * (u1 - u0)
                out_uv[win_loop, 1] = v0 + sv * (v1 - v0)

            # Determine which UV layers are referenced by OTHER materials on this mesh
            keep_uvs = set()
            for other_m in me.materials:
                if other_m is None or other_m == mat or not other_m.use_nodes or not other_m.node_tree:
                    continue
                for nd in other_m.node_tree.nodes:
                    if nd.type == "UVMAP" and nd.uv_map:
                        keep_uvs.add(nd.uv_map)
                # If another material has a TEX_IMAGE without explicit UVMAP, keep existing active UV
                if any(nd.type == "TEX_IMAGE" for nd in other_m.node_tree.nodes) and me.uv_layers.active:
                    keep_uvs.add(me.uv_layers.active.name)

            # Remove obsolete multi-projection UV layers not used by other materials
            for uvl in list(me.uv_layers):
                if uvl.name in old_uv_names and uvl.name not in keep_uvs:
                    me.uv_layers.remove(uvl)

            atlas_uv = me.uv_layers.get(atlas_uv_name) or me.uv_layers.new(name=atlas_uv_name)
            atlas_uv.data.foreach_set("uv", out_uv.ravel())
            atlas_uv.active = True
            atlas_uv.active_render = True

        # Rebuild material node tree into clean single-texture glTF-native Principled BSDF
        nt = mat.node_tree
        nt.nodes.clear()
        out_node = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        tex = nt.nodes.new("ShaderNodeTexImage")
        uv_node = nt.nodes.new("ShaderNodeUVMap")

        uv_node.uv_map = atlas_uv_name
        tex.image = atlas_img
        tex.extension = "EXTEND"

        bsdf.inputs["Base Color"].default_value = spec["base_rgba"]
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = spec["metallic"]
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = spec["roughness"]
        coat_in = bsdf.inputs.get("Coat Weight") or bsdf.inputs.get("Clearcoat")
        if coat_in:
            coat_in.default_value = spec["coat"]

        nt.links.new(uv_node.outputs["UV"], tex.inputs["Vector"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(bsdf.outputs["BSDF"], out_node.inputs["Surface"])

        log_stage(
            f"Flattened {len(layer_arrays)}-layer livery on '{mat.name}' -> 4K atlas "
            f"(scale {pack_scale:.2f}, {remapped_polys:,} decal polys)"
        )
        hints.append(
            f"Flattened {len(layer_arrays)}-layer multi-UV livery on '{mat.name}' into a single glTF texture atlas."
        )


def bake_object_projected_side_decals(mesh_objects, hints):
    """
    Detects Object-space planar side decals (such as Porsche 911 GT3 RS 'side_graphic.png'
    projected via Film car coords -> Separate XYZ -> Mix(bodyColor, decalColor)) and bakes
    them on CPU into a clean UV-mapped texture + glTF-native Principled BSDF so the decals
    export crisply without Cycles baking and still work with Paint Booth / Reset to stock.
    Must run BEFORE root_empty normalization so reference-object transforms remain exact.
    """
    mat_to_objs = {}
    for obj in mesh_objects:
        if not obj.data:
            continue
        for slot in obj.material_slots:
            if slot.material is not None:
                mat_to_objs.setdefault(slot.material, []).append(obj)

    for mat, objs in mat_to_objs.items():
        nt = getattr(mat, "node_tree", None)
        if not nt:
            continue
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        bc_in = bsdf.inputs.get("Base Color")
        if not bc_in or not bc_in.is_linked:
            continue
        mix_node = bc_in.links[0].from_node
        if mix_node.type not in ("MIX", "MIX_RGB"):
            continue

        # Look for an Object-space TEX_COORD + TEX_IMAGE driving Mix.Factor (side decal pattern)
        tc_node = next((n for n in nt.nodes if n.type == "TEX_COORD"), None)
        tex_node = next((n for n in nt.nodes if n.type == "TEX_IMAGE" and n.image), None)
        if not tc_node or not tex_node:
            continue
        # Confirm Mix has two unlinked RGBA colors (base paint A, decal ink B)
        rgba_inps = [i for i in mix_node.inputs if i.type == "RGBA" and not i.is_linked]
        if len(rgba_inps) < 2:
            continue
        # Confirm TEX_IMAGE Alpha feeds into Mix Factor (directly or through Math mask chain)
        alpha_out = tex_node.outputs.get("Alpha")
        if not alpha_out or not alpha_out.is_linked:
            continue
        # Check for Film car coords / Separate XYZ planar projection nodes
        sep_nodes = [n for n in nt.nodes if n.type == "SEPXYZ"]
        comb_node = next((n for n in nt.nodes if n.type == "COMBXYZ"), None)
        if not sep_nodes or not comb_node:
            continue

        # Read exact projection parameters from the node graph (with Porsche defaults as fallback)
        def _math_const(node_name, idx, default):
            nd = nt.nodes.get(node_name)
            if nd and nd.type == "MATH" and len(nd.inputs) > idx and not nd.inputs[idx].is_linked:
                return float(nd.inputs[idx].default_value)
            return default

        x_off = _math_const("Math", 1, 0.53)
        x_span = _math_const("Math.001", 1, 1.498)
        z_slope = _math_const("Math.002", 1, 0.017)
        z_base = _math_const("Math.003", 1, 0.235)
        z_span = _math_const("Math.005", 1, 0.206)
        y_min_abs = _math_const("Math.013", 1, 0.62)
        n_min_abs = _math_const("Math.018", 1, 0.2)

        sin_nd = nt.nodes.get("Film turn sin")
        cos_nd = nt.nodes.get("Film turn cos")
        turn_sin = float(sin_nd.outputs[0].default_value) if sin_nd and sin_nd.type == "VALUE" else 0.0
        turn_cos = float(cos_nd.outputs[0].default_value) if cos_nd and cos_nd.type == "VALUE" else 1.0

        base_rgba = tuple(float(c) for c in rgba_inps[0].default_value[:4])
        decal_rgba = tuple(float(c) for c in rgba_inps[1].default_value[:4])

        img = tex_node.image
        iw, ih = img.size[0], img.size[1]
        if iw <= 0 or ih <= 0:
            continue

        buf = np.empty(iw * ih * 4, dtype=np.float32)
        img.pixels.foreach_get(buf)
        src_arr = buf.reshape((ih, iw, 4))
        src_alpha = np.clip(src_arr[..., 3:4], 0.0, 1.0)

        base_lin = np.array(base_rgba[:3], dtype=np.float32)
        decal_lin = np.array(decal_rgba[:3], dtype=np.float32)
        base_srgb = _linear_to_srgb_np(base_lin)

        # Build crisp padded decal texture (2x upscaled for sharp edges, solid base paint border + plain swatch)
        PAD = 32
        SWATCH_H = 64
        tw = iw * 2
        th = ih * 2
        atlas_w = tw + 2 * PAD
        atlas_h = th + 2 * PAD + SWATCH_H

        alpha_up = _resize_rgba_bilinear(src_arr, tw, th)[..., 3:4]
        alpha_up = np.clip(alpha_up, 0.0, 1.0)
        comp_lin = base_lin[None, None, :] * (1.0 - alpha_up) + decal_lin[None, None, :] * alpha_up
        comp_srgb = _linear_to_srgb_np(comp_lin)

        atlas = np.empty((atlas_h, atlas_w, 4), dtype=np.float32)
        atlas[..., 0] = base_srgb[0]
        atlas[..., 1] = base_srgb[1]
        atlas[..., 2] = base_srgb[2]
        atlas[..., 3] = 1.0
        x0, y0 = PAD, SWATCH_H + PAD
        atlas[y0 : y0 + th, x0 : x0 + tw, :3] = comp_srgb

        u0, u1 = x0 / float(atlas_w), (x0 + tw) / float(atlas_w)
        v0, v1 = y0 / float(atlas_h), (y0 + th) / float(atlas_h)
        plain_u = 32.0 / float(atlas_w)
        plain_v = 32.0 / float(atlas_h)

        atlas_name = f"BG_{slugify(mat.name)}_side_decal"
        atlas_img = bpy.data.images.new(atlas_name, width=atlas_w, height=atlas_h, alpha=False)
        atlas_img.colorspace_settings.name = "sRGB"
        atlas_img.pixels.foreach_set(atlas.ravel())
        atlas_img.pack()

        ref_inv = tc_node.object.matrix_world.inverted() if tc_node.object else None
        uv_layer_name = "BG_SideDecal"
        decal_polys = 0
        seen_meshes = set()

        for obj in objs:
            me = obj.data
            if me in seen_meshes or not me.polygons:
                continue
            seen_meshes.add(me)

            mat_slots = {i for i, m in enumerate(me.materials) if m == mat}
            if not mat_slots:
                continue

            n_verts = len(me.vertices)
            n_polys = len(me.polygons)
            n_loops = len(me.loops)

            vco = np.empty(n_verts * 3, dtype=np.float32)
            me.vertices.foreach_get("co", vco)
            vco = vco.reshape((n_verts, 3))

            # Transform vertex coords into Film car root space
            if ref_inv is not None:
                m4 = np.array(ref_inv @ obj.matrix_world, dtype=np.float32)
                p_ref = vco @ m4[:3, :3].T + m4[:3, 3]
                rot3 = m4[:3, :3]
            else:
                p_ref = vco
                rot3 = np.eye(3, dtype=np.float32)

            loop_verts = np.empty(n_loops, dtype=np.int32)
            me.loops.foreach_get("vertex_index", loop_verts)
            loop_starts = np.empty(n_polys, dtype=np.int32)
            loop_totals = np.empty(n_polys, dtype=np.int32)
            mat_indices = np.empty(n_polys, dtype=np.int32)
            p_normals = np.empty(n_polys * 3, dtype=np.float32)
            me.polygons.foreach_get("loop_start", loop_starts)
            me.polygons.foreach_get("loop_total", loop_totals)
            me.polygons.foreach_get("material_index", mat_indices)
            me.polygons.foreach_get("normal", p_normals)
            p_normals = p_normals.reshape((n_polys, 3))

            # Transform polygon normals into world space (Geometry.Normal in Blender is world space)
            w_rot = np.array(obj.matrix_world.to_3x3(), dtype=np.float32)
            wn = p_normals @ w_rot.T
            wn_len = np.linalg.norm(wn, axis=1, keepdims=True)
            wn = wn / np.maximum(wn_len, 1e-6)

            is_mat_poly = np.isin(mat_indices, list(mat_slots))
            if not np.any(is_mat_poly):
                continue

            # Start with existing active UV for non-matching slots, plain swatch for this paint
            out_uv = np.empty((n_loops, 2), dtype=np.float32)
            if me.uv_layers.active:
                me.uv_layers.active.data.foreach_get("uv", out_uv.ravel())
            else:
                out_uv[:] = (plain_u, plain_v)

            is_mat_loop = np.repeat(is_mat_poly, loop_totals)
            out_uv[is_mat_loop, 0] = plain_u
            out_uv[is_mat_loop, 1] = plain_v

            lp = p_ref[loop_verts]
            lx, ly, lz = lp[:, 0], lp[:, 1], lp[:, 2]

            # Per-polygon side & normal masks
            cy = np.add.reduceat(ly, loop_starts) / loop_totals
            side_mask = np.abs(cy) > y_min_abs
            normal_mask = np.abs(wn[:, 1] * turn_cos - wn[:, 0] * turn_sin) > n_min_abs

            # Exact planar UV projection per loop (using polygon side sign so no face straddles Y=0)
            poly_pos_y = cy > 0.0
            loop_pos_y = np.repeat(poly_pos_y, loop_totals)
            t = (lx - x_off) / x_span
            z0 = t * z_slope + z_base
            lv = (lz - z0) / z_span
            lu = np.where(loop_pos_y, 1.0 - t, t)

            # Determine which polygons overlap the decal rectangle [0, 1] x [0, 1]
            in_box = (lu >= -0.02) & (lu <= 1.02) & (lv >= -0.02) & (lv <= 1.02)
            poly_any_in = np.maximum.reduceat(in_box, loop_starts)
            in_safe = (lu >= -0.25) & (lu <= 1.25) & (lv >= -0.25) & (lv <= 1.25)
            poly_all_safe = np.minimum.reduceat(in_safe, loop_starts)

            win_poly = is_mat_poly & side_mask & normal_mask & poly_any_in & poly_all_safe
            hit_count = int(np.count_nonzero(win_poly))
            if hit_count > 0:
                decal_polys += hit_count
                win_loop = np.repeat(win_poly, loop_totals)
                pad_u = (PAD * 0.5) / float(tw)
                pad_v = (PAD * 0.5) / float(th)
                su = np.clip(lu[win_loop], -pad_u, 1.0 + pad_u)
                sv = np.clip(lv[win_loop], -pad_v, 1.0 + pad_v)
                out_uv[win_loop, 0] = u0 + su * (u1 - u0)
                out_uv[win_loop, 1] = v0 + sv * (v1 - v0)

            uv_layer = me.uv_layers.get(uv_layer_name) or me.uv_layers.new(name=uv_layer_name)
            uv_layer.data.foreach_set("uv", out_uv.ravel())
            if len(me.materials) == 1:
                uv_layer.active = True
                uv_layer.active_render = True

        # Rebuild material into clean glTF-2.0-native Principled BSDF
        met_val = float(bsdf.inputs["Metallic"].default_value) if "Metallic" in bsdf.inputs else 0.0
        rgh_val = float(bsdf.inputs["Roughness"].default_value) if "Roughness" in bsdf.inputs else 0.25
        coat_in = bsdf.inputs.get("Coat Weight") or bsdf.inputs.get("Clearcoat")
        coat_val = float(coat_in.default_value) if coat_in else 1.0

        nt.nodes.clear()
        out_node = nt.nodes.new("ShaderNodeOutputMaterial")
        new_bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        new_tex = nt.nodes.new("ShaderNodeTexImage")
        new_uv = nt.nodes.new("ShaderNodeUVMap")

        new_uv.uv_map = uv_layer_name
        new_tex.image = atlas_img
        new_tex.extension = "EXTEND"

        new_bsdf.inputs["Base Color"].default_value = base_rgba
        if "Metallic" in new_bsdf.inputs:
            new_bsdf.inputs["Metallic"].default_value = met_val
        if "Roughness" in new_bsdf.inputs:
            new_bsdf.inputs["Roughness"].default_value = rgh_val
        new_coat = new_bsdf.inputs.get("Coat Weight") or new_bsdf.inputs.get("Clearcoat")
        if new_coat:
            new_coat.default_value = coat_val

        nt.links.new(new_uv.outputs["UV"], new_tex.inputs["Vector"])
        nt.links.new(new_tex.outputs["Color"], new_bsdf.inputs["Base Color"])
        nt.links.new(new_bsdf.outputs["BSDF"], out_node.inputs["Surface"])

        log_stage(
            f"Baked Object-space side decal '{img.name}' on '{mat.name}' -> {atlas_w}x{atlas_h} UV texture ({decal_polys:,} polys)"
        )
        hints.append(
            f"Projected Object-space side decal '{img.name}' on '{mat.name}' into a glTF-native UV texture."
        )


def _is_blender_default_grey(rgba):
    return abs(rgba[0] - 0.8) < 0.01 and abs(rgba[1] - 0.8) < 0.01 and abs(rgba[2] - 0.8) < 0.01


def resolve_procedural_mix_paint(mat):
    """
    Resolves procedural / Object-space Blender shader graphs (MIX, MIX_RGB, VALTORGB Color Ramps,
    and Object-coord Roughness/Normal chains) that glTF 2.0 cannot export:
      - Preserves the BSDF's true artist Base Color when set (non-default grey).
      - For VALTORGB Color Ramps with default grey BSDF Base Color, samples the ramp midpoint.
      - For MIX/MIX_RGB with default grey BSDF Base Color, uses unlinked socket A (never Color2).
      - Resolves procedural MAP_RANGE Roughness into its midpoint scalar and removes unmappable
        Object/Generated texture links so Blender doesn't export texCoord:-1 scan textures.
    """
    node_tree = getattr(mat, "node_tree", None)
    if not node_tree:
        return None
    bsdf = next((n for n in node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf:
        return None

    has_obj_coords = any(
        l.from_node.type == "TEX_COORD" and l.from_socket.name in ("Object", "Generated")
        for l in node_tree.links
    )

    base_input = bsdf.inputs.get("Base Color")
    resolved_color = None

    if base_input and base_input.is_linked:
        from_node = base_input.links[0].from_node
        is_proc_color = from_node.type in ("VALTORGB", "TEX_NOISE", "HUE_SAT", "BRIGHTCONTRAST") or (
            from_node.type in ("MIX", "MIX_RGB") and has_obj_coords
        )
        if is_proc_color:
            bsdf_def = tuple(float(c) for c in base_input.default_value[:4])
            if not _is_blender_default_grey(bsdf_def):
                resolved_color = bsdf_def
            elif from_node.type == "VALTORGB" and len(from_node.color_ramp.elements) > 0:
                elems = from_node.color_ramp.elements
                r = sum(float(e.color[0]) for e in elems) / len(elems)
                g = sum(float(e.color[1]) for e in elems) / len(elems)
                b = sum(float(e.color[2]) for e in elems) / len(elems)
                resolved_color = (r, g, b, 1.0)
            elif from_node.type in ("MIX", "MIX_RGB"):
                # Only use the FIRST RGBA input (A / Color1) if unlinked — never grab Color2!
                rgba_inps = [inp for inp in from_node.inputs if inp.type == "RGBA"]
                if rgba_inps and not rgba_inps[0].is_linked:
                    resolved_color = tuple(float(c) for c in rgba_inps[0].default_value[:4])

            if resolved_color is not None:
                base_input.default_value = resolved_color
                for link in list(base_input.links):
                    node_tree.links.remove(link)

    # Resolve procedural Object-space Roughness (e.g. MAP_RANGE driven by scan fabric / noise)
    rgh_input = bsdf.inputs.get("Roughness")
    if rgh_input and rgh_input.is_linked and has_obj_coords:
        r_src = rgh_input.links[0].from_node
        if r_src.type == "MAP_RANGE":
            to_min = float(r_src.inputs["To Min"].default_value) if "To Min" in r_src.inputs else 0.5
            to_max = float(r_src.inputs["To Max"].default_value) if "To Max" in r_src.inputs else 0.5
            rgh_input.default_value = max(0.04, min(1.0, (to_min + to_max) * 0.5))
            for link in list(rgh_input.links):
                node_tree.links.remove(link)

    # Unlink Object-space procedural Bump/Normal maps so glTF doesn't emit texCoord:-1 maps
    norm_input = bsdf.inputs.get("Normal")
    if norm_input and norm_input.is_linked and has_obj_coords:
        has_uv_map = any(n.type == "UVMAP" for n in node_tree.nodes)
        if not has_uv_map:
            for link in list(norm_input.links):
                node_tree.links.remove(link)

    return resolved_color


def extract_material_info(mat):
    """Returns (hex_color, clearcoat, saturation, luminance)."""
    rgba = (0.6, 0.64, 0.7, 1.0)
    clearcoat = 0.0
    if mat is not None:
        resolve_procedural_mix_paint(mat)
        node_tree = getattr(mat, "node_tree", None)
        found_bsdf = False
        if node_tree:
            for node in node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    base_input = node.inputs.get("Base Color")
                    if base_input and hasattr(base_input, "default_value"):
                        rgba = tuple(float(c) for c in base_input.default_value[:4])
                        found_bsdf = True
                    coat_input = node.inputs.get("Coat Weight") or node.inputs.get("Clearcoat")
                    if coat_input and hasattr(coat_input, "default_value"):
                        clearcoat = float(coat_input.default_value)
                    break
        if not found_bsdf and hasattr(mat, "diffuse_color"):
            rgba = tuple(float(c) for c in mat.diffuse_color[:4])

    r, g, b = (
        linear_to_srgb_channel(rgba[0]),
        linear_to_srgb_channel(rgba[1]),
        linear_to_srgb_channel(rgba[2]),
    )
    mx, mn = max(r, g, b), min(r, g, b)
    sat = 0.0 if mx < 1e-4 else (mx - mn) / mx
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return rgba_to_hex(rgba), clearcoat, sat, lum


def classify_material_role(name):
    n = name.lower()
    if any(k in n for k in ("mat_paint_primary", "body_paint", "carpaint", "paint_primary")):
        return "primary"
    if any(k in n for k in ("mat_paint_secondary", "paint_secondary", "two_tone")):
        return "secondary"
    if any(k in n for k in ("mat_paint_accent", "caliper", "accent", "stripe")):
        return "accent"
    if any(k in n for k in ("mat_headlight", "headlight", "drl", "emitter_head", "lamp_white")):
        return "headlight"
    if any(k in n for k in ("mat_taillight", "taillight", "brakelight", "emitter_tail", "tail_red")):
        return "taillight"
    if any(k in n for k in ("mat_glass", "glass", "windshield", "windscreen", "window")):
        return "glass"
    if (
        any(
            k in n
            for k in (
                "mat_trim",
                "trim_",
                "plastic",
                "polymer",
                "rubber",
                "tire",
                "tyre",
                "grille",
                "carbon",
            )
        )
        or re.search(r"\btrim\b", n) is not None
    ):
        return "trim"
    if (
        any(k in n for k in ("mat_rim", "alloy", "wheel_metal", "wheel graphite", "wheel_graphite"))
        or re.search(r"(^|[_\-\s])rims?($|[_\-\s])", n) is not None
    ):
        return "rim"
    if (
        "paint" in n
        or re.search(r"(^|[_\-\s])body($|[_\-\s])", n) is not None
        or any(k in n for k in ("chassis", "shell"))
    ):
        return "primary"
    return "other"


def is_spinning_wheel_object(name):
    n = name.lower()
    if any(ex in n for ex in NON_SPINNING_WHEEL_EXCLUSIONS):
        return False
    return any(
        k in n
        for k in (
            "wheel",
            "tire",
            "tyre",
            "spoke",
            "rim",
            "lug",
            "hub_f",
            "hub_r",
            "hubcap",
            "centre_shield",
            "center_cap",
            "valve_stem",
        )
    )


def detect_explicit_wheel_corner(name):
    n = name.lower()
    if re.search(r"(^|[_\-\s\.])(fl|front[_\-\s]?l|front[_\-\s]?left)($|[_\-\s\.])", n):
        return "FL"
    if re.search(r"(^|[_\-\s\.])(fr|front[_\-\s]?r|front[_\-\s]?right)($|[_\-\s\.])", n):
        return "FR"
    if re.search(r"(^|[_\-\s\.])(rl|rear[_\-\s]?l|rear[_\-\s]?left|bl|back[_\-\s]?left)($|[_\-\s\.])", n):
        return "RL"
    if re.search(r"(^|[_\-\s\.])(rr|rear[_\-\s]?r|rear[_\-\s]?right|br|back[_\-\s]?right)($|[_\-\s\.])", n):
        return "RR"
    return None


def detect_part_category(name):
    n = name.lower()
    if n.startswith("part_"):
        raw = n[len("part_") :]
        return raw.split("_")[0] if raw else "part"

    if any(ex in n for ex in HARDWARE_PART_EXCLUSIONS):
        return None

    for keyword, category in (
        ("spoiler", "spoiler"),
        ("rear_wing", "spoiler"),
        ("rear wing", "spoiler"),
        ("gt_wing", "spoiler"),
        ("gt wing", "spoiler"),
        ("ducktail", "spoiler"),
        ("hood", "hood"),
        ("bonnet", "hood"),
        ("bumper_front", "bumper"),
        ("front_bumper", "bumper"),
        ("front bumper", "bumper"),
        ("bumper_rear", "bumper"),
        ("rear_bumper", "bumper"),
        ("rear bumper", "bumper"),
        ("diffuser", "aero"),
        ("splitter", "aero"),
        ("skirt", "aero"),
        ("exhaust", "exhaust"),
        ("roof_rack", "roof"),
        ("mirror", "mirror"),
        ("door", "door"),
        ("fender", "fender"),
    ):
        if keyword in n:
            return category
    return None


def pretty_label(name):
    cleaned = re.sub(r"^(part_|slot_|mat_|body_)", "", name, flags=re.IGNORECASE)
    cleaned = re.sub(r"[_\-\.]+", " ", cleaned).strip()
    return cleaned.title() if cleaned else name


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "item"


def get_fast_world_bbox(objs):
    """Fast world bounding box using existing object bound_box (avoids per-object depsgraph re-eval)."""
    min_v = Vector((math.inf, math.inf, math.inf))
    max_v = Vector((-math.inf, -math.inf, -math.inf))
    found = False

    for obj in objs:
        if obj.type != "MESH":
            continue
        mat = obj.matrix_world
        for corner in obj.bound_box:
            world_c = mat @ Vector(corner)
            min_v.x = min(min_v.x, world_c.x)
            min_v.y = min(min_v.y, world_c.y)
            min_v.z = min(min_v.z, world_c.z)
            max_v.x = max(max_v.x, world_c.x)
            max_v.y = max(max_v.y, world_c.y)
            max_v.z = max(max_v.z, world_c.z)
            found = True

    if not found:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    return min_v, max_v


def get_world_bbox(objs):
    return get_fast_world_bbox(objs)


def is_exportable_mesh(obj):
    if obj.type != "MESH":
        return False
    if obj.hide_viewport or obj.hide_render:
        return False
    name_l = obj.name.lower()
    if any(pat in name_l for pat in IGNORED_BACKDROP_PATTERNS):
        return False
    if obj.data is None or len(obj.data.vertices) == 0:
        return False
    return True


def is_slot_empty(obj):
    return obj.type == "EMPTY" and obj.name.lower().startswith("slot_")


def count_evaluated_tris(mesh_objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    counts = {}
    total = 0
    for obj in mesh_objects:
        eval_obj = obj.evaluated_get(depsgraph)
        mesh_data = eval_obj.to_mesh()
        if mesh_data:
            mesh_data.calc_loop_triangles()
            c = len(mesh_data.loop_triangles)
            counts[obj] = c
            total += c
            eval_obj.to_mesh_clear()
        else:
            counts[obj] = 0
    return total, counts


def optimize_meshes_for_showroom(mesh_objects, max_tris, hints):
    """
    Full-fidelity mode by default (max_tris <= 0): preserves 100% original mesh geometry
    with zero decimation or vertex welding so single-car showroom visuals stay razor-sharp.
    Only caps extreme offline Subsurf levels (> 2) to 2.
    """
    raw_poly_total = sum(len(o.data.polygons) for o in mesh_objects if o.data)

    if max_tris <= 0:
        capped_subsurf = 0
        for obj in mesh_objects:
            for mod in obj.modifiers:
                if mod.type == "SUBSURF":
                    if mod.levels > 2 or mod.render_levels > 2:
                        mod.levels = min(mod.levels, 2)
                        mod.render_levels = min(mod.render_levels, 2)
                        capped_subsurf += 1
        if capped_subsurf > 0:
            bpy.context.view_layer.update()
            hints.append(f"Capped {capped_subsurf} extreme Subsurf modifier(s) (> level 2) to level 2.")

        if raw_poly_total > 2500000:
            est_tris = int(raw_poly_total * 2)
            return est_tris, {}
        total_tris, tri_counts = count_evaluated_tris(mesh_objects)
        return total_tris, tri_counts

    # Optional LOD decimation path only when --max-tris > 0 is explicitly requested
    capped_mods = 0
    for obj in mesh_objects:
        base_polys = len(obj.data.polygons) if obj.data else 0
        for mod in obj.modifiers:
            if mod.type == "SUBSURF":
                target_lvl = 0 if (base_polys > 8000 or raw_poly_total > 1500000) else 1
                if mod.levels > target_lvl or mod.render_levels > target_lvl:
                    mod.levels = min(mod.levels, target_lvl)
                    mod.render_levels = min(mod.render_levels, target_lvl)
                    capped_mods += 1

    if capped_mods > 0:
        bpy.context.view_layer.update()

    total_tris, tri_counts = count_evaluated_tris(mesh_objects)
    if total_tris <= max_tris:
        return total_tris, tri_counts

    dense_objs = [o for o in mesh_objects if 2000 < tri_counts.get(o, 0) <= 80000]
    dense_total = sum(tri_counts[o] for o in dense_objs)
    static_total = total_tris - dense_total

    if dense_total > 0:
        target_dense = max(int(max_tris * 0.65), max_tris - static_total)
        base_ratio = max(0.08, min(0.95, target_dense / float(dense_total)))
        decimated_count = 0

        for obj in dense_objs:
            tris = tri_counts[obj]
            weight = 1.15 if tris < 10000 else 1.0
            ratio = max(0.06, min(0.95, base_ratio * weight))
            if ratio >= 0.94:
                continue
            mod = obj.modifiers.new(name="BG_ShowroomDecimate", type="DECIMATE")
            mod.decimate_type = "COLLAPSE"
            mod.ratio = ratio
            mod.use_collapse_triangulate = False
            decimated_count += 1

        bpy.context.view_layer.update()
        new_total, new_counts = count_evaluated_tris(mesh_objects)
        hints.append(
            f"Optimized showroom LOD from {total_tris:,} → {new_total:,} tris across {decimated_count} dense mesh(es)."
        )
        return new_total, new_counts

    return total_tris, tri_counts


def group_wheels_by_corner(mesh_objects, car_center, car_size, root_empty):
    """Groups spinning wheel sub-meshes into at most 4 clean wheel_assembly_{FL,FR,RL,RR} empties."""
    corner_buckets = {"FL": [], "FR": [], "RL": [], "RR": []}
    wheel_mesh_set = set()

    for obj in mesh_objects:
        if not is_spinning_wheel_object(obj.name):
            continue
        obj_min, obj_max = get_world_bbox([obj])
        obj_center = (obj_min + obj_max) * 0.5
        obj_size = obj_max - obj_min

        # Ignore anything unreasonably huge (e.g., whole chassis misnamed) or sitting high on the roof
        if obj_size.length > max(car_size.x, car_size.y) * 0.9:
            continue
        if obj_center.z > car_size.z * 0.68:
            continue

        corner = detect_explicit_wheel_corner(obj.name)
        if corner is None:
            # Determine corner from spatial quadrant in normalized Blender coordinates (X=left/right, Y=front/rear)
            # Keep objects near the outer sides (not center drivetrain)
            if abs(obj_center.x - car_center.x) < car_size.x * 0.16:
                continue
            if abs(obj_center.y - car_center.y) < car_size.y * 0.12:
                continue
            is_left = obj_center.x < car_center.x
            is_front = obj_center.y > car_center.y
            corner = ("F" if is_front else "R") + ("L" if is_left else "R")

        corner_buckets[corner].append(obj)
        wheel_mesh_set.add(obj)

    wheels_manifest = []
    created_empties = []

    for corner in ("FL", "FR", "RL", "RR"):
        objs = corner_buckets[corner]
        if not objs:
            continue

        w_min, w_max = get_world_bbox(objs)
        w_center = (w_min + w_max) * 0.5
        w_size = w_max - w_min

        assembly_name = f"wheel_assembly_{corner}"
        pivot = bpy.data.objects.new(assembly_name, None)
        bpy.context.scene.collection.objects.link(pivot)
        pivot.parent = root_empty
        pivot.matrix_world.translation = w_center
        bpy.context.view_layer.update()

        # Re-parent top-most wheel objects in this bucket under the corner pivot
        bucket_set = set(objs)
        for obj in objs:
            if obj.parent in bucket_set:
                continue
            world_mat = obj.matrix_world.copy()
            obj.parent = pivot
            obj.matrix_world = world_mat

        created_empties.append(pivot)
        wheels_manifest.append(
            {
                "id": slugify(assembly_name),
                "corner": corner,
                "objectName": assembly_name,
                "center": blender_to_gltf_vec3(w_center),
                "radius": round(float(max(w_size.y, w_size.z) * 0.5), 4),
                "width": round(float(max(0.14, min(w_size.x, w_size.y))), 4),
            }
        )

    bpy.context.view_layer.update()
    return wheels_manifest, wheel_mesh_set, created_empties


def main():
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)
    hints = []

    all_objects = list(bpy.context.scene.objects)
    mesh_objects = [o for o in all_objects if is_exportable_mesh(o)]
    slot_objects = [o for o in all_objects if is_slot_empty(o)]

    if not mesh_objects:
        raise RuntimeError("No visible MESH objects found in .blend scene.")

    # Bake Object-space planar side decals (e.g. Porsche GT3 RS side graphics) BEFORE root normalization
    bake_object_projected_side_decals(mesh_objects, hints)

    # Normalize scale, lengthwise orientation, centering, and grounding via a clean root wrapper
    min_v, max_v = get_world_bbox(mesh_objects)
    size_v = max_v - min_v
    longest_axis = max(size_v.x, size_v.y, size_v.z, 1e-5)

    scale_factor = 1.0
    if longest_axis > 18.0 or longest_axis < 0.8:
        scale_factor = 4.4 / longest_axis
        hints.append(
            f"Auto-scaled model by {scale_factor:.4f}x (original longest dimension was {longest_axis:.2f}m; normalized to ~4.4m)."
        )

    rotate_z_90 = size_v.x > size_v.y * 1.15
    if rotate_z_90:
        hints.append(
            "Detected car length along Blender X-axis; rotated 90° so it parks lengthwise inside garage bays."
        )

    export_objs = list(mesh_objects) + list(slot_objects)
    export_set = set(export_objs)

    for obj in list(export_objs):
        parent = obj.parent
        while parent is not None:
            if parent not in export_set:
                export_set.add(parent)
                export_objs.append(parent)
            parent = parent.parent

    root_empty = bpy.data.objects.new("blend_garage_root", None)
    bpy.context.scene.collection.objects.link(root_empty)

    top_level = [o for o in export_objs if o.parent is None]
    for obj in top_level:
        world_mat = obj.matrix_world.copy()
        obj.parent = root_empty
        obj.matrix_world = world_mat

    if rotate_z_90:
        root_empty.rotation_euler[2] += math.pi * 0.5
    if scale_factor != 1.0:
        root_empty.scale = (scale_factor, scale_factor, scale_factor)

    bpy.context.view_layer.update()

    min_v, max_v = get_world_bbox(mesh_objects)
    center_x = (min_v.x + max_v.x) * 0.5
    center_y = (min_v.y + max_v.y) * 0.5
    root_empty.location.x -= center_x
    root_empty.location.y -= center_y
    root_empty.location.z -= min_v.z
    bpy.context.view_layer.update()

    min_v, max_v = get_world_bbox(mesh_objects)
    size_v = max_v - min_v
    center_v = (min_v + max_v) * 0.5
    log_stage(f"Normalized {len(mesh_objects)} meshes")

    # Flatten multi-UV decal liveries (e.g. FF1 Supra paintjobs) into a single glTF-native 4K atlas
    flatten_multi_uv_livery_materials(mesh_objects, hints)

    # Optimize mesh triangle density for real-time WebGL showroom performance
    total_tris, _ = optimize_meshes_for_showroom(mesh_objects, args.max_tris, hints)
    log_stage(f"Optimized showroom LOD ({total_tris:,} tris)")

    # Group spinning wheel assemblies cleanly into FL/FR/RL/RR
    wheels, wheel_mesh_set, wheel_empties = group_wheels_by_corner(
        mesh_objects, center_v, size_v, root_empty
    )
    export_objs.extend(wheel_empties)
    log_stage(f"Grouped {len(wheels)} wheel assemblies")

    # Collect clean swappable exterior parts & materials
    part_candidates = []
    materials_map = {}
    material_scores = {}

    for obj in mesh_objects:
        obj_min, obj_max = get_world_bbox([obj])
        obj_size = obj_max - obj_min
        obj_extent = obj_size.length
        obj_vol = max(1e-5, obj_size.x * obj_size.y * obj_size.z)

        if obj not in wheel_mesh_set:
            part_cat = detect_part_category(obj.name)
            is_explicit_part = obj.name.lower().startswith("part_")
            if part_cat is not None and (is_explicit_part or obj_extent >= 0.18):
                part_candidates.append((is_explicit_part, obj_extent, obj, part_cat))

        mat_slots = [s.material for s in obj.material_slots if s.material is not None]
        if not mat_slots:
            key = "default-body"
            entry = materials_map.setdefault(
                key,
                {
                    "id": key,
                    "materialName": "DefaultMaterial",
                    "role": "primary",
                    "defaultColor": "#c81d25",
                    "meshNames": [],
                },
            )
            entry["meshNames"].append(obj.name)
            material_scores[key] = material_scores.get(key, 0.0) + obj_vol
        else:
            for mat in mat_slots:
                mat_id = slugify(mat.name)
                if mat_id not in materials_map:
                    hex_col, clearcoat, sat, lum = extract_material_info(mat)
                    materials_map[mat_id] = {
                        "id": mat_id,
                        "materialName": mat.name,
                        "role": classify_material_role(mat.name),
                        "defaultColor": hex_col,
                        "meshNames": [],
                        "_meta": (clearcoat, sat, lum),
                    }
                if obj.name not in materials_map[mat_id]["meshNames"]:
                    materials_map[mat_id]["meshNames"].append(obj.name)
                material_scores[mat_id] = material_scores.get(mat_id, 0.0) + obj_vol

    # Sort parts: explicit part_* first, then largest exterior panels, capped at 24 clean entries
    part_candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    parts = []
    seen_part_ids = set()
    for _, _, obj, part_cat in part_candidates[:24]:
        pid = slugify(obj.name)
        if pid in seen_part_ids:
            continue
        seen_part_ids.add(pid)
        parts.append(
            {
                "id": pid,
                "label": pretty_label(obj.name),
                "category": part_cat,
                "objectName": obj.name,
                "defaultVisible": True,
            }
        )

    slots = []
    for obj in slot_objects:
        cat = obj.name[len("slot_") :].lower() if obj.name.lower().startswith("slot_") else "custom"
        slots.append(
            {
                "id": slugify(obj.name),
                "category": cat,
                "objectName": obj.name,
                "position": blender_to_gltf_vec3(obj.matrix_world.translation),
                "rotation": [
                    round(float(obj.rotation_euler.x), 4),
                    round(float(obj.rotation_euler.z), 4),
                    round(float(-obj.rotation_euler.y), 4),
                ],
                "scale": [
                    round(float(obj.scale.x), 4),
                    round(float(obj.scale.z), 4),
                    round(float(obj.scale.y), 4),
                ],
            }
        )

    material_zones = list(materials_map.values())

    # If no explicit primary paint zone exists, promote the best exterior body-paint candidate
    if not any(z["role"] == "primary" for z in material_zones) and material_zones:
        def paint_candidate_score(z):
            name_l = z["materialName"].lower()
            vol = material_scores.get(z["id"], 0.0)
            clearcoat, sat, lum = z.get("_meta", (0.0, 0.0, 0.5))
            if z["role"] in ("glass", "trim", "rim", "headlight", "taillight"):
                return -1.0
            if any(k in name_l for k in NON_PAINT_PROMOTION_KEYWORDS):
                return vol * 0.05
            bonus = 1.0 + clearcoat * 3.0 + sat * 2.5 + (0.6 if lum > 0.18 else 0.0)
            return vol * bonus

        best_zone = max(material_zones, key=paint_candidate_score)
        best_zone["role"] = "primary"
        hints.append(
            f"Auto-bound '{best_zone['materialName']}' as Primary Paint."
        )

    # Sort material zones so primary/secondary/accent/rim/glass appear first in Paint Booth
    role_order = {
        "primary": 0,
        "secondary": 1,
        "accent": 2,
        "rim": 3,
        "glass": 4,
        "trim": 5,
        "headlight": 6,
        "taillight": 7,
        "other": 8,
    }
    material_zones.sort(
        key=lambda z: (role_order.get(z["role"], 9), -material_scores.get(z["id"], 0.0))
    )
    for z in material_zones:
        z.pop("_meta", None)

    if not wheels:
        hints.append(
            "No wheel objects detected — name wheel meshes 'wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR' to unlock steering, spin preview & rim swaps."
        )

    # Select only export objects + root for clean glTF export
    bpy.ops.object.select_all(action="DESELECT")
    root_empty.select_set(True)
    for obj in export_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root_empty

    glb_path = os.path.join(args.output_dir, "model.glb")
    supported_props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    gltf_kwargs = {
        "filepath": glb_path,
        "export_format": "GLB",
        "use_selection": True,
        "export_yup": True,
        "export_apply": True,
        "export_texcoords": True,
        "export_normals": True,
        "export_materials": "EXPORT",
        "export_image_format": "WEBP",
        "export_image_quality": 90,
        "export_cameras": False,
        "export_lights": False,
        "export_draco_mesh_compression_enable": not args.no_draco,
        "export_draco_mesh_compression_level": 6,
        "export_draco_position_quantization": 16,
        "export_draco_normal_quantization": 12,
        "export_draco_texcoord_quantization": 12,
    }
    filtered_kwargs = {k: v for k, v in gltf_kwargs.items() if k in supported_props}
    log_stage(f"Starting glTF export ({len(export_objs)} objects)...")
    bpy.ops.export_scene.gltf(**filtered_kwargs)
    log_stage("Finished glTF export")

    gltf_min = [
        round(float(min_v.x), 4),
        round(float(min_v.z), 4),
        round(float(-max_v.y), 4),
    ]
    gltf_max = [
        round(float(max_v.x), 4),
        round(float(max_v.z), 4),
        round(float(-min_v.y), 4),
    ]
    gltf_size = [
        round(gltf_max[0] - gltf_min[0], 4),
        round(gltf_max[1] - gltf_min[1], 4),
        round(gltf_max[2] - gltf_min[2], 4),
    ]
    gltf_center = [
        round((gltf_min[0] + gltf_max[0]) * 0.5, 4),
        round((gltf_min[1] + gltf_max[1]) * 0.5, 4),
        round((gltf_min[2] + gltf_max[2]) * 0.5, 4),
    ]

    manifest = {
        "schemaVersion": 1,
        "id": args.car_id,
        "name": args.car_name,
        "author": args.author,
        "sourceFile": args.source_file,
        "importedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "modelUrl": f"/cars/{args.car_id}/model.glb",
        "bounds": {
            "min": gltf_min,
            "max": gltf_max,
            "size": gltf_size,
            "center": gltf_center,
        },
        "triangleCount": total_tris,
        "objectCount": len(mesh_objects),
        "wheels": wheels,
        "parts": parts,
        "slots": slots,
        "materialZones": material_zones,
        "hints": hints,
    }

    manifest_path = os.path.join(args.output_dir, "vehicle.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    glb_mb = os.path.getsize(glb_path) / (1024 * 1024)
    print(
        f"[blend-garage] Exported '{args.car_name}' -> {glb_path} "
        f"({glb_mb:.1f} MB, {total_tris:,} tris, {len(wheels)} wheels, {len(parts)} parts, {len(material_zones)} materials)"
    )


if __name__ == "__main__":
    main()
