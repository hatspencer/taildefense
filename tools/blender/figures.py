# The survivors', creeps', guns' and turrets' meshes, built in Blender and written out as
# web/src/scene/figures.gen.ts. Run it in Blender (Text editor, or blender -b -P this file);
# it rebuilds a preview of every piece in the open scene and rewrites the module.
#
# Everything here is in game space: x forward, y up, z to the figure's left, one unit a metre
# before the hero's 1.15 scale. Bodies and heads are hulls of ellipsoids fused into one surface
# (voxel remeshed, smoothed, cut down), so torso, neck, hips and legs are one skin; boots,
# hands, hair, hats, packs and the clothes over the shirt are their own pieces laid on it.
#
# In Blender: run the file to rewrite the module and lay out a row of dressed survivors, the
# creeps, the guns (twice their size) and the turrets;
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


# How the page might dress a creep, to look at one in Blender.
DEAD = {'skin': 0x8a8e74, 'shirt': 0xc8b894, 'pants': 0x3c3a36, 'hair': 0x2a2420}


def code_color(k, pal=None):
    if k < 32:
        return (pal or {}).get(SLOTS[k]) or PREVIEW[SLOTS[k]]
    if k < 64:
        n = REGIONS[k - 32]
        return PREVIEW['belt_r' if n == 'belt' else n]
    return PALETTE[k - 64]


def preview(name, bm, at=(0, 0, 0), coll='figures', pal=None):
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
        mn = ('dead_%d' if pal else 'fig_%d') % k
        m = bpy.data.materials.get(mn) or bpy.data.materials.new(mn)
        h = code_color(k, pal)
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


# ---- Creeps -----------------------------------------------------------------------------
#
# The dead, on the same tools as the living: each from a posed skeleton (hunched, knees
# bent, the head pushed forward, hands hooked), the body fused round it as one skin and each
# arm as another, the head a survivor's gone wrong. Clothes are painted on by which bone a
# face is nearest and how far along it, in the slots the page swaps per creep, so a horde is
# a crowd of different people; what is fixed (blood, bone, the builder's vest) is a palette
# colour. Every vertex moves with one joint, as the creeps' shader poses them, about the
# pivots creep_pieces() writes out for creepModels.ts.

BLOOD, GORE, BONE, SOCKET, EYEBALL, GUM, SHOE = 0x4a0c0a, 0x6a1410, 0xd8ccb0, 0x1a0c08, 0xc8c098, 0x2a0806, 0x2a2420
ROT, FLESH, VEST, REFLECT, HARDHAT = 0x4e4a3e, 0x8a3a30, 0xe0661c, 0xe8d040, 0xe8b818
BILE, PUS, VEIN, EGG = 0x7a8a34, 0xc8c060, 0x3e2e2a, 0xc4c890


def noise(x, y, z, f=10.0, seed=0):
    """A smooth value in 0..1 wandering over the body: for stains, tears and blotches."""
    a = seed * 2.39996
    v = (math.sin(x * f * 1.31 + a) * math.cos(y * f * 0.97 - a * 1.7)
         + math.sin(y * f * 1.53 + z * f * 0.71 + a * 2.3) * math.cos(z * f * 1.19 - x * f * 0.43)
         + math.sin(z * f * 1.77 + a * 0.6) * math.cos(x * f * 1.07 + y * f * 0.61 + a))
    return 0.5 + v / 6


def vadd(a, b, k=1.0):
    return tuple(a[i] + b[i] * k for i in range(3))


def vsub(a, b):
    return tuple(a[i] - b[i] for i in range(3))


def vlerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def vnorm(a):
    n = math.sqrt(sum(c * c for c in a)) or 1.0
    return tuple(c / n for c in a)


def vcross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def limb(a, b, ra, rb):
    return hull(ellipsoid(a, ra), ellipsoid(b, rb))


def ball(c, r, seg=8, rings=6):
    return ellipsoid(c, (r, r, r), seg=seg, rings=rings)


def spike(a, b, r):
    bm = cylinder(a, b, r, 0.002, seg=5)
    paint(bm, fixed(BONE))
    return bm


def claw(wr, d, c, k=1.0, long=1.0):
    """A hand from the wrist: the palm, four fingers going d and hooking towards c, a thumb.
    Returns the parts and where the hand ends."""
    d, c = vnorm(d), vnorm(c)
    e = vnorm(vcross(d, c))
    p0, p1 = vadd(wr, d, 0.014 * k), vadd(wr, d, 0.05 * k)
    P = [hull(*[ball(vadd(p, e, s * w * k), 0.011 * k, 6, 4) for p, w in ((p0, 0.016), (p1, 0.02)) for s in (1, -1)])]
    for i, t in enumerate((-1.5, -0.5, 0.5, 1.5)):
        L = (0.85, 1.05, 1.1, 1.0)[i] * k * long
        a = vadd(p1, e, t * 0.012 * k)
        b = vadd(vadd(a, d, 0.03 * L), c, 0.008 * k)
        tip = vadd(vadd(b, d, 0.02 * L), c, 0.018 * k)
        P += [hull(ball(a, 0.0075 * k, 6, 4), ball(b, 0.007 * k, 6, 4)), hull(ball(b, 0.007 * k, 6, 4), ball(tip, 0.006 * k, 6, 4))]
    th = vadd(p0, e, 0.022 * k)
    P.append(hull(ball(th, 0.008 * k, 6, 4), ball(vadd(vadd(vadd(th, d, 0.025 * k), e, 0.01 * k), c, 0.012 * k), 0.0065 * k, 6, 4)))
    return P, vadd(p1, d, 0.05 * k * long)


def nearest(segs, p):
    """The segment (name, a, b) p is nearest, how far along it, and that point."""
    best = None
    for name, a, b in segs:
        dist, t = seg_dist(p, a, b)
        if best is None or dist < best[0]:
            best = (dist, name, t, vlerp(a, b, t))
    return best[1:]


def paint_segs(bm, segs, fn):
    """Each face the code fn(name, t, p, c) gives: the bone it is nearest, how far along, the
    face's centre and the point on the bone."""
    for f in bm.faces:
        p = tuple(back(f.calc_center_median()))
        name, t, c = nearest(segs, p)
        k = fn(name, t, p, c)
        if k is not None:
            f.material_index = k


class Skel:
    """A posed skeleton: spine points (x, y) and the left side's (x, y, z); a right side as R
    overrides, given with z positive too."""
    def __init__(self, sp):
        self.sp = sp

    def __call__(self, k, s=1):
        p = (self.sp.get('R', {}).get(k) if s < 0 else None) or self.sp[k]
        return (p[0], p[1], (p[2] if len(p) > 2 else 0.0) * s)


def dead_head(at, k=1.0, hairdo='patchy', tilt=0.0, gape=1.0, pale=None, seed=0):
    """A survivor's head, dead: the eyes sunk in dark sockets, the mouth hanging open, the
    hair coming out in patches (or bald, or long and lank). at is where the neck meets it, k
    its size; tilt turns it about the neck (below 0 bows it)."""
    bm = thin(head(False), 0.5)
    rg = survivor_rig()
    ex, ey, ez = rg['eye']
    mx, my, _ = rg['mouth']
    top = rg['top']

    def code(x, y, z):
        if x > 0.05 and ((y - ey) / 0.022) ** 2 + ((abs(z) - ez) / 0.026) ** 2 < 1:
            return fixed(SOCKET)
        if x > 0.06 and abs(z) < 0.03 * gape + 0.004 and my - 0.024 * gape < y < my + 0.006:
            return fixed(GUM)
        if hairdo in ('patchy', 'long') and y > top - 0.08 + 0.02 * (x > 0.04) and noise(x, y, z, 40, seed) > 0.42:
            return S['hair']
        if noise(x, y, z, 30, seed + 9) > 0.7:
            return fixed(BLOOD)
        return pale if pale is not None else S['skin']
    paint_by(bm, code)
    parts = [bm]
    for s in (1, -1):
        e = ellipsoid((ex - 0.012, ey, ez * s), (0.008, 0.008, 0.009), seg=6, rings=4)
        paint(e, fixed(EYEBALL))
        parts.append(e)
    t = box((mx - 0.012, my - 0.018 * gape, 0), (0.008, 0.006, 0.036))
    paint(t, fixed(BONE))
    parts.append(t)
    if hairdo == 'long':
        h, tail = hair('long')
        parts += [h, tail]
        for s in (1, -1):
            # Lank strands hanging over the face.
            st = hull(ellipsoid((0.06, 1.3, 0.05 * s), (0.02, 0.02, 0.016)), ellipsoid((0.1, 1.08, 0.06 * s), (0.012, 0.03, 0.012)))
            paint(st, S['hair'])
            parts.append(st)
    bm = join(*parts)
    nx, ny, _ = rg['neck']
    c, sn = math.cos(tilt), math.sin(tilt)
    for v in bm.verts:
        x, y, z = back(v.co)
        x, y = x - nx, y - ny
        x, y = x * c - y * sn, x * sn + y * c
        v.co = G(at[0] + x * k, at[1] + y * k, at[2] + z * k)
    return bm


