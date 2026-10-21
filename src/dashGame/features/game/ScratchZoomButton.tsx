import { useEffect, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import {
  getScratchZoomEnabled,
  setScratchZoomEnabled,
  subscribeScratchZoom,
} from "@/services/scratchZoomPref";

/** Pause-menu toggle for the touch zoom on motion and photo cards. */
export function ScratchZoomButton({
  className = "game-pause__zoom",
}: {
  className?: string;
} = {}) {
  const [enabled, setEnabled] = useState(getScratchZoomEnabled);

  useEffect(() => subscribeScratchZoom(() => setEnabled(getScratchZoomEnabled())), []);

  return (
    <button
      type="button"
      className={`${className}${enabled ? "" : " is-off"}`}
      aria-label={enabled ? "Disable zoom" : "Enable zoom"}
      aria-pressed={enabled}
      onClick={() => setScratchZoomEnabled(!enabled)}
    >
      {enabled ? (
        <ZoomIn aria-hidden="true" size={17} strokeWidth={2.4} />
      ) : (
        <ZoomOut aria-hidden="true" size={17} strokeWidth={2.4} />
      )}
      {enabled ? "Zoom (enabled)" : "Zoom (disabled)"}
    </button>
  );
}
