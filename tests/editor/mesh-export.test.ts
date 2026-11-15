import { describe, expect, it } from "vitest";
import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { meshExportScene } from "@/lib/scene/mesh-export";

describe("GLB geometry across appearance layers", () => {
  it.each([true, false])("exports a visible object's geometry when its mesh display is %s", (meshVisible) => {
    const object = new Group();
    object.position.set(0.4, 0, 0);
    const mesh = new Mesh(new BoxGeometry(1, 0.791, 1), new MeshBasicMaterial());
    mesh.name = "mesh";
    mesh.position.y = 0.3955;
    mesh.visible = meshVisible;
    const splat = new Group();
    splat.name = "splat";
    object.add(mesh, splat);
    const hiddenObject = object.clone(true);
    hiddenObject.visible = false;
    hiddenObject.position.x = 100;

    const output = meshExportScene([object, hiddenObject]);
    const visibleMeshes: Mesh[] = [];
    output.traverseVisible((node) => { if (node instanceof Mesh) visibleMeshes.push(node); });
    expect(visibleMeshes).toHaveLength(1);
    expect(output.getObjectByName("splat")).toBeUndefined();
    const bounds = new Box3().setFromObject(output);
    const size = bounds.getSize(new Vector3());
    expect(size.x).toBeCloseTo(1);
    expect(size.y).toBeCloseTo(0.791);
    expect(size.z).toBeCloseTo(1);
    expect(bounds.getCenter(new Vector3()).x).toBeCloseTo(0.4);
    expect(mesh.visible).toBe(meshVisible);
    expect(object.children).toEqual([mesh, splat]);
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
});