def outfit(o):
    """Paints clothes by bone: o['shirt'] is 'short', 'long', 'tank', 'open', 'gown' or None;
    o['pants'] 'long', 'shorts' or None; o['shoes']; o['seed'] varies the stains and tears."""
    sh, pa, shoes, sd = o.get('shirt'), o.get('pants'), o.get('shoes', True), o.get('seed', 0)

    def cloth(name, t, p, c):
        x, y, z = p
        jag = 0.1 * abs(math.sin(math.atan2(z - c[2], x - c[0]) * 4 + sd))
        front = x > c[0] + 0.02
        if name == 'foot':
            return 'shoe' if shoes else None
        if name == 'shin':
            if shoes and t > 0.82:
                return 'shoe'
            return 'pants' if pa == 'long' and t < 0.8 + jag else None
        if name == 'thigh':
            if sh == 'gown' and t < 0.65 - 2 * jag:
                return 'shirt'
            return 'pants' if pa == 'long' or (pa == 'shorts' and t < 0.45 - jag) else None
        if name in ('hip', 'seat'):
            if sh in ('long', 'short', 'open') and name == 'seat' and t > 0.5 - jag or sh == 'gown':
                return 'shirt'
            return 'pants' if pa else None
        if name == 'gut':
            return 'shirt' if sh == 'gown' and not front else None
        if name in ('belly', 'chest'):
            if not sh:
                return None
            if sh == 'open' and front and abs(z) < 0.03 + 0.05 * (1 - t if name == 'belly' else 0.4):
                return None
            if sh == 'tank' and name == 'chest' and t > 0.55 and abs(z) > 0.07:
                return None
            if sh == 'gown' and name == 'chest' and t > 0.8 and front:
                return None
            return 'shirt'
        if name == 'shoulder':
            return 'shirt' if sh and (sh != 'tank' or t < 0.3) and (sh != 'gown' or t < 0.6) else None
        if name == 'upper':
            return 'shirt' if sh in ('long', 'open') or sh == 'short' and t < 0.65 - jag or sh == 'gown' and t < 0.2 else None
        if name == 'fore':
            return 'shirt' if sh in ('long', 'open') and t < 0.45 - jag else None
        return None

    def fn(name, t, p, c):
        x, y, z = p
        k = cloth(name, t, p, c)
        if k == 'shoe':
            return fixed(SHOE)
        if k:
            hole = noise(x, y, z, 9, sd)
            if hole > 0.69:
                k = None
            elif hole > 0.675 or (x > c[0] and noise(x, y, z, 7, sd + 3) > 0.68):
                return fixed(BLOOD)
            else:
                return S[k]
        # Bare skin: dried blood, rot.
        n = noise(x, y, z, 13, sd + 5)
        if name == 'hand' and t > 0.75 and n > 0.45:
            return fixed(BLOOD)
        if n > 0.74:
            return fixed(BLOOD)
        if n < 0.25:
            return fixed(ROT)
        return S['skin']
    return fn


def zombie(sp):
    """A dead body on the skeleton sp, dressed: the trunk and legs as one skin and each arm
    its own, with the bones each moves with, the segments its clothes are painted by, and
    its pivots."""
    K = Skel(sp)
    w, g = sp.get('w', 1.0), sp.get('g', 1.0)
    pel, wai, chs, top, nk = K('pel'), K('wai'), K('chs'), K('top'), K('nk')
    n = {
        'pel': (pel, (0.1 * w, 0.08, 0.125 * w)),
        'wai': (wai, (0.085 * w, 0.075, 0.112 * w)),
        'chs': (chs, (0.1 * w, 0.09, 0.13 * w)),
        'top': (top, (0.07 * w, 0.05, 0.11 * w)),
        'nk': (nk, (0.04 * w ** 0.5, 0.05, 0.042 * w ** 0.5)),
    }
    links = [('pel', 'wai'), ('wai', 'chs'), ('chs', 'top'), ('top', 'nk')]
    mid = vlerp(pel, wai, 0.5)
    segs = [('seat', pel, mid), ('belly', mid, chs), ('chest', chs, top), ('neck', top, nk)]
    bones = [(PELVIS, pel, vlerp(pel, wai, 0.3)), (CHEST, vlerp(pel, wai, 0.45), wai), (CHEST, wai, chs), (CHEST, chs, top),
             (CHEST, top, nk), (HEAD, nk, vadd(nk, (0, 0.2, 0)))]
    for s in (1, -1):
        L = 'L' if s > 0 else 'R'
        th, sh_ = (THIGH_L, SHIN_L) if s > 0 else (THIGH_R, SHIN_R)
        hp, kn, an, to, sh = K('hp', s), K('kn', s), K('an', s), K('to', s), K('sh', s)
        he = (an[0] - 0.025, 0.03, an[2])
        n['sc' + L] = (sh, (0.05 * w, 0.05, 0.05 * w))
        n['hp' + L] = (hp, (0.078 * w, 0.075, 0.078 * w))
        n['kn' + L] = (kn, (0.05 * g, 0.048, 0.05 * g))
        n['an' + L] = (an, (0.034 * g, 0.032, 0.034 * g))
        n['he' + L] = (he, (0.032, 0.03, 0.034))
        n['to' + L] = (to, (0.03, 0.022, 0.04))
        links += [('top', 'sc' + L), ('pel', 'hp' + L), ('hp' + L, 'kn' + L), ('kn' + L, 'an' + L), ('an' + L, 'he' + L, 'to' + L)]
        segs += [('shoulder', top, sh), ('hip', pel, hp), ('thigh', hp, kn), ('shin', kn, an), ('foot', an, to)]
        bones += [(CHEST, top, sh), (PELVIS, pel, hp), (th, hp, kn), (sh_, kn, an), (sh_, an, to)]
    if 'gut' in sp:
        gc, gr = sp['gut']
        segs.append(('gut', wai, gc))
        bones.append((CHEST, wai, gc))
    extra = [f() for f in sp.get('extra', ())]
    if 'gut' in sp:
        extra.append(hull(ellipsoid(sp['gut'][0], sp['gut'][1], seg=16, rings=10), ellipsoid(chs, (0.09 * w, 0.08, 0.12 * w))))
    trunk = fuse(blob(n, links, extra), voxel=sp.get('voxel', 0.01), faces=sp.get('faces', 800), smooth_iter=5)
    dress = sp.get('dress') or outfit(sp)
    paint_segs(trunk, segs, dress)
    arms, abones = [], []
    piv = {'chest': vlerp(pel, wai, 0.3), 'head': nk}
    for s in (1, -1):
        u, f = (UARM_L, FARM_L) if s > 0 else (UARM_R, FARM_R)
        ak = sp.get('armk', (1.0, 1.0))[0 if s > 0 else 1]
        sh, el, wr = K('sh', s), K('el', s), K('wr', s)
        a = {'sh': (sh, (0.048 * w * ak, 0.052 * ak, 0.046 * w * ak)), 'el': (el, (0.035 * g * ak,) * 3),
             'wr': (wr, (0.026 * g * ak, 0.024 * ak, 0.028 * g * ak))}
        flat = sp.get('flat')
        hd, tip = claw(wr, (1, -0.25, 0) if flat else vsub(wr, el), (0, -1, 0) if flat else (0.4, 0, -s),
                       ak * sp.get('hand', 1.0), sp.get('fingers', 1.0))
        bm = fuse(blob(a, [('sh', 'el'), ('el', 'wr')], hd), voxel=0.0055 * max(1.0, ak * 0.7), faces=sp.get('armfaces', 240) * (1.5 if ak > 1.5 else 1))
        aseg = [('upper', sh, el), ('fore', el, wr), ('hand', wr, tip)]
        paint_segs(bm, aseg, dress)
        arms.append(bm)
        abones += [(u, sh, el), (f, el, wr), (f, wr, tip)]
        R_ = '' if s > 0 else 'R'
        piv['uarm' + R_], piv['farm' + R_] = sh, el
        piv['thigh' + R_], piv['shin' + R_] = K('hp', s), K('kn', s)
    return trunk, join(*arms), bones, abones, segs, piv


