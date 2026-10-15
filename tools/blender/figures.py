# The survivors' and creeps' meshes, built in Blender and written out as
# web/src/scene/figures.gen.ts. Run it in Blender (Text editor, or blender -b -P this file);
# it rebuilds a preview of every piece in the open scene and rewrites the module.
#
# Everything here is in game space: x forward, y up, z to the figure's left, one unit a metre
# before the hero's 1.15 scale. Bodies and heads are hulls of ellipsoids fused into one surface
# (voxel remeshed, smoothed, cut down), so torso, neck, hips and legs are one skin; boots,
# hands, hair, hats, packs and the clothes over the shirt are their own pieces laid on it.
#
# In Blender: run the file to rewrite the module and lay out a row of dressed survivors;
# show_heads() puts two big heads beside them to study the face.
#
# Each triangle carries a code: a slot the page colours per player or per creep (skin, shirt,
# trousers, ...), a body region the page dresses per outfit (the forearm is a sleeve or bare
# skin), or a fixed colour from the palette. Each vertex carries the joints it moves with, as
# in web/src/scene/rig.ts, and a weight between them where a limb bends.

import base64
import math
import os
import struct

import bmesh
import bpy
from mathutils import Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'web', 'src', 'scene', 'figures.gen.ts')

# Joints, as rig.ts numbers them, and the pelvis, which is not one of the creeps' joints.
X2, CHEST, HEAD, UARM_L, FARM_L, UARM_R, FARM_R, THIGH_L, SHIN_L, THIGH_R, SHIN_R, X = range(12)
PELVIS = 12
PARENT = {X2: CHEST, CHEST: PELVIS, HEAD: CHEST, UARM_L: CHEST, FARM_L: UARM_L, UARM_R: CHEST, FARM_R: UARM_R,
          THIGH_L: PELVIS, SHIN_L: THIGH_L, THIGH_R: PELVIS, SHIN_R: THIGH_R, X: CHEST, PELVIS: -1}

# Slots, coloured by the page.
SLOTS = ['skin', 'shirt', 'shirt2', 'pants', 'boot', 'hair', 'hat', 'over', 'stripe', 'eye', 'mouth', 'sole',
         'belt', 'wrap', 'brow', 'lip']
# Body regions, dressed by the page per outfit.
REGIONS = ['torso', 'collar', 'belt', 'seat', 'uarm', 'elbow', 'farm', 'wrist', 'neck', 'thigh', 'shin', 'jaw']
S = {n: i for i, n in enumerate(SLOTS)}
R = {n: 32 + i for i, n in enumerate(REGIONS)}
PALETTE: list = []


def fixed(hex_):
    if hex_ not in PALETTE:
        PALETTE.append(hex_)
    return 64 + PALETTE.index(hex_)


# Game space to Blender's (z up, -y the figure's left) and back.
def G(x, y, z):
    return Vector((x, -z, y))


def back(v):
    return (v.x, v.z, -v.y)


def clamp(v, a, b):
    return max(a, min(b, v))


def smooth(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def rnd(i, salt=0):
    h = (i * 2654435761 + salt * 40503) & 0xffffffff
    h ^= h >> 13
    h = (h * 0x5bd1e995) & 0xffffffff
    h ^= h >> 15
    return (h & 0xffff) / 65535


# A piece: a bmesh in Blender space, a code per face (in the face's material index, through
# CODES), and how its vertices take joints.
class Piece:
    def __init__(self, bm, smooth=True):
        self.bm = bm
        self.smooth = smooth


def skin(nodes, edges, sub=1, root=None, upright=True):
    """A skin-modifier surface over a skeleton: nodes {key: ((x, y, z), (across, deep))} for
    upright chains, (across, up) for chains along x. The radii are those of the smoothed
    surface: the cage is grown to make up for the smoothing pulling it in."""
    keys = list(nodes)
    me = bpy.data.meshes.new('tmp')
    me.from_pydata([G(*nodes[k][0]) for k in keys], [(keys.index(a), keys.index(b)) for a, b in edges], [])
    ob = bpy.data.objects.new('tmp', me)
    bpy.context.collection.objects.link(ob)
    ob.modifiers.new('skin', 'SKIN')
    grow = 1.3 if sub else 1.0
    for i, k in enumerate(keys):
        a, b = nodes[k][1]
        me.skin_vertices[0].data[i].radius = (b * grow, a * grow) if upright else (a * grow, b * grow)
    me.skin_vertices[0].data[keys.index(root or keys[0])].use_root = True
    if sub:
        s = ob.modifiers.new('sub', 'SUBSURF')
        s.levels = sub
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    bm = bmesh.new()
    bm.from_mesh(ev.to_mesh())
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    return bm


def ellipsoid(c, r, rot=(0, 0, 0), seg=12, rings=8):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * r[0], v.co.y * r[2], v.co.z * r[1]))
    rotate(bm, rot)
    for v in bm.verts:
        v.co += G(*c)
    return bm


def hull(*parts):
    """The convex hull round some ellipsoids: a limb from joint to joint."""
    pts = []
    for p in parts:
        pts += [v.co.copy() for v in p.verts]
        p.free()
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in pts]
    res = bmesh.ops.convex_hull(bm, input=vs)
    bmesh.ops.delete(bm, geom=list(set(res['geom_interior']) | set(res['geom_unused'])), context='VERTS')
    return bm


def blob(nodes, links, extra=()):
    """Ellipsoids at nodes {key: ((x, y, z), (rx, ry, rz)[, (rot)])}, each link a hull
    between its nodes; with any extra pieces, to be fused by fuse()."""
    def e(k):
        n = nodes[k]
        return ellipsoid(n[0], n[1], n[2] if len(n) > 2 else (0, 0, 0))
    out = [hull(*[e(k) for k in l]) for l in links]
    return out + list(extra)


def fuse(parts, voxel=0.009, faces=900, smooth_iter=4, smooth_k=0.5):
    """One surface round overlapping pieces: voxel remeshed, the seams smoothed, cut down to
    about `faces` triangles."""
    bm = join(*parts)
    for p in parts:
        p.free()
    me = bpy.data.meshes.new('tmp')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('tmp', me)
    bpy.context.collection.objects.link(ob)
    r = ob.modifiers.new('re', 'REMESH')
    r.mode = 'VOXEL'
    r.voxel_size = voxel
    if smooth_iter:
        s = ob.modifiers.new('sm', 'LAPLACIANSMOOTH')
        s.iterations = smooth_iter
        s.lambda_factor = smooth_k
        s.use_volume_preserve = True
    d = ob.modifiers.new('de', 'DECIMATE')
    dg = bpy.context.evaluated_depsgraph_get()
    n = len(ob.evaluated_get(dg).data.polygons)
    d.ratio = min(1.0, faces / max(1, n * 2))
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    out = bmesh.new()
    out.from_mesh(ev.to_mesh())
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    return out


def thin(bm, ratio):
    """bm cut down to about ratio of its triangles, keeping its outline and codes."""
    me = bpy.data.meshes.new('tmp')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('tmp', me)
    bpy.context.collection.objects.link(ob)
    d = ob.modifiers.new('de', 'DECIMATE')
    d.ratio = ratio
    d.use_symmetry = True
    d.symmetry_axis = 'Y'
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    out = bmesh.new()
    out.from_mesh(ev.to_mesh())
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    return out


