import math
import os

import bpy


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, "models")
IMAGE_DIR = os.path.join(ROOT_DIR, "images")
BLEND_PATH = os.path.join(MODEL_DIR, "toothbrush_source.blend")
GLB_PATH = os.path.join(MODEL_DIR, "toothbrush.glb")
POSTER_PATH = os.path.join(IMAGE_DIR, "toothbrush-poster.png")


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        bpy.data.materials.remove(block)
    for block in bpy.data.images:
        bpy.data.images.remove(block)


def ensure_dirs():
    os.makedirs(MODEL_DIR, exist_ok=True)
    os.makedirs(IMAGE_DIR, exist_ok=True)


def make_material(name, base_color, metallic, roughness):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def add_cylinder(name, radius, depth, location, rotation=(0.0, 0.0, 0.0), vertices=64):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.shade_smooth()
    return obj


def add_uv_sphere(name, radius, location, scale=(1.0, 1.0, 1.0)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=location, segments=48, ring_count=24)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.shade_smooth()
    return obj


def add_cube(name, size, location, scale=(1.0, 1.0, 1.0)):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.shade_smooth()
    return obj


def bevel_modifier(obj, amount=0.012, segments=3):
    mod = obj.modifiers.new(name="Bevel", type="BEVEL")
    mod.width = amount
    mod.segments = segments
    mod.limit_method = "ANGLE"


def subsurf_modifier(obj, levels=2):
    mod = obj.modifiers.new(name="Subdivision", type="SUBSURF")
    mod.levels = levels
    mod.render_levels = levels