def walker():
    """The shuffling dead: hunched, the head pushed forward, arms hanging; a short-sleeved
    shirt untucked and torn, blood down the front, work trousers, shoes."""
    sp = dict(pel=(0.0, 0.57), wai=(0.03, 0.71), chs=(0.09, 0.85), top=(0.13, 0.95), nk=(0.18, 0.98),
              sh=(0.13, 0.935, 0.165), el=(0.15, 0.72, 0.2), wr=(0.23, 0.56, 0.185),
              hp=(0.0, 0.545, 0.092), kn=(0.06, 0.3, 0.1), an=(0.0, 0.075, 0.105), to=(0.13, 0.03, 0.11),
              shirt='short', pants='long', seed=1)
    trunk, arms, bones, abones, segs, piv = zombie(sp)
    hd = dead_head(piv['head'], 1.0, tilt=0.12, seed=1)
    return [(trunk, bones, None), (arms, abones, None), (hd, None, HEAD)], piv


def runner():
    """Lunging: thrown forward from the hips, knees deep, both arms reaching; a long-sleeved
    shirt hanging open over the chest, ripped at the cuffs."""
    sp = dict(pel=(0.0, 0.55), wai=(0.05, 0.68), chs=(0.13, 0.82), top=(0.19, 0.92), nk=(0.24, 0.96),
              sh=(0.19, 0.905, 0.16), el=(0.3, 0.8, 0.2), wr=(0.44, 0.76, 0.17),
              R={'el': (0.26, 0.74, 0.21), 'wr': (0.39, 0.66, 0.18)},
              hp=(0.0, 0.53, 0.092), kn=(0.09, 0.29, 0.1), an=(-0.02, 0.075, 0.105), to=(0.11, 0.03, 0.11),
              g=0.92, shirt='open', pants='long', seed=2)
    trunk, arms, bones, abones, segs, piv = zombie(sp)
    hd = dead_head(piv['head'], 0.98, tilt=0.3, gape=1.3, seed=2)
    return [(trunk, bones, None), (arms, abones, None), (hd, None, HEAD)], piv


def swarmer():
    """A crawler on its knees and hands, its back arched, the bald head low and thrust out."""
    sp = dict(pel=(-0.16, 0.4), wai=(-0.03, 0.44), chs=(0.11, 0.43), top=(0.22, 0.4), nk=(0.29, 0.38),
              sh=(0.22, 0.385, 0.15), el=(0.27, 0.22, 0.19), wr=(0.33, 0.06, 0.17),
              hp=(-0.17, 0.37, 0.092), kn=(-0.08, 0.06, 0.11), an=(-0.36, 0.06, 0.1), to=(-0.45, 0.03, 0.1),
              flat=True, shirt='long', pants='long', shoes=False, seed=3)
    trunk, arms, bones, abones, segs, piv = zombie(sp)
    hd = dead_head(piv['head'], 0.95, hairdo='bald', tilt=-0.55, gape=1.2, seed=3)
    return [(trunk, bones, None), (arms, abones, None), (hd, None, HEAD)], piv


def brute():
    """The builder: broad and heavy, a gut on him, in an orange hi-vis vest with yellow bands
    and a hardhat, sleeves rolled, boots."""
    sp = dict(pel=(0.0, 0.62), wai=(0.04, 0.77), chs=(0.09, 0.95), top=(0.12, 1.08), nk=(0.16, 1.12),
              sh=(0.11, 1.06, 0.23), el=(0.15, 0.8, 0.27), wr=(0.22, 0.6, 0.25),
              hp=(0.0, 0.59, 0.13), kn=(0.07, 0.32, 0.14), an=(0.0, 0.08, 0.145), to=(0.15, 0.035, 0.15),
              w=1.45, g=1.35, armk=(1.25, 1.25), gut=((0.1, 0.78, 0), (0.16, 0.17, 0.19)), faces=1000,
              shirt='short', pants='long', seed=4)
    trunk, arms, bones, abones, segs, piv = zombie(sp)
    surf = Surf(trunk)
    vest = shell(trunk, lambda x, y, z: nearest(segs, (x, y, z))[0] in ('belly', 'chest', 'gut', 'seat') and y > 0.66
                 and not (nearest(segs, (x, y, z))[0] == 'chest' and nearest(segs, (x, y, z))[1] > 0.85), 0.016)
    paint(vest, fixed(VEST))
    paint_by(vest, lambda x, y, z: fixed(BLOOD) if noise(x, y, z, 8, 4) > 0.66 else None)
    parts = [(trunk, bones, None), (arms, abones, None), (vest, bones, None)]
    for y in (0.78, 0.92):
        b = band(surf, y, 0.035, 0.022)
        paint(b, fixed(REFLECT))
        parts.append((b, bones, None))
    hd = dead_head(piv['head'], 1.08, hairdo='bald', tilt=0.15, seed=4)
    hh = hat('hardhat')
    nx, ny, _ = survivor_rig()['neck']
    c, s_ = math.cos(0.15), math.sin(0.15)
    for v in hh.verts:
        x, y, z = back(v.co)
        x, y = x - nx, y - ny
        x, y = x * c - y * s_, x * s_ + y * c
        v.co = G(piv['head'][0] + x * 1.08, piv['head'][1] + y * 1.08, z * 1.08)
    paint(hh, fixed(HARDHAT))
    parts += [(hd, None, HEAD), (hh, None, HEAD)]
    return parts, piv


def spitter():
    """Swollen with bile: the belly distended, its shirt burst open over it, boils on the
    skin that swell as it fills (on joint X)."""
    gc = (0.12, 0.72, 0)
    sp = dict(pel=(0.0, 0.55), wai=(0.0, 0.69), chs=(0.03, 0.87), top=(0.05, 0.99), nk=(0.1, 1.03),
              sh=(0.05, 0.975, 0.18), el=(0.06, 0.76, 0.22), wr=(0.14, 0.6, 0.21),
              hp=(0.0, 0.525, 0.1), kn=(0.05, 0.29, 0.11), an=(0.0, 0.075, 0.115), to=(0.13, 0.03, 0.12),
              w=1.12, gut=(gc, (0.2, 0.2, 0.21)), shirt='open', pants='long', seed=5)
    base = outfit(sp)

    def dress(name, t, p, c):
        x, y, z = p
        if name == 'gut' and x > 0.06:
            if abs(math.sin(math.atan2(z, x - gc[0]) * 6 + y * 18)) < 0.1:
                return fixed(VEIN)
            return fixed(BILE) if noise(x, y, z, 14, 5) > 0.55 else S['skin']
        return base(name, t, p, c)
    sp['dress'] = dress
    trunk, arms, bones, abones, segs, piv = zombie(sp)
    hd = dead_head(piv['head'], 1.0, tilt=-0.1, gape=1.5, pale=fixed(0x9aa070), seed=5)
    boils = []
    for a, b in ((0.3, 0.25), (-0.5, -0.3), (0.05, -0.15), (0.75, 0.5), (-0.25, 0.55), (0.6, -0.45), (-0.8, 0.1)):
        c = (gc[0] + 0.19 * math.cos(a) * math.cos(b), gc[1] + 0.185 * math.sin(b), 0.2 * math.sin(a) * math.cos(b))
        bl = ball(c, 0.02 + 0.008 * rnd(int(a * 100) + 50, 2))
        paint(bl, fixed(PUS))
        boils.append(bl)
    piv['x'] = gc
    return [(trunk, bones, None), (arms, abones, None), (hd, None, HEAD), (join(*boils), None, X)], piv


def hurler():
    """Gaunt and too tall, crouched to spring, arms hanging past its knees: a tank top and
    shorts, barefoot, shards of its own bone breaking out of its back."""
    sp = dict(pel=(0.0, 0.62), wai=(0.03, 0.78), chs=(0.08, 0.96), top=(0.11, 1.09), nk=(0.16, 1.13),
              sh=(0.11, 1.075, 0.15), el=(0.16, 0.8, 0.2), wr=(0.23, 0.55, 0.2),
              hp=(0.0, 0.6, 0.085), kn=(0.1, 0.33, 0.1), an=(-0.02, 0.07, 0.1), to=(0.11, 0.025, 0.1),
              w=0.8, g=0.72, fingers=1.35, shirt='tank', pants='shorts', shoes=False, seed=6)
    trunk, arms, bones, abones, segs, piv = zombie(sp)
    hd = dead_head(piv['head'], 0.95, tilt=0.15, gape=1.2, seed=6)
    shards = [spike((0.02, 0.98, 0.04), (-0.12, 1.1, 0.1), 0.022), spike((0.0, 0.9, -0.05), (-0.13, 0.98, -0.1), 0.02),
              spike((0.05, 1.06, 0.0), (-0.06, 1.2, -0.02), 0.018)]
    return [(trunk, bones, None), (arms, abones, None), (hd, None, HEAD), (join(*shards), None, CHEST)], piv