def sphere(c, r, seg=10, rings=7, fn=None):
    """A sphere at c with radii r=(x, y, z), each vertex (in unit coordinates) through fn."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    for v in bm.verts:
        u = (v.co.x, v.co.z, -v.co.y)
        p = fn(*u) if fn else (u[0] * r[0], u[1] * r[1], u[2] * r[2])
        v.co = G(c[0] + p[0], c[1] + p[1], c[2] + p[2])
    return bm


def box(c, size, bevel=0.0, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], -v.co.z * size[2], v.co.y * size[1]))
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect='EDGES')
    rotate(bm, rot)
    for v in bm.verts:
        v.co += G(*c)
    return bm


def cylinder(a, b, r1, r2=None, seg=8, caps=True):
    """A tube from a to b (game space)."""
    r2 = r1 if r2 is None else r2
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=1.0)
    A, B = G(*a), G(*b)
    d = B - A
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    for v in bm.verts:
        v.co = Vector((v.co.x, v.co.y, (v.co.z + 0.5) * d.length))
        v.co.rotate(q)
        v.co += A
    return bm


def rotate(bm, rot):
    """Turns about game x, y, z (radians, in that order) round the origin."""
    from mathutils import Euler
    rx, ry, rz = rot
    if not (rx or ry or rz):
        return
    # Game x is Blender x, game y is Blender z, game z is Blender -y.
    m = Euler((rx, -rz, ry), 'XZY').to_matrix()
    for v in bm.verts:
        v.co = m @ v.co


def paint(bm, code):
    """Every face one code."""
    for f in bm.faces:
        f.material_index = code


def paint_by(bm, fn):
    """Each face the code fn gives for its centre (game space)."""
    for f in bm.faces:
        c = back(f.calc_center_median())
        k = fn(*c)
        if k is not None:
            f.material_index = k


def join(*bms):
    out = bmesh.new()
    for b in bms:
        me = bpy.data.meshes.new('tmp')
        b.to_mesh(me)
        out.from_mesh(me)
        bpy.data.meshes.remove(me)
    return out


def shell(src, keep, push, solid=0.0):
    """The faces of src whose centres keep accepts, pushed out along their normals: clothes
    or hair over a body. keep gets (x, y, z) in game space."""
    bm = src.copy()
    bm.normal_update()
    drop = [f for f in bm.faces if not keep(*back(f.calc_center_median()))]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    bm.normal_update()
    for v in bm.verts:
        n = v.normal
        k = push(*back(v.co)) if callable(push) else push
        v.co += n * k
    if solid:
        ret = bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=solid)
    return bm


def mirror_z(bm):
    out = bm.copy()
    for v in out.verts:
        v.co.y = -v.co.y
    bmesh.ops.reverse_faces(out, faces=list(out.faces))
    return out


# ---- Joints by nearest bone -------------------------------------------------------------

def seg_dist(p, a, b):
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ap = (p[0] - a[0], p[1] - a[1], p[2] - a[2])
    L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
    t = clamp((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L, 0, 1) if L > 0 else 0
    q = (a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2])
    return math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2), t


def weigh(p, bones, allow=None, blend=0.0):
    """The joint a point moves with, and with blend > 0 the joint it shades into where a limb
    bends: (j0, j1, w of j0)."""
    best = []
    for j, a, b in bones:
        if allow is not None and j not in allow:
            continue
        d, t = seg_dist(p, a, b)
        best.append((d, j, t))
    best.sort()
    d0, j0, t0 = best[0]
    if blend <= 0:
        return j0, j0, 1.0
    # Shade only into the parent or a child, near where the two meet.
    for d1, j1, t1 in best[1:]:
        if j1 == PARENT.get(j0) or PARENT.get(j1) == j0:
            w = 0.5 + 0.5 * smooth(0, 1, (d1 - d0) / blend)
            return j0, j1, w
    return j0, j0, 1.0


# ---- Export ---------------------------------------------------------------------------

def b64(fmt, vals):
    return base64.b64encode(struct.pack('<%d%s' % (len(vals), fmt), *vals)).decode()


def encode(bm, bones=None, joint=None, allow=None, blend=0.0, smooth_=True, tone=None):
    """A piece as the page reads it. Vertices in 1/4096 m; joints per vertex (or one for
    all); per triangle a code and a tone (how much lighter or darker its colour is)."""
    bm = bm.copy()
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bm.verts.index_update()
    pos, js, tris, codes, tones = [], [], [], [], []
    for v in bm.verts:
        g = back(v.co)
        pos += [round(c * 4096) for c in g]
        if joint is None:
            j0, j1, w = weigh(g, bones, allow, blend)
            js += [j0, j1, round(w * 255)]
    for i, f in enumerate(bm.faces):
        tris += [v.index for v in f.verts]
        codes.append(f.material_index)
        c = back(f.calc_center_median())
        k = tone(*c, i) if tone else 1.0
        tones.append(clamp(round(k * 128), 0, 255))
    out = {'v': b64('h', pos), 't': b64('H', tris), 'c': b64('B', codes), 'k': b64('B', tones), 's': 1 if smooth_ else 0}
    if joint is None:
        out['j'] = b64('B', js)
    else:
        out['j0'] = joint
    bm.free()
    return out


def weathered(base=1.0, dirt=0.18, grain=0.08):
    """Tone: grain per face, and dirt rising from the ground."""
    def f(x, y, z, i):
        return base * (1 - grain / 2 + grain * rnd(i, 7)) * (1 - dirt * (1 - smooth(0.0, 0.45, y)))
    return f


# ---- Preview in the scene -----------------------------------------------------------------

PREVIEW = {
    'skin': 0xc89068, 'shirt': 0x3d8bff, 'shirt2': 0x2a5aa8, 'pants': 0x3a4458, 'boot': 0x3a2a1c, 'hair': 0x2e1f14,
    'hat': 0xe0681c, 'over': 0xd6e03c, 'stripe': 0xe8e8d8, 'eye': 0x141010, 'mouth': 0x6a3020, 'sole': 0x1a1612,
    'belt': 0x2a2018, 'wrap': 0x8a2a40, 'brow': 0x2a1c14, 'lip': 0x9a5a48,
    'torso': 0x3d8bff, 'collar': 0x2a5aa8, 'belt_r': 0x2a2018, 'seat': 0x3a4458, 'uarm': 0x3d8bff, 'farm': 0x5a9bff,
    'wrist': 0xc89068, 'neck': 0xc89068, 'thigh': 0x3a4458, 'shin': 0x34405a, 'jaw': 0xc89068, 'elbow': 0x4d9bff,
}


def code_color(k):
    if k < 32:
        return PREVIEW[SLOTS[k]]
    if k < 64:
        n = REGIONS[k - 32]
        return PREVIEW['belt_r' if n == 'belt' else n]
    return PALETTE[k - 64]


def preview(name, bm, at=(0, 0, 0), coll='figures'):
    c = bpy.data.collections.get(coll) or bpy.data.collections.new(coll)
    if c.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(c)
    me = bpy.data.meshes.new(name)
    b = bm.copy()
    for v in b.verts:
        v.co += G(*at)
    used = sorted({f.material_index for f in b.faces})
    for f in b.faces:
        f.material_index = used.index(f.material_index)
    b.to_mesh(me)
    b.free()
    for k in used:
        mn = 'fig_%d' % k
        m = bpy.data.materials.get(mn) or bpy.data.materials.new(mn)
        h = code_color(k)
        col = (((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, 1)
        lin = tuple(c ** 2.2 for c in col[:3]) + (1,)
        m.diffuse_color = lin
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        bsdf.inputs[0].default_value = lin
        bsdf.inputs['Roughness'].default_value = 0.9
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    c.objects.link(ob)
    return ob


# ---- The survivor ---------------------------------------------------------------------------
#
# The hero's skeleton (heroes.ts builds its groups at these pivots): legs from the hips, arms
# from the shoulders, both hanging straight down at rest; the torso turns at the waist, the
# head at the neck.
HIP_Y, HIP_Z, KNEE_Y, ANKLE_Y = 0.56, 0.095, 0.30, 0.075
WAIST = 0.6
SH_Y, SH_Z, ELBOW_Y, WRIST_Y, HAND_Y = 0.985, 0.164, 0.75, 0.58, 0.535
NECK = (0.01, 1.07)


def hero_bones(fem=False):
    sz = SH_Z * (0.93 if fem else 1)
    b = [(PELVIS, (0, 0.5, HIP_Z), (0, 0.5, -HIP_Z)), (PELVIS, (0, 0.5, 0), (0, 0.63, 0)),
         (CHEST, (0, 0.66, 0), (0, 1.06, 0)), (CHEST, (0, 1.0, sz - 0.07), (0, 1.0, -sz + 0.07)),
         (HEAD, (0.01, 1.11, 0), (0.02, 1.3, 0))]
    for s, (u, f, t, k) in ((1, (UARM_L, FARM_L, THIGH_L, SHIN_L)), (-1, (UARM_R, FARM_R, THIGH_R, SHIN_R))):
        b += [(u, (0, SH_Y, sz * s), (0, ELBOW_Y, sz * s)), (f, (0, ELBOW_Y, sz * s), (0.0, HAND_Y - 0.06, sz * s)),
              (t, (0, HIP_Y, HIP_Z * s), (0, KNEE_Y, HIP_Z * s)), (k, (0, KNEE_Y, HIP_Z * s), (0.1, 0.0, HIP_Z * s))]
    return b


def body(fem=False):
    """The trunk (torso, neck, hips and legs to the ankle) as one surface, and each arm to the
    wrist as its own, its shoulder sunk into the trunk's so the seam never shows."""
    sz = SH_Z * (0.93 if fem else 1)
    k = 0.92 if fem else 1.0     # across the shoulders and chest
    hk = 1.07 if fem else 1.0    # across the hips
    n = {
        'pel': ((0.0, 0.6, 0), (0.1, 0.075, 0.135 * hk)),
        'wai': ((0.006, 0.69, 0), (0.088, 0.06, 0.118 * (0.9 if fem else 1))),
        'bel': ((0.016, 0.8, 0), (0.098, 0.07, 0.128 * k)),
        'chs': ((0.012, 0.915, 0), (0.106 if fem else 0.104, 0.08, 0.138 * k)),
        'top': ((-0.01, 0.985, 0), (0.088, 0.05, 0.13 * k)),
        'nk0': ((0.0, 1.06, 0), (0.05, 0.03, 0.052)),
        'nk1': ((0.012, 1.115, 0), (0.042, 0.03, 0.044)),
    }
    links = [('pel', 'wai'), ('wai', 'bel'), ('bel', 'chs'), ('chs', 'top'), ('top', 'nk0'), ('nk0', 'nk1')]
    extra = []
    for s in (1, -1):
        L = 'L' if s > 0 else 'R'
        hz = HIP_Z * hk * s
        n['hp' + L] = ((0.0, 0.53, hz), (0.09, 0.06, 0.086 * hk))
        n['th' + L] = ((0.01, 0.42, hz), (0.08, 0.07, 0.075))
        n['kn' + L] = ((0.014, KNEE_Y, hz), (0.057, 0.045, 0.054))
        n['cf' + L] = ((-0.012, 0.21, hz), (0.06, 0.06, 0.053))
        n['an' + L] = ((0.0, 0.1, hz), (0.042, 0.03, 0.04))
        links += [('pel', 'hp' + L), ('hp' + L, 'th' + L), ('th' + L, 'kn' + L), ('kn' + L, 'cf' + L), ('cf' + L, 'an' + L)]
        # The seat, and the chest's slope into the shoulder.
        extra.append(ellipsoid((-0.045, 0.56, 0.06 * s * hk), (0.07, 0.075, 0.075 * hk)))
        extra.append(ellipsoid((0.068, 0.888, 0.054 * s), (0.056, 0.048, 0.05)) if fem else ellipsoid((0.04, 0.95, 0.065 * s), (0.05, 0.048, 0.075)))
        # The trapezius, sloping from the neck down to the shoulder.
        extra.append(hull(ellipsoid((-0.015, 1.045, 0.035 * s), (0.05, 0.025, 0.03)), ellipsoid((-0.012, 0.995, (sz - 0.025) * s), (0.055, 0.033, 0.05))))
    trunk = fuse(blob(n, links, extra), faces=1300)
    arms = []
    for s in (1, -1):
        z = sz * s
        a = {
            'sh': ((-0.008, 0.972, z), (0.058, 0.055, 0.052)),
            'ua': ((-0.006, 0.87, z + 0.004 * s), (0.051, 0.06, 0.048)),
            'el': ((-0.008, ELBOW_Y, z), (0.042, 0.04, 0.041)),
            'fa': ((0.004, 0.67, z), (0.045, 0.05, 0.041)),
            'wr': ((0.004, 0.592, z), (0.03, 0.02, 0.034)),
        }
        arms.append(fuse(blob(a, [('sh', 'ua'), ('ua', 'el'), ('el', 'fa'), ('fa', 'wr')]), faces=300))
    return trunk, arms[0], arms[1]


