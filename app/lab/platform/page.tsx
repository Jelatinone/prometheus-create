// Owned by the platform lane (see lanes.json). Replace this placeholder with a
// working demo of the lane's acceptance check.
import { LanePlaceholder } from "@/components/lab/LanePlaceholder";
import { laneLab } from "../lanes";

export default function Page() {
  const lane = laneLab("platform");
  return <LanePlaceholder {...lane} ownedPaths={lane.owns.join(", ")} />;
}