def abomination():
    """Bodies fused into one hulk: a vast hunched back with another torso sunk into it, one
    arm swollen to a club that drags its knuckles, a third arm (X) clawing out of the hump
    and a fourth (X2) out of its ribs, a second head grown into its shoulder, bone breaking
    through the spine, rags of several people's clothes."""
    sp = dict(pel=(0.0, 0.8), wai=(0.12, 1.04), chs=(0.26, 1.28), top=(0.36, 1.42), nk=(0.5, 1.3),
              sh=(0.33, 1.44, 0.36), el=(0.5, 1.12, 0.44), wr=(0.64, 0.92, 0.38),
              R={'sh': (0.31, 1.46, 0.44), 'el': (0.43, 0.98, 0.62), 'wr': (0.56, 0.4, 0.56)},
              hp=(0.0, 0.76, 0.2), kn=(0.13, 0.42, 0.24), an=(0.0, 0.1, 0.25), to=(0.2, 0.04, 0.26),
              w=2.3, g=2.1, armk=(1.15, 2.1), hand=1.0, faces=2600, voxel=0.014, armfaces=420,
              extra=[lambda: ellipsoid((0.06, 1.5, 0.0), (0.36, 0.32, 0.36)),
                     lambda: ellipsoid((0.2, 1.62, 0.15), (0.2, 0.16, 0.2)),
                     lambda: ellipsoid((0.0, 1.2, 0.3), (0.16, 0.22, 0.14), rot=(0.4, 0, 0)),
                     lambda: ellipsoid((0.26, 1.0, 0.0), (0.22, 0.22, 0.27)),
                     lambda: ellipsoid((-0.12, 1.58, -0.18), (0.14, 0.12, 0.13))],
              shirt='short', pants='shorts', seed=7)
    base = outfit(sp)

    def dress(name, t, p, c):
        x, y, z = p
        k = base(name, t, p, c)
        # Where the bodies grew together: raw seams, ribs bared on the left.
        if abs(noise(x, y, z, 5, 7) - 0.5) < 0.02:
            return fixed(GORE)
        if name in ('belly', 'chest') and z > 0.25 and x > c[0] - 0.05 and int((y - 0.9) / 0.05) % 2 == 0 and 0.95 < y < 1.3:
            return fixed(BONE)
        if k == S['skin'] and noise(x, y, z, 6, 17) > 0.7:
            return fixed(FLESH)
        if k == S['shirt'] and (noise(x, y, z, 4, 8) > 0.45 or name != 'chest'):
            return S['skin']
        return k
    sp['dress'] = dress
    trunk, arms, bones, abones, segs, piv = zombie(sp)
    hd = dead_head(piv['head'], 1.5, hairdo='bald', tilt=0.1, gape=1.7, seed=7)
    other = dead_head((-0.02, 1.62, -0.28), 0.9, tilt=0.9, gape=1.2, seed=8)
    spurs = join(*[spike((x, y, z), (x - 0.18, y + 0.18, z * 1.3), 0.05) for x, y, z in
                   ((0.1, 1.6, 0.05), (-0.05, 1.5, 0.12), (-0.18, 1.35, 0.0), (-0.22, 1.15, -0.08), (0.2, 1.6, -0.12))])
    out = [(trunk, bones, None), (arms, abones, None), (hd, None, HEAD), (other, None, CHEST), (spurs, None, CHEST)]
    # The arms of the others: one out of the hump, one out of the ribs.
    for j, (sh, el, wr), sd in ((X, ((-0.05, 1.6, 0.22), (0.1, 1.86, 0.36), (0.3, 1.94, 0.38)), 9),
                                (X2, ((0.18, 1.12, -0.42), (0.34, 0.96, -0.56), (0.5, 0.98, -0.54)), 10)):
        a = {'sh': (sh, (0.045, 0.045, 0.045)), 'el': (el, (0.034,) * 3), 'wr': (wr, (0.026,) * 3)}
        hd_, tip = claw(wr, vsub(wr, el), (0.3, -1, 0), 1.1)
        bm = fuse(blob(a, [('sh', 'el'), ('el', 'wr')], hd_), voxel=0.0055, faces=220)
        paint_segs(bm, [('upper', sh, el), ('fore', el, wr), ('hand', wr, tip)], outfit({'shirt': 'long', 'seed': sd}))
        out.append((bm, None, j))
        piv['x' if j == X else 'x2'] = sh
    return out, piv


def broodmother():
    """A woman once, swollen past bursting: tall and starved on long bent legs, the belly
    a vast veined sac bursting out of her gown, egg sacs clustered on her back, lank hair
    over her face, hands to her knees."""
    gc = (0.3, 1.2, 0)
    sp = dict(pel=(0.0, 1.0), wai=(0.04, 1.2), chs=(0.1, 1.47), top=(0.15, 1.67), nk=(0.22, 1.72),
              sh=(0.15, 1.65, 0.17), el=(0.22, 1.3, 0.25), wr=(0.36, 1.0, 0.23),
              hp=(0.0, 0.97, 0.1), kn=(0.15, 0.55, 0.12), an=(0.0, 0.08, 0.12), to=(0.13, 0.03, 0.12),
              w=0.95, g=0.78, armk=(1.1, 1.1), fingers=1.6, gut=(gc, (0.32, 0.3, 0.29)), faces=2000,
              shirt='gown', pants=None, shoes=False, seed=11)
    base = outfit(sp)

    def dress(name, t, p, c):
        x, y, z = p
        if name == 'gut' and x > 0.16:
            if abs(math.sin(math.atan2(z, x - gc[0]) * 5 + y * 11)) < 0.09 or abs(math.sin(math.atan2(y - gc[1], z) * 4 + x * 9)) < 0.06:
                return fixed(VEIN)
            return fixed(BILE) if noise(x, y, z, 6, 11) > 0.66 else S['skin']
        return base(name, t, p, c)
    sp['dress'] = dress
    trunk, arms, bones, abones, segs, piv = zombie(sp)
    hd = dead_head(piv['head'], 1.1, hairdo='long', tilt=0.25, gape=1.3, seed=11)
    sacs = [ellipsoid(c, (r, r * 1.1, r), seg=12, rings=8) for c, r in
            (((-0.12, 1.52, 0.1), 0.15), ((-0.17, 1.33, -0.08), 0.17), ((-0.06, 1.7, -0.08), 0.12), ((-0.2, 1.15, 0.1), 0.13),
             ((-0.26, 1.42, 0.08), 0.1))]
    sacs = fuse(sacs, voxel=0.012, faces=500, smooth_iter=3)
    paint_by(sacs, lambda x, y, z: fixed(VEIN) if abs(math.sin(y * 40 + z * 14)) < 0.12 else fixed(EGG) if noise(x, y, z, 10, 12) > 0.4 else fixed(PUS))
    # Things moving under the skin of the belly.
    lumps = [ellipsoid((gc[0] + 0.29 * math.cos(a) * math.cos(b), gc[1] + 0.27 * math.sin(b), 0.26 * math.sin(a) * math.cos(b)), (0.07, 0.05, 0.06))
             for a, b in ((0.4, 0.2), (-0.5, -0.3), (0.1, 0.5))]
    lumps = join(*lumps)
    paint(lumps, S['skin'])
    piv['x'] = gc
    return [(trunk, bones, None), (arms, abones, None), (hd, None, HEAD), (sacs, None, CHEST), (lumps, None, X)], piv


CREEPS = {'walker': walker, 'runner': runner, 'swarmer': swarmer, 'brute': brute, 'spitter': spitter, 'hurler': hurler,
          'abomination': abomination, 'broodmother': broodmother}


def creep_pieces():
    """Every creep's pieces, and per kind its pivots and height."""
    tone = weathered(dirt=0.25, grain=0.14)
    out, rig = {}, {}
    for name, make in CREEPS.items():
        parts, piv = make()
        top = 0.0
        for i, (bm, bones, j) in enumerate(parts):
            top = max(top, max(back(v.co)[1] for v in bm.verts))
            out['creep_%s_%d' % (name, i)] = encode(bm, bones, joint=j, tone=tone)
            bm.free()
        rig[name] = {k: [round(c, 3) for c in v] for k, v in piv.items()}
        rig[name]['top'] = round(top, 3)
    return out, rig


def show_creeps(names=None):
    """The creeps in a row beside the survivors, to look at."""
    for o in list(bpy.data.objects):
        if o.name.startswith('creep_'):
            bpy.data.objects.remove(o)
    for i, (name, make) in enumerate(CREEPS.items()):
        if names and name not in names:
            continue
        parts, _ = make()
        ob = preview('creep_' + name, join(*[p for p, _, _ in parts]), at=(3, 0, (i - 4) * 1.2), pal=DEAD)
        for p_ in ob.data.polygons:
            p_.use_smooth = True


