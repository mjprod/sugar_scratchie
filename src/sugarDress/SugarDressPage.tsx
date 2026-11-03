import { InfiniteCanvas } from "./components/InfiniteCanvas";
import "./sugar-dress.css";

/** Full-bleed clothes canvas on the operator app (:5080). */
export function SugarDressPage() {
  return (
    <div className="sugar-dress-root" id="sugar-dress-root">
      <InfiniteCanvas />
    </div>
  );
}
