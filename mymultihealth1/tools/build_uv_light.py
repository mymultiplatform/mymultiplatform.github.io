import math
import os

import bpy


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, "models")
IMAGE_DIR = os.path.join(ROOT_DIR, "images")
BLEND_PATH = os.path.join(MODEL_DIR, "uv_light_source.blend")
GLB_PATH = os.path.join(MODEL_DIR, "uv_light.glb")
POSTER_PATH = os.path.join(IMAGE_DIR, "uv_light-poster.png")


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


def make_material(name, base_color, metallic, roughness, emission_strength=0.0, emission_color=None):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission_color is not None:
        bsdf.inputs["Emission Color"].default_value = emission_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def bevel_modifier(obj, amount=0.012, segments=3):
    mod = obj.modifiers.new(name="Bevel", type="BEVEL")
    mod.width = amount
    mod.segments = segments
    mod.limit_method = "ANGLE"


def subsurf_modifier(obj, levels=2):
    mod = obj.modifiers.new(name="Subdivision", type="SUBSURF")
    mod.levels = levels
    mod.render_levels = levels


def add_cube(name, size, location, scale=(1.0, 1.0, 1.0)):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.shade_smooth()
    return obj


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


def build_uv_light():
    shell = make_material("Shell", (0.92, 0.92, 0.91, 1.0), 0.0, 0.18)
    trim = make_material("Trim", (0.82, 0.84, 0.86, 1.0), 0.0, 0.28)
    glow = make_material("Glow", (0.77, 0.89, 0.98, 1.0), 0.0, 0.08, emission_strength=0.9, emission_color=(0.77, 0.89, 0.98, 1.0))

    body = add_cube("Body", size=2.0, location=(0.0, 0.0, 0.0), scale=(1.25, 0.78, 0.32))
    subsurf_modifier(body, levels=2)
    bevel_modifier(body, amount=0.05, segments=4)
    body.data.materials.append(shell)

    lid = add_cube("Lid", size=2.0, location=(0.0, 0.02, 0.2), scale=(1.18, 0.72, 0.12))
    subsurf_modifier(lid, levels=2)
    bevel_modifier(lid, amount=0.035, segments=3)
    lid.data.materials.append(trim)

    light_bar = add_cube("LightBar", size=1.6, location=(0.0, -0.03, -0.02), scale=(0.85, 0.08, 0.03))
    bevel_modifier(light_bar, amount=0.01, segments=2)
    light_bar.data.materials.append(glow)

    button = add_cylinder("Button", radius=0.11, depth=0.04, location=(0.76, 0.63, 0.02), rotation=(math.radians(90.0), 0.0, 0.0))
    bevel_modifier(button, amount=0.004, segments=2)
    button.data.materials.append(trim)

    feet_positions = [(-0.9, -0.56, -0.31), (0.9, -0.56, -0.31), (-0.9, 0.56, -0.31), (0.9, 0.56, -0.31)]
    for index, position in enumerate(feet_positions, start=1):
        foot = add_cylinder(
            f"Foot{index}",
            radius=0.08,
            depth=0.05,
            location=position,
            rotation=(math.radians(90.0), 0.0, 0.0),
            vertices=32,
        )
        foot.data.materials.append(trim)

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.0))
    rig = bpy.context.active_object
    rig.name = "UVRig"
    rig.rotation_euler = (math.radians(68.0), math.radians(-12.0), math.radians(10.0))

    for obj in bpy.data.objects:
        if obj.type == "MESH":
            obj.parent = rig


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
    camera.location = (4.1, -3.7, 2.5)
    camera.rotation_euler = (math.radians(72.0), 0.0, math.radians(46.0))
    scene.camera = camera

    bpy.ops.object.light_add(type="AREA", location=(2.8, -2.6, 3.8))
    key = bpy.context.active_object
    key.data.energy = 2600
    key.data.shape = "RECTANGLE"
    key.data.size = 3.0
    key.data.size_y = 2.2

    bpy.ops.object.light_add(type="AREA", location=(-2.6, 2.8, 1.8))
    fill = bpy.context.active_object
    fill.data.energy = 1000
    fill.data.shape = "RECTANGLE"
    fill.data.size = 3.5
    fill.data.size_y = 2.7

    bpy.ops.object.light_add(type="AREA", location=(0.0, 0.0, -2.7))
    rim = bpy.context.active_object
    rim.data.energy = 380
    rim.rotation_euler = (math.radians(180.0), 0.0, 0.0)
    rim.data.shape = "RECTANGLE"
    rim.data.size = 4.2
    rim.data.size_y = 4.2

    world = bpy.data.worlds["World"]
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs[0].default_value = (0.985, 0.985, 0.985, 1.0)
    background.inputs[1].default_value = 0.82


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
build_uv_light()
setup_render()
export_assets()