# ---- Weapons and turrets --------------------------------------------------------------------
#
# Hard-surface kit in the figures' style: real, worn objects a survivor would find, a little
# chunky so they read from the camera. Guns face +x from the right hand's grip, as heroes.ts
# holds them (its HOLDS put the off hand and the muzzle on these models); the player's colour
# is the tape and paint on them (the shirt slot). Turrets stand on y = 0 centred on their tile,
# facing +x; a turning head is its own piece about its pivot.

ACC = S['shirt']
BLACK, GUNMETAL, STEEL, BARE = 0x252526, 0x36383b, 0x4f5357, 0x7a7e80
WOOD, WOOD_DK, OLIVE, OLIVE_DK, BRASS = 0x7a4c2a, 0x4e3018, 0x535a38, 0x3a4028, 0xb08a3a
BAG, BAG_DK, PLANK, PLANK_DK, CONC, HAZ = 0x9a8c66, 0x7e7252, 0x7a5c3a, 0x55402a, 0x77746c, 0xc89a2a
RUSTY, COPPER, WHITE, ICE = 0x7a4a2a, 0xb06a34, 0xc8ccc8, 0x6aa8d0


def col(bm, c):
    """Paint bm a fixed colour, or a slot when c < 64."""
    paint(bm, c if c < 64 else fixed(c))
    return bm


def hard(bm, angle=0.9):
    """Edges sharper than angle split, so smooth shading keeps a hard surface's corners."""
    bm.normal_update()
    es = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > angle]
    bmesh.ops.split_edges(bm, edges=es)
    return bm


def kit(*parts):
    return hard(join(*parts))


def bx(c, size, color, bevel=0.0, rot=(0, 0, 0)):
    return col(box(c, size, bevel, rot), color)


def cy(a, b, r1, color, r2=None, seg=10):
    return col(cylinder(a, b, r1, r2, seg), color)


def rod(pts, r, color, seg=6):
    """A bent bar through pts, with a knuckle at each bend."""
    out = [cy(pts[i], pts[i + 1], r, color, seg=seg) for i in range(len(pts) - 1)]
    out += [col(sphere(p, (r, r, r), seg, 4), color) for p in pts[1:-1]]
    return out


def lump(c, r, color, rot=(0, 0, 0), seed=0):
    """Something soft and sagging: a sandbag or a sack, its ends pinched in."""
    bm = ellipsoid(c, r, rot, seg=10, rings=6)
    C = G(*c)
    for v in bm.verts:
        d = v.co - C
        v.co = C + d * (0.92 + 0.12 * noise(*back(v.co), f=14, seed=seed))
    return col(bm, color)


def sandbags(n, rad, y, color_a=BAG, color_b=BAG_DK, arc=(0, 2 * math.pi), size=(0.17, 0.09, 0.11), seed=0):
    out = []
    for i in range(n):
        a = arc[0] + (arc[1] - arc[0]) * (i + 0.5) / n
        c = (math.cos(a) * rad, y, -math.sin(a) * rad)
        out.append(lump(c, size, color_a if (i + seed) % 2 else color_b, (0, a + math.pi / 2 + 0.15 * (rnd(i, seed) - 0.5), 0), seed + i))
    return out


# -- Guns ---------------------------------------------------------------------------------

def pistol():
    t = -0.22  # the grip's rake
    return kit(
        bx((0.11, 0.062, 0), (0.31, 0.055, 0.044), STEEL, 0.008),
        bx((0.1, 0.024, 0), (0.27, 0.028, 0.04), BLACK, 0.005),
        cy((0.255, 0.06, 0), (0.29, 0.06, 0), 0.012, BLACK, seg=8),
        bx((-0.008, -0.022, 0), (0.058, 0.13, 0.042), BLACK, 0.008, (0, 0, t)),
        bx((-0.012, -0.03, 0), (0.064, 0.06, 0.048), ACC, 0.006, (0, 0, t)),
        bx((-0.025, -0.088, 0), (0.064, 0.016, 0.046), BLACK, 0.004, (0, 0, t)),
        bx((0.058, -0.006, 0), (0.06, 0.008, 0.014), BLACK),
        bx((0.086, 0.004, 0), (0.008, 0.03, 0.014), BLACK),
        bx((0.05, 0.0, 0), (0.008, 0.022, 0.008), BLACK),
        bx((-0.03, 0.096, 0), (0.014, 0.014, 0.032), BLACK),
        bx((0.25, 0.094, 0), (0.012, 0.01, 0.008), BLACK),
        *[bx((-0.02 + i * 0.012, 0.064, 0), (0.005, 0.045, 0.047), BLACK) for i in range(3)],
    )


def shotgun():
    return kit(
        cy((0.04, 0.066, 0), (0.64, 0.066, 0), 0.017, BLACK),
        cy((0.06, 0.032, 0), (0.58, 0.032, 0), 0.014, GUNMETAL, seg=8),
        bx((0.57, 0.05, 0), (0.025, 0.05, 0.03), BLACK),
        col(sphere((0.625, 0.088, 0), (0.006, 0.006, 0.006), 6, 4), BARE),
        bx((-0.005, 0.045, 0), (0.2, 0.08, 0.052), GUNMETAL, 0.008),
        bx((0.0, 0.05, 0.027), (0.08, 0.03, 0.004), BLACK),
        cy((0.33, 0.032, 0), (0.5, 0.032, 0), 0.029, WOOD),
        *[cy((x, 0.032, 0), (x + 0.008, 0.032, 0), 0.031, WOOD_DK) for x in (0.36, 0.4, 0.44, 0.48)],
        bx((0.005, -0.004, 0), (0.07, 0.008, 0.014), BLACK),
        bx((0.035, 0.008, 0), (0.008, 0.03, 0.014), BLACK),
        col(hull(ellipsoid((-0.09, 0.02, 0), (0.045, 0.034, 0.022)), ellipsoid((-0.19, 0.02, 0), (0.04, 0.035, 0.024)),
                 ellipsoid((-0.34, 0.0, 0), (0.02, 0.07, 0.026))), WOOD),
        col(hull(ellipsoid((-0.36, 0.0, 0), (0.012, 0.072, 0.027)), ellipsoid((-0.375, 0.0, 0), (0.012, 0.072, 0.027))), BLACK),
        bx((-0.14, 0.022, 0), (0.05, 0.078, 0.054), ACC, 0.008, (0, 0, -0.08)),
    )


def smg():
    return kit(
        bx((0.1, 0.045, 0), (0.34, 0.085, 0.056), BLACK, 0.012),
        bx((0.12, 0.096, 0), (0.22, 0.014, 0.022), GUNMETAL),
        bx((0.005, 0.045, 0), (0.045, 0.092, 0.062), ACC, 0.006),
        cy((0.27, 0.045, 0), (0.37, 0.045, 0), 0.024, GUNMETAL),
        *[cy((x, 0.045, 0), (x + 0.01, 0.045, 0), 0.026, BLACK) for x in (0.29, 0.33)],
        cy((0.37, 0.045, 0), (0.425, 0.045, 0), 0.011, BLACK, seg=8),
        bx((0.36, 0.088, 0), (0.012, 0.03, 0.01), BLACK),
        bx((0.13, -0.065, 0), (0.042, 0.15, 0.03), GUNMETAL, 0.006, (0, 0, -0.14)),
        bx((0.0, -0.05, 0), (0.046, 0.1, 0.036), BLACK, 0.008, (0, 0, -0.22)),
        bx((0.05, -0.012, 0), (0.05, 0.008, 0.014), BLACK),
        *rod([(-0.07, 0.065, 0.022), (-0.25, 0.045, 0.022)], 0.007, GUNMETAL),
        *rod([(-0.07, 0.025, -0.022), (-0.25, 0.045, -0.022)], 0.007, GUNMETAL),
        bx((-0.255, 0.03, 0), (0.016, 0.1, 0.056), BLACK, 0.005),
    )