def head(fem=False):
    """Cranium, forehead, cheekbones, jaw and chin, the nose with its bridge and wings, the
    brow over the eyes and the ears, as one surface; the neck sinks into it."""
    jw = 0.048 if fem else 0.055
    parts = [
        ellipsoid((-0.006, 1.236, 0), (0.099, 0.083, 0.081), seg=16, rings=10),
        ellipsoid((0.048, 1.232, 0), (0.05, 0.05, 0.066)),
        # The face, an egg narrowing from the cheeks to the chin; the jaw's angle sits high and
        # back under the ear, so the jawline runs soft down to the chin.
        hull(ellipsoid((0.03, 1.2, 0), (0.058, 0.036, 0.064)), ellipsoid((0.06, 1.148, 0), (0.026, 0.018, 0.03 if fem else 0.035)),
             ellipsoid((-0.012, 1.186, jw), (0.03, 0.034, 0.018)), ellipsoid((-0.012, 1.186, -jw), (0.03, 0.034, 0.018))),
        # Round the mouth.
        ellipsoid((0.056, 1.17, 0), (0.034, 0.028, 0.04)),
        # The brow over the eyes, and the nose: bridge, tip, the base between the nostrils.
        ellipsoid((0.084, 1.222, 0), (0.016, 0.011, 0.05)) if not fem else ellipsoid((0.082, 1.224, 0), (0.014, 0.01, 0.047)),
        hull(ellipsoid((0.092, 1.226, 0), (0.006, 0.008, 0.007)), ellipsoid((0.106, 1.19, 0), (0.009 if fem else 0.01, 0.009, 0.009 if fem else 0.01)),
             ellipsoid((0.096, 1.181, 0), (0.008, 0.005, 0.008))),
    ]
    for s_ in (1, -1):
        # A soft cheek under each eye, the nostril's wing and the ear.
        parts.append(ellipsoid((0.044, 1.192, 0.036 * s_), (0.024, 0.015, 0.02)))
        parts.append(ellipsoid((0.096, 1.185, 0.011 * s_), (0.008, 0.007, 0.007)))
        parts.append(hull(ellipsoid((-0.004, 1.222, 0.08 * s_), (0.016, 0.018, 0.008)), ellipsoid((-0.008, 1.19, 0.078 * s_), (0.011, 0.014, 0.008))))
    bm = fuse(parts, voxel=0.0035, faces=900, smooth_iter=7, smooth_k=0.5)
    paint(bm, S['skin'])
    # Where stubble shades the jaw and lip.
    paint_by(bm, lambda x, y, z: R['jaw'] if y < 1.185 and x > -0.02 and abs(z) < 0.07 and not (x > 0.09 and y > 1.17) else None)
    return headspace(bm)


