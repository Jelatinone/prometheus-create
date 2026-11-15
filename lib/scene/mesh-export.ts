import { Scene, type Group } from "three";

/** Export geometry for visible objects, independently of their appearance layer. */
export function meshExportScene(groups: Iterable<Group>): Scene {
  const root = new Scene();
  root.name = "Prometheus::create take";
  for (const group of groups) {
    if (!group.visible) continue;
    const copy = group.clone(false);
    const mesh = group.getObjectByName("mesh");
    if (mesh) {
      const geometry = mesh.clone(true);
      geometry.visible = true; // The viewport hides this root while showing its splat.
      copy.add(geometry);
    }
    root.add(copy);
  }
  return root;
}
