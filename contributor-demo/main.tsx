import { createRoot } from "react-dom/client";
import { ContributorDemoView } from "./view";
import "../styles/control-room.css";
import "../private-app/app/private.css";

const root = document.getElementById("root");
if (!root) throw new Error("demo_root_missing");
createRoot(root).render(<ContributorDemoView search={window.location.search} />);