def rifle():
    return kit(
        col(hull(ellipsoid((0.1, 0.022, 0), (0.06, 0.03, 0.026)), ellipsoid((0.5, 0.034, 0), (0.035, 0.022, 0.02))), WOOD),
        col(hull(ellipsoid((-0.04, 0.012, 0), (0.05, 0.032, 0.022)), ellipsoid((-0.2, 0.036, 0), (0.04, 0.03, 0.024)),
                 ellipsoid((-0.33, 0.0, 0), (0.02, 0.07, 0.026))), WOOD),
        col(hull(ellipsoid((-0.35, 0.0, 0), (0.012, 0.072, 0.027)), ellipsoid((-0.365, 0.0, 0), (0.012, 0.072, 0.027))), BLACK),
        bx((-0.25, 0.012, 0), (0.05, 0.1, 0.056), ACC, 0.008),
        cy((-0.06, 0.058, 0), (0.17, 0.058, 0), 0.021, STEEL),
        cy((0.17, 0.06, 0), (0.75, 0.06, 0), 0.013, BLACK, 0.009),
        *rod([(0.0, 0.058, -0.02), (0.0, 0.05, -0.055)], 0.005, STEEL),
        col(sphere((0.0, 0.05, -0.06), (0.011, 0.011, 0.011), 6, 4), BLACK),
        cy((-0.04, 0.122, 0), (0.0, 0.122, 0), 0.021, BLACK, 0.017),
        cy((0.0, 0.122, 0), (0.24, 0.122, 0), 0.016, BLACK),
        cy((0.24, 0.122, 0), (0.31, 0.122, 0), 0.016, BLACK, 0.026),
        cy((0.12, 0.136, 0), (0.12, 0.152, 0), 0.01, BLACK, seg=8),
        cy((0.12, 0.122, -0.012), (0.12, 0.122, -0.03), 0.009, BLACK, seg=8),
        bx((0.03, 0.09, 0), (0.02, 0.04, 0.02), BLACK), bx((0.2, 0.09, 0), (0.02, 0.04, 0.02), BLACK),
        bx((0.03, -0.012, 0), (0.07, 0.008, 0.014), BLACK),
        bx((0.06, -0.0, 0), (0.008, 0.03, 0.014), BLACK),
        *rod([(0.45, 0.012, 0.024), (0.3, -0.035, 0.03), (0.0, -0.05, 0.03), (-0.26, -0.02, 0.028)], 0.005, ACC),
    )


def minigun():
    """The body; the barrels are minigun_spin."""
    return kit(
        bx((-0.02, 0.02, 0), (0.26, 0.15, 0.14), GUNMETAL, 0.02),
        cy((-0.22, 0.02, 0), (-0.15, 0.02, 0), 0.062, BLACK),
        cy((-0.15, 0.02, 0), (-0.14, 0.02, 0), 0.068, STEEL),
        cy((0.11, 0.02, 0), (0.14, 0.02, 0), 0.07, BLACK, seg=12),
        bx((0.06, 0.02, 0), (0.04, 0.156, 0.146), ACC, 0.01),
        *rod([(-0.1, -0.04, -0.09), (-0.1, 0.08, -0.09)], 0.016, BLACK, seg=8),
        bx((-0.1, 0.02, -0.075), (0.03, 0.03, 0.02), BLACK),
        *rod([(-0.08, 0.09, 0.05), (-0.06, 0.15, 0.06), (0.1, 0.15, 0.06), (0.12, 0.09, 0.05)], 0.013, BLACK, seg=8),
        bx((-0.03, -0.13, 0.09), (0.17, 0.13, 0.12), OLIVE, 0.01),
        bx((-0.03, -0.062, 0.09), (0.18, 0.014, 0.13), OLIVE_DK),
        bx((0.054, -0.13, 0.09), (0.004, 0.06, 0.06), 0xd8d0a8),
        *rod([(0.0, -0.06, 0.08), (0.03, -0.02, 0.085), (0.05, 0.02, 0.075)], 0.016, BRASS),
    )


def minigun_spin():
    out = []
    for i in range(6):
        a = i * math.pi / 3
        y, z = 0.02 + math.cos(a) * 0.036, math.sin(a) * 0.036
        out.append(cy((0.13, y, z), (0.69, y, z), 0.011, BLACK if i % 2 else STEEL, seg=6))
    out += [cy((x, 0.02, 0), (x + 0.02, 0.02, 0), 0.054, GUNMETAL, seg=12) for x in (0.3, 0.6)]
    out.append(cy((0.13, 0.02, 0), (0.69, 0.02, 0), 0.016, GUNMETAL, seg=6))
    return kit(*out)


def launcher():
    return kit(
        cy((-0.32, 0.03, 0), (0.5, 0.03, 0), 0.045, OLIVE, seg=12),
        cy((-0.44, 0.03, 0), (-0.32, 0.03, 0), 0.064, BLACK, 0.045, seg=12),
        cy((-0.02, 0.03, 0), (0.22, 0.03, 0), 0.053, WOOD, seg=12),
        cy((-0.22, 0.03, 0), (-0.16, 0.03, 0), 0.049, ACC, seg=12),
        cy((0.42, 0.03, 0), (0.5, 0.03, 0), 0.05, OLIVE_DK, seg=12),
        cy((0.5, 0.03, 0), (0.56, 0.03, 0), 0.03, OLIVE_DK, 0.07, seg=12),
        cy((0.56, 0.03, 0), (0.67, 0.03, 0), 0.07, OLIVE_DK, 0.022, seg=12),
        cy((0.67, 0.03, 0), (0.69, 0.03, 0), 0.022, RUSTY, 0.01, seg=8),
        bx((0.06, -0.05, 0), (0.042, 0.095, 0.036), BLACK, 0.008, (0, 0, -0.2)),
        bx((0.32, -0.05, 0), (0.04, 0.09, 0.034), BLACK, 0.008, (0, 0, -0.1)),
        bx((0.1, -0.012, 0), (0.06, 0.008, 0.014), BLACK),
        bx((0.26, 0.105, 0.035), (0.05, 0.06, 0.014), BLACK, 0.004),
        bx((0.26, 0.08, 0.03), (0.03, 0.02, 0.03), BLACK),
    )


def crowbar():
    pts = [(-0.17, -0.025, 0), (0.44, 0.0, 0), (0.52, 0.03, 0), (0.565, 0.085, 0), (0.55, 0.14, 0), (0.505, 0.155, 0)]
    out = rod(pts, 0.015, 0x4a2220, seg=6)
    out.append(bx((-0.18, -0.03, 0), (0.03, 0.012, 0.034), 0x4a2220, 0, (0, 0, 0.3)))
    out.append(bx((0.49, 0.15, 0.009), (0.03, 0.012, 0.008), 0x4a2220, 0, (0, 0, 0.3)))
    out.append(bx((0.49, 0.15, -0.009), (0.03, 0.012, 0.008), 0x4a2220, 0, (0, 0, 0.3)))
    out.append(cy((-0.14, -0.022, 0), (0.05, -0.014, 0), 0.02, ACC, seg=8))
    out += [cy((x, -0.022 + (x + 0.14) * 0.04, 0), (x + 0.008, -0.022 + (x + 0.148) * 0.04, 0), 0.022, BLACK, seg=8) for x in (-0.13, -0.04, 0.035)]
    return kit(*out)


GUNS = [pistol, shotgun, smg, rifle, minigun, launcher, crowbar]


# -- Turrets ------------------------------------------------------------------------------

def mg_body():
    """A sandbag nest round a tripod."""
    out = sandbags(9, 0.37, 0.09, seed=1) + sandbags(9, 0.35, 0.25, seed=2, size=(0.16, 0.085, 0.105))
    out = [o for o in out]
    for a in (0.3, 2.4, 4.4):
        out += rod([(0, 0.6, 0), (math.cos(a) * 0.24, 0.02, -math.sin(a) * 0.24)], 0.018, BLACK)
    out.append(cy((0, 0.42, 0), (0, 0.66, 0), 0.03, GUNMETAL))
    out.append(bx((-0.18, 0.08, 0.12), (0.18, 0.14, 0.1), OLIVE, 0.01, (0, 0.4, 0)))
    out.append(bx((-0.12, 0.08, -0.16), (0.16, 0.12, 0.09), OLIVE_DK, 0.01, (0, -0.3, 0)))
    return kit(*out)


def mg_head():
    return kit(
        bx((-0.04, 0.0, 0), (0.36, 0.13, 0.11), GUNMETAL, 0.015),
        bx((-0.26, -0.01, 0), (0.12, 0.09, 0.07), BLACK, 0.01),
        *rod([(-0.2, -0.05, 0.0), (-0.32, -0.08, 0.0)], 0.02, BLACK),
        cy((0.14, 0.0, 0), (0.42, 0.0, 0), 0.032, BLACK, seg=8),
        cy((0.42, 0.0, 0), (0.62, 0.0, 0), 0.016, BLACK, seg=8),
        cy((0.62, 0.0, 0), (0.67, 0.0, 0), 0.024, BLACK, seg=8),
        *rod([(0.0, 0.07, 0.0), (0.04, 0.12, 0.0), (0.16, 0.12, 0.0), (0.19, 0.07, 0.0)], 0.012, BLACK),
        bx((0.02, -0.06, 0.1), (0.14, 0.12, 0.08), OLIVE, 0.01),
        *rod([(0.04, 0.0, 0.07), (0.06, 0.02, 0.04)], 0.012, BRASS),
        # The shield: a bent steel plate with a slot to shoot through.
        bx((0.24, 0.02, 0.13), (0.03, 0.3, 0.16), STEEL, 0.006, (0, -0.35, 0)),
        bx((0.24, 0.02, -0.13), (0.03, 0.3, 0.16), STEEL, 0.006, (0, 0.35, 0)),
        bx((0.27, 0.12, 0), (0.03, 0.1, 0.12), STEEL, 0.006),
        bx((0.27, -0.1, 0), (0.03, 0.1, 0.12), STEEL, 0.006),
        bx((0.27, 0.17, 0), (0.034, 0.016, 0.4), HAZ, 0.0),
    )