def build_toothbrush():
    bronze = make_material("Bronze", (0.58, 0.39, 0.22, 1.0), 0.92, 0.28)
    grip = make_material("Grip", (0.12, 0.12, 0.12, 1.0), 0.0, 0.72)
    head = make_material("Head", (0.84, 0.85, 0.86, 1.0), 0.0, 0.34)
    bristle_white = make_material("BristleWhite", (0.9, 0.92, 0.93, 1.0), 0.0, 0.58)
    bristle_teal = make_material("BristleTeal", (0.3, 0.61, 0.55, 1.0), 0.0, 0.55)

    body = add_cylinder("Body", radius=0.18, depth=2.8, location=(0.0, 0.0, 0.0))
    body.scale = (1.0, 0.78, 1.0)
    subsurf_modifier(body)
    bevel_modifier(body, amount=0.016, segments=4)
    body.data.materials.append(bronze)

    neck = add_cylinder("Neck", radius=0.085, depth=0.95, location=(0.0, 0.0, 1.82))
    neck.scale = (0.92, 0.86, 1.0)
    subsurf_modifier(neck, levels=2)
    bevel_modifier(neck, amount=0.008, segments=3)
    neck.data.materials.append(bronze)

    accent_ring = add_cylinder("AccentRing", radius=0.105, depth=0.06, location=(0.0, 0.0, 1.48))
    accent_ring.scale = (1.0, 0.9, 1.0)
    accent_ring.data.materials.append(head)
    bevel_modifier(accent_ring, amount=0.006, segments=2)

    head_block = add_cube("HeadBlock", size=0.36, location=(0.0, 0.0, 2.42), scale=(0.5, 0.24, 0.2))
    subsurf_modifier(head_block, levels=2)
    bevel_modifier(head_block, amount=0.01, segments=3)
    head_block.data.materials.append(head)

    head_tip = add_uv_sphere("HeadTip", radius=0.12, location=(0.0, 0.0, 2.58), scale=(1.45, 0.78, 0.58))
    head_tip.data.materials.append(head)
    bevel_modifier(head_tip, amount=0.006, segments=2)

    grip_front = add_cube("GripFront", size=0.2, location=(0.0, -0.08, -0.05), scale=(0.7, 0.18, 3.0))
    subsurf_modifier(grip_front, levels=2)
    bevel_modifier(grip_front, amount=0.01, segments=3)
    grip_front.data.materials.append(grip)

    grip_back = add_cube("GripBack", size=0.2, location=(0.0, 0.08, -0.1), scale=(0.56, 0.12, 2.2))
    subsurf_modifier(grip_back, levels=2)
    bevel_modifier(grip_back, amount=0.01, segments=3)
    grip_back.data.materials.append(grip)

    button = add_uv_sphere("Button", radius=0.075, location=(0.0, -0.15, 0.18), scale=(1.35, 0.62, 1.0))
    button.data.materials.append(head)

    lower_button = add_uv_sphere("LowerButton", radius=0.045, location=(0.0, -0.145, -0.18), scale=(1.15, 0.55, 1.0))
    lower_button.data.materials.append(head)

    bristle_specs = [
        (-0.07, -0.028, bristle_white, 0.12),
        (-0.023, -0.03, bristle_teal, 0.14),
        (0.023, -0.03, bristle_white, 0.15),
        (0.07, -0.028, bristle_teal, 0.12),
        (-0.07, 0.028, bristle_teal, 0.16),
        (-0.023, 0.03, bristle_white, 0.13),
        (0.023, 0.03, bristle_teal, 0.17),
        (0.07, 0.028, bristle_white, 0.14),
    ]
    for index, (x_pos, y_pos, material, height) in enumerate(bristle_specs, start=1):
        bristle = add_cylinder(
            f"Bristle{index}",
            radius=0.017,
            depth=height,
            location=(x_pos, y_pos, 2.7 + height * 0.5),
            vertices=24,
        )
        bristle.data.materials.append(material)
        bevel_modifier(bristle, amount=0.002, segments=2)

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.8))
    rig = bpy.context.active_object
    rig.name = "ToothbrushRig"
    rig.rotation_euler = (math.radians(4.0), math.radians(22.0), math.radians(2.0))

    for obj in bpy.data.objects:
        if obj.type == "MESH":
            obj.parent = rig

    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.data.objects:
        if obj.type == "MESH":
            obj.select_set(True)

    bpy.context.view_layer.objects.active = body
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def setup_render():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 96
    scene.cycles.use_adaptive_sampling = True
    scene.render.resolution_x = 1800
    scene.render.resolution_y = 1800
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = POSTER_PATH

    camera_data = bpy.data.cameras.new(name="Camera")
    camera = bpy.data.objects.new("Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (4.6, -4.2, 2.8)
    camera.rotation_euler = (math.radians(73.0), 0.0, math.radians(47.0))
    scene.camera = camera

    bpy.ops.object.light_add(type="AREA", location=(2.5, -2.5, 3.8))
    key = bpy.context.active_object
    key.data.energy = 2500
    key.data.shape = "RECTANGLE"
    key.data.size = 2.8
    key.data.size_y = 2.2

    bpy.ops.object.light_add(type="AREA", location=(-2.8, 2.4, 1.5))
    fill = bpy.context.active_object
    fill.data.energy = 900
    fill.data.shape = "RECTANGLE"
    fill.data.size = 3.5
    fill.data.size_y = 2.6

    bpy.ops.object.light_add(type="AREA", location=(0.0, 0.0, -3.0))
    rim = bpy.context.active_object
    rim.data.energy = 450
    rim.rotation_euler = (math.radians(180.0), 0.0, 0.0)
    rim.data.shape = "RECTANGLE"
    rim.data.size = 4.0
    rim.data.size_y = 4.0

    world = bpy.data.worlds["World"]
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs[0].default_value = (0.985, 0.985, 0.985, 1.0)
    background.inputs[1].default_value = 0.65


def export_assets():
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.data.objects:
        if obj.type == "MESH":
            obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=GLB_PATH,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_normals=True,
        export_yup=True,
        export_materials="EXPORT",
    )
    bpy.ops.render.render(write_still=True)


ensure_dirs()
reset_scene()
build_toothbrush()
setup_render()
export_assets()