def face(fem=False):
    """Eyes (whites and irises), brows, lips and the line of the mouth, set into the head."""
    parts = []
    for s_ in (1, -1):
        w = ellipsoid((0.0795, 1.212, 0.031 * s_), (0.008, 0.0085, 0.014), seg=8, rings=5)
        paint(w, fixed(0xe4dccc))
        e = ellipsoid((0.086, 1.212, 0.03 * s_), (0.004, 0.0075, 0.0075), seg=6, rings=4)
        paint(e, S['eye'])
        b = hull(ellipsoid((0.091, 1.232, 0.014 * s_), (0.006, 0.005, 0.006), seg=6, rings=4),
                 ellipsoid((0.088, 1.236, 0.03 * s_), (0.006, 0.006, 0.008), seg=6, rings=4),
                 ellipsoid((0.079, 1.231, 0.046 * s_), (0.005, 0.004, 0.006), seg=6, rings=4))
        paint(b, S['brow'])
        parts += [w, e, b]
    up = ellipsoid((0.089, 1.168, 0), (0.006, 0.005 if fem else 0.004, 0.019), seg=8, rings=4)
    lo = ellipsoid((0.087, 1.16, 0), (0.007, 0.006 if fem else 0.005, 0.016), seg=8, rings=4)
    paint(up, S['lip'])
    paint(lo, S['lip'])
    m = box((0.091, 1.164, 0), (0.006, 0.003, 0.03))
    paint(m, S['mouth'])
    parts += [up, lo, m]
    return headspace(join(*parts))


def hand(s=1, z=None):
    """A hand hanging from the wrist, fingers together and curled a little, thumb forward."""
    z = (SH_Z if z is None else z) * s
    bm = fuse([
        hull(ellipsoid((0.006, 0.580, z), (0.024, 0.012, 0.03)), ellipsoid((0.01, 0.540, z), (0.022, 0.025, 0.033))),
        hull(ellipsoid((0.01, 0.540, z), (0.02, 0.02, 0.031)), ellipsoid((0.022, 0.502, z), (0.018, 0.016, 0.027))),
        hull(ellipsoid((0.022, 0.565, z - 0.015 * s), (0.012, 0.012, 0.012)), ellipsoid((0.036, 0.536, z - 0.012 * s), (0.01, 0.014, 0.01))),
    ], voxel=0.005, faces=90, smooth_iter=2)
    paint(bm, S['skin'])
    return bm


def finger():
    """The taunt: the right fist, one finger up out of it (down, as the arm hangs at rest),
    oversized to read at a few pixels."""
    z = -SH_Z
    bm = fuse([
        ellipsoid((0.012, 0.540, z), (0.034, 0.034, 0.042)),
        hull(ellipsoid((0.02, 0.510, z), (0.016, 0.014, 0.016)), ellipsoid((0.022, 0.360, z), (0.014, 0.014, 0.014))),
    ], voxel=0.006, faces=110, smooth_iter=2)
    paint(bm, S['skin'])
    return bm


def boot(s=1, z=None, high=0.16):
    """A work boot round the ankle: shaft, laced front, heel and toe on a thick sole."""
    z = (HIP_Z if z is None else z) * s
    bm = fuse([
        hull(ellipsoid((-0.005, high, z), (0.054, 0.012, 0.05)), ellipsoid((-0.01, 0.06, z), (0.058, 0.035, 0.05))),
        hull(ellipsoid((0.0, 0.06, z), (0.05, 0.035, 0.05)), ellipsoid((0.095, 0.04, z), (0.042, 0.028, 0.044))),
        box((0.035, 0.014, z), (0.21, 0.028, 0.104), bevel=0.01),
    ], voxel=0.006, faces=160, smooth_iter=1)
    paint(bm, S['boot'])
    paint_by(bm, lambda x, y, z_: S['sole'] if y < 0.03 else None)
    return bm


def cut(bm, ys):
    """Slices bm across at each height, so the regions painted by height have straight edges."""
    for y in ys:
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=G(0, y, 0), plane_no=Vector((0, 0, 1)))
    bm.faces.ensure_lookup_table()


def dress_trunk(bm):
    """The trunk's regions: shirt from the belt to the collar, the neck above it, trousers below."""
    cut(bm, (1.04, 1.075, 1.0, 0.93, 0.86, 0.8, 0.72, 0.665, 0.605, 0.57, KNEE_Y + 0.02))
    def f(x, y, z):
        if y > 1.075 or (y > 1.04 and abs(z) < 0.06):
            return R['neck']
        if y > 0.665:
            return R['torso']
        if y > 0.605:
            return R['belt']
        if y > 0.47 and abs(z) < 0.2:
            return R['seat'] if abs(z) < 0.07 or y > 0.53 else R['thigh']
        return R['thigh'] if y > KNEE_Y + 0.02 else R['shin']
    paint_by(bm, f)


def dress_arm(bm):
    """Sleeve lengths: to the upper arm, the elbow, the forearm, the wrist."""
    cut(bm, (0.87, 0.705, 0.63))
    paint_by(bm, lambda x, y, z: R['uarm'] if y > 0.87 else R['elbow'] if y > 0.705 else R['farm'] if y > 0.63 else R['wrist'])


# ---- Hair and headgear ----------------------------------------------------------------------
#
# Hair is a shell over the cranium (its own sphere, so the hairline is clean), cut by a mask in
# the cranium's unit space: u forward, v up, w to the left.
CRANIUM = ((-0.006, 1.236, 0.0), (0.099, 0.084, 0.082))
HEAD_K = 1.1                  # heads a touch big, so faces and hair read from the camera
HEAD_AT = (0.01, 1.12, 0.0)   # what they are scaled about: the top of the neck
HEAD_DROP = 0.028             # and how far the head then sits down onto a short neck
HEAD_BACK = 0.86              # and the back of the skull drawn in, so heads are short front to back
TAIL_AT = (-0.085, 1.27, 0.0)  # where long hair swings from


def headspace(bm):
    """Scales a head piece about the top of the neck."""
    o = G(*HEAD_AT)
    for v in bm.verts:
        d = (v.co - o) * HEAD_K
        if d.x < 0:
            d.x *= HEAD_BACK
        v.co = o + d + G(0, -HEAD_DROP, 0)
    return bm


def cranial(mask, push=0.014, bump=0.0, seg=18, rings=12, solid=0.0):
    """Hair (or a cloth cap) over the cranium where mask(u, v, w) holds."""
    (cx, cy, cz), (rx, ry, rz) = CRANIUM
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    drop = []
    for f in bm.faces:
        c = f.calc_center_median()
        if not mask(c.x, c.z, -c.y):
            drop.append(f)
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    for i, v in enumerate(bm.verts):
        u, w_, h = v.co.x, -v.co.y, v.co.z
        k = push + bump * (rnd(i, 3) - 0.3)
        v.co = G(cx + u * (rx + k), cy + h * (ry + k), cz + w_ * (rz + k))
    if solid:
        bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=solid)
    return bm


def capline(u, v, w, front=0.36, nape=-0.5):
    """The hairline: high over the forehead, sloping down past the temples, low at the nape."""
    if u > 0.55:
        return v > front
    if u > -0.1:
        return v > front - 0.36 * (0.55 - u) / 0.65 - (0.1 if abs(w) > 0.75 else 0)
    return v > nape


