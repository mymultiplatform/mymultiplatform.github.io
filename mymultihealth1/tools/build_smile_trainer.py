import math
import os

import bpy


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, "models")
IMAGE_DIR = os.path.join(ROOT_DIR, "images")
BLEND_PATH = os.path.join(MODEL_DIR, "smile_trainer_source.blend")
GLB_PATH = os.path.join(MODEL_DIR, "smile_trainer.glb")
POSTER_PATH = os.path.join(IMAGE_DIR, "smile_trainer-poster.png")


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


def make_material(name, base_color, metallic, roughness, transmission=0.0, ior=1.45):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Transmission Weight"].default_value = transmission
    bsdf.inputs["IOR"].default_value = ior
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


def build_smile_trainer():
    pearl = make_material("Pearl", (0.96, 0.94, 0.91, 1.0), 0.0, 0.14, transmission=0.22, ior=1.39)
    pearl_sheen = make_material("PearlSheen", (0.91, 0.94, 0.92, 1.0), 0.0, 0.1, transmission=0.12, ior=1.39)

    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.78,
        minor_radius=0.062,
        major_segments=96,
        minor_segments=28,
        location=(0.0, 0.0, 0.0),
        rotation=(math.radians(92.0), 0.0, 0.0),
    )
    trainer = bpy.context.active_object
    trainer.name = "SmileTrainer"
    trainer.scale = (1.34, 0.58, 0.42)
    bpy.ops.object.shade_smooth()
    bevel_modifier(trainer, amount=0.004, segments=2)
    trainer.data.materials.append(pearl)

    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.14, location=(-1.06, 0.0, -0.02), segments=48, ring_count=24)
    left_cap = bpy.context.active_object
    left_cap.name = "LeftCap"
    left_cap.scale = (1.0, 0.62, 0.58)
    bpy.ops.object.shade_smooth()
    left_cap.data.materials.append(pearl_sheen)

    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.14, location=(1.06, 0.0, -0.02), segments=48, ring_count=24)
    right_cap = bpy.context.active_object
    right_cap.name = "RightCap"
    right_cap.scale = (1.0, 0.62, 0.58)
    bpy.ops.object.shade_smooth()
    right_cap.data.materials.append(pearl_sheen)

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.0))
    rig = bpy.context.active_object
    rig.name = "SmileTrainerRig"
    rig.rotation_euler = (math.radians(76.0), math.radians(2.0), math.radians(-2.0))

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
    camera.location = (4.0, -3.8, 2.7)
    camera.rotation_euler = (math.radians(72.0), 0.0, math.radians(44.0))
    scene.camera = camera

    bpy.ops.object.light_add(type="AREA", location=(2.5, -2.8, 3.8))
    key = bpy.context.active_object
    key.data.energy = 2200
    key.data.shape = "RECTANGLE"
    key.data.size = 2.8
    key.data.size_y = 2.0

    bpy.ops.object.light_add(type="AREA", location=(-2.4, 2.6, 1.6))
    fill = bpy.context.active_object
    fill.data.energy = 1000
    fill.data.shape = "RECTANGLE"
    fill.data.size = 3.2
    fill.data.size_y = 2.5

    bpy.ops.object.light_add(type="AREA", location=(0.0, 0.0, -2.8))
    rim = bpy.context.active_object
    rim.data.energy = 350
    rim.rotation_euler = (math.radians(180.0), 0.0, 0.0)
    rim.data.shape = "RECTANGLE"
    rim.data.size = 4.2
    rim.data.size_y = 4.2

    world = bpy.data.worlds["World"]
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs[0].default_value = (0.985, 0.985, 0.985, 1.0)
    background.inputs[1].default_value = 0.8


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
build_smile_trainer()
setup_render()
export_assets()