def mortar_body():
    out = sandbags(7, 0.38, 0.09, arc=(0.9, 2 * math.pi - 0.9), seed=3)
    out += sandbags(5, 0.36, 0.25, arc=(1.3, 2 * math.pi - 1.3), seed=4, size=(0.16, 0.085, 0.105))
    out.append(cy((0, 0.0, 0), (0, 0.05, 0), 0.24, GUNMETAL, seg=10))
    out.append(cy((0, 0.05, 0), (0, 0.09, 0), 0.12, BLACK, seg=10))
    for i, (x, z) in enumerate([(-0.22, 0.24), (-0.3, 0.12)]):
        out.append(bx((x, 0.08, z), (0.18, 0.16, 0.13), OLIVE, 0.01, (0, 0.5 * i, 0)))
    for z in (-0.06, 0.0, 0.06):
        out.append(cy((-0.24, 0.16, 0.24 + z), (-0.24, 0.27, 0.24 + z), 0.022, OLIVE_DK, seg=8))
        out.append(cy((-0.24, 0.27, 0.24 + z), (-0.24, 0.31, 0.24 + z), 0.022, BRASS, 0.006, seg=8))
    return kit(*out)


def mortar_head():
    """Pivots at the baseplate's ball; the tube up at 55 degrees, its bipod to the ground."""
    a = 0.96
    d = (math.cos(a), math.sin(a), 0)
    tip = (d[0] * 0.74, d[1] * 0.74, 0)
    return kit(
        cy((-0.02, -0.02, 0), tip, 0.066, OLIVE_DK, 0.06, seg=12),
        cy((tip[0], tip[1], 0), (tip[0] + d[0] * 0.03, tip[1] + d[1] * 0.03, 0), 0.054, BLACK, seg=12),
        col(sphere((0, 0, 0), (0.06, 0.05, 0.06), 8, 5), BLACK),
        cy((d[0] * 0.3, d[1] * 0.3, 0), (d[0] * 0.36, d[1] * 0.36, 0), 0.062, GUNMETAL, seg=12),
        *rod([(d[0] * 0.33, d[1] * 0.33, 0.04), (0.42, -0.11, 0.2)], 0.014, BLACK),
        *rod([(d[0] * 0.33, d[1] * 0.33, -0.04), (0.42, -0.11, -0.2)], 0.014, BLACK),
        *rod([(0.38, -0.02, 0.15), (0.38, -0.02, -0.15)], 0.01, BLACK),
        bx((d[0] * 0.33, d[1] * 0.33 + 0.07, 0.07), (0.04, 0.05, 0.03), BLACK, 0.004),
        bx((d[0] * 0.2, d[1] * 0.2, 0), (0.06, 0.04, 0.104), ACC, 0.0, (0, 0, a)),
    )


def frost_body():
    """Cryo tanks strapped round a pipe up to a vent that holds the crystal."""
    out = [bx((0, 0.05, 0), (0.86, 0.1, 0.86), CONC, 0.02)]
    for i, a in enumerate((0.6, 2.7, 4.8)):
        c = (math.cos(a) * 0.22, 0, -math.sin(a) * 0.22)
        out.append(cy((c[0], 0.1, c[2]), (c[0], 0.78, c[2]), 0.13, WHITE, seg=12))
        out.append(col(sphere((c[0], 0.78, c[2]), (0.13, 0.07, 0.13), 12, 5), WHITE))
        out.append(cy((c[0], 0.3, c[2]), (c[0], 0.36, c[2]), 0.134, ICE, seg=12))
        out.append(cy((c[0], 0.6, c[2]), (c[0], 0.64, c[2]), 0.134, ICE, seg=12))
        out.append(cy((c[0], 0.85, c[2]), (c[0], 0.9, c[2]), 0.03, STEEL, seg=8))
        out += rod([(c[0], 0.9, c[2]), (c[0] * 0.4, 1.0, c[2] * 0.4), (0, 1.02, 0)], 0.018, COPPER)
    out.append(cy((0, 0.1, 0), (0, 1.16, 0), 0.05, STEEL, seg=8))
    out.append(cy((0, 1.08, 0), (0, 1.16, 0), 0.2, GUNMETAL, 0.24, seg=12))
    # Prongs up and out round the crystal, open at the top so it shows from above.
    for k in range(5):
        a = k * 2 * math.pi / 5
        c, s_ = math.cos(a), -math.sin(a)
        out += rod([(c * 0.18, 1.16, s_ * 0.18), (c * 0.26, 1.36, s_ * 0.26), (c * 0.2, 1.56, s_ * 0.2)], 0.02, STEEL)
        out.append(col(sphere((c * 0.2, 1.57, s_ * 0.2), (0.03, 0.03, 0.03), 6, 4), ICE))
    out.append(col(bmesh_torus(0.25, 0.025, 1.3), GUNMETAL))
    for k in range(4):
        a = k * math.pi / 2 + 0.4
        out.append(bx((math.cos(a) * 0.36, 0.14, -math.sin(a) * 0.36), (0.1, 0.04, 0.1), ICE, 0.01, (0, a, 0)))
    out.append(cy((0.2, 0.42, 0.3), (0.2, 0.52, 0.3), 0.04, 0xc03020, seg=8))
    return kit(*out)


def tesla_body():
    """Car batteries wired to a transformer, insulators stacked up to a copper coil."""
    out = [bx((0, 0.05, 0), (0.86, 0.1, 0.86), CONC, 0.02)]
    for i, (x, z) in enumerate([(0.22, 0.24), (0.22, -0.24), (-0.24, 0.26)]):
        out.append(bx((x, 0.2, z), (0.22, 0.2, 0.14), 0x2a2c2e, 0.01, (0, 0.2 * i, 0)))
        out.append(bx((x, 0.31, z), (0.22, 0.02, 0.14), 0x3a5a8a if i % 2 else 0x8a3a2a, 0, (0, 0.2 * i, 0)))
        out.append(cy((x + 0.06, 0.31, z), (x + 0.06, 0.34, z), 0.018, 0xc03020, seg=6))
        out += rod([(x + 0.06, 0.34, z), (x * 0.4, 0.42, z * 0.4), (0, 0.5, 0)], 0.01, 0x8a2a20)
    out.append(bx((-0.22, 0.3, -0.18), (0.26, 0.4, 0.24), GUNMETAL, 0.02))
    for k in range(4):
        out.append(bx((-0.22, 0.2 + k * 0.08, -0.05), (0.2, 0.03, 0.02), BLACK))
    out.append(cy((0, 0.1, 0), (0, 0.5, 0), 0.12, GUNMETAL, 0.1, seg=10))
    for k in range(5):
        y = 0.5 + k * 0.1
        out.append(cy((0, y, 0), (0, y + 0.06, 0), 0.06, 0xd8d4c4, seg=8))
        out.append(cy((0, y + 0.06, 0), (0, y + 0.1, 0), 0.1, 0xb8b4a4, 0.06, seg=8))
    out.append(cy((0, 1.0, 0), (0, 1.32, 0), 0.07, BLACK, seg=10))
    for k in range(7):
        y = 1.02 + k * 0.042
        out.append(col(bmesh_torus(0.09, 0.019, y, seg=10, ring=4), COPPER))
    out.append(col(bmesh_torus(0.2, 0.04, 1.38), BARE))
    out += rod([(0, 1.32, 0), (0, 1.48, 0)], 0.02, BARE)
    return kit(*out)


def bmesh_torus(R, r, y, seg=14, ring=6):
    bm = bmesh.new()
    vs = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        row = []
        for j in range(ring):
            b = 2 * math.pi * j / ring
            rr = R + r * math.cos(b)
            row.append(bm.verts.new(G(math.cos(a) * rr, y + r * math.sin(b), -math.sin(a) * rr)))
        vs.append(row)
    for i in range(seg):
        for j in range(ring):
            bm.faces.new((vs[i][j], vs[(i + 1) % seg][j], vs[(i + 1) % seg][(j + 1) % ring], vs[i][(j + 1) % ring]))
    bm.normal_update()
    return bm