def hair(style):
    """A hairstyle: (the part on the head, the part that swings)."""
    H, T = [], []
    cap = lambda u, v, w: capline(u, v, w)
    if style == 'bald':
        return None, None
    if style == 'buzz':
        H.append(cranial(cap, push=0.005))
    elif style == 'cornrows':
        H.append(cranial(cap, push=0.005))
        for w in (-0.045, -0.015, 0.015, 0.045):
            pts = [ellipsoid((x, 1.236 + 0.088 * math.sqrt(max(0, 1 - ((x + 0.006) / 0.103) ** 2)) - 0.002, w), (0.012, 0.008, 0.008), seg=6, rings=4)
                   for x in (0.07, 0.03, -0.02, -0.07)]
            for a, b in zip(pts, pts[1:]):
                H.append(hull(a.copy(), b.copy()))
    elif style == 'short':
        H.append(cranial(cap, push=0.016, bump=0.006))
    elif style == 'crop':
        H.append(cranial(lambda u, v, w: capline(u, v, w, front=0.28), push=0.013, bump=0.004))
    elif style == 'sidecut':
        H.append(cranial(lambda u, v, w: capline(u, v, w) and (w > -0.3 or v > 0.75), push=0.022, bump=0.008))
        H.append(cranial(lambda u, v, w: capline(u, v, w) and w <= -0.3, push=0.004))
    elif style == 'curly':
        H.append(cranial(lambda u, v, w: capline(u, v, w, front=0.3), push=0.03, bump=0.022))
    elif style == 'afro':
        H.append(cranial(cap, push=0.01))
        H.append(ellipsoid((-0.02, 1.3, 0), (0.15, 0.13, 0.145), seg=14, rings=9))
    elif style == 'mohawk':
        H.append(cranial(cap, push=0.004))
        H.append(hull(ellipsoid((0.07, 1.33, 0), (0.02, 0.03, 0.018)), ellipsoid((-0.02, 1.37, 0), (0.03, 0.04, 0.02)),
                      ellipsoid((-0.1, 1.3, 0), (0.02, 0.03, 0.018))))
    elif style == 'bun':
        H.append(cranial(lambda u, v, w: capline(u, v, w, front=0.42), push=0.012))
        H.append(ellipsoid((-0.085, 1.335, 0), (0.045, 0.042, 0.045), seg=10, rings=6))
    elif style == 'ponytail':
        H.append(cranial(lambda u, v, w: capline(u, v, w, front=0.42), push=0.013))
        T.append(hull(ellipsoid((-0.1, 1.29, 0), (0.025, 0.025, 0.025)), ellipsoid((-0.14, 1.2, 0), (0.03, 0.04, 0.03)),
                      ellipsoid((-0.15, 1.08, 0), (0.015, 0.02, 0.018))))
    elif style == 'long':
        H.append(cranial(lambda u, v, w: capline(u, v, w, front=0.4), push=0.016))
        for s in (1, -1):
            H.append(hull(ellipsoid((-0.02, 1.27, 0.083 * s), (0.05, 0.03, 0.014)), ellipsoid((-0.035, 1.14, 0.08 * s), (0.04, 0.03, 0.012))))
        T.append(hull(ellipsoid((-0.09, 1.27, 0), (0.025, 0.04, 0.08)), ellipsoid((-0.085, 1.02, 0), (0.025, 0.03, 0.09))))
    elif style == 'locs':
        H.append(cranial(cap, push=0.018, bump=0.008))
        for w in (-0.07, -0.025, 0.025, 0.07):
            T.append(hull(ellipsoid((-0.09, 1.25, w), (0.017, 0.017, 0.017)), ellipsoid((-0.095, 1.04, w * 1.2), (0.014, 0.014, 0.014))))
        for s in (1, -1):
            H.append(hull(ellipsoid((0.0, 1.22, 0.088 * s), (0.016, 0.016, 0.016)), ellipsoid((-0.01, 1.08, 0.09 * s), (0.014, 0.014, 0.014))))
    elif style == 'braids':
        H.append(cranial(lambda u, v, w: capline(u, v, w, front=0.42), push=0.011))
        for s in (1, -1):
            T.append(hull(ellipsoid((-0.08, 1.2, 0.06 * s), (0.02, 0.02, 0.02)), ellipsoid((-0.1, 1.0, 0.07 * s), (0.014, 0.014, 0.014))))
    elif style == 'bob':
        H.append(cranial(lambda u, v, w: capline(u, v, w, front=0.36) or (u < 0.5 and v > -0.75), push=0.02))
    elif style == 'headwrap':
        bm = cranial(lambda u, v, w: capline(u, v, w, front=0.4, nape=-0.65), push=0.03, bump=0.01)
        knot = ellipsoid((-0.1, 1.34, 0), (0.05, 0.04, 0.05), seg=8, rings=6)
        H += [bm, knot]
        for b in H:
            paint(b, S['wrap'])
        return headspace(join(*H)), None
    for b in H + T:
        paint(b, S['hair'])
    return headspace(join(*H)), (headspace(join(*T)) if T else None)


def hat(kind):
    """Headgear, on a bare head (the page lifts it over big hair)."""
    P = []

    def top(bm, y):
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < y], context='VERTS')
        return bm
    if kind == 'cap':
        P.append(top(ellipsoid((0.0, 1.258, 0), (0.108, 0.088, 0.093), seg=16, rings=10), 1.262))
        P.append(ellipsoid((0.11, 1.27, 0), (0.06, 0.008, 0.07), rot=(0, 0, -0.12), seg=12, rings=4))
    elif kind == 'hardhat':
        P.append(top(ellipsoid((0.0, 1.265, 0), (0.118, 0.11, 0.1), seg=16, rings=10), 1.262))
        P.append(ellipsoid((0.015, 1.265, 0), (0.15, 0.01, 0.128), seg=16, rings=4))
        P.append(hull(ellipsoid((0.1, 1.33, 0), (0.01, 0.01, 0.02)), ellipsoid((-0.1, 1.33, 0), (0.01, 0.01, 0.02)),
                      ellipsoid((0.0, 1.378, 0), (0.01, 0.01, 0.022))))
    elif kind == 'helmet':
        P.append(top(ellipsoid((0.0, 1.252, 0), (0.125, 0.115, 0.108), seg=16, rings=10), 1.215))
        P.append(ellipsoid((0.0, 1.218, 0), (0.135, 0.012, 0.118), seg=16, rings=4))
        for s in (1, -1):
            st = box((0.02, 1.16, 0.085 * s), (0.012, 0.11, 0.006), rot=(0, 0, 0.3))
            paint(st, fixed(0x2a2a20))
            P.append(st)
    elif kind == 'straw':
        P.append(hull(ellipsoid((0.0, 1.3, 0), (0.09, 0.03, 0.085)), ellipsoid((0.0, 1.36, 0), (0.075, 0.02, 0.07))))
        P.append(ellipsoid((0.0, 1.295, 0), (0.21, 0.012, 0.2), seg=16, rings=4))
        band = hull(ellipsoid((0.0, 1.31, 0), (0.092, 0.012, 0.087)))
        paint(band, fixed(0x5a3a1c))
        P.append(band)
    elif kind == 'bandana':
        P.append(cranial(lambda u, v, w: v > 0.15 and (u < 0.6 or v > 0.3), push=0.018))
        P.append(ellipsoid((-0.11, 1.26, 0), (0.025, 0.025, 0.035), seg=8, rings=5))
        P.append(hull(ellipsoid((-0.12, 1.25, 0.01), (0.01, 0.01, 0.02)), ellipsoid((-0.15, 1.17, 0.025), (0.008, 0.02, 0.02))))
    elif kind == 'beanie':
        P.append(top(ellipsoid((-0.008, 1.262, 0), (0.112, 0.112, 0.097), seg=16, rings=10), 1.255))
        P.append(hull(ellipsoid((0.0, 1.27, 0), (0.115, 0.022, 0.1))))
    elif kind == 'nursecap':
        P.append(hull(ellipsoid((0.04, 1.34, 0), (0.05, 0.02, 0.08)), ellipsoid((0.0, 1.355, 0), (0.04, 0.015, 0.07))))
        c = join(box((0.088, 1.352, 0), (0.006, 0.02, 0.006)), box((0.088, 1.352, 0), (0.006, 0.006, 0.02)))
        paint(c, fixed(0xd03030))
        P.append(c)
    else:
        return None
    for b in P:
        if all(f.material_index == 0 for f in b.faces):
            paint(b, S['hat'])
    return headspace(join(*P))


