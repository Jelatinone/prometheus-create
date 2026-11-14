/**
 * Lane lab slots shown on /lab, read from lanes.json (the single source of
 * lane ownership). Each lane edits only its own app/lab/<lane>/page.tsx.
 */
import lanes from "@/lanes.json";

export type LaneKey = keyof typeof lanes.lanes;

export const LANE_LABS = (Object.keys(lanes.lanes) as LaneKey[]).map((key) => {
  const lane = lanes.lanes[key];
  return {
    key,
    title: lane.title,
    href: lane.lab,
    task: lane.task,
    branch: lane.branch,
    check: lane.check,
    owns: lane.owns,
  };
});

export function laneLab(key: LaneKey) {
  return LANE_LABS.find((l) => l.key === key)!;
}