def sniper_body():
    """A watchtower of scavenged planks: four legs, braces, a ladder, a sandbagged deck."""
    out = [bx((0, 0.03, 0), (0.9, 0.06, 0.9), CONC, 0.02)]
    for x, z in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
        out.append(bx((x * 0.34, 0.85, z * 0.34), (0.09, 1.7, 0.09), PLANK_DK, 0.01, (0, 0, -x * 0.03)))
    for y in (0.45, 1.15):
        out += [bx((0, y, 0.35), (0.72, 0.06, 0.04), PLANK), bx((0, y, -0.35), (0.72, 0.06, 0.04), PLANK)]
        out += [bx((0.35, y, 0), (0.04, 0.06, 0.72), PLANK), bx((-0.35, y, 0), (0.04, 0.06, 0.72), PLANK)]
    out += [bx((0, 0.8, 0.36), (0.06, 0.92, 0.035), PLANK, 0, (0, 0, 0.66)), bx((0, 0.8, -0.36), (0.06, 0.92, 0.035), PLANK, 0, (0, 0, -0.66))]
    for i in range(6):
        out.append(bx(((i - 2.5) * 0.155, 1.72, 0), (0.15, 0.05, 0.92), PLANK if i % 2 else 0x6a5034, 0.005))
    out += sandbags(4, 0.36, 1.84, arc=(0.75, 2.4), seed=5, size=(0.14, 0.08, 0.1))
    out += sandbags(4, 0.36, 1.84, arc=(3.9, 5.55), seed=6, size=(0.14, 0.08, 0.1))
    out += sandbags(2, 0.38, 1.84, arc=(2.75, 3.55), seed=7, size=(0.14, 0.08, 0.1))
    out += [bx((-0.5, 0.86, 0.13), (0.04, 1.72, 0.04), PLANK_DK), bx((-0.5, 0.86, -0.13), (0.04, 1.72, 0.04), PLANK_DK)]
    out += [bx((-0.5, 0.2 + i * 0.26, 0), (0.035, 0.035, 0.3), PLANK) for i in range(6)]
    out.append(lump((0.25, 1.82, 0.25), (0.08, 0.05, 0.06), OLIVE, seed=8))
    return kit(*out)


def sniper_head():
    """A hunting rifle on a bipod, a scope and a sandbag rest."""
    out = [
        col(hull(ellipsoid((0.1, 0.0, 0), (0.08, 0.04, 0.035)), ellipsoid((0.5, 0.01, 0), (0.04, 0.03, 0.028))), WOOD),
        col(hull(ellipsoid((-0.08, -0.005, 0), (0.06, 0.04, 0.03)), ellipsoid((-0.42, -0.03, 0), (0.03, 0.09, 0.034))), WOOD),
        cy((-0.06, 0.045, 0), (0.2, 0.045, 0), 0.028, STEEL),
        cy((0.2, 0.048, 0), (1.05, 0.048, 0), 0.018, BLACK, 0.013),
        cy((1.0, 0.048, 0), (1.07, 0.048, 0), 0.025, BLACK, seg=8),
        cy((-0.02, 0.13, 0), (0.3, 0.13, 0), 0.022, BLACK),
        cy((0.3, 0.13, 0), (0.38, 0.13, 0), 0.022, BLACK, 0.034),
        cy((-0.07, 0.13, 0), (-0.02, 0.13, 0), 0.028, BLACK, 0.022),
        bx((0.06, 0.09, 0), (0.025, 0.05, 0.025), BLACK), bx((0.24, 0.09, 0), (0.025, 0.05, 0.025), BLACK),
        *rod([(0.0, 0.045, -0.03), (0.0, 0.03, -0.08)], 0.007, STEEL),
        *rod([(0.6, 0.03, 0.0), (0.68, -0.16, 0.1)], 0.01, BLACK),
        *rod([(0.6, 0.03, 0.0), (0.68, -0.16, -0.1)], 0.01, BLACK),
        lump((-0.3, -0.1, 0), (0.12, 0.06, 0.08), BAG, seed=9),
    ]
    return kit(*out)


def missile_body():
    out = [bx((0, 0.1, 0), (0.88, 0.2, 0.88), 0x4a4e44, 0.02)]
    for i in range(8):
        u = -0.44 + 0.11 * (i + 0.5)
        c = HAZ if i % 2 else BLACK
        out += [bx((u, 0.2, 0.43), (0.11, 0.02, 0.03), c), bx((u, 0.2, -0.43), (0.11, 0.02, 0.03), c)]
        out += [bx((0.43, 0.2, u), (0.03, 0.02, 0.11), c), bx((-0.43, 0.2, u), (0.03, 0.02, 0.11), c)]
    out.append(cy((0, 0.2, 0), (0, 0.6, 0), 0.24, STEEL, 0.18, seg=10))
    out.append(cy((0, 0.6, 0), (0, 0.66, 0), 0.26, GUNMETAL, seg=12))
    for a in (0.8, 2.4, 3.9, 5.5):
        out.append(bx((math.cos(a) * 0.36, 0.24, -math.sin(a) * 0.36), (0.08, 0.06, 0.08), BLACK, 0.005))
    out.append(bx((-0.3, 0.3, 0.3), (0.2, 0.18, 0.14), OLIVE, 0.01, (0, 0.6, 0)))
    return kit(*out)


def missile_head():
    """A rocket pod off a gunship, bolted to the turntable: six tubes, red noses showing."""
    out = [
        bx((0, 0.14, 0), (0.6, 0.46, 0.6), OLIVE, 0.03),
        bx((0, 0.14, 0), (0.56, 0.5, 0.5), OLIVE_DK, 0.01),
        bx((0.0, 0.39, 0), (0.42, 0.04, 0.3), OLIVE_DK, 0.01),
        bx((-0.32, 0.14, 0), (0.06, 0.4, 0.5), GUNMETAL, 0.01),
        bx((-0.1, -0.06, 0.32), (0.22, 0.2, 0.06), BLACK, 0.01),
        bx((0.1, 0.38, 0.2), (0.08, 0.04, 0.06), WHITE),
        bx((0.302, 0.14, 0), (0.008, 0.08, 0.6), HAZ),
    ]
    for y in (0.04, 0.24):
        for z in (-0.19, 0, 0.19):
            out.append(cy((0.28, y, z), (0.31, y, z), 0.08, BLACK, seg=10))
            out.append(cy((0.24, y, z), (0.36, y, z), 0.05, 0xb03a2a, 0.008, seg=8))
    return kit(*out)


TURRETS = {'gun': (mg_body, mg_head), 'cannon': (mortar_body, mortar_head), 'frost': (frost_body, None),
           'tesla': (tesla_body, None), 'sniper': (sniper_body, sniper_head), 'missile': (missile_body, missile_head)}


def kit_pieces():
    tone = weathered(dirt=0.15, grain=0.1)
    out = {}
    for i, make in enumerate(GUNS):
        out['gun_%d' % i] = encode(make(), joint=0, tone=tone)
    out['gun_4_spin'] = encode(minigun_spin(), joint=0, tone=tone)
    for name, (body, head) in TURRETS.items():
        out['turret_%s' % name] = encode(body(), joint=0, tone=weathered(dirt=0.3, grain=0.12))
        if head:
            out['turret_%s_head' % name] = encode(head(), joint=0, tone=tone)
    return out


def show_kit():
    """The guns, big, and the turrets in a row behind the creeps."""
    for o in list(bpy.data.objects):
        if o.name.startswith('kit_'):
            bpy.data.objects.remove(o)
    for i, make in enumerate(GUNS):
        bm = make()
        if i == 4:
            bm = join(bm, minigun_spin())
        for v in bm.verts:
            v.co *= 2.0
        preview('kit_gun_%d' % i, bm, at=(5 + (i % 2) * 2.2, 2.6 - (i // 2) * 0.5, 0))
    heads = {'gun': 0.66, 'cannon': 0.12, 'sniper': 2.0, 'missile': 0.76}
    for i, (name, (body, head)) in enumerate(TURRETS.items()):
        bm = body()
        if head:
            h = head()
            for v in h.verts:
                v.co += G(0, heads[name], 0)
            bm = join(bm, h)
        preview('kit_turret_' + name, bm, at=(7, 0, (i - 2.5) * 1.3))
    for o in bpy.data.objects:
        if o.name.startswith('kit_'):
            for p_ in o.data.polygons:
                p_.use_smooth = True

def main():
    creeps, rig = creep_pieces()
    write({**survivor_pieces(), **creeps, **kit_pieces()}, {'SURVIVOR': survivor_rig(), 'CREEPS': rig})
    show_survivors()
    show_creeps()
    show_kit()


if __name__ == '__main__':
    main()