def beard(kind):
    """1 stubble (the page shades the jaw instead), 2 full, 3 a moustache."""
    if kind == 2:
        bm = headspace(hull(ellipsoid((0.064, 1.15, 0), (0.032, 0.03, 0.04)), ellipsoid((0.016, 1.178, 0), (0.05, 0.03, 0.062)),
                            ellipsoid((-0.004, 1.204, 0), (0.05, 0.02, 0.074))))
    elif kind == 3:
        bm = headspace(hull(ellipsoid((0.093, 1.176, 0.015), (0.008, 0.007, 0.02)), ellipsoid((0.093, 1.176, -0.015), (0.008, 0.007, 0.02))))
    else:
        return None
    paint(bm, S['hair'])
    return bm


def glasses():
    P = []
    for s in (1, -1):
        P.append(box((0.104, 1.216, 0.033 * s), (0.006, 0.024, 0.034)))
        P.append(box((0.06, 1.222, 0.08 * s), (0.08, 0.005, 0.005)))
    P.append(box((0.105, 1.222, 0), (0.005, 0.005, 0.03)))
    bm = join(*P)
    paint(bm, fixed(0x2a2a30))
    return headspace(bm)


# ---- Clothes over the shirt, and what they carry ------------------------------------------------

class Surf:
    """The trunk's surface, to lay straps, patches and packs on."""
    def __init__(self, trunk):
        from mathutils.bvhtree import BVHTree
        self.bvh = BVHTree.FromBMesh(trunk)

    def x(self, y, z, front=True):
        o = G(0.5 if front else -0.5, y, z)
        hit = self.bvh.ray_cast(o, Vector((-1 if front else 1, 0, 0)))
        return hit[0].x if hit[0] is not None else 0.0


def strap(surf, pts, front=True, w=0.022, t=0.006, lift=0.008):
    """A strap along the surface through (y, z) points, on the front or the back."""
    s = 1 if front else -1
    es = [ellipsoid((surf.x(y, z, front) + s * lift, y, z), (t, w / 2, w / 2), seg=6, rings=4) for y, z in pts]
    out = [hull(a.copy(), b.copy()) for a, b in zip(es, es[1:])]
    for e in es:
        e.free()
    return join(*out)


def over(kind, trunk, arms, fem=False):
    """What goes over the shirt: a hi-vis vest, a plate carrier, an overalls bib or an open
    jacket (whose sleeves go over the arms)."""
    P = []
    surf = Surf(trunk)
    if kind == 'vest':
        P.append(shell(trunk, lambda x, y, z: 0.605 < y < 1.04 and not (y > 0.99 and abs(z) < 0.075)
                       and not (x > 0.03 and abs(z) < 0.035 + (y - 0.85) * 0.3 and y > 0.85), 0.016))
    elif kind == 'plate':
        for front in (True, False):
            sgn = 1 if front else -1
            P.append(shell(trunk, lambda x, y, z: 0.72 < y < 1.0 and abs(z) < 0.11 and x * sgn > 0.02, 0.032))
        P.append(shell(trunk, lambda x, y, z: 0.72 < y < 0.8, 0.026))
        for z in (-0.065, 0.0, 0.065):
            b = box((surf.x(0.79, z) + 0.05, 0.79, z), (0.035, 0.06, 0.05), bevel=0.008)
            paint(b, R['torso'] if False else S['over'])
            P.append(b)
        for s in (1, -1):
            P.append(strap(surf, [(0.98, 0.08 * s), (1.04, 0.1 * s)], True, w=0.04, lift=0.02))
            P.append(strap(surf, [(1.04, 0.1 * s), (0.98, 0.08 * s)], False, w=0.04, lift=0.02))
    elif kind == 'bib':
        P.append(shell(trunk, lambda x, y, z: 0.605 < y < 0.93 and abs(z) < 0.095 and x > 0.0, 0.011))
        P.append(shell(trunk, lambda x, y, z: 0.605 < y < 0.86 and abs(z) < 0.11 and x < 0.0, 0.011))
        for s in (1, -1):
            P.append(strap(surf, [(0.9, 0.07 * s), (0.98, 0.075 * s), (1.03, 0.085 * s)], True, w=0.03))
            P.append(strap(surf, [(1.03, 0.085 * s), (0.95, 0.06 * s), (0.86, 0.05 * s)], False, w=0.03))
            btn = box((surf.x(0.9, 0.07 * s) + 0.016, 0.9, 0.07 * s), (0.01, 0.018, 0.018))
            paint(btn, fixed(0xb0a890))
            P.append(btn)
    elif kind == 'open':
        P.append(shell(trunk, lambda x, y, z: 0.57 < y < 1.04 and not (y > 1.0 and abs(z) < 0.07), 0.017))
        # Hanging open on the shirt.
        front = strap(surf, [(1.0, 0.0), (0.8, 0.0), (0.6, 0.0)], True, w=0.05, lift=0.02)
        paint(front, S['shirt'])
        P.append(front)
        P.append(hull(ellipsoid((-0.02, 1.05, 0), (0.07, 0.03, 0.09)), ellipsoid((0.0, 1.08, 0), (0.06, 0.02, 0.075))))
        for a in arms:
            P.append(shell(a, lambda x, y, z: y > 0.64, 0.011))
    for b in P:
        if all(f.material_index < 64 for f in b.faces):
            paint(b, S['over'])
    # One colour over a smooth body: half the body's triangles do.
    return thin(join(*P), 0.45)


def band(surf, y, h, lift, n=24):
    """A band round the trunk at height y, h tall, lift off the surface."""
    bm = bmesh.new()
    rows = []
    for yy in (y - h / 2, y + h / 2):
        row = []
        for i in range(n):
            a = 2 * math.pi * i / n
            d = Vector((math.cos(a), -math.sin(a), 0))
            hit = surf.bvh.ray_cast(G(0, yy, 0) + d * 0.5, -d)
            p = hit[0] if hit[0] is not None else G(0, yy, 0) + d * 0.1
            row.append(bm.verts.new(p + d * lift))
        rows.append(row)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((rows[0][i], rows[0][j], rows[1][j], rows[1][i]))
    bm.normal_update()
    return bm


def stripes(trunk, on_vest=False):
    """Reflective bands round the chest and belly."""
    surf = Surf(trunk)
    k = 0.024 if on_vest else 0.01
    bm = join(band(surf, 0.78, 0.03, k), band(surf, 0.94, 0.03, k))
    paint(bm, S['stripe'])
    return bm


def chest(kind, trunk):
    """A red cross, a tie on a white shirt front, a lanyard and badge, or a breast pocket."""
    surf = Surf(trunk)
    P = []
    fx = lambda y, z, k=0.006: surf.x(y, z) + k
    if kind == 'cross':
        z, y = 0.065, 0.95
        P.append(box((fx(y, z), y, z), (0.008, 0.05, 0.016)))
        P.append(box((fx(y, z), y, z), (0.008, 0.016, 0.05)))
        bx = surf.x(0.9, 0, False) - 0.006
        P.append(box((bx, 0.9, 0), (0.008, 0.09, 0.03)))
        P.append(box((bx, 0.9, 0), (0.008, 0.03, 0.09)))
        for b in P:
            paint(b, fixed(0xd03030))
    elif kind == 'tie':
        sh = strap(surf, [(1.0, 0.0), (0.86, 0.0), (0.72, 0.0)], True, w=0.075, lift=0.004)
        paint(sh, fixed(0xe6e2d8))
        tie = strap(surf, [(1.0, 0.0), (0.97, 0.0), (0.76, 0.0)], True, w=0.03, lift=0.01)
        paint(tie, fixed(0x8a2a2a))
        P += [sh, tie]
    elif kind == 'lanyard':
        for s in (1, -1):
            P.append(strap(surf, [(1.03, 0.07 * s), (0.95, 0.03 * s), (0.88, 0.006 * s)], True, w=0.012))
        P.append(box((fx(0.85, 0, 0.01), 0.85, 0), (0.008, 0.06, 0.045)))
        for b in P:
            paint(b, fixed(0xe8e8e8))
    elif kind == 'pocket':
        P.append(box((fx(0.94, -0.07), 0.94, -0.07), (0.01, 0.06, 0.055)))
        for b in P:
            paint(b, S['shirt2'])
    else:
        return None
    return join(*P)


def pack(kind, trunk, fem=False):
    """What they carry on their back (or at the belt, for the toolbelt)."""
    surf = Surf(trunk)
    bx = lambda y, z=0.0: surf.x(y, z, False)
    P = []
    straps = lambda col, w=0.03: [(strap(surf, [(0.8, 0.08 * s), (0.95, 0.08 * s), (1.03, 0.085 * s)], True, w=w),
                                   strap(surf, [(1.03, 0.085 * s), (0.95, 0.08 * s), (0.8, 0.08 * s)], False, w=w)) for s in (1, -1)]
    if kind == 'medbag':
        b = box((bx(0.86) - 0.06, 0.86, 0), (0.11, 0.24, 0.26), bevel=0.02)
        paint(b, fixed(0xb83a2a))
        c = join(box((bx(0.86) - 0.117, 0.88, 0), (0.008, 0.11, 0.035)), box((bx(0.86) - 0.117, 0.88, 0), (0.008, 0.035, 0.11)))
        paint(c, fixed(0xf0f0e8))
        P += [b, c]
        for a, b2 in straps(0x2a2018):
            paint(a, fixed(0x2a2018)); paint(b2, fixed(0x2a2018)); P += [a, b2]
    elif kind == 'wrench':
        w = bmesh.new()
        shaft = cylinder((bx(0.7, 0.1) - 0.03, 0.7, 0.12), (bx(1.0, -0.1) - 0.03, 1.08, -0.11), 0.016, seg=6)
        jaw = box((bx(1.0, -0.1) - 0.03, 1.1, -0.12), (0.03, 0.07, 0.09), bevel=0.008, rot=(0.75, 0, 0))
        P += [shaft, jaw]
        for b in P:
            paint(b, fixed(0x8a8c90))
        s2 = strap(surf, [(1.03, -0.09), (0.9, 0.0), (0.72, 0.1)], True, w=0.025)
        paint(s2, fixed(0x3a2616))
        P.append(s2)
    elif kind == 'pack':
        b = box((bx(0.86) - 0.08, 0.85, 0), (0.15, 0.3, 0.27), bevel=0.025)
        flap = box((bx(0.98) - 0.085, 0.97, 0), (0.16, 0.06, 0.25), bevel=0.02)
        side = [box((bx(0.8, 0.12) - 0.07, 0.8, 0.15 * s), (0.1, 0.14, 0.05), bevel=0.012) for s in (1, -1)]
        for x in [b, flap] + side:
            paint(x, fixed(0x55593c))
        P += [b, flap] + side
        for a, b2 in straps(0x44482f):
            paint(a, fixed(0x44482f)); paint(b2, fixed(0x44482f)); P += [a, b2]
    elif kind == 'bigpack':
        b = box((bx(0.88) - 0.1, 0.9, 0), (0.19, 0.44, 0.3), bevel=0.03)
        paint(b, fixed(0xc8a03a))
        roll = cylinder((bx(1.1) - 0.1, 1.15, 0.17), (bx(1.1) - 0.1, 1.15, -0.17), 0.055, seg=10)
        paint(roll, fixed(0x3a5a2a))
        pocket = box((bx(0.82) - 0.2, 0.8, 0), (0.05, 0.18, 0.22), bevel=0.02)
        paint(pocket, fixed(0xa8802a))
        P += [b, roll, pocket]
        for a, b2 in straps(0x2a2a2a):
            paint(a, fixed(0x2a2a2a)); paint(b2, fixed(0x2a2a2a)); P += [a, b2]
    elif kind == 'toolbelt':
        belt = band(surf, 0.62, 0.05, 0.014)
        paint(belt, fixed(0x6a4a28))
        pouches = [box((surf.x(0.58, 0.12 * s) - 0.02, 0.56, 0.135 * s), (0.08, 0.1, 0.05), bevel=0.012) for s in (1, -1)]
        for b in pouches:
            paint(b, fixed(0x5a3e22))
        ham = cylinder((surf.x(0.58, 0.14), 0.6, 0.15), (surf.x(0.58, 0.14) + 0.01, 0.44, 0.15), 0.01, seg=6)
        paint(ham, fixed(0x8a8c90))
        P += [belt, ham] + pouches
    elif kind == 'satchel':
        bag = box((0.02, 0.62, 0.165), (0.17, 0.15, 0.06), bevel=0.02)
        paint(bag, fixed(0x5a3a22))
        sa = strap(surf, [(0.66, 0.13), (0.8, 0.07), (0.95, -0.03), (1.035, -0.1)], True, w=0.025)
        sb = strap(surf, [(1.035, -0.1), (0.9, -0.02), (0.75, 0.08), (0.66, 0.13)], False, w=0.025)
        paint(sa, fixed(0x3a2616)); paint(sb, fixed(0x3a2616))
        P += [bag, sa, sb]
    elif kind == 'bedroll':
        b = box((bx(0.82) - 0.06, 0.82, 0), (0.11, 0.24, 0.24), bevel=0.02)
        paint(b, fixed(0x5a4a2a))
        roll = cylinder((bx(1.0) - 0.08, 1.06, 0.2), (bx(1.0) - 0.08, 1.06, -0.2), 0.06, seg=10)
        paint(roll, fixed(0x3e5a34))
        P += [b, roll]
        for a, b2 in straps(0x2a2018):
            paint(a, fixed(0x2a2018)); paint(b2, fixed(0x2a2018)); P += [a, b2]
    else:
        return None
    return join(*P)


# ---- Writing the module -----------------------------------------------------------------------

def survivor_pieces():
    """Every survivor piece by name, with how its vertices take joints."""
    TRUNK = {PELVIS, CHEST, THIGH_L, SHIN_L, THIGH_R, SHIN_R}
    ARMS = {UARM_L, FARM_L, UARM_R, FARM_R}
    out = {}
    skin_tone = weathered(dirt=0.0, grain=0.05)
    cloth = weathered()
    for fem, g in ((False, 'm'), (True, 'f')):
        sz = SH_Z * (0.93 if fem else 1)
        bones = hero_bones(fem)
        trunk, al, ar = body(fem)
        dress_trunk(trunk)
        dress_arm(al)
        dress_arm(ar)
        arms = join(al, ar)
        rig = dict(bones=bones, blend=0.05)
        out['trunk_' + g] = encode(trunk, bones, allow=TRUNK, blend=0.05, tone=cloth)
        out['arms_' + g] = encode(arms, bones, allow=ARMS, blend=0.05, tone=cloth)
        out['head_' + g] = encode(head(fem), joint=HEAD, tone=skin_tone)
        out['face_' + g] = encode(face(fem), joint=HEAD, smooth_=False)
        out['hands_' + g] = encode(join(hand(1, sz), hand(-1, sz)), bones, allow={FARM_L, FARM_R}, tone=skin_tone)
        out['finger_' + g] = encode(finger_at(sz), joint=FARM_R, tone=skin_tone)
        hz = HIP_Z * (1.07 if fem else 1)
        out['boots_' + g] = encode(join(boot(1, hz), boot(-1, hz)), bones, allow={SHIN_L, SHIN_R}, tone=cloth, smooth_=False)
        for k in ('vest', 'plate', 'bib', 'open'):
            out['over_%s_%s' % (k, g)] = encode(over(k, trunk, [al, ar], fem), bones, allow=TRUNK | ARMS, blend=0.05, tone=cloth)
        out['stripes_' + g] = encode(stripes(trunk), bones, allow=TRUNK, blend=0.05, smooth_=False)
        out['vstripes_' + g] = encode(stripes(trunk, True), bones, allow=TRUNK, blend=0.05, smooth_=False)
        for k in ('cross', 'tie', 'lanyard', 'pocket'):
            out['chest_%s_%s' % (k, g)] = encode(chest(k, trunk), joint=CHEST, smooth_=False)
        for k in ('medbag', 'wrench', 'pack', 'bigpack', 'satchel', 'bedroll', 'toolbelt'):
            out['pack_%s_%s' % (k, g)] = encode(pack(k, trunk, fem), joint=PELVIS if k == 'toolbelt' else X2, tone=cloth, smooth_=False)
    for st in ('buzz', 'short', 'crop', 'afro', 'curly', 'locs', 'braids', 'cornrows', 'ponytail', 'bun', 'long', 'bob',
               'mohawk', 'sidecut', 'headwrap'):
        h, t = hair(st)
        out['hair_' + st] = encode(h, joint=HEAD, tone=weathered(dirt=0, grain=0.12))
        if t:
            out['tail_' + st] = encode(t, joint=X, tone=weathered(dirt=0, grain=0.12))
    for k in ('cap', 'hardhat', 'helmet', 'straw', 'bandana', 'beanie', 'nursecap'):
        out['hat_' + k] = encode(hat(k), joint=HEAD, tone=weathered(dirt=0, grain=0.06), smooth_=k in ('bandana', 'beanie'))
    out['beard_2'] = encode(beard(2), joint=HEAD, tone=weathered(dirt=0, grain=0.12))
    out['beard_3'] = encode(beard(3), joint=HEAD)
    out['glasses'] = encode(glasses(), joint=HEAD, smooth_=False)
    return out


def finger_at(sz):
    bm = finger()
    for v in bm.verts:
        v.co.y += SH_Z - sz   # Blender -y is the figure's left: the right hand sits at -sz
    return bm


def survivor_rig():
    """The pivots heroes.ts builds its groups at."""
    def head_pt(p):
        d = [(p[i] - HEAD_AT[i]) * HEAD_K for i in range(3)]
        if d[0] < 0:
            d[0] *= HEAD_BACK
        return [round(HEAD_AT[i] + d[i] - (HEAD_DROP if i == 1 else 0), 4) for i in range(3)]
    return {
        'hipY': HIP_Y, 'hipZ': HIP_Z, 'kneeY': KNEE_Y, 'ankleY': ANKLE_Y, 'waist': WAIST,
        'shY': SH_Y, 'shZ': SH_Z, 'elbowY': ELBOW_Y, 'handY': HAND_Y, 'neck': list(NECK) + [0],
        'tail': head_pt(TAIL_AT), 'eye': head_pt((0.09, 1.212, 0.031)), 'mouth': head_pt((0.093, 1.1635, 0)),
        'brow': head_pt((0.092, 1.234, 0.031)), 'top': head_pt((0, 1.32, 0))[1],
    }


def write(pieces, extra=None):
    import json
    lines = ['// Generated by tools/blender/figures.py: do not edit; change the script and run it in Blender.',
             '/* eslint-disable */', '',
             'export const SLOTS = %s as const;' % json.dumps(SLOTS),
             'export const REGIONS = %s as const;' % json.dumps(REGIONS),
             'export const PALETTE = [%s];' % ', '.join('0x%06x' % c for c in PALETTE),
             '']
    for k, v in (extra or {}).items():
        lines.append('export const %s = %s;' % (k, json.dumps(v)))
    lines.append('')
    lines.append('export interface Enc { v: string; t: string; c: string; k: string; s: number; j?: string; j0?: number }')
    lines.append('export const PIECES: Record<string, Enc> = {')
    for k, v in pieces.items():
        lines.append('  %s: %s,' % (json.dumps(k), json.dumps(v, separators=(',', ':'))))
    lines.append('};')
    lines.append('')
    with open(OUT, 'w') as f:
        f.write('\n'.join(lines))
    print('wrote', OUT, sum(len(json.dumps(v)) for v in pieces.values()) // 1024, 'KB')


def show_heads():
    """Two big heads, smooth shaded, to study the face."""
    for o in list(bpy.data.objects):
        if o.name.startswith('study'):
            bpy.data.objects.remove(o)
    for i, (fem, st) in enumerate(((False, 'short'), (True, 'bun'))):
        bm = join(head(fem), face(fem), hair(st)[0])
        for v in bm.verts:
            v.co *= 4
        preview('study_' + ('f' if fem else 'm'), bm, at=(0, -2.5, (i - 0.5) * 1.2))
        ob = bpy.data.objects['study_' + ('f' if fem else 'm')]
        for p_ in ob.data.polygons:
            p_.use_smooth = True


def show_survivors():
    """A row of dressed survivors in the scene, to look at."""
    for o in list(bpy.data.objects):
        if o.name.startswith('hero'):
            bpy.data.objects.remove(o)
    outfits = [('vest', 'hardhat', 'toolbelt', None, 'short', False, 1), ('plate', 'helmet', 'pack', None, 'buzz', False, 0),
               ('bib', 'straw', None, 'pocket', 'long', True, 0), ('open', 'bandana', None, None, 'ponytail', True, 0),
               (None, 'beanie', 'bigpack', None, 'curly', True, 0), (None, 'cap', 'medbag', 'cross', 'crop', False, 2),
               (None, None, 'satchel', 'tie', 'sidecut', False, 3), (None, 'nursecap', None, 'lanyard', 'bun', True, 0)]
    for i, (ov, ht, pk, ch, st, fem, bd) in enumerate(outfits):
        tr, a, b = body(fem)
        dress_trunk(tr)
        dress_arm(a)
        dress_arm(b)
        sz = SH_Z * (0.93 if fem else 1)
        hz = HIP_Z * (1.07 if fem else 1)
        parts = [tr, a, b, head(fem), face(fem), hand(1, sz), hand(-1, sz), boot(1, hz), boot(-1, hz)]
        if ov:
            parts.append(over(ov, tr, [a, b], fem))
        if ov == 'vest' or i == 5:
            parts.append(stripes(tr, ov == 'vest'))
        for x in (hat(ht) if ht else None, pack(pk, tr, fem) if pk else None, chest(ch, tr) if ch else None, beard(bd), *hair(st)):
            if x:
                parts.append(x)
        preview('hero%d' % i, join(*parts), at=(0, 0, (i - 4) * 0.6))


def main():
    write(survivor_pieces(), {'SURVIVOR': survivor_rig()})
    show_survivors()


if __name__ == '__main__':
    main()
